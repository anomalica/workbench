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
import { signedUrl } from "./lib/bunny.ts";
import { needed, scoreSession, startSession } from "./lib/gate.ts";
import { type Author, type FileState, GitHubClient } from "./lib/github.ts";
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
const CHALLENGES_PER_SESSION = 10;
const MIN_POOL_FOR_CLOZE_GATE = 5;

export interface Env extends AuthConfig {
  serviceToken: string;
  owner: string;
  ingestsRepo: string;
  curationRepo: string;
  branch: string;
  bunnyHost: string;
  bunnyKey: string;
  gateTtlSeconds: number;
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
      if (!result.ok) return err(400, `Invalid or expired session (${result.reason})`);
      passed = result.passed;
      score = result.score;
      need = result.needed;
    }

    const out: Record<string, unknown> = { passed, method, score, needed: need };
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

  await deps.github.editFile(
    env.ingestsRepo,
    `store/${hash}.md`,
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
          if (verdict.total_units != null) sidecar.total_units = verdict.total_units;
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

export async function handleRequest(req: Request, env: Env, deps: Deps): Promise<Response> {
  const { pathname } = new URL(req.url);
  const method = req.method;

  if (pathname.startsWith("/api/auth/")) return handleAuth(pathname, req, env, deps);

  // Gate (public reads + the possession challenge - no login needed to prove possession).
  const gate = pathname.match(/^\/api\/ingests\/([^/]+)\/verification(?:\/(start|submit))?$/);
  if (gate) {
    const [, hash, action] = gate;
    if (action === "start" || action === "submit") {
      if (method !== "POST") return err(405, "Method not allowed");
    } else if (method !== "GET") return err(405, "Method not allowed");
    return handleGate(hash, action ?? "", req, env, deps);
  }

  // Everything past here writes - require a logged-in reviewer.
  const user = await readSession(env, req.headers.get("cookie"), deps.nowSec());

  const review = pathname.match(/^\/api\/ingests\/([^/]+)$/);
  if (review && method === "PUT") {
    if (!user) return err(401, "Login required");
    return handleReviewWrite(review[1], req, env, deps, user);
  }

  const curate = pathname.match(/^\/api\/curation\/(merge|unmerge|reject|unreject)$/);
  if (curate && method === "POST") {
    if (!user) return err(401, "Login required");
    return handleCuration(curate[1], req, env, deps, user);
  }

  return notFound();
}

// --- Deno entry (Bunny Edge Scripting / Deno Deploy / local `deno task dev`) ---

function loadEnv(): Env {
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
    branch: get("GIT_BRANCH", "main"),
    bunnyHost: get("BUNNY_ZONE_HOST"),
    bunnyKey: get("BUNNY_TOKEN_KEY"),
    gateTtlSeconds: Number(get("GATE_TTL_SECONDS", "300")),
  };
}

if (import.meta.main) {
  const env = loadEnv();
  const github = new GitHubClient(env.serviceToken, env.owner, env.branch);
  const deps: Deps = { github, nowSec: () => Math.floor(Date.now() / 1000) };
  Deno.serve((req) => handleRequest(req, env, deps));
}
