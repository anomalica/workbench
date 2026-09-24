import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  type FetchLike,
  GitHubClient,
  RepositoryPrivacyError,
  toBase64,
} from "./github.ts";
import { newlyUnsafeFields } from "./repository_privacy.ts";

Deno.test("record metadata is checked without scanning original source text", () => {
  const before = "---\nsource_url: file:///home/reviewer/old.pdf\n---\nbody\n";
  const same =
    "---\nsource_url: file:///home/reviewer/old.pdf\ntitle: Fixed\n---\nbody\n";
  assertEquals(newlyUnsafeFields("store/a.md", same, before), []);
  assertEquals(
    newlyUnsafeFields(
      "store/a.md",
      "---\ntitle: Source\n---\nfile:///home/reviewer/old.pdf",
    ),
    [],
  );
  assertEquals(
    newlyUnsafeFields(
      "store/a.md",
      "---\nsource_file: /home%2Freviewer%2Fdocument.pdf\n---\n",
    ),
    ["source_file"],
  );
});

Deno.test("production GitHub writer refuses new local machine metadata before writing", async () => {
  const calls: string[] = [];
  const fetchImpl: FetchLike = (url) => {
    calls.push(url);
    return Promise.resolve({
      status: 200,
      json: () => Promise.resolve({ object: { sha: "parent" } }),
    });
  };
  const github = new GitHubClient("token", "anomalica", "main", fetchImpl);
  const content = "---\nsource_url: file:///home/reviewer/doc.pdf\n---\nbody\n";
  await assertRejects(
    () =>
      github.putFile("ingests", "store/a.md", content, "review", {
        name: "R",
        email: "r@example.test",
      }),
    RepositoryPrivacyError,
    "source_url",
  );
  assertEquals(calls, []);
  await assertRejects(
    () =>
      github.commitFiles(
        "ingests",
        [{ path: "store/a.md", text: content, expectedSha: null }],
        "review",
        { name: "R", email: "r@example.test" },
      ),
    RepositoryPrivacyError,
    "source_url",
  );
  assertEquals(calls.length, 1); // branch ref only; no blob or commit was sent
});

Deno.test("a privacy rejection is not retried as a GitHub conflict", async () => {
  let calls = 0;
  const fetchImpl: FetchLike = () => {
    calls++;
    return Promise.resolve({
      status: 200,
      json: () =>
        Promise.resolve({
          content: toBase64("---\nsource_url: https://example.test/\n---\n"),
          sha: "old",
        }),
    });
  };
  const github = new GitHubClient("token", "anomalica", "main", fetchImpl);

  await assertRejects(
    () =>
      github.editFile(
        "ingests",
        "store/a.md",
        () => "---\nsource_url: file:///home/reviewer/doc.pdf\n---\n",
        "review",
        { name: "R", email: "r@example.test" },
      ),
    RepositoryPrivacyError,
  );

  assertEquals(calls, 2); // initial read plus the privacy baseline read; no retry
});
