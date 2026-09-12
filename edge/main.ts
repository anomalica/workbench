/**
 * The workbench edge function - a single stateless fetch handler (the Bunny Edge
 * Scripting / Deno entry). It serves ONLY the dynamic, secret, and write paths;
 * the graph, candidate lists, records, and public originals are static JSON/files
 * on the CDN (see backend/prerender.py) and never touch this function.
 *
 *   auth      GET  /api/auth/{login,callback,me,logout}      GitHub OAuth, signed-cookie sessions
 *   gate      GET  /api/ingests/{h}/verification             challenge availability
 *             POST /api/ingests/{h}/verification/start       signed session + cloze blanks
 *             POST /api/ingests/{h}/verification/submit      score -> on pass, a signed Bunny URL
 *   write     PUT  /api/ingests/{h}                          reviewer correction -> ingests git (auth)
 *   curate    POST /api/curation/{merge,unmerge,reject}      decision -> curation ledger git (auth)
 *   directives PUT /api/articles/{section}/{slug}/directives presentation directives -> content git (auth)
 *
 * Reads of restricted sidecars (verification answers) go through the private
 * ingests repo via the service token - answers never reach the client.
 */

import {
  type AuthConfig,
  clearSessionCookie,
  exchangeCode,
  loginRedirectUrl,
  makeSessionCookie,
  readSession,
  type User,
  verifyState,
} from "./lib/auth.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "jsr:@std/yaml@1";
import { signedUrl } from "./lib/bunny.ts";
import {
  ApplyConflict,
  applyPatch,
  applyTokenReplacements,
  BodyChanged,
  HOUSEKEEPING_ALGORITHM_VERSION,
  type HousekeepingSidecar,
  type HousekeepingV1Item,
  type HousekeepingV2Item,
  InvalidReplacement,
  MultilineField,
  previewItem,
  unmetDependencies,
  validateV2Sidecar,
} from "./lib/housekeeping.ts";
import { sha256Hex } from "./lib/crypto.ts";
import { needed, scoreSession, startSession } from "./lib/gate.ts";
import {
  type AtomicFileChange,
  type Author,
  type CommitFilesOptions,
  type FileState,
  GitHubClient,
  GitHubError,
} from "./lib/github.ts";
import { atLeast, DEFAULT_ROLE, parseRoles, type Role, roleOf } from "./lib/roles.ts";
import {
  appendEntry,
  buildMergeEntry,
  buildRejectEntry,
  buildUndoEntry,
  buildUnrejectEntry,
  isoSeconds,
  type NodeRef,
} from "./lib/ledger.ts";

const FULL_HASH = /^[a-f0-9]{64}$/;
const EXT = /^[a-z0-9]{1,8}$/;
// Article identity for the directive-write route. Strict kebab-case so a path
// segment can never escape content/pages/ (no dots, slashes, or "..").
const ARTICLE_SECTION = /^[a-z][a-z-]*$/;
const ARTICLE_SLUG = /^[a-z0-9][a-z0-9-]*$/;
const MAX_DIRECTIVE_LEN = 500;
const CHALLENGES_PER_SESSION = 10;
const MIN_POOL_FOR_CLOZE_GATE = 5;
const HOUSEKEEPING_DECISION_SCHEMA = "anomalica/housekeeping-decision/1";
const HOUSEKEEPING_MANIFEST_SCHEMA = "anomalica/housekeeping-algorithm/1";
const HOUSEKEEPING_MANIFEST_PATH = "housekeeping-algorithm.json";
const ALGORITHM_VERSION_TOKEN = /^[A-Za-z0-9._-]+$/;

export interface Env extends AuthConfig {
  serviceToken: string;
  owner: string;
  ingestsRepo: string;
  curationRepo: string;
  contentRepo: string;
  branch: string;
  bunnyHost: string;
  bunnyKey: string;
  gateTtlSeconds: number;
  // Serve a gated record's text body on a gate-pass. OFF by default - it crosses
  // the copyright boundary (licensed text), so it is an explicit, separate switch
  // from any other edge deploy.
  serveGatedBody: boolean;
}

interface GitHubLike {
  getFile(repo: string, path: string): Promise<FileState | null>;
  getFileAt(repo: string, path: string, ref: string): Promise<FileState | null>;
  getRef(repo: string): Promise<string>;
  editFile(
    repo: string,
    path: string,
    transform: (cur: string) => string,
    message: string,
    author: Author,
    retries?: number,
  ): Promise<string>;
  listCommits(
    repo: string,
    path: string,
    perPage?: number,
  ): Promise<{ by: string; email: string; at: string; message: string }[]>;
  commitFiles(
    repo: string,
    changes: AtomicFileChange[],
    message: string,
    author: Author,
    options?: CommitFilesOptions,
  ): Promise<string>;
}

export interface Deps {
  github: GitHubLike;
  nowSec: () => number;
}

interface Sidecar {
  algorithm?: string;
  sha256?: string;
  challenges?: { before: string; after: string; answer: string }[];
}

// --- responses ---
const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const err = (status: number, detail: string) => json({ detail }, status);
const notFound = () => err(404, "Not found");

function hasExactKeys(value: unknown, expected: string[]): value is Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

function algorithmManifestVersion(raw: string): string | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !hasExactKeys(value, ["algorithm_version", "schema"]) ||
    value.schema !== HOUSEKEEPING_MANIFEST_SCHEMA ||
    typeof value.algorithm_version !== "string" ||
    !ALGORITHM_VERSION_TOKEN.test(value.algorithm_version)
  )
    return null;
  const canonical =
    `{ "algorithm_version": ${JSON.stringify(value.algorithm_version)}, ` +
    `"schema": ${JSON.stringify(HOUSEKEEPING_MANIFEST_SCHEMA)} }\n`;
  return raw === canonical ? value.algorithm_version : null;
}

function recordFrontmatter(text: string): Record<string, unknown> | null {
  const match = text.match(/^---(?:\r\n|\n)([\s\S]*?)(?:\r\n|\n)---(?:\r\n|\n|$)/);
  if (!match) return null;
  try {
    const value = parseYaml(match[1]);
    return value != null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normaliseContentHash(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const bare = value.replace(/^sha256:/, "");
  return FULL_HASH.test(bare) ? bare : null;
}

function copyrightStatus(frontmatter: Record<string, unknown> | null): string | null {
  if (!frontmatter) return null;
  if (typeof frontmatter["copyright.status"] === "string") {
    return frontmatter["copyright.status"] as string;
  }
  const copyright = frontmatter.copyright;
  if (copyright != null && typeof copyright === "object" && !Array.isArray(copyright)) {
    const status = (copyright as Record<string, unknown>).status;
    return typeof status === "string" ? status : null;
  }
  return null;
}

class HousekeepingUnavailable extends Error {}

async function housekeepingViewAt(
  hash: string,
  ref: string,
  env: Env,
  deps: Deps,
): Promise<Record<string, unknown>> {
  const manifestFile = await deps.github.getFileAt(
    env.ingestsRepo,
    HOUSEKEEPING_MANIFEST_PATH,
    ref,
  );
  const algorithmVersion = manifestFile && algorithmManifestVersion(manifestFile.text);
  if (algorithmVersion == null) throw new HousekeepingUnavailable();

  const bodyPath = await resolveBodyPathAt(env, deps, hash, ref);
  const bodyFile = await deps.github.getFileAt(env.ingestsRepo, bodyPath, ref);
  if (!bodyFile) throw new GitHubError(404, "record not found");
  const inputSha = `sha256:${await sha256Hex(bodyFile.text)}`;
  const sidecarFile = await deps.github.getFileAt(
    env.ingestsRepo,
    `store/${hash}.housekeeping.json`,
    ref,
  );

  let sidecar: HousekeepingSidecar | null = null;
  let rawSidecar: Record<string, unknown> | null = null;
  let dueReason: string | null = null;
  if (!sidecarFile) {
    dueReason = "missing-sidecar";
  } else {
    try {
      const decoded = JSON.parse(sidecarFile.text);
      rawSidecar =
        decoded != null && typeof decoded === "object" && !Array.isArray(decoded)
          ? (decoded as Record<string, unknown>)
          : null;
    } catch {
      rawSidecar = null;
    }
    if (!rawSidecar) dueReason = "invalid-sidecar";
    else if (rawSidecar.schema !== "anomalica/housekeeping/2") {
      dueReason = "unsupported-schema";
    } else if (rawSidecar.outcome !== "completed") dueReason = "incomplete";
    else {
      sidecar = rawSidecar as unknown as HousekeepingSidecar;
      if (!validateV2Sidecar(sidecar) || sidecar.content_hash !== `sha256:${hash}`) {
        sidecar = null;
        dueReason = "invalid-sidecar";
      } else if (sidecar.input_sha256 !== inputSha) {
        dueReason = "input-mismatch";
      } else if (sidecar.algorithm_version !== algorithmVersion) {
        dueReason = "algorithm-mismatch";
      }
    }
  }

  const proposed =
    sidecar && dueReason == null ? sidecar.items.filter((item) => item.status === "proposed") : [];
  const scopes = [
    ...new Set(
      proposed.map((item) => (item.operation === "replace-token" ? "body" : "frontmatter")),
    ),
  ].sort();
  const previews = sidecar
    ? Object.fromEntries(sidecar.items.map((item) => [item.id, previewItem(bodyFile.text, item)]))
    : {};
  return {
    schema: "anomalica/housekeeping-view/1",
    access: "full",
    viewed_sidecar_sha: sidecarFile?.sha ?? null,
    viewed_ref: ref,
    viewed_content_hash: `sha256:${hash}`,
    viewed_input_sha256: inputSha,
    viewed_algorithm_version: algorithmVersion,
    state: dueReason == null ? "current" : "due",
    due_reason: dueReason,
    outstanding_count: proposed.length,
    scopes,
    deep_link: `/housekeeping?record=${hash}`,
    sidecar: rawSidecar,
    previews,
  };
}

function sample<T>(pool: T[], n: number): T[] {
  const copy = [...pool];
  const buf = new Uint32Array(copy.length);
  crypto.getRandomValues(buf);
  for (let i = copy.length - 1; i > 0; i--) {
    const j = buf[i] % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

/** The login -> role map from `ingests/roles.yaml`. Fails CLOSED: if the file is
 *  missing or unreadable the map is empty, so every login resolves to
 *  contributor and no write is allowed. Read per request - the file is tiny, and
 *  a revoked role must take effect immediately, not after a redeploy. */
async function loadRoles(env: Env, deps: Deps): Promise<Record<string, Role>> {
  const file = await deps.github.getFile(env.ingestsRepo, "roles.yaml");
  if (!file) return {};
  return parseRoles(file.text);
}

async function loadSidecar(env: Env, deps: Deps, hash: string): Promise<Sidecar | null> {
  const file = await deps.github.getFile(env.ingestsRepo, `store/${hash}.verification.json`);
  if (!file) return null;
  try {
    return JSON.parse(file.text) as Sidecar;
  } catch {
    return null;
  }
}

function authorOf(user: User): Author {
  return { name: user.name || user.login || "reviewer", email: user.email };
}

// The canonical record body file: v2 records keep it in {hash}.v2.md (preferred
// by the workbench's _scan + by-name/ symlink), else {hash}.md. Reviews write it
// and the history reads it.
async function resolveBodyPath(env: Env, deps: Deps, hash: string): Promise<string> {
  const v2 = `store/${hash}.v2.md`;
  return (await deps.github.getFile(env.ingestsRepo, v2)) ? v2 : `store/${hash}.md`;
}

async function resolveBodyPathAt(env: Env, deps: Deps, hash: string, ref: string): Promise<string> {
  const v2 = `store/${hash}.v2.md`;
  return (await deps.github.getFileAt(env.ingestsRepo, v2, ref)) ? v2 : `store/${hash}.md`;
}

// --- handlers ---

async function handleAuth(path: string, req: Request, env: Env, deps: Deps): Promise<Response> {
  const now = deps.nowSec();
  if (path === "/api/auth/login") {
    return Response.redirect(await loginRedirectUrl(env, now), 302);
  }
  if (path === "/api/auth/callback") {
    const url = new URL(req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !(await verifyState(env, state, now))) {
      return err(400, "Invalid OAuth state");
    }
    const user = await exchangeCode(env, code);
    const headers = new Headers({ Location: env.publicUrl });
    headers.append("Set-Cookie", await makeSessionCookie(env, user, now));
    return new Response(null, { status: 302, headers });
  }
  if (path === "/api/auth/me") {
    const user = await readSession(env, req.headers.get("cookie"), now);
    return json({ user });
  }
  if (path === "/api/auth/logout") {
    return new Response(null, {
      status: 302,
      headers: new Headers({
        Location: env.publicUrl,
        "Set-Cookie": clearSessionCookie(),
      }),
    });
  }
  return notFound();
}

async function handleGate(
  hash: string,
  action: string,
  req: Request,
  env: Env,
  deps: Deps,
): Promise<Response> {
  if (!FULL_HASH.test(hash)) return notFound();
  const sidecar = await loadSidecar(env, deps, hash);

  if (action === "") {
    // GET availability info
    if (!sidecar) return json({ available: false });
    const pool = sidecar.challenges?.length ?? 0;
    const served = Math.min(CHALLENGES_PER_SESSION, pool);
    return json({
      available: true,
      algorithm: sidecar.algorithm ?? "cloze-v1",
      pool_size: pool,
      challenges_per_session: served,
      min_correct_to_pass: served ? needed(served) : 0,
      cloze_gateable: pool >= MIN_POOL_FOR_CLOZE_GATE,
      sha_fastpath_available: "sha256" in (sidecar ?? {}),
    });
  }

  if (!sidecar) return err(404, "No verification available");

  if (action === "start") {
    const pool = sidecar.challenges ?? [];
    if (pool.length < MIN_POOL_FOR_CLOZE_GATE) {
      return err(409, "Cloze gate not available for this record");
    }
    const chosen = sample(pool, Math.min(CHALLENGES_PER_SESSION, pool.length));
    const s = await startSession(env.sessionSecret, hash, chosen, deps.nowSec());
    return json({
      session_id: s.token,
      challenges: s.challenges,
      min_correct_to_pass: s.minCorrectToPass,
    });
  }

  if (action === "submit") {
    const body = (await req.json().catch(() => ({}))) as {
      sha256?: string;
      session_id?: string;
      responses?: Record<string, string>;
      ext?: string;
    };
    let passed = false;
    let method = "cloze";
    let score: number | null = null;
    let need: number | null = null;

    if (
      typeof body.sha256 === "string" &&
      sidecar.sha256 &&
      body.sha256.toLowerCase() === sidecar.sha256.toLowerCase()
    ) {
      passed = true;
      method = "sha256";
    } else {
      const result = await scoreSession(
        env.sessionSecret,
        hash,
        body.session_id ?? "",
        body.responses ?? {},
        deps.nowSec(),
      );
      if (!result.ok) {
        return err(400, `Invalid or expired session (${result.reason})`);
      }
      passed = result.passed;
      score = result.score;
      need = result.needed;
    }

    const out: Record<string, unknown> = {
      passed,
      method,
      score,
      needed: need,
    };
    if (passed) {
      const ref = await deps.github.getRef(env.ingestsRepo);
      try {
        out.housekeeping = await housekeepingViewAt(hash, ref, env, deps);
      } catch (error) {
        if (error instanceof HousekeepingUnavailable) {
          return err(503, "Housekeeping algorithm manifest unavailable");
        }
        throw error;
      }
      // Mint a short-lived signed Bunny URL for exactly this verified hash.
      const ext = body.ext && EXT.test(body.ext) ? body.ext : null;
      if (ext && env.bunnyHost && env.bunnyKey) {
        out.url = await signedUrl(
          env.bunnyKey,
          env.bunnyHost,
          `/sources/${hash}.${ext}`,
          deps.nowSec() + env.gateTtlSeconds,
        );
        out.expires_in = env.gateTtlSeconds;
      }
      // Serve the extracted TEXT BODY to the proven possessor. The public
      // snapshot blanks the body for gated records (copyright); without this the
      // gate passes into an empty editor. One-shot - returned in this pass
      // response only, no persistent unlock state (re-gates on reload, the safer
      // boundary). Read from the canonical .v2/.md path (the same read the
      // review-write path does) and split into frontmatter + body so the SPA can
      // both display the text AND reconstruct the full record on write-back
      // (raw_frontmatter + body) without clobbering the frontmatter.
      //
      // GATED behind SERVE_GATED_BODY (default OFF): serving licensed text on a
      // gate-pass crosses a copyright boundary, so it is its own explicit switch -
      // a directive-only or any other edge deploy must NOT start serving bodies as
      // a side effect. With the flag off, a pass returns only the signed URL (the
      // pre-existing behaviour), never the body.
      if (env.serveGatedBody) {
        const bodyPath = await resolveBodyPathAt(env, deps, hash, ref);
        const recordFile = await deps.github.getFileAt(env.ingestsRepo, bodyPath, ref);
        const md = recordFile?.text;
        if (md != null && recordFile != null) {
          const m = md.match(/^(---(?:\r\n|\n)[\s\S]*?(?:\r\n|\n)---(?:\r\n|\n|$))([\s\S]*)$/);
          out.raw_frontmatter = m ? m[1] : "";
          out.body = m ? m[2] : md;
          out.base_record_sha = recordFile.sha;
          out.base_ref = ref;
        }
      }
    }
    return json(out);
  }
  return notFound();
}

async function handleReviewWrite(
  hash: string,
  req: Request,
  env: Env,
  deps: Deps,
  user: User,
  role: Role,
): Promise<Response> {
  if (!FULL_HASH.test(hash)) return notFound();
  const body = (await req.json().catch(() => ({}))) as {
    content?: string;
    base_record_sha?: string;
    base_ref?: string;
    notes?: string;
    spans?: { from: number; to: number; kind?: string }[];
    verdict?: {
      observed_coverage?: number;
      digestible?: boolean;
      total_units?: number;
    };
  };
  if (!body.content || typeof body.content !== "string") {
    return err(400, "Missing content");
  }
  if (
    typeof body.base_record_sha !== "string" ||
    !/^[a-f0-9]{40,64}$/.test(body.base_record_sha) ||
    typeof body.base_ref !== "string" ||
    !/^[a-f0-9]{40,64}$/.test(body.base_ref)
  ) {
    return err(400, "Missing viewed record identity");
  }
  const notes = (body.notes ?? "").trim();
  const author = authorOf(user);

  if ((await deps.github.getRef(env.ingestsRepo)) !== body.base_ref) {
    return err(409, "Stale review base");
  }
  const bodyPath = await resolveBodyPathAt(env, deps, hash, body.base_ref);
  const bodyFile = await deps.github.getFileAt(env.ingestsRepo, bodyPath, body.base_ref);
  if (bodyFile == null) return notFound();
  if (bodyFile.sha !== body.base_record_sha) {
    return err(409, "Stale review base");
  }
  const submitted = recordFrontmatter(body.content);
  const current = recordFrontmatter(bodyFile.text);
  if (normaliseContentHash(submitted?.content_hash) !== hash) {
    return err(409, "Record identity cannot be changed");
  }
  const beforeCopyright = copyrightStatus(current);
  const afterCopyright = copyrightStatus(submitted);
  if (afterCopyright != null && afterCopyright !== beforeCopyright && !atLeast(role, "admin")) {
    return err(403, "Changing a record's copyright status is restricted to admins");
  }

  const spans = Array.isArray(body.spans) ? body.spans : [];
  const verdict = body.verdict;
  const changes: AtomicFileChange[] = [
    {
      path: bodyPath,
      text: body.content,
      expectedSha: bodyFile.sha,
    },
  ];
  if (spans.length || verdict?.observed_coverage != null) {
    const coveragePath = `store/${hash}.review.json`;
    const coverageFile = await deps.github.getFileAt(env.ingestsRepo, coveragePath, body.base_ref);
    const sidecar = coverageFile
      ? JSON.parse(coverageFile.text)
      : { schema: "anomalica/review-coverage/0", reviews: [] };
    const entry: Record<string, unknown> = {
      by: user.email,
      at: isoSeconds(new Date(deps.nowSec() * 1000)),
      spans: spans.map((s) => ({
        from: s.from,
        to: s.to,
        kind: s.kind ?? "observed",
      })),
    };
    if (notes) entry.notes = notes;
    sidecar.reviews.push(entry);
    if (verdict?.observed_coverage != null) {
      sidecar.schema = "anomalica/review-coverage/1";
      sidecar.observed_coverage = verdict.observed_coverage;
      sidecar.digestible = !!verdict.digestible;
      if (verdict.total_units != null) {
        sidecar.total_units = verdict.total_units;
      }
    }
    changes.push({
      path: coveragePath,
      text: JSON.stringify(sidecar, null, 2) + "\n",
      expectedSha: coverageFile?.sha ?? null,
    });
  }
  try {
    await deps.github.commitFiles(
      env.ingestsRepo,
      changes,
      `review: ${hash.slice(0, 12)}${notes ? ` - ${notes}` : ""}`,
      author,
      { expectedRef: body.base_ref },
    );
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 409 || e.status === 422)) {
      return err(409, "Stale review base");
    }
    throw e;
  }
  return json({ submitted: true });
}

/**
 * Record per-item housekeeping decisions and apply the approved ones.
 *
 * NOT a reuse of PUT /api/ingests/{hash}: that route takes the whole record from
 * the client, and a gated record's body never reaches the browser - the snapshot
 * blanks it. So the client sends decisions only and this reads the record with
 * the credentials it already holds.
 *
 * Record and sidecar go in ONE logical write. The frontmatter change and the
 * decision that authorised it are the same fact; split them and a reader finds an
 * unexplained edit.
 */
async function handleHousekeepingDecide(
  hash: string,
  req: Request,
  env: Env,
  deps: Deps,
  user: User,
): Promise<Response> {
  if (!FULL_HASH.test(hash)) return notFound();
  const payload = await req.json().catch(() => null);
  if (
    !hasExactKeys(payload, [
      "schema",
      "viewed_sidecar_sha",
      "viewed_ref",
      "viewed_content_hash",
      "viewed_input_sha256",
      "viewed_algorithm_version",
      "decisions",
    ]) ||
    payload.schema !== HOUSEKEEPING_DECISION_SCHEMA ||
    typeof payload.viewed_sidecar_sha !== "string" ||
    !/^[a-f0-9]{40,64}$/.test(payload.viewed_sidecar_sha) ||
    typeof payload.viewed_ref !== "string" ||
    !/^[a-f0-9]{40,64}$/.test(payload.viewed_ref) ||
    typeof payload.viewed_content_hash !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(payload.viewed_content_hash) ||
    typeof payload.viewed_input_sha256 !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(payload.viewed_input_sha256) ||
    typeof payload.viewed_algorithm_version !== "string" ||
    !ALGORITHM_VERSION_TOKEN.test(payload.viewed_algorithm_version) ||
    !Array.isArray(payload.decisions) ||
    payload.decisions.length === 0 ||
    payload.decisions.some(
      (decision) =>
        !hasExactKeys(decision, ["item_id", "status"]) ||
        typeof decision.item_id !== "string" ||
        !decision.item_id ||
        (decision.status !== "approved" && decision.status !== "rejected"),
    )
  )
    return err(400, "Invalid housekeeping decision request");
  const decisions = new Map<string, "approved" | "rejected">();
  for (const decision of payload.decisions) {
    if (decisions.has(decision.item_id)) {
      return err(400, "Duplicate housekeeping decision id");
    }
    decisions.set(decision.item_id, decision.status);
  }

  const sidecarPath = `store/${hash}.housekeeping.json`;
  if ((await deps.github.getRef(env.ingestsRepo)) !== payload.viewed_ref) {
    return err(409, "Stale housekeeping proposal");
  }
  const manifestFile = await deps.github.getFileAt(
    env.ingestsRepo,
    HOUSEKEEPING_MANIFEST_PATH,
    payload.viewed_ref,
  );
  const manifestVersion = manifestFile && algorithmManifestVersion(manifestFile.text);
  if (manifestVersion == null || manifestVersion !== HOUSEKEEPING_ALGORITHM_VERSION) {
    return err(503, "Housekeeping algorithm manifest unavailable");
  }
  const sidecarFile = await deps.github.getFileAt(env.ingestsRepo, sidecarPath, payload.viewed_ref);
  if (sidecarFile == null) return notFound();
  if (sidecarFile.sha !== payload.viewed_sidecar_sha) {
    return err(409, "Stale housekeeping proposal");
  }
  const raw = sidecarFile.text;

  let sidecar: HousekeepingSidecar;
  try {
    sidecar = JSON.parse(raw);
  } catch {
    return err(500, "Unreadable housekeeping sidecar");
  }
  if (sidecar.schema !== "anomalica/housekeeping/2") {
    return err(409, "Housekeeping v1 proposal is due for a fresh pass");
  }
  if (sidecar.algorithm_version !== HOUSEKEEPING_ALGORITHM_VERSION) {
    return err(409, "Stale housekeeping proposal");
  }
  if (!validateV2Sidecar(sidecar)) {
    return err(422, "Invalid housekeeping/2 sidecar");
  }
  if (
    sidecar.content_hash !== `sha256:${hash}` ||
    sidecar.content_hash !== payload.viewed_content_hash ||
    sidecar.input_sha256 !== payload.viewed_input_sha256 ||
    sidecar.algorithm_version !== payload.viewed_algorithm_version ||
    sidecar.algorithm_version !== manifestVersion
  )
    return err(409, "Stale housekeeping proposal");

  const bodyPath = await resolveBodyPathAt(env, deps, hash, payload.viewed_ref);
  const bodyFile = await deps.github.getFileAt(env.ingestsRepo, bodyPath, payload.viewed_ref);
  if (bodyFile == null) return notFound();
  const current = bodyFile.text;
  if (`sha256:${await sha256Hex(current)}` !== sidecar.input_sha256) {
    return err(409, "Stale housekeeping proposal");
  }

  const known = new Set(sidecar.items.map((i) => i.id));
  if (known.size !== sidecar.items.length) {
    return err(422, "Duplicate housekeeping item id");
  }
  for (const id of decisions.keys()) {
    // A stale tab must not half-succeed.
    if (!known.has(id)) return err(400, `Unknown item: ${id}`);
  }
  const selected = [];
  for (const item of sidecar.items) {
    const decision = decisions.get(item.id);
    if (!decision) continue;
    // Already decided means the record has moved underneath this tab.
    if (item.status !== "proposed") {
      return err(409, `${item.id} is already ${item.status}`);
    }
    selected.push({ item, decision });
  }

  const approved = selected
    .filter(({ decision }) => decision === "approved")
    .map(({ item }) => item);
  const author = authorOf(user);
  const note = `housekeeping: ${approved.length} applied, ${
    decisions.size - approved.length
  } rejected`;

  if (approved.length) {
    let updated: string;
    try {
      const replacements = approved.filter(
        (item) => item.operation === "replace-token",
      ) as HousekeepingV2Item[];
      const frontmatter = approved.filter(
        (item) => item.operation !== "replace-token",
      ) as HousekeepingV1Item[];
      updated = applyTokenReplacements(current, replacements);
      if (frontmatter.length) {
        const approvedIds = new Set(
          sidecar.items
            .filter((item) => item.status === "approved" || decisions.get(item.id) === "approved")
            .map((item) => item.id),
        );
        const unmet = unmetDependencies(
          sidecar.items.filter(
            (item) => item.operation !== "replace-token",
          ) as HousekeepingV1Item[],
          approvedIds,
        );
        if (unmet.length) {
          return err(422, `Unmet dependencies: ${unmet.join(", ")}`);
        }
        const approvedFrontmatter = frontmatter.map((item) => ({
          ...item,
          status: "approved" as const,
        }));
        const result = await applyPatch(updated, approvedFrontmatter);
        if (result.didNotApply.length || result.applied.length !== approvedFrontmatter.length) {
          return err(409, "Stale housekeeping proposal");
        }
        updated = result.text;
      }
    } catch (e) {
      if (e instanceof ApplyConflict) return err(409, e.message);
      if (e instanceof BodyChanged) return err(500, e.message);
      if (e instanceof MultilineField) return err(422, e.message);
      if (e instanceof InvalidReplacement) return err(422, e.message);
      throw e;
    }
    for (const { item, decision } of selected) item.status = decision;
    const updatedSidecar = JSON.stringify(sidecar, null, 2) + "\n";
    try {
      await deps.github.commitFiles(
        env.ingestsRepo,
        [
          { path: bodyPath, text: updated, expectedSha: bodyFile.sha },
          {
            path: sidecarPath,
            text: updatedSidecar,
            expectedSha: sidecarFile.sha,
          },
        ],
        `${note} - ${hash.slice(0, 12)}`,
        author,
        { expectedRef: payload.viewed_ref },
      );
    } catch (e) {
      if (e instanceof GitHubError && (e.status === 409 || e.status === 422)) {
        return err(409, "Stale housekeeping proposal");
      }
      throw e;
    }
  } else {
    for (const { item, decision } of selected) item.status = decision;
    try {
      await deps.github.commitFiles(
        env.ingestsRepo,
        [
          {
            path: sidecarPath,
            text: JSON.stringify(sidecar, null, 2) + "\n",
            expectedSha: sidecarFile.sha,
          },
        ],
        `${note} - ${hash.slice(0, 12)} (decisions)`,
        author,
        { expectedRef: payload.viewed_ref },
      );
    } catch (e) {
      if (e instanceof GitHubError && (e.status === 409 || e.status === 422)) {
        return err(409, "Stale housekeeping proposal");
      }
      throw e;
    }
  }

  return json({
    applied: approved.length,
    rejected: decisions.size - approved.length,
  });
}

async function handleCuration(
  action: string,
  req: Request,
  env: Env,
  deps: Deps,
  user: User,
): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    survivor?: NodeRef;
    victims?: NodeRef[];
    canonical_name?: string;
    merge_id?: string;
    rejection_id?: string;
    nodes?: NodeRef[];
    reason?: string;
  };
  const at = isoSeconds(new Date(deps.nowSec() * 1000));
  const by = user.email || null;
  const author = authorOf(user);

  if (action === "merge") {
    if (!body.survivor?.id || !body.victims?.length || !body.canonical_name) {
      return err(400, "survivor, victims and canonical_name are required");
    }
    if (body.victims.some((v) => v.id === body.survivor!.id)) {
      return err(400, "survivor cannot also be a victim");
    }
    const entry = buildMergeEntry({
      mergeId: crypto.randomUUID(),
      at,
      by,
      canonicalName: body.canonical_name,
      survivor: body.survivor,
      victims: body.victims,
    });
    await deps.github.editFile(
      env.curationRepo,
      "merges.yaml",
      (cur) => appendEntry(cur, entry),
      `curation merge: ${body.canonical_name}`,
      author,
    );
    return json({ ok: true, merge_id: entry.merge_id });
  }

  if (action === "unmerge") {
    if (!body.merge_id) return err(400, "merge_id is required");
    await deps.github.editFile(
      env.curationRepo,
      "merges.yaml",
      (cur) => appendEntry(cur, buildUndoEntry(body.merge_id!, by, at)),
      `curation unmerge: ${body.merge_id}`,
      author,
    );
    return json({ ok: true });
  }

  if (action === "reject") {
    if (!body.nodes || body.nodes.length < 2) {
      return err(400, "need at least two node ids to reject as distinct");
    }
    const entry = buildRejectEntry({
      rejectionId: crypto.randomUUID(),
      at,
      by,
      reason: body.reason ?? null,
      nodes: body.nodes,
    });
    await deps.github.editFile(
      env.curationRepo,
      "rejections.yaml",
      (cur) => appendEntry(cur, entry),
      `curation reject: ${body.nodes.length} nodes`,
      author,
    );
    return json({ ok: true, rejection_id: entry.rejection_id });
  }

  if (action === "unreject") {
    if (!body.rejection_id) return err(400, "rejection_id is required");
    await deps.github.editFile(
      env.curationRepo,
      "rejections.yaml",
      (cur) => appendEntry(cur, buildUnrejectEntry(body.rejection_id!, by, at)),
      `curation unreject: ${body.rejection_id}`,
      author,
    );
    return json({ ok: true });
  }
  return notFound();
}

// Reviewer-facing summary of a commit: the subject line, plus the reviewer's
// notes ("Reviewed up to 20%") if any were given - the detail a reviewer
// resuming later actually needs, not just the commit title. Notes are the
// commit body with blank lines and Reviewed-Record: identity trailers (see
// architecture/review-workbench.md) stripped, since those aren't for humans.
function commitSummary(message: string): string {
  const [subject, ...rest] = message.split("\n");
  const notes = rest
    .filter((line) => line.trim() && !line.startsWith("Reviewed-Record:"))
    .join("\n")
    .trim();
  return notes ? `${subject} - ${notes}` : subject;
}

// The review history of a record: every reviewer's edits to the canonical body,
// from git. Live (not the static snapshot, which lags), public read. Reviewer
// EMAIL is dropped - only name + date + summary reach the client.
async function handleHistory(hash: string, env: Env, deps: Deps): Promise<Response> {
  if (!FULL_HASH.test(hash)) return notFound();
  const bodyPath = await resolveBodyPath(env, deps, hash);
  const commits = await deps.github.listCommits(env.ingestsRepo, bodyPath);
  return json({
    history: commits.map((c) => ({
      by: c.by,
      at: c.at,
      summary: commitSummary(c.message),
    })),
  });
}

// Presentation directives for one assembled article. Written to the per-article
// sidecar content/pages/<section>/<slug>.directives.yaml - a standalone YAML list
// of strings the assembler reads for EVERY language render of that article (so a
// single write is cross-language, no 30-frontmatter fan-out). Presentation-only:
// the assembler enforces in-prompt that a directive can never add/drop/change a
// fact; the UI labels it too. The sidecar must stay valid YAML or the assembler
// silently drops it, so we re-serialise the whole list rather than text-append.
async function handleArticleDirectives(
  section: string,
  slug: string,
  req: Request,
  env: Env,
  deps: Deps,
  user: User,
): Promise<Response> {
  if (!ARTICLE_SECTION.test(section) || !ARTICLE_SLUG.test(slug)) {
    return notFound();
  }
  const body = (await req.json().catch(() => ({}))) as { directives?: unknown };
  if (!Array.isArray(body.directives)) {
    return err(400, "Missing directives list");
  }

  const seen = new Set<string>();
  const directives: string[] = [];
  for (const d of body.directives) {
    if (typeof d !== "string") {
      return err(400, "Each directive must be a string");
    }
    const s = d.trim();
    if (!s) continue;
    if (s.length > MAX_DIRECTIVE_LEN) return err(400, "Directive too long");
    if (!seen.has(s)) {
      seen.add(s);
      directives.push(s);
    }
  }

  const path = `pages/${section}/${slug}.directives.yaml`;
  await deps.github.editFile(
    env.contentRepo,
    path,
    // Set the whole list (the standalone sidecar has no other content to keep).
    () => (directives.length ? stringifyYaml(directives) : "[]\n"),
    `directives: ${section}/${slug} (${directives.length})`,
    authorOf(user),
  );
  return json({ ok: true, directives });
}

async function route(req: Request, env: Env, deps: Deps): Promise<Response> {
  const { pathname } = new URL(req.url);
  const method = req.method;

  if (pathname.startsWith("/api/auth/")) {
    return handleAuth(pathname, req, env, deps);
  }

  // Gate (public reads + the possession challenge - no login needed to prove possession).
  const gate = pathname.match(/^\/api\/ingests\/([^/]+)\/verification(?:\/(start|submit))?$/);
  if (gate) {
    const [, hash, action] = gate;
    if (action === "start" || action === "submit") {
      if (method !== "POST") return err(405, "Method not allowed");
    } else if (method !== "GET") return err(405, "Method not allowed");
    return handleGate(hash, action ?? "", req, env, deps);
  }

  // Review history (public read - who edited this record, from git).
  const history = pathname.match(/^\/api\/ingests\/([^/]+)\/history$/);
  if (history) {
    if (method !== "GET") return err(405, "Method not allowed");
    return handleHistory(history[1], env, deps);
  }

  // Everything past here writes - require a logged-in user AND a role that may
  // write. Being logged in is NOT enough: unlisted logins default to contributor
  // and are refused, which is what stops any GitHub account committing to live
  // data. Mirrors backend/roles.py; see edge/lib/roles.ts.
  const user = await readSession(env, req.headers.get("cookie"), deps.nowSec());
  let resolvedRole: Role | null = null;

  /** 401 when logged out, 403 when the role is below `minimum`, else null. */
  const denyUnless = async (minimum: Role): Promise<Response | null> => {
    if (!user) return err(401, "Login required");
    if (resolvedRole == null) {
      resolvedRole = roleOf(user.login, await loadRoles(env, deps));
    }
    return atLeast(resolvedRole, minimum) ? null : err(403, `Requires ${minimum} role`);
  };

  // The caller's own role, so the UI can show the right affordances. Login-only:
  // it reveals nothing but your own role.
  if (pathname === "/api/me/role" && method === "GET") {
    if (!user) return json({ role: DEFAULT_ROLE });
    return json({ role: roleOf(user.login, await loadRoles(env, deps)) });
  }

  const review = pathname.match(/^\/api\/ingests\/([^/]+)$/);
  if (review && method === "PUT") {
    const denied = await denyUnless("reviewer");
    if (denied) return denied;
    return handleReviewWrite(review[1], req, env, deps, user!, resolvedRole!);
  }

  const housekeep = pathname.match(/^\/api\/ingests\/([^/]+)\/housekeeping\/decide$/);
  if (housekeep && method === "POST") {
    const denied = await denyUnless("reviewer");
    if (denied) return denied;
    return handleHousekeepingDecide(housekeep[1], req, env, deps, user!);
  }

  const curate = pathname.match(/^\/api\/curation\/(merge|unmerge|reject|unreject)$/);
  if (curate && method === "POST") {
    const denied = await denyUnless("reviewer");
    if (denied) return denied;
    return handleCuration(curate[1], req, env, deps, user!);
  }

  // Article directives are an editor+ op (the four-tier op-split).
  const directives = pathname.match(/^\/api\/articles\/([^/]+)\/([^/]+)\/directives$/);
  if (directives && method === "PUT") {
    const denied = await denyUnless("editor");
    if (denied) return denied;
    return handleArticleDirectives(directives[1], directives[2], req, env, deps, user!);
  }

  return notFound();
}

export async function handleRequest(req: Request, env: Env, deps: Deps): Promise<Response> {
  try {
    return await route(req, env, deps);
  } catch (e) {
    // A GitHub API failure (bad/expired service token, permission, sha conflict)
    // throws GitHubError - surface a diagnosable upstream status rather than letting
    // it bubble to a bare, body-less Bunny 500 (which masked a malformed service
    // token on 2026-06-22). Other unexpected throws still get a clean 500.
    if (e instanceof GitHubError) {
      return err(502, `upstream write failed: GitHub ${e.status}`);
    }
    return err(500, "internal error");
  }
}

// --- env + deps (the Deno.serve entry lives in serve.ts, so importing this
// module for tests never starts a server) ---

export function loadEnv(): Env {
  const get = (k: string, d = "") => Deno.env.get(k) ?? d;
  return {
    clientId: get("GITHUB_CLIENT_ID"),
    clientSecret: get("GITHUB_CLIENT_SECRET"),
    publicUrl: get("PUBLIC_URL", "http://localhost:1947"),
    sessionSecret: get("SESSION_SECRET", "dev-insecure-secret"),
    serviceToken: get("GITHUB_SERVICE_TOKEN"),
    owner: get("GITHUB_OWNER", "anomalica"),
    ingestsRepo: get("INGESTS_REPO", "ingests"),
    curationRepo: get("CURATION_REPO", "curation"),
    contentRepo: get("CONTENT_REPO", "content"),
    branch: get("GIT_BRANCH", "main"),
    bunnyHost: get("BUNNY_ZONE_HOST"),
    bunnyKey: get("BUNNY_TOKEN_KEY"),
    gateTtlSeconds: Number(get("GATE_TTL_SECONDS", "300")),
    serveGatedBody: get("SERVE_GATED_BODY") === "1",
  };
}

export function buildDeps(env: Env): Deps {
  return {
    github: new GitHubClient(env.serviceToken, env.owner, env.branch),
    nowSec: () => Math.floor(Date.now() / 1000),
  };
}
