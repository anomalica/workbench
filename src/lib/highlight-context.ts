import type { HighlightContext } from "./transcript-words";

/**
 * Both directions of the highlight-context chain, indexed once.
 *
 * An edge says "`of` needs these earlier highlights to be understood". Readers
 * want it both ways round: what this passage depends on, and what would be
 * stranded if it went. Built as maps rather than scanned per call because the
 * side-list asks for every highlight on the record in one render.
 *
 * ONE HIGHLIGHT CAN CARRY SEVERAL EDGES. `addHighlightContext` merges into the
 * existing edge, so the workbench never authors a duplicate `of` - but the
 * record format is an interchange contract, and the parser emits one entry per
 * `{{highlight-context: ...}}` marker. A hand-edited record, a digester-written
 * one, or a merge that lands two markers for the same highlight is therefore
 * representable and legal. Reading with `.find()` would show the first edge and
 * silently hide the rest: the reviewer sees a chain that looks complete and is
 * not. So these ACCUMULATE across every edge.
 */
export interface ContextIndex {
  /** Everything `id` depends on, first-mentioned order, deduped. */
  needs(id: string): string[];
  /** Everything that depends on `id` - the reverse direction. */
  dependents(id: string): string[];
  /** True if `id` sits on a chain at all, either way round. */
  isChained(id: string): boolean;
}

function push(m: Map<string, string[]>, key: string, value: string) {
  const list = m.get(key);
  if (!list) m.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}

export function buildContextIndex(contexts: HighlightContext[]): ContextIndex {
  const needs = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  for (const edge of contexts) {
    for (const n of edge.needs) {
      // A self-reference says nothing and would render as a passage needing
      // itself. The author guards against creating one; a record that arrives
      // carrying one is simply not shown a meaningless link.
      if (n === edge.of) continue;
      push(needs, edge.of, n);
      push(dependents, n, edge.of);
    }
  }
  return {
    needs: (id) => needs.get(id) ?? [],
    dependents: (id) => dependents.get(id) ?? [],
    isChained: (id) => needs.has(id) || dependents.has(id),
  };
}
