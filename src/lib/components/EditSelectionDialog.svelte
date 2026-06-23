<script lang="ts">
  import type { Word } from "$lib/transcript-words";

  // Unified multi-word editor: edit text, delete/insert words, and retime - all
  // in one modal over a selected word range. Replaces the separate edit-word +
  // adjust-time actions. The caller splices the result back via replaceWordRange.
  let {
    words,
    prevStart = null,
    nextStart = null,
    mediaDuration = null,
    speaker = "",
    onsave,
    oncancel,
    onseek,
  }: {
    /** The selected range's words (within one speaker run), in order. */
    words: Word[];
    /** Start of the word just before the selection (lower time bound), or null. */
    prevStart?: number | null;
    /** Start of the word just after the selection (upper time bound), or null. */
    nextStart?: number | null;
    mediaDuration?: number | null;
    speaker?: string;
    /** Commit the edited words (text + start), in order. */
    onsave: (newWords: { text: string; start: number }[]) => void;
    oncancel: () => void;
    /** Seek/play the media from `t` seconds (preview a word). */
    onseek: (t: number) => void;
  } = $props();

  interface Item {
    text: string;
    start: number;
    // True when the timestamp was auto-positioned (a new/split word), not set by
    // the reviewer - shown in a distinct colour so it's clear it's a guess.
    auto: boolean;
  }

  // svelte-ignore state_referenced_locally
  let items = $state<Item[]>(words.map((w) => ({ text: w.text, start: w.start, auto: false })));
  // The row whose timestamp the arrow keys nudge.
  let selected = $state(0);

  function lowerBound(i: number): number {
    return i > 0 ? items[i - 1].start : (prevStart ?? 0);
  }
  function upperBound(i: number): number {
    if (i < items.length - 1) return items[i + 1].start;
    return nextStart ?? mediaDuration ?? items[i].start + 1;
  }
  // Clamp a row's start between its neighbours so word order stays monotonic.
  function setStart(i: number, t: number, human = true) {
    const lo = lowerBound(i);
    const hi = upperBound(i);
    items[i].start = Math.max(lo, Math.min(hi, t));
    if (human) items[i].auto = false;
  }
  function nudge(i: number, delta: number) {
    setStart(i, items[i].start + delta);
  }

  function deleteItem(i: number) {
    items = items.filter((_, j) => j !== i);
    if (selected >= items.length) selected = Math.max(0, items.length - 1);
  }

  function addWord() {
    const last = items[items.length - 1];
    const lo = last ? last.start : (prevStart ?? 0);
    const hi = nextStart ?? mediaDuration ?? lo + 1;
    items = [...items, { text: "", start: (lo + hi) / 2, auto: true }];
    selected = items.length - 1;
  }

  // A space typed into a word splits it into separately-timestamped words: the
  // first piece keeps the time, the rest are auto-positioned across the gap to
  // the next word (the "hit space -> new timestamp" behaviour).
  function splitOnSpace(i: number) {
    const parts = items[i].text.split(/\s+/).filter(Boolean);
    if (parts.length <= 1) return;
    const start = items[i].start;
    const span = Math.max(0, upperBound(i) - start);
    const pieces: Item[] = parts.map((text, p) => ({
      text,
      start: p === 0 ? start : start + (span * p) / parts.length,
      auto: p !== 0,
    }));
    items = [...items.slice(0, i), ...pieces, ...items.slice(i + 1)];
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      oncancel();
      return;
    }
    // Arrow nudge only when focus isn't in a text input (so editing text with
    // the arrows still works).
    const inInput = (e.target as HTMLElement)?.tagName === "INPUT";
    if (!inInput && items[selected]) {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        nudge(selected, -0.05);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        nudge(selected, +0.05);
      }
    }
  }

  function save() {
    onsave(items.filter((it) => it.text.trim()).map((it) => ({ text: it.text.trim(), start: it.start })));
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4 font-ui"
  onclick={(e) => { if (e.target === e.currentTarget) oncancel(); }}
  role="presentation"
>
  <div class="bg-surface rounded-lg shadow-xl border border-border w-full max-w-2xl max-h-[85vh] flex flex-col">
    <div class="px-4 py-3 border-b border-border flex items-center gap-2 flex-none">
      <h2 class="text-sm font-medium text-on-surface">Edit selection</h2>
      {#if speaker}<span class="text-xs text-on-surface-muted">{speaker}</span>{/if}
      <span class="text-xs text-on-surface-muted ml-auto">{items.length} word{items.length === 1 ? "" : "s"}</span>
    </div>

    <p class="px-4 pt-2 text-xs text-on-surface-muted">
      Edit the text, delete or add words, and retime. Click a timestamp to select it,
      then nudge with the arrow keys (50ms) or the buttons. Click &#9658; to play from a word.
      Amber timestamps were auto-positioned - click to confirm.
    </p>

    <div class="flex-1 overflow-auto px-3 py-2 space-y-1">
      {#each items as item, i (i)}
        <div
          class="flex items-center gap-2 rounded px-2 py-1 transition-colors
            {selected === i ? 'bg-primary/10' : 'hover:bg-surface-alt/50'}"
        >
          <!-- Play from this word -->
          <button
            onclick={() => onseek(item.start)}
            class="flex-none text-on-surface-muted hover:text-primary cursor-pointer p-1"
            title="Play from here"
            aria-label="Play from this word"
          >
            <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path d="M6 4l10 6-10 6V4z" /></svg>
          </button>

          <!-- Timestamp chip: click to select; colour distinguishes auto vs set -->
          <button
            onclick={() => { selected = i; onseek(item.start); }}
            class="flex-none tabular-nums text-xs rounded px-1.5 py-0.5 cursor-pointer transition-colors
              {item.auto
                ? 'bg-warning-container text-on-warning-container'
                : selected === i
                  ? 'bg-primary text-on-primary'
                  : 'bg-surface-alt text-on-surface-secondary hover:bg-surface-alt/70'}"
            title={item.auto ? "Auto-positioned - click to select + confirm" : "Click to select, then nudge"}
          >
            {item.start.toFixed(2)}s
          </button>

          <!-- Per-row time nudge, shown for the selected row -->
          {#if selected === i}
            <div class="flex-none flex items-center gap-0.5">
              {#each [-0.1, -0.01, 0.01, 0.1] as d (d)}
                <button
                  onclick={() => nudge(i, d)}
                  class="text-[10px] tabular-nums rounded px-1 py-0.5 bg-surface-alt text-on-surface-secondary
                    hover:bg-surface-alt/70 cursor-pointer"
                  title="{d > 0 ? '+' : ''}{d * 1000}ms"
                >{d > 0 ? "+" : ""}{(d * 1000).toFixed(0)}</button>
              {/each}
            </div>
          {/if}

          <!-- Word text. A space splits it into separately-timed words. -->
          <input
            bind:value={item.text}
            onfocus={() => (selected = i)}
            oninput={() => { if (/\s/.test(item.text)) splitOnSpace(i); }}
            class="flex-1 min-w-0 bg-surface border border-border rounded px-2 py-1 text-sm
              text-on-surface focus:outline-none focus:border-primary"
            placeholder="(new word)"
          />

          <!-- Delete this word -->
          <button
            onclick={() => deleteItem(i)}
            class="flex-none text-on-surface-muted hover:text-error cursor-pointer p-1"
            title="Delete this word"
            aria-label="Delete this word"
          >&times;</button>
        </div>
      {/each}

      <button
        onclick={addWord}
        class="mt-1 text-xs text-primary hover:underline cursor-pointer px-2 py-1"
      >+ Add word</button>
    </div>

    <div class="px-4 py-3 border-t border-border flex items-center justify-end gap-2 flex-none">
      <button
        onclick={oncancel}
        class="text-sm px-3 py-1.5 rounded text-on-surface-secondary hover:bg-surface-alt cursor-pointer"
      >Cancel</button>
      <button
        onclick={save}
        class="text-sm px-3 py-1.5 rounded bg-primary text-on-primary hover:bg-primary-hover cursor-pointer"
      >Save</button>
    </div>
  </div>
</div>
