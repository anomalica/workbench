import { assert, assertEquals } from "jsr:@std/assert@1";
import { parse, parseAll } from "jsr:@std/yaml@1";
import { makeSessionCookie, type User } from "./lib/auth.ts";
import { sha256Hex, verifyToken } from "./lib/crypto.ts";
import {
  type AtomicFileChange,
  type Author,
  type CommitFilesResult,
  type DirectoryEntry,
  type FileState,
  GitHubError,
} from "./lib/github.ts";
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
const PUBLIC_HASH = HASH.slice(0, 56);
const REF = "b".repeat(40);
const FILE_SHA = "c".repeat(40);
const ALGORITHM_MANIFEST =
  '{ "algorithm_version": "1", "schema": "anomalica/housekeeping-algorithm/1" }\n';
const USER: User = {
  name: "Rev",
  email: "rev@x.com",
  login: "rev",
  avatar_url: "",
};

class FakeGitHub {
  files = new Map<string, string>();
  shas = new Map<string, string>();
  ref = REF;
  /** Paths the fixture seeded rather than the code under test writing them, so
   *  a "writes nothing" assertion stays meaningful. */
  seeded = new Set<string>();
  /** Files actually written by the code under test. */
  get wrote(): string[] {
    return [...this.files.keys()].filter((k) => !this.seeded.has(k));
  }
  constructor() {
    // Every write route is role-gated (edge/lib/roles.ts), so the fixture user
    // needs a role or nothing would be writable. `rev` is an editor: that covers
    // the reviewer-level writes (records, curation) AND the editor-level ones
    // (article directives). The gate itself is tested explicitly below.
    this.files.set("ingests/roles.yaml", "rev: editor\n");
    this.seeded.add("ingests/roles.yaml");
    this.put("ingests", "housekeeping-algorithm.json", ALGORITHM_MANIFEST);
    this.seeded.add("ingests/housekeeping-algorithm.json");
    this.put(
      "ingests",
      `store/${HASH}.md`,
      `---\ncontent_hash: sha256:${HASH}\ntitle: Test\n---\nBody.\n`,
    );
    this.seeded.add(`ingests/store/${HASH}.md`);
  }
  put(repo: string, path: string, text: string) {
    const key = `${repo}/${path}`;
    this.files.set(key, text);
    this.shas.set(key, FILE_SHA);
  }
  getRef(_repo: string): Promise<string> {
    return Promise.resolve(this.ref);
  }
  listDirectoryAt(
    repo: string,
    path: string,
    _ref: string,
  ): Promise<DirectoryEntry[]> {
    const prefix = `${repo}/${path}/`;
    return Promise.resolve(
      [...this.files.keys()]
        .filter((key) =>
          key.startsWith(prefix) && !key.slice(prefix.length).includes("/")
        )
        .map((key) => ({
          name: key.slice(prefix.length),
          type: "blob" as const,
        })),
    );
  }
  getFile(repo: string, path: string): Promise<FileState | null> {
    return this.getFileAt(repo, path, this.ref);
  }
  readsAt: { repo: string; path: string; ref: string }[] = [];
  getFileAt(
    repo: string,
    path: string,
    ref: string,
  ): Promise<FileState | null> {
    this.readsAt.push({ repo, path, ref });
    const k = `${repo}/${path}`;
    return Promise.resolve(
      this.files.has(k)
        ? { text: this.files.get(k)!, sha: this.shas.get(k) ?? FILE_SHA }
        : null,
    );
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
  atomicCommits: { changes: AtomicFileChange[]; message: string }[] = [];
  commitFiles(
    repo: string,
    changes: AtomicFileChange[],
    message: string,
    _author: Author,
    options?: { expectedRef?: string },
  ): Promise<CommitFilesResult> {
    if (
      options?.expectedRef !== undefined && options.expectedRef !== this.ref
    ) {
      return Promise.reject(new GitHubError(409, "branch changed"));
    }
    for (const change of changes) {
      const key = `${repo}/${change.path}`;
      const current = this.files.has(key)
        ? (this.shas.get(key) ?? FILE_SHA)
        : null;
      if (current !== change.expectedSha) {
        return Promise.reject(new GitHubError(409, "changed"));
      }
    }
    for (const change of changes) {
      const key = `${repo}/${change.path}`;
      this.files.set(key, change.text);
      this.shas.set(key, "d".repeat(40));
    }
    this.atomicCommits.push({ changes, message });
    return Promise.resolve({
      commitSha: "atomicsha",
      fileShas: Object.fromEntries(
        changes.map((change) => [change.path, "d".repeat(40)]),
      ),
    });
  }
  commits = new Map<
    string,
    { by: string; email: string; at: string; message: string }[]
  >();
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
const req = (path: string, init?: RequestInit) =>
  new Request(`https://wb.example.is${path}`, init);

Deno.test("auth/me without a cookie -> null", async () => {
  const res = await handleRequest(
    req("/api/auth/me"),
    ENV,
    deps(new FakeGitHub()),
  );
  assertEquals(await res.json(), { user: null });
});

Deno.test("auth/login redirects to GitHub", async () => {
  const res = await handleRequest(
    req("/api/auth/login"),
    ENV,
    deps(new FakeGitHub()),
  );
  assertEquals(res.status, 302);
  assert(
    res.headers.get("location")!.startsWith(
      "https://github.com/login/oauth/authorize",
    ),
  );
});

Deno.test("gate info reports availability from the private sidecar", async () => {
  const gh = new FakeGitHub();
  gh.put(
    "ingests",
    `store/${HASH}.verification.json`,
    JSON.stringify(sidecar(10)),
  );
  const res = await handleRequest(
    req(`/api/ingests/${PUBLIC_HASH}/verification`),
    ENV,
    deps(gh),
  );
  const body = await res.json();
  assertEquals(body.available, true);
  assertEquals(body.pool_size, 10);
  assertEquals(body.min_correct_to_pass, 8);
});

Deno.test("gate info: no sidecar -> not available (ungated record)", async () => {
  const res = await handleRequest(
    req(`/api/ingests/${PUBLIC_HASH}/verification`),
    ENV,
    deps(new FakeGitHub()),
  );
  assertEquals(await res.json(), { available: false });
});

Deno.test("gate start never leaks answers; submit all-correct -> signed Bunny URL", async () => {
  const gh = new FakeGitHub();
  gh.put(
    "ingests",
    `store/${HASH}.verification.json`,
    JSON.stringify(sidecar(10)),
  );

  const startRes = await handleRequest(
    req(`/api/ingests/${PUBLIC_HASH}/verification/start`, { method: "POST" }),
    ENV,
    deps(gh),
  );
  const started = await startRes.json();
  assertEquals(started.challenges.length, 10);
  assert(!JSON.stringify(started).includes("word0"), "answer leaked");
  const token = await verifyToken<{ h: string }>(
    ENV.sessionSecret,
    started.session_id,
  );
  assertEquals(token?.h, PUBLIC_HASH);
  assert(
    !JSON.stringify(token).includes(HASH),
    "full record hash leaked in session token",
  );

  // Answer them all correctly (challenge.before is `b<i>`, the test answer `word<i>`).
  const responses: Record<string, string> = {};
  for (const c of started.challenges) {
    const i = Number(c.before.slice(1));
    responses[String(c.id)] = `word${i}`;
  }
  const submitRes = await handleRequest(
    req(`/api/ingests/${PUBLIC_HASH}/verification/submit`, {
      method: "POST",
      body: JSON.stringify({
        session_id: started.session_id,
        responses,
        ext: "mp4",
      }),
    }),
    ENV,
    deps(gh),
  );
  const out = await submitRes.json();
  assertEquals(out.passed, true);
  assertEquals(out.score, 10);
  assert(
    out.url.startsWith(
      `https://cdn.example.b-cdn.net/sources/${HASH}.mp4?token=HS256-`,
    ),
  );
  assert(out.url.includes("expires="));
  assertEquals(out.expires_in, 300);
});

Deno.test("public gate rejects full hashes instead of exposing a suffix oracle", async () => {
  const gh = new FakeGitHub();
  gh.put(
    "ingests",
    `store/${HASH}.verification.json`,
    JSON.stringify(sidecar(10)),
  );
  const res = await handleRequest(
    req(`/api/ingests/${HASH}/verification`),
    ENV,
    deps(gh),
  );
  assertEquals(res.status, 404);
});

Deno.test("public gate fails closed on a public-hash collision", async () => {
  const gh = new FakeGitHub();
  const collision = PUBLIC_HASH + "b".repeat(8);
  gh.put("ingests", `store/${collision}.md`, "---\ntitle: Collision\n---\n");
  const res = await handleRequest(
    req(`/api/ingests/${PUBLIC_HASH}/verification`),
    ENV,
    deps(gh),
  );
  assertEquals(res.status, 404);
});

Deno.test("gate submit: SHA fastpath passes without a session", async () => {
  const gh = new FakeGitHub();
  gh.put(
    "ingests",
    `store/${HASH}.verification.json`,
    JSON.stringify(sidecar(10, { sha256: "DEADBEEF" })),
  );
  const res = await handleRequest(
    req(`/api/ingests/${PUBLIC_HASH}/verification/submit`, {
      method: "POST",
      body: JSON.stringify({ sha256: "deadbeef" }),
    }),
    ENV,
    deps(gh),
  );
  const out = await res.json();
  assertEquals(out.passed, true);
  assertEquals(out.method, "sha256");
  assertEquals(Object.keys(out.housekeeping).sort(), [
    "access",
    "deep_link",
    "due_reason",
    "outstanding_count",
    "previews",
    "schema",
    "scopes",
    "sidecar",
    "state",
    "viewed_algorithm_version",
    "viewed_content_hash",
    "viewed_input_sha256",
    "viewed_ref",
    "viewed_sidecar_sha",
  ]);
  assertEquals(out.housekeeping.access, "full");
  assertEquals(out.housekeeping.sidecar, null);
});

Deno.test("gate success fails closed when the algorithm manifest is non-canonical", async () => {
  const gh = new FakeGitHub();
  gh.put(
    "ingests",
    `store/${HASH}.verification.json`,
    JSON.stringify(sidecar(5, { sha256: "x" })),
  );
  gh.put("ingests", "housekeeping-algorithm.json", ALGORITHM_MANIFEST + "\n");
  const res = await handleRequest(
    req(`/api/ingests/${PUBLIC_HASH}/verification/submit`, {
      method: "POST",
      body: JSON.stringify({ sha256: "x" }),
    }),
    ENV,
    deps(gh),
  );
  assertEquals(res.status, 503);
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
    req(`/api/ingests/${PUBLIC_HASH}/verification/submit`, {
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
    req(`/api/ingests/${PUBLIC_HASH}/verification/submit`, {
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
  gh.put(
    "ingests",
    `store/${HASH}.verification.json`,
    JSON.stringify(sidecar(10)),
  );
  gh.put(
    "ingests",
    `store/${HASH}.v2.md`,
    "---\ntitle: secret\n---\nSECRET BODY\n",
  );
  const startRes = await handleRequest(
    req(`/api/ingests/${PUBLIC_HASH}/verification/start`, { method: "POST" }),
    ENV,
    deps(gh),
  );
  const started = await startRes.json();
  const responses: Record<string, string> = {};
  for (const c of started.challenges) responses[String(c.id)] = "WRONG";
  const res = await handleRequest(
    req(`/api/ingests/${PUBLIC_HASH}/verification/submit`, {
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
  assertEquals(gh.wrote, []);
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
  assertEquals(out.directives, [
    "Use the full name Luis Elizondo",
    "Prefer active voice",
  ]);
  // Written to the cross-language per-article sidecar in the CONTENT repo...
  const written = gh.files.get(
    "content/pages/people/luis-elizondo.directives.yaml",
  )!;
  assert(written, "sidecar not written");
  // ...as valid YAML the assembler can safe_load back to the same list.
  assertEquals(parse(written), [
    "Use the full name Luis Elizondo",
    "Prefer active voice",
  ]);
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
  assertEquals(
    parse(gh.files.get("content/pages/people/luis-elizondo.directives.yaml")!),
    [],
  );
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
  assertEquals(gh.wrote, []);
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
  assertEquals(gh.wrote, []);
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
  const [entry] = parseAll(gh.files.get("curation/merges.yaml")!) as Record<
    string,
    unknown
  >[];
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
  const [entry] = parseAll(gh.files.get("curation/rejections.yaml")!) as Record<
    string,
    unknown
  >[];
  assertEquals(entry.op, "reject");
  assertEquals((entry.audit as { node_ids: string[] }).node_ids, ["n1", "n2"]);
});

Deno.test("review PUT needs auth, then commits the corrected record", async () => {
  const gh = new FakeGitHub();
  gh.put(
    "ingests",
    `store/${HASH}.md`,
    `---\ncontent_hash: sha256:${HASH}\n---\noriginal body\n`,
  );
  const payload = JSON.stringify({
    content: `---\ncontent_hash: sha256:${HASH}\n---\ncorrected body\n`,
    notes: "fixed speaker",
    base_record_sha: FILE_SHA,
    base_ref: REF,
  });

  const unauth = await handleRequest(
    req(`/api/ingests/${HASH}`, { method: "PUT", body: payload }),
    ENV,
    deps(gh),
  );
  assertEquals(unauth.status, 401);

  const ok = await handleRequest(
    req(`/api/ingests/${PUBLIC_HASH}`, {
      method: "PUT",
      headers: { cookie: await cookie() },
      body: payload,
    }),
    ENV,
    deps(gh),
  );
  assertEquals(await ok.json(), {
    submitted: true,
    base_ref: "atomicsha",
    base_record_sha: "d".repeat(40),
  });
  assertEquals(
    gh.files.get(`ingests/store/${HASH}.md`),
    `---\ncontent_hash: sha256:${HASH}\n---\ncorrected body\n`,
  );
});

Deno.test("review of a V2 record writes the canonical .v2.md, not a stray .md", async () => {
  const gh = new FakeGitHub();
  gh.files.delete(`ingests/store/${HASH}.md`);
  gh.shas.delete(`ingests/store/${HASH}.md`);
  gh.put(
    "ingests",
    `store/${HASH}.v2.md`,
    `---\ncontent_hash: sha256:${HASH}\n---\nold v2 body\n`,
  ); // canonical exists
  const ok = await handleRequest(
    req(`/api/ingests/${HASH}`, {
      method: "PUT",
      headers: { cookie: await cookie() },
      body: JSON.stringify({
        content: `---\ncontent_hash: sha256:${HASH}\n---\ncorrected v2 body\n`,
        notes: "fix speakers",
        base_record_sha: FILE_SHA,
        base_ref: REF,
      }),
    }),
    ENV,
    deps(gh),
  );
  assertEquals((await ok.json()).submitted, true);
  // landed on the canonical .v2.md; did NOT create a stray .md
  assertEquals(
    gh.files.get(`ingests/store/${HASH}.v2.md`),
    `---\ncontent_hash: sha256:${HASH}\n---\ncorrected v2 body\n`,
  );
  assertEquals(gh.files.has(`ingests/store/${HASH}.md`), false);
});

Deno.test("review PUT uses the viewed record and ref as a CAS base", async () => {
  const gh = new FakeGitHub();
  const viewed = "---\ntitle: T\n---\nSpeaker_1 spoke.\n";
  const housekept = "---\ntitle: T\n---\nAlice spoke.\n";
  gh.put("ingests", `store/${HASH}.v2.md`, housekept);
  gh.ref = "e".repeat(40);
  const res = await handleRequest(
    req(`/api/ingests/${HASH}`, {
      method: "PUT",
      headers: { cookie: await cookie() },
      body: JSON.stringify({
        content: viewed.replace("spoke", "talked"),
        notes: "stale editor",
        base_record_sha: FILE_SHA,
        base_ref: REF,
      }),
    }),
    ENV,
    deps(gh),
  );
  assertEquals(res.status, 409);
  assertEquals(gh.files.get(`ingests/store/${HASH}.v2.md`), housekept);
  assertEquals(gh.atomicCommits.length, 0);
});

Deno.test("review PUT accepts only top-level base_record_sha and base_ref", async () => {
  const gh = new FakeGitHub();
  gh.put("ingests", `store/${HASH}.md`, "old\n");
  const res = await handleRequest(
    req(`/api/ingests/${HASH}`, {
      method: "PUT",
      headers: { cookie: await cookie() },
      body: JSON.stringify({
        content: "new\n",
        base: { record_sha: FILE_SHA, ref: REF },
      }),
    }),
    ENV,
    deps(gh),
  );
  assertEquals(res.status, 400);
  assertEquals(gh.files.get(`ingests/store/${HASH}.md`), "old\n");
  assertEquals(gh.atomicCommits.length, 0);
});

Deno.test("review PUT validates route identity and reserves copyright changes for admins", async () => {
  const current =
    `---\ncontent_hash: sha256:${HASH}\ncopyright:\n  status: restricted\n---\nold\n`;
  const changedCopyright = current.replace("restricted", "licensed");

  const mismatch = new FakeGitHub();
  mismatch.put("ingests", `store/${HASH}.md`, current);
  const mismatchResponse = await handleRequest(
    req(`/api/ingests/${HASH}`, {
      method: "PUT",
      headers: { cookie: await cookie() },
      body: JSON.stringify({
        content: changedCopyright.replace(HASH, "f".repeat(64)),
        base_record_sha: FILE_SHA,
        base_ref: REF,
      }),
    }),
    ENV,
    deps(mismatch),
  );
  assertEquals(mismatchResponse.status, 409);
  assertEquals(mismatch.atomicCommits.length, 0);

  const editor = new FakeGitHub();
  editor.put("ingests", `store/${HASH}.md`, current);
  const editorResponse = await handleRequest(
    req(`/api/ingests/${HASH}`, {
      method: "PUT",
      headers: { cookie: await cookie() },
      body: JSON.stringify({
        content: changedCopyright,
        base_record_sha: FILE_SHA,
        base_ref: REF,
      }),
    }),
    ENV,
    deps(editor),
  );
  assertEquals(editorResponse.status, 403);
  assertEquals(editor.atomicCommits.length, 0);

  const admin = new FakeGitHub();
  admin.put("ingests", "roles.yaml", "rev: admin\n");
  admin.put("ingests", `store/${HASH}.md`, current);
  const adminResponse = await handleRequest(
    req(`/api/ingests/${HASH}`, {
      method: "PUT",
      headers: { cookie: await cookie() },
      body: JSON.stringify({
        content: changedCopyright,
        base_record_sha: FILE_SHA,
        base_ref: REF,
      }),
    }),
    ENV,
    deps(admin),
  );
  assertEquals(adminResponse.status, 200);
  assertEquals(admin.atomicCommits.length, 1);
});

Deno.test("review PUT commits record and coverage sidecar atomically", async () => {
  const gh = new FakeGitHub();
  gh.put(
    "ingests",
    `store/${HASH}.md`,
    `---\ncontent_hash: sha256:${HASH}\ntitle: T\n---\nold\n`,
  );
  const res = await handleRequest(
    req(`/api/ingests/${HASH}`, {
      method: "PUT",
      headers: { cookie: await cookie() },
      body: JSON.stringify({
        content: `---\ncontent_hash: sha256:${HASH}\ntitle: T\n---\nnew\n`,
        notes: "read all",
        spans: [{ from: 0, to: 1 }],
        verdict: { observed_coverage: 1, digestible: true, total_units: 1 },
        base_record_sha: FILE_SHA,
        base_ref: REF,
      }),
    }),
    ENV,
    deps(gh),
  );
  assertEquals(res.status, 200);
  assertEquals(gh.atomicCommits.length, 1);
  assertEquals(
    gh.atomicCommits[0].changes.map((change) => change.path),
    [`store/${HASH}.md`, `store/${HASH}.review.json`],
  );
});

Deno.test("review history: public read, maps git commits, drops reviewer email", async () => {
  const gh = new FakeGitHub();
  gh.put("ingests", `store/${HASH}.v2.md`, "body\n"); // v2 record -> history reads .v2.md
  gh.commits.set(`ingests/store/${HASH}.v2.md`, [
    {
      by: "Mark",
      email: "mark@x.com",
      at: "2026-06-22T02:35:31Z",
      message: "review: fix names",
    },
    {
      by: "Sam",
      email: "sam@x.com",
      at: "2026-06-21T09:00:00Z",
      message: "review: first pass",
    },
  ]);
  const res = await handleRequest(
    req(`/api/ingests/${PUBLIC_HASH}/history`),
    ENV,
    deps(gh),
  ); // no cookie
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.history, [
    { by: "Mark", at: "2026-06-22T02:35:31Z", summary: "review: fix names" },
    { by: "Sam", at: "2026-06-21T09:00:00Z", summary: "review: first pass" },
  ]);
  assert(
    !JSON.stringify(body).includes("@x.com"),
    "reviewer email must not leak",
  );
});

Deno.test("review history: surfaces reviewer notes, strips identity trailers", async () => {
  const gh = new FakeGitHub();
  gh.put("ingests", `store/${HASH}.v2.md`, "body\n");
  gh.commits.set(`ingests/store/${HASH}.v2.md`, [
    {
      by: "Mark",
      email: "mark@x.com",
      at: "2026-06-30T02:04:45Z",
      message:
        "review: The DANGEROUS Truth About UFOs\n\nReviewed up to 20%\n\n" +
        "Reviewed-Record: url:https://www.youtube.com/watch?v=idBryc0eWww\n" +
        "Reviewed-Record: content:73be106d406f6d35a063a894e8384e7da0918eb8597d2107a9e3653becca2bdc",
    },
    {
      by: "Sam",
      email: "sam@x.com",
      at: "2026-06-21T09:00:00Z",
      message: "feat: add 1 record(s) from audio ingestion",
    },
  ]);
  const res = await handleRequest(
    req(`/api/ingests/${PUBLIC_HASH}/history`),
    ENV,
    deps(gh),
  );
  const body = await res.json();
  assertEquals(body.history, [
    {
      by: "Mark",
      at: "2026-06-30T02:04:45Z",
      summary: "review: The DANGEROUS Truth About UFOs - Reviewed up to 20%",
    },
    {
      by: "Sam",
      at: "2026-06-21T09:00:00Z",
      summary: "feat: add 1 record(s) from audio ingestion",
    },
  ]);
});

Deno.test("unknown route -> 404", async () => {
  const res = await handleRequest(
    req("/api/nope"),
    ENV,
    deps(new FakeGitHub()),
  );
  assertEquals(res.status, 404);
});

Deno.test("a GitHub write failure surfaces a 502, not a bare 500", async () => {
  const gh = {
    // roles.yaml must resolve or the role gate 403s before the write is reached.
    getFile: (_repo: string, path: string) =>
      Promise.resolve(
        path === "roles.yaml"
          ? ({ text: "rev: editor\n", sha: "s" } as FileState)
          : null,
      ),
    getFileAt: (_repo: string, _path: string, _ref: string) =>
      Promise.resolve(null),
    getRef: () => Promise.resolve(REF),
    listDirectoryAt: () => Promise.resolve([]),
    editFile: () => Promise.reject(new GitHubError(401, "Bad credentials")),
    commitFiles: () => Promise.reject(new GitHubError(401, "Bad credentials")),
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

async function v2Sidecar(record: string) {
  const oldToken = "Speaker_1";
  const encoded = new TextEncoder().encode(record);
  const start = encoded.findIndex((_, i) =>
    i >= encoded.length - new TextEncoder().encode(oldToken).length
      ? false
      : record.slice(0, i).includes("---\n") &&
        new TextDecoder().decode(encoded.slice(i, i + oldToken.length)) ===
          oldToken
  );
  return {
    schema: "anomalica/housekeeping/2",
    content_hash: `sha256:${HASH}`,
    input_sha256: `sha256:${await sha256Hex(record)}`,
    checked_at: "2026-09-11T00:00:00Z",
    algorithm_version: "1",
    outcome: "completed",
    items: [
      {
        id: "speaker-1",
        check: "speaker-name",
        operation: "replace-token",
        scope: "body",
        old_token: oldToken,
        new_token: "Alice",
        case_sensitive: true,
        token_boundary: "ascii-word",
        occurrences: [{ start_byte: start, end_byte: start + oldToken.length }],
        expected_count: 1,
        confidence: "high",
        evidence: {
          reasoning: "Named in transcript",
          sources: [],
          record_spans: [],
        },
        status: "proposed",
      },
    ],
  };
}

function housekeepingPayload(
  proposal: Awaited<ReturnType<typeof v2Sidecar>>,
  status: "approved" | "rejected",
) {
  return {
    schema: "anomalica/housekeeping-decision/1",
    decisions: [{ item_id: proposal.items[0].id, status }],
    viewed_sidecar_sha: FILE_SHA,
    viewed_ref: REF,
    viewed_content_hash: proposal.content_hash,
    viewed_input_sha256: proposal.input_sha256,
    viewed_algorithm_version: proposal.algorithm_version,
  };
}

Deno.test("housekeeping v2 approval atomically commits record and approved sidecar", async () => {
  const gh = new FakeGitHub();
  const record = "---\ntitle: T\n---\nSpeaker_1 spoke.\n";
  const proposal = await v2Sidecar(record);
  gh.put("ingests", `store/${HASH}.v2.md`, record);
  gh.put(
    "ingests",
    `store/${HASH}.housekeeping.json`,
    JSON.stringify(proposal),
  );
  const res = await handleRequest(
    req(`/api/ingests/${HASH}/housekeeping/decide`, {
      method: "POST",
      headers: { cookie: await cookie() },
      body: JSON.stringify(housekeepingPayload(proposal, "approved")),
    }),
    ENV,
    deps(gh),
  );
  assertEquals(res.status, 200);
  assertEquals(gh.atomicCommits.length, 1);
  assertEquals(gh.atomicCommits[0].changes.length, 2);
  assertEquals(
    gh.readsAt
      .filter(
        ({ path }) =>
          path === "housekeeping-algorithm.json" ||
          path.endsWith(".housekeeping.json") ||
          path.endsWith(".v2.md"),
      )
      .map(({ ref }) => ref),
    [REF, REF, REF, REF],
  );
  assertEquals(
    gh.files.get(`ingests/store/${HASH}.v2.md`),
    "---\ntitle: T\n---\nAlice spoke.\n",
  );
  const saved = JSON.parse(
    gh.files.get(`ingests/store/${HASH}.housekeeping.json`)!,
  );
  assertEquals(saved.items[0].status, "approved");
});

Deno.test("housekeeping stale v2 approval writes neither file and stays proposed", async () => {
  const gh = new FakeGitHub();
  const original = "---\ntitle: T\n---\nSpeaker_1 spoke.\n";
  const proposal = await v2Sidecar(original);
  const changed = original + "later edit\n";
  gh.put("ingests", `store/${HASH}.v2.md`, changed);
  gh.put(
    "ingests",
    `store/${HASH}.housekeeping.json`,
    JSON.stringify(proposal),
  );
  const res = await handleRequest(
    req(`/api/ingests/${HASH}/housekeeping/decide`, {
      method: "POST",
      headers: { cookie: await cookie() },
      body: JSON.stringify(housekeepingPayload(proposal, "approved")),
    }),
    ENV,
    deps(gh),
  );
  assertEquals(res.status, 409);
  assertEquals(gh.atomicCommits.length, 0);
  assertEquals(gh.files.get(`ingests/store/${HASH}.v2.md`), changed);
  const saved = JSON.parse(
    gh.files.get(`ingests/store/${HASH}.housekeeping.json`)!,
  );
  assertEquals(saved.items[0].status, "proposed");
});

Deno.test("housekeeping stale v2 rejection also writes neither file", async () => {
  const gh = new FakeGitHub();
  const original = "---\ntitle: T\n---\nSpeaker_1 spoke.\n";
  const proposal = await v2Sidecar(original);
  const changed = original + "later edit\n";
  gh.put("ingests", `store/${HASH}.v2.md`, changed);
  gh.put(
    "ingests",
    `store/${HASH}.housekeeping.json`,
    JSON.stringify(proposal),
  );
  const res = await handleRequest(
    req(`/api/ingests/${HASH}/housekeeping/decide`, {
      method: "POST",
      headers: { cookie: await cookie() },
      body: JSON.stringify(housekeepingPayload(proposal, "rejected")),
    }),
    ENV,
    deps(gh),
  );
  assertEquals(res.status, 409);
  assertEquals(gh.atomicCommits.length, 0);
  assertEquals(
    JSON.parse(gh.files.get(`ingests/store/${HASH}.housekeeping.json`)!)
      .items[0].status,
    "proposed",
  );
});

Deno.test("housekeeping decisions bind every viewed identity", async () => {
  const record = "---\ntitle: T\n---\nSpeaker_1 spoke.\n";
  for (
    const changed of ["content", "input", "version", "sidecar", "ref"] as const
  ) {
    const gh = new FakeGitHub();
    const proposal = await v2Sidecar(record);
    gh.put("ingests", `store/${HASH}.v2.md`, record);
    gh.put(
      "ingests",
      `store/${HASH}.housekeeping.json`,
      JSON.stringify(proposal),
    );
    const payload = housekeepingPayload(proposal, "rejected");
    if (changed === "content") {
      payload.viewed_content_hash = `sha256:${"f".repeat(64)}`;
    }
    if (changed === "input") {
      payload.viewed_input_sha256 = `sha256:${"f".repeat(64)}`;
    }
    if (changed === "version") payload.viewed_algorithm_version = "0";
    if (changed === "sidecar") {
      gh.shas.set(`ingests/store/${HASH}.housekeeping.json`, "f".repeat(40));
    }
    if (changed === "ref") gh.ref = "f".repeat(40);
    const res = await handleRequest(
      req(`/api/ingests/${HASH}/housekeeping/decide`, {
        method: "POST",
        headers: { cookie: await cookie() },
        body: JSON.stringify(payload),
      }),
      ENV,
      deps(gh),
    );
    assertEquals(res.status, 409, changed);
    assertEquals(gh.atomicCommits.length, 0, changed);
  }
});

Deno.test("housekeeping rejects client-supplied operations as an extra field", async () => {
  const gh = new FakeGitHub();
  const record = "---\ntitle: T\n---\nSpeaker_1 spoke.\n";
  const proposal = await v2Sidecar(record);
  gh.put("ingests", `store/${HASH}.v2.md`, record);
  gh.put(
    "ingests",
    `store/${HASH}.housekeeping.json`,
    JSON.stringify(proposal),
  );
  const payload = {
    ...housekeepingPayload(proposal, "approved"),
    items: [{ ...proposal.items[0], new_token: "Mallory" }],
  };
  const res = await handleRequest(
    req(`/api/ingests/${HASH}/housekeeping/decide`, {
      method: "POST",
      headers: { cookie: await cookie() },
      body: JSON.stringify(payload),
    }),
    ENV,
    deps(gh),
  );
  assertEquals(res.status, 400);
  assertEquals(gh.files.get(`ingests/store/${HASH}.v2.md`), record);
  assertEquals(gh.atomicCommits.length, 0);
});

Deno.test("housekeeping requires the canonical decision schema", async () => {
  const record = "---\ntitle: T\n---\nSpeaker_1 spoke.\n";
  for (const schema of [undefined, "anomalica/housekeeping-decision/0"]) {
    const gh = new FakeGitHub();
    const proposal = await v2Sidecar(record);
    gh.put("ingests", `store/${HASH}.v2.md`, record);
    gh.put(
      "ingests",
      `store/${HASH}.housekeeping.json`,
      JSON.stringify(proposal),
    );
    const payload: Record<string, unknown> = housekeepingPayload(
      proposal,
      "rejected",
    );
    if (schema === undefined) delete payload.schema;
    else payload.schema = schema;
    const res = await handleRequest(
      req(`/api/ingests/${HASH}/housekeeping/decide`, {
        method: "POST",
        headers: { cookie: await cookie() },
        body: JSON.stringify(payload),
      }),
      ENV,
      deps(gh),
    );
    assertEquals(res.status, 400, String(schema));
    assertEquals(gh.atomicCommits.length, 0);
  }
});

Deno.test("housekeeping decision schema rejects duplicate ids and nested extra fields", async () => {
  const record = "---\ntitle: T\n---\nSpeaker_1 spoke.\n";
  for (const variant of ["duplicate", "extra"] as const) {
    const gh = new FakeGitHub();
    const proposal = await v2Sidecar(record);
    gh.put("ingests", `store/${HASH}.v2.md`, record);
    gh.put(
      "ingests",
      `store/${HASH}.housekeeping.json`,
      JSON.stringify(proposal),
    );
    const payload = housekeepingPayload(proposal, "rejected");
    if (variant === "duplicate") {
      payload.decisions.push({ ...payload.decisions[0] });
    }
    const submitted = variant === "extra"
      ? {
        ...payload,
        decisions: [{ ...payload.decisions[0], operation: "replace-token" }],
      }
      : payload;
    const res = await handleRequest(
      req(`/api/ingests/${HASH}/housekeeping/decide`, {
        method: "POST",
        headers: { cookie: await cookie() },
        body: JSON.stringify(submitted),
      }),
      ENV,
      deps(gh),
    );
    assertEquals(res.status, 400, variant);
    assertEquals(gh.atomicCommits.length, 0, variant);
  }
});

Deno.test("housekeeping decisions fail closed on a missing or non-canonical manifest", async () => {
  const record = "---\ntitle: T\n---\nSpeaker_1 spoke.\n";
  for (
    const manifest of [
      null,
      '{"algorithm_version":"1","schema":"anomalica/housekeeping-algorithm/1"}\n',
      ALGORITHM_MANIFEST + "\n",
      ALGORITHM_MANIFEST.replace('"1"', '"2"'),
    ]
  ) {
    const gh = new FakeGitHub();
    const proposal = await v2Sidecar(record);
    gh.put("ingests", `store/${HASH}.v2.md`, record);
    gh.put(
      "ingests",
      `store/${HASH}.housekeeping.json`,
      JSON.stringify(proposal),
    );
    if (manifest == null) {
      gh.files.delete("ingests/housekeeping-algorithm.json");
      gh.shas.delete("ingests/housekeeping-algorithm.json");
    } else {
      gh.put("ingests", "housekeeping-algorithm.json", manifest);
    }
    const res = await handleRequest(
      req(`/api/ingests/${HASH}/housekeeping/decide`, {
        method: "POST",
        headers: { cookie: await cookie() },
        body: JSON.stringify(housekeepingPayload(proposal, "rejected")),
      }),
      ENV,
      deps(gh),
    );
    assertEquals(res.status, 503, String(manifest));
    assertEquals(gh.atomicCommits.length, 0);
  }
});

Deno.test("housekeeping invalid v2 approval writes neither file and stays proposed", async () => {
  const gh = new FakeGitHub();
  const record = "---\ntitle: T\n---\nSpeaker_1 spoke.\n";
  const proposal = await v2Sidecar(record);
  proposal.items[0].expected_count = 2;
  gh.put("ingests", `store/${HASH}.v2.md`, record);
  gh.put(
    "ingests",
    `store/${HASH}.housekeeping.json`,
    JSON.stringify(proposal),
  );
  const res = await handleRequest(
    req(`/api/ingests/${HASH}/housekeeping/decide`, {
      method: "POST",
      headers: { cookie: await cookie() },
      body: JSON.stringify(housekeepingPayload(proposal, "approved")),
    }),
    ENV,
    deps(gh),
  );
  assertEquals(res.status, 422);
  assertEquals(gh.atomicCommits.length, 0);
  assertEquals(gh.files.get(`ingests/store/${HASH}.v2.md`), record);
  const saved = JSON.parse(
    gh.files.get(`ingests/store/${HASH}.housekeeping.json`)!,
  );
  assertEquals(saved.items[0].status, "proposed");
});

Deno.test("housekeeping rejection commits only the sidecar", async () => {
  const gh = new FakeGitHub();
  const record = "---\ntitle: T\n---\nSpeaker_1 spoke.\n";
  gh.put("ingests", `store/${HASH}.v2.md`, record);
  const proposal = await v2Sidecar(record);
  gh.put(
    "ingests",
    `store/${HASH}.housekeeping.json`,
    JSON.stringify(proposal),
  );
  const res = await handleRequest(
    req(`/api/ingests/${HASH}/housekeeping/decide`, {
      method: "POST",
      headers: { cookie: await cookie() },
      body: JSON.stringify(housekeepingPayload(proposal, "rejected")),
    }),
    ENV,
    deps(gh),
  );
  assertEquals(res.status, 200);
  assertEquals(gh.atomicCommits.length, 1);
  assertEquals(
    gh.atomicCommits[0].changes.map((change) => change.path),
    [`store/${HASH}.housekeeping.json`],
  );
  assertEquals(gh.files.get(`ingests/store/${HASH}.v2.md`), record);
  const saved = JSON.parse(
    gh.files.get(`ingests/store/${HASH}.housekeeping.json`)!,
  );
  assertEquals(saved.items[0].status, "rejected");
});

Deno.test("housekeeping v1 approval is due and never applies without an input hash", async () => {
  const gh = new FakeGitHub();
  const record = "---\npublisher: 'Old'\n---\nBody unchanged.\n";
  const proposal = {
    schema: "anomalica/housekeeping/1",
    content_hash: `sha256:${HASH}`,
    checked_at: "2026-09-11T00:00:00Z",
    checker_version: 1,
    items: [
      {
        id: "publisher",
        check: "publisher",
        field: "publisher",
        operation: "set",
        current: "Old",
        proposed: "New",
        confidence: "high",
        evidence: {
          reasoning: "Source identifies it",
          sources: [],
          record_spans: [],
        },
        status: "proposed",
      },
    ],
  };
  gh.put("ingests", `store/${HASH}.md`, record);
  gh.put(
    "ingests",
    `store/${HASH}.housekeeping.json`,
    JSON.stringify(proposal),
  );
  const res = await handleRequest(
    req(`/api/ingests/${HASH}/housekeeping/decide`, {
      method: "POST",
      headers: { cookie: await cookie() },
      body: JSON.stringify({
        schema: "anomalica/housekeeping-decision/1",
        decisions: [{ item_id: "publisher", status: "approved" }],
        viewed_sidecar_sha: FILE_SHA,
        viewed_ref: REF,
        viewed_content_hash: proposal.content_hash,
        viewed_input_sha256: "sha256:" + "0".repeat(64),
        viewed_algorithm_version: "1",
      }),
    }),
    ENV,
    deps(gh),
  );
  assertEquals(res.status, 409);
  assertEquals(gh.atomicCommits.length, 0);
  assertEquals(gh.files.get(`ingests/store/${HASH}.md`), record);
  const saved = JSON.parse(
    gh.files.get(`ingests/store/${HASH}.housekeeping.json`)!,
  );
  assertEquals(saved.items[0].status, "proposed");
});

Deno.test("housekeeping v1 rejection is also refused", async () => {
  const gh = new FakeGitHub();
  const record = "---\ntitle: T\n---\nBody.\n";
  const proposal = {
    schema: "anomalica/housekeeping/1",
    content_hash: `sha256:${HASH}`,
    checked_at: "2026-09-11T00:00:00Z",
    checker_version: 1,
    items: [
      {
        id: "title",
        check: "title",
        field: "title",
        operation: "set",
        current: "T",
        proposed: "New",
        confidence: "high",
        evidence: { reasoning: "Source title", sources: [], record_spans: [] },
        status: "proposed",
      },
    ],
  };
  gh.put("ingests", `store/${HASH}.md`, record);
  gh.put(
    "ingests",
    `store/${HASH}.housekeeping.json`,
    JSON.stringify(proposal),
  );
  const res = await handleRequest(
    req(`/api/ingests/${HASH}/housekeeping/decide`, {
      method: "POST",
      headers: { cookie: await cookie() },
      body: JSON.stringify({
        schema: "anomalica/housekeeping-decision/1",
        decisions: [{ item_id: "title", status: "rejected" }],
        viewed_sidecar_sha: FILE_SHA,
        viewed_ref: REF,
        viewed_content_hash: proposal.content_hash,
        viewed_input_sha256: `sha256:${await sha256Hex(record)}`,
        viewed_algorithm_version: "1",
      }),
    }),
    ENV,
    deps(gh),
  );
  assertEquals(res.status, 409);
  assertEquals(gh.atomicCommits.length, 0);
});

Deno.test("housekeeping v2 retains hash-bound frontmatter operations", async () => {
  const gh = new FakeGitHub();
  const record = "---\npublisher: 'Old'\n---\nBody unchanged.\n";
  const proposal = {
    schema: "anomalica/housekeeping/2",
    content_hash: `sha256:${HASH}`,
    input_sha256: `sha256:${await sha256Hex(record)}`,
    checked_at: "2026-09-11T00:00:00Z",
    algorithm_version: "1",
    outcome: "completed",
    items: [
      {
        id: "publisher",
        check: "publisher",
        field: "publisher",
        operation: "set",
        current: "Old",
        proposed: "New",
        confidence: "high",
        evidence: {
          reasoning: "Source identifies it",
          sources: [],
          record_spans: [],
        },
        status: "proposed",
      },
    ],
  };
  gh.put("ingests", `store/${HASH}.md`, record);
  gh.put(
    "ingests",
    `store/${HASH}.housekeeping.json`,
    JSON.stringify(proposal),
  );
  const res = await handleRequest(
    req(`/api/ingests/${HASH}/housekeeping/decide`, {
      method: "POST",
      headers: { cookie: await cookie() },
      body: JSON.stringify({
        schema: "anomalica/housekeeping-decision/1",
        decisions: [{ item_id: "publisher", status: "approved" }],
        viewed_sidecar_sha: FILE_SHA,
        viewed_ref: REF,
        viewed_content_hash: proposal.content_hash,
        viewed_input_sha256: proposal.input_sha256,
        viewed_algorithm_version: proposal.algorithm_version,
      }),
    }),
    ENV,
    deps(gh),
  );
  assertEquals(res.status, 200);
  assertEquals(gh.atomicCommits.length, 1);
  assertEquals(
    gh.files.get(`ingests/store/${HASH}.md`),
    '---\npublisher: "New"\n---\nBody unchanged.\n',
  );
});

// --- role gate (the production write gate) ---------------------------------
// Until this existed the edge gated writes on "is there a session" alone, so any
// GitHub login could commit to the live ingests repo. These pin that shut.

const asUser = async (login: string) =>
  (await makeSessionCookie(ENV, { ...USER, login }, NOW)).split(";")[0];

const putReview = (gh: FakeGitHub, ck: string) => {
  gh.put(
    "ingests",
    `store/${HASH}.md`,
    `---\ncontent_hash: sha256:${HASH}\ntitle: T\n---\nold body\n`,
  );
  gh.seeded.add(`ingests/store/${HASH}.md`);
  return handleRequest(
    req(`/api/ingests/${HASH}`, {
      method: "PUT",
      headers: { cookie: ck },
      body: JSON.stringify({
        content: `---\ncontent_hash: sha256:${HASH}\ntitle: T\n---\nbody\n`,
        notes: "",
        base_record_sha: FILE_SHA,
        base_ref: REF,
      }),
    }),
    ENV,
    deps(gh),
  );
};

Deno.test("role gate: an UNLISTED login cannot write a record (the hole)", async () => {
  const gh = new FakeGitHub(); // roles.yaml lists `rev` only
  const res = await putReview(gh, await asUser("randomer"));
  assertEquals(res.status, 403);
  assertEquals(gh.wrote, []);
});

Deno.test("role gate: an explicit contributor cannot write a record", async () => {
  const gh = new FakeGitHub();
  gh.put("ingests", "roles.yaml", "rev: editor\nnewbie: contributor\n");
  gh.seeded.add("ingests/roles.yaml");
  const res = await putReview(gh, await asUser("newbie"));
  assertEquals(res.status, 403);
  assertEquals(gh.wrote, []);
});

Deno.test("role gate: fails CLOSED when roles.yaml is missing", async () => {
  const gh = new FakeGitHub();
  gh.files.delete("ingests/roles.yaml"); // no role file at all
  const res = await putReview(gh, await asUser("rev"));
  assertEquals(res.status, 403);
  assertEquals(gh.wrote, []);
});

Deno.test("role gate: a reviewer CAN write a record", async () => {
  const gh = new FakeGitHub();
  gh.put("ingests", "roles.yaml", "rev: reviewer\n");
  gh.seeded.add("ingests/roles.yaml");
  const res = await putReview(gh, await asUser("rev"));
  assertEquals(res.status, 200);
});

Deno.test("role gate: article directives need editor - a reviewer is refused", async () => {
  const gh = new FakeGitHub();
  gh.put("ingests", "roles.yaml", "rev: reviewer\n");
  gh.seeded.add("ingests/roles.yaml");
  const res = await handleRequest(
    req(`/api/articles/people/luis-elizondo/directives`, {
      method: "PUT",
      headers: { cookie: await asUser("rev") },
      body: JSON.stringify({ directives: ["x"] }),
    }),
    ENV,
    deps(gh),
  );
  assertEquals(res.status, 403);
  assertEquals(gh.wrote, []);
});

Deno.test("role gate: curation needs reviewer - an unlisted login is refused", async () => {
  const gh = new FakeGitHub();
  const res = await handleRequest(
    req("/api/curation/reject", {
      method: "POST",
      headers: { cookie: await asUser("randomer") },
      body: JSON.stringify({
        nodes: [
          { id: "n1", name: "A", node_type: "matter" },
          { id: "n2", name: "B", node_type: "matter" },
        ],
      }),
    }),
    ENV,
    deps(gh),
  );
  assertEquals(res.status, 403);
  assertEquals(gh.wrote, []);
});

Deno.test("me/role: reports the caller's role; unlisted -> contributor", async () => {
  const gh = new FakeGitHub();
  const mine = await handleRequest(
    req("/api/me/role", { headers: { cookie: await asUser("rev") } }),
    ENV,
    deps(gh),
  );
  assertEquals(await mine.json(), { role: "editor" });
  const theirs = await handleRequest(
    req("/api/me/role", { headers: { cookie: await asUser("randomer") } }),
    ENV,
    deps(gh),
  );
  assertEquals(await theirs.json(), { role: "contributor" });
});
