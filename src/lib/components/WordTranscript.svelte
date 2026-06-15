<script lang="ts">
  import { parseWords } from "$lib/transcript-words";
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
    onreassign,
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
    /** Reassign the inclusive word range [from, to] to `speaker`. */
    onreassign: (from: number, to: number, speaker: string) => void;
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
  }

  function chooseSpeaker(name: string) {
    if (range) onreassign(range.from, range.to, name);
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

<svelte:window onpointerup={stopDrag} />

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

<!-- Selection action bar, docked at the top of the transcript pane, shown when
     a word range is selected. -->
{#if range}
  {@const count = range.to - range.from + 1}
  {@const selectedSpeaker = runOfWord.get(range.from)?.speaker ?? null}
  <div
    class="absolute top-2 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2
      bg-surface-raised border border-border rounded-full shadow-lg px-3 py-1.5"
  >
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
  </div>
{/if}

<div class="flex-1 overflow-auto" data-scroll-sync>
  <div class="select-none">
    {#each visibleRuns as run (run.startWord)}
      <div class="border-b border-border/50 px-4 pt-3 pb-2">
        <!-- Clickable speaker chip: reassigns the whole turn. -->
        <div class="relative inline-block pb-1">
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
                  : 'hover:bg-primary-container/30'}"
            >{words[g].text}</span>{" "}
          {/each}
        </p>
      </div>
    {/each}
  </div>
</div>
