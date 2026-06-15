<script lang="ts">
  import { untrack } from "svelte";
  import { parseWords, wordsInTimeRange } from "$lib/transcript-words";
  import type { SpeakerRun } from "$lib/transcript-words";
  import {
    orderedNamedSpeakers,
    isSpecialSpeaker,
    nextSpeakerName,
    SPEAKER_IRRELEVANT,
    SPEAKER_NARRATOR,
    SPEAKER_EXTERNAL_FOOTAGE,
    SPEAKER_GROUP,
  } from "$lib/transcript";
  import SpeakerDot from "./SpeakerDot.svelte";

  let {
    body,
    namedSpeakers = [],
    currentTime = 0,
    filteredSpeakers = new Set<string>(),
    storageKey = "",
    onreassign,
    onedit,
    onseek,
  }: {
    /** Transcript body (everything after the frontmatter) using `{{t:N.N}}`
     *  per-word markers. */
    body: string;
    /** Named speakers from the frontmatter, for picker ordering. */
    namedSpeakers?: string[];
    /** Current media playback position in seconds, for karaoke highlighting. */
    currentTime?: number;
    /** When non-empty, only these speakers' turns are shown. */
    filteredSpeakers?: Set<string>;
    /** localStorage key for persisting which words have been observed. */
    storageKey?: string;
    /** Reassign the inclusive word range [from, to] to `speaker`. */
    onreassign: (from: number, to: number, speaker: string) => void;
    /** Replace the text of a single word (keeps its timestamp). */
    onedit: (gIndex: number, text: string) => void;
    /** Seek the media to `seconds` (optional). */
    onseek?: (seconds: number) => void;
  } = $props();

  let parsed = $derived(parseWords(body));
  let words = $derived(parsed.words);
  let runs = $derived(parsed.runs);

  // Speaker filter: when active, only matching turns are rendered. Selection
  // and karaoke still index the full word array, so they stay correct.
  let visibleRuns = $derived(
    filteredSpeakers.size === 0 ? runs : runs.filter((r) => filteredSpeakers.has(r.speaker)),
  );

  // The word currently being spoken: the last word whose start time is at or
  // before the playback clock (each word runs until the next word's start).
  // Word starts are monotonic, so binary-search. -1 before the first word.
  let activeWord = $derived.by(() => {
    if (words.length === 0 || currentTime < words[0].start) return -1;
    let lo = 0;
    let hi = words.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (words[mid].start <= currentTime) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  });

  // Map each word gIndex to the run that owns it, so a click can clamp the
  // selection to a single speaker turn.
  let runOfWord = $derived.by(() => {
    const m = new Map<number, SpeakerRun>();
    for (const run of runs) {
      for (let i = run.startWord; i <= run.endWord; i++) m.set(i, run);
    }
    return m;
  });

  // Distinct speaker names in first-appearance order, for the picker's
  // "other" section (default/unnamed clusters not in the named list).
  let allSpeakerNames = $derived.by(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const run of runs) {
      if (run.speaker && !seen.has(run.speaker)) {
        seen.add(run.speaker);
        out.push(run.speaker);
      }
    }
    return out;
  });

  // Pseudo-segments so orderedNamedSpeakers can sort by first appearance.
  let pseudoSegments = $derived(
    runs.map((r) => ({
      speaker: r.speaker,
      time: "",
      seconds: words[r.startWord]?.start ?? 0,
      lines: [],
      index: r.startWord,
    })),
  );
  let namedSpeakersOrdered = $derived(orderedNamedSpeakers(pseudoSegments, namedSpeakers));

  // Selection state: an inclusive {from, to} range of word gIndices, always
  // within one speaker run. `anchor` is where a click/drag started.
  let anchor = $state<number | null>(null);
  let range = $state<{ from: number; to: number } | null>(null);
  let dragging = $state(false);
  let pickerOpen = $state(false);
  // startWord of the run whose header picker is open (header click reassigns
  // the whole turn), or null.
  let headerPicker = $state<number | null>(null);
  // Single-word text edit state.
  let editingWord = $state(false);
  let editValue = $state("");
  let editWordEl = $state<HTMLInputElement>();

  // Floating selection bar: positioned just above (or below) the first
  // selected word, in the offsetParent's coordinate space.
  let scrollEl = $state<HTMLElement>();
  let barEl = $state<HTMLElement>();
  let barStyle = $state("");

  // Observation tracking: word gIndices that have been "seen" - auto-filled as
  // playback passes each word, or marked manually. Unobserved words render
  // faded; the set persists per record in localStorage. Always reassigned (not
  // mutated) so reactivity fires regardless of Set-proxy behaviour.
  let observed = $state(new Set<number>());
  let lastPlayTime = -1;

  // Load persisted observation when the record (storageKey) changes.
  $effect(() => {
    const key = storageKey;
    let restored: number[] = [];
    if (key) {
      try {
        restored = JSON.parse(localStorage.getItem(key) ?? "[]");
      } catch {
        restored = [];
      }
    }
    untrack(() => {
      lastPlayTime = -1;
      observed = new Set(restored);
    });
  });

  // Persist on change.
  $effect(() => {
    const arr = [...observed];
    if (storageKey) localStorage.setItem(storageKey, JSON.stringify(arr));
  });

  // Auto-observe: mark words the playhead passes during continuous forward
  // playback. Seeks and backward jumps (gap > 2s or negative) are ignored, so
  // skipped content is never silently marked seen.
  $effect(() => {
    const t = currentTime;
    void words.length;
    untrack(() => {
      const prev = lastPlayTime;
      lastPlayTime = t;
      if (prev < 0 || t - prev <= 0 || t - prev > 2) return;
      const fresh = wordsInTimeRange(words, prev, t).filter((g) => !observed.has(g));
      if (fresh.length) {
        const next = new Set(observed);
        for (const g of fresh) next.add(g);
        observed = next;
      }
    });
  });

  // Keep the actively-playing word in view: when the karaoke cursor reaches the
  // bottom 10% of the transcript (or scrolls off the top) it re-centres the
  // word, so it never rides the very bottom edge and has runway both ways. Only
  // fires as activeWord changes (i.e. during playback), so it doesn't fight
  // manual scrolling while paused.
  $effect(() => {
    const g = activeWord;
    untrack(() => {
      if (g < 0 || !scrollEl) return;
      requestAnimationFrame(() => {
        const el = scrollEl?.querySelector<HTMLElement>(`[data-word-index="${g}"]`);
        if (!el || !scrollEl) return;
        const view = scrollEl.getBoundingClientRect();
        const word = el.getBoundingClientRect();
        const topMargin = 24;
        const bottomZone = view.height * 0.1;
        if (word.top < view.top + topMargin || word.bottom > view.bottom - bottomZone) {
          const target = scrollEl.scrollTop + (word.top - view.top) - view.height * 0.5;
          scrollEl.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
        }
      });
    });
  });

  function isObserved(g: number): boolean {
    return observed.has(g);
  }

  function rangeAllObserved(): boolean {
    if (!range) return false;
    for (let g = range.from; g <= range.to; g++) if (!observed.has(g)) return false;
    return true;
  }

  function toggleSeen() {
    if (!range) return;
    const all = rangeAllObserved();
    const next = new Set(observed);
    for (let g = range.from; g <= range.to; g++) {
      if (all) next.delete(g);
      else next.add(g);
    }
    observed = next;
  }

  function observedInRun(run: SpeakerRun): number {
    let n = 0;
    for (let g = run.startWord; g <= run.endWord; g++) if (observed.has(g)) n++;
    return n;
  }

  function selectBlock(run: SpeakerRun) {
    headerPicker = null;
    pickerOpen = false;
    editingWord = false;
    anchor = run.startWord;
    range = { from: run.startWord, to: run.endWord };
  }

  function positionBar() {
    if (!range || !scrollEl || !barEl) return;
    const wordEl = scrollEl.querySelector<HTMLElement>(`[data-word-index="${range.from}"]`);
    const parent = barEl.offsetParent as HTMLElement | null;
    if (!wordEl || !parent) return;

    const word = wordEl.getBoundingClientRect();
    const base = parent.getBoundingClientRect();
    const view = scrollEl.getBoundingClientRect();
    const barW = barEl.offsetWidth;
    const barH = barEl.offsetHeight;
    const gap = 8;
    const margin = 4;

    // Left-align to the word, clamped within the visible scroll area.
    let left = word.left - base.left;
    const minLeft = view.left - base.left + margin;
    const maxLeft = view.right - base.left - barW - margin;
    if (maxLeft >= minLeft) left = Math.max(minLeft, Math.min(left, maxLeft));
    else left = minLeft;

    // Vertical clamp: keep the anchoring word's top within the visible area
    // so the bar never floats off-screen when the word is scrolled away.
    const wordTop = Math.max(view.top, Math.min(word.top, view.bottom));

    // Always sit ABOVE the word (playback runs left-to-right under the line, so
    // a bar below would cover what's being read). The transcript has top
    // headroom so the first line has room; if a scrolled word still has none,
    // pin to the top of the visible area rather than flipping below.
    const minTop = view.top - base.top + margin;
    const top = Math.max(minTop, wordTop - base.top - gap - barH);

    barStyle = `top:${Math.round(top)}px;left:${Math.round(left)}px`;
  }

  function schedulePositionBar() {
    requestAnimationFrame(positionBar);
  }

  $effect(() => {
    // Track selection and edit mode (bar width changes when editing).
    void range;
    void editingWord;
    if (range) schedulePositionBar();
  });

  function clampToRun(a: number, b: number): { from: number; to: number } | null {
    const run = runOfWord.get(a);
    if (!run) return null;
    // Clamp b into the anchor's run so a drag/shift can't cross a speaker turn.
    const lo = Math.max(run.startWord, Math.min(a, b));
    const hi = Math.min(run.endWord, Math.max(a, b));
    return { from: lo, to: hi };
  }

  function selectWord(g: number, extend: boolean) {
    headerPicker = null;
    if (extend && anchor !== null) {
      range = clampToRun(anchor, g);
    } else {
      anchor = g;
      range = { from: g, to: g };
    }
    pickerOpen = false;
  }

  function onWordPointerDown(e: PointerEvent, g: number) {
    if (e.button !== 0) return;
    if (e.shiftKey) {
      selectWord(g, true);
    } else {
      selectWord(g, false);
      dragging = true;
      if (onseek && words[g]) onseek(words[g].start);
    }
  }

  function onWordPointerEnter(g: number) {
    if (dragging && anchor !== null) {
      range = clampToRun(anchor, g);
    }
  }

  function stopDrag() {
    dragging = false;
  }

  function isSelected(g: number): boolean {
    return range !== null && g >= range.from && g <= range.to;
  }

  function clearSelection() {
    anchor = null;
    range = null;
    pickerOpen = false;
    editingWord = false;
  }

  function chooseSpeaker(name: string) {
    if (range) onreassign(range.from, range.to, name);
    clearSelection();
  }

  function startEditWord() {
    if (!range || range.from !== range.to) return;
    editValue = words[range.from].text;
    pickerOpen = false;
    editingWord = true;
    setTimeout(() => {
      editWordEl?.focus();
      editWordEl?.select();
    }, 0);
  }

  function commitEditWord() {
    if (range && editingWord) onedit(range.from, editValue);
    clearSelection();
  }

  function toggleHeaderPicker(run: SpeakerRun) {
    // Opening a header picker deselects any word range to avoid two live menus.
    anchor = null;
    range = null;
    pickerOpen = false;
    headerPicker = headerPicker === run.startWord ? null : run.startWord;
  }

  function chooseRunSpeaker(run: SpeakerRun, name: string) {
    onreassign(run.startWord, run.endWord, name);
    headerPicker = null;
  }
</script>

<svelte:window onpointerup={stopDrag} onresize={() => range && schedulePositionBar()} />

{#snippet speakerMenu(currentSpeaker: string | null, onChoose: (name: string) => void)}
  {@const named = namedSpeakersOrdered.filter((s) => s !== currentSpeaker)}
  {@const special = [
    SPEAKER_IRRELEVANT,
    SPEAKER_NARRATOR,
    SPEAKER_EXTERNAL_FOOTAGE,
    SPEAKER_GROUP,
  ].filter((s) => s !== currentSpeaker)}
  {@const other = allSpeakerNames.filter(
    (s) => s !== currentSpeaker && !namedSpeakers.includes(s) && !isSpecialSpeaker(s),
  )}
  <div
    role="menu"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    onkeydown={() => {}}
    class="absolute top-full left-0 mt-1 z-40 bg-surface-raised border border-border
      rounded shadow-lg py-1 min-w-40 max-h-60 overflow-auto"
  >
    {#each named as name}
      <button
        onclick={() => onChoose(name)}
        class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface"
      >
        <SpeakerDot speaker={name} inline />
        {name}
      </button>
    {/each}
    {#if named.length > 0 && special.length > 0}
      <div class="border-t border-border my-1"></div>
    {/if}
    {#each special as name}
      <button
        onclick={() => onChoose(name)}
        class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface-muted italic"
      >
        <SpeakerDot speaker={name} inline />
        {name}
      </button>
    {/each}
    {#if other.length > 0}
      <div class="border-t border-border my-1"></div>
      {#each other as name}
        <button
          onclick={() => onChoose(name)}
          class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface-muted"
        >
          <SpeakerDot speaker={name} inline />
          {name}
        </button>
      {/each}
    {/if}
    <div class="border-t border-border mt-1 pt-1">
      <button
        onclick={() => onChoose(nextSpeakerName(pseudoSegments))}
        class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-primary"
      >
        + New speaker
      </button>
    </div>
  </div>
{/snippet}

<!-- Selection action bar, floating just above the first selected word, shown
     when a word range is selected. -->
{#if range}
  {@const count = range.to - range.from + 1}
  {@const single = range.from === range.to}
  {@const selectedSpeaker = runOfWord.get(range.from)?.speaker ?? null}
  <div
    bind:this={barEl}
    style={barStyle}
    class="absolute z-30 flex items-center gap-2
      bg-surface-raised border border-primary/60 ring-2 ring-primary/25 rounded-full shadow-xl px-3 py-1.5"
  >
    {#if editingWord}
      <input
        bind:this={editWordEl}
        type="text"
        bind:value={editValue}
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitEditWord();
          } else if (e.key === "Escape") {
            e.preventDefault();
            clearSelection();
          }
        }}
        class="text-sm font-ui bg-surface border border-primary rounded px-2 py-0.5 text-on-surface outline-none min-w-32"
      />
      <button
        onclick={commitEditWord}
        class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline"
        title="Save (Enter)"
      >
        Save
      </button>
      <button
        onclick={clearSelection}
        class="p-0.5 rounded cursor-pointer text-on-surface-muted/60 hover:text-on-surface hover:bg-surface-alt transition-colors"
        title="Cancel (Esc)"
        aria-label="Cancel"
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    {:else}
      <span class="text-xs font-ui text-on-surface-secondary tabular-nums">
        {count} word{count === 1 ? "" : "s"}
      </span>
      <div class="w-px h-4 bg-border" aria-hidden="true"></div>
      <div class="relative">
        <button
          onclick={(e) => {
            e.stopPropagation();
            pickerOpen = !pickerOpen;
          }}
          class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline flex items-center gap-1"
          title="Assign these words to a speaker"
        >
          Assign speaker
          <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {#if pickerOpen}
          {@render speakerMenu(selectedSpeaker, chooseSpeaker)}
        {/if}
      </div>
      <div class="w-px h-4 bg-border" aria-hidden="true"></div>
      <button
        onclick={toggleSeen}
        class="text-xs font-ui font-medium cursor-pointer hover:underline
          {rangeAllObserved() ? 'text-on-surface-muted' : 'text-primary'}"
        title={rangeAllObserved()
          ? "Mark these words as not yet observed"
          : "Mark these words as observed"}
      >
        {rangeAllObserved() ? "Mark unseen" : "Mark seen"}
      </button>
      {#if single}
        <div class="w-px h-4 bg-border" aria-hidden="true"></div>
        <button
          onclick={startEditWord}
          class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline"
          title="Edit this word's text"
        >
          Edit word
        </button>
      {/if}
      <button
        onclick={clearSelection}
        class="p-0.5 rounded cursor-pointer text-on-surface-muted/60 hover:text-on-surface hover:bg-surface-alt transition-colors"
        title="Clear selection"
        aria-label="Clear selection"
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    {/if}
  </div>
{/if}

<div
  bind:this={scrollEl}
  onscroll={() => range && schedulePositionBar()}
  class="flex-1 overflow-auto"
  data-scroll-sync
>
  <!-- Top headroom so the selection bar always has room to sit above even the
       first line, and never has to flip below it. -->
  <div class="select-none pt-12">
    {#each visibleRuns as run (run.startWord)}
      {@const obs = observedInRun(run)}
      {@const total = run.endWord - run.startWord + 1}
      <div class="border-b border-border/50 px-4 pt-3 pb-2">
        <div class="flex items-center justify-between gap-2 pb-1">
          <!-- Clickable speaker chip: reassigns the whole turn. -->
          <div class="relative inline-block">
            <button
              onclick={(e) => {
                e.stopPropagation();
                toggleHeaderPicker(run);
              }}
              class="group flex items-center gap-2 cursor-pointer rounded px-1 -mx-1 hover:bg-primary-container/30 transition-colors"
              title="Change this speaker"
            >
              <div class="w-4 flex-none flex items-center justify-center">
                <SpeakerDot speaker={run.speaker} />
              </div>
              <span class="text-xs font-ui font-medium text-primary group-hover:underline">
                {run.speaker}
              </span>
              <svg
                class="w-3 h-3 text-on-surface-muted/60"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                viewBox="0 0 24 24"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {#if headerPicker === run.startWord}
              {@render speakerMenu(run.speaker, (name) => chooseRunSpeaker(run, name))}
            {/if}
          </div>
          <!-- Observation progress for this turn. Clicking selects the turn so
               it can be marked seen deliberately (no one-click mark-all). -->
          <button
            onclick={() => selectBlock(run)}
            class="flex-none text-[10px] font-mono tabular-nums px-1.5 py-0.5 rounded cursor-pointer transition-colors
              {obs >= total
              ? 'text-primary hover:bg-primary-container/30'
              : 'text-on-surface-muted/60 hover:bg-surface-alt hover:text-on-surface'}"
            title={obs >= total
              ? "This turn is fully observed - click to select it"
              : `${obs} of ${total} words observed - click to select this turn, then Mark seen`}
          >
            {obs}/{total}
          </button>
        </div>
        <p class="pl-6 text-sm text-on-surface leading-relaxed">
          {#each Array.from({ length: run.endWord - run.startWord + 1 }, (_, k) => run.startWord + k) as g (g)}
            <span
              data-word-index={g}
              role="button"
              tabindex="-1"
              onpointerdown={(e) => onWordPointerDown(e, g)}
              onpointerenter={() => onWordPointerEnter(g)}
              class="cursor-text rounded-sm px-px transition-colors
                {isSelected(g)
                ? 'bg-primary/30 text-on-surface'
                : g === activeWord
                  ? 'bg-amber-400/40 text-on-surface'
                  : isObserved(g)
                    ? 'hover:bg-primary-container/30'
                    : 'text-on-surface-muted/40 hover:bg-primary-container/30'}"
            >{words[g].text}</span>{" "}
          {/each}
        </p>
      </div>
    {/each}
  </div>
</div>
