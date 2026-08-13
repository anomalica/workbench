/**
 * Storing a browser draft as the DIFFERENCE from the server's copy.
 *
 * A draft used to be the whole document. Marking one segment irrelevant in a
 * 780KB book wrote 780KB to localStorage, and with undo history behind it, up
 * to twenty more copies of the same book - against a ~5MB per-origin quota that
 * the next book then found already full. The reviewer got "your last edit could
 * NOT be saved in this browser", which is the one failure this store exists to
 * prevent.
 *
 * The server already has the unedited text. So the draft only has to record how
 * the reviewer's copy differs from it: the changed lines, plus references to
 * the runs that did not change. Fifty scattered edits in a 20,000-line book
 * become about a hundred short runs instead of a second copy of the book.
 *
 * Deliberately not a general diff. There is no LCS search here - it walks the
 * current text once, matching each line against the original from a moving
 * cursor and re-syncing through an index when an edit breaks the run. That is
 * linear, has no dependency, and stays exact: `decode(original, encode(a, b))`
 * returns b for ANY pair of strings, because anything it fails to match is
 * simply stored as a literal.
 */

/** A run of unchanged lines, by position in the original. */
type CopyOp = [start: number, count: number];
/** Lines that are not in the original at this point, stored verbatim. */
type LiteralOp = string[];

export type PatchOp = { c: CopyOp } | { l: LiteralOp };

export interface DraftPatch {
  /** Guards against applying a patch to a body the server has since changed. */
  base: number;
  ops: PatchOp[];
}

/** Cheap non-cryptographic hash (FNV-1a, 32-bit). Identity check only - it
 *  never has to resist an adversary, just catch "the record changed under
 *  this draft", where any mismatch at all is enough. */
export function fingerprint(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function encodePatch(original: string, current: string): DraftPatch {
  const from = original.split("\n");
  const to = current.split("\n");

  // Where each line occurs in the original, so the walk can re-sync after an
  // edit instead of degrading into literals for the rest of the document.
  const positions = new Map<string, number[]>();
  for (let i = 0; i < from.length; i++) {
    const at = positions.get(from[i]);
    if (at) at.push(i);
    else positions.set(from[i], [i]);
  }

  const ops: PatchOp[] = [];
  let literal: string[] = [];
  let cursor = 0;

  const flush = () => {
    if (literal.length) {
      ops.push({ l: literal });
      literal = [];
    }
  };

  for (let i = 0; i < to.length; i++) {
    const line = to[i];
    let at = -1;
    if (cursor < from.length && from[cursor] === line) {
      at = cursor;
    } else {
      // Prefer the nearest occurrence at or after the cursor: an edit usually
      // moves forward, and picking an earlier one would re-emit text.
      const all = positions.get(line);
      if (all) {
        for (const p of all) {
          if (p >= cursor) {
            at = p;
            break;
          }
        }
      }
    }

    if (at === -1) {
      literal.push(line);
      continue;
    }

    flush();
    const last = ops[ops.length - 1];
    if (last && "c" in last && last.c[0] + last.c[1] === at) last.c[1]++;
    else ops.push({ c: [at, 1] });
    cursor = at + 1;
  }
  flush();

  return { base: fingerprint(original), ops };
}

export function decodePatch(original: string, patch: DraftPatch): string | null {
  if (patch.base !== fingerprint(original)) return null;
  const from = original.split("\n");
  const out: string[] = [];
  for (const op of patch.ops) {
    if ("c" in op) {
      const [start, count] = op.c;
      if (start < 0 || start + count > from.length) return null;
      for (let i = 0; i < count; i++) out.push(from[start + i]);
    } else {
      out.push(...op.l);
    }
  }
  return out.join("\n");
}

/** Rough serialised size, for deciding how much undo history is affordable. */
export function patchSize(patch: DraftPatch): number {
  return JSON.stringify(patch).length;
}
