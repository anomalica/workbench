/**
 * Possession gate (cloze-v1), stateless edition. The local FastAPI keeps the
 * sampled challenges (with answers) in server memory; the edge has no shared
 * memory across invocations, so the session lives in a SIGNED token carrying a
 * one-way HMAC of each answer - the answers themselves never reach the client
 * and cannot be recovered from the token. Scoring recomputes the HMAC of the
 * reviewer's response and compares. Mirrors backend/server.py exactly:
 * 10 challenges/session, pass at 80%, pool >= 5 to gate, 30-min TTL.
 */

import { hmac, signToken, verifyToken } from "./crypto.ts";

export const CHALLENGES_PER_SESSION = 10;
export const PASS_RATIO = 0.8;
export const MIN_POOL_FOR_CLOZE_GATE = 5;
export const VERIFICATION_SESSION_TTL_SECONDS = 1800;

// whitespace + string.punctuation + the curly quotes, matching backend _normalise_word.
const STRIP = new Set(" \t\n\r\f\v!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~“”‘’\"'".split(""));

/** Strip surrounding punctuation/quotes and lowercase (== backend normalise). */
export function normaliseWord(word: string): string {
  let start = 0;
  let end = word.length;
  while (start < end && STRIP.has(word[start])) start++;
  while (end > start && STRIP.has(word[end - 1])) end--;
  return word.slice(start, end).toLowerCase();
}

export function needed(n: number): number {
  return Math.ceil(PASS_RATIO * n);
}

interface Challenge {
  before: string;
  after: string;
  answer: string;
}

interface SessionPayload {
  h: string; // record hash this session is bound to
  t: number; // created (unix seconds)
  a: string[]; // per-challenge HMAC of the normalised answer
}

// Salt the HMAC with the record hash so a common answer word hashes differently
// per record - an attacker who passes one gate and reads its token can't build a
// cross-record word->HMAC dictionary. The gate is the copyright boundary.
async function answerHmac(secret: string, hash: string, answer: string): Promise<string> {
  return await hmac(secret, `gate:${hash}:${answer}`);
}

export interface StartedSession {
  token: string;
  challenges: { id: number; before: string; after: string }[];
  minCorrectToPass: number;
}

/** Build a signed gate session from a sampled set of challenges. */
export async function startSession(
  secret: string,
  hash: string,
  sample: Challenge[],
  nowSec: number,
): Promise<StartedSession> {
  const a = await Promise.all(sample.map((c) => answerHmac(secret, hash, c.answer)));
  const token = await signToken(secret, { h: hash, t: nowSec, a } as SessionPayload);
  return {
    token,
    challenges: sample.map((c, i) => ({ id: i + 1, before: c.before, after: c.after })),
    minCorrectToPass: needed(sample.length),
  };
}

export type ScoreResult =
  | { ok: false; reason: "invalid" | "expired" | "wrong_record" }
  | { ok: true; passed: boolean; score: number; needed: number };

/** Score a submission against a signed session token. Fully stateless. */
export async function scoreSession(
  secret: string,
  hash: string,
  token: string,
  responses: Record<string, string>,
  nowSec: number,
): Promise<ScoreResult> {
  const payload = await verifyToken<SessionPayload>(secret, token);
  if (!payload || !Array.isArray(payload.a)) return { ok: false, reason: "invalid" };
  if (payload.h !== hash) return { ok: false, reason: "wrong_record" };
  if (nowSec - payload.t > VERIFICATION_SESSION_TTL_SECONDS) {
    return { ok: false, reason: "expired" };
  }
  let score = 0;
  for (let i = 0; i < payload.a.length; i++) {
    const given = normaliseWord(String(responses[String(i + 1)] ?? ""));
    if (given && (await answerHmac(secret, hash, given)) === payload.a[i]) score++;
  }
  const need = needed(payload.a.length);
  return { ok: true, passed: score >= need, score, needed: need };
}
