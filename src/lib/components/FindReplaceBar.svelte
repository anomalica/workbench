<script lang="ts">
  // In-editor find/replace for ONE record, shown as a split-view panel under
  // the editor: literal search (match-case optional), and a list of every
  // matching line with the term highlighted so all matches are visible at once
  // before replacing. Replace-all edits through the document store (undoable,
  // flows through the normal review/submit). No regex, no backend.
  //
  // Display is cleaned (word-timestamp {{t:N}} markers stripped, whitespace
  // collapsed) for readability, but matching, counting and replacement all run
  // on the RAW text - only what's shown is cleaned.

  let {
    text,
    onreplace,
    onlocate,
    onclose,
  }: {
    text: string;
    onreplace: (newText: string) => void;
    /** Locate a match in the editor (parent focuses + selects + scrolls). */
    onlocate?: (start: number, end: number) => void;
    onclose?: () => void;
  } = $props();

  const MAX_LINES = 1000;

  let query = $state("");
  let replacement = $state("");
  let caseSensitive = $state(false);
  let findInput = $state<HTMLInputElement>();

  function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  function makeRe(): RegExp {
    return new RegExp(escapeRegExp(query), `g${caseSensitive ? "" : "i"}`);
  }

  // Strip transcript markers and tidy whitespace for the displayed line only.
  function cleanForDisplay(line: string): string {
    return line
      .replace(/\{\{t:[0-9.]+\}\}/g, "")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  // Split a cleaned line into highlighted / plain segments around the query.
  function segmentsOf(cleaned: string): { text: string; hit: boolean }[] {
    const re = makeRe();
    const segs: { text: string; hit: boolean }[] = [];
    let last = 0;
    for (const m of cleaned.matchAll(re)) {
      if (m.index === undefined || m[0].length === 0) continue;
      if (m.index > last) segs.push({ text: cleaned.slice(last, m.index), hit: false });
      segs.push({ text: m[0], hit: true });
      last = m.index + m[0].length;
    }
    if (last < cleaned.length || segs.length === 0) segs.push({ text: cleaned.slice(last), hit: false });
    return segs;
  }

  type ResultLine = { lineNo: number; segments: { text: string; hit: boolean }[]; start: number; end: number };

  let result = $derived.by<{ count: number; lines: ResultLine[]; truncated: boolean }>(() => {
    if (!query) return { count: 0, lines: [], truncated: false };
    const re = makeRe();
    const rawLines = text.split("\n");
    const lines: ResultLine[] = [];
    let count = 0;
    let offset = 0;
    let truncated = false;
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i];
      const hits = [...line.matchAll(re)].filter((m) => m[0].length > 0);
      if (hits.length > 0) {
        count += hits.length;
        if (lines.length < MAX_LINES) {
          const first = hits[0];
          lines.push({
            lineNo: i + 1,
            segments: segmentsOf(cleanForDisplay(line)),
            start: offset + (first.index ?? 0),
            end: offset + (first.index ?? 0) + first[0].length,
          });
        } else {
          truncated = true;
        }
      }
      offset += line.length + 1; // + newline
    }
    return { count, lines, truncated };
  });

  function replaceAll() {
    if (result.count === 0) return;
    onreplace(text.replace(makeRe(), () => replacement));
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

<div class="border-t border-border bg-surface-alt flex flex-col min-h-0 flex-1 font-ui">
  <!-- Controls -->
  <div class="px-3 py-2 flex flex-col gap-1.5 flex-none border-b border-border/60">
    <div class="flex items-center gap-2">
      <input
        bind:this={findInput}
        bind:value={query}
        onkeydown={onKey}
        type="text"
        placeholder="Find in this record"
        spellcheck="false"
        class="flex-1 min-w-0 text-sm font-mono bg-surface border border-border rounded px-2 py-1
          text-on-surface outline-none focus:border-primary placeholder:text-on-surface-muted/60"
      />
      <span class="text-xs text-on-surface-secondary tabular-nums flex-none">
        {#if query}{result.count} {result.count === 1 ? "match" : "matches"}{/if}
      </span>
      <label class="flex items-center gap-1 text-xs text-on-surface-secondary cursor-pointer select-none" title="Match case">
        <input type="checkbox" bind:checked={caseSensitive} class="accent-primary" />Aa
      </label>
      <button
        onclick={() => onclose?.()}
        class="px-1.5 py-1 rounded cursor-pointer text-on-surface-muted hover:bg-surface"
        title="Close (Esc)"
        aria-label="Close">&#x2715;</button>
    </div>
    <div class="flex items-center gap-2">
      <input
        bind:value={replacement}
        onkeydown={onKey}
        type="text"
        placeholder="Replace with"
        spellcheck="false"
        class="flex-1 min-w-0 text-sm font-mono bg-surface border border-border rounded px-2 py-1
          text-on-surface outline-none focus:border-primary placeholder:text-on-surface-muted/60"
      />
      <button
        onclick={replaceAll}
        disabled={result.count === 0}
        class="text-xs px-3 py-1 rounded cursor-pointer bg-primary text-on-primary hover:bg-primary-hover
          disabled:opacity-40 disabled:cursor-not-allowed"
      >Replace all</button>
    </div>
  </div>

  <!-- Results: every matching line, term highlighted, markers stripped -->
  <div class="flex-1 overflow-auto min-h-0">
    {#if !query}
      <p class="text-xs text-on-surface-muted px-3 py-2">Type to find every match in this record.</p>
    {:else if result.lines.length === 0}
      <p class="text-xs text-on-surface-muted px-3 py-2">No matches.</p>
    {:else}
      {#each result.lines as line (line.lineNo)}
        <button
          onclick={() => onlocate?.(line.start, line.end)}
          class="w-full text-left flex gap-2 px-3 py-1 cursor-pointer hover:bg-surface text-sm font-mono leading-relaxed border-b border-border/30"
          title="Locate in the editor"
        >
          <span class="text-[11px] text-on-surface-muted tabular-nums w-10 text-right flex-none select-none">{line.lineNo}</span>
          <span class="min-w-0 break-words text-on-surface">
            {#each line.segments as seg}
              {#if seg.hit}<mark class="bg-amber-400/40 text-on-surface rounded-sm">{seg.text}</mark>{:else}{seg.text}{/if}
            {/each}
          </span>
        </button>
      {/each}
      {#if result.truncated}
        <p class="text-xs text-on-surface-muted px-3 py-2">
          Showing the first {MAX_LINES} lines of {result.count} matches - narrow the search.
        </p>
      {/if}
    {/if}
  </div>
</div>
