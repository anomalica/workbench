<script lang="ts">
  import type { Word } from "$lib/transcript-words";
  import { tick, onMount } from "svelte";

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
  // Per-row text inputs, for moving focus when navigating or splitting words.
  let inputs: (HTMLInputElement | null)[] = [];

  // Select row `i`, focus its text input and place the caret (default: end).
  // `caret: "all"` selects the whole word so typing replaces it outright.
  // Waits a tick so the input exists after an items reassign (split/navigate).
  async function focusRow(i: number, caret: number | "end" | "all" = "end") {
    selected = i;
    await tick();
    const el = inputs[i];
    if (!el) return;
    el.focus();
    if (caret === "all") {
      el.select();
    } else {
      const pos = caret === "end" ? el.value.length : caret;
      el.setSelectionRange(pos, pos);
    }
    el.scrollIntoView({ block: "nearest" });
  }

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

  // Pressing space in a word starts a NEW word at the caret: the text before
  // the caret keeps the current time, the text after it becomes a new,
  // auto-positioned word. Focus follows to the new word so continued typing
  // lands there - the "hit space -> new timestamp" behaviour, without the space
  // ever entering the value (which previously re-split on every keystroke and
  // stranded focus on the first word).
  function splitAtCaret(i: number, caret: number) {
    const before = items[i].text.slice(0, caret);
    const after = items[i].text.slice(caret);
    const newStart = (items[i].start + upperBound(i)) / 2;
    const next = items.slice();
    next[i] = { ...next[i], text: before };
    next.splice(i + 1, 0, { text: after, start: newStart, auto: true });
    items = next;
    focusRow(i + 1, 0);
  }

  function onWordKeydown(e: KeyboardEvent, i: number) {
    if (e.key !== " ") return;
    e.preventDefault();
    const input = e.target as HTMLInputElement;
    splitAtCaret(i, input.selectionStart ?? items[i].text.length);
  }

  // Pasted text containing spaces splits into separately-timestamped words: the
  // first piece keeps the time, the rest are auto-positioned across the gap to
  // the next word. Typed spaces are handled by splitAtCaret; this covers paste.
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
    focusRow(i + parts.length - 1, "end");
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      oncancel();
      return;
    }
    // Ctrl/Cmd+Enter saves and exits, the keyboard equivalent of Save.
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      save();
      return;
    }
    // Up/down move the selection box to the previous/next word (and focus it),
    // even from within a text input - single-line inputs ignore up/down anyway.
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (selected > 0) focusRow(selected - 1, "end");
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (selected < items.length - 1) focusRow(selected + 1, "end");
      return;
    }
    // Left/right nudge the selected timestamp only when focus isn't in a text
    // input (so editing text with the arrows still works).
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

  // Focus the first word on open with its text fully selected, so it can be
  // retyped immediately and keyboard control is live (the host viewer's global
  // Up/Down shortcuts bail when focus is in an input).
  onMount(() => {
    focusRow(0, "all");
  });
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
      Edit the text, delete or add words, and retime. Up/down move between words;
      a timestamp nudge (buttons, or left/right arrows at 50ms) plays from the new
      position, and &#9658; replays. Space starts a new word at the caret;
      Ctrl+Enter saves. Amber timestamps were auto-positioned - click to confirm.
    </p>

    <div class="flex-1 overflow-auto px-3 py-2 space-y-1">
      {#each items as item, i (i)}
        <div
          class="flex items-center gap-2 rounded px-2 py-1 transition-colors
            {selected === i ? 'bg-primary/10' : 'hover:bg-surface-alt/50'}"
        >
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

          <!-- Per-row time nudge with a centred play, shown for the selected
               row. Each nudge plays from the new position; the centre play
               replays from the current one. -->
          {#if selected === i}
            <div class="flex-none flex items-center gap-0.5">
              {#each [-0.1, -0.01] as d (d)}
                <button
                  onclick={() => { nudge(i, d); onseek(items[i].start); }}
                  class="text-[10px] tabular-nums rounded px-1 py-0.5 bg-surface-alt text-on-surface-secondary
                    hover:bg-surface-alt/70 cursor-pointer"
                  title="{d * 1000}ms, then play"
                >{(d * 1000).toFixed(0)}</button>
              {/each}
              <button
                onclick={() => onseek(items[i].start)}
                class="flex-none text-primary hover:text-primary-hover cursor-pointer px-0.5"
                title="Play from here"
                aria-label="Play from here"
              >
                <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 20 20"><path d="M6 4l10 6-10 6V4z" /></svg>
              </button>
              {#each [0.01, 0.1] as d (d)}
                <button
                  onclick={() => { nudge(i, d); onseek(items[i].start); }}
                  class="text-[10px] tabular-nums rounded px-1 py-0.5 bg-surface-alt text-on-surface-secondary
                    hover:bg-surface-alt/70 cursor-pointer"
                  title="+{d * 1000}ms, then play"
                >+{(d * 1000).toFixed(0)}</button>
              {/each}
            </div>
          {/if}

          <!-- Word text. Space starts a new word at the caret; pasted spaces split. -->
          <input
            bind:this={inputs[i]}
            bind:value={item.text}
            onfocus={() => (selected = i)}
            onkeydown={(e) => onWordKeydown(e, i)}
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
        title="Save and close (Ctrl+Enter)"
        class="text-sm px-3 py-1.5 rounded bg-primary text-on-primary hover:bg-primary-hover cursor-pointer"
      >Save</button>
    </div>
  </div>
</div>
