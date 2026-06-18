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
 * (unsaved body edits) or `workbench:notes:` (unsaved notes) - losing those
 * would discard the reviewer's actual work.
 */

const PREFIX = "workbench:";

// Reconstructible-from-server or pure-UI state - safe to drop to free space.
const EVICTABLE_PREFIXES = [
  "workbench:observed:",
  "workbench:read:",
  "workbench:coverage:",
  "workbench:lastseg:",
];

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

export const _internal = { PREFIX, EVICTABLE_PREFIXES };
