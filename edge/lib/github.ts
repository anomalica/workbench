/**
 * GitHub API client - the serverless write path (the production
 * GitHubIngestSource the FastAPI stub stands in for). No local clone, no volume:
 * reads + commits go straight through the Contents and Git Data APIs with a
 * service-account token.
 *
 * Used for: reviewer corrections -> the ingests repo, and curation decisions ->
 * the curation ledger. Writes are read-modify-write with an optimistic-lock
 * retry on the file sha (concurrent reviewers are a sha conflict, not corruption).
 *
 * fetchImpl is injectable so the logic is unit-testable without network.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Standard base64 (padded) of a UTF-8 string - the contents API content field. */
export function toBase64(text: string): string {
  const bytes = encoder.encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Decode the contents API base64 (which is line-wrapped) back to a UTF-8 string. */
export function fromBase64(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return decoder.decode(bytes);
}

export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<{ status: number; json: () => Promise<unknown> }>;

export interface Author {
  name: string;
  email: string;
}

export interface FileState {
  text: string;
  sha: string;
}

export interface DirectoryEntry {
  name: string;
  type: "blob" | "tree";
}

export interface AtomicFileChange {
  path: string;
  text: string;
  /** Blob sha read before constructing the change. Null means the path must not exist. */
  expectedSha: string | null;
}

export interface CommitFilesOptions {
  /** Commit the change only while the branch still names the commit the client viewed. */
  expectedRef?: string;
  retries?: number;
}

export interface CommitFilesResult {
  commitSha: string;
  fileShas: Record<string, string>;
}

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export class GitHubClient {
  constructor(
    private token: string,
    private owner: string,
    private branch = "main",
    private fetchImpl: FetchLike = globalThis.fetch as unknown as FetchLike,
  ) {}

  private url(repo: string, path: string): string {
    const clean = path.split("/").map(encodeURIComponent).join("/");
    return `https://api.github.com/repos/${this.owner}/${repo}/contents/${clean}`;
  }

  private api(repo: string, path: string): string {
    return `https://api.github.com/repos/${this.owner}/${repo}/${path}`;
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "anomalica-workbench-edge",
    };
  }

  /** The commit history of a path (newest first) - the review history of a
   *  record. Returns [] if the file/repo is absent (404). */
  async listCommits(
    repo: string,
    path: string,
    perPage = 30,
  ): Promise<{ by: string; email: string; at: string; message: string }[]> {
    const clean = path.split("/").map(encodeURIComponent).join("/");
    const res = await this.fetchImpl(
      `https://api.github.com/repos/${this.owner}/${repo}/commits` +
        `?path=${clean}&sha=${
          encodeURIComponent(this.branch)
        }&per_page=${perPage}`,
      { headers: this.headers() },
    );
    if (res.status === 404 || res.status === 409) return []; // 409: empty repo
    if (res.status !== 200) {
      throw new GitHubError(res.status, `listCommits ${path}`);
    }
    const body = (await res.json()) as {
      commit: {
        author: { name: string; email: string; date: string };
        message: string;
      };
    }[];
    return body.map((c) => ({
      by: c.commit.author.name,
      email: c.commit.author.email,
      at: c.commit.author.date,
      // Full message (subject + body), not just the subject line: the
      // reviewer's notes ("Reviewed up to 20%") live in the body, and a
      // reviewer resuming later needs that, not just the commit title.
      // handleHistory derives the display summary from it.
      message: c.commit.message,
    }));
  }

  /** Read the branch head. */
  async getRef(repo: string): Promise<string> {
    const branchPath = this.branch.split("/").map(encodeURIComponent).join("/");
    const res = await this.fetchImpl(
      this.api(repo, `git/ref/heads/${branchPath}`),
      {
        headers: this.headers(),
      },
    );
    if (res.status !== 200) throw new GitHubError(res.status, "get branch ref");
    return ((await res.json()) as { object: { sha: string } }).object.sha;
  }

  /** Read a file from one committed tree. Returns null if it does not exist. */
  async getFileAt(
    repo: string,
    path: string,
    ref: string,
  ): Promise<FileState | null> {
    const res = await this.fetchImpl(
      `${this.url(repo, path)}?ref=${encodeURIComponent(ref)}`,
      {
        headers: this.headers(),
      },
    );
    if (res.status === 404) return null;
    if (res.status !== 200) {
      throw new GitHubError(res.status, `getFile ${path}`);
    }
    const body = (await res.json()) as { content: string; sha: string };
    return { text: fromBase64(body.content), sha: body.sha };
  }

  /** Read a file from the configured branch. */
  getFile(repo: string, path: string): Promise<FileState | null> {
    return this.getFileAt(repo, path, this.branch);
  }

  /** List one directory in a committed tree without downloading its files. */
  async listDirectoryAt(
    repo: string,
    path: string,
    ref: string,
  ): Promise<DirectoryEntry[]> {
    const commit = await this.fetchImpl(
      this.api(repo, `git/commits/${encodeURIComponent(ref)}`),
      { headers: this.headers() },
    );
    if (commit.status === 404) return [];
    if (commit.status !== 200) {
      throw new GitHubError(commit.status, `listDirectory ${path}`);
    }
    let tree = ((await commit.json()) as { tree: { sha: string } }).tree.sha;
    for (const part of path.split("/").filter(Boolean)) {
      const res = await this.fetchImpl(
        this.api(repo, `git/trees/${encodeURIComponent(tree)}`),
        { headers: this.headers() },
      );
      if (res.status === 404) return [];
      if (res.status !== 200) {
        throw new GitHubError(res.status, `listDirectory ${path}`);
      }
      const body = (await res.json()) as {
        tree: { path: string; type: "blob" | "tree"; sha: string }[];
      };
      const next = body.tree.find((entry) =>
        entry.path === part && entry.type === "tree"
      );
      if (!next) return [];
      tree = next.sha;
    }
    const res = await this.fetchImpl(
      this.api(repo, `git/trees/${encodeURIComponent(tree)}`),
      { headers: this.headers() },
    );
    if (res.status === 404) return [];
    if (res.status !== 200) {
      throw new GitHubError(res.status, `listDirectory ${path}`);
    }
    const body = (await res.json()) as {
      tree: { path: string; type: "blob" | "tree" }[];
    };
    return body.tree.map((entry) => ({ name: entry.path, type: entry.type }));
  }

  /** Create or update a file. Pass the prior sha to update; omit to create. */
  async putFile(
    repo: string,
    path: string,
    text: string,
    message: string,
    author: Author,
    sha?: string,
  ): Promise<string> {
    const res = await this.fetchImpl(this.url(repo, path), {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify({
        message,
        content: toBase64(text),
        branch: this.branch,
        author,
        committer: author,
        ...(sha ? { sha } : {}),
      }),
    });
    if (res.status === 409 || res.status === 422) {
      throw new GitHubError(res.status, "sha conflict");
    }
    if (res.status !== 200 && res.status !== 201) {
      throw new GitHubError(res.status, `putFile ${path}`);
    }
    const body = (await res.json()) as { content: { sha: string } };
    return body.content.sha;
  }

  /**
   * Read-modify-write with optimistic-lock retry: read the file (or treat a
   * missing file as ""), apply `transform`, commit. On a sha conflict (another
   * writer landed first), re-read and retry. This is how concurrent reviewers
   * appending to the same ledger serialise safely.
   */
  async editFile(
    repo: string,
    path: string,
    transform: (current: string) => string,
    message: string,
    author: Author,
    retries = 4,
  ): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const existing = await this.getFile(repo, path);
      const next = transform(existing?.text ?? "");
      try {
        return await this.putFile(
          repo,
          path,
          next,
          message,
          author,
          existing?.sha,
        );
      } catch (err) {
        if (
          err instanceof GitHubError &&
          (err.status === 409 || err.status === 422)
        ) {
          lastErr = err;
          continue; // re-read and retry
        }
        throw err;
      }
    }
    throw lastErr ?? new GitHubError(409, "editFile: exhausted retries");
  }

  /**
   * Commit several files together, then advance the branch only if its ref still
   * names the parent we read. If an unrelated commit wins the race, rebuild on
   * its head; if any changed path moved, fail stale rather than overwrite it.
   */
  async commitFiles(
    repo: string,
    changes: AtomicFileChange[],
    message: string,
    author: Author,
    options: CommitFilesOptions = {},
  ): Promise<CommitFilesResult> {
    if (changes.length === 0) throw new Error("commitFiles: no changes");
    if (new Set(changes.map((change) => change.path)).size !== changes.length) {
      throw new Error("commitFiles: duplicate path");
    }

    let lastErr: unknown;
    const retries = options.retries ?? 4;
    const branchPath = this.branch.split("/").map(encodeURIComponent).join("/");
    for (let attempt = 0; attempt <= retries; attempt++) {
      const parent = await this.getRef(repo);
      if (options.expectedRef !== undefined && parent !== options.expectedRef) {
        throw new GitHubError(409, "branch changed");
      }

      const parentCommit = await this.fetchImpl(
        this.api(repo, `git/commits/${parent}`),
        {
          headers: this.headers(),
        },
      );
      if (parentCommit.status !== 200) {
        throw new GitHubError(parentCommit.status, "get parent commit");
      }
      const baseTree =
        ((await parentCommit.json()) as { tree: { sha: string } }).tree.sha;

      for (const change of changes) {
        const current = await this.fetchImpl(
          `${this.url(repo, change.path)}?ref=${encodeURIComponent(parent)}`,
          { headers: this.headers() },
        );
        if (current.status === 404) {
          if (change.expectedSha !== null) {
            throw new GitHubError(409, `${change.path} changed`);
          }
        } else if (current.status === 200) {
          const sha = ((await current.json()) as { sha: string }).sha;
          if (sha !== change.expectedSha) {
            throw new GitHubError(409, `${change.path} changed`);
          }
        } else {
          throw new GitHubError(
            current.status,
            `getFile ${change.path} at parent`,
          );
        }
      }

      const treeEntries: {
        path: string;
        mode: "100644";
        type: "blob";
        sha: string;
      }[] = [];
      for (const change of changes) {
        const blob = await this.fetchImpl(this.api(repo, "git/blobs"), {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            content: toBase64(change.text),
            encoding: "base64",
          }),
        });
        if (blob.status !== 201) {
          throw new GitHubError(blob.status, `create blob ${change.path}`);
        }
        treeEntries.push({
          path: change.path,
          mode: "100644",
          type: "blob",
          sha: ((await blob.json()) as { sha: string }).sha,
        });
      }

      const tree = await this.fetchImpl(this.api(repo, "git/trees"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ base_tree: baseTree, tree: treeEntries }),
      });
      if (tree.status !== 201) {
        throw new GitHubError(tree.status, "create tree");
      }
      const treeSha = ((await tree.json()) as { sha: string }).sha;

      const commit = await this.fetchImpl(this.api(repo, "git/commits"), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          message,
          tree: treeSha,
          parents: [parent],
          author,
          committer: author,
        }),
      });
      if (commit.status !== 201) {
        throw new GitHubError(commit.status, "create commit");
      }
      const commitSha = ((await commit.json()) as { sha: string }).sha;

      // GitHub's ref update has no If-Match input. Re-read before PATCH so a
      // raced branch is revalidated rather than relying only on non-fast-forward
      // rejection after constructing a commit from an obsolete parent.
      if ((await this.getRef(repo)) !== parent) {
        lastErr = new GitHubError(409, "ref conflict");
        continue;
      }

      const update = await this.fetchImpl(
        this.api(repo, `git/refs/heads/${branchPath}`),
        {
          method: "PATCH",
          headers: this.headers(),
          body: JSON.stringify({ sha: commitSha, force: false }),
        },
      );
      if (update.status === 200) {
        return {
          commitSha,
          fileShas: Object.fromEntries(
            treeEntries.map((entry) => [entry.path, entry.sha]),
          ),
        };
      }
      if (update.status === 409 || update.status === 422) {
        lastErr = new GitHubError(update.status, "ref conflict");
        continue;
      }
      throw new GitHubError(update.status, "update branch ref");
    }
    throw lastErr ?? new GitHubError(409, "commitFiles: exhausted retries");
  }
}
