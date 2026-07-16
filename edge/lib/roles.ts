/**
 * Contribution roles at the edge - the production write gate.
 *
 * The workbench's Python backend has its own copy of this model
 * (`backend/roles.py`), but production does NOT run that backend: it runs this
 * edge. Until this existed, every write route here gated on "is there a session"
 * alone, so ANY GitHub login could commit to the live ingests repo. This closes
 * that.
 *
 * `roles.yaml` lives at the ingests repo root and maps a GitHub login to a role.
 * Anyone authenticated but unlisted is a `contributor` - the safe default - so a
 * new login can never write. Absent or malformed, EVERYONE is a contributor
 * (fail closed: a missing role file must not grant access).
 *
 *     # ingests/roles.yaml
 *     markhedleyjones: admin
 *     somereviewer: reviewer
 *
 * Roles are ordered contributor < reviewer < editor < admin (cumulative), and
 * must stay in step with backend/roles.py:
 * - contributor: propose only; no writes here.
 * - reviewer: + record writes, curation decisions.
 * - editor: + the higher-impact ops (archive, article directives).
 * - admin: + role management.
 */

export const ROLES = ["contributor", "reviewer", "editor", "admin"] as const;
export type Role = (typeof ROLES)[number];
export const DEFAULT_ROLE: Role = "contributor";

/**
 * Parse `roles.yaml`. Deliberately a small line parser rather than a YAML
 * dependency: the file is a flat `login: role` map with `#` comments, and the
 * gate must not inherit a parser's surprises. Anything that isn't a clean
 * `login: knownRole` line is ignored, so a malformed entry silently grants
 * nothing instead of throwing the gate open.
 */
export function parseRoles(text: string): Record<string, Role> {
  const out: Record<string, Role> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (!line || line.trimStart().startsWith("#")) continue;
    // INDENTED lines belong to some nested structure, not the top-level
    // login->role map. Trimming first would read `nested:\n  role: admin` as a
    // login literally called "role" with admin - so only column-0 keys count.
    if (/^\s/.test(line)) continue;
    const m = line.match(/^([A-Za-z0-9-_]+)\s*:\s*"?([a-z]+)"?\s*$/);
    if (!m) continue;
    const [, login, role] = m;
    if ((ROLES as readonly string[]).includes(role)) {
      out[login.toLowerCase()] = role as Role;
    }
  }
  return out;
}

/** A login's role, defaulting to contributor when unlisted. */
export function roleOf(login: string | undefined, roles: Record<string, Role>): Role {
  if (!login) return DEFAULT_ROLE;
  return roles[login.toLowerCase()] ?? DEFAULT_ROLE;
}

/** True when `role` ranks at or above `minimum`. Unknown roles rank lowest. */
export function atLeast(role: Role, minimum: Role): boolean {
  const rank = ROLES.indexOf(role);
  const floor = ROLES.indexOf(minimum);
  return rank >= 0 && floor >= 0 && rank >= floor;
}
