import { fetchNameSuggestions, type NameSuggestion } from "$lib/api";

/** Typing a subject's name, with what already exists offered as you go.
 *
 * Shared because the two places that name a subject want identical behaviour and
 * must not drift: renaming a node (where an existing name means merge) and
 * tagging a record (where an existing name means tag THAT subject rather than
 * make a second one with the same name). Both live or die on the reviewer being
 * shown the thing that already exists before they invent a near-duplicate.
 *
 * The behaviour is here; each caller renders its own list, because what a hit
 * MEANS differs - "merges into this" against "tag this" - and a component
 * pretending both are one control would take more props than it saved.
 */
export function subjectSuggest(opts: {
  /** Never offer this node - renaming offers everything except itself. */
  excludeId?: () => string;
  /** A name to treat as "nothing typed yet": the rename box opens pre-filled,
   *  and suggestions for the name already in it are noise. */
  ignore?: () => string;
}) {
  let items = $state<NameSuggestion[]>([]);
  let highlighted = $state(-1);
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Debounced so a fast typist makes one query, not eight. */
  function search(text: string) {
    clearTimeout(timer);
    const q = text.trim();
    if (q.length < 2 || q === (opts.ignore?.() ?? "")) {
      items = [];
      highlighted = -1;
      return;
    }
    timer = setTimeout(async () => {
      items = await fetchNameSuggestions(q, opts.excludeId?.() ?? "");
      highlighted = -1;
    }, 150);
  }

  function clear() {
    clearTimeout(timer);
    items = [];
    highlighted = -1;
  }

  /** Arrow keys move, Enter takes the highlighted one, Escape closes the list
   *  before it closes anything else. Returns true when the key was consumed, so
   *  the caller knows whether to do its own thing with it. */
  function key(e: KeyboardEvent, onpick: (s: NameSuggestion) => void): boolean {
    if (e.key === "Escape" && items.length) {
      clear();
      return true;
    }
    if (!items.length) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      highlighted = (highlighted + 1) % items.length;
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      highlighted = (highlighted - 1 + items.length) % items.length;
      return true;
    }
    if (e.key === "Enter" && highlighted >= 0) {
      e.preventDefault();
      onpick(items[highlighted]);
      return true;
    }
    return false;
  }

  return {
    get items() {
      return items;
    },
    get highlighted() {
      return highlighted;
    },
    set highlighted(i: number) {
      highlighted = i;
    },
    /** The live subject whose name the text matches exactly, if any: what makes
     *  the next action a merge rather than a rename, or a tag onto something
     *  that exists rather than a new one. */
    exact(text: string) {
      const t = text.trim();
      return items.find((s) => s.name === t) ?? null;
    },
    search,
    clear,
    key,
  };
}
