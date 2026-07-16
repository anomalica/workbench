import { assertEquals } from "jsr:@std/assert@1";
import { atLeast, parseRoles, roleOf } from "./roles.ts";

// This parser decides who may write to live data, so its failure mode matters as
// much as its happy path: anything it can't read cleanly must grant NOTHING.

Deno.test("parseRoles: reads a flat login: role map", () => {
  assertEquals(parseRoles("markhedleyjones: admin\nrev: reviewer\n"), {
    markhedleyjones: "admin",
    rev: "reviewer",
  });
});

Deno.test("parseRoles: ignores comments and blank lines", () => {
  const text =
    "# Contribution roles.\n# Roles: contributor < reviewer < editor < admin.\n\nrev: editor\n";
  assertEquals(parseRoles(text), { rev: "editor" });
});

Deno.test("parseRoles: lowercases logins (GitHub logins are case-insensitive)", () => {
  assertEquals(parseRoles("MarkHedleyJones: admin\n"), {
    markhedleyjones: "admin",
  });
});

Deno.test("parseRoles: tolerates quoted values", () => {
  assertEquals(parseRoles('rev: "reviewer"\n'), { rev: "reviewer" });
});

Deno.test("parseRoles: an UNKNOWN role grants nothing (not a partial match)", () => {
  assertEquals(parseRoles("sneaky: superuser\nrev: reviewer\n"), {
    rev: "reviewer",
  });
});

Deno.test("parseRoles: malformed lines are dropped, not guessed at", () => {
  const text = "nested:\n  role: admin\njust-a-login\n: admin\nrev: reviewer\n";
  assertEquals(parseRoles(text), { rev: "reviewer" });
});

Deno.test("parseRoles: empty/garbage input yields an empty map (fail closed)", () => {
  assertEquals(parseRoles(""), {});
  assertEquals(parseRoles("<<<not yaml>>>"), {});
});

Deno.test("roleOf: unlisted and anonymous default to contributor", () => {
  const roles = parseRoles("rev: reviewer\n");
  assertEquals(roleOf("rev", roles), "reviewer");
  assertEquals(roleOf("REV", roles), "reviewer");
  assertEquals(roleOf("randomer", roles), "contributor");
  assertEquals(roleOf(undefined, roles), "contributor");
  assertEquals(roleOf("rev", {}), "contributor");
});

Deno.test("atLeast: the hierarchy is cumulative", () => {
  assertEquals(atLeast("admin", "reviewer"), true);
  assertEquals(atLeast("editor", "reviewer"), true);
  assertEquals(atLeast("reviewer", "reviewer"), true);
  assertEquals(atLeast("contributor", "reviewer"), false);
  assertEquals(atLeast("reviewer", "editor"), false);
  assertEquals(atLeast("editor", "admin"), false);
  assertEquals(atLeast("admin", "admin"), true);
});
