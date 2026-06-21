/**
 * The deployed entry for Bunny Edge Scripting. Bunny's runtime routes requests
 * to the handler registered via BunnySDK.net.http.serve - NOT a raw Deno.serve
 * (which Bunny does not pick up, so requests fall through to a Bunny 400). The
 * SDK also emulates the Bunny runtime locally for `deno task dev`.
 *
 * Env is read LAZILY on the first request, not at module load: Deno.env access
 * is a per-request capability on the edge, so reading it at import time can throw
 * and take the whole script down. main.ts stays import-safe (no serve) so the
 * test suite imports handleRequest without binding a server.
 *
 * Bundle THIS file (deno bundle serve.ts) for deployment.
 */

import * as BunnySDK from "@bunny.net/edgescript-sdk";
import { buildDeps, type Deps, type Env, handleRequest, loadEnv } from "./main.ts";

let ctx: { env: Env; deps: Deps } | null = null;
function context() {
  if (!ctx) {
    const env = loadEnv();
    ctx = { env, deps: buildDeps(env) };
  }
  return ctx;
}

BunnySDK.net.http.serve(async (req: Request): Promise<Response> => {
  const { env, deps } = context();
  return await handleRequest(req, env, deps);
});
