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
import { stringify as stringifyYaml } from "jsr:@std/yaml@1";
import { signedUrl } from "./lib/bunny.ts";
import { needed, scoreSession, startSession } from "./lib/gate.ts";
import { type Author, type FileState, GitHubClient, GitHubError } from "./lib/github.ts";
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
// by the workbench's _scan + records/ symlink), else {hash}.md. Reviews write it
// and the history reads it.
async function resolveBodyPath(env: Env, deps: Deps, hash: string): Promise<string> {
  const v2 = `store/${hash}.v2.md`;
  return (await deps.github.getFile(env.ingestsRepo, v2)) ? v2 : `store/${hash}.md`;
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
        const md = (
          await deps.github.getFile(env.ingestsRepo, await resolveBodyPath(env, deps, hash))
        )?.text;
        if (md != null) {
          const m = md.match(/^(---\n[\s\S]*?\n---\n)([\s\S]*)$/);
          out.raw_frontmatter = m ? m[1] : "";
          out.body = m ? m[2] : md;
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
): Promise<Response> {
  if (!FULL_HASH.test(hash)) return notFound();
  const body = (await req.json().catch(() => ({}))) as {
    content?: string;
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
  const notes = (body.notes ?? "").trim();
  const author = authorOf(user);

  const bodyPath = await resolveBodyPath(env, deps, hash);

  await deps.github.editFile(
    env.ingestsRepo,
    bodyPath,
    () => body.content as string,
    `review: ${hash.slice(0, 12)}${notes ? ` - ${notes}` : ""}`,
    author,
  );

  const spans = Array.isArray(body.spans) ? body.spans : [];
  const verdict = body.verdict;
  if (spans.length || verdict?.observed_coverage != null) {
    await deps.github.editFile(
      env.ingestsRepo,
      `store/${hash}.review.json`,
      (cur) => {
        const sidecar = cur
          ? JSON.parse(cur)
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
        return JSON.stringify(sidecar, null, 2) + "\n";
      },
      `review-coverage: ${hash.slice(0, 12)}`,
      author,
    );
  }
  return json({ submitted: true });
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

  /** 401 when logged out, 403 when the role is below `minimum`, else null. */
  const denyUnless = async (minimum: Role): Promise<Response | null> => {
    if (!user) return err(401, "Login required");
    const role = roleOf(user.login, await loadRoles(env, deps));
    return atLeast(role, minimum) ? null : err(403, `Requires ${minimum} role`);
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
    return handleReviewWrite(review[1], req, env, deps, user!);
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
    publicUrl: get("PUBLIC_URL", "http://localhost:5173"),
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
