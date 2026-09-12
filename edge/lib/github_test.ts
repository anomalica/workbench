import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  type FetchLike,
  fromBase64,
  GitHubClient,
  GitHubError,
  toBase64,
} from "./github.ts";

Deno.test("base64 round-trips UTF-8 (unicode-safe)", () => {
  for (const s of ["", "hello", "Tic Tac", "敦賀 (げんぱつ)", "a\nb\tc"]) {
    assertEquals(fromBase64(toBase64(s)), s);
  }
});

Deno.test("fromBase64 tolerates the API's line-wrapped content", () => {
  const wrapped = toBase64("x".repeat(100)).replace(/(.{20})/g, "$1\n");
  assertEquals(fromBase64(wrapped), "x".repeat(100));
});

Deno.test("fromBase64 refuses invalid UTF-8", () => {
  assertRejects(
    () => Promise.resolve().then(() => fromBase64("/w==")),
    TypeError,
  );
});

Deno.test("getFile returns null on 404, decodes content otherwise", async () => {
  const mk = (status: number, content?: string): FetchLike => () =>
    Promise.resolve({
      status,
      json: () =>
        Promise.resolve(
          content ? { content: toBase64(content), sha: "abc" } : {},
        ),
    });
  const missing = new GitHubClient("t", "anomalica", "main", mk(404));
  assertEquals(await missing.getFile("curation", "merges.yaml"), null);

  const present = new GitHubClient(
    "t",
    "anomalica",
    "main",
    mk(200, "op: merge\n"),
  );
  assertEquals(await present.getFile("curation", "merges.yaml"), {
    text: "op: merge\n",
    sha: "abc",
  });
});

Deno.test("listDirectoryAt resolves a committed subtree", async () => {
  const seen: string[] = [];
  const fetchImpl: FetchLike = (url) => {
    seen.push(url);
    if (url.endsWith("/git/commits/commit")) {
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ tree: { sha: "root" } }),
      });
    }
    if (url.endsWith("/git/trees/root")) {
      return Promise.resolve({
        status: 200,
        json: () =>
          Promise.resolve({
            tree: [{ path: "store", type: "tree", sha: "tree" }],
          }),
      });
    }
    return Promise.resolve({
      status: 200,
      json: () =>
        Promise.resolve({
          tree: [
            { path: "a.md", type: "blob", sha: "a" },
            { path: "v1", type: "tree", sha: "b" },
          ],
        }),
    });
  };
  const gh = new GitHubClient("t", "anomalica", "main", fetchImpl);
  assertEquals(await gh.listDirectoryAt("ingests", "store", "commit"), [
    { name: "a.md", type: "blob" },
    { name: "v1", type: "tree" },
  ]);
  assertEquals(seen.length, 3);
});

Deno.test("editFile creates a missing file (no sha sent)", async () => {
  const seen: { method?: string; body: Record<string, unknown> }[] = [];
  const fetchImpl: FetchLike = (_url, init) => {
    if (init?.method === "PUT") {
      seen.push({ method: init.method, body: JSON.parse(String(init.body)) });
      return Promise.resolve({
        status: 201,
        json: () => Promise.resolve({ content: { sha: "new" } }),
      });
    }
    return Promise.resolve({ status: 404, json: () => Promise.resolve({}) }); // GET: missing
  };
  const gh = new GitHubClient("t", "anomalica", "main", fetchImpl);
  const sha = await gh.editFile(
    "curation",
    "rejections.yaml",
    (cur) => cur + "---\nop: reject\n",
    "reject cluster",
    { name: "R", email: "r@x.com" },
  );
  assertEquals(sha, "new");
  assertEquals(seen.length, 1);
  assert(!("sha" in seen[0].body), "no sha for a new file");
  assertEquals(fromBase64(String(seen[0].body.content)), "---\nop: reject\n");
});

Deno.test("editFile retries on a sha conflict then succeeds", async () => {
  let getCount = 0;
  let putCount = 0;
  const fetchImpl: FetchLike = (_url, init) => {
    if (init?.method === "PUT") {
      putCount++;
      // first PUT conflicts (someone else committed), second wins
      if (putCount === 1) {
        return Promise.resolve({
          status: 409,
          json: () => Promise.resolve({}),
        });
      }
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ content: { sha: "final" } }),
      });
    }
    getCount++;
    return Promise.resolve({
      status: 200,
      json: () =>
        Promise.resolve({ content: toBase64("base\n"), sha: `sha${getCount}` }),
    });
  };
  const gh = new GitHubClient("t", "anomalica", "main", fetchImpl);
  const sha = await gh.editFile("c", "f.yaml", (c) => c + "x\n", "msg", {
    name: "R",
    email: "r@x.com",
  });
  assertEquals(sha, "final");
  assertEquals(putCount, 2); // retried
  assertEquals(getCount, 2); // re-read before the retry
});

// The FULL message is carried, subject + body - NOT just the subject line. The
// reviewer's own notes ("Reviewed up to 20%") live in the body, and that is
// exactly what someone resuming after an interruption needs. The display summary
// is derived downstream by commitSummary() in main.ts, so truncating here would
// destroy the notes before anything could show them.
Deno.test("listCommits maps the commits API, preserving the reviewer's notes", async () => {
  const fetchImpl: FetchLike = (url) => {
    assert(url.includes("/commits?path="));
    return Promise.resolve({
      status: 200,
      json: () =>
        Promise.resolve([
          {
            commit: {
              author: {
                name: "Mark",
                email: "m@x.com",
                date: "2026-06-22T02:35:31Z",
              },
              message: "review: fix names\n\nReviewed up to 20%",
            },
          },
        ]),
    });
  };
  const gh = new GitHubClient("t", "anomalica", "main", fetchImpl);
  const commits = await gh.listCommits("ingests", "store/abc.v2.md");
  assertEquals(commits, [
    {
      by: "Mark",
      email: "m@x.com",
      at: "2026-06-22T02:35:31Z",
      message: "review: fix names\n\nReviewed up to 20%",
    },
  ]);
});

Deno.test("listCommits returns [] for a missing path (404)", async () => {
  const gh = new GitHubClient(
    "t",
    "anomalica",
    "main",
    () => Promise.resolve({ status: 404, json: () => Promise.resolve({}) }),
  );
  assertEquals(await gh.listCommits("ingests", "store/nope.md"), []);
});

Deno.test("commitFiles creates one two-file commit and advances the ref with CAS", async () => {
  const calls: {
    url: string;
    method: string;
    body?: Record<string, unknown>;
  }[] = [];
  let blob = 0;
  const fetchImpl: FetchLike = (url, init) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url.includes("/git/ref/heads/main")) {
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ object: { sha: "parent" } }),
      });
    }
    if (url.endsWith("/git/commits/parent")) {
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ tree: { sha: "base" } }),
      });
    }
    if (url.includes("/contents/")) {
      const sha = url.includes("record.md") ? "record-old" : "sidecar-old";
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ sha }),
      });
    }
    if (url.endsWith("/git/blobs")) {
      blob++;
      return Promise.resolve({
        status: 201,
        json: () => Promise.resolve({ sha: `blob-${blob}` }),
      });
    }
    if (url.endsWith("/git/trees")) {
      return Promise.resolve({
        status: 201,
        json: () => Promise.resolve({ sha: "tree-new" }),
      });
    }
    if (url.endsWith("/git/commits")) {
      return Promise.resolve({
        status: 201,
        json: () => Promise.resolve({ sha: "commit-new" }),
      });
    }
    if (url.includes("/git/refs/heads/main")) {
      return Promise.resolve({ status: 200, json: () => Promise.resolve({}) });
    }
    throw new Error(`unexpected ${method} ${url}`);
  };
  const gh = new GitHubClient("t", "anomalica", "main", fetchImpl);
  assertEquals(
    await gh.commitFiles(
      "ingests",
      [
        {
          path: "store/record.md",
          text: "new record",
          expectedSha: "record-old",
        },
        {
          path: "store/sidecar.json",
          text: "new sidecar",
          expectedSha: "sidecar-old",
        },
      ],
      "housekeeping",
      { name: "R", email: "r@x.com" },
    ),
    "commit-new",
  );
  const tree = calls.find((call) => call.url.endsWith("/git/trees"))!.body!;
  assertEquals((tree.tree as unknown[]).length, 2);
  const commit = calls.find((call) => call.url.endsWith("/git/commits"))!.body!;
  assertEquals(commit.parents, ["parent"]);
  const patch = calls.find((call) => call.method === "PATCH")!.body!;
  assertEquals(patch, { sha: "commit-new", force: false });
});

Deno.test("commitFiles re-reads a raced ref and refuses a changed target path", async () => {
  let refs = 0;
  let patches = 0;
  const fetchImpl: FetchLike = (url, init) => {
    if (url.includes("/git/ref/heads/main")) {
      refs++;
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ object: { sha: `parent-${refs}` } }),
      });
    }
    if (/\/git\/commits\/parent-\d$/.test(url)) {
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ tree: { sha: "base" } }),
      });
    }
    if (url.includes("/contents/")) {
      return Promise.resolve({
        status: 200,
        json: () =>
          Promise.resolve({ sha: refs === 1 ? "old" : "someone-else" }),
      });
    }
    if (url.endsWith("/git/blobs")) {
      return Promise.resolve({
        status: 201,
        json: () => Promise.resolve({ sha: "blob" }),
      });
    }
    if (url.endsWith("/git/trees")) {
      return Promise.resolve({
        status: 201,
        json: () => Promise.resolve({ sha: "tree" }),
      });
    }
    if (url.endsWith("/git/commits")) {
      return Promise.resolve({
        status: 201,
        json: () => Promise.resolve({ sha: "commit" }),
      });
    }
    if (init?.method === "PATCH") {
      patches++;
      return Promise.resolve({ status: 409, json: () => Promise.resolve({}) });
    }
    throw new Error(`unexpected ${url}`);
  };
  const gh = new GitHubClient("t", "anomalica", "main", fetchImpl);
  await assertRejects(
    () =>
      gh.commitFiles(
        "ingests",
        [{ path: "store/record.md", text: "new", expectedSha: "old" }],
        "housekeeping",
        { name: "R", email: "r@x.com" },
      ),
    GitHubError,
    "changed",
  );
  assertEquals(patches, 0);
  assertEquals(refs, 3);
});
