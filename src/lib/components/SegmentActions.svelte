<script lang="ts">
  import type { Segment } from "$lib/transcript";
  import { secondsToTime, nextSpeakerName, speakerColour } from "$lib/transcript";

  let {
    segment,
    allSegments,
    allSpeakers,
    isFirst,
    isLast,
    videoTime,
    onchangespeaker,
    onchangetime,
    onmergeup,
    onmergedown,
    onstartsplit,
  }: {
    segment: Segment;
    allSegments: Segment[];
    allSpeakers: string[];
    isFirst: boolean;
    isLast: boolean;
    videoTime: number;
    onchangespeaker: (newSpeaker: string) => void;
    onchangetime: (newTime: string) => void;
    onmergeup: () => void;
    onmergedown: () => void;
    onstartsplit: () => void;
  } = $props();

  let showSpeakerPicker = $state(false);
  let showTimePicker = $state(false);
  let editTime = $state(0);

  function openTimePicker() {
    editTime = segment.seconds;
    showTimePicker = true;
    showSpeakerPicker = false;
     }

  function commitTime() {
    onchangetime(secondsToTime(editTime));
    showTimePicker = false;
  }

</script>

<!-- Header row: same layout as the static version, but interactive -->
<div class="flex items-center gap-2 mb-1">
  <span
    class="w-2 h-2 rounded-full flex-none"
    style="background-color: {speakerColour(segment.speaker)}"
  ></span>

  <!-- Speaker: clickable -->
  <div class="relative">
    <button
      onclick={(e) => { e.stopPropagation(); showSpeakerPicker = !showSpeakerPicker; showTimePicker = false; }}
      class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline"
      title="Change speaker"
    >
      {segment.speaker}
    </button>
    {#if showSpeakerPicker}
      <div class="absolute left-0 top-full mt-1 z-20 bg-surface-raised border border-border rounded shadow-lg py-1 min-w-40 max-h-48 overflow-auto">
        {#each allSpeakers as sp}
          {#if sp !== segment.speaker}
            <button
              onclick={(e) => { e.stopPropagation(); onchangespeaker(sp); showSpeakerPicker = false; }}
              class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer
                hover:bg-primary-container/30 text-on-surface"
            >
              <span class="inline-block w-2 h-2 rounded-full mr-2 align-middle" style="background-color: {speakerColour(sp)}"></span>
              {sp}
            </button>
          {/if}
        {/each}
        <div class="border-t border-border mt-1 pt-1">
          <button
            onclick={(e) => { e.stopPropagation(); onchangespeaker(nextSpeakerName(allSegments)); showSpeakerPicker = false; }}
            class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer
              hover:bg-primary-container/30 text-primary"
          >
            + New speaker
          </button>
        </div>
      </div>
    {/if}
  </div>

  <!-- Time: clickable -->
  <div class="relative">
    <button
      onclick={(e) => { e.stopPropagation(); openTimePicker(); }}
      class="text-xs text-on-surface-muted font-mono cursor-pointer hover:underline"
      title="Change timestamp"
    >
      {segment.time.replace(/^00:/, "")}
    </button>
    {#if showTimePicker}
      <div class="absolute left-0 top-full mt-1 z-20 bg-surface-raised border border-border rounded shadow-lg p-3 min-w-52">
        <div class="flex items-center gap-1.5 mb-2">
          <button onclick={(e) => { e.stopPropagation(); editTime = Math.max(0, editTime - 1); }}
            class="text-xs font-mono px-1.5 py-0.5 bg-surface border border-border rounded cursor-pointer hover:bg-surface-alt">-1s</button>
          <button onclick={(e) => { e.stopPropagation(); editTime = Math.max(0, editTime - 0.1); }}
            class="text-xs font-mono px-1.5 py-0.5 bg-surface border border-border rounded cursor-pointer hover:bg-surface-alt">-0.1</button>
          <span class="text-sm font-mono text-on-surface tabular-nums flex-1 text-center">{secondsToTime(editTime)}</span>
          <button onclick={(e) => { e.stopPropagation(); editTime += 0.1; }}
            class="text-xs font-mono px-1.5 py-0.5 bg-surface border border-border rounded cursor-pointer hover:bg-surface-alt">+0.1</button>
          <button onclick={(e) => { e.stopPropagation(); editTime += 1; }}
            class="text-xs font-mono px-1.5 py-0.5 bg-surface border border-border rounded cursor-pointer hover:bg-surface-alt">+1s</button>
        </div>
        <div class="flex items-center gap-2">
          <button onclick={(e) => { e.stopPropagation(); editTime = Math.floor(videoTime); }}
            class="text-xs font-ui px-2 py-1 bg-primary-container/30 text-primary rounded cursor-pointer hover:bg-primary-container/50 flex-1">
            Use video ({secondsToTime(videoTime)})
          </button>
          <button onclick={(e) => { e.stopPropagation(); commitTime(); }}
            class="text-xs font-ui font-medium px-2 py-1 bg-primary text-on-primary rounded cursor-pointer hover:bg-primary-hover">Set</button>
          <button onclick={(e) => { e.stopPropagation(); showTimePicker = false; }}
            class="text-xs text-on-surface-muted cursor-pointer hover:text-on-surface" title="Cancel">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    {/if}
  </div>

  {#if segment.irrelevant}
    <span class="text-xs text-on-surface-muted italic">irrelevant</span>
  {/if}

  <!-- Action icons at the end of the row -->
  <div class="ml-auto flex items-center gap-0.5">
    {#if !isFirst}
      <button onclick={(e) => { e.stopPropagation(); onmergeup(); }}
        class="p-0.5 rounded cursor-pointer text-on-surface-muted/50 hover:text-on-surface hover:bg-surface-alt transition-colors"
        title="Merge into segment above">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7" />
        </svg>
      </button>
    {/if}
    {#if !isLast}
      <button onclick={(e) => { e.stopPropagation(); onmergedown(); }}
        class="p-0.5 rounded cursor-pointer text-on-surface-muted/50 hover:text-on-surface hover:bg-surface-alt transition-colors"
        title="Merge into segment below">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
    {/if}
    {#if segment.lines.length > 1}
      <button onclick={(e) => { e.stopPropagation(); onstartsplit(); }}
        class="p-0.5 rounded cursor-pointer text-on-surface-muted/50 hover:text-on-surface hover:bg-surface-alt transition-colors"
        title="Split this segment">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" d="M12 2v20M2 12h4M18 12h4" />
        </svg>
      </button>
    {/if}
  </div>
</div>
