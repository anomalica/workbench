/**
 * GitHub contents-API client - the serverless write path (the production
 * GitHubIngestSource the FastAPI stub stands in for). No local clone, no volume:
 * reads + commits go straight through the API with a service-account token.
 *
 * Used for: reviewer corrections -> the ingests repo, and curation decisions ->
 * the curation ledger. Writes are read-modify-write with an optimistic-lock
 * retry on the file sha (concurrent reviewers are a sha conflict, not corruption).
 *
 * fetchImpl is injectable so the logic is unit-testable without network.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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
        `?path=${clean}&sha=${encodeURIComponent(this.branch)}&per_page=${perPage}`,
      { headers: this.headers() },
    );
    if (res.status === 404 || res.status === 409) return []; // 409: empty repo
    if (res.status !== 200) throw new GitHubError(res.status, `listCommits ${path}`);
    const body = (await res.json()) as {
      commit: { author: { name: string; email: string; date: string }; message: string };
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

  /** Read a file. Returns null if it does not exist (404). */
  async getFile(repo: string, path: string): Promise<FileState | null> {
    const res = await this.fetchImpl(
      `${this.url(repo, path)}?ref=${encodeURIComponent(this.branch)}`,
      { headers: this.headers() },
    );
    if (res.status === 404) return null;
    if (res.status !== 200) throw new GitHubError(res.status, `getFile ${path}`);
    const body = (await res.json()) as { content: string; sha: string };
    return { text: fromBase64(body.content), sha: body.sha };
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
        return await this.putFile(repo, path, next, message, author, existing?.sha);
      } catch (err) {
        if (err instanceof GitHubError && (err.status === 409 || err.status === 422)) {
          lastErr = err;
          continue; // re-read and retry
        }
        throw err;
      }
    }
    throw lastErr ?? new GitHubError(409, "editFile: exhausted retries");
  }
}
