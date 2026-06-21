/**
 * Bunny CDN Token Authentication (signed expiring URLs) for gated originals.
 * Implements the CURRENT maintained reference algorithm
 * (BunnyWay/BunnyCDN.TokenAuthentication): HMAC-SHA256 keyed with the Pull
 * Zone's URL-Token-Authentication key, base64url (no pad), prefixed "HS256-".
 * NOT the older plain-MD5/SHA256 scheme some docs still describe.
 *
 * The gate calls signedUrl() AFTER a passed possession check and returns the URL
 * to the client, which fetches the original straight from the CDN. The security
 * key lives in the Edge env only and never reaches the client.
 *
 * Verified against operations' canonical vectors (see bunny_test.ts).
 */

import { hmac } from "./crypto.ts";

export interface SignOptions {
  /** Scope the token to a directory (the client may then fetch any file under
   *  it). Omit to scope to exactly `pathname` - tighter, the gate default. */
  tokenPath?: string;
  /** Bind the token to a client IP (added to both the signature and the URL). */
  userIp?: string;
  /** Extra Bunny query params to sign (e.g. limit/speed). Raw values. */
  params?: Record<string, string>;
  /** Override the URL scheme (default https). */
  scheme?: string;
}

/**
 * Build a signed, expiring Bunny Pull-Zone URL.
 * @param securityKey  the Pull Zone "URL Token Authentication Key" (Edge env)
 * @param host         the Pull Zone hostname, e.g. "example.b-cdn.net"
 * @param pathname     the file path WITH leading slash, raw (not URL-encoded)
 * @param expiresUnix  absolute expiry as a Unix timestamp (seconds)
 */
export async function signedUrl(
  securityKey: string,
  host: string,
  pathname: string,
  expiresUnix: number,
  opts: SignOptions = {},
): Promise<string> {
  const signaturePath = opts.tokenPath ?? pathname;

  // signingData: all signed params, sorted by key, "k=v" joined with "&", RAW
  // values. token_path participates as a param when scoping a directory.
  const signParams: Record<string, string> = { ...(opts.params ?? {}) };
  if (opts.tokenPath) signParams.token_path = opts.tokenPath;
  const signingData = Object.keys(signParams)
    .sort()
    .map((k) => `${k}=${signParams[k]}`)
    .join("&");

  const userIp = opts.userIp ?? "";
  const message = `${signaturePath}${expiresUnix}${signingData}${userIp}`;
  const token = `HS256-${await hmac(securityKey, message)}`;

  // The URL query (url_data) uses URL-ENCODED values - computed separately from
  // the (raw) signingData above. Order: token, extra params, token_path, expires.
  const scheme = opts.scheme ?? "https";
  const parts = [`token=${token}`];
  for (const k of Object.keys(opts.params ?? {}).sort()) {
    parts.push(`${k}=${encodeURIComponent((opts.params ?? {})[k])}`);
  }
  if (opts.tokenPath) parts.push(`token_path=${encodeURIComponent(opts.tokenPath)}`);
  if (userIp) parts.push(`ip=${encodeURIComponent(userIp)}`);
  parts.push(`expires=${expiresUnix}`);
  return `${scheme}://${host}${pathname}?${parts.join("&")}`;
}
