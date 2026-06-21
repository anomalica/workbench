import { assertEquals } from "jsr:@std/assert@1";
import { signedUrl } from "./bunny.ts";

// Canonical vectors computed by operations from Bunny's own reference impl
// (BunnyWay/BunnyCDN.TokenAuthentication), key=test-security-key, expires=1700000000.
const KEY = "test-security-key";
const EXPIRES = 1700000000;

Deno.test("vector A: per-file token, no params", async () => {
  const url = await signedUrl(KEY, "example.b-cdn.net", "/sources/abc123.mp4", EXPIRES);
  assertEquals(
    url,
    "https://example.b-cdn.net/sources/abc123.mp4" +
      "?token=HS256-vrNaCYo9AU7SgjDDaLwIu02JtaLhhuEqjh2YH5Qk8v0&expires=1700000000",
  );
});

Deno.test("vector B: directory-scoped token (token_path)", async () => {
  const url = await signedUrl(KEY, "example.b-cdn.net", "/sources/abc123.mp4", EXPIRES, {
    tokenPath: "/sources/",
  });
  assertEquals(
    url,
    "https://example.b-cdn.net/sources/abc123.mp4" +
      "?token=HS256-rre5WFNlTB-YsG2wW9S-YJma38XW1gWezglByK8NnTg" +
      "&token_path=%2Fsources%2F&expires=1700000000",
  );
});
