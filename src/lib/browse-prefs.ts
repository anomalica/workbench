/**
 * How the reviewer left the record list arranged.
 *
 * Sorting the browse list is not a one-off action, it is how a particular
 * reviewer works: someone checking recent intake sorts by date ingested,
 * someone chasing a backlog sorts by reviewed. Forgetting that on every visit
 * means re-picking the same two controls before any actual work starts.
 *
 * Validated on the way in rather than trusted. A stale value from an older
 * build - a sort key that no longer exists - would otherwise reach the sort
 * switch, match no case, and leave the list in whatever order the server sent,
 * which reads as the sort being broken rather than the preference being stale.
 */

import { safeLocalSet } from "$lib/storage";

// `version` was removed with the Ver column. A stored preference naming it now
// fails validation and falls back, which is why the validator exists.
export const SORT_KEYS = [
  "date",
  "title",
  "type",
  "publisher",
  "creator",
  "digestible",
  "digested",
  "copyright",
  "priority",
] as const;

export const DATE_FIELDS = ["published", "ingested", "reviewed"] as const;

export type SortKey = (typeof SORT_KEYS)[number];
export type DateField = (typeof DATE_FIELDS)[number];

export interface BrowsePrefs {
  sortBy: SortKey;
  sortAsc: boolean;
  dateField: DateField;
}

/** Newest first, by publication date - what someone opening the workbench
 *  without an opinion should see. */
export const BROWSE_DEFAULTS: BrowsePrefs = {
  sortBy: "date",
  sortAsc: false,
  dateField: "published",
};

export const BROWSE_STORAGE_KEY = "workbench:browse";

export function loadBrowsePrefs(): BrowsePrefs {
  try {
    const raw = localStorage.getItem(BROWSE_STORAGE_KEY);
    if (!raw) return { ...BROWSE_DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<BrowsePrefs>;
    return {
      sortBy: SORT_KEYS.includes(parsed?.sortBy as SortKey)
        ? (parsed.sortBy as SortKey)
        : BROWSE_DEFAULTS.sortBy,
      sortAsc: typeof parsed?.sortAsc === "boolean" ? parsed.sortAsc : BROWSE_DEFAULTS.sortAsc,
      dateField: DATE_FIELDS.includes(parsed?.dateField as DateField)
        ? (parsed.dateField as DateField)
        : BROWSE_DEFAULTS.dateField,
    };
  } catch {
    // Corrupt or unavailable storage: the arrangement is a convenience, so it
    // falls back rather than failing.
    return { ...BROWSE_DEFAULTS };
  }
}

export function saveBrowsePrefs(prefs: BrowsePrefs): void {
  safeLocalSet(BROWSE_STORAGE_KEY, JSON.stringify(prefs));
}
