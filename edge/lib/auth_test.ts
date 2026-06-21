import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  type AuthConfig,
  clearSessionCookie,
  exchangeCode,
  loginRedirectUrl,
  makeSessionCookie,
  readSession,
  verifyState,
} from "./auth.ts";

const CFG: AuthConfig = {
  clientId: "cid",
  clientSecret: "csecret",
  publicUrl: "https://workbench.example.is",
  sessionSecret: "super-secret",
};

Deno.test("login URL carries client_id, callback, scope, signed state", async () => {
  const url = new URL(await loginRedirectUrl(CFG, 1000));
  assertEquals(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  assertEquals(url.searchParams.get("client_id"), "cid");
  assertEquals(
    url.searchParams.get("redirect_uri"),
    "https://workbench.example.is/api/auth/callback",
  );
  assert(url.searchParams.get("scope")?.includes("user:email"));
  assert(await verifyState(CFG, url.searchParams.get("state"), 1000));
});

Deno.test("state is rejected when stale or forged", async () => {
  const url = new URL(await loginRedirectUrl(CFG, 1000));
  const state = url.searchParams.get("state");
  assert(!(await verifyState(CFG, state, 1000 + 601)), "stale");
  assert(!(await verifyState(CFG, "forged.token", 1000)), "forged");
  assert(!(await verifyState(CFG, null, 1000)), "absent");
});

Deno.test("session cookie round-trips and expires", async () => {
  const user = {
    name: "Reviewer",
    email: "r@x.com",
    login: "rev",
    avatar_url: "http://a",
  };
  const setCookie = await makeSessionCookie(CFG, user, 1000);
  assert(setCookie.includes("HttpOnly") && setCookie.includes("SameSite=Lax"));
  const token = setCookie.split(";")[0]; // wb_session=...
  assertEquals(await readSession(CFG, token, 1000), user);
  // far in the future -> expired
  assertEquals(await readSession(CFG, token, 1000 + 60 * 60 * 24 * 31), null);
  // wrong secret -> rejected
  assertEquals(await readSession({ ...CFG, sessionSecret: "other" }, token, 1000), null);
});

Deno.test("no/garbage cookie -> no session", async () => {
  assertEquals(await readSession(CFG, null, 1000), null);
  assertEquals(await readSession(CFG, "other=1; junk", 1000), null);
});

Deno.test("clearSessionCookie expires the cookie", () => {
  assert(clearSessionCookie().includes("Max-Age=0"));
});

Deno.test("exchangeCode pulls profile + primary email (mocked GitHub)", async () => {
  const fetchImpl = (url: string, _init?: RequestInit): Promise<Response> => {
    if (url.endsWith("/access_token")) {
      return Promise.resolve(new Response(JSON.stringify({ access_token: "gho_x" })));
    }
    if (url.endsWith("/user")) {
      return Promise.resolve(
        new Response(JSON.stringify({ login: "rev", name: "Rev", avatar_url: "http://a" })),
      );
    }
    if (url.endsWith("/user/emails")) {
      return Promise.resolve(
        new Response(
          JSON.stringify([
            { email: "secondary@x.com", primary: false },
            { email: "primary@x.com", primary: true },
          ]),
        ),
      );
    }
    throw new Error("unexpected " + url);
  };
  const user = await exchangeCode(CFG, "code123", fetchImpl);
  assertEquals(user, {
    name: "Rev",
    email: "primary@x.com",
    login: "rev",
    avatar_url: "http://a",
  });
});
