/**
 * Best-effort localStorage writes.
 *
 * A bare `localStorage.setItem` throws `QuotaExceededError` when the origin's
 * store is full. When that call lives inside a Svelte `$effect`, the throw
 * aborts the effect graph and tears down the component's render - which once
 * killed all per-word highlighting in the word editor on a large record whose
 * body draft had filled the quota. Persistence here is a convenience, never a
 * correctness requirement: it must degrade silently, never throw.
 *
 * On a quota failure we evict reconstructible session drafts and UI state for
 * OTHER records (coverage/observed sets come back from the server after submit;
 * last-segment is pure UI state) and retry once. We never evict `workbench:doc:`
 * (unsaved body edits) or `workbench:notes:` (unsaved notes) for a LIVE record -
 * losing those would discard the reviewer's actual work. See pruneOrphanedDrafts
 * below for the one case where doc/notes ARE safe to remove: the record they
 * belong to no longer exists in the corpus at all, so there is no work left to
 * protect - just quota being silently consumed by nothing.
 *
 * Incident (2026-07-01): a record's browser draft was lost because this
 * origin's localStorage was already within ~40KB of the ~5MB per-origin quota,
 * crowded by drafts for records deleted from the corpus months earlier. The
 * record's own save then failed - silently, per the design above - and the
 * work was gone on the next reload. pruneOrphanedDrafts is the fix: called once
 * at app load with the current corpus's hashes, it reclaims exactly that kind
 * of dead weight before it can crowd out a live record's save.
 */

const PREFIX = "workbench:";

// Reconstructible-from-server or pure-UI state - safe to drop to free space.
const EVICTABLE_PREFIXES = [
  "workbench:observed:",
  "workbench:read:",
  "workbench:coverage:",
  "workbench:lastseg:",
  // Where the reviewer was in a record's audio. Pure convenience: evicting it
  // costs them their place, never their work.
  "workbench:playhead:",
];

// Every prefix keyed by a record's content_hash - the full set a record's
// local state can occupy. Used by pruneOrphanedDrafts, which (unlike
// EVICTABLE_PREFIXES above) also includes doc/notes: safe ONLY because the
// record itself no longer exists anywhere in the corpus to have work protected.
const HASH_KEYED_PREFIXES = [...EVICTABLE_PREFIXES, "workbench:doc:", "workbench:notes:"];

function evictReconstructible(keep: string): boolean {
  const victims: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k || k === keep) continue;
    if (EVICTABLE_PREFIXES.some((p) => k.startsWith(p))) victims.push(k);
  }
  for (const k of victims) localStorage.removeItem(k);
  return victims.length > 0;
}

/**
 * Write to localStorage without ever throwing. Returns whether the value was
 * persisted. On quota failure, prunes reconstructible keys and retries once.
 */
export function safeLocalSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    if (evictReconstructible(key)) {
      try {
        localStorage.setItem(key, value);
        return true;
      } catch {
        /* still full - give up; persistence is best-effort */
      }
    }
    return false;
  }
}

/**
 * Remove every hash-keyed workbench entry (doc drafts, notes, observed spans,
 * coverage, read state, last-segment) whose record is not in `liveHashes`.
 * Call once per app load, right after fetching the current corpus - never
 * speculatively, since a false "doesn't exist" would destroy real unsynced
 * work. Callers should refuse to prune against an empty/degenerate hash set
 * (a failed or partial fetch must never look like "the corpus is empty").
 *
 * Returns how many keys were removed and roughly how many bytes were freed,
 * so a caller can log it - this runs silently otherwise.
 */
export function pruneOrphanedDrafts(liveHashes: ReadonlySet<string>): {
  removed: number;
  freedBytes: number;
} {
  if (liveHashes.size === 0) return { removed: 0, freedBytes: 0 };
  const victims: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k) continue;
    const prefix = HASH_KEYED_PREFIXES.find((p) => k.startsWith(p));
    if (!prefix) continue;
    const hash = k.slice(prefix.length);
    if (!liveHashes.has(hash)) victims.push(k);
  }
  let freedBytes = 0;
  for (const k of victims) {
    freedBytes += k.length + (localStorage.getItem(k)?.length ?? 0);
    localStorage.removeItem(k);
  }
  return { removed: victims.length, freedBytes };
}

export const _internal = { PREFIX, EVICTABLE_PREFIXES, HASH_KEYED_PREFIXES };
