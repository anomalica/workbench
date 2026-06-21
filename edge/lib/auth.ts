/**
 * GitHub OAuth for the edge - stateless. The local FastAPI uses Starlette
 * SessionMiddleware (a signed cookie); the edge has no middleware, so the
 * session is a signed token (crypto.ts signToken) in a cookie, verified per
 * request. Same user shape as backend/auth.py: {name, email, login, avatar_url}.
 *
 * The OAuth `state` is itself a short-lived signed token (CSRF protection): the
 * edge has no server memory to stash a nonce, so it signs the state and verifies
 * it on callback.
 */

import { signToken, verifyToken } from "./crypto.ts";

const GH_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GH_TOKEN = "https://github.com/login/oauth/access_token";
const GH_API = "https://api.github.com";

const SESSION_COOKIE = "wb_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days, matching backend/auth.py
const STATE_MAX_AGE = 60 * 10; // 10 min to complete the OAuth round-trip

export interface User {
  name: string;
  email: string;
  login: string;
  avatar_url: string;
}

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  publicUrl: string;
  sessionSecret: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Build the GitHub authorise redirect URL with a signed CSRF state token. */
export async function loginRedirectUrl(cfg: AuthConfig, nowSec: number): Promise<string> {
  const state = await signToken(cfg.sessionSecret, { k: "oauth", t: nowSec });
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: `${cfg.publicUrl}/api/auth/callback`,
    scope: "read:user user:email",
    state,
  });
  return `${GH_AUTHORIZE}?${params}`;
}

export async function verifyState(
  cfg: AuthConfig,
  state: string | null,
  nowSec: number,
): Promise<boolean> {
  if (!state) return false;
  const p = await verifyToken<{ k: string; t: number }>(cfg.sessionSecret, state);
  return !!p && p.k === "oauth" && nowSec - p.t <= STATE_MAX_AGE;
}

/** Exchange an OAuth code for the user profile (token never leaves the edge). */
export async function exchangeCode(
  cfg: AuthConfig,
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<User> {
  const tokenRes = await fetchImpl(GH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: `${cfg.publicUrl}/api/auth/callback`,
    }),
  });
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) throw new Error("OAuth token exchange failed");

  const ghHeaders = {
    Authorization: `Bearer ${token.access_token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "anomalica-workbench-edge",
  };
  const profile = (await (await fetchImpl(`${GH_API}/user`, { headers: ghHeaders })).json()) as {
    name?: string;
    login?: string;
    email?: string;
    avatar_url?: string;
  };

  let email = profile.email ?? "";
  if (!email) {
    const emails = (await (
      await fetchImpl(`${GH_API}/user/emails`, { headers: ghHeaders })
    ).json()) as { email: string; primary: boolean }[];
    email = emails.find((e) => e.primary)?.email ?? "";
  }
  return {
    name: profile.name || profile.login || "",
    email,
    login: profile.login || "",
    avatar_url: profile.avatar_url || "",
  };
}

export async function makeSessionCookie(
  cfg: AuthConfig,
  user: User,
  nowSec: number,
): Promise<string> {
  const token = await signToken(cfg.sessionSecret, { user, iat: nowSec });
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

/** Read + verify the session from a request's Cookie header. */
export async function readSession(
  cfg: AuthConfig,
  cookieHeader: string | null,
  nowSec: number,
): Promise<User | null> {
  const token = cookieValue(cookieHeader, SESSION_COOKIE);
  if (!token) return null;
  const payload = await verifyToken<{ user: User; iat: number }>(cfg.sessionSecret, token);
  if (!payload || nowSec - payload.iat > SESSION_MAX_AGE) return null;
  return payload.user;
}
