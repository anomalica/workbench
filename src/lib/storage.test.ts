import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeLocalSet } from "./storage";

/**
 * A localStorage stand-in with a byte budget, so we can exercise the real
 * QuotaExceededError path that jsdom's quota-less localStorage never triggers.
 */
function makeQuotaStorage(budget: number): Storage {
  const map = new Map<string, string>();
  let used = 0;
  const sizeOf = (k: string, v: string) => k.length + v.length;
  return {
    get length() {
      return map.size;
    },
    key(i: number) {
      return [...map.keys()][i] ?? null;
    },
    getItem(k: string) {
      return map.has(k) ? (map.get(k) as string) : null;
    },
    setItem(k: string, v: string) {
      const prev = map.has(k) ? sizeOf(k, map.get(k) as string) : 0;
      if (used - prev + sizeOf(k, v) > budget) {
        const e = new Error("quota") as Error & { name: string };
        e.name = "QuotaExceededError";
        throw e;
      }
      used = used - prev + sizeOf(k, v);
      map.set(k, v);
    },
    removeItem(k: string) {
      if (map.has(k)) {
        used -= sizeOf(k, map.get(k) as string);
        map.delete(k);
      }
    },
    clear() {
      map.clear();
      used = 0;
    },
  } as Storage;
}

describe("safeLocalSet", () => {
  let original: Storage;
  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", { value: original, configurable: true });
  });
  beforeEach(() => {
    original = globalThis.localStorage;
  });

  function install(s: Storage) {
    Object.defineProperty(globalThis, "localStorage", { value: s, configurable: true });
  }

  it("persists a value when there is room", () => {
    install(makeQuotaStorage(1000));
    expect(safeLocalSet("workbench:observed:a", "[[0,5]]")).toBe(true);
    expect(localStorage.getItem("workbench:observed:a")).toBe("[[0,5]]");
  });

  it("never throws and returns false when the store is full and nothing is evictable", () => {
    const s = makeQuotaStorage(40);
    install(s);
    // Fill with a protected key that we must not evict.
    localStorage.setItem("workbench:doc:x", "12345678901234567890");
    let result: boolean | undefined;
    expect(() => {
      result = safeLocalSet("workbench:observed:b", "12345678901234567890extra");
    }).not.toThrow();
    expect(result).toBe(false);
    expect(localStorage.getItem("workbench:doc:x")).not.toBeNull(); // protected, retained
  });

  it("evicts reconstructible keys and retries on quota", () => {
    install(makeQuotaStorage(80));
    localStorage.setItem("workbench:observed:old", "0123456789"); // reconstructible, 32 bytes
    localStorage.setItem("workbench:doc:keep", "abcdefghij"); // protected, 28 bytes -> used 60
    // The new write (42 bytes) does not fit beside both, but does once the old
    // observed draft is evicted.
    const ok = safeLocalSet("workbench:observed:new", "01234567890123456789");
    expect(ok).toBe(true);
    expect(localStorage.getItem("workbench:observed:new")).not.toBeNull();
    expect(localStorage.getItem("workbench:observed:old")).toBeNull(); // evicted
    expect(localStorage.getItem("workbench:doc:keep")).not.toBeNull(); // protected
  });

  it("never evicts unsaved doc/notes drafts", () => {
    install(makeQuotaStorage(110));
    localStorage.setItem("workbench:doc:a", "1234567890"); // unsaved body edit, 25 bytes
    localStorage.setItem("workbench:notes:b", "1234567890"); // unsaved notes, 27 bytes
    localStorage.setItem("workbench:lastseg:c", "1234567890"); // pure UI state, 29 bytes -> used 81
    const ok = safeLocalSet("workbench:observed:d", "123456789012345678901234567890"); // 50 bytes
    expect(ok).toBe(true);
    expect(localStorage.getItem("workbench:doc:a")).not.toBeNull();
    expect(localStorage.getItem("workbench:notes:b")).not.toBeNull();
    expect(localStorage.getItem("workbench:lastseg:c")).toBeNull(); // evicted to make room
  });
});
