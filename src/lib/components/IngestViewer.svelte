<script lang="ts">
  import type { IngestDetail } from "$lib/api";
  import { saveIngest } from "$lib/api";
  import { DocumentStore } from "$lib/document.svelte";
  import { parseTranscript, secondsToTime, speakerColour } from "$lib/transcript";
  import type { Segment } from "$lib/transcript";
  import SpeakerManager from "./SpeakerManager.svelte";
  import SegmentActions from "./SegmentActions.svelte";
  import SplitEditor from "./SplitEditor.svelte";
  import DiffViewer from "./DiffViewer.svelte";
  import { marked } from "marked";

  let {
    ingest,
    sourceFile,
  }: {
    ingest: IngestDetail;
    sourceFile: File | null;
  } = $props();

  const doc = new DocumentStore();

  let rawMarkdown = $derived(
    [
      "---",
      ...Object.entries(ingest.frontmatter).map(([k, v]) => `${k}: ${v}`),
      "---",
      ingest.body,
    ].join("\n"),
  );

  $effect(() => {
    doc.load(rawMarkdown, ingest.content_hash);
  });

  let currentBody = $derived(() => {
    const match = doc.current.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
    return match ? match[1] : doc.current;
  });
  let segments = $derived(parseTranscript(currentBody()));
  let hasTranscript = $derived(segments.length > 0 && segments[0].speaker !== "");

  // View mode
  let view = $state<"ingest" | "edit" | "diff" | "raw">("ingest");

  // Scroll sync between views: save fraction on scroll, restore on view switch
  let scrollFraction = 0;

  function handleContentScroll(e: Event) {
    const el = e.currentTarget as HTMLElement;
    const max = el.scrollHeight - el.clientHeight;
    if (max > 0) scrollFraction = el.scrollTop / max;
  }

  function restoreScroll() {
    requestAnimationFrame(() => {
      const el = document.querySelector("[data-scroll-sync]") as HTMLElement;
      if (el) {
        const max = el.scrollHeight - el.clientHeight;
        el.scrollTop = scrollFraction * max;
      }
    });
  }

  // Restore scroll position whenever the view tab changes
  $effect(() => {
    // Touch `view` to subscribe to changes
    void view;
    restoreScroll();
  });

  // Metadata parsed from frontmatter (read-only display)
  let showMetadata = $state(false);

  // Source
  let isPdf = $derived(ingest.frontmatter.source_type === "pdf");
  let isWeb = $derived(ingest.frontmatter.source_type === "web");

  // File drop state (for dropping source files onto the left panel)
  let dragging = $state(false);
  let localSourceFile = $state<File | null>(sourceFile);
  let localSourceUrl = $state<string | null>(null);
  let loadingFile = $state(false);

  // Create/revoke blob URL when file changes
  $effect(() => {
    if (localSourceFile) {
      const url = URL.createObjectURL(localSourceFile);
      localSourceUrl = url;
      return () => URL.revokeObjectURL(url);
    } else {
      localSourceUrl = null;
    }
  });

  function handleFileDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    const file = e.dataTransfer?.files[0];
    if (file) {
      loadingFile = true;
      // Use requestAnimationFrame to let the spinner render before
      // the browser starts processing the file
      requestAnimationFrame(() => {
        localSourceFile = file;
      });
    }
  }

  // Web ingests without a source file don't need a separate left panel
  let singleColumn = $derived(isWeb && !localSourceFile);

  // PDF page sync
  let pdfPage = $state(1);
  let pdfSrc = $derived(
    localSourceUrl && isPdf
      ? `${localSourceUrl}#toolbar=0&navpanes=0&page=${pdfPage}`
      : null,
  );

  /** Replace file_page YAML blocks with visible, clickable page markers.
   *  The block may contain other fields like printed_page alongside file_page. */
  function preprocessPageMarkers(body: string): string {
    return body.replace(
      /\n---\n((?:.*\n)*?file_page:\s*(\d+)\n(?:.*\n)*?)---\n/g,
      '\n<div class="page-marker" data-file-page="$2"><span class="page-label">Page $2</span></div>\n',
    );
  }

  let pdfNavTimer: ReturnType<typeof setTimeout> | null = null;

  /** Render {{redacted: ~N words}} and {{illegible}} markers as styled
   *  inline blocks. Each redacted word is shown as a fixed-width bar. */
  function renderRedactions(html: string): string {
    return html.replace(
      /\{\{(redacted|illegible)(?::\s*~(\d+)\s*words?)?\}\}/g,
      (_, type, count) => {
        const n = parseInt(count || "1", 10);
        const bars = Array.from({ length: n }, () =>
          '<span class="redacted-word"></span>',
        ).join("");
        const label = type === "illegible" ? "illegible" : "redacted";
        return `<span class="redaction" title="${label}: ~${n} word${n > 1 ? "s" : ""}">${bars}</span>`;
      },
    );
  }

  function navigatePdfToPage(page: number) {
    if (!localSourceFile || page === pdfPage) return;
    if (pdfNavTimer) clearTimeout(pdfNavTimer);
    pdfNavTimer = setTimeout(() => {
      pdfPage = page;
      // Create fresh URL to force reload. Don't set loadingFile -
      // the old PDF stays visible until the new one loads over it.
      if (localSourceUrl) URL.revokeObjectURL(localSourceUrl);
      localSourceUrl = URL.createObjectURL(localSourceFile!);
    }, 300);
  }

  // Prose container ref for page sync
  let proseContainer: HTMLDivElement | undefined = $state();

  // Set up click handler and IntersectionObserver for page markers.
  // Runs as $effect so it re-initialises when content changes.
  $effect(() => {
    if (!proseContainer || !isPdf || !localSourceFile) return;

    // Wait a tick for {@html} to render into the DOM
    const timer = setTimeout(() => {
      if (!proseContainer) return;
      const markers = proseContainer.querySelectorAll(".page-marker[data-file-page]");

      // Click handler
      function handleClick(e: Event) {
        const marker = (e.target as HTMLElement).closest(".page-marker");
        if (marker) {
          const pg = parseInt((marker as HTMLElement).dataset.filePage ?? "1", 10);
          navigatePdfToPage(pg);
        }
      }
      proseContainer!.addEventListener("click", handleClick);

      // Scroll observer
      let observer: IntersectionObserver | null = null;
      if (markers.length > 0) {
        observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (entry.isIntersecting) {
                const pg = parseInt((entry.target as HTMLElement).dataset.filePage ?? "1", 10);
                navigatePdfToPage(pg);
              }
            }
          },
          { root: proseContainer!, rootMargin: "-10% 0px -70% 0px" },
        );
        for (const m of markers) observer.observe(m);
      }

      // Cleanup stored for effect teardown
      cleanupPageSync = () => {
        proseContainer?.removeEventListener("click", handleClick);
        observer?.disconnect();
      };
    }, 50);

    return () => {
      clearTimeout(timer);
      cleanupPageSync?.();
    };
  });

  let cleanupPageSync: (() => void) | null = null;

  function youtubeId(url: string | undefined): string | null {
    if (!url) return null;
    const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
  }
  let ytId = $derived(youtubeId(ingest.frontmatter.source_url));

  // YouTube player
  let ytPlayer: YT.Player | null = null;
  let playerReady = $state(false);
  let currentTime = $state(0);
  let activeSegment = $state(-1);
  let timeInterval: ReturnType<typeof setInterval> | null = null;

  // Speaker selection - drives both transcript filtering and merging.
  // Empty set means no filter (show all speakers).
  let selectedSpeakers = $state(new Set<string>());

  // Irrelevant visibility
  let hideIrrelevant = $state(true);

  // Segment selection (for the Mark irrelevant action)
  let selected = $state(new Set<number>());
  let lastClicked = $state(-1);

  // Split editing mode
  let splittingIndex = $state<number | null>(null);

  // Save state
  let saving = $state(false);
  let saveError = $state<string | null>(null);

  async function handleSave() {
    saving = true;
    saveError = null;
    const ok = await saveIngest(ingest.content_hash, doc.current);
    saving = false;
    if (ok) {
      doc.discard();
      doc.load(doc.current, ingest.content_hash);
    } else {
      saveError = "Failed to save";
    }
  }

  // Derived: visible segments after filters
  let visibleSegments = $derived(
    segments
      .filter((s) => !hideIrrelevant || !s.irrelevant)
      .filter((s) => selectedSpeakers.size === 0 || selectedSpeakers.has(s.speaker)),
  );

  // Derived: speakers visible in current filter mode
  let visibleSpeakerIds = $derived(new Set(
    segments
      .filter((s) => !hideIrrelevant || !s.irrelevant)
      .map((s) => s.speaker),
  ));

  let irrelevantCount = $derived(segments.filter((s) => s.irrelevant).length);

  // Ordered list of unique speaker names for the speaker picker
  let allSpeakerNames = $derived((): string[] => {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const seg of segments) {
      if (seg.speaker && !seen.has(seg.speaker)) {
        seen.add(seg.speaker);
        names.push(seg.speaker);
      }
    }
    return names;
  });

  // True if every selected segment is already irrelevant. Used to flip
  // the toggle action: irrelevant -> relevant, otherwise relevant -> irrelevant.
  let selectedAllIrrelevant = $derived(() => {
    if (selected.size === 0) return false;
    const sel = segments.filter((s) => selected.has(s.index));
    return sel.length > 0 && sel.every((s) => s.irrelevant);
  });

  function initYouTubePlayer(id: string) {
    if (typeof YT === "undefined" || !YT.Player) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
      (window as any).onYouTubeIframeAPIReady = () => createPlayer(id);
    } else {
      createPlayer(id);
    }
  }

  function createPlayer(id: string) {
    ytPlayer = new YT.Player("yt-player", {
      videoId: id,
      playerVars: { rel: 0, modestbranding: 1 },
      events: {
        onReady: () => {
          playerReady = true;
          timeInterval = setInterval(() => {
            if (ytPlayer) currentTime = ytPlayer.getCurrentTime();
          }, 250);
        },
      },
    });
  }

  function seekTo(seconds: number, segIndex: number) {
    activeSegment = segIndex;
    if (ytPlayer && playerReady) {
      // seekTo preserves current playback state - if playing, keeps
      // playing; if paused, stays paused. The allowSeekAhead flag
      // matters for the initial seek before the video is cued.
      ytPlayer.seekTo(seconds, true);
    }
  }

  function formatTime(time: string): string {
    return time.replace(/^00:/, "");
  }

  // Selection handling
  function handleSegmentClick(segment: Segment, e: MouseEvent) {
    if (e.ctrlKey || e.metaKey) {
      // Toggle individual
      const next = new Set(selected);
      if (next.has(segment.index)) next.delete(segment.index);
      else next.add(segment.index);
      selected = next;
      lastClicked = segment.index;
    } else if (e.shiftKey && lastClicked >= 0) {
      // Range select
      const from = Math.min(lastClicked, segment.index);
      const to = Math.max(lastClicked, segment.index);
      const next = new Set(selected);
      for (const s of segments) {
        if (s.index >= from && s.index <= to) next.add(s.index);
      }
      selected = next;
    } else {
      // Normal click - seek video and select just this segment
      seekTo(segment.seconds, segment.index);
      selected = new Set([segment.index]);
      lastClicked = segment.index;
    }
  }

  function markSelectedIrrelevant(irrelevant: boolean) {
    const targets = segments
      .filter((s) => selected.has(s.index))
      .map((s) => ({ speaker: s.speaker, time: s.time }));
    if (targets.length > 0) {
      doc.setIrrelevant(targets, irrelevant);
      selected = new Set();
    }
  }

  function toggleSelectedIrrelevance() {
    // If everything selected is already irrelevant, mark relevant.
    // Otherwise (some or all relevant) mark everything irrelevant.
    markSelectedIrrelevant(!selectedAllIrrelevant());
  }

  // Edit operations
  function renameSpeaker(oldId: string, newName: string) {
    doc.renameSpeaker(oldId, newName);
    // If the renamed speaker was selected, follow it to the new name
    if (selectedSpeakers.has(oldId)) {
      const next = new Set(selectedSpeakers);
      next.delete(oldId);
      next.add(newName);
      selectedSpeakers = next;
    }
  }

  function mergeSpeakers(sourceIds: string[], targetName: string) {
    doc.mergeSpeakers(sourceIds, targetName);
    // Replace the merged speakers with just the target in the selection
    const next = new Set<string>();
    next.add(targetName);
    selectedSpeakers = next;
  }

  // Stable ordered list of speaker IDs (by first appearance). Used for
  // shift+click range selection so the range follows visible order.
  let speakerOrder = $derived((): string[] => {
    const seen = new Set<string>();
    const order: string[] = [];
    for (const seg of segments) {
      if (seg.speaker && !seen.has(seg.speaker)) {
        seen.add(seg.speaker);
        order.push(seg.speaker);
      }
    }
    return order;
  });

  let lastClickedSpeaker = $state<string | null>(null);

  function handleSpeakerSelection(id: string, e?: MouseEvent) {
    if (e && e.shiftKey && lastClickedSpeaker) {
      // Shift+click: range select between last clicked and this one
      const order = speakerOrder();
      const fromIdx = order.indexOf(lastClickedSpeaker);
      const toIdx = order.indexOf(id);
      if (fromIdx >= 0 && toIdx >= 0) {
        const lo = Math.min(fromIdx, toIdx);
        const hi = Math.max(fromIdx, toIdx);
        const next = new Set(selectedSpeakers);
        for (let i = lo; i <= hi; i++) next.add(order[i]);
        selectedSpeakers = next;
      }
    } else if (e && (e.ctrlKey || e.metaKey)) {
      // Ctrl+click: toggle individual (multi-select)
      const next = new Set(selectedSpeakers);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      selectedSpeakers = next;
    } else {
      // Plain click: replace selection (or deselect if already the only one)
      if (selectedSpeakers.size === 1 && selectedSpeakers.has(id)) {
        selectedSpeakers = new Set();
      } else {
        selectedSpeakers = new Set([id]);
      }
    }
    lastClickedSpeaker = id;
  }

  function clearSpeakerSelection() {
    selectedSpeakers = new Set();
    // Scroll back to the active or last-selected segment
    requestAnimationFrame(() => {
      const idx = selected.size > 0 ? [...selected][0] : activeSegment;
      if (idx >= 0) {
        const el = document.querySelector(`[data-segment-index="${idx}"]`);
        if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    });
  }

  function toggleSpeakerIrrelevant(speakerId: string) {
    // If any of the speaker's segments are relevant, mark all irrelevant.
    // Otherwise (everything already irrelevant) mark all relevant.
    const speakerSegments = segments.filter((s) => s.speaker === speakerId);
    const anyRelevant = speakerSegments.some((s) => !s.irrelevant);
    const targets = speakerSegments.map((s) => ({ speaker: s.speaker, time: s.time }));
    if (targets.length > 0) {
      doc.setIrrelevant(targets, anyRelevant);
    }
  }

  // Keyboard shortcuts
  function handleKeydown(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement) return;
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      if (doc.dirty) handleSave();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
      e.preventDefault();
      doc.undo();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === "y" || (e.key === "z" && e.shiftKey))) {
      e.preventDefault();
      doc.redo();
    } else if (e.key === "Escape") {
      selected = new Set();
      selectedSpeakers = new Set();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "a" && view === "ingest" && hasTranscript) {
      e.preventDefault();
      selected = new Set(visibleSegments.map((s) => s.index));
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && view === "ingest" && hasTranscript) {
      e.preventDefault();
      navigateSegment(e.key === "ArrowDown" ? 1 : -1, e.shiftKey);
    } else if (e.key === "Delete" && selected.size > 0) {
      toggleSelectedIrrelevance();
    }
  }

  function navigateSegment(direction: 1 | -1, extendSelection: boolean) {
    // Find current position based on activeSegment or last selected
    const currentIdx = activeSegment >= 0 ? activeSegment : lastClicked;
    const currentPos = visibleSegments.findIndex((s) => s.index === currentIdx);

    let nextPos: number;
    if (currentPos < 0) {
      nextPos = direction === 1 ? 0 : visibleSegments.length - 1;
    } else {
      nextPos = currentPos + direction;
    }

    if (nextPos < 0 || nextPos >= visibleSegments.length) return;

    const nextSegment = visibleSegments[nextPos];

    if (extendSelection) {
      // Shift+Arrow extends selection
      const next = new Set(selected);
      next.add(nextSegment.index);
      selected = next;
    } else {
      selected = new Set([nextSegment.index]);
    }

    activeSegment = nextSegment.index;
    lastClicked = nextSegment.index;
    seekTo(nextSegment.seconds, nextSegment.index);

    // Scroll the segment into view
    const el = document.querySelector(`[data-segment-index="${nextSegment.index}"]`);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  $effect(() => {
    if (ytId) initYouTubePlayer(ytId);
    window.addEventListener("keydown", handleKeydown);
    return () => {
      if (timeInterval) clearInterval(timeInterval);
      ytPlayer = null;
      playerReady = false;
      window.removeEventListener("keydown", handleKeydown);
    };
  });
</script>

<div class="flex flex-col h-full"
  ondragover={(e) => e.preventDefault()}
  ondrop={(e) => e.preventDefault()}>
  <!-- Title bar -->
  <div class="px-4 py-3 border-b border-border bg-surface-alt flex items-start justify-between gap-4">
    <div class="flex-1 min-w-0">
      <h2 class="font-ui font-semibold text-on-surface truncate">
        {ingest.frontmatter.title ?? "Untitled"}
      </h2>
      <div class="flex gap-3 mt-1 text-xs text-on-surface-muted font-ui">
        <span>{ingest.frontmatter.source_type?.toUpperCase()}</span>
        <span>{ingest.frontmatter.date}</span>
        {#if hasTranscript}
          <span>{segments.length} segments</span>
        {/if}
        {#if doc.dirty}
          <span class="text-warning font-medium">unsaved changes</span>
        {/if}
      </div>
    </div>
  </div>

  <div class="flex-1 flex min-h-0">
    {#if singleColumn}
      <!-- Single-column layout for web ingests -->
    {:else}
      <!-- Left panel -->
      <div class="w-1/2 border-r border-border flex flex-col min-h-0">
        <div class="px-3 py-2 bg-surface-alt border-b border-border flex-none">
          <span class="text-xs font-ui font-medium text-on-surface-secondary uppercase">Original</span>
        </div>

        {#if pdfSrc && isPdf}
          {#if loadingFile}
            <div class="flex-1 flex items-center justify-center text-on-surface-muted">
              <div class="text-center">
                <svg class="w-6 h-6 mx-auto mb-2 animate-spin text-primary" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                </svg>
                <p class="text-xs font-ui">Loading PDF...</p>
              </div>
            </div>
          {/if}
          <iframe
            src={pdfSrc}
            class="flex-1 w-full border-none {loadingFile ? 'hidden' : ''}"
            title="Source PDF"
            onload={() => { loadingFile = false; }}
          ></iframe>
        {:else if localSourceUrl}
          <div class="flex-none p-4">
            <video controls src={localSourceUrl} class="w-full rounded">
              <track kind="captions" />
            </video>
          </div>
        {:else if ytId}
          <div class="flex-none p-4">
            <div id="yt-player" class="w-full aspect-video rounded"></div>
            <a
              href={ingest.frontmatter.source_url}
              target="_blank"
              rel="noopener"
              class="text-xs text-on-surface-muted hover:text-primary mt-2 inline-block break-all"
            >
              {ingest.frontmatter.source_url}
            </a>
          </div>
        {:else}
          <!-- Drop target fills all available space -->
          <div
            class="flex-1 flex items-center justify-center text-sm text-center transition-colors cursor-default
              {dragging ? 'bg-primary-container/20 text-primary' : 'text-on-surface-muted'}"
            ondragover={(e) => { e.preventDefault(); dragging = true; }}
            ondragleave={() => { dragging = false; }}
            ondrop={handleFileDrop}
          >
            <p class="p-8">{dragging ? "Drop file here" : "Drop a source file here to view alongside the ingest"}</p>
          </div>
        {/if}

        {#if hasTranscript}
          <div class="flex-1 overflow-auto border-t border-border min-h-0">
            <details open class="group">
              <summary class="px-4 py-2 bg-surface-alt cursor-pointer flex items-center gap-2 select-none sticky top-0 z-10">
                <svg class="w-3 h-3 text-on-surface-muted transition-transform group-open:rotate-90" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M6 4l8 6-8 6V4z" />
                </svg>
                <span class="text-xs font-ui font-medium text-on-surface-secondary uppercase">Speakers</span>
                <span class="text-xs text-on-surface-muted ml-auto">{visibleSpeakerIds.size}</span>
              </summary>
              <div class="px-3 py-2">
                <SpeakerManager
                  {segments}
                  {selectedSpeakers}
                  onselect={handleSpeakerSelection}
                  onrename={renameSpeaker}
                  onmerge={mergeSpeakers}
                  ontoggleirrelevant={toggleSpeakerIrrelevant}
                />
              </div>
            </details>
          </div>
        {/if}
    </div>
    {/if}

    <!-- Right panel (or full-width for web ingests) -->
    <div class="{singleColumn ? 'w-full' : 'w-1/2'} flex flex-col">
      <!-- Source URL bar for single-column web ingests -->
      {#if singleColumn && ingest.frontmatter.source_url}
        <div class="px-4 py-2 bg-surface-alt border-b border-border flex items-center gap-2 flex-none">
          <span class="text-xs font-ui font-medium text-on-surface-secondary uppercase flex-none">Source</span>
          <a
            href={ingest.frontmatter.source_url}
            target="_blank"
            rel="noopener"
            class="text-xs text-primary hover:underline truncate"
          >
            {ingest.frontmatter.source_url}
          </a>
        </div>
      {/if}
      <!-- Panel header with view tabs and controls -->
      <div class="px-4 py-2 bg-surface-alt border-b border-border flex items-center gap-1">
        {#each [["ingest", "Ingest", "View formatted content"], ["edit", "Edit", "Edit content as markdown"], ["diff", "Diff", "View changes from original"], ["raw", "Raw", "View raw markdown (read-only)"]] as [id, label, tip]}
          <button
            onclick={() => { view = id as typeof view; }}
            class="text-xs font-ui font-medium px-2 py-1 rounded transition-colors cursor-pointer
              {view === id ? 'bg-primary text-on-primary' : 'text-on-surface-secondary hover:bg-surface'}"
            title={tip}
          >
            {label}
          </button>
        {/each}

        <button
          onclick={() => { showMetadata = !showMetadata; }}
          class="text-xs font-ui px-2 py-1 rounded cursor-pointer transition-colors
            {showMetadata ? 'bg-primary/10 text-primary' : 'text-on-surface-muted hover:text-on-surface hover:bg-surface'}"
          title="Toggle metadata"
        >
          Meta
        </button>

        <div class="ml-auto flex items-center gap-1">
          <!-- Transcript-specific controls -->
          {#if view === "ingest" && hasTranscript}
            {#if selected.size > 0}
              <span class="text-xs font-ui text-on-surface-muted px-1">{selected.size} selected</span>
              <button
                onclick={toggleSelectedIrrelevance}
                class="cursor-pointer p-1 rounded transition-colors
                  {selectedAllIrrelevant()
                    ? 'text-on-surface-muted hover:bg-success-container/30 hover:text-success'
                    : 'text-on-surface-secondary hover:bg-error-container/30 hover:text-error'}"
                title={selectedAllIrrelevant()
                  ? 'Currently irrelevant - click to mark relevant'
                  : 'Currently relevant - click to mark irrelevant'}
              >
                {#if selectedAllIrrelevant()}
                  <!-- Eye-off: current state is hidden/irrelevant -->
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                {:else}
                  <!-- Eye: current state is visible/relevant -->
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                {/if}
              </button>
              <button
                onclick={() => { selected = new Set(); }}
                class="cursor-pointer p-1 rounded text-on-surface-muted hover:bg-surface hover:text-on-surface transition-colors"
                title="Clear selection (Esc)"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path stroke-linecap="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <div class="w-px h-5 bg-border mx-1"></div>
            {/if}

            <!-- Show/hide irrelevant chip -->
            {#if irrelevantCount > 0}
              <button
                onclick={() => { hideIrrelevant = !hideIrrelevant; }}
                class="flex items-center gap-1 cursor-pointer pl-1.5 pr-2 py-0.5 rounded-full transition-colors
                  {hideIrrelevant
                    ? 'text-on-surface-muted hover:bg-surface'
                    : 'bg-warning-container text-on-warning-container hover:opacity-80'}"
                title={hideIrrelevant
                  ? `${irrelevantCount} irrelevant segments hidden - click to show`
                  : `Showing ${irrelevantCount} irrelevant segments - click to hide`}
              >
                {#if hideIrrelevant}
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                {:else}
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                {/if}
                <span class="text-xs font-ui font-medium tabular-nums">{irrelevantCount}</span>
              </button>
            {/if}
          {/if}

          <!-- Undo / Redo / Save / Discard - always visible, greyed when disabled -->
          <div class="w-px h-4 bg-border mx-1"></div>
          <button
            onclick={() => doc.undo()}
            disabled={!doc.canUndo}
            class="p-1 rounded transition-colors cursor-pointer
              {doc.canUndo ? 'text-on-surface-secondary hover:bg-surface hover:text-on-surface' : 'text-on-surface-muted/30 cursor-default'}"
            title="Undo (Ctrl+Z)"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M3 10h10a5 5 0 015 5v2M3 10l4-4M3 10l4 4" />
            </svg>
          </button>
          <button
            onclick={() => doc.redo()}
            disabled={!doc.canRedo}
            class="p-1 rounded transition-colors cursor-pointer
              {doc.canRedo ? 'text-on-surface-secondary hover:bg-surface hover:text-on-surface' : 'text-on-surface-muted/30 cursor-default'}"
            title="Redo (Ctrl+Shift+Z)"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M21 10H11a5 5 0 00-5 5v2M21 10l-4-4M21 10l-4 4" />
            </svg>
          </button>
          <button
            onclick={handleSave}
            disabled={saving || !doc.dirty}
            class="text-xs font-ui font-medium px-2 py-1 rounded cursor-pointer transition-colors
              {doc.dirty ? 'bg-primary text-on-primary hover:bg-primary-hover' : 'text-on-surface-muted/30 cursor-default'}"
            title="Save changes to file (Ctrl+S)"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            onclick={() => doc.discard()}
            disabled={!doc.dirty}
            class="text-xs font-ui px-2 py-1 rounded cursor-pointer transition-colors
              {doc.dirty ? 'text-error hover:bg-error-container/30' : 'text-on-surface-muted/30 cursor-default'}"
            title="Discard all changes and revert to original"
          >
            Discard
          </button>
        </div>
      </div>

      <!-- Metadata panel (collapsible, shown in any view) -->
      {#if showMetadata}
        <div class="border-b border-border bg-surface-alt/50 px-4 py-3 flex-none">
          <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
            {#each Object.entries(ingest.frontmatter) as [key, value]}
              {#if value && key !== "speakers"}
                <span class="font-ui font-medium text-on-surface-muted text-right">{key}</span>
                <span class="text-on-surface font-mono break-all">{value}</span>
              {/if}
            {/each}
          </div>
        </div>
      {/if}

      {#if view === "diff"}
        <div class="flex-1 overflow-auto" data-scroll-sync onscroll={handleContentScroll}>
          <DiffViewer original={doc.original} modified={doc.current} />
        </div>

      {:else if view === "edit"}
        <div class="flex-1 flex flex-col min-h-0">
          <textarea
            data-scroll-sync
            value={currentBody()}
            oninput={(e) => doc.editBody((e.target as HTMLTextAreaElement).value)}
            onscroll={handleContentScroll}
            class="flex-1 w-full resize-none bg-surface text-sm text-on-surface leading-relaxed
              p-4 font-mono outline-none border-none"
            spellcheck="false"
          ></textarea>
        </div>

      {:else if view === "raw"}
        <div class="flex-1 overflow-auto p-4" data-scroll-sync onscroll={handleContentScroll}>
          <pre class="text-xs font-mono text-on-surface whitespace-pre-wrap break-words">{doc.current}</pre>
        </div>

      {:else if hasTranscript}
        {#if selectedSpeakers.size > 0}
          <div class="px-3 py-1.5 bg-primary-container/20 border-b border-border flex items-center gap-2 flex-wrap">
            <span class="text-xs font-ui text-on-surface-secondary">Filtered to:</span>
            {#each [...selectedSpeakers] as speakerId}
              <span class="text-xs font-ui font-medium text-primary inline-flex items-center gap-1">
                <span class="w-2 h-2 rounded-full" style="background-color: {speakerColour(speakerId)}"></span>
                {speakerId}
              </span>
            {/each}
            <button
              onclick={clearSpeakerSelection}
              class="text-xs text-on-surface-muted hover:text-on-surface cursor-pointer ml-auto"
            >clear</button>
          </div>
        {/if}
        <div class="flex-1 overflow-auto" data-scroll-sync onscroll={handleContentScroll}>
          {#each visibleSegments as segment, vi}
            {@const isSelected = selected.has(segment.index)}
            {#if splittingIndex === segment.index}
              <!-- Split editing mode: replaces the segment in place -->
              <div class="border-b border-border/50">
                <SplitEditor
                  {segment}
                  allSegments={segments}
                  allSpeakers={allSpeakerNames()}
                  onsplit={(charPos, aboveSp, belowSp, belowTime) => {
                    doc.splitSegment(segment.speaker, segment.time, charPos, aboveSp, belowSp, belowTime);
                    splittingIndex = null;
                  }}
                  oncancel={() => { splittingIndex = null; }}
                />
              </div>
            {:else}
              <div
                data-segment-index={segment.index}
                class="px-4 py-3 border-b transition-colors cursor-pointer
                  {isSelected
                    ? 'bg-primary-container/30 border-primary/30'
                    : activeSegment === segment.index
                      ? 'bg-primary-container/15 border-border/50'
                      : segment.irrelevant
                        ? 'opacity-50 bg-surface-alt/50 border-border/50'
                        : 'border-border/50 hover:bg-primary-container/10'}"
                role="button"
                tabindex="0"
                onclick={(e) => handleSegmentClick(segment, e)}
                onkeydown={(e) => { if (e.key === 'Enter') handleSegmentClick(segment, e as unknown as MouseEvent); }}
              >
                {#if isSelected && selected.size === 1}
                  <SegmentActions
                    {segment}
                    allSegments={segments}
                    allSpeakers={allSpeakerNames()}
                    isFirst={vi === 0}
                    isLast={vi === visibleSegments.length - 1}
                    videoTime={currentTime}
                    onchangespeaker={(sp) => doc.changeSegmentSpeaker(segment.speaker, segment.time, sp)}
                    onchangetime={(t) => doc.changeSegmentTime(segment.speaker, segment.time, t)}
                    onmergeup={() => doc.mergeSegmentUp(segment.speaker, segment.time)}
                    onmergedown={() => doc.mergeSegmentDown(segment.speaker, segment.time)}
                    onstartsplit={() => { splittingIndex = segment.index; }}
                  />
                {:else}
                  <div class="flex items-center gap-2 mb-1 h-6">
                    <span
                      class="w-2 h-2 rounded-full flex-none"
                      style="background-color: {speakerColour(segment.speaker)}"
                    ></span>
                    <span class="text-xs font-ui font-medium text-primary">{segment.speaker}</span>
                    <span class="text-xs text-on-surface-muted font-mono">{formatTime(segment.time)}</span>
                    {#if segment.irrelevant}
                      <span class="text-xs text-on-surface-muted italic">irrelevant</span>
                    {/if}
                  </div>
                {/if}

                <div class="text-sm text-on-surface leading-relaxed pl-4">
                  {#each segment.lines as line}
                    <p class="mb-0.5">{line}</p>
                  {/each}
                </div>
              </div>
            {/if}
          {/each}
        </div>

      {:else}
        {@const processedBody = isPdf ? preprocessPageMarkers(currentBody()) : currentBody()}
        {@const renderedHtml = renderRedactions(marked.parse(processedBody) as string)}
        <div
          bind:this={proseContainer}
          data-scroll-sync
          onscroll={handleContentScroll}
          class="flex-1 overflow-auto px-8 py-6 prose
            {singleColumn ? 'mx-auto' : 'max-w-none'}
            text-on-surface prose-headings:text-on-surface prose-a:text-primary
            prose-img:rounded prose-img:max-w-full prose-hr:border-border
            prose-p:leading-relaxed prose-li:leading-relaxed"
        >
          {@html renderedHtml}
        </div>
      {/if}
    </div>
  </div>
</div>
