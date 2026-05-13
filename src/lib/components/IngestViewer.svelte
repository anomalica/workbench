<script lang="ts">
  import type { IngestDetail, User } from "$lib/api";
  import { submitReview } from "$lib/api";
  import { DocumentStore } from "$lib/document.svelte";
  import { parseTranscript, secondsToTime, findActiveSegmentForTime, extractFrontmatterSpeakers, isSegmentIrrelevant, isSpecialSpeaker, nextSpeakerName, groupSegmentsBySpeaker, orderedNamedSpeakers, SPEAKER_IRRELEVANT, SPEAKER_NARRATOR, SPEAKER_EXTERNAL_FOOTAGE } from "$lib/transcript";
  import { nextSegmentBoundary, singleEndForCurrentTime } from "$lib/playback";
  import type { Segment } from "$lib/transcript";
  import SpeakerManager from "./SpeakerManager.svelte";
  import SplitEditor from "./SplitEditor.svelte";
  import EditSegmentDialog from "./EditSegmentDialog.svelte";
  import SpeakerDot from "./SpeakerDot.svelte";
  import DiffViewer from "./DiffViewer.svelte";
  import MilkdownEditor from "./MilkdownEditor.svelte";
  import EpubViewer from "./EpubViewer.svelte";
  import { marked } from "marked";
  import yaml from "js-yaml";

  let {
    ingest,
    sourceFile,
    user,
    reviewed = false,
    onreviewedchange,
    onback,
  }: {
    ingest: IngestDetail;
    sourceFile: File | null;
    user: User | null;
    reviewed?: boolean;
    onreviewedchange?: (hash: string, reviewed: boolean) => void;
    onback: () => void;
  } = $props();

  const doc = new DocumentStore();

  let rawMarkdown = $derived(ingest.raw_frontmatter + ingest.body);

  // Only reload when we're actually looking at a different ingest.
  // Without this guard, writes inside doc.load (to $state fields) can
  // retrigger the effect and wipe localStorage-restored state.
  let lastLoadedHash = "";
  let loadEffectCount = 0;
  $effect(() => {
    const hash = ingest.content_hash;
    const md = rawMarkdown;
    loadEffectCount++;
    const run = loadEffectCount;
    if (hash === lastLoadedHash) {
      console.log(`[load-effect #${run}] skipped (hash unchanged: ${hash.slice(0, 12)}...)`);
      return;
    }
    lastLoadedHash = hash;
    const key = `workbench:doc:${hash}`;
    const hasSaved = localStorage.getItem(key) !== null;
    console.log(`[load-effect #${run}] loading`, { hash: hash.slice(0, 12), hasSaved, mdLen: md.length });
    doc.load(md, hash);
    console.log(`[load-effect #${run}] after load`, {
      dirty: doc.dirty,
      currentLen: doc.current.length,
      pastCount: doc.past.length,
    });
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
  let isAudio = $derived(ingest.frontmatter.source_type === "audio");
  let isVideo = $derived(ingest.frontmatter.source_type === "video");
  let isEbook = $derived(ingest.frontmatter.source_type === "ebook");

  // Copyright: public/accessible records can show everything freely
  let isPublic = $derived(
    ingest.copyright_status === "public_domain" ||
    ingest.copyright_status === "open_licence" ||
    ingest.copyright_status === "publicly_accessible",
  );
  let accessGranted = $state(false);

  // File drop state (for dropping source files onto the left panel)
  let dragging = $state(false);
  let sourceFileInput = $state<HTMLInputElement | null>(null);
  // svelte-ignore state_referenced_locally
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

  // For public records, try to fetch the source file from the backend.
  // Skip if there's a YouTube embed (the video is more useful than the extracted audio).
  //
  // Key resolution for web records uses a fidelity ladder. The ingester
  // produces up to three sibling artefacts: a "single_file" capture with
  // every external asset inlined as data URIs (renders identically to
  // the original page under sandbox=""), a "page_render" PDF, and the
  // raw post-render HTML pointed at by source_hash. We prefer the
  // single_file capture, then the PDF, then the raw HTML. Other source
  // types fall back to source_hash or content_hash directly.
  //
  // The naive frontmatter parser on the backend collapses the snapshots
  // list incorrectly (treats it as one nested object), so we reparse the
  // raw frontmatter block with js-yaml and pull the list ourselves.
  interface Snapshot {
    role: string;
    hash: string;
    content_type: string;
  }

  let parsedFrontmatter = $derived.by((): Record<string, unknown> => {
    const raw = ingest.raw_frontmatter || "";
    const stripped = raw.replace(/^---\n/, "").replace(/\n---\n?$/, "");
    try {
      const out = yaml.load(stripped);
      return (out && typeof out === "object") ? out as Record<string, unknown> : {};
    } catch {
      return {};
    }
  });

  let snapshots = $derived.by((): Snapshot[] => {
    const raw = parsedFrontmatter.snapshots;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (s): s is Snapshot =>
        s != null && typeof s === "object" && typeof (s as Snapshot).hash === "string",
    );
  });

  function pickSnapshot(snaps: Snapshot[]): Snapshot | null {
    const byRole = (r: string) => snaps.find((s) => s.role === r);
    return byRole("single_file") || byRole("page_render") || null;
  }

  let preferredSnapshot = $derived(pickSnapshot(snapshots));

  let sourceKey = $derived(
    (preferredSnapshot?.hash || ingest.frontmatter.source_hash || "")
      .replace(/^sha256:/, "") || ingest.content_hash,
  );

  // What kind of file are we fetching? Drives the left-pane renderer
  // choice (PDF panel vs HTML iframe). Falls back to the source_type
  // for legacy records that have no snapshots list.
  let sourceContentType = $derived(
    preferredSnapshot?.content_type ||
      (isPdf ? "application/pdf" : isWeb ? "text/html" : ""),
  );

  $effect(() => {
    if (isPublic && !localSourceFile && !localSourceUrl && !ytId) {
      loadingFile = true;
      fetch(`/api/sources/${sourceKey}`)
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

  function acceptFile(file: File) {
    loadingFile = true;
    accessGranted = true;
    // Use requestAnimationFrame to let the spinner render before
    // the browser starts processing the file
    requestAnimationFrame(() => {
      localSourceFile = file;
    });
  }

  function handleFileDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    const file = e.dataTransfer?.files[0];
    if (file) acceptFile(file);
  }

  function handleFilePick(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) acceptFile(file);
    input.value = "";
  }

  // No left panel when there's nothing useful to show in it:
  // - web records with no archived/dropped source (URL bar only)
  // - ebook records without a dropped source file (the reviewer has to
  //   provide the .epub themselves; EPUBs are licensed material so we
  //   don't auto-fetch them)
  // Once the source is attached, two-pane shows the rendered EPUB
  // (flattenEpubToHtml -> single sandbox="" iframe) next to the ingest.
  let singleColumn = $derived(
    (isWeb && !localSourceFile && !localSourceUrl) ||
      (isEbook && !localSourceFile),
  );

  // PDF page sync
  let pdfPage = $state(1);
  let pdfSrc = $derived(
    localSourceUrl && isPdf
      ? `${localSourceUrl}#toolbar=0&navpanes=0&page=${pdfPage}`
      : null,
  );

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[c] as string));
  }

  /** Replace annotation comment blocks with visible HTML elements.
   *
   *  Per architecture/record-format.md, structural-only annotations
   *  (chapter, chapter_title, printed_page) are suppressed in the body -
   *  they drive navigation, not prose. Speaker annotations are also
   *  suppressed here; the transcript view consumes them via parseTranscript.
   */
  /** Pair `![alt](url)` with an immediately-following italic-only
   *  paragraph and rewrite as <figure><figcaption>. Web records commonly
   *  emit captions as plain italic prose on the next line, which marked
   *  otherwise renders at body-text size on its own paragraph. Detect
   *  and group them so the caption ends up styled correctly.
   *
   *  Patterns matched (must be a paragraph entirely consisting of the
   *  italic-wrapped caption, no other prose on the same line):
   *
   *    ![alt](url)
   *
   *    *Caption text here.*
   */
  function pairImageCaptions(body: string): string {
    return body.replace(
      /^(!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\))\s*\n\n\*([^*\n][^*]*?)\*\s*(?=\n|$)/gm,
      (_, _img, alt, url, caption) =>
        `<figure class="ingest-figure caption-figure"><img src="${url}" alt="${escapeHtml(alt)}" loading="lazy" /><figcaption>${escapeHtml(caption)}</figcaption></figure>`,
    );
  }

  function preprocessAnnotations(body: string): string {
    const recordHash = ingest.content_hash;
    body = pairImageCaptions(body);
    return body.replace(
      /<!--\s*([\s\S]*?)-->/g,
      (_, content) => {
        const trimmed = content.trim();
        // Page marker (PDFs)
        const pageMatch = trimmed.match(/^file_page:\s*(\d+)/);
        if (pageMatch) {
          return `<div class="page-marker" data-file-page="${pageMatch[1]}"><span class="page-label">Page ${pageMatch[1]}</span></div>`;
        }
        // Structural markers: suppress in body (used for nav, not display)
        if (/^(chapter|chapter_title|printed_page|speaker)\s*:/.test(trimmed)) {
          return "";
        }
        // Image with extracted file: render as actual <img> from the media endpoint
        const imageFileMatch = trimmed.match(
          /^image\s*:\s*\n\s*file\s*:\s*([0-9a-f]{12}\.[a-z]{3,4})(?:\s*\n\s*alt\s*:\s*"?([^"\n]*)"?)?/,
        );
        if (imageFileMatch) {
          const file = imageFileMatch[1];
          const alt = (imageFileMatch[2] || "").trim();
          const src = `/api/ingests/${recordHash}/media/${file}`;
          return `<figure class="ingest-figure"><img src="${src}" alt="${escapeHtml(alt)}" loading="lazy" /></figure>`;
        }
        // Image description (no extracted file)
        const imageDescMatch = trimmed.match(/^image\s*:\s*([\s\S]+)/);
        if (imageDescMatch) {
          const desc = imageDescMatch[1].trim();
          return `<div class="annotation annotation-image"><span class="annotation-label">Image</span> ${escapeHtml(desc)}</div>`;
        }
        // Redacted block
        const redactedMatch = trimmed.match(/^redacted\s*:\s*\n\s*extent\s*:\s*([\s\S]+)/);
        if (redactedMatch) {
          const extent = redactedMatch[1].trim();
          return `<div class="annotation annotation-redacted"><span class="annotation-label">Redacted</span> ${escapeHtml(extent)}</div>`;
        }
        // Unknown annotation: keep visible so reviewers can spot stray markers
        if (trimmed) {
          return `<div class="annotation">${escapeHtml(trimmed)}</div>`;
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
  let playbackMode = $state<"auto" | "single">("auto");
  let singleSegmentEnd = -1; // seconds at which to pause (used in interval as backup)
  let singleCheckEnabled = false; // delayed flag to avoid stale-time false pauses
  let singlePauseTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelSinglePauseTimer() {
    if (singlePauseTimer) {
      clearTimeout(singlePauseTimer);
      singlePauseTimer = null;
    }
  }

  function schedulePauseAt(boundarySeconds: number, fromSeconds: number) {
    cancelSinglePauseTimer();
    const durationMs = Math.max(0, (boundarySeconds - fromSeconds) * 1000);
    singlePauseTimer = setTimeout(() => {
      if (ytPlayer && playerReady) ytPlayer.pauseVideo();
      singleSegmentEnd = -1;
      singleCheckEnabled = false;
      singlePauseTimer = null;
    }, durationMs);
  }

  // Speaker selection - for merging and UI highlight.
  let selectedSpeakers = $state(new Set<string>());
  // Speaker filter - intentional filter via colour dot click.
  let filteredSpeakers = $state(new Set<string>());

  // Irrelevant visibility
  let hideIrrelevant = $state(true);

  // Segment selection (for the Mark irrelevant action)
  let selected = $state(new Set<number>());
  let lastClicked = $state(-1);

  // Split editing mode
  let splittingIndex = $state<number | null>(null);
  let editingIndex = $state<number | null>(null);
  // Which picker is open, if any. "sentence" uses segment.index as key;
  // "group" uses the first segment of the group's index as key.
  let speakerPicker = $state<null | { kind: "sentence" | "group" | "multi"; key: number }>(null);

  // Close the speaker picker on outside click
  $effect(() => {
    if (speakerPicker === null) return;
    const handler = () => { speakerPicker = null; };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  });

  // Drop filter/selection entries for speakers that no longer exist
  // (e.g. after rename, merge, or assign).
  $effect(() => {
    const existing = new Set(segments.map((s) => s.speaker));
    const prunedFilter = new Set([...filteredSpeakers].filter((id) => existing.has(id)));
    if (prunedFilter.size !== filteredSpeakers.size) filteredSpeakers = prunedFilter;
    const prunedSelection = new Set([...selectedSpeakers].filter((id) => existing.has(id)));
    if (prunedSelection.size !== selectedSpeakers.size) selectedSpeakers = prunedSelection;
  });

  // Auto-follow: sync the highlighted segment with video playback.
  // In "auto" mode: focus follows continuously, skipping irrelevant segments.
  // In "single" mode: highlight stays on the clicked segment; the interval handles pausing.
  $effect(() => {
    if (!hasTranscript || selected.size > 1 || splittingIndex !== null) return;
    if (view !== "ingest") return;
    if (autoFollowPaused) return;
    if (playbackMode === "single") return;
    const t = currentTime;

    let best = findActiveSegmentForTime(segments, t);
    if (best >= 0 && best !== activeSegment) {
      // If the current time falls within an irrelevant segment, skip to the next relevant one
      const bestSeg = segments.find((s) => s.index === best);
      if (bestSeg && isSegmentIrrelevant(bestSeg)) {
        const nextRelevant = segments.find((s) => !isSegmentIrrelevant(s) && s.seconds > t);
        if (nextRelevant && ytPlayer && playerReady) {
          ytPlayer.seekTo(nextRelevant.seconds, true);
          best = nextRelevant.index;
        }
      }

      activeSegment = best;
      selected = new Set([best]);
      lastClicked = best;
      const el = document.querySelector(`[data-segment-index="${best}"]`);
      if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });

  // Submit review state
  let submitting = $state(false);
  // Approve is a no-op empty commit on top of an existing reviewed record,
  // so disable when there are no changes and we already reviewed this one.
  let alreadyApproved = $derived(!doc.dirty && reviewed);
  let submitDisabled = $derived(submitting || !user || alreadyApproved);
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
      // Backend auto-marks reviewed on submit; mirror it locally.
      onreviewedchange?.(ingest.content_hash, true);
    } else {
      submitError = result.error ?? "Failed to submit";
    }
  }

  // Derived: visible segments after filters
  let visibleSegments = $derived(
    segments
      .filter((s) => !hideIrrelevant || !isSegmentIrrelevant(s))
      .filter((s) => filteredSpeakers.size === 0 || filteredSpeakers.has(s.speaker)),
  );

  // Derived: visible segments grouped by consecutive same-speaker runs
  let visibleGroups = $derived(groupSegmentsBySpeaker(visibleSegments));

  // Derived: speakers visible in current filter mode
  let visibleSpeakerIds = $derived(new Set(
    segments
      .filter((s) => !hideIrrelevant || !isSegmentIrrelevant(s))
      .map((s) => s.speaker),
  ));

  let irrelevantCount = $derived(segments.filter((s) => isSegmentIrrelevant(s)).length);

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

  // Named speakers from the current document's frontmatter
  let currentFrontmatter = $derived(() => {
    const match = doc.current.match(/^(---\n[\s\S]*?\n---\n)/);
    return match ? match[1] : "";
  });
  let namedSpeakers = $derived(extractFrontmatterSpeakers(currentFrontmatter()));
  let namedSpeakersOrdered = $derived(orderedNamedSpeakers(segments, namedSpeakers));

  function addNamedSpeaker(name: string) {
    if (!namedSpeakers.includes(name)) {
      doc.updateFrontmatterSpeakers([...namedSpeakers, name]);
    }
  }

  function removeNamedSpeaker(name: string) {
    doc.updateFrontmatterSpeakers(namedSpeakers.filter((n) => n !== name));
  }

  function renameNamedSpeaker(oldName: string, newName: string) {
    doc.updateFrontmatterSpeakers(namedSpeakers.map((n) => (n === oldName ? newName : n)));
  }

  // True if every selected segment is already irrelevant. Used to flip
  // the toggle action: irrelevant -> relevant, otherwise relevant -> irrelevant.
  let selectedAllIrrelevant = $derived(
    selected.size > 0 &&
      segments.filter((s) => selected.has(s.index)).every((s) => isSegmentIrrelevant(s)),
  );

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
            if (!ytPlayer) return;
            const t = ytPlayer.getCurrentTime();
            currentTime = t;
            // Single-mode pause: check directly against the live player time
            if (singleCheckEnabled && singleSegmentEnd > 0 && t >= singleSegmentEnd) {
              ytPlayer.pauseVideo();
              singleSegmentEnd = -1;
              singleCheckEnabled = false;
            }
          }, 250);
        },
      },
    });
  }

  // Brief pause on auto-follow after manual interaction
  let autoFollowPaused = $state(false);
  let autoFollowTimer: ReturnType<typeof setTimeout> | null = null;

  function togglePlaybackMode() {
    cancelSinglePauseTimer();
    if (playbackMode === "auto") {
      playbackMode = "single";
      singleSegmentEnd = singleEndForCurrentTime(segments, currentTime);
      singleCheckEnabled = singleSegmentEnd > 0;
      if (singleSegmentEnd > 0) schedulePauseAt(singleSegmentEnd, currentTime);
    } else {
      playbackMode = "auto";
      singleSegmentEnd = -1;
      singleCheckEnabled = false;
    }
  }

  function seekTo(seconds: number, segIndex: number) {
    activeSegment = segIndex;
    autoFollowPaused = true;
    if (autoFollowTimer) clearTimeout(autoFollowTimer);
    autoFollowTimer = setTimeout(() => { autoFollowPaused = false; }, 1000);
    singleCheckEnabled = false;
    cancelSinglePauseTimer();
    if (ytPlayer && playerReady) {
      ytPlayer.seekTo(seconds, true);
      ytPlayer.playVideo();
      if (playbackMode === "single") {
        singleSegmentEnd = nextSegmentBoundary(segments, segIndex);
        if (singleSegmentEnd > 0) {
          // Precise pause via setTimeout using the segment duration
          schedulePauseAt(singleSegmentEnd, seconds);
          // Also re-enable the interval backup after a delay
          setTimeout(() => { singleCheckEnabled = true; }, 500);
        }
      } else {
        singleSegmentEnd = -1;
      }
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
      // Range select from the anchor (lastClicked) to this click.
      // Replaces the selection so moving the click back toward the anchor shrinks the range.
      const from = Math.min(lastClicked, segment.index);
      const to = Math.max(lastClicked, segment.index);
      const next = new Set<number>();
      for (const s of segments) {
        if (s.index >= from && s.index <= to) next.add(s.index);
      }
      selected = next;
      seekTo(segment.seconds, segment.index);
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
      doc.setSegmentsSpeaker(targets, irrelevant ? SPEAKER_IRRELEVANT : nextSpeakerName(segments));
      selected = new Set();
    }
  }

  function toggleSelectedIrrelevance() {
    // If everything selected is already irrelevant, mark relevant.
    // Otherwise (some or all relevant) mark everything irrelevant.
    markSelectedIrrelevant(!selectedAllIrrelevant);
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

  function clearSpeakerFilter() {
    filteredSpeakers = new Set();
    // Scroll back to the active or last-selected segment
    requestAnimationFrame(() => {
      const idx = selected.size > 0 ? [...selected][0] : activeSegment;
      if (idx >= 0) {
        const el = document.querySelector(`[data-segment-index="${idx}"]`);
        if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    });
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
      filteredSpeakers = new Set();
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
    return () => {
      if (timeInterval) clearInterval(timeInterval);
      ytPlayer = null;
      playerReady = false;
    };
  });

  $effect(() => {
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  });
</script>

<div class="flex flex-col h-full"
  role="presentation"
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
      {#if ingest.authors && ingest.authors.length > 0}
        <p class="text-xs text-on-surface-muted truncate">
          {ingest.authors.join(", ")}
        </p>
      {/if}
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
    {#if reviewed}
      <span
        class="flex items-center gap-1.5 text-xs font-ui font-medium text-success flex-none"
        title="You have submitted a review for this record"
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
        </svg>
        Reviewed
      </span>
    {/if}
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
    <div
      class="fixed inset-0 bg-ink/50 z-50 flex items-center justify-center p-4"
      onclick={(e) => { if (e.target === e.currentTarget) showSubmitForm = false; }}
      onkeydown={(e) => { if (e.key === 'Escape') showSubmitForm = false; }}
      role="dialog"
      aria-modal="true"
      aria-label="Submit review"
      tabindex="-1"
    >
      <div class="bg-surface rounded-lg shadow-lg max-w-md w-full p-6">
        <h3 class="font-ui font-semibold text-on-surface mb-1">
          {doc.dirty ? "Submit review" : "Approve as-is"}
        </h3>
        <p class="text-xs text-on-surface-muted mb-4">
          {doc.dirty
            ? "Commits your changes to the ingests repo with you as author."
            : "Records an empty review commit so this record shows as reviewed by you. No content changes."}
        </p>

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

        {#if doc.dirty}
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
        {/if}

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
            {submitting ? "Submitting..." : doc.dirty ? "Submit review" : "Approve"}
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
        <div class="px-3 py-2 bg-surface-alt border-b border-border flex-none flex items-center gap-3">
          <span class="text-xs font-ui font-medium text-on-surface-secondary uppercase flex-none">Original</span>
          {#if ingest.frontmatter.source_url}
            <a
              href={ingest.frontmatter.source_url}
              target="_blank"
              rel="noopener"
              class="text-xs text-primary hover:underline truncate min-w-0"
              title={ingest.frontmatter.source_url}
            >
              {ingest.frontmatter.source_url}
            </a>
          {/if}
          {#if ingest.frontmatter.date_accessed}
            <span
              class="text-xs text-on-surface-muted font-ui flex-none ml-auto"
              title={ingest.frontmatter.date_accessed}
            >
              accessed {ingest.frontmatter.date_accessed.slice(0, 10)}
            </span>
          {/if}
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
        {:else if localSourceUrl && (isAudio || isVideo)}
          <div class="flex-none p-4">
            <video controls src={localSourceUrl} class="w-full rounded">
              <track kind="captions" />
            </video>
          </div>
        {:else if localSourceUrl && isWeb && sourceContentType === "application/pdf"}
          <!-- "page_render" snapshot: a paginated PDF of the page taken
               at ingest time. Browser's native PDF viewer handles this. -->
          <iframe
            src={localSourceUrl}
            class="flex-1 w-full border-none bg-white"
            title="Archived source page (PDF render)"
          ></iframe>
        {:else if localSourceUrl && isWeb}
          <!-- "single_file" snapshot (preferred) or raw HTML (fallback).
               Either way it renders in an opaque-origin sandbox - no
               scripts, no same-origin, can't reach our cookies or DOM.
               The single_file capture has every asset inlined as data
               URIs and renders identically to the original page; the
               raw HTML falls back to browser defaults because its
               relative asset paths resolve against the blob URL origin
               instead of the publisher. -->
          <iframe
            src={localSourceUrl}
            sandbox=""
            class="flex-1 w-full border-none bg-white"
            title="Archived source page"
          ></iframe>
        {:else if localSourceFile && isEbook}
          <EpubViewer file={localSourceFile} />
        {:else}
          <!-- Drop target fills all available space -->
          <div
            class="flex-1 flex flex-col items-center justify-center gap-3 text-sm text-center transition-colors cursor-default p-8
              {dragging ? 'bg-primary-container/20 text-primary' : 'text-on-surface-muted'}"
            role="region"
            aria-label="Drop target for source file"
            ondragover={(e) => { e.preventDefault(); dragging = true; }}
            ondragleave={() => { dragging = false; }}
            ondrop={handleFileDrop}
          >
            <p>{dragging ? "Drop file here" : "Drop a source file here to view alongside the ingest"}</p>
            <input type="file" class="hidden" onchange={handleFilePick} bind:this={sourceFileInput} />
            <button
              type="button"
              onclick={() => sourceFileInput?.click()}
              class="px-3 py-1.5 text-xs font-ui bg-surface-alt hover:bg-surface-alt/70 border border-border rounded transition-colors"
            >
              Choose file
            </button>
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
                  {namedSpeakers}
                  {selectedSpeakers}
                  {filteredSpeakers}
                  onselect={handleSpeakerSelection}
                  onfilter={(id) => {
                    const next = new Set(filteredSpeakers);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    filteredSpeakers = next;
                  }}
                  onsetfilter={(ids) => { filteredSpeakers = new Set(ids); }}
                  onrename={renameSpeaker}
                  onmerge={mergeSpeakers}
                  onaddnamed={addNamedSpeaker}
                  onremovenamed={removeNamedSpeaker}
                  onrenamenamed={renameNamedSpeaker}
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
            class="text-xs text-primary hover:underline truncate min-w-0"
          >
            {ingest.frontmatter.source_url}
          </a>
          {#if ingest.frontmatter.date_accessed}
            <span class="text-xs text-on-surface-muted font-ui flex-none ml-auto" title={ingest.frontmatter.date_accessed}>
              accessed {ingest.frontmatter.date_accessed.slice(0, 10)}
            </span>
          {/if}
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
          <!-- Playback mode toggle -->
          {#if view === "ingest" && hasTranscript && ytId}
            <button
              onclick={togglePlaybackMode}
              class="flex items-center gap-1 cursor-pointer px-1.5 py-0.5 rounded-full transition-colors text-xs font-ui font-medium
                {playbackMode === 'single'
                  ? 'bg-primary/10 text-primary'
                  : 'text-on-surface-muted hover:text-on-surface hover:bg-surface'}"
              title={playbackMode === "auto"
                ? "Auto-follow: video plays continuously, focus follows"
                : "Single segment: pauses after each segment"}
            >
              {#if playbackMode === "single"}
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <rect x="6" y="4" width="4" height="16" rx="1" />
                  <rect x="14" y="4" width="4" height="16" rx="1" />
                </svg>
              {:else}
                <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              {/if}
              {playbackMode === "single" ? "Single" : "Auto"}
            </button>
          {/if}

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
            disabled={submitDisabled}
            class="text-xs font-ui font-medium px-3 py-1 rounded transition-colors
              {submitDisabled
                ? 'bg-on-surface-muted/10 text-on-surface-muted cursor-default'
                : doc.dirty
                  ? 'bg-primary text-on-primary hover:bg-primary-hover cursor-pointer'
                  : 'bg-surface text-on-surface-secondary border border-border hover:bg-surface-alt cursor-pointer'}"
            title={!user
              ? "Log in to submit"
              : alreadyApproved
                ? "You've already approved this record as-is. Make changes to submit a new review."
                : doc.dirty
                  ? "Submit changes as a review (Ctrl+S)"
                  : "Approve this record as-is (empty review commit)"}
          >
            {#if submitting}
              Submitting...
            {:else if !user}
              Log in to submit
            {:else if alreadyApproved}
              Approved
            {:else if doc.dirty}
              Submit
            {:else}
              Approve
            {/if}
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
        <div
          class="flex-1 flex items-center justify-center p-8 transition-colors
            {dragging ? 'bg-primary-container/20' : ''}"
          role="region"
          aria-label="Drop source file or enter hash to unlock"
          ondragover={(e) => { e.preventDefault(); dragging = true; }}
          ondragleave={() => { dragging = false; }}
          ondrop={handleFileDrop}
        >
          <div class="text-center max-w-md">
            <div class="text-on-surface-muted mb-3">
              <svg class="w-10 h-10 mx-auto" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
            </div>
            <h3 class="font-ui font-semibold text-on-surface mb-2">Restricted content</h3>
            <p class="text-sm text-on-surface-secondary mb-4">
              This record contains copyrighted material. Drop the source file anywhere on this panel, choose it from your computer, or paste its SHA-256 hash.
            </p>

            <!-- File picker -->
            <input type="file" class="hidden" onchange={handleFilePick} bind:this={sourceFileInput} />
            <button
              type="button"
              onclick={() => sourceFileInput?.click()}
              class="text-xs font-ui font-medium px-4 py-2 rounded cursor-pointer
                bg-surface-alt hover:bg-surface-alt/70 border border-border"
            >
              Choose file
            </button>

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
                Or enter the SHA-256 hash
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
        {#if filteredSpeakers.size > 0}
          <div class="px-3 py-1.5 bg-primary-container/20 border-b border-border flex items-center gap-2 flex-wrap">
            <span class="text-xs font-ui text-on-surface-secondary">Filtered to:</span>
            {#each [...filteredSpeakers] as speakerId}
              <span class="text-xs font-ui font-medium text-primary inline-flex items-center gap-1">
                <SpeakerDot speaker={speakerId} />
                {speakerId}
              </span>
            {/each}
            <button
              onclick={clearSpeakerFilter}
              class="text-xs text-on-surface-muted hover:text-on-surface cursor-pointer ml-auto"
            >clear</button>
          </div>
        {/if}
        {#if selected.size > 1}
          {@const multiPickerOpen = speakerPicker?.kind === "multi"}
          <div class="px-4 py-2 bg-surface-alt border-b border-border flex items-center gap-2 flex-none">
            <span class="text-xs font-ui text-on-surface-secondary">{selected.size} segments selected</span>
            <div class="ml-auto flex items-center gap-1">
              <!-- Change speaker (extract into a different or new speaker) -->
              <div class="relative">
                <button
                  onclick={(e) => {
                    e.stopPropagation();
                    speakerPicker = multiPickerOpen ? null : { kind: "multi", key: 0 };
                  }}
                  class="text-xs font-ui px-2 py-1 rounded cursor-pointer text-on-surface-secondary hover:bg-primary-container/30 hover:text-primary flex items-center gap-1"
                  title="Change speaker for all selected"
                >
                  Change speaker
                  <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {#if multiPickerOpen}
                  {@const current = ""}
                  {@const nm = namedSpeakersOrdered.filter((s) => s !== current)}
                  {@const sp = [SPEAKER_IRRELEVANT, SPEAKER_NARRATOR, SPEAKER_EXTERNAL_FOOTAGE].filter((s) => s !== current)}
                  {@const ot = allSpeakerNames().filter((s) => !namedSpeakers.includes(s) && !isSpecialSpeaker(s))}
                  {@const assign = (name: string) => {
                    const targets = segments
                      .filter((s) => selected.has(s.index))
                      .map((s) => ({ speaker: s.speaker, time: s.time }));
                    doc.setSegmentsSpeaker(targets, name);
                    selected = new Set();
                    speakerPicker = null;
                  }}
                  <div
                    onclick={(e) => e.stopPropagation()}
                    onkeydown={() => {}}
                    role="menu"
                    tabindex="-1"
                    class="absolute right-0 top-full mt-1 z-30 bg-surface-raised border border-border rounded shadow-lg py-1 min-w-40 max-h-60 overflow-auto"
                  >
                    {#each nm as name}
                      <button onclick={() => assign(name)}
                        class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface">
                        <SpeakerDot speaker={name} inline />
                        {name}
                      </button>
                    {/each}
                    {#if nm.length > 0 && sp.length > 0}
                      <div class="border-t border-border my-1"></div>
                    {/if}
                    {#each sp as name}
                      <button onclick={() => assign(name)}
                        class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface-muted italic">
                        <SpeakerDot speaker={name} inline />
                        {name}
                      </button>
                    {/each}
                    {#if ot.length > 0}
                      <div class="border-t border-border my-1"></div>
                      {#each ot as name}
                        <button onclick={() => assign(name)}
                          class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface-muted">
                          <SpeakerDot speaker={name} inline />
                          {name}
                        </button>
                      {/each}
                    {/if}
                    <div class="border-t border-border mt-1 pt-1">
                      <button onclick={() => assign(nextSpeakerName(segments))}
                        class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-primary">
                        + New speaker
                      </button>
                    </div>
                  </div>
                {/if}
              </div>

              <!-- Mark irrelevant / relevant (only one shown, based on current state) -->
              {#if selectedAllIrrelevant}
                <button
                  onclick={() => {
                    const targets = segments
                      .filter((s) => selected.has(s.index))
                      .map((s) => ({ speaker: s.speaker, time: s.time }));
                    doc.setSegmentsSpeaker(targets, nextSpeakerName(segments));
                    selected = new Set();
                  }}
                  class="text-xs font-ui px-2 py-1 rounded cursor-pointer text-on-surface-secondary hover:bg-success-container/30 hover:text-success"
                  title="Mark all selected as relevant"
                >
                  Mark relevant
                </button>
              {:else}
                <button
                  onclick={() => {
                    const targets = segments
                      .filter((s) => selected.has(s.index))
                      .map((s) => ({ speaker: s.speaker, time: s.time }));
                    doc.setSegmentsSpeaker(targets, SPEAKER_IRRELEVANT);
                    selected = new Set();
                  }}
                  class="text-xs font-ui px-2 py-1 rounded cursor-pointer text-on-surface-secondary hover:bg-error-container/30 hover:text-error"
                  title="Mark all selected as irrelevant"
                >
                  Mark irrelevant
                </button>
              {/if}
              <button
                onclick={() => { selected = new Set(); }}
                class="text-xs text-on-surface-muted cursor-pointer hover:text-on-surface px-1"
                title="Clear selection (Esc)"
              >
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path stroke-linecap="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        {/if}
        <div class="flex-1 overflow-auto" data-scroll-sync onscroll={handleContentScroll}>
          {#each visibleGroups as group}
            {@const groupIrrelevant = isSegmentIrrelevant(group.segments[0])}
            {@const groupKey = group.segments[0].index}
            {@const groupPickerOpen = speakerPicker?.kind === "group" && speakerPicker.key === groupKey}
            <div
              class="border-b border-border/50 transition-colors
                {groupPickerOpen ? 'bg-primary-container/20' : ''}"
              style:opacity={groupIrrelevant ? 0.4 : undefined}
              style:background={groupIrrelevant && !groupPickerOpen ? 'var(--color-surface-alt)' : undefined}
            >
              <!-- Group header: speaker shown once per run, click to change whole block -->
              <div class="px-4 pt-3 pb-1 flex items-center gap-2">
                <div class="w-4 flex-none flex items-center justify-center">
                  <SpeakerDot speaker={group.speaker} />
                </div>
                <div class="relative">
                  <button
                    onclick={(e) => {
                      e.stopPropagation();
                      speakerPicker = groupPickerOpen ? null : { kind: "group", key: groupKey };
                    }}
                    class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline"
                    title="Change speaker for this whole block"
                  >
                    {group.speaker}
                  </button>
                  {#if groupPickerOpen}
                    {@const current = group.speaker}
                    {@const nm = namedSpeakersOrdered.filter((s) => s !== current)}
                    {@const sp = [SPEAKER_IRRELEVANT, SPEAKER_NARRATOR, SPEAKER_EXTERNAL_FOOTAGE].filter((s) => s !== current)}
                    {@const ot = allSpeakerNames().filter((s) => s !== current && !namedSpeakers.includes(s) && !isSpecialSpeaker(s))}
                    <div
                      onclick={(e) => e.stopPropagation()}
                      onkeydown={() => {}}
                      role="menu"
                      tabindex="-1"
                      class="absolute left-0 top-full mt-1 z-30 bg-surface-raised border border-border rounded shadow-lg py-1 min-w-40 max-h-60 overflow-auto"
                    >
                      {#each nm as name}
                        <button
                          onclick={() => {
                            doc.setSegmentsSpeaker(group.segments.map((s) => ({ speaker: s.speaker, time: s.time })), name);
                            speakerPicker = null;
                          }}
                          class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface"
                        >
                          <SpeakerDot speaker={name} inline />
                          {name}
                        </button>
                      {/each}
                      {#if nm.length > 0 && sp.length > 0}
                        <div class="border-t border-border my-1"></div>
                      {/if}
                      {#each sp as name}
                        <button
                          onclick={() => {
                            doc.setSegmentsSpeaker(group.segments.map((s) => ({ speaker: s.speaker, time: s.time })), name);
                            speakerPicker = null;
                          }}
                          class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface-muted italic"
                        >
                          <SpeakerDot speaker={name} inline />
                          {name}
                        </button>
                      {/each}
                      {#if ot.length > 0}
                        <div class="border-t border-border my-1"></div>
                        {#each ot as name}
                          <button
                            onclick={() => {
                              doc.setSegmentsSpeaker(group.segments.map((s) => ({ speaker: s.speaker, time: s.time })), name);
                              speakerPicker = null;
                            }}
                            class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface-muted"
                          >
                            <SpeakerDot speaker={name} inline />
                            {name}
                          </button>
                        {/each}
                      {/if}
                      <div class="border-t border-border mt-1 pt-1">
                        <button
                          onclick={() => {
                            doc.setSegmentsSpeaker(group.segments.map((s) => ({ speaker: s.speaker, time: s.time })), nextSpeakerName(segments));
                            speakerPicker = null;
                          }}
                          class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-primary"
                        >
                          + New speaker
                        </button>
                      </div>
                    </div>
                  {/if}
                </div>
                {#if groupIrrelevant}
                  <span class="text-xs text-on-surface-muted italic">irrelevant</span>
                {/if}
              </div>

              <!-- Sentences within the group -->
              {#each group.segments as segment}
                {@const isSelected = selected.has(segment.index)}
                {@const isSingleSelected = isSelected && selected.size === 1}
                {#if splittingIndex === segment.index}
                  <div class="px-4 pb-2">
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
                  {@const sentencePickerOpen = speakerPicker?.kind === "sentence" && speakerPicker.key === segment.index}
                  <div
                    data-segment-index={segment.index}
                    class="px-4 py-1 transition-colors cursor-pointer select-none group/row
                      {isSelected ? 'bg-primary-container/30' : 'hover:bg-primary-container/10'}"
                    role="button"
                    tabindex="0"
                    onclick={(e) => handleSegmentClick(segment, e)}
                    onkeydown={(e) => { if (e.key === 'Enter') handleSegmentClick(segment, e as unknown as MouseEvent); }}
                  >
                    <div class="flex items-start gap-2">
                      <!-- Per-sentence speaker picker: muted chevron, aligned with group dot -->
                      <div class="relative flex-none w-4 flex items-start justify-center pt-0.5">
                        <button
                          onclick={(e) => {
                            e.stopPropagation();
                            speakerPicker = sentencePickerOpen ? null : { kind: "sentence", key: segment.index };
                          }}
                          class="w-4 h-4 flex items-center justify-center rounded cursor-pointer text-on-surface-muted/40 hover:text-on-surface hover:bg-surface-alt transition-colors"
                          title="Change speaker for this sentence"
                        >
                          <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
                          </svg>
                        </button>
                        {#if sentencePickerOpen}
                          {@const current = segment.speaker}
                          {@const nm = namedSpeakersOrdered.filter((s) => s !== current)}
                          {@const sp = [SPEAKER_IRRELEVANT, SPEAKER_NARRATOR, SPEAKER_EXTERNAL_FOOTAGE].filter((s) => s !== current)}
                          {@const ot = allSpeakerNames().filter((s) => s !== current && !namedSpeakers.includes(s) && !isSpecialSpeaker(s))}
                          <div
                            onclick={(e) => e.stopPropagation()}
                            onkeydown={() => {}}
                            role="menu"
                            tabindex="-1"
                            class="absolute left-0 top-full mt-1 z-30 bg-surface-raised border border-border rounded shadow-lg py-1 min-w-40 max-h-60 overflow-auto"
                          >
                            {#each nm as name}
                              <button
                                onclick={() => { doc.changeSegmentSpeaker(segment.speaker, segment.time, name); speakerPicker = null; }}
                                class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface"
                              >
                                <SpeakerDot speaker={name} inline />
                                {name}
                              </button>
                            {/each}
                            {#if nm.length > 0 && sp.length > 0}
                              <div class="border-t border-border my-1"></div>
                            {/if}
                            {#each sp as name}
                              <button
                                onclick={() => { doc.changeSegmentSpeaker(segment.speaker, segment.time, name); speakerPicker = null; }}
                                class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface-muted italic"
                              >
                                <SpeakerDot speaker={name} inline />
                                {name}
                              </button>
                            {/each}
                            {#if ot.length > 0}
                              <div class="border-t border-border my-1"></div>
                              {#each ot as name}
                                <button
                                  onclick={() => { doc.changeSegmentSpeaker(segment.speaker, segment.time, name); speakerPicker = null; }}
                                  class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface-muted"
                                >
                                  <SpeakerDot speaker={name} inline />
                                  {name}
                                </button>
                              {/each}
                            {/if}
                            <div class="border-t border-border mt-1 pt-1">
                              <button
                                onclick={() => { doc.changeSegmentSpeaker(segment.speaker, segment.time, nextSpeakerName(segments)); speakerPicker = null; }}
                                class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-primary"
                              >
                                + New speaker
                              </button>
                            </div>
                          </div>
                        {/if}
                      </div>
                      <span class="text-sm text-on-surface leading-relaxed flex-1">{segment.lines.join(" ")}</span>
                      {#if isSingleSelected}
                        <div class="flex items-center gap-0.5 flex-none pt-0.5">
                          <button onclick={(e) => {
                              e.stopPropagation();
                              const wasIrrelevant = isSegmentIrrelevant(segment);
                              const newSpeaker = wasIrrelevant ? nextSpeakerName(segments) : SPEAKER_IRRELEVANT;
                              doc.setSegmentsSpeaker(
                                [{ speaker: segment.speaker, time: segment.time }],
                                newSpeaker,
                              );
                              if (!wasIrrelevant && ytPlayer && playerReady) {
                                const nextRelevant = segments.find((s) => !isSegmentIrrelevant(s) && s.seconds > segment.seconds && s.index !== segment.index);
                                if (nextRelevant) ytPlayer.seekTo(nextRelevant.seconds, true);
                              }
                            }}
                            class="p-0.5 rounded cursor-pointer transition-colors
                              {isSegmentIrrelevant(segment)
                                ? 'text-on-surface-muted hover:text-success'
                                : 'text-on-surface-muted/50 hover:text-error hover:bg-surface-alt'}"
                            title={isSegmentIrrelevant(segment) ? 'Mark as relevant' : 'Mark as irrelevant'}>
                            {#if isSegmentIrrelevant(segment)}
                              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>
                            {:else}
                              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" /></svg>
                            {/if}
                          </button>
                          {#if segment.lines.join("\n").length > 1}
                            <button onclick={(e) => { e.stopPropagation(); splittingIndex = segment.index; }}
                              class="p-0.5 rounded cursor-pointer text-on-surface-muted/50 hover:text-on-surface hover:bg-surface-alt transition-colors"
                              title="Split this segment">
                              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" d="M12 2v20M2 12h4M18 12h4" /></svg>
                            </button>
                          {/if}
                          <button onclick={(e) => { e.stopPropagation(); editingIndex = segment.index; }}
                            class="p-0.5 rounded cursor-pointer text-on-surface-muted/50 hover:text-primary hover:bg-surface-alt transition-colors"
                            title="Edit timestamp and text">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                              <path stroke-linecap="round" stroke-linejoin="round" d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                              <path stroke-linecap="round" stroke-linejoin="round" d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>
                        </div>
                      {/if}
                    </div>
                  </div>
                {/if}
              {/each}
            </div>
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

{#if editingIndex !== null}
  {@const editSegment = segments.find((s) => s.index === editingIndex)}
  {#if editSegment}
    <EditSegmentDialog
      segment={editSegment}
      allSpeakers={allSpeakerNames()}
      namedSpeakers={namedSpeakersOrdered}
      videoTime={currentTime}
      onsave={(newSpeaker, newTime, newText) => {
        doc.editSegment(editSegment.speaker, editSegment.time, newSpeaker, newTime, newText);
        editingIndex = null;
      }}
      oncancel={() => { editingIndex = null; }}
    />
  {/if}
{/if}
