<script lang="ts">
  import type { Segment } from "$lib/transcript";
  import {
    secondsToTime,
    secondsToTimecode,
    parseTimeToSeconds,
    isSpecialSpeaker,
    EVENT_NOTE_PRESETS,
    insertEventNote as spliceEventNote,
    SPEAKER_IRRELEVANT,
    SPEAKER_NARRATOR,
    assignableSpecialSpeakers,
    SPEAKER_GROUP,
  } from "$lib/transcript";
  import SpeakerDot from "./SpeakerDot.svelte";

  let {
    segment,
    allSpeakers,
    namedSpeakers,
    videoTime,
    canPreview = false,
    onpreview,
    onsave,
    oncancel,
  }: {
    segment: Segment;
    allSpeakers: string[];
    namedSpeakers: string[];
    videoTime: number;
    /** Whether the background player can be seeked/played for audible preview. */
    canPreview?: boolean;
    onpreview?: (seconds: number) => void;
    onsave: (newSpeaker: string, newTime: string, newText: string) => void;
    oncancel: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let text = $state(segment.lines.join("\n"));
  // svelte-ignore state_referenced_locally
  let editSeconds = $state(segment.seconds);
  // svelte-ignore state_referenced_locally
  let editSpeaker = $state(segment.speaker);
  let showSpeakerPicker = $state(false);
  let textareaEl: HTMLTextAreaElement | undefined = $state();

  // Format seconds to MM:SS.D (or HH:MM:SS.D), keeping the tenths so a 0.1
  // nudge is actually visible - secondsToTime() floors to whole seconds.
  function fmtTenths(s: number): string {
    const t = Math.max(0, s);
    const pad = (n: number) => String(n).padStart(2, "0");
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const sec = Math.floor(t % 60);
    const tenth = Math.floor((t * 10) % 10);
    const base = h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
    return `${base}.${tenth}`;
  }

  // Round to tenths so the value stays clean as the buttons nudge it.
  function nudge(delta: number) {
    editSeconds = Math.max(0, Math.round((editSeconds + delta) * 10) / 10);
    onpreview?.(editSeconds);
  }

  // Fine-scrub slider window: a +/-6s span that recenters if the value is
  // pushed outside it by the coarse buttons.
  // svelte-ignore state_referenced_locally
  let scrubCenter = $state(segment.seconds);
  $effect(() => {
    if (editSeconds < scrubCenter - 6 || editSeconds > scrubCenter + 6) {
      scrubCenter = editSeconds;
    }
  });
  let scrubMin = $derived(Math.max(0, scrubCenter - 6));
  let scrubMax = $derived(scrubCenter + 6);

  $effect(() => {
    if (textareaEl) {
      textareaEl.focus();
      textareaEl.setSelectionRange(textareaEl.value.length, textareaEl.value.length);
    }
  });

  let namedGroup = $derived(namedSpeakers.filter((s) => s !== editSpeaker));
  let specialGroup = $derived(assignableSpecialSpeakers(editSpeaker));
  let otherGroup = $derived(
    allSpeakers.filter((s) => s !== editSpeaker && !namedSpeakers.includes(s) && !isSpecialSpeaker(s)),
  );

  // Insert a bracketed non-verbal event note at the cursor (or replacing the
  // selection). Bare `[...]` is the unkeyed meta form the digester reads as an
  // event, not spoken words - distinct from the keyed `{{actor: action}}` form.
  // Spaces are padded in only where the neighbours aren't already whitespace.
  function insertEventNote(label: string) {
    const el = textareaEl;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? start;
    const result = spliceEventNote(text, label, start, end);
    text = result.text;
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(result.cursor, result.cursor);
    }, 0);
  }

  /** Strike the selected words: `~~like this~~`. Kept as markdown rather than
   *  a new annotation because it needs no format change and renders struck
   *  wherever the record is read. Note the words still REACH the model as
   *  prose - a strike says "the source shows this crossed out", not "ignore
   *  this". Toggles, so a second press unstrikes. */
  function strikeSelection() {
    const el = textareaEl;
    const start = el?.selectionStart ?? 0;
    const end = el?.selectionEnd ?? start;
    if (start === end) return;
    const picked = text.slice(start, end);
    const already = picked.startsWith("~~") && picked.endsWith("~~") && picked.length > 4;
    const replaced = already ? picked.slice(2, -2) : `~~${picked}~~`;
    text = text.slice(0, start) + replaced + text.slice(end);
    const to = start + replaced.length;
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(start, to);
    }, 0);
  }

  function save() {
    const newText = text.trim();
    if (!newText) return;
    // secondsToTimecode keeps the tenths - secondsToTime would floor them
    // away, silently dropping the fine-scrub adjustment.
    onsave(editSpeaker, secondsToTimecode(editSeconds), newText);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      oncancel();
    } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    }
  }
</script>

<div
  class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
  onclick={(e) => { if (e.target === e.currentTarget) oncancel(); }}
  onkeydown={handleKeydown}
  role="dialog"
  tabindex="-1"
>
  <div
    class="bg-surface-raised border border-border rounded shadow-xl p-4 w-full max-w-xl"
    role="document"
  >
    <div class="flex items-center justify-between mb-3">
      <h3 class="text-sm font-ui font-medium text-on-surface">Edit sentence</h3>
      <button
        onclick={oncancel}
        class="text-on-surface-muted hover:text-on-surface cursor-pointer p-0.5"
        title="Cancel (Esc)"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>

    <!-- Speaker picker -->
    <div class="mb-3">
      <span class="block text-xs font-ui font-medium text-on-surface-secondary uppercase mb-1">Speaker</span>
      <div class="relative">
        <button
          onclick={() => { showSpeakerPicker = !showSpeakerPicker; }}
          class="w-full flex items-center gap-2 bg-surface border border-border rounded px-2 py-1.5 text-sm font-ui cursor-pointer hover:border-primary/50 text-left"
        >
          <SpeakerDot speaker={editSpeaker} />
          <span class="flex-1 {isSpecialSpeaker(editSpeaker) ? 'italic text-on-surface-muted' : 'text-on-surface'}">{editSpeaker}</span>
          <svg class="w-3.5 h-3.5 text-on-surface-muted" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {#if showSpeakerPicker}
          <div class="absolute left-0 right-0 top-full mt-1 z-20 bg-surface-raised border border-border rounded shadow-lg py-1 max-h-60 overflow-auto">
            {#each namedGroup as sp}
              <button onclick={() => { editSpeaker = sp; showSpeakerPicker = false; }}
                class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface">
                <SpeakerDot speaker={sp} inline />
                {sp}
              </button>
            {/each}
            {#if namedGroup.length > 0 && specialGroup.length > 0}
              <div class="border-t border-border my-1"></div>
            {/if}
            {#each specialGroup as sp}
              <button onclick={() => { editSpeaker = sp; showSpeakerPicker = false; }}
                class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface-muted italic">
                <SpeakerDot speaker={sp} inline />
                {sp}
              </button>
            {/each}
            {#if otherGroup.length > 0}
              <div class="border-t border-border my-1"></div>
              {#each otherGroup as sp}
                <button onclick={() => { editSpeaker = sp; showSpeakerPicker = false; }}
                  class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface-muted">
                  <SpeakerDot speaker={sp} inline />
                  {sp}
                </button>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    </div>

    <!-- Timestamp adjuster -->
    <div class="mb-3">
      <label for="edit-time" class="block text-xs font-ui font-medium text-on-surface-secondary uppercase mb-1">Timestamp</label>
      <div class="flex items-center gap-1.5">
        <button onclick={() => nudge(-1)}
          class="text-xs font-mono px-1.5 py-0.5 bg-surface border border-border rounded cursor-pointer hover:bg-surface-alt">-1s</button>
        <button onclick={() => nudge(-0.1)}
          class="text-xs font-mono px-1.5 py-0.5 bg-surface border border-border rounded cursor-pointer hover:bg-surface-alt">-0.1</button>
        <input
          id="edit-time"
          type="text"
          value={fmtTenths(editSeconds)}
          oninput={(e) => {
            const parsed = parseTimeToSeconds((e.target as HTMLInputElement).value);
            if (!isNaN(parsed)) editSeconds = parsed;
          }}
          class="text-sm font-mono text-on-surface bg-surface border border-border rounded px-2 py-0.5 flex-1 text-center outline-none focus:border-primary tabular-nums"
        />
        <button onclick={() => nudge(0.1)}
          class="text-xs font-mono px-1.5 py-0.5 bg-surface border border-border rounded cursor-pointer hover:bg-surface-alt">+0.1</button>
        <button onclick={() => nudge(1)}
          class="text-xs font-mono px-1.5 py-0.5 bg-surface border border-border rounded cursor-pointer hover:bg-surface-alt">+1s</button>
        <button onclick={() => { editSeconds = videoTime; onpreview?.(editSeconds); }}
          class="text-xs font-ui px-2 py-0.5 bg-primary-container/30 text-primary rounded cursor-pointer hover:bg-primary-container/50"
          title="Use current video time">
          Video ({secondsToTime(videoTime)})
        </button>
      </div>

      {#if canPreview}
        <!-- Fine-scrub slider: drag to a precise start, release to hear it.
             Range follows the value within a +/-6s window. -->
        <div class="flex items-center gap-2 mt-2">
          <button
            onclick={() => onpreview?.(editSeconds)}
            class="flex-none flex items-center gap-1 text-xs font-ui px-2 py-1 bg-primary text-on-primary rounded cursor-pointer hover:bg-primary-hover"
            title="Play the video from this timestamp"
          >
            <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
            Play from here
          </button>
          <input
            type="range"
            min={scrubMin}
            max={scrubMax}
            step="0.05"
            value={editSeconds}
            oninput={(e) => { editSeconds = Math.round(parseFloat((e.target as HTMLInputElement).value) * 10) / 10; }}
            onchange={() => onpreview?.(editSeconds)}
            class="flex-1 accent-primary cursor-pointer"
            aria-label="Fine-scrub timestamp"
          />
        </div>
      {/if}
    </div>

    <!-- Text editor -->
    <div class="mb-3">
      <label for="edit-text" class="block text-xs font-ui font-medium text-on-surface-secondary uppercase mb-1">Text</label>
      <textarea
        id="edit-text"
        bind:this={textareaEl}
        bind:value={text}
        rows="4"
        class="w-full text-sm font-body text-on-surface bg-surface border border-border rounded px-2 py-1.5 outline-none focus:border-primary resize-y leading-relaxed"
      ></textarea>
      <!-- Quick-insert non-verbal event notes at the cursor. The reviewer can
           also just type any `[...]`; these are the common ones. -->
      <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onclick={strikeSelection}
          class="text-xs font-ui px-1.5 py-0.5 bg-surface border border-border rounded cursor-pointer hover:border-primary/50 hover:text-primary text-on-surface-secondary line-through"
          title="Strike the selected words - the source shows them crossed out. They stay in the record and still reach the model; press again to unstrike."
        >abc</button>
        <span class="w-px h-3.5 bg-border" aria-hidden="true"></span>
        <span class="text-[0.65rem] font-ui uppercase tracking-wide text-on-surface-muted">Event note</span>
        {#each EVENT_NOTE_PRESETS as preset}
          <button
            type="button"
            onclick={() => insertEventNote(preset)}
            class="text-xs font-mono px-1.5 py-0.5 bg-surface border border-border rounded cursor-pointer hover:border-primary/50 hover:text-primary text-on-surface-secondary"
            title={`Insert [${preset}] at the cursor - a non-verbal event, read downstream as meta, not spoken words`}
          >[{preset}]</button>
        {/each}
      </div>
    </div>

    <div class="flex items-center justify-end gap-2">
      <button onclick={oncancel}
        class="text-xs font-ui text-on-surface-muted cursor-pointer px-3 py-1 hover:text-on-surface">
        Cancel
      </button>
      <button onclick={save}
        class="text-xs font-ui font-medium px-3 py-1 bg-primary text-on-primary rounded cursor-pointer hover:bg-primary-hover"
        title="Save (Ctrl+Enter)">
        Save
      </button>
    </div>
  </div>
</div>
