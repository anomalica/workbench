import { assert, assertEquals } from "jsr:@std/assert@1";
import { parseAll } from "jsr:@std/yaml@1";
import { makeSessionCookie, type User } from "./lib/auth.ts";
import type { Author, FileState } from "./lib/github.ts";
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
  branch: "main",
  bunnyHost: "cdn.example.b-cdn.net",
  bunnyKey: "test-security-key",
  gateTtlSeconds: 300,
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

Deno.test("unknown route -> 404", async () => {
  const res = await handleRequest(req("/api/nope"), ENV, deps(new FakeGitHub()));
  assertEquals(res.status, 404);
});
