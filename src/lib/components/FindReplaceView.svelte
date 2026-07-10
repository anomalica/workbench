<script lang="ts">
  // Find/replace as its own view over ONE record: the search and replace fields
  // at the top, every occurrence listed below with the change shown inline, and
  // per-occurrence control over what actually gets replaced.
  //
  // The record's annotations (word timestamps, speaker comments) are invisible
  // here - nobody searches for a timestamp - and a replacement steps around
  // them, so it never damages one. See $lib/find-replace.
  import { untrack } from "svelte";
  import {
    buildSearchText,
    findMatches,
    applyReplacements,
    matchContext,
    type Match,
  } from "$lib/find-replace";

  let {
    text,
    seed = "",
    seedSeq = 0,
    onreplace,
    onclose,
  }: {
    /** The record body (no frontmatter), exactly as `onreplace` must return it. */
    text: string;
    /** Query to pre-populate and run - the reviewer's current selection. */
    seed?: string;
    /** Bumped per Ctrl+F so re-seeding the same term re-runs the search. */
    seedSeq?: number;
    onreplace: (newText: string) => void;
    onclose?: () => void;
  } = $props();

  // Typing must never wait on a search of a long record: the input updates on
  // every keystroke, the results catch up once typing pauses.
  const DEBOUNCE_MS = 120;
  // Beyond this the list stops being something a human reads one row at a time.
  const MAX_ROWS = 500;

  let queryInput = $state("");
  let replacementInput = $state("");
  let query = $state("");
  let replacement = $state("");
  let caseSensitive = $state(false);
  // Until the reviewer touches the replace field, a row shows the match
  // highlighted rather than a deletion - an empty replacement is a real,
  // deliberate "delete this", not the starting state.
  let replaceDirty = $state(false);
  let findInput = $state<HTMLInputElement>();

  // Occurrences the reviewer has unticked, keyed by their offset in the search
  // text. Default is everything selected, so "replace the lot" needs no clicks.
  let excluded = $state(new Set<number>());

  $effect(() => {
    const q = queryInput;
    const timer = setTimeout(() => (query = q), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });
  $effect(() => {
    const r = replacementInput;
    const timer = setTimeout(() => (replacement = r), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  // A new search is a new set of occurrences - nothing carries over.
  $effect(() => {
    void query;
    void caseSensitive;
    untrack(() => (excluded = new Set()));
  });

  // Ctrl+F with a word selected: search for it at once, skipping the debounce.
  $effect(() => {
    void seedSeq;
    const s = seed;
    untrack(() => {
      if (!s) return;
      queryInput = s;
      query = s;
      excluded = new Set();
      findInput?.select();
    });
  });

  let searchText = $derived(buildSearchText(text));
  let matches = $derived(findMatches(searchText, query, caseSensitive));
  let rows = $derived(matches.slice(0, MAX_ROWS));
  let selectedMatches = $derived(matches.filter((m) => !excluded.has(m.start)));

  function toggle(m: Match) {
    const next = new Set(excluded);
    if (next.has(m.start)) next.delete(m.start);
    else next.add(m.start);
    excluded = next;
  }
  const selectAll = () => (excluded = new Set());
  const selectNone = () => (excluded = new Set(matches.map((m) => m.start)));

  /** Shift the surviving exclusions to where they land once `replaced` (a
   *  subset of `matches`, in order) has been applied - so the occurrences the
   *  reviewer deliberately skipped stay skipped, and stay ticked off. */
  function shiftExclusions(replaced: Match[], value: string) {
    const doing = new Set(replaced.map((m) => m.start));
    const next = new Set<number>();
    let delta = 0;
    for (const m of matches) {
      if (doing.has(m.start)) delta += value.length - (m.end - m.start);
      else if (excluded.has(m.start)) next.add(m.start + delta);
    }
    excluded = next;
  }

  // Replace with what is IN the box, not the debounced copy the preview draws
  // from: a click landing inside the debounce window would otherwise substitute
  // the previous value - and an empty one silently deletes the match.
  function replaceMatches(chosen: Match[]) {
    if (chosen.length === 0) return;
    const value = replacementInput;
    const next = applyReplacements(text, searchText, chosen, value);
    shiftExclusions(chosen, value);
    onreplace(next);
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onclose?.();
    }
  }

  export function focus() {
    findInput?.focus();
    findInput?.select();
  }
</script>

<div class="flex-1 flex flex-col min-h-0 font-ui bg-surface">
  <!-- Search + replace. No record text above it: this view is the search. -->
  <div class="flex-none px-4 py-3 border-b border-border bg-surface-alt flex flex-col gap-2">
    <div class="flex items-center gap-2">
      <input
        bind:this={findInput}
        bind:value={queryInput}
        onkeydown={onKey}
        type="text"
        placeholder="Find in this record"
        spellcheck="false"
        class="flex-1 min-w-0 text-sm bg-surface border border-border rounded px-2 py-1.5
          text-on-surface outline-none focus:border-primary placeholder:text-on-surface-muted/60"
      />
      <span class="text-xs text-on-surface-secondary tabular-nums flex-none w-24 text-right">
        {#if query}{matches.length} {matches.length === 1 ? "match" : "matches"}{/if}
      </span>
      <label
        class="flex items-center gap-1 text-xs text-on-surface-secondary cursor-pointer select-none flex-none"
        title="Match case"
      >
        <input type="checkbox" bind:checked={caseSensitive} class="accent-primary" />Aa
      </label>
      <button
        onclick={() => onclose?.()}
        class="px-1.5 py-1 rounded cursor-pointer text-on-surface-muted hover:bg-surface flex-none"
        title="Close (Esc)"
        aria-label="Close">&#x2715;</button
      >
    </div>
    <input
      bind:value={replacementInput}
      oninput={() => (replaceDirty = true)}
      onkeydown={onKey}
      type="text"
      placeholder="Replace with"
      spellcheck="false"
      class="w-full text-sm bg-surface border border-border rounded px-2 py-1.5
        text-on-surface outline-none focus:border-primary placeholder:text-on-surface-muted/60"
    />
  </div>

  <!-- Occurrences, each showing exactly what would change. -->
  <div class="flex-1 overflow-auto min-h-0">
    {#if !query}
      <p class="text-sm text-on-surface-muted px-4 py-3">
        Type to find every occurrence in this record. Select a word in the transcript and press
        Ctrl+F to search for it.
      </p>
    {:else if matches.length === 0}
      <p class="text-sm text-on-surface-muted px-4 py-3">No matches.</p>
    {:else}
      {#each rows as m (m.start)}
        {@const ctx = matchContext(searchText, m)}
        {@const on = !excluded.has(m.start)}
        <div
          class="flex items-start gap-3 px-4 py-2 border-b border-border/40 transition-colors
            {on ? 'hover:bg-surface-alt/40' : 'opacity-50 hover:bg-surface-alt/20'}"
        >
          <input
            type="checkbox"
            checked={on}
            onchange={() => toggle(m)}
            class="mt-1 flex-none accent-primary cursor-pointer"
            title={on ? "Skip this occurrence" : "Include this occurrence"}
            aria-label="Include this occurrence"
          />
          <p class="flex-1 min-w-0 text-sm leading-relaxed text-on-surface whitespace-pre-wrap break-words">
            <!-- No horizontal padding on the del/ins: their backgrounds must
                 show the matched and replacement text's exact whitespace. -->
            {#if ctx.clippedBefore}<span class="text-on-surface-muted">…</span>{/if}{ctx.before}{#if replaceDirty}<del
                class="bg-error-container text-on-error-container rounded-sm line-through decoration-1"
                >{ctx.matched}</del
              >{#if replacement}<ins
                  class="bg-success-container text-on-success-container rounded-sm no-underline font-medium"
                  >{replacement}</ins
                >{/if}{:else}<mark class="bg-warning-container text-on-warning-container rounded-sm"
                >{ctx.matched}</mark
              >{/if}{ctx.after}{#if ctx.clippedAfter}<span class="text-on-surface-muted">…</span>{/if}
          </p>
          <button
            onclick={() => replaceMatches([m])}
            disabled={!replaceDirty}
            class="flex-none text-xs font-medium px-2 py-1 rounded cursor-pointer text-primary
              hover:bg-primary-container/30 disabled:opacity-40 disabled:cursor-not-allowed"
            title="Replace just this occurrence"
          >
            Replace
          </button>
        </div>
      {/each}
      {#if matches.length > rows.length}
        <p class="text-xs text-on-surface-muted px-4 py-3">
          Showing the first {MAX_ROWS} of {matches.length} occurrences. The rest are still selected
          and will be replaced - narrow the search to review them individually.
        </p>
      {/if}
    {/if}
  </div>

  <!-- Execute. -->
  {#if query && matches.length > 0}
    <div class="flex-none px-4 py-3 border-t border-border bg-surface-alt flex items-center gap-3">
      <button onclick={selectAll} class="text-xs text-primary hover:underline cursor-pointer"
        >Select all</button
      >
      <button onclick={selectNone} class="text-xs text-primary hover:underline cursor-pointer"
        >Select none</button
      >
      <span class="text-xs text-on-surface-muted tabular-nums ml-auto">
        {selectedMatches.length} of {matches.length} selected
      </span>
      <button
        onclick={() => replaceMatches(selectedMatches)}
        disabled={!replaceDirty || selectedMatches.length === 0}
        class="text-sm px-3 py-1.5 rounded cursor-pointer bg-primary text-on-primary
          hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed"
      >
        Replace selected
      </button>
    </div>
  {/if}
</div>
