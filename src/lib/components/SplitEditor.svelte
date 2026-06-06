<script lang="ts">
  import type { Segment } from "$lib/transcript";
  import {
    nextSpeakerName,
    secondsToTimecode,
    isSpecialSpeaker,
    SPEAKER_IRRELEVANT,
    SPEAKER_NARRATOR,
    SPEAKER_EXTERNAL_FOOTAGE,
    SPEAKER_GROUP,
  } from "$lib/transcript";
  import SpeakerDot from "./SpeakerDot.svelte";

  let {
    segment,
    allSegments,
    allSpeakers,
    namedSpeakers,
    onsplit,
    oncancel,
  }: {
    segment: Segment;
    allSegments: Segment[];
    allSpeakers: string[];
    /** Frontmatter-declared named speakers, ordered. Included even when they
     *  have no segment yet - otherwise a brand-new named speaker can't be
     *  picked for a part. */
    namedSpeakers: string[];
    /** Commit the split as N consecutive pieces, in order. */
    onsplit: (pieces: { speaker: string; time: string; text: string }[]) => void;
    oncancel: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  const initialText = segment.lines.join("\n");

  // The split model is a list of boundary character offsets (sorted, each
  // strictly inside the text) plus one speaker per resulting piece. Piece i
  // spans [boundaries[i-1] ?? 0, boundaries[i] ?? len); speakers has one more
  // entry than boundaries. The two arrays are always spliced in tandem so
  // their indices stay aligned.
  // svelte-ignore state_referenced_locally
  let boundaries = $state<number[]>([findMidpoint(initialText)]);
  // svelte-ignore state_referenced_locally
  let speakers = $state<string[]>([segment.speaker, nextSpeakerName(allSegments)]);
  let openPicker = $state<number | null>(null);

  let fullText = $derived(segment.lines.join("\n"));

  // The segment after this one, used to interpolate piece start times. A piece
  // that starts partway through the text gets a timestamp proportional to how
  // far into the text it begins, between this segment's start and the next's.
  let nextSegment = $derived(allSegments.find((s) => s.index === segment.index + 1) ?? null);

  let pieces = $derived.by(() => {
    const starts = [0, ...boundaries];
    const ends = [...boundaries, fullText.length];
    const start = segment.seconds;
    const total = fullText.length || 1;
    const canInterp = !!nextSegment && nextSegment.seconds > start;
    return starts.map((startChar, i) => {
      const text = fullText.slice(startChar, ends[i]);
      let time = segment.time;
      let estimate = false;
      if (i > 0 && canInterp) {
        const frac = Math.min(1, Math.max(0, startChar / total));
        const seconds = Math.round((start + frac * (nextSegment!.seconds - start)) * 10) / 10;
        time = secondsToTimecode(seconds);
        estimate = true;
      }
      return { startChar, text, speaker: speakers[i] ?? segment.speaker, time, estimate };
    });
  });

  let canCommit = $derived(pieces.length >= 2 && pieces.every((p) => p.text.trim().length > 0));

  // --- Picker groups (named > special > other), mirroring the per-sentence
  // menu. The part's own current speaker is dropped from its list. ---
  const SPECIALS = [SPEAKER_IRRELEVANT, SPEAKER_NARRATOR, SPEAKER_EXTERNAL_FOOTAGE, SPEAKER_GROUP];
  function namedFor(current: string): string[] {
    return namedSpeakers.filter((s) => s !== current);
  }
  function specialsFor(current: string): string[] {
    return SPECIALS.filter((s) => s !== current);
  }
  function othersFor(current: string): string[] {
    return allSpeakers.filter(
      (s) => s !== current && !namedSpeakers.includes(s) && !isSpecialSpeaker(s),
    );
  }

  function findMidpoint(text: string): number {
    return snapToWord(text, Math.floor(text.length / 2));
  }

  // Snap an index forward to the next word/line boundary so splits land
  // between words, not mid-token.
  function snapToWord(text: string, idx: number): number {
    const nextSpace = text.indexOf(" ", idx);
    const nextNewline = text.indexOf("\n", idx);
    if (nextNewline >= 0 && (nextNewline < nextSpace || nextSpace < 0)) return nextNewline + 1;
    if (nextSpace >= 0) return nextSpace + 1;
    return idx;
  }

  function selectPieceSpeaker(i: number, speaker: string) {
    speakers[i] = speaker;
    openPicker = null;
  }

  // Insert a boundary at charPos, splitting whichever piece contains it. The
  // new piece inherits that piece's speaker (a split doesn't reassign who is
  // speaking until you say so).
  function addBoundary(charPos: number) {
    if (charPos <= 0 || charPos >= fullText.length) return;
    if (boundaries.some((b) => Math.abs(b - charPos) < 1)) return;
    let k = 0;
    while (k < boundaries.length && boundaries[k] < charPos) k++;
    boundaries.splice(k, 0, charPos);
    speakers.splice(k + 1, 0, speakers[k]);
  }

  // Remove boundary k; its trailing piece merges back into the one above it,
  // which keeps its speaker.
  function removeBoundary(k: number) {
    if (k < 0 || k >= boundaries.length) return;
    boundaries.splice(k, 1);
    speakers.splice(k + 1, 1);
  }

  // Add a fresh split at the midpoint of the longest current piece.
  function addSplitAtLargestGap() {
    const starts = [0, ...boundaries];
    const ends = [...boundaries, fullText.length];
    let bestI = 0;
    let bestLen = -1;
    for (let i = 0; i < starts.length; i++) {
      const len = ends[i] - starts[i];
      if (len > bestLen) {
        bestLen = len;
        bestI = i;
      }
    }
    addBoundary(snapToWord(fullText, Math.floor((starts[bestI] + ends[bestI]) / 2)));
  }

  // Move the boundary nearest the clicked offset to that offset, clamped to
  // stay strictly between its neighbours. With a single boundary this is the
  // old "click to reposition the split" behaviour.
  function moveNearestBoundary(globalPos: number) {
    if (boundaries.length === 0) return;
    if (globalPos <= 0 || globalPos >= fullText.length) return;
    let k = 0;
    let best = Infinity;
    for (let j = 0; j < boundaries.length; j++) {
      const d = Math.abs(boundaries[j] - globalPos);
      if (d < best) {
        best = d;
        k = j;
      }
    }
    const lo = (boundaries[k - 1] ?? 0) + 1;
    const hi = (boundaries[k + 1] ?? fullText.length) - 1;
    boundaries[k] = Math.min(hi, Math.max(lo, globalPos));
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

    moveNearestBoundary(offsetBase + offset);
  }

  function commitSplit() {
    const out = pieces
      .map((p) => ({ speaker: p.speaker, time: p.time, text: p.text.trim() }))
      .filter((p) => p.text.length > 0);
    if (out.length < 2) return;
    onsplit(out);
  }
</script>

{#snippet pickerMenu(pieceIndex: number, current: string)}
  <div class="absolute left-0 top-full mt-1 z-20 bg-surface-raised border border-border rounded shadow-lg py-1 min-w-40 max-h-48 overflow-auto">
    {#each namedFor(current) as sp}
      <button onclick={() => selectPieceSpeaker(pieceIndex, sp)}
        class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface">
        <SpeakerDot speaker={sp} inline />{sp}
      </button>
    {/each}
    {#if namedFor(current).length > 0 && specialsFor(current).length > 0}
      <div class="border-t border-border my-1"></div>
    {/if}
    {#each specialsFor(current) as sp}
      <button onclick={() => selectPieceSpeaker(pieceIndex, sp)}
        class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface-muted italic">
        <SpeakerDot speaker={sp} inline />{sp}
      </button>
    {/each}
    {#if othersFor(current).length > 0}
      <div class="border-t border-border my-1"></div>
      {#each othersFor(current) as sp}
        <button onclick={() => selectPieceSpeaker(pieceIndex, sp)}
          class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface-muted">
          <SpeakerDot speaker={sp} inline />{sp}
        </button>
      {/each}
    {/if}
    <div class="border-t border-border mt-1 pt-1">
      <button onclick={() => selectPieceSpeaker(pieceIndex, nextSpeakerName(allSegments))}
        class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-primary">+ New speaker</button>
    </div>
  </div>
{/snippet}

<div class="ring-2 ring-primary/30 rounded-lg overflow-hidden">
  {#each pieces as piece, i (i)}
    {#if i > 0}
      <!-- Boundary between the part above and this one: line + remove control -->
      <div class="flex items-center gap-2 px-3 py-1">
        <div class="flex-1 h-0.5 rounded bg-primary"></div>
        <button
          onclick={() => removeBoundary(i - 1)}
          class="flex-none text-on-surface-muted hover:text-error cursor-pointer p-0.5"
          title="Remove this split (merge with the part above)"
          aria-label="Remove split"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        <div class="flex-1 h-0.5 rounded bg-primary"></div>
      </div>
    {/if}

    <div class="px-4 {i === 0 ? 'pt-3 pb-2' : 'pt-1 pb-2 bg-primary-container/10'}">
      <!-- Part header: speaker picker + (interpolated) timestamp -->
      <div class="flex items-center gap-2 mb-1">
        <SpeakerDot speaker={piece.speaker} />
        <div class="relative">
          <button
            onclick={() => { openPicker = openPicker === i ? null : i; }}
            class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline"
            title="Change speaker for this part"
          >
            {piece.speaker}
          </button>
          {#if openPicker === i}
            {@render pickerMenu(i, piece.speaker)}
          {/if}
        </div>
        <span
          class="text-xs font-mono text-on-surface-muted"
          title={piece.estimate
            ? "Estimated from the split position - check and fine-tune in Edit"
            : "Original segment start"}
        >
          {piece.time.replace(/^00:/, "")}{#if piece.estimate}<span class="text-warning ml-1" title="Estimated timestamp">~</span>{/if}
        </span>
      </div>
      <!-- Part text: click to move the nearest split -->
      <div
        class="text-sm text-on-surface leading-relaxed pl-4 whitespace-pre-wrap cursor-text select-none"
        onclick={(e) => handleTextClick(e, piece.startChar)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') e.preventDefault(); }}
        role="button"
        tabindex="0"
        aria-label="Part {i + 1} - click to move the nearest split"
      >{piece.text}</div>
    </div>
  {/each}

  <!-- Action bar -->
  <div class="flex items-center gap-2 px-3 py-2 border-t border-border bg-surface-alt">
    <button
      onclick={addSplitAtLargestGap}
      class="text-xs font-ui font-medium px-2 py-1 bg-surface border border-border rounded cursor-pointer hover:bg-surface-alt text-on-surface"
      title="Add another split in the longest part"
    >
      + Split
    </button>
    <div class="flex-1"></div>
    <button onclick={oncancel}
      class="text-xs text-on-surface-muted cursor-pointer hover:text-on-surface px-2 py-1"
      title="Cancel split">Cancel</button>
    <button onclick={commitSplit} disabled={!canCommit}
      class="text-xs font-ui font-medium px-3 py-1 bg-primary text-on-primary rounded cursor-pointer hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed"
      title="Confirm the split">
      Split into {pieces.length}
    </button>
  </div>
</div>
