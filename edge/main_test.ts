import { assert, assertEquals } from "jsr:@std/assert@1";
import { parse, parseAll } from "jsr:@std/yaml@1";
import { makeSessionCookie, type User } from "./lib/auth.ts";
import { type Author, type FileState, GitHubError } from "./lib/github.ts";
import { type Deps, type Env, handleRequest } from "./main.ts";

const ENV: Env = {
  clientId: "cid",
  clientSecret: "cs",
  publicUrl: "https://wb.example.is",
  sessionSecret: "sekret",
  serviceToken: "svc",
  owner: "anomalica",
  ingestsRepo: "ingests",
  curationRepo: "curation",
  contentRepo: "content",
  branch: "main",
  bunnyHost: "cdn.example.b-cdn.net",
  bunnyKey: "test-security-key",
  gateTtlSeconds: 300,
  serveGatedBody: false, // production-safe default; body-serving tests opt in
};
const NOW = 1000;
const HASH = "a".repeat(64);
const USER: User = { name: "Rev", email: "rev@x.com", login: "rev", avatar_url: "" };

class FakeGitHub {
  files = new Map<string, string>();
  put(repo: string, path: string, text: string) {
    this.files.set(`${repo}/${path}`, text);
  }
  getFile(repo: string, path: string): Promise<FileState | null> {
    const k = `${repo}/${path}`;
    return Promise.resolve(this.files.has(k) ? { text: this.files.get(k)!, sha: "s" } : null);
  }
  editFile(
    repo: string,
    path: string,
    transform: (cur: string) => string,
    _msg: string,
    _author: Author,
  ): Promise<string> {
    const k = `${repo}/${path}`;
    this.files.set(k, transform(this.files.get(k) ?? ""));
    return Promise.resolve("newsha");
  }
  commits = new Map<string, { by: string; email: string; at: string; message: string }[]>();
  listCommits(repo: string, path: string) {
    return Promise.resolve(this.commits.get(`${repo}/${path}`) ?? []);
  }
}

function deps(gh: FakeGitHub): Deps {
  return { github: gh, nowSec: () => NOW };
}
const sidecar = (n: number, extra = {}) => ({
  algorithm: "cloze-v1",
  challenges: Array.from({ length: n }, (_, i) => ({
    before: `b${i}`,
    after: `a${i}`,
    answer: `word${i}`,
  })),
  ...extra,
});
async function cookie(): Promise<string> {
  return (await makeSessionCookie(ENV, USER, NOW)).split(";")[0];
}
const req = (path: string, init?: RequestInit) => new Request(`https://wb.example.is${path}`, init);

Deno.test("auth/me without a cookie -> null", async () => {
  const res = await handleRequest(req("/api/auth/me"), ENV, deps(new FakeGitHub()));
  assertEquals(await res.json(), { user: null });
});

Deno.test("auth/login redirects to GitHub", async () => {
  const res = await handleRequest(req("/api/auth/login"), ENV, deps(new FakeGitHub()));
  assertEquals(res.status, 302);
  assert(res.headers.get("location")!.startsWith("https://github.com/login/oauth/authorize"));
});

Deno.test("gate info reports availability from the private sidecar", async () => {
  const gh = new FakeGitHub();
  gh.put("ingests", `store/${HASH}.verification.json`, JSON.stringify(sidecar(10)));
  const res = await handleRequest(req(`/api/ingests/${HASH}/verification`), ENV, deps(gh));
  const body = await res.json();
  assertEquals(body.available, true);
  assertEquals(body.pool_size, 10);
  assertEquals(body.min_correct_to_pass, 8);
});

Deno.test("gate info: no sidecar -> not available (ungated record)", async () => {
  const res = await handleRequest(
    req(`/api/ingests/${HASH}/verification`),
    ENV,
    deps(new FakeGitHub()),
  );
  assertEquals(await res.json(), { available: false });
});

Deno.test("gate start never leaks answers; submit all-correct -> signed Bunny URL", async () => {
  const gh = new FakeGitHub();
  gh.put("ingests", `store/${HASH}.verification.json`, JSON.stringify(sidecar(10)));

  const startRes = await handleRequest(
    req(`/api/ingests/${HASH}/verification/start`, { method: "POST" }),
    ENV,
    deps(gh),
  );
  const started = await startRes.json();
  assertEquals(started.challenges.length, 10);
  assert(!JSON.stringify(started).includes("word0"), "answer leaked");

  // Answer them all correctly (challenge.before is `b<i>`, the test answer `word<i>`).
  const responses: Record<string, string> = {};
  for (const c of started.challenges) {
    const i = Number(c.before.slice(1));
    responses[String(c.id)] = `word${i}`;
  }
  const submitRes = await handleRequest(
    req(`/api/ingests/${HASH}/verification/submit`, {
      method: "POST",
      body: JSON.stringify({ session_id: started.session_id, responses, ext: "mp4" }),
    }),
    ENV,
    deps(gh),
  );
  const out = await submitRes.json();
  assertEquals(out.passed, true);
  assertEquals(out.score, 10);
  assert(out.url.startsWith(`https://cdn.example.b-cdn.net/sources/${HASH}.mp4?token=HS256-`));
  assert(out.url.includes("expires="));
  assertEquals(out.expires_in, 300);
});

Deno.test("gate submit: SHA fastpath passes without a session", async () => {
  const gh = new FakeGitHub();
  gh.put(
    "ingests",
    `store/${HASH}.verification.json`,
    JSON.stringify(sidecar(10, { sha256: "DEADBEEF" })),
  );
  const res = await handleRequest(
    req(`/api/ingests/${HASH}/verification/submit`, {
      method: "POST",
      body: JSON.stringify({ sha256: "deadbeef" }),
    }),
    ENV,
    deps(gh),
  );
  const out = await res.json();
  assertEquals(out.passed, true);
  assertEquals(out.method, "sha256");
});

Deno.test("gate submit pass: serves the gated body from the canonical .v2 record", async () => {
  const gh = new FakeGitHub();
  gh.put(
    "ingests",
    `store/${HASH}.verification.json`,
    JSON.stringify(sidecar(10, { sha256: "DEADBEEF" })),
  );
  // The canonical .v2.md wins over a stray v1 .md (the workbench reads .v2.md).
  gh.put("ingests", `store/${HASH}.md`, "---\ntitle: STALE\n---\nstale body\n");
  const v2 =
    "---\ntitle: A Gated Book\ncopyright:\n  status: licensed\n---\nThe body.\nLine two.\n";
  gh.put("ingests", `store/${HASH}.v2.md`, v2);

  const res = await handleRequest(
    req(`/api/ingests/${HASH}/verification/submit`, {
      method: "POST",
      body: JSON.stringify({ sha256: "deadbeef" }),
    }),
    { ...ENV, serveGatedBody: true }, // body-serving requires the explicit flag
    deps(gh),
  );
  const out = await res.json();
  assertEquals(out.passed, true);
  assertEquals(
    out.raw_frontmatter,
    "---\ntitle: A Gated Book\ncopyright:\n  status: licensed\n---\n",
  );
  assertEquals(out.body, "The body.\nLine two.\n");
  // raw_frontmatter + body reconstructs the full canonical record (safe write-back).
  assertEquals(out.raw_frontmatter + out.body, v2);
});

Deno.test("gate submit: SERVE_GATED_BODY off -> a pass returns NO body (copyright gate)", async () => {
  const gh = new FakeGitHub();
  gh.put(
    "ingests",
    `store/${HASH}.verification.json`,
    JSON.stringify(sidecar(10, { sha256: "DEADBEEF" })),
  );
  gh.put("ingests", `store/${HASH}.v2.md`, "---\ntitle: x\n---\nSECRET BODY\n");
  const res = await handleRequest(
    req(`/api/ingests/${HASH}/verification/submit`, {
      method: "POST",
      body: JSON.stringify({ sha256: "deadbeef" }),
    }),
    ENV, // flag off (default)
    deps(gh),
  );
  const out = await res.json();
  assertEquals(out.passed, true); // possession still proven
  assertEquals(out.body, undefined); // ...but the body is NOT served with the flag off
  assertEquals(out.raw_frontmatter, undefined);
});

Deno.test("gate submit FAIL: never returns the gated body (no leak)", async () => {
  const gh = new FakeGitHub();
  gh.put("ingests", `store/${HASH}.verification.json`, JSON.stringify(sidecar(10)));
  gh.put("ingests", `store/${HASH}.v2.md`, "---\ntitle: secret\n---\nSECRET BODY\n");
  const startRes = await handleRequest(
    req(`/api/ingests/${HASH}/verification/start`, { method: "POST" }),
    ENV,
    deps(gh),
  );
  const started = await startRes.json();
  const responses: Record<string, string> = {};
  for (const c of started.challenges) responses[String(c.id)] = "WRONG";
  const res = await handleRequest(
    req(`/api/ingests/${HASH}/verification/submit`, {
      method: "POST",
      body: JSON.stringify({ session_id: started.session_id, responses }),
    }),
    { ...ENV, serveGatedBody: true }, // even with serving ENABLED, a FAIL gets no body
    deps(gh),
  );
  const out = await res.json();
  assertEquals(out.passed, false);
  assertEquals(out.body, undefined);
  assertEquals(out.raw_frontmatter, undefined);
});

Deno.test("article directives: PUT needs auth", async () => {
  const gh = new FakeGitHub();
  const res = await handleRequest(
    req(`/api/articles/people/luis-elizondo/directives`, {
      method: "PUT",
      body: JSON.stringify({ directives: ["Use the full name Luis Elizondo"] }),
    }),
    ENV,
    deps(gh),
  );
  assertEquals(res.status, 401);
  assertEquals(gh.files.size, 0);
});

Deno.test("article directives: writes the per-article sidecar as a YAML list", async () => {
  const gh = new FakeGitHub();
  const res = await handleRequest(
    req(`/api/articles/people/luis-elizondo/directives`, {
      method: "PUT",
      headers: { cookie: await cookie() },
      body: JSON.stringify({
        // trimmed, blanks dropped, deduped, order preserved
        directives: [
          "  Use the full name Luis Elizondo  ",
          "",
          "Use the full name Luis Elizondo",
          "Prefer active voice",
        ],
      }),
    }),
    ENV,
    deps(gh),
  );
  assertEquals(res.status, 200);
  const out = await res.json();
  assertEquals(out.directives, ["Use the full name Luis Elizondo", "Prefer active voice"]);
  // Written to the cross-language per-article sidecar in the CONTENT repo...
  const written = gh.files.get("content/pages/people/luis-elizondo.directives.yaml")!;
  assert(written, "sidecar not written");
  // ...as valid YAML the assembler can safe_load back to the same list.
  assertEquals(parse(written), ["Use the full name Luis Elizondo", "Prefer active voice"]);
});

Deno.test("article directives: an empty list writes an empty YAML list", async () => {
  const gh = new FakeGitHub();
  const res = await handleRequest(
    req(`/api/articles/people/luis-elizondo/directives`, {
      method: "PUT",
      headers: { cookie: await cookie() },
      body: JSON.stringify({ directives: [] }),
    }),
    ENV,
    deps(gh),
  );
  assertEquals(res.status, 200);
  assertEquals(parse(gh.files.get("content/pages/people/luis-elizondo.directives.yaml")!), []);
});

Deno.test("article directives: rejects an invalid slug (traversal/extension), writes nothing", async () => {
  const gh = new FakeGitHub();
  const res = await handleRequest(
    req(`/api/articles/people/luis.elizondo/directives`, {
      method: "PUT",
      headers: { cookie: await cookie() },
      body: JSON.stringify({ directives: ["x"] }),
    }),
    ENV,
    deps(gh),
  );
  assertEquals(res.status, 404);
  assertEquals(gh.files.size, 0);
});

Deno.test("article directives: a non-array body is a 400", async () => {
  const gh = new FakeGitHub();
  const res = await handleRequest(
    req(`/api/articles/people/luis-elizondo/directives`, {
      method: "PUT",
      headers: { cookie: await cookie() },
      body: JSON.stringify({ directives: "not a list" }),
    }),
    ENV,
    deps(gh),
  );
  assertEquals(res.status, 400);
  assertEquals(gh.files.size, 0);
});

Deno.test("curation merge needs auth, then appends a ledger entry", async () => {
  const gh = new FakeGitHub();
  const merge = {
    survivor: { id: "s1", name: "Tic Tac", node_type: "object", aliases: [] },
    victims: [{ id: "v1", name: "Tic-Tac UAP", node_type: "object" }],
    canonical_name: "Tic Tac",
  };
  // no cookie -> 401
  const unauth = await handleRequest(
    req("/api/curation/merge", { method: "POST", body: JSON.stringify(merge) }),
    ENV,
    deps(gh),
  );
  assertEquals(unauth.status, 401);

  // with cookie -> ok + the ledger now holds a parseable merge entry
  const ok = await handleRequest(
    req("/api/curation/merge", {
      method: "POST",
      headers: { cookie: await cookie() },
      body: JSON.stringify(merge),
    }),
    ENV,
    deps(gh),
  );
  assertEquals(ok.status, 200);
  assertEquals((await ok.json()).ok, true);
  const [entry] = parseAll(gh.files.get("curation/merges.yaml")!) as Record<string, unknown>[];
  assertEquals(entry.op, "merge");
  assertEquals((entry.audit as { victim_ids: string[] }).victim_ids, ["v1"]);
  assertEquals(entry.by, "rev@x.com");
});

Deno.test("curation reject appends to rejections.yaml", async () => {
  const gh = new FakeGitHub();
  const res = await handleRequest(
    req("/api/curation/reject", {
      method: "POST",
      headers: { cookie: await cookie() },
      body: JSON.stringify({
        nodes: [
          { id: "n1", name: "S1632", node_type: "matter" },
          { id: "n2", name: "S1673", node_type: "matter" },
        ],
        reason: "distinct",
      }),
    }),
    ENV,
    deps(gh),
  );
  assertEquals((await res.json()).ok, true);
  const [entry] = parseAll(gh.files.get("curation/rejections.yaml")!) as Record<string, unknown>[];
  assertEquals(entry.op, "reject");
  assertEquals((entry.audit as { node_ids: string[] }).node_ids, ["n1", "n2"]);
});

Deno.test("review PUT needs auth, then commits the corrected record", async () => {
  const gh = new FakeGitHub();
  const payload = JSON.stringify({
    content: "# corrected body\n",
    notes: "fixed speaker",
  });

  const unauth = await handleRequest(
    req(`/api/ingests/${HASH}`, { method: "PUT", body: payload }),
    ENV,
    deps(gh),
  );
  assertEquals(unauth.status, 401);

  const ok = await handleRequest(
    req(`/api/ingests/${HASH}`, {
      method: "PUT",
      headers: { cookie: await cookie() },
      body: payload,
    }),
    ENV,
    deps(gh),
  );
  assertEquals((await ok.json()).submitted, true);
  assertEquals(gh.files.get(`ingests/store/${HASH}.md`), "# corrected body\n");
});

Deno.test("review of a V2 record writes the canonical .v2.md, not a stray .md", async () => {
  const gh = new FakeGitHub();
  gh.put("ingests", `store/${HASH}.v2.md`, "old v2 body\n"); // canonical exists
  const ok = await handleRequest(
    req(`/api/ingests/${HASH}`, {
      method: "PUT",
      headers: { cookie: await cookie() },
      body: JSON.stringify({ content: "# corrected v2 body\n", notes: "fix speakers" }),
    }),
    ENV,
    deps(gh),
  );
  assertEquals((await ok.json()).submitted, true);
  // landed on the canonical .v2.md; did NOT create a stray .md
  assertEquals(gh.files.get(`ingests/store/${HASH}.v2.md`), "# corrected v2 body\n");
  assertEquals(gh.files.has(`ingests/store/${HASH}.md`), false);
});

Deno.test("review history: public read, maps git commits, drops reviewer email", async () => {
  const gh = new FakeGitHub();
  gh.put("ingests", `store/${HASH}.v2.md`, "body\n"); // v2 record -> history reads .v2.md
  gh.commits.set(`ingests/store/${HASH}.v2.md`, [
    { by: "Mark", email: "mark@x.com", at: "2026-06-22T02:35:31Z", message: "review: fix names" },
    { by: "Sam", email: "sam@x.com", at: "2026-06-21T09:00:00Z", message: "review: first pass" },
  ]);
  const res = await handleRequest(req(`/api/ingests/${HASH}/history`), ENV, deps(gh)); // no cookie
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.history, [
    { by: "Mark", at: "2026-06-22T02:35:31Z", summary: "review: fix names" },
    { by: "Sam", at: "2026-06-21T09:00:00Z", summary: "review: first pass" },
  ]);
  assert(!JSON.stringify(body).includes("@x.com"), "reviewer email must not leak");
});

Deno.test("unknown route -> 404", async () => {
  const res = await handleRequest(req("/api/nope"), ENV, deps(new FakeGitHub()));
  assertEquals(res.status, 404);
});

Deno.test("a GitHub write failure surfaces a 502, not a bare 500", async () => {
  const gh = {
    getFile: () => Promise.resolve(null),
    editFile: () => Promise.reject(new GitHubError(401, "Bad credentials")),
    listCommits: () => Promise.resolve([]),
  };
  const res = await handleRequest(
    req("/api/curation/reject", {
      method: "POST",
      headers: { cookie: await cookie() },
      body: JSON.stringify({
        nodes: [
          { id: "n1", name: "A", node_type: "matter" },
          { id: "n2", name: "B", node_type: "matter" },
        ],
      }),
    }),
    ENV,
    { github: gh, nowSec: () => NOW },
  );
  assertEquals(res.status, 502);
  assertEquals((await res.json()).detail, "upstream write failed: GitHub 401");
});
