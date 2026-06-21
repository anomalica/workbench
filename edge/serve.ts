/**
 * The deployed entry for Bunny Edge Scripting (and `deno task dev`). Bunny's
 * runtime loads this module and routes requests to the handler registered via a
 * top-level Deno.serve - it does NOT run the module as `main`, so the handler
 * must register unconditionally at load (not behind `import.meta.main`, which is
 * false on Bunny and in tests). main.ts stays import-safe (no serve) so the test
 * suite can import handleRequest without binding a server.
 *
 * Bundle THIS file (deno bundle serve.ts) for deployment.
 */

import { buildDeps, handleRequest, loadEnv } from "./main.ts";

const env = loadEnv();
const deps = buildDeps(env);

Deno.serve((req) => handleRequest(req, env, deps));
