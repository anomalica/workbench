import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  b64urlDecode,
  b64urlEncode,
  hmac,
  sha256Hex,
  signToken,
  timingSafeEqual,
  verifyToken,
} from "./crypto.ts";

Deno.test("b64url round-trips arbitrary bytes (no +,/,= in output)", () => {
  const bytes = new Uint8Array([0, 1, 2, 251, 252, 253, 254, 255, 62, 63]);
  const enc = b64urlEncode(bytes);
  assert(!/[+/=]/.test(enc), "url-safe alphabet only");
  assertEquals([...b64urlDecode(enc)], [...bytes]);
});

Deno.test("hmac is deterministic and key-sensitive", async () => {
  const a = await hmac("secret", "message");
  assertEquals(a, await hmac("secret", "message"));
  assert(a !== (await hmac("other", "message")));
  assert(a !== (await hmac("secret", "message2")));
});

Deno.test("signToken/verifyToken round-trips and rejects tampering", async () => {
  const secret = "edge-session-secret";
  const token = await signToken(secret, { user: "bob", role: "reviewer" });
  assertEquals(await verifyToken(secret, token), { user: "bob", role: "reviewer" });

  // wrong secret rejected
  assertEquals(await verifyToken("nope", token), null);
  // tampered body rejected (flip a char in the payload segment)
  const [body, sig] = token.split(".");
  const bad = `${body.slice(0, -1)}${body.at(-1) === "A" ? "B" : "A"}.${sig}`;
  assertEquals(await verifyToken(secret, bad), null);
  // missing signature rejected
  assertEquals(await verifyToken(secret, body), null);
});

Deno.test("timingSafeEqual basic correctness", () => {
  assert(timingSafeEqual("abc", "abc"));
  assert(!timingSafeEqual("abc", "abd"));
  assert(!timingSafeEqual("abc", "abcd"));
});

Deno.test("sha256Hex matches a known vector", async () => {
  // echo -n "" | sha256sum
  assertEquals(
    await sha256Hex(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  // echo -n "abc" | sha256sum
  assertEquals(
    await sha256Hex("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});
