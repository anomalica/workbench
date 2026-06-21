/**
 * Stateless crypto for the edge surface (Web Crypto only - runs unchanged on
 * Bunny Edge Scripting / Deno Deploy). There is no server-side session store
 * online, so sessions and gate state live in signed, tamper-proof tokens.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function b64urlDecode(text: string): Uint8Array {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Raw HMAC-SHA256 of msg under secret, as URL-safe base64. */
export async function hmac(secret: string, msg: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(msg));
  return b64urlEncode(new Uint8Array(sig));
}

/** Constant-time string compare (avoids early-exit timing leaks on tokens). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Sign a JSON payload into "<b64url(json)>.<b64url(hmac)>". The payload is
 * readable by the client (it is only signed, not encrypted), so NEVER put a
 * secret answer in it - store a one-way HMAC of the answer instead (see gate.ts).
 */
export async function signToken(secret: string, payload: unknown): Promise<string> {
  const body = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  const sig = await hmac(secret, body);
  return `${body}.${sig}`;
}

/** Verify + decode a signToken token. Returns the payload, or null if tampered. */
export async function verifyToken<T = unknown>(secret: string, token: string): Promise<T | null> {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = await hmac(secret, body);
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    return JSON.parse(decoder.decode(b64urlDecode(body))) as T;
  } catch {
    return null;
  }
}

/** SHA-256 of a string as lowercase hex (for the verification SHA fastpath). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
