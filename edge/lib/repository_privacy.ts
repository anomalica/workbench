/** Mirrors anomalica_common.repository_privacy for GitHub API writes.
 * Local-machine metadata must not enter the ingests repository. Source bodies
 * are evidence, and existing legacy metadata may be preserved during an edit.
 */
import { parse } from "jsr:@std/yaml@1";

const localFields = new Set([
  "source_url",
  "fetched_url",
  "asset_path",
  "source_file",
  "reference",
  "source_path",
  "file_path",
  "local_path",
  "input_file",
  "output_file",
  "asset_error",
  "path",
]);

function metadata(path: string, content: string): unknown {
  let text = content;
  if (path.endsWith(".md") && text.startsWith("---\n")) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (match) text = match[1];
  }
  try {
    if (path.endsWith(".json")) return JSON.parse(text);
    if (
      path.endsWith(".md") || path.endsWith(".yaml") || path.endsWith(".yml")
    ) {
      return parse(text);
    }
  } catch {
    // Malformed metadata still gets a lexical check rather than bypassing it.
  }
  return text;
}

function unsafe(value: unknown, path = ""): Map<string, string> {
  const result = new Map<string, string>();
  function visit(current: unknown, field: string): void {
    if (typeof current === "string") {
      let decoded = current;
      for (let n = 0; n < 3; n++) {
        try {
          const next = decodeURIComponent(decoded);
          if (next === decoded) break;
          decoded = next;
        } catch {
          break;
        }
      }
      decoded = decoded.replaceAll("\\", "/");
      const name = field.split(".").at(-1);
      const local = localFields.has(name ?? "") &&
        /^(?:file:|\/|~\/|[a-z]:\/)/i.test(decoded);
      if (
        local || decoded.toLowerCase().includes("file://") ||
        /(?:^|\W)(?:\/home\/[^/\s]+|\/Users\/[^/\s]+)(?:\/|$)/i.test(decoded) ||
        /(?:^|\W)[a-z]:\/Users\/[^/\s]+(?:\/|$)/i.test(decoded) ||
        /(?:^|[\s"'=(:])\/(?:tmp|var|mnt|media|opt|etc|srv|run|private|Volumes)\/[^\s]+/i
          .test(decoded)
      ) result.set(field, current);
    } else if (Array.isArray(current)) {
      for (const [index, item] of current.entries()) {
        visit(item, `${field}[${index}]`);
      }
    } else if (current && typeof current === "object") {
      for (const [key, item] of Object.entries(current)) {
        visit(item, field ? `${field}.${key}` : key);
      }
    }
  }
  visit(value, path);
  return result;
}

/** Names fields only; never include the offending value in an error message. */
export function newlyUnsafeFields(
  path: string,
  content: string,
  previous = "",
): string[] {
  const before = unsafe(metadata(path, previous));
  return [...unsafe(metadata(path, content))].filter(
    ([field, value]) => before.get(field) !== value,
  ).map(([field]) => field).sort();
}

export function unsafeMessage(message: string): boolean {
  return unsafe(message).size > 0;
}
