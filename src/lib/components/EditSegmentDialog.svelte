<script lang="ts">
  import type { Segment } from "$lib/transcript";
  import {
    secondsToTime,
    parseTimeToSeconds,
    isSpecialSpeaker,
    SPEAKER_IRRELEVANT,
    SPEAKER_NARRATOR,
    SPEAKER_EXTERNAL_FOOTAGE,
    SPEAKER_GROUP,
  } from "$lib/transcript";
  import SpeakerDot from "./SpeakerDot.svelte";

  let {
    segment,
    allSpeakers,
    namedSpeakers,
    videoTime,
    onsave,
    oncancel,
  }: {
    segment: Segment;
    allSpeakers: string[];
    namedSpeakers: string[];
    videoTime: number;
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

  $effect(() => {
    if (textareaEl) {
      textareaEl.focus();
      textareaEl.setSelectionRange(textareaEl.value.length, textareaEl.value.length);
    }
  });

  let namedGroup = $derived(namedSpeakers.filter((s) => s !== editSpeaker));
  let specialGroup = $derived([SPEAKER_IRRELEVANT, SPEAKER_NARRATOR, SPEAKER_EXTERNAL_FOOTAGE, SPEAKER_GROUP].filter((s) => s !== editSpeaker));
  let otherGroup = $derived(
    allSpeakers.filter((s) => s !== editSpeaker && !namedSpeakers.includes(s) && !isSpecialSpeaker(s)),
  );

  function save() {
    const newText = text.trim();
    if (!newText) return;
    onsave(editSpeaker, secondsToTime(editSeconds), newText);
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
        <button onclick={() => { editSeconds = Math.max(0, editSeconds - 1); }}
          class="text-xs font-mono px-1.5 py-0.5 bg-surface border border-border rounded cursor-pointer hover:bg-surface-alt">-1s</button>
        <button onclick={() => { editSeconds = Math.max(0, editSeconds - 0.1); }}
          class="text-xs font-mono px-1.5 py-0.5 bg-surface border border-border rounded cursor-pointer hover:bg-surface-alt">-0.1</button>
        <input
          id="edit-time"
          type="text"
          value={secondsToTime(editSeconds)}
          oninput={(e) => {
            const parsed = parseTimeToSeconds((e.target as HTMLInputElement).value);
            if (!isNaN(parsed)) editSeconds = parsed;
          }}
          class="text-sm font-mono text-on-surface bg-surface border border-border rounded px-2 py-0.5 flex-1 text-center outline-none focus:border-primary tabular-nums"
        />
        <button onclick={() => { editSeconds += 0.1; }}
          class="text-xs font-mono px-1.5 py-0.5 bg-surface border border-border rounded cursor-pointer hover:bg-surface-alt">+0.1</button>
        <button onclick={() => { editSeconds += 1; }}
          class="text-xs font-mono px-1.5 py-0.5 bg-surface border border-border rounded cursor-pointer hover:bg-surface-alt">+1s</button>
        <button onclick={() => { editSeconds = videoTime; }}
          class="text-xs font-ui px-2 py-0.5 bg-primary-container/30 text-primary rounded cursor-pointer hover:bg-primary-container/50"
          title="Use current video time">
          Video ({secondsToTime(videoTime)})
        </button>
      </div>
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
