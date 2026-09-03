/** What a merge's survivor should be called, offered to the reviewer.
 *
 * A NODE ID is not a name, and most of the proposals in the queue suggest one:
 * the manual passes wrote the survivor's id into `suggested_canonical`. Taken at
 * face value the workbench offered it AND pre-selected it, so working through
 * the queue would have named survivors after uuids - and a node's name is the
 * page title and its web address.
 *
 * So an id is resolved to the member it names. If it names no member the
 * heaviest member's name stands in, because a suggestion is a convenience and
 * must never be a name nobody would choose.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type CanonicalMember = { id: string; name: string; claims?: number | null };

export function suggestedCanonical(
  suggested: string | null | undefined,
  members: CanonicalMember[],
): string {
  const raw = (suggested ?? "").trim();
  if (raw && !UUID.test(raw)) return raw;
  const named = members.find((m) => m.id === raw);
  if (named) return named.name;
  const heaviest = [...members].sort((a, b) => (b.claims ?? 0) - (a.claims ?? 0))[0];
  return heaviest?.name ?? "";
}
