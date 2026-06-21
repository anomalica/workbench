import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  needed,
  normaliseWord,
  scoreSession,
  startSession,
  VERIFICATION_SESSION_TTL_SECONDS,
} from "./gate.ts";

const SECRET = "gate-secret";
const HASH = "a".repeat(64);

// 10 challenges so a full session matches the production size.
const POOL = Array.from({ length: 10 }, (_, i) => ({
  before: `before ${i}`,
  after: `after ${i}`,
  answer: `word${i}`,
}));

Deno.test("normaliseWord strips surrounding punctuation/quotes + lowercases", () => {
  assertEquals(normaliseWord("  “Hello!” "), "hello");
  assertEquals(normaliseWord("(World),"), "world");
  assertEquals(normaliseWord("don't"), "don't"); // inner apostrophe kept
  assertEquals(normaliseWord("...UFO?!"), "ufo");
  assertEquals(normaliseWord(""), "");
});

Deno.test("needed = ceil(0.8 * n)", () => {
  assertEquals(needed(10), 8);
  assertEquals(needed(5), 4);
  assertEquals(needed(3), 3);
});

Deno.test("start session never leaks answers to the client", async () => {
  const s = await startSession(SECRET, HASH, POOL, 1000);
  assertEquals(s.challenges.length, 10);
  assertEquals(s.minCorrectToPass, 8);
  const blob = JSON.stringify(s);
  for (const c of POOL) assert(!blob.includes(c.answer), `leaked ${c.answer}`);
});

Deno.test("all-correct passes, with case/punctuation tolerance", async () => {
  const s = await startSession(SECRET, HASH, POOL, 1000);
  const responses: Record<string, string> = {};
  POOL.forEach((c, i) => {
    responses[String(i + 1)] = `  ${c.answer.toUpperCase()}! `;
  });
  const r = await scoreSession(SECRET, HASH, s.token, responses, 1000);
  assert(r.ok && r.passed && r.score === 10 && r.needed === 8);
});

Deno.test("8/10 passes, 7/10 fails (the 80% boundary)", async () => {
  const s = await startSession(SECRET, HASH, POOL, 1000);
  const mk = (n: number) => {
    const r: Record<string, string> = {};
    POOL.forEach((c, i) => {
      r[String(i + 1)] = i < n ? c.answer : "wrong";
    });
    return r;
  };
  const eight = await scoreSession(SECRET, HASH, s.token, mk(8), 1000);
  assert(eight.ok && eight.passed && eight.score === 8);
  const seven = await scoreSession(SECRET, HASH, s.token, mk(7), 1000);
  assert(seven.ok && !seven.passed && seven.score === 7);
});

Deno.test("expired session rejected", async () => {
  const s = await startSession(SECRET, HASH, POOL, 1000);
  const later = 1000 + VERIFICATION_SESSION_TTL_SECONDS + 1;
  const r = await scoreSession(SECRET, HASH, s.token, {}, later);
  assert(!r.ok && r.reason === "expired");
});

Deno.test("session bound to its record hash", async () => {
  const s = await startSession(SECRET, HASH, POOL, 1000);
  const r = await scoreSession(SECRET, "b".repeat(64), s.token, {}, 1000);
  assert(!r.ok && r.reason === "wrong_record");
});

Deno.test("answer HMACs are salted per record (no cross-record dictionary)", async () => {
  const a = await startSession(SECRET, "a".repeat(64), POOL, 1000);
  const b = await startSession(SECRET, "b".repeat(64), POOL, 1000);
  const hmacsOf = (token: string) =>
    (
      JSON.parse(atob(token.split(".")[0].replaceAll("-", "+").replaceAll("_", "/"))) as {
        a: string[];
      }
    ).a;
  // same answers, different record hash -> disjoint HMAC sets
  const setA = new Set(hmacsOf(a.token));
  assert(
    hmacsOf(b.token).every((h) => !setA.has(h)),
    "HMACs reused across records",
  );
});

Deno.test("tampered token rejected", async () => {
  const s = await startSession(SECRET, HASH, POOL, 1000);
  const r = await scoreSession(SECRET, HASH, s.token + "x", {}, 1000);
  assert(!r.ok && r.reason === "invalid");
});
