import { beforeEach, describe, expect, it } from "vitest";
import {
  BROWSE_DEFAULTS,
  BROWSE_STORAGE_KEY,
  loadBrowsePrefs,
  saveBrowsePrefs,
} from "./browse-prefs";

beforeEach(() => localStorage.clear());

describe("remembering how the list was arranged", () => {
  it("comes back the way it was left", () => {
    saveBrowsePrefs({ sortBy: "digestible", sortAsc: true, dateField: "ingested" });
    expect(loadBrowsePrefs()).toEqual({
      sortBy: "digestible",
      sortAsc: true,
      dateField: "ingested",
    });
  });

  it("starts newest-first by publication date when nothing is stored", () => {
    expect(loadBrowsePrefs()).toEqual(BROWSE_DEFAULTS);
  });
});

describe("refusing to trust what it reads back", () => {
  it("drops a sort key that no longer exists", () => {
    // A key from an older build reaches the sort switch, matches no case, and
    // leaves the list in server order - which reads as sorting being broken
    // rather than as a stale preference.
    localStorage.setItem(
      BROWSE_STORAGE_KEY,
      JSON.stringify({ sortBy: "relevance", sortAsc: true, dateField: "ingested" }),
    );
    const prefs = loadBrowsePrefs();
    expect(prefs.sortBy).toBe(BROWSE_DEFAULTS.sortBy);
    // The fields that ARE valid survive; one bad value is not a reason to
    // discard the rest of the arrangement.
    expect(prefs.dateField).toBe("ingested");
    expect(prefs.sortAsc).toBe(true);
  });

  it("drops a date field that no longer exists", () => {
    localStorage.setItem(
      BROWSE_STORAGE_KEY,
      JSON.stringify({ sortBy: "title", dateField: "acquired" }),
    );
    const prefs = loadBrowsePrefs();
    expect(prefs.dateField).toBe(BROWSE_DEFAULTS.dateField);
    expect(prefs.sortBy).toBe("title");
  });

  it("falls back on anything that is not readable", () => {
    localStorage.setItem(BROWSE_STORAGE_KEY, "{ not json");
    expect(loadBrowsePrefs()).toEqual(BROWSE_DEFAULTS);
    localStorage.setItem(BROWSE_STORAGE_KEY, "null");
    expect(loadBrowsePrefs()).toEqual(BROWSE_DEFAULTS);
    localStorage.setItem(BROWSE_STORAGE_KEY, JSON.stringify({ sortAsc: "yes" }));
    expect(loadBrowsePrefs().sortAsc).toBe(BROWSE_DEFAULTS.sortAsc);
  });
});
