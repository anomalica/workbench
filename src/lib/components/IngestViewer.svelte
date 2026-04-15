<script lang="ts">
  import type { IngestDetail, User } from "$lib/api";
  import { submitReview } from "$lib/api";
  import { DocumentStore } from "$lib/document.svelte";
  import { parseTranscript, secondsToTime, speakerColour } from "$lib/transcript";
  import type { Segment } from "$lib/transcript";
  import SpeakerManager from "./SpeakerManager.svelte";
  import SegmentActions from "./SegmentActions.svelte";
  import SplitEditor from "./SplitEditor.svelte";
  import DiffViewer from "./DiffViewer.svelte";
  import MilkdownEditor from "./MilkdownEditor.svelte";
  import { marked } from "marked";

  let {
    ingest,
    sourceFile,
    user,
    onback,
  }: {
    ingest: IngestDetail;
    sourceFile: File | null;
    user: User | null;
    onback: () => void;
  } = $props();

  const doc = new DocumentStore();

  let rawMarkdown = $derived(ingest.raw_frontmatter + ingest.body);

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

  // Copyright: public/accessible records can show everything freely
  let isPublic = $derived(
    ingest.copyright_status === "public_domain" ||
    ingest.copyright_status === "open_licence" ||
    ingest.copyright_status === "publicly_accessible",
  );
  let accessGranted = $state(false);

  // File drop state (for dropping source files onto the left panel)
  let dragging = $state(false);
  let localSourceFile = $state<File | null>(sourceFile);

  // Who can see the body:
  // - public_domain / open_licence / publicly_accessible: everyone
  // - restricted / licensed: need hash verification or file drop
  let canShowBody = $derived(isPublic || accessGranted || !!localSourceFile);

  // Hash input for manual verification
  let hashInput = $state("");
  let hashError = $state<string | null>(null);

  async function verifyHash() {
    hashError = null;
    const hash = hashInput.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      hashError = "Enter a valid 64-character SHA-256 hash";
      return;
    }
    if (hash !== ingest.content_hash) {
      hashError = "Hash does not match this record";
      return;
    }
    accessGranted = true;
  }
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

  // For public records, try to fetch the source file from the backend
  $effect(() => {
    if (isPublic && !localSourceFile && !localSourceUrl) {
      loadingFile = true;
      fetch(`/api/sources/${ingest.content_hash}`)
        .then((res) => {
          if (res.ok) return res.blob();
          return null;
        })
        .then((blob) => {
          if (blob && blob.size > 0) {
            const url = URL.createObjectURL(blob);
            localSourceUrl = url;
            accessGranted = true;
          }
          loadingFile = false;
        })
        .catch(() => {
          loadingFile = false;
        });
    }
  });

  function handleFileDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    const file = e.dataTransfer?.files[0];
    if (file) {
      loadingFile = true;
      accessGranted = true;
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

  /** Replace annotation comment blocks with visible HTML elements. */
  function preprocessAnnotations(body: string): string {
    return body.replace(
      /<!--\s*([\s\S]*?)-->/g,
      (_, content) => {
        const trimmed = content.trim();
        // Page marker
        const pageMatch = trimmed.match(/file_page:\s*(\d+)/);
        if (pageMatch) {
          return `<div class="page-marker" data-file-page="${pageMatch[1]}"><span class="page-label">Page ${pageMatch[1]}</span></div>`;
        }
        // Image description
        const imageMatch = trimmed.match(/^image:\s*([\s\S]+)/);
        if (imageMatch) {
          const desc = imageMatch[1].trim();
          return `<div class="annotation annotation-image"><span class="annotation-label">Image</span> ${desc}</div>`;
        }
        // Redacted block
        const redactedMatch = trimmed.match(/^redacted:\s*\n\s*extent:\s*([\s\S]+)/);
        if (redactedMatch) {
          const extent = redactedMatch[1].trim();
          return `<div class="annotation annotation-redacted"><span class="annotation-label">Redacted</span> ${extent}</div>`;
        }
        // Unknown annotation - show as generic
        if (trimmed) {
          return `<div class="annotation">${trimmed}</div>`;
        }
        return "";
      },
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
        const label = type === "illegible" ? "illegible" : "redacted";
        const width = n * 2.5;
        return `<span class="redaction" title="${label}: ~${n} word${n > 1 ? "s" : ""}" style="width:${width}em"></span>`;
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
    if (!proseContainer || !isPdf || (!localSourceFile && !localSourceUrl)) return;

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

  // Auto-follow: sync the highlighted segment with video playback.
  // Skips irrelevant segments by seeking past them to the next relevant one.
  // Pauses briefly after manual seeking so clicks aren't overridden.
  $effect(() => {
    if (!hasTranscript || selected.size > 1 || splittingIndex !== null) return;
    if (view !== "ingest") return;
    if (autoFollowPaused) return;
    const t = currentTime;
    // Find the last relevant segment whose time is <= current playback time
    let best = -1;
    for (const seg of segments) {
      if (seg.irrelevant) continue;
      if (seg.seconds <= t) best = seg.index;
      else break;
    }
    if (best >= 0 && best !== activeSegment) {
      // Check if the current time falls within an irrelevant segment -
      // if so, seek past it to the next relevant one
      const currentSeg = segments.find(
        (s) => s.seconds <= t && segments.findIndex((n) => !n.irrelevant && n.seconds > t) >= 0,
      );
      if (currentSeg?.irrelevant) {
        const nextRelevant = segments.find((s) => !s.irrelevant && s.seconds > t);
        if (nextRelevant && ytPlayer && playerReady) {
          ytPlayer.seekTo(nextRelevant.seconds, true);
          best = nextRelevant.index;
        }
      }

      activeSegment = best;
      selected = new Set([best]);
      lastClicked = best;
      // Don't use seekTo here - that would set lastManualSeek and block us
      const el = document.querySelector(`[data-segment-index="${best}"]`);
      if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });

  // Submit review state
  let submitting = $state(false);
  let submitError = $state<string | null>(null);
  let showSubmitForm = $state(false);
  let reviewNotes = $state("");

  async function handleSubmit() {
    if (!user) return;
    submitting = true;
    submitError = null;
    const result = await submitReview(ingest.content_hash, doc.current, reviewNotes);
    submitting = false;
    if (result.ok) {
      showSubmitForm = false;
      reviewNotes = "";
      // Set the submitted content as the new baseline without resetting position
      doc.original = doc.current;
      doc.past = [];
      doc.future = [];
      localStorage.removeItem(doc.storageKey);
    } else {
      submitError = result.error ?? "Failed to submit";
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

  // Brief pause on auto-follow after manual interaction
  let autoFollowPaused = $state(false);
  let autoFollowTimer: ReturnType<typeof setTimeout> | null = null;

  function seekTo(seconds: number, segIndex: number) {
    activeSegment = segIndex;
    autoFollowPaused = true;
    if (autoFollowTimer) clearTimeout(autoFollowTimer);
    autoFollowTimer = setTimeout(() => { autoFollowPaused = false; }, 1000);
    if (ytPlayer && playerReady) {
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
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === " " && ytId && ytPlayer && playerReady) {
      e.preventDefault();
      if (ytPlayer.getPlayerState() === 1) ytPlayer.pauseVideo();
      else ytPlayer.playVideo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      if (doc.dirty && user) showSubmitForm = true;
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
  <div class="px-4 py-3 border-b border-border bg-surface-alt flex items-center gap-3">
    <button
      onclick={onback}
      class="p-2 rounded text-on-surface-muted hover:text-on-surface hover:bg-surface transition-colors cursor-pointer flex-none"
      title="Back to ingest list"
    >
      <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
      </svg>
    </button>
    <div class="w-px h-8 bg-border flex-none"></div>
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

  <!-- Status bar -->
  <div class="px-4 py-1.5 border-b border-border flex items-center gap-2 flex-none text-xs font-ui
    {doc.dirty ? 'bg-warning-container/30 text-on-warning-container' : user ? 'bg-success-container/30 text-on-success-container' : 'bg-surface-alt text-on-surface-muted'}">
    {#if doc.dirty}
      <svg class="w-3.5 h-3.5 flex-none" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <span>You have unsubmitted changes (saved locally)</span>
    {:else if user}
      <svg class="w-3.5 h-3.5 flex-none" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
      </svg>
      <span>Reviewing as {user.name}</span>
    {:else}
      <svg class="w-3.5 h-3.5 flex-none" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
      </svg>
      <span>View only - <a href="/api/auth/login" class="underline hover:text-on-surface">log in</a> to submit reviews</span>
    {/if}
  </div>

  <!-- Submit review modal -->
  {#if showSubmitForm}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div
      class="fixed inset-0 bg-ink/50 z-50 flex items-center justify-center p-4"
      onclick={() => { showSubmitForm = false; }}
    >
      <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
      <div
        class="bg-surface rounded-lg shadow-lg max-w-md w-full p-6"
        onclick={(e) => e.stopPropagation()}
      >
        <h3 class="font-ui font-semibold text-on-surface mb-4">Submit review</h3>

        {#if user}
          <div class="flex items-center gap-3 mb-4 p-3 bg-surface-alt rounded">
            {#if user.avatar_url}
              <img src={user.avatar_url} alt="" class="w-8 h-8 rounded-full" />
            {/if}
            <div>
              <div class="text-sm font-ui font-medium text-on-surface">{user.name}</div>
              <div class="text-xs text-on-surface-muted">{user.email}</div>
            </div>
          </div>
        {/if}

        <label class="block text-xs font-ui text-on-surface-secondary mb-1" for="review-notes">
          Notes (optional)
        </label>
        <textarea
          id="review-notes"
          bind:value={reviewNotes}
          placeholder="What did you change and why?"
          rows="3"
          class="w-full text-sm bg-surface border border-border rounded px-3 py-2
            text-on-surface outline-none focus:border-primary placeholder:text-on-surface-muted/50 resize-none"
        ></textarea>

        {#if submitError}
          <p class="text-xs text-error mt-2">{submitError}</p>
        {/if}

        <div class="flex items-center gap-2 mt-4">
          <div class="flex-1"></div>
          <button
            onclick={() => { showSubmitForm = false; }}
            class="text-xs font-ui text-on-surface-muted px-3 py-1.5 rounded cursor-pointer hover:text-on-surface"
          >Cancel</button>
          <button
            onclick={handleSubmit}
            disabled={submitting}
            class="text-xs font-ui font-medium px-4 py-1.5 bg-primary text-on-primary rounded cursor-pointer hover:bg-primary-hover"
          >
            {submitting ? "Submitting..." : "Submit review"}
          </button>
        </div>
      </div>
    </div>
  {/if}

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
        {:else if localSourceUrl}
          <div class="flex-none p-4">
            <video controls src={localSourceUrl} class="w-full rounded">
              <track kind="captions" />
            </video>
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
                <button
                  onclick={(e) => { e.stopPropagation(); doc.mergeAdjacentSpeakers(); }}
                  class="text-xs font-ui text-on-surface-muted hover:text-primary ml-auto cursor-pointer"
                  title="Merge adjacent segments by the same speaker"
                >merge adjacent</button>
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
        {#each [["ingest", "Ingest", "Rendered view"], ["edit", "Edit", "Rich markdown editor"], ["raw", "Raw", "Edit raw markdown with frontmatter"], ["diff", "Diff", "View changes from original"]] as [id, label, tip]}
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
          <!-- Global show/hide irrelevant toggle -->
          {#if view === "ingest" && hasTranscript}
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
              {doc.canUndo ? 'text-on-surface-secondary hover:bg-surface hover:text-on-surface' : 'text-on-surface-muted cursor-default'}"
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
              {doc.canRedo ? 'text-on-surface-secondary hover:bg-surface hover:text-on-surface' : 'text-on-surface-muted cursor-default'}"
            title="Redo (Ctrl+Shift+Z)"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M21 10H11a5 5 0 00-5 5v2M21 10l-4-4M21 10l-4 4" />
            </svg>
          </button>
          <button
            onclick={() => { if (user) showSubmitForm = true; else window.location.href = '/api/auth/login'; }}
            disabled={submitting || !doc.dirty}
            class="text-xs font-ui font-medium px-3 py-1 rounded cursor-pointer transition-colors
              {doc.dirty
                ? 'bg-primary text-on-primary hover:bg-primary-hover'
                : 'bg-on-surface-muted/10 text-on-surface-muted cursor-default'}"
            title={user ? "Submit review (Ctrl+S)" : "Log in to submit"}
          >
            {submitting ? "Submitting..." : user ? "Submit" : "Log in to submit"}
          </button>
          <button
            onclick={() => doc.discard()}
            disabled={!doc.dirty}
            class="text-xs font-ui px-3 py-1 rounded cursor-pointer transition-colors
              {doc.dirty
                ? 'text-error hover:bg-error-container/30'
                : 'text-on-surface-muted cursor-default'}"
            title="Discard all changes and revert to original"
          >
            Discard
          </button>
        </div>
      </div>

      <!-- Metadata panel (collapsible, shown in any view) -->
      {#if showMetadata}
        <div class="border-b border-border bg-surface-alt/50 px-4 py-3 flex-none">
          <pre class="text-xs font-mono text-on-surface whitespace-pre-wrap">{ingest.raw_frontmatter.replace(/^---\n/, "").replace(/---\n$/, "").trim()}</pre>
        </div>
      {/if}

      {#if !canShowBody}
        <!-- Restricted content: need hash verification -->
        <div class="flex-1 flex items-center justify-center p-8">
          <div class="text-center max-w-md">
            <div class="text-on-surface-muted mb-3">
              <svg class="w-10 h-10 mx-auto" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <h3 class="font-ui font-semibold text-on-surface mb-2">Restricted content</h3>
            <p class="text-sm text-on-surface-secondary mb-4">
              This record contains copyrighted material. Drop your source file onto the left panel, or enter the file's SHA-256 hash below.
            </p>

            <!-- Hash input form - password manager friendly -->
            <form
              class="mt-4 text-left"
              autocomplete="on"
              onsubmit={(e) => { e.preventDefault(); verifyHash(); }}
            >
              <!-- Hidden username field for password manager pairing -->
              <input
                type="hidden"
                name="username"
                autocomplete="username"
                value={ingest.public_hash}
              />
              <label class="block text-xs font-ui text-on-surface-secondary mb-1" for="hash-input">
                SHA-256 hash of the source file
              </label>
              <div class="flex gap-2">
                <input
                  id="hash-input"
                  type="password"
                  name="password"
                  autocomplete="current-password"
                  bind:value={hashInput}
                  placeholder="64-character hex hash"
                  class="flex-1 text-xs font-mono bg-surface border border-border rounded px-3 py-2
                    text-on-surface outline-none focus:border-primary placeholder:text-on-surface-muted/50"
                />
                <button
                  type="submit"
                  class="text-xs font-ui font-medium px-4 py-2 rounded cursor-pointer
                    bg-primary text-on-primary hover:bg-primary-hover"
                >
                  Verify
                </button>
              </div>
              {#if hashError}
                <p class="text-xs text-error mt-2">{hashError}</p>
              {/if}
            </form>

            <p class="text-xs text-on-surface-muted mt-4">
              Copyright status: {ingest.copyright_status}
              {#if ingest.frontmatter["copyright.holder"]}
                - {ingest.frontmatter["copyright.holder"]}
              {/if}
            </p>
          </div>
        </div>

      {:else if view === "diff"}
        <div class="flex-1 overflow-auto" data-scroll-sync onscroll={handleContentScroll}>
          <DiffViewer original={doc.original} modified={doc.current} />
        </div>

      {:else if view === "edit"}
        <div class="flex-1 flex flex-col min-h-0">
          <MilkdownEditor
            value={currentBody()}
            onchange={(md) => doc.editBody(md)}
          />
        </div>

      {:else if view === "raw"}
        <div class="flex-1 flex flex-col min-h-0">
          <textarea
            data-scroll-sync
            value={currentBody()}
            oninput={(e) => doc.editBody((e.target as HTMLTextAreaElement).value)}
            onscroll={handleContentScroll}
            class="flex-1 w-full resize-none bg-surface text-xs text-on-surface leading-relaxed
              p-4 font-mono outline-none border-none"
            spellcheck="false"
          ></textarea>
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
                    : 'border-border/50 hover:bg-primary-container/10'}"
                style:opacity={segment.irrelevant ? 0.4 : undefined}
                style:background={segment.irrelevant ? 'var(--color-surface-alt)' : undefined}
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
                    ontoggleirrelevant={() => {
                      const markingIrrelevant = !segment.irrelevant;
                      doc.setIrrelevant([{ speaker: segment.speaker, time: segment.time }], markingIrrelevant);
                      // If marking irrelevant during playback, seek to the next relevant segment
                      if (markingIrrelevant && ytPlayer && playerReady) {
                        const nextRelevant = segments.find((s) => !s.irrelevant && s.seconds > segment.seconds && s.index !== segment.index);
                        if (nextRelevant) {
                          ytPlayer.seekTo(nextRelevant.seconds, true);
                        }
                      }
                    }}
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
        {@const processedBody = preprocessAnnotations(currentBody())}
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
