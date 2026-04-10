<script lang="ts">
  import type { Segment } from "$lib/transcript";
  import { nextSpeakerName, speakerColour } from "$lib/transcript";

  let {
    segment,
    allSegments,
    allSpeakers,
    onsplit,
    oncancel,
  }: {
    segment: Segment;
    allSegments: Segment[];
    allSpeakers: string[];
    onsplit: (charPos: number, aboveSpeaker: string, belowSpeaker: string, belowTime: string) => void;
    oncancel: () => void;
  } = $props();

  let fullText = $derived(segment.lines.join("\n"));

  // Default split at roughly the midpoint, snapped to a word boundary
  let splitCharPos = $state(findMidpoint(segment.lines.join("\n")));
  let aboveSpeaker = $state(segment.speaker);
  let belowSpeaker = $state(nextSpeakerName(allSegments));

  let topText = $derived(fullText.slice(0, splitCharPos));
  let bottomText = $derived(fullText.slice(splitCharPos));
  let showAbovePicker = $state(false);
  let showBelowPicker = $state(false);

  function findMidpoint(text: string): number {
    const mid = Math.floor(text.length / 2);
    // Snap to the nearest space or newline after the midpoint
    const nextSpace = text.indexOf(" ", mid);
    const nextNewline = text.indexOf("\n", mid);
    if (nextNewline >= 0 && (nextNewline < nextSpace || nextSpace < 0)) return nextNewline + 1;
    if (nextSpace >= 0) return nextSpace + 1;
    return mid;
  }

  function handleTextClick(e: MouseEvent, offsetBase: number) {
    const container = e.currentTarget as HTMLElement;
    let range: Range | null = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(e.clientX, e.clientY);
    } else if ((document as any).caretPositionFromPoint) {
      const pos = (document as any).caretPositionFromPoint(e.clientX, e.clientY);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
      }
    }
    if (!range) return;

    let offset = 0;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      if (node === range.startContainer) {
        offset += range.startOffset;
        break;
      }
      offset += node.textContent?.length ?? 0;
    }

    const globalPos = offsetBase + offset;
    if (globalPos > 0 && globalPos < fullText.length) {
      splitCharPos = globalPos;
    }
  }

  function selectSpeaker(which: "above" | "below", speaker: string) {
    if (which === "above") {
      aboveSpeaker = speaker;
      showAbovePicker = false;
    } else {
      belowSpeaker = speaker;
      showBelowPicker = false;
    }
  }

  function commitSplit() {
    if (topText.trim() && bottomText.trim()) {
      onsplit(splitCharPos, aboveSpeaker, belowSpeaker, segment.time);
    }
  }
</script>

<div class="ring-2 ring-primary/30 rounded-lg overflow-hidden">
  <!-- Top segment -->
  <div class="px-4 pt-3 pb-2">
    <!-- Header -->
    <div class="flex items-center gap-2 mb-1">
      <span class="w-2 h-2 rounded-full flex-none" style="background-color: {speakerColour(aboveSpeaker)}"></span>
      <div class="relative">
        <button
          onclick={() => { showAbovePicker = !showAbovePicker; showBelowPicker = false; }}
          class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline"
          title="Change speaker for top half"
        >
          {aboveSpeaker}
        </button>
        {#if showAbovePicker}
          <div class="absolute left-0 top-full mt-1 z-20 bg-surface-raised border border-border rounded shadow-lg py-1 min-w-40 max-h-48 overflow-auto">
            {#each allSpeakers as sp}
              <button onclick={() => selectSpeaker("above", sp)}
                class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface">
                <span class="inline-block w-2 h-2 rounded-full mr-2 align-middle" style="background-color: {speakerColour(sp)}"></span>{sp}
              </button>
            {/each}
            <div class="border-t border-border mt-1 pt-1">
              <button onclick={() => selectSpeaker("above", nextSpeakerName(allSegments))}
                class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-primary">+ New speaker</button>
            </div>
          </div>
        {/if}
      </div>
      <span class="text-xs text-on-surface-muted font-mono">{segment.time.replace(/^00:/, "")}</span>
    </div>
    <!-- Top text: clickable to move split up -->
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div
      class="text-sm text-on-surface leading-relaxed pl-4 whitespace-pre-wrap cursor-text select-none"
      onclick={(e) => handleTextClick(e, 0)}
    >{topText}</div>
  </div>

  <!-- Split divider -->
  <div class="flex items-center gap-2 px-3 py-1">
    <div class="flex-1 h-0.5 rounded bg-primary"></div>
  </div>

  <!-- Bottom segment -->
  <div class="px-4 pt-1 pb-2 bg-primary-container/10">
    <!-- Header -->
    <div class="flex items-center gap-2 mb-1">
      <span class="w-2 h-2 rounded-full flex-none" style="background-color: {speakerColour(belowSpeaker)}"></span>
      <div class="relative">
        <button
          onclick={() => { showBelowPicker = !showBelowPicker; showAbovePicker = false; }}
          class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline"
          title="Change speaker for bottom half"
        >
          {belowSpeaker}
        </button>
        {#if showBelowPicker}
          <div class="absolute left-0 top-full mt-1 z-20 bg-surface-raised border border-border rounded shadow-lg py-1 min-w-40 max-h-48 overflow-auto">
            {#each allSpeakers as sp}
              <button onclick={() => selectSpeaker("below", sp)}
                class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface">
                <span class="inline-block w-2 h-2 rounded-full mr-2 align-middle" style="background-color: {speakerColour(sp)}"></span>{sp}
              </button>
            {/each}
            <div class="border-t border-border mt-1 pt-1">
              <button onclick={() => selectSpeaker("below", nextSpeakerName(allSegments))}
                class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-primary">+ New speaker</button>
            </div>
          </div>
        {/if}
      </div>
    </div>
    <!-- Bottom text: clickable to move split down -->
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div
      class="text-sm text-on-surface leading-relaxed pl-4 whitespace-pre-wrap cursor-text select-none"
      onclick={(e) => handleTextClick(e, splitCharPos)}
    >{bottomText}</div>
  </div>

  <!-- Action bar -->
  <div class="flex items-center gap-2 px-3 py-2 border-t border-border bg-surface-alt">
    <div class="flex-1"></div>
    <button onclick={oncancel}
      class="text-xs text-on-surface-muted cursor-pointer hover:text-on-surface px-2 py-1"
      title="Cancel split">Cancel</button>
    <button onclick={commitSplit}
      class="text-xs font-ui font-medium px-3 py-1 bg-primary text-on-primary rounded cursor-pointer hover:bg-primary-hover"
      title="Confirm split at this position">Split</button>
  </div>
</div>
