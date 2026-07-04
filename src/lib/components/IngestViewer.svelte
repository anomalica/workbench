<script lang="ts">
  import type { IngestDetail, DigestDocument, User } from "$lib/api";
  import {
    submitReview,
    fetchCoverage,
    provenanceOf,
    submitVerification,
    hashFile,
    STATIC_READS,
  } from "$lib/api";
  import {
    bodyOf,
    editedLineSpans,
    mergeSpans,
    coveredSegmentIndices,
    markObserved,
    selectionCoverageState,
    runsToLineSpans,
    segmentRunsFromLineSpans,
    spanLineCount,
    lineToSegmentMap,
    subtractSpans,
    mergeTiers,
    advancePlayWindow,
    segmentBounds,
    playedSegmentPositions,
    observedPercent,
  } from "$lib/coverage";
  import type { CoverageSpan, KindedSpan, PlayWindow } from "$lib/coverage";
  import CoverageStrip from "./CoverageStrip.svelte";
  import { DocumentStore } from "$lib/document.svelte";
  import { safeLocalSet } from "$lib/storage";
  import { parseTranscript, parseTimeToSeconds, secondsToTime, findActiveSegmentForTime, segmentAtTime, nextRelevantSegmentAfter, extractFrontmatterSpeakers, isSegmentIrrelevant, isSpecialSpeaker, nextSpeakerName, groupSegmentsBySpeaker, orderedNamedSpeakers, SPEAKER_IRRELEVANT, SPEAKER_NARRATOR, SPEAKER_EXTERNAL_FOOTAGE, SPEAKER_GROUP } from "$lib/transcript";
  import { nextSegmentBoundary, singleEndForCurrentTime } from "$lib/playback";
  import type { Segment } from "$lib/transcript";
  import SpeakerManager from "./SpeakerManager.svelte";
  import SplitEditor from "./SplitEditor.svelte";
  import EditSegmentDialog from "./EditSegmentDialog.svelte";
  import SpeakerDot from "./SpeakerDot.svelte";
  import DiffViewer from "./DiffViewer.svelte";
  import MilkdownEditor from "./MilkdownEditor.svelte";
  import FindReplaceBar from "./FindReplaceBar.svelte";
  import EpubViewer from "./EpubViewer.svelte";
  import WordTranscript from "./WordTranscript.svelte";
  import ReadableText from "./ReadableText.svelte";
  import EditableMetadata from "./EditableMetadata.svelte";
  import ReviewHistory from "./ReviewHistory.svelte";
  import { hasWordTimestamps, parseWords, nextRelevantWordStartAfter, speakerWordCounts } from "$lib/transcript-words";
  import { untrack } from "svelte";
  import { marked } from "marked";
  import yaml from "js-yaml";

  let {
    ingest,
    digest = null,
    sourceFile,
    user,
    reviewed = false,
    needsVerify = false,
    hasNext = false,
    hasPrev = false,
    onnext,
    onprev,
    onreviewedchange,
    onback,
    ontuning,
  }: {
    ingest: IngestDetail;
    digest?: DigestDocument | null;
    sourceFile: File | null;
    user: User | null;
    reviewed?: boolean;
    /** Review carried from a re-ingest, not yet re-verified - show a banner. */
    needsVerify?: boolean;
    /** Whether there is a record after this one in the current
     *  filtered+sorted list - drives the Next button enabled state and
     *  the n/ArrowRight keyboard shortcut. */
    hasNext?: boolean;
    hasPrev?: boolean;
    onnext?: () => void;
    onprev?: () => void;
    onreviewedchange?: (hash: string, reviewed: boolean) => void;
    onback: () => void;
    /** Switch this record into relevance-tuning mode. */
    ontuning?: () => void;
  } = $props();

  const doc = new DocumentStore();

  // For a gated record, the public snapshot withholds body + raw_frontmatter;
  // they arrive only after a possession proof (unlockGatedBody) and then override
  // the empty snapshot values so the editor + write-back see the real record.
  let unlockedBody = $state<string | null>(null);
  let unlockedRawFm = $state<string | null>(null);
  let rawMarkdown = $derived(
    (unlockedRawFm ?? ingest.raw_frontmatter) + (unlockedBody ?? ingest.body),
  );

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
  // Live frontmatter parsed from the working document, so edited fields
  // (creators, publisher) reflect immediately rather than the stale fetch.
  let currentFrontmatterObj = $derived.by<Record<string, unknown>>(() => {
    const match = doc.current.match(/^---\n([\s\S]*?)\n---\n/);
    if (!match) return {};
    try {
      return (yaml.load(match[1]) as Record<string, unknown>) ?? {};
    } catch {
      return {};
    }
  });
  let liveCreators = $derived.by<string[]>(() => {
    const c = currentFrontmatterObj.creators ?? currentFrontmatterObj.authors;
    return Array.isArray(c) ? c.map(String) : [];
  });
  let livePublisher = $derived(
    typeof currentFrontmatterObj.publisher === "string" ? currentFrontmatterObj.publisher : "",
  );
  let liveProvenance = $derived(
    provenanceOf({
      source_url:
        typeof currentFrontmatterObj.source_url === "string"
          ? currentFrontmatterObj.source_url
          : "",
      source_file:
        typeof currentFrontmatterObj.source_file === "string"
          ? currentFrontmatterObj.source_file
          : "",
      source_hash:
        typeof currentFrontmatterObj.source_hash === "string"
          ? currentFrontmatterObj.source_hash
          : "",
      provenance:
        typeof currentFrontmatterObj.provenance === "string"
          ? currentFrontmatterObj.provenance
          : "",
    }),
  );
  let currentRawFrontmatter = $derived.by(() => {
    const m = doc.current.match(/^---\n([\s\S]*?)\n---\n/);
    return m ? m[1].trim() : "";
  });
  let segments = $derived(parseTranscript(currentBody()));

  // Per-word-timestamp (PWTS) records carry `{{t:N.N}}` markers and a
  // `word_timestamps: true` frontmatter flag. They get the isolated word-level
  // editor instead of the segment editor; v1 records are untouched. Detect from
  // the live body so the toggle survives edits. NB: parseTranscript keys off the
  // HH:MM:SS.D line prefix, which record/2 no longer carries, so it finds no
  // segments for a PWTS body - detect the word record directly from the {{t:}}
  // markers, NOT via hasTranscript.
  let isWordRecord = $derived(hasWordTimestamps(currentBody()));
  // A PWTS body IS a transcript even though parseTranscript found no prefixed
  // segments in it, so fold isWordRecord into hasTranscript (drives the speaker
  // panel, keyboard nav, layout).
  let hasTranscript = $derived(
    isWordRecord || (segments.length > 0 && segments[0].speaker !== ""),
  );
  // Parsed word runs for word records (drives the per-word playback skip below);
  // null otherwise. Memoised on the live body.
  let parsedWords = $derived(isWordRecord ? parseWords(currentBody()) : null);
  // Per-speaker WORD counts for the speaker panel (word records); null for v1,
  // where the panel counts segments instead.
  let wordSpeakerRows = $derived(parsedWords ? speakerWordCounts(parsedWords.runs) : null);
  // Latest observation verdict reported by the word editor (word-index spans +
  // coverage fraction + digestible + total words), persisted on review submit.
  let wordVerdict = $state<{
    spans: { from: number; to: number }[];
    observed_coverage: number;
    digestible: boolean;
    total_units: number;
  } | null>(null);

  // Same verdict shape reported by the readable-text coverage view (web/ebook
  // records), which has no playback signal so coverage is marked explicitly.
  let textVerdict = $state<{
    spans: { from: number; to: number }[];
    observed_coverage: number;
    digestible: boolean;
    total_units: number;
  } | null>(null);

  // View mode for the ingest column's sub-tabs (rendered/edit/raw/diff).
  // Digest is no longer a sub-tab; it lives in its own column.
  let view = $state<"ingest" | "edit" | "diff" | "raw">("ingest");
  // In-editor find/replace bar over the raw body textarea (Ctrl-F / Ctrl-H).
  let findOpen = $state(false);
  let rawTextarea = $state<HTMLTextAreaElement>();
  let findBar = $state<{ focus: () => void }>();

  // Claim sections in display order. Derived rather than inline so the typed
  // tuple isn't inferred as a union by Svelte's compiler.
  const NODE_TYPE_ORDER = [
    "person",
    "organisation",
    "place",
    "event",
    "matter",
    "object",
    "document",
    "concept",
  ];
  const NODE_TYPE_PLURALS: Record<string, string> = {
    person: "People",
    organisation: "Organisations",
    place: "Places",
    event: "Events",
    matter: "Matters",
    object: "Objects",
    document: "Documents",
    concept: "Concepts",
  };
  // Claim type filter - toggle each on/off. Default: all on.
  const CLAIM_TYPES = [
    "observation",
    "testimony",
    "hearsay",
    "opinion",
    "measurement",
    "administrative",
  ];
  let claimTypeFilter = $state<Record<string, boolean>>(
    Object.fromEntries(CLAIM_TYPES.map((t) => [t, true])),
  );
  function toggleClaimType(t: string) {
    claimTypeFilter = { ...claimTypeFilter, [t]: !claimTypeFilter[t] };
  }
  let allClaimTypesOn = $derived(
    CLAIM_TYPES.every((t) => claimTypeFilter[t]),
  );

  // Collapsible digest sections. Persists per-section in localStorage so the
  // reviewer's preferred layout sticks across records.
  type Collapsible = "nodes" | "domain" | "infrastructure";
  const COLLAPSE_STORAGE_KEY = "workbench:digest-collapsed";
  function _loadCollapsed(): Record<Collapsible, boolean> {
    try {
      const raw = localStorage.getItem(COLLAPSE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          return {
            nodes: !!parsed.nodes,
            domain: !!parsed.domain,
            infrastructure: !!parsed.infrastructure,
          };
        }
      }
    } catch {}
    return { nodes: false, domain: false, infrastructure: false };
  }
  let collapsed = $state<Record<Collapsible, boolean>>(_loadCollapsed());
  $effect(() => {
    try {
      localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(collapsed));
    } catch {}
  });
  function toggleCollapsed(s: Collapsible) {
    collapsed = { ...collapsed, [s]: !collapsed[s] };
  }

  // Optional filter: click a node chip to show only claims referencing it.
  // Plain click sets the filter to that one node (replacing any current
  // selection). Ctrl/Cmd/Shift click toggles the node in/out of a multi-node
  // selection - a claim then matches if it references ANY selected node.
  let selectedNodeIds = $state<Set<string>>(new Set());
  let selectedNodeNames = $derived(
    digest
      ? [...selectedNodeIds]
          .map((id) => digest.nodes.find((n) => n.id === id)?.name)
          .filter((n): n is string => !!n)
      : [],
  );

  function _toggleNodeFilter(nodeId: string, additive: boolean) {
    const next = new Set(selectedNodeIds);
    if (additive) {
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
    } else {
      // Plain click: if the only selected node is this one, clear. Otherwise
      // replace selection with just this node.
      if (next.size === 1 && next.has(nodeId)) next.clear();
      else {
        next.clear();
        next.add(nodeId);
      }
    }
    selectedNodeIds = next;
  }

  function toggleNodeFilter(nodeId: string, event?: MouseEvent | KeyboardEvent) {
    const additive = !!event && (event.ctrlKey || event.metaKey || event.shiftKey);
    _toggleNodeFilter(nodeId, additive);
  }

  function claimMatchesFilter(c: import("$lib/api").DigestClaim): boolean {
    // Type filter: if the claim's type is toggled off, hide it. Treat unknown
    // types as visible so a future claim type doesn't disappear silently.
    if (c.type in claimTypeFilter && !claimTypeFilter[c.type]) return false;
    // Node filter: claim must reference at least one selected node (OR).
    if (selectedNodeIds.size === 0) return true;
    if (c.speaker?.id && selectedNodeIds.has(c.speaker.id)) return true;
    return (c.refs || []).some((r) => r.id && selectedNodeIds.has(r.id));
  }

  let claimSections = $derived(
    digest
      ? [
          {
            label: "Domain claims",
            claims: (digest.domain_claims ?? []).filter(claimMatchesFilter),
            total: (digest.domain_claims ?? []).length,
          },
          {
            label: "Infrastructure claims",
            claims: (digest.infrastructure_claims ?? []).filter(claimMatchesFilter),
            total: (digest.infrastructure_claims ?? []).length,
          },
        ]
      : [],
  );

  // Reset the filter when switching to a different record so we don't carry
  // stale node ids between digests.
  $effect(() => {
    digest;  // dependency
    selectedNodeIds = new Set();
  });

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

  // Deep-link to a specific claim. The assembled-site references emit URLs
  // of the form /<public_hash>#claim-<uuid>. We do the scroll/flash entirely
  // in JS (no native anchor jump) so we can wait for the async-loaded digest
  // to render its claim cards before resolving the lookup.
  //
  // Selection model: `selectedClaimId` is the persistent state. When set,
  // the matching card gets `.claim-selected` (subtle outline + background
  // tint) and stays highlighted until the user clicks outside it or the URL
  // hash changes to something different. The brief `.claim-flash` entry
  // pulse is layered on top so the reader's eye is drawn to it on arrival.
  let selectedClaimId = $state<string | null>(null);
  // For word/video records, a deep-linked claim also drives a source-side
  // highlight: the word editor highlights the words in the claim's time range
  // and scrolls to them, and the player seeks there. `seq` bumps per navigation
  // so re-linking the same claim re-fires the scroll.
  let claimHighlight = $state<{ start: number; end: number; seq: number } | null>(null);
  let _claimSeq = 0;

  /** Bounded poll for the card element. Large records can have hundreds of
   *  claims that take a moment to render after the digest column mounts,
   *  so a single delayed lookup misses. ~2 s ceiling (25 attempts at 80 ms)
   *  is more than enough in practice; longer would just be hiding a real
   *  rendering problem we'd rather see than paper over. */
  function _findCardWithRetry(
    claimId: string,
    attempts: number,
    onFound: (el: HTMLElement) => void,
  ) {
    const el = document.querySelector<HTMLElement>(
      `[data-claim-id="${CSS.escape(claimId)}"]`,
    );
    if (el) {
      onFound(el);
      return;
    }
    if (attempts <= 0) {
      console.warn(`[ingest-viewer] claim card not found after polling: ${claimId}`);
      return;
    }
    setTimeout(() => _findCardWithRetry(claimId, attempts - 1, onFound), 80);
  }

  function _scrollToClaimFromHash() {
    if (typeof window === "undefined" || !digest) return;
    const h = window.location.hash;
    const m = h.match(/^#claim-([a-f0-9-]{36})$/i);
    // Hash changed to something that isn't a claim ref: clear any selection.
    if (!m) {
      selectedClaimId = null;
      claimHighlight = null;
      return;
    }
    const claimId = m[1];
    // Ensure the digest column is visible (it may have been toggled off via
    // the column-visibility controls). When PaneForge gets involved later
    // this is the hook to open the panel programmatically.
    if (!cols.digest) {
      cols = { ...cols, digest: true };
    }
    // Reshape the digest view so the linked claim isn't buried: collapse
    // the nodes section, expand whichever claim section (domain /
    // infrastructure) contains the target, and clear any node-filter that
    // might otherwise hide the card. Mutates the persisted `collapsed`
    // state intentionally - arriving via a deep link is a context switch,
    // not a layout preference change to fight.
    const inDomain = (digest.domain_claims ?? []).some((c) => c.id === claimId);
    const inInfra = (digest.infrastructure_claims ?? []).some((c) => c.id === claimId);
    collapsed = {
      nodes: true,
      domain: inDomain ? false : collapsed.domain,
      infrastructure: inInfra ? false : collapsed.infrastructure,
    };
    if (selectedNodeIds.size > 0) selectedNodeIds = new Set();
    selectedClaimId = claimId;
    // For a word/video record, the source view is the word editor, not the
    // claim cards - so also drive a source-side highlight: find the claim's
    // time range, highlight those words + scroll to them, and seek the player
    // there (paused) so "take me to where in the video" actually lands.
    if (isWordRecord) {
      const claim = [
        ...(digest.domain_claims ?? []),
        ...(digest.infrastructure_claims ?? []),
      ].find((c) => c.id === claimId);
      const range = claim?.location ? parseClaimLocation(claim.location) : null;
      if (range) {
        claimHighlight = { ...range, seq: ++_claimSeq };
        if (ytPlayer && playerReady) {
          ytPlayer.seekTo(Math.max(0, range.start), true);
          ytPlayer.pauseVideo();
        }
      } else {
        claimHighlight = null;
      }
    } else {
      claimHighlight = null;
    }
    requestAnimationFrame(() => {
      _findCardWithRetry(claimId, 25, (el) => {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        // Brief entry pulse on top of the persistent selection state.
        el.classList.add("claim-flash");
        setTimeout(() => el.classList.remove("claim-flash"), 1800);
      });
    });
  }

  // Parse a claim's `location` ("00:00:00.1-00:00:11.0", or a single timecode)
  // into a seconds range. Returns null if it can't be read.
  function parseClaimLocation(loc: string): { start: number; end: number } | null {
    const sep = loc.indexOf("-");
    const startStr = (sep >= 0 ? loc.slice(0, sep) : loc).trim();
    const endStr = sep >= 0 ? loc.slice(sep + 1).trim() : "";
    const start = parseTimeToSeconds(startStr);
    if (!Number.isFinite(start)) return null;
    const end = endStr ? parseTimeToSeconds(endStr) : start;
    return { start, end: Number.isFinite(end) && end >= start ? end : start };
  }

  // Apply / remove .claim-selected on the matching card whenever the
  // selection state changes. Separate from the scroll/flash effect because
  // it needs to react to selectedClaimId being cleared too (click-outside).
  $effect(() => {
    const id = selectedClaimId;
    const previouslySelected = document.querySelectorAll<HTMLElement>(
      "[data-claim-id].claim-selected",
    );
    previouslySelected.forEach((el) => el.classList.remove("claim-selected"));
    if (!id) return;
    const el = document.querySelector<HTMLElement>(
      `[data-claim-id="${CSS.escape(id)}"]`,
    );
    if (el) el.classList.add("claim-selected");
  });

  // Click-outside: clear the selection if the user clicks anywhere that
  // isn't the currently highlighted card.
  function _handleClaimClickOutside(e: MouseEvent) {
    if (!selectedClaimId) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const closestCard = target.closest<HTMLElement>("[data-claim-id]");
    if (closestCard?.dataset.claimId === selectedClaimId) return;
    selectedClaimId = null;
    _clearQuoteHighlight();
    // Also strip the hash from the URL so a refresh doesn't re-select it.
    if (window.location.hash.startsWith("#claim-")) {
      history.replaceState(null, "", window.location.pathname + window.location.search);
    }
  }

  if (typeof window !== "undefined") {
    document.addEventListener("mousedown", _handleClaimClickOutside);
  }

  // Quote-to-ingest highlighting. When a claim card is clicked, we look
  // up the claim's verbatim `quote` text in the rendered ingest body,
  // create a Range across the matching text nodes, register it as a CSS
  // Custom Highlight (no DOM mutation, no node fragmentation), and
  // scroll the match into view.
  //
  // Browser support: CSS.highlights is Chromium 105+, Firefox 140+,
  // Safari 17.2+. If unavailable we gracefully degrade to scroll only.
  const QUOTE_HIGHLIGHT_NAME = "claim-quote";

  function _clearQuoteHighlight() {
    if (typeof CSS === "undefined" || !(CSS as any).highlights) return;
    (CSS as any).highlights.delete(QUOTE_HIGHLIGHT_NAME);
  }

  function _findTextRange(root: HTMLElement, query: string): Range | null {
    const target = query.trim();
    if (!target) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Array<{ node: Text; start: number }> = [];
    let full = "";
    let n: Node | null = walker.nextNode();
    while (n) {
      nodes.push({ node: n as Text, start: full.length });
      full += n.textContent ?? "";
      n = walker.nextNode();
    }
    const idx = full.indexOf(target);
    if (idx === -1) return null;
    const endIdx = idx + target.length;
    const locate = (pos: number): { node: Text; offset: number } | null => {
      for (let i = 0; i < nodes.length; i++) {
        const end = i + 1 < nodes.length ? nodes[i + 1].start : full.length;
        if (pos >= nodes[i].start && pos <= end) {
          return { node: nodes[i].node, offset: pos - nodes[i].start };
        }
      }
      return null;
    };
    const start = locate(idx);
    const end = locate(endIdx);
    if (!start || !end) return null;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  }

  function _highlightQuoteInIngest(quote: string) {
    _clearQuoteHighlight();
    if (!proseContainer) return;
    if (typeof CSS === "undefined" || !(CSS as any).highlights) {
      // No Custom Highlight API - just scroll without the visual.
      const range = _findTextRange(proseContainer, quote);
      range?.startContainer.parentElement?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
      return;
    }
    const range = _findTextRange(proseContainer, quote);
    if (!range) {
      console.warn("[ingest-viewer] quote not found in ingest body:", quote.slice(0, 60));
      return;
    }
    // Register the highlight under the global Highlights registry.
    const HighlightCtor = (window as any).Highlight as
      | { new (range: Range): unknown }
      | undefined;
    if (HighlightCtor) {
      (CSS as any).highlights.set(QUOTE_HIGHLIGHT_NAME, new HighlightCtor(range));
    }
    // Centre the match in the prose scroll container if it's not visible.
    const rect = range.getBoundingClientRect();
    const containerRect = proseContainer.getBoundingClientRect();
    if (rect.top < containerRect.top + 40 || rect.bottom > containerRect.bottom - 40) {
      const targetTop =
        rect.top - containerRect.top + proseContainer.scrollTop - containerRect.height / 2 + rect.height / 2;
      proseContainer.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
    }
  }

  function _activateClaim(c: { id: string; quote?: string }) {
    selectedClaimId = c.id;
    if (typeof window !== "undefined") {
      history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}#claim-${c.id}`,
      );
    }
    if (c.quote) _highlightQuoteInIngest(c.quote);
  }

  /** Click-handler for claim cards. Skips when the click came from an
   *  inner link/button so refs and inline controls still work normally. */
  function _onClaimCardClick(c: { id: string; quote?: string }, e: MouseEvent) {
    const target = e.target as HTMLElement | null;
    if (target?.closest("a, button")) return;
    _activateClaim(c);
  }

  function _onClaimCardKey(c: { id: string; quote?: string }, e: KeyboardEvent) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    _activateClaim(c);
  }

  $effect(() => {
    // Re-run when the async digest arrives (cold load via direct link); in-page
    // hash navigation is handled by the hashchange listener below. The call is
    // untracked because _scrollToClaimFromHash reads AND writes cols / collapsed
    // / selectedNodeIds / selectedClaimId - without untrack those writes make
    // this effect depend on its own mutations and re-fire forever
    // (effect_update_depth_exceeded), which silently broke the cold-load
    // deep-link. Only `digest` should re-trigger it.
    void digest;
    // Also re-run once the body has loaded enough to be a word record: on a
    // cold load the digest can arrive before the body, and the word-view claim
    // highlight needs isWordRecord true to set claimHighlight.
    void isWordRecord;
    untrack(() => _scrollToClaimFromHash());
  });

  if (typeof window !== "undefined") {
    window.addEventListener("hashchange", _scrollToClaimFromHash);
  }

  // Metadata parsed from frontmatter (read-only display)
  let showMetadata = $state(false);
  // Dedicated review-history panel (title-bar toggle) - provenance surface.
  let showHistory = $state(false);
  // Set when a submitted review committed locally but failed to push to
  // origin - shown in the status bar until dismissed.
  let syncWarning = $state<string | null>(null);

  // Source
  let isPdf = $derived(ingest.frontmatter.source_type === "pdf");
  let isWeb = $derived(ingest.frontmatter.source_type === "web");
  let isAudio = $derived(ingest.frontmatter.source_type === "audio");
  let isVideo = $derived(ingest.frontmatter.source_type === "video");
  let isEbook = $derived(ingest.frontmatter.source_type === "ebook");
  // Text records (no playback signal) get explicit block-level read coverage
  // in the rendered prose view. PDFs are included: their page markers render as
  // zero-unit blocks inside ReadableText's container, so the page-sync observer
  // (bound to that container via proseContainer) keeps working.
  let isTextRecord = $derived(isWeb || isEbook || isPdf);

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
  let unlocking = $state(false);

  // A gated record online: the snapshot withheld the body, so proving possession
  // also has to FETCH it. true exactly when there's a hidden body to unlock.
  let gatedBodyWithheld = $derived(STATIC_READS && !isPublic && !ingest.body && !unlockedBody);

  // Prove possession to the edge and, on a pass, pull back the withheld body +
  // raw_frontmatter (the public snapshot omits them for gated records). Loads the
  // editor with the real record so review + write-back work. Returns whether the
  // gate opened. Access is granted ONLY on a server pass - a wrong proof leaves
  // the body hidden.
  async function unlockGatedBody(proof: {
    sha256?: string;
    session_id?: string;
    responses?: Record<string, string>;
    ext?: string;
  }): Promise<boolean> {
    unlocking = true;
    try {
      const out = await submitVerification(ingest.content_hash, proof);
      if (!out.passed) return false;
      if (typeof out.body === "string") {
        unlockedRawFm = out.raw_frontmatter ?? ingest.raw_frontmatter;
        unlockedBody = out.body;
        // Same hash, so the load-effect won't re-run; load the now-available body
        // explicitly and mark it loaded.
        doc.load((unlockedRawFm ?? "") + unlockedBody, ingest.content_hash);
        lastLoadedHash = ingest.content_hash;
      }
      accessGranted = true;
      return true;
    } catch {
      return false;
    } finally {
      unlocking = false;
    }
  }

  async function verifyHash() {
    hashError = null;
    const hash = hashInput.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      hashError = "Enter a valid 64-character SHA-256 hash";
      return;
    }
    if (gatedBodyWithheld) {
      // Online: let the edge check the proof against the record's source hash and
      // return the body. (The content hash and the source-file hash differ for
      // ebooks/web, so we can't validate locally.)
      if (!(await unlockGatedBody({ sha256: hash }))) {
        hashError = "That hash doesn't match this record";
      }
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

  /** Display-only stylesheet injected into HTML source snapshots before
   *  rendering. Hides common ad-slot containers that the publisher
   *  reserves layout space for via CSS min-height. Under our sandbox=""
   *  the ad loader script can't run, so those reserved heights stay
   *  empty and become visible gaps between paragraphs.
   *
   *  Modifies the in-memory blob only - the saved artefact on disk is
   *  unchanged.
   */
  const AD_HIDE_CSS = `
    <style>
      .adthrive-ad,
      [id^="AdThrive_"],
      [id^="div-gpt-ad"],
      [id*="taboola"],
      [id*="outbrain"],
      [class*="advert"],
      [class*="ad-slot"],
      [class*="adslot"],
      [class*="ad-container"],
      [class*="banner-ad"],
      [class*="dfp-ad"] {
        display: none !important;
      }
    </style>
  `;

  function injectAdHideCss(html: string): string {
    if (/<\/head>/i.test(html)) {
      return html.replace(/<\/head>/i, `${AD_HIDE_CSS}</head>`);
    }
    if (/<body[^>]*>/i.test(html)) {
      return html.replace(/<body[^>]*>/i, (m) => `${m}${AD_HIDE_CSS}`);
    }
    return AD_HIDE_CSS + html;
  }

  /** Copy data-src / data-original / data-lazy-src into src on <img> and
   *  <source> tags whose current src is empty or a placeholder data URI.
   *  Same for data-srcset -> srcset. Lets the iframe fetch the real
   *  image from the publisher CDN when the page is parsed under
   *  sandbox="" (no scripts to do the swap natively).
   *
   *  Trade-off: resolved URLs are remote, so the reviewer's IP is
   *  visible to the publisher origin during render. Accepted because
   *  the alternative is images that never appear at all (SingleFile
   *  decides what to inline based on what the browser fetched at
   *  capture time, and lazy-loaded images often don't trigger before
   *  the save completes).
   */
  function resolveLazyImages(html: string): string {
    return html.replace(
      /<(img|source)\b([^>]*?)\s*\/?>/gi,
      (full, tag, attrs) => {
        const dataSrc = attrs.match(/\sdata-(?:src|original|lazy-src)="([^"]+)"/i);
        const dataSrcset = attrs.match(/\sdata-srcset="([^"]+)"/i);
        if (!dataSrc && !dataSrcset) return full;

        const srcMatch = attrs.match(/\ssrc="([^"]*)"/i);
        const currentSrc = srcMatch ? srcMatch[1] : "";
        // Heuristic for placeholder src: empty, or a short data: URI
        // (typical lazy-load placeholders are tiny transparent gifs or
        // SVGs well under 200 chars; real inlined images are kilobytes).
        const looksPlaceholder =
          !currentSrc ||
          (currentSrc.startsWith("data:") && currentSrc.length < 200);

        let newAttrs = attrs;
        if (dataSrc && looksPlaceholder) {
          newAttrs = srcMatch
            ? newAttrs.replace(/\ssrc="[^"]*"/i, ` src="${dataSrc[1]}"`)
            : `${newAttrs} src="${dataSrc[1]}"`;
        }
        if (dataSrcset) {
          const srcsetMatch = attrs.match(/\ssrcset="([^"]*)"/i);
          newAttrs = srcsetMatch
            ? newAttrs.replace(/\ssrcset="[^"]*"/i, ` srcset="${dataSrcset[1]}"`)
            : `${newAttrs} srcset="${dataSrcset[1]}"`;
        }
        return `<${tag}${newAttrs}>`;
      },
    );
  }

  $effect(() => {
    if (isPublic && !localSourceFile && !localSourceUrl && !ytId) {
      // Online (static-read) the edge has no /api/sources route; public source
      // FILES are served straight from the CDN at /sources/<hash>.<ext>. Only
      // PDFs are served that way - web uses the source_url link-out, video the
      // embed - so skip the fetch for non-PDF public sources in static mode.
      if (STATIC_READS && !isPdf) return;
      const srcUrl = STATIC_READS ? `/sources/${sourceKey}.pdf` : `/api/sources/${sourceKey}`;
      loadingFile = true;
      fetch(srcUrl)
        .then(async (res) => {
          if (!res.ok) return null;
          const blob = await res.blob();
          if (blob.size === 0) return null;
          // For HTML snapshots: hide ad slots and resolve lazy-loaded
          // image references that SingleFile couldn't inline at capture.
          const contentType = res.headers.get("content-type") || blob.type;
          if (contentType.startsWith("text/html")) {
            let text = await blob.text();
            text = resolveLazyImages(text);
            text = injectAdHideCss(text);
            return new Blob([text], { type: "text/html" });
          }
          return blob;
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

  async function acceptFile(file: File) {
    loadingFile = true;
    hashError = null;
    // Gated record online: the body is withheld from the snapshot, so prove
    // possession (the source file's SHA-256) to the edge and fetch the body.
    // Only reveal it on a server pass - a wrong file keeps the body hidden.
    if (gatedBodyWithheld) {
      let sha256: string;
      try {
        sha256 = await hashFile(file);
      } catch {
        hashError = "Couldn't read that file";
        loadingFile = false;
        return;
      }
      const ext = file.name.split(".").pop()?.toLowerCase();
      if (!(await unlockGatedBody({ sha256, ext }))) {
        hashError = "That file doesn't match this record";
        loadingFile = false;
        return;
      }
    } else {
      accessGranted = true;
    }
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
  // Keep the source pane for a web record that has a source_url even when no
  // archived capture loads (it never does online - the edge has no /api/sources
  // route), so the "open the original page" link-out stays available to verify
  // the extraction against the live page.
  let singleColumn = $derived(
    (isWeb && !localSourceFile && !localSourceUrl && !ingest.frontmatter.source_url) ||
      (isEbook && !localSourceFile),
  );

  // Column visibility: user toggles which of source/ingest/digest are shown.
  // Persists to localStorage. The Source column is auto-suppressed for
  // record types that have nothing to display there (see singleColumn).
  type ColumnState = { source: boolean; ingest: boolean; digest: boolean };
  const COLUMN_STORAGE_KEY = "workbench:columns";

  function _loadCols(): ColumnState {
    try {
      const raw = localStorage.getItem(COLUMN_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (
          typeof parsed === "object" && parsed
          && "source" in parsed && "ingest" in parsed && "digest" in parsed
        ) {
          return {
            source: !!parsed.source,
            ingest: !!parsed.ingest,
            digest: !!parsed.digest,
          };
        }
      }
    } catch {
      // ignore corrupt localStorage entries
    }
    return { source: true, ingest: true, digest: false };
  }

  let cols = $state<ColumnState>(_loadCols());

  $effect(() => {
    try {
      localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(cols));
    } catch {
      // storage full or disabled; the user just loses persistence
    }
  });

  // First time a record with a digest is opened and the user hasn't already
  // turned the digest column on, show it. This is a one-shot reveal so they
  // see the new column exists; subsequent toggles are remembered.
  let digestRevealed = false;
  $effect(() => {
    if (digest && !digestRevealed) {
      digestRevealed = true;
      if (!cols.digest) cols = { ...cols, digest: true };
    }
  });

  // Effective column visibility after applying singleColumn (no source pane
  // possible for some record types) and digest availability.
  let visibleCols = $derived({
    source: cols.source && !singleColumn,
    ingest: cols.ingest,
    digest: cols.digest && !!digest,
  });
  let visibleCount = $derived(
    (visibleCols.source ? 1 : 0)
      + (visibleCols.ingest ? 1 : 0)
      + (visibleCols.digest ? 1 : 0),
  );
  let colWidthClass = $derived(
    visibleCount >= 3 ? "w-1/3" : visibleCount === 2 ? "w-1/2" : "w-full",
  );

  function toggleCol(name: "source" | "ingest" | "digest") {
    const next = { ...cols, [name]: !cols[name] };
    const effSource = next.source && !singleColumn;
    const effIngest = next.ingest;
    const effDigest = next.digest && !!digest;
    // At least one column must remain visible.
    if (!effSource && !effIngest && !effDigest) return;
    cols = next;
  }

  // Jump to the diff view from the unsaved-changes indicators. The diff tab
  // lives in the ingest column, so make sure that column is showing first.
  function showDiff() {
    if (!cols.ingest) cols = { ...cols, ingest: true };
    view = "diff";
  }

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
    // Trailing match is `[ \t]*$` (with the m flag) rather than `\s*` so we
    // don't accidentally consume the newline that separates the caption
    // line from the next paragraph. Without that newline, marked treats
    // the following paragraph as a continuation of our injected HTML
    // block and stops parsing inline markdown (links included) in it.
    return body.replace(
      /^(!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\))[ \t]*\n\n\*([^*\n][^*]*?)\*[ \t]*$/gm,
      (_, _img, alt, url, caption) =>
        `<figure class="ingest-figure caption-figure"><img src="${url}" alt="${escapeHtml(alt)}" loading="lazy" /><figcaption>${escapeHtml(caption)}</figcaption></figure>`,
    );
  }

  function preprocessAnnotations(body: string): string {
    const recordHash = ingest.content_hash;
    // Strip per-word timestamp markers ({{t:SECONDS}}) for prose display: they're
    // an inline annotation (record/2), not content. The word-level editor
    // consumes them; any markdown/prose render must hide them (word records use
    // WordTranscript, but this keeps markers out of every other prose path too).
    body = body.replace(/\{\{t:\d+(?:\.\d+)?\}\}/g, "");
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
  // Component root - focus target when reclaiming keyboard focus from the
  // YouTube iframe (see reclaimFocusFromVideo).
  let appRoot: HTMLDivElement | undefined = $state();

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

  // Theatre mode: lift the video to a full-width band across the top, with
  // the remaining columns laid out beneath it. Implemented with CSS Grid
  // named areas rather than moving DOM nodes, so the YouTube player and the
  // ingest column keep their state (playback position, selection, scroll)
  // across the toggle. Only meaningful when a video is actually showing.
  let theatreMode = $state(false);
  let theatreActive = $derived(theatreMode && !!ytId && visibleCols.source);

  // Columns that sit below the video band in theatre mode, left to right:
  // the speakers panel (lifted out of the source column), then ingest, then
  // digest. The video spans the full width above them. Achieved purely by
  // re-mapping CSS Grid areas, so the YouTube player is never reparented.
  let belowAreas = $derived(
    [
      hasTranscript ? "spk" : null,
      visibleCols.ingest ? "ing" : null,
      visibleCols.digest ? "dig" : null,
    ].filter((a): a is string => a !== null),
  );
  let theatreGridStyle = $derived.by(() => {
    const areas = belowAreas.length ? belowAreas : ["ing"];
    // Speakers stays narrow (its natural sidebar width); ingest and digest
    // share the rest.
    const cols = areas
      .map((a) => (a === "spk" ? "minmax(12rem, 18rem)" : "1fr"))
      .join(" ");
    const top = areas.map(() => "src").join(" ");
    const bottom = areas.join(" ");
    return (
      `grid-template-columns: ${cols};` +
      ` grid-template-rows: auto minmax(0, 1fr);` +
      ` grid-template-areas: "${top}" "${bottom}";`
    );
  });

  // YouTube player
  let ytPlayer: YT.Player | null = null;
  let playerReady = $state(false);
  let currentTime = $state(0);
  let playbackRate = $state(1);
  const playbackRates = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  function setPlaybackRate(rate: number) {
    playbackRate = rate;
    if (ytPlayer && playerReady) ytPlayer.setPlaybackRate(rate);
  }
  let activeSegment = $state(-1);
  let timeInterval: ReturnType<typeof setInterval> | null = null;
  let playbackMode = $state<"auto" | "single">("auto");
  // When on, playback jumps past any segment marked irrelevant to the next
  // relevant one, so the reviewer never sits through cut content. Default on.
  let skipIrrelevant = $state(true);
  let singleSegmentEnd = -1; // seconds at which to pause (used in interval as backup)
  let singleCheckEnabled = false; // delayed flag to avoid stale-time false pauses
  let singlePauseTimer: ReturnType<typeof setTimeout> | null = null;

  // Hover-pause: hovering the per-segment action toolbar pauses playback so
  // the buttons stop drifting out from under the cursor on short sentences.
  // Leaving resumes - unless the click opened a "next process" (Edit / Split),
  // which should hold the pause so the reviewer has time to work. Instant
  // actions (Ignore, Merge up) don't suppress the resume.
  let hoverPausedPlayback = false;
  let suppressHoverResume = false;

  // Keyboard seek/segment-nav state.
  const SEEK_STEP_SECONDS = 5;
  let lastSegmentNavAt = 0; // throttles up/down sentence jumps

  function onControlsEnter() {
    // Fresh hover session - clear any leftover suppression from a prior
    // Edit/Split that didn't emit a mouseleave (e.g. the row unmounted
    // into the SplitEditor before leave could fire).
    suppressHoverResume = false;
    if (ytPlayer && playerReady && ytPlayer.getPlayerState() === 1) {
      ytPlayer.pauseVideo();
      hoverPausedPlayback = true;
    }
  }

  function onControlsLeave() {
    if (hoverPausedPlayback && !suppressHoverResume && ytPlayer && playerReady) {
      ytPlayer.playVideo();
    }
    hoverPausedPlayback = false;
    suppressHoverResume = false;
  }

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
  // (e.g. after rename, merge, or assign). A word record has no segments - its
  // speakers come from the parsed word runs - so include those, else every
  // filter is pruned the instant it's set and speaker filtering never works.
  $effect(() => {
    const existing = new Set(segments.map((s) => s.speaker));
    for (const r of wordSpeakerRows ?? []) existing.add(r.id);
    const prunedFilter = new Set([...filteredSpeakers].filter((id) => existing.has(id)));
    if (prunedFilter.size !== filteredSpeakers.size) filteredSpeakers = prunedFilter;
    const prunedSelection = new Set([...selectedSpeakers].filter((id) => existing.has(id)));
    if (prunedSelection.size !== selectedSpeakers.size) selectedSpeakers = prunedSelection;
  });

  // Skip irrelevant: while the video is actually playing, jump past any
  // segment marked irrelevant to the next relevant one. Reactive on
  // currentTime (updated every 250ms by the player interval), so it always
  // sees the live transcript and the current toggle state. The
  // autoFollowPaused grace means clicking an irrelevant segment to review
  // it isn't instantly undone.
  $effect(() => {
    const t = currentTime; // subscribe to the playback clock
    if (!skipIrrelevant || !hasTranscript || autoFollowPaused) return;
    if (!ytPlayer || !playerReady) return;
    if (ytPlayer.getPlayerState() !== 1) return; // only while playing
    // Per-word records (record/2) have no V1 segments (parseTranscript keys off
    // the line-start timecode, which is gone), so skip off the word runs: when
    // the playhead is on an [irrelevant] word, seek to the next relevant word.
    if (isWordRecord && parsedWords) {
      const target = nextRelevantWordStartAfter(
        parsedWords.words,
        parsedWords.runs,
        t,
        (s) => s === SPEAKER_IRRELEVANT,
      );
      if (target != null) ytPlayer.seekTo(target, true);
      return;
    }
    // segmentAtTime (unlike findActiveSegmentForTime) includes irrelevant
    // segments, so it can tell us the playhead is inside one - which is the
    // whole point. The previous skip used findActiveSegmentForTime, which
    // skips irrelevant segments, so its "is this irrelevant?" check was
    // never true and the skip never fired.
    const current = segmentAtTime(segments, t);
    if (current && isSegmentIrrelevant(current)) {
      const nextRelevant = nextRelevantSegmentAfter(segments, t);
      if (nextRelevant) ytPlayer.seekTo(nextRelevant.seconds, true);
    }
  });

  // Auto-follow: sync the highlighted segment with video playback.
  // In "auto" mode: focus follows continuously, skipping irrelevant segments.
  // In "single" mode: highlight stays on the clicked segment; the interval handles pausing.
  $effect(() => {
    if (!hasTranscript || selected.size > 1 || splittingIndex !== null) return;
    // Don't let auto-follow move the selection while the edit dialog is open -
    // previewing a timestamp seeks the video, and otherwise this effect would
    // re-select whatever segment matches the new time, drifting the selection
    // out from under the segment being edited.
    if (editingIndex !== null) return;
    if (view !== "ingest") return;
    if (autoFollowPaused) return;
    if (playbackMode === "single") return;
    const t = currentTime;

    let best = findActiveSegmentForTime(segments, t);
    if (best >= 0 && best !== activeSegment) {
      // Don't move the selection onto an irrelevant segment - the
      // skip-irrelevant logic in the playback interval seeks past it, so
      // following it here would just flicker the highlight.
      const bestSeg = segments.find((s) => s.index === best);
      if (bestSeg && isSegmentIrrelevant(bestSeg) && skipIrrelevant) return;

      activeSegment = best;
      selected = new Set([best]);
      lastClicked = best;
      const el = document.querySelector(`[data-segment-index="${best}"]`);
      if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  });

  // Submit review state
  let submitting = $state(false);
  // Approve is a no-op empty commit on top of an existing reviewed record.
  // Still informational for labels/titles, but no longer disables submit:
  // a reviewed record can take a fresh zero-edit submission carrying
  // coverage spans ("looked, all fine").
  let alreadyApproved = $derived(!doc.dirty && reviewed);
  // The toolbar button's disabled state. When logged out it must stay
  // CLICKABLE - its click navigates to the login page, so disabling it
  // there strands the reviewer ("Log in to submit" that can't be clicked).
  let submitDisabled = $derived(submitting);
  // Used by the `a` keyboard shortcut: only meaningful when logged in.
  let approveShortcutEnabled = $derived(!!user && !submitting);
  let submitError = $state<string | null>(null);
  let showSubmitForm = $state(false);
  let reviewNotes = $state("");
  // When the modal's "Approve & next" button (or Shift+A keystroke) fires,
  // we set this true so a successful submit advances to the next record
  // automatically. Reset on every modal open.
  let submitAndAdvance = $state(false);

  // Review coverage, two pending tiers. `pendingRuns` (observed, strong)
  // are segment-index runs the reviewer marked or edited - solid amber in
  // the gutter. `playedRuns` (played, weak) are segments auto-recorded as
  // continuously played through - dotted amber. Observed wins over played
  // wherever they overlap. `myObservedSpans` / `myPlayedSpans` are their
  // own prior submitted coverage from the sidecar (green, solid/dotted).
  let pendingRuns = $state<CoverageSpan[]>([]);
  let playedRuns = $state<CoverageSpan[]>([]);
  let myObservedSpans = $state<CoverageSpan[]>([]);
  let myPlayedSpans = $state<CoverageSpan[]>([]);
  let bodyLineCount = $derived(currentBody().split("\n").length);
  let coveredSegments = $derived(coveredSegmentIndices(currentBody(), myObservedSpans));
  // For word/video records the submitted spans are word indices (not line
  // spans), so expand this reviewer's server coverage into a word-index list
  // and feed it to the word editor - otherwise a reopened record (or a fresh
  // session, after submit clears the localStorage draft) shows nothing observed.
  let serverObservedWords = $derived.by<number[]>(() => {
    if (!isWordRecord) return [];
    const out: number[] = [];
    for (const s of myObservedSpans) for (let i = s.from; i <= s.to; i++) out.push(i);
    return out;
  });
  let playedCoveredSegments = $derived(coveredSegmentIndices(currentBody(), myPlayedSpans));
  function runsToSet(runs: CoverageSpan[]): Set<number> {
    const out = new Set<number>();
    for (const r of runs) for (let i = r.from; i <= r.to; i++) out.add(i);
    return out;
  }
  let pendingSegments = $derived(runsToSet(pendingRuns));
  let playedSegments = $derived(runsToSet(playedRuns));
  // Observed line spans: pending runs plus the lines edited this session
  // (edits always count as observed coverage even if unmarked).
  let pendingLineSpans = $derived(
    mergeSpans([
      ...runsToLineSpans(currentBody(), pendingRuns),
      ...editedLineSpans(bodyOf(doc.original), currentBody()),
    ]),
  );
  // The submit payload: both tiers as kinded line spans, observed winning
  // over played on overlap.
  let pendingKindedSpans = $derived<KindedSpan[]>(
    mergeTiers(pendingLineSpans, runsToLineSpans(currentBody(), playedRuns)),
  );
  let pendingSpanLineCount = $derived(spanLineCount(pendingKindedSpans));

  function coverageStorageKey(hash: string): string {
    return `workbench:coverage:${hash}`;
  }

  // Restore pending runs when the record changes, then pre-seed with the
  // segments touched by edits restored from the document draft.
  let coverageRestoredHash = "";
  $effect(() => {
    const hash = ingest.content_hash;
    if (hash === coverageRestoredHash) return;
    coverageRestoredHash = hash;
    playWindow = null;
    let observed: CoverageSpan[] = [];
    let played: CoverageSpan[] = [];
    try {
      const raw = localStorage.getItem(coverageStorageKey(hash));
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          observed = parsed; // legacy single-tier format
        } else if (parsed && typeof parsed === "object") {
          if (Array.isArray(parsed.observed)) observed = parsed.observed;
          if (Array.isArray(parsed.played)) played = parsed.played;
        }
      }
    } catch {
      observed = [];
      played = [];
    }
    pendingRuns = observed;
    playedRuns = played;
  });

  // Pre-seed: segments edited this session automatically become pending
  // runs. Reads pendingRuns untracked so its own write doesn't loop.
  $effect(() => {
    const edited = segmentRunsFromLineSpans(
      currentBody(),
      editedLineSpans(bodyOf(doc.original), currentBody()),
    );
    if (edited.length === 0) return;
    untrack(() => {
      const merged = mergeSpans([...pendingRuns, ...edited]);
      if (JSON.stringify(merged) !== JSON.stringify(pendingRuns)) pendingRuns = merged;
    });
  });

  // Persist both pending tiers alongside the document draft.
  $effect(() => {
    const hash = ingest.content_hash;
    const observed = pendingRuns;
    const played = playedRuns;
    if (hash !== coverageRestoredHash) return;
    if (observed.length === 0 && played.length === 0) {
      try {
        localStorage.removeItem(coverageStorageKey(hash));
      } catch {
        // best-effort
      }
    } else {
      safeLocalSet(coverageStorageKey(hash), JSON.stringify({ observed, played }));
    }
  });

  // Mark the current segment selection as observed coverage. Overlapping
  // and index-adjacent runs coalesce; the selection clears afterwards,
  // matching the other selection actions. Played segments inside the
  // selection upgrade to observed (observed wins on overlap).
  function markSelectedObserved() {
    if (selected.size === 0) return;
    pendingRuns = markObserved(pendingRuns, selected);
    selected = new Set();
  }

  // Remove pending marks - both tiers - from the selected segments.
  // Submitted (green) coverage is untouched.
  function clearSelectedMarks() {
    if (selected.size === 0) return;
    const sel = [...selected].map((i) => ({ from: i, to: i }));
    pendingRuns = subtractSpans(pendingRuns, sel);
    playedRuns = subtractSpans(playedRuns, sel);
    selected = new Set();
  }

  // The observed toggle: clear when every selected segment already carries
  // a pending mark (either tier), otherwise mark observed. Submitted
  // coverage and the [irrelevant] speaker tag are never touched.
  let selectionAllMarked = $derived(
    selectionCoverageState(selected, pendingRuns, playedRuns) === "all-covered",
  );
  function toggleSelectedObserved() {
    if (selectionAllMarked) clearSelectedMarks();
    else markSelectedObserved();
  }

  // Hands-free "played" tracking. While media plays, fold each playback
  // clock sample into a continuous-play window; any segment whose whole
  // time range sits inside that window was played end-to-end. Seeks and
  // jumps (a sample more than 2 s past the last, or backwards) start a
  // fresh window, so skipped segments never count. Records without media
  // never call this - manual marking only.
  let playWindow: PlayWindow | null = null;
  function trackPlayback(t: number, duration?: number) {
    playWindow = advancePlayWindow(playWindow, t);
    const bounds = segmentBounds(segments.map((s) => s.seconds), duration);
    const positions = playedSegmentPositions(playWindow, bounds);
    if (positions.length === 0) return;
    const merged = mergeSpans([...playedRuns, ...positions.map((i) => ({ from: i, to: i }))]);
    if (JSON.stringify(merged) !== JSON.stringify(playedRuns)) playedRuns = merged;
  }

  function scrollToBodyLine(line: number) {
    const map = lineToSegmentMap(currentBody());
    const seg = map[Math.min(line, map.length - 1)];
    if (seg === undefined || seg < 0) return;
    const el = document.querySelector(`[data-segment-index="${seg}"]`);
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  $effect(() => {
    const hash = ingest.content_hash;
    const email = user?.email;
    if (!email) {
      myObservedSpans = [];
      myPlayedSpans = [];
      return;
    }
    fetchCoverage(hash).then((reviews) => {
      if (ingest.content_hash !== hash) return;
      const mine = reviews.filter((r) => r.by === email).flatMap((r) => r.spans);
      // Spans without a kind predate the tiers - treat as observed.
      const observed = mergeSpans(mine.filter((s) => (s.kind ?? "observed") === "observed"));
      myObservedSpans = observed;
      myPlayedSpans = subtractSpans(
        mine.filter((s) => s.kind === "played"),
        observed,
      );
    });
  });

  async function handleSubmit() {
    if (!user) return;
    submitting = true;
    submitError = null;
    // Word records submit their word-index observation + a verdict the
    // digester's gate reads; text records (web/ebook) submit their read
    // line-spans + the same verdict; segment records submit line-span coverage.
    const recordVerdict = isWordRecord ? wordVerdict : isTextRecord ? textVerdict : null;
    const spans = recordVerdict
      ? recordVerdict.spans.map((s) => ({ from: s.from, to: s.to, kind: "observed" as const }))
      : pendingKindedSpans;
    const verdict = recordVerdict
      ? {
          observed_coverage: recordVerdict.observed_coverage,
          digestible: recordVerdict.digestible,
          total_units: recordVerdict.total_units,
        }
      : undefined;
    const result = await submitReview(ingest.content_hash, doc.current, reviewNotes, spans, verdict);
    submitting = false;
    if (result.ok) {
      // Committed locally but not pushed to origin - the live site will not
      // see this review until sync succeeds. Loud, never silent.
      syncWarning = result.synced === false
        ? `Review saved and committed locally, but NOT yet synced to GitHub - the live site will not show it. ${result.syncDetail || ""}`.trim()
        : null;
      showSubmitForm = false;
      reviewNotes = "";
      myObservedSpans = mergeSpans([
        ...myObservedSpans,
        ...spans.filter((s) => s.kind === "observed"),
      ]);
      myPlayedSpans = subtractSpans(
        [...myPlayedSpans, ...spans.filter((s) => s.kind === "played")],
        myObservedSpans,
      );
      pendingRuns = [];
      playedRuns = [];
      localStorage.removeItem(coverageStorageKey(ingest.content_hash));
      // Set the submitted content as the new baseline without resetting position
      doc.original = doc.current;
      doc.past = [];
      doc.future = [];
      localStorage.removeItem(doc.storageKey);
      // Backend auto-marks reviewed on submit; mirror it locally.
      onreviewedchange?.(ingest.content_hash, true);
      if (submitAndAdvance) {
        submitAndAdvance = false;
        // Advance after the next microtask so the reviewed-state change
        // gets applied to the list view before we navigate.
        queueMicrotask(() => onnext?.());
      }
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

  // Indices of segments whose start time is earlier than the segment
  // immediately before them in document order - i.e. the timeline goes
  // backwards there. These are almost always a stale split/edit and break
  // playback's active-segment tracking, so we flag them in the transcript.
  let nonMonotonicIndices = $derived.by(() => {
    const bad = new Set<number>();
    let prev = -Infinity;
    for (const s of segments) {
      if (s.seconds < prev) bad.add(s.index);
      prev = s.seconds;
    }
    return bad;
  });

  // Derived: visible segments grouped by consecutive same-speaker runs
  let visibleGroups = $derived(groupSegmentsBySpeaker(visibleSegments));

  // Derived: speakers visible in current filter mode
  let visibleSpeakerIds = $derived(
    wordSpeakerRows
      ? new Set(
          wordSpeakerRows
            .filter((r) => !hideIrrelevant || r.id !== SPEAKER_IRRELEVANT)
            .map((r) => r.id),
        )
      : new Set(
          segments.filter((s) => !hideIrrelevant || !isSegmentIrrelevant(s)).map((s) => s.speaker),
        ),
  );

  // Count of irrelevant units for the show/hide eye toggle: irrelevant WORDS for
  // a word record (segments don't exist), irrelevant segments for v1. Drives
  // whether the eye icon shows at all.
  let irrelevantCount = $derived(
    wordSpeakerRows
      ? (wordSpeakerRows.find((r) => r.id === SPEAKER_IRRELEVANT)?.total ?? 0)
      : segments.filter((s) => isSegmentIrrelevant(s)).length,
  );

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

  // Seek the (background) player to a time and play, so a reviewer tuning a
  // timestamp in the edit dialog can immediately hear where it lands. The
  // video sits behind the modal but its audio is still audible.
  function previewSeek(seconds: number) {
    if (ytPlayer && playerReady) {
      ytPlayer.seekTo(Math.max(0, seconds), true);
      ytPlayer.playVideo();
    }
  }

  function createPlayer(id: string) {
    ytPlayer = new YT.Player("yt-player", {
      videoId: id,
      playerVars: { rel: 0, modestbranding: 1 },
      events: {
        onReady: () => {
          playerReady = true;
          ytPlayer?.setPlaybackRate(playbackRate);
          // Cold-load claim deep link: the digest resolved and set the
          // highlight before the player existed, so the seek was skipped.
          // Now that it's ready, land on the claim's start (paused).
          if (claimHighlight && ytPlayer) {
            ytPlayer.seekTo(Math.max(0, claimHighlight.start), true);
            ytPlayer.pauseVideo();
          }
          timeInterval = setInterval(() => {
            if (!ytPlayer) return;
            const t = ytPlayer.getCurrentTime();
            currentTime = t;
            // Played-coverage tracking: only sample while actually playing,
            // so pauses don't extend the continuous-play window.
            if (ytPlayer.getPlayerState() === 1) {
              trackPlayback(t, ytPlayer.getDuration() || undefined);
            }
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

  // Remember the last segment the reviewer focused, per record, so coming
  // back to a record returns to roughly where they left off. Written
  // explicitly from the click/keyboard handlers (not via a reactive effect)
  // so navigating between records can't write a stale index to the wrong
  // record's key. The index is parse-order; if the body was edited since,
  // restore is best-effort and silently skips when the index no longer
  // resolves to a segment.
  function rememberLastSegment(idx: number) {
    if (idx < 0) return;
    try {
      localStorage.setItem(`workbench:lastseg:${ingest.content_hash}`, String(idx));
    } catch {}
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
    rememberLastSegment(segment.index);
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
    // Word records must keep their per-word timestamps, so rename through the
    // word-aware path (the segment serialiser would strip the {{t:}} markers).
    if (isWordRecord) doc.renameWordSpeaker(oldId, newName);
    else doc.renameSpeaker(oldId, newName);
    // If the renamed speaker was selected, follow it to the new name
    if (selectedSpeakers.has(oldId)) {
      const next = new Set(selectedSpeakers);
      next.delete(oldId);
      next.add(newName);
      selectedSpeakers = next;
    }
  }

  function mergeSpeakers(sourceIds: string[], targetName: string) {
    // Word records: merge via the word-aware rename so {{t:}} markers survive.
    if (isWordRecord) for (const id of sourceIds) doc.renameWordSpeaker(id, targetName);
    else doc.mergeSpeakers(sourceIds, targetName);
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
    if (e.target instanceof HTMLElement && e.target.isContentEditable) return;
    if (e.key === " " && ytId && ytPlayer && playerReady) {
      e.preventDefault();
      if (ytPlayer.getPlayerState() === 1) ytPlayer.pauseVideo();
      else ytPlayer.playVideo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === "f" || e.key === "h")) {
      // In-editor find/replace over the raw body text. Switch to the raw
      // editor (the universal text surface) and open the bar.
      e.preventDefault();
      view = "raw";
      findOpen = true;
      requestAnimationFrame(() => findBar?.focus());
    } else if ((e.ctrlKey || e.metaKey) && e.key === "s") {
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
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && view === "ingest" && isWordRecord) {
      // Word editor has no segment nav, so Up/Down step playback speed
      // (up = faster). One step per press; ignore OS key-repeat.
      e.preventDefault();
      if (e.repeat) return;
      const cur = Math.max(0, playbackRates.indexOf(playbackRate));
      const next =
        e.key === "ArrowUp"
          ? Math.min(cur + 1, playbackRates.length - 1)
          : Math.max(cur - 1, 0);
      setPlaybackRate(playbackRates[next]);
    } else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && view === "ingest" && hasTranscript) {
      // Up/Down = jump to the previous/next sentence. Ignore the OS
      // key-repeat that fires while a key is held, and throttle rapid
      // double-fires, so one press moves exactly one segment.
      e.preventDefault();
      if (e.repeat) return;
      const now = Date.now();
      if (now - lastSegmentNavAt < 150) return;
      lastSegmentNavAt = now;
      navigateSegment(e.key === "ArrowDown" ? 1 : -1, e.shiftKey);
    } else if (
      (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
      view === "ingest" &&
      hasTranscript &&
      ytId && ytPlayer && playerReady
    ) {
      // Left/Right = seek the video by +/- SEEK_STEP. Holding scrubs.
      // Only in a video transcript; record nav stays on n/p here so the
      // arrows don't bounce the reviewer between records mid-playback.
      e.preventDefault();
      const cur = ytPlayer.getCurrentTime();
      const delta = e.key === "ArrowRight" ? SEEK_STEP_SECONDS : -SEEK_STEP_SECONDS;
      ytPlayer.seekTo(Math.max(0, cur + delta), true);
    } else if (e.key === "Delete" && selected.size > 0) {
      toggleSelectedIrrelevance();
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "n" || (e.key === "ArrowRight" && !hasTranscript)) && hasNext) {
      // Next record. n is universal; ArrowRight only for non-transcript
      // records (pdf/web/ebook), where it doesn't collide with seeking.
      e.preventDefault();
      onnext?.();
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key === "p" || (e.key === "ArrowLeft" && !hasTranscript)) && hasPrev) {
      e.preventDefault();
      onprev?.();
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "a" && approveShortcutEnabled) {
      // Open the Approve modal. Won't fire when logged out, mid-submit, or
      // already approved-as-is for a clean record.
      e.preventDefault();
      submitAndAdvance = e.shiftKey && hasNext;
      showSubmitForm = true;
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
    rememberLastSegment(nextSegment.index);

    // Scroll the segment into view
    const el = document.querySelector(`[data-segment-index="${nextSegment.index}"]`);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // Restore the remembered segment once per record load. Depends on
  // segments being parsed (transcript ready) and re-arms when the record
  // hash changes. Guarded so edits that re-parse segments don't re-trigger
  // the jump. Scrolls + selects only - does not seek/play the video, so
  // returning to a record is quiet.
  let lastRestoredHash = "";
  $effect(() => {
    const hash = ingest.content_hash;
    const segs = segments; // subscribe to parsed segments
    if (!hasTranscript || segs.length === 0) return;
    if (hash === lastRestoredHash) return;
    lastRestoredHash = hash;
    let idx: number;
    try {
      const raw = localStorage.getItem(`workbench:lastseg:${hash}`);
      if (raw == null) return;
      idx = parseInt(raw, 10);
    } catch {
      return;
    }
    if (Number.isNaN(idx) || !segs.some((s) => s.index === idx)) return;
    selected = new Set([idx]);
    activeSegment = idx;
    lastClicked = idx;
    setTimeout(() => {
      const el = document.querySelector(`[data-segment-index="${idx}"]`);
      if (el) el.scrollIntoView({ block: "center", behavior: "auto" });
    }, 80);
  });

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

  // Keep keyboard focus on the app for video records. Clicking the YouTube
  // iframe focuses it, after which arrow keys go to YouTube (up/down =
  // volume) instead of our window handler, so our segment-nav / seek
  // bindings would only work depending on where the user last clicked.
  // When the iframe steals focus we hand it straight back to the app root
  // so the SAME bindings apply everywhere. The click's own play/pause has
  // already registered by the time focus returns, and blurring doesn't
  // stop playback - only the keyboard target moves. The cost is that
  // YouTube's built-in keyboard shortcuts aren't reachable, which is fine
  // since ours replace them (space = play/pause, arrows = nav/seek).
  function reclaimFocusFromVideo() {
    if (!ytId || !appRoot) return;
    // Defer so document.activeElement reflects the iframe after the click.
    setTimeout(() => {
      const active = document.activeElement;
      if (active && active.tagName === "IFRAME" && active.id === "yt-player") {
        appRoot?.focus({ preventScroll: true });
      }
    }, 0);
  }

  $effect(() => {
    if (!ytId) return;
    window.addEventListener("blur", reclaimFocusFromVideo);
    return () => window.removeEventListener("blur", reclaimFocusFromVideo);
  });
</script>

<div class="flex flex-col h-full outline-none"
  bind:this={appRoot}
  tabindex="-1"
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
    <div class="flex items-center gap-0.5 flex-none">
      <button
        onclick={() => onprev?.()}
        disabled={!hasPrev}
        class="p-1.5 rounded transition-colors flex-none
          {hasPrev
            ? 'text-on-surface-muted hover:text-on-surface hover:bg-surface cursor-pointer'
            : 'text-on-surface-muted/30 cursor-default'}"
        title="Previous record (P)"
        aria-label="Previous record"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <button
        onclick={() => onnext?.()}
        disabled={!hasNext}
        class="p-1.5 rounded transition-colors flex-none
          {hasNext
            ? 'text-on-surface-muted hover:text-on-surface hover:bg-surface cursor-pointer'
            : 'text-on-surface-muted/30 cursor-default'}"
        title="Next record (N)"
        aria-label="Next record"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>
    <div class="w-px h-8 bg-border flex-none"></div>
    <div class="flex-1 min-w-0">
      <h2 class="font-ui font-semibold text-on-surface truncate">
        {ingest.frontmatter.title ?? "Untitled"}
      </h2>
      {#if liveCreators.length > 0}
        <p class="text-xs text-on-surface-muted truncate">
          {liveCreators.join(", ")}
        </p>
      {/if}
      <div class="flex gap-3 mt-1 text-xs text-on-surface-muted font-ui">
        <span>{ingest.frontmatter.source_type?.toUpperCase()}</span>
        <span>{ingest.frontmatter.date}</span>
        {#if hasTranscript}
          <span>{segments.length} segments</span>
        {/if}
        {#if doc.dirty}
          <button
            onclick={showDiff}
            class="text-warning font-medium underline decoration-dotted underline-offset-2 hover:decoration-solid cursor-pointer"
            title="View what changed (diff)"
          >unsaved changes</button>
        {/if}
      </div>
    </div>
    <!-- Column visibility toggles -->
    <div
      class="flex items-center gap-0.5 text-xs font-ui font-medium flex-none p-0.5 rounded bg-surface border border-border"
      role="group"
      aria-label="Column visibility"
    >
      <button
        onclick={() => toggleCol("source")}
        disabled={singleColumn}
        title={singleColumn ? "No source available for this record" : (cols.source ? "Hide source column" : "Show source column")}
        class="px-2 py-1 rounded transition-colors
          {singleColumn
            ? 'text-on-surface-muted opacity-50 cursor-default'
            : cols.source
              ? 'bg-primary text-on-primary cursor-pointer'
              : 'text-on-surface-secondary hover:bg-surface-alt cursor-pointer'}"
      >Source</button>
      <button
        onclick={() => toggleCol("ingest")}
        title={cols.ingest ? "Hide ingest column" : "Show ingest column"}
        class="px-2 py-1 rounded transition-colors cursor-pointer
          {cols.ingest ? 'bg-primary text-on-primary' : 'text-on-surface-secondary hover:bg-surface-alt'}"
      >Ingest</button>
      <button
        onclick={() => toggleCol("digest")}
        disabled={!digest}
        title={!digest ? "No digest produced for this record yet" : (cols.digest ? "Hide digest column" : "Show digest column")}
        class="px-2 py-1 rounded transition-colors
          {!digest
            ? 'text-on-surface-muted opacity-50 cursor-default'
            : cols.digest
              ? 'bg-primary text-on-primary cursor-pointer'
              : 'text-on-surface-secondary hover:bg-surface-alt cursor-pointer'}"
      >
        Digest
        {#if digest}
          <span class="ml-1 text-[10px] opacity-70 tabular-nums">
            {(digest.domain_claims?.length || 0) + (digest.infrastructure_claims?.length || 0)}
          </span>
        {/if}
      </button>
    </div>

    <button
      onclick={() => (showHistory = !showHistory)}
      class="px-2 py-1 rounded text-xs font-ui font-medium flex-none border border-border transition-colors cursor-pointer
        {showHistory ? 'bg-primary text-on-primary' : 'text-on-surface-secondary hover:bg-surface'}"
      title="Who edited this record, and when (from its git history)"
    >History</button>

    {#if ontuning && !STATIC_READS}
      <button
        onclick={ontuning}
        class="px-2 py-1 rounded text-xs font-ui font-medium flex-none border border-border
          text-on-surface-secondary hover:bg-surface transition-colors cursor-pointer"
        title="Relevance tuning: highlight the spans a good extraction should cover"
      >Tuning</button>
    {/if}

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
    {:else if needsVerify}
      <span
        class="flex items-center gap-1.5 text-xs font-ui font-medium text-warning flex-none"
        title="Speakers were carried over from your earlier review of this record. Verify them and submit to confirm."
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v6h6M20 20v-6h-6M20 9a8 8 0 0 0-14-3M4 15a8 8 0 0 0 14 3" />
        </svg>
        Carried over - verify
      </span>
    {/if}
  </div>

  <!-- Status bar. saveFailed takes priority over every other state: the
       in-memory edit exists nowhere else, so this must be the loudest, hardest
       to miss thing on the page until it clears (next successful save) or the
       reviewer submits. Never silent - this is the fix for a review that once
       looked fine on screen for hours and then simply wasn't there on reload. -->
  <div class="px-4 py-1.5 border-b border-border flex items-center gap-2 flex-none text-xs font-ui
    {doc.saveFailed ? 'bg-error text-on-error' : syncWarning ? 'bg-warning text-on-warning' : doc.dirty ? 'bg-warning-container/30 text-on-warning-container' : user ? 'bg-success-container/30 text-on-success-container' : 'bg-surface-alt text-on-surface-muted'}">
    {#if doc.saveFailed}
      <svg class="w-3.5 h-3.5 flex-none animate-pulse" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
      </svg>
      <span class="font-semibold">Your last edit could NOT be saved in this browser (storage full) - do not reload or close this tab.</span>
      <button
        onclick={() => { if (user) showSubmitForm = true; }}
        class="ml-1 underline font-semibold cursor-pointer hover:no-underline"
      >Submit now</button>
    {:else if syncWarning}
      <svg class="w-3.5 h-3.5 flex-none" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
      </svg>
      <span class="font-semibold">{syncWarning}</span>
      <button
        onclick={() => (syncWarning = null)}
        class="ml-auto underline cursor-pointer hover:no-underline flex-none"
        title="Dismiss"
      >Dismiss</button>
    {:else if doc.dirty}
      <svg class="w-3.5 h-3.5 flex-none" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
      <button
        onclick={showDiff}
        class="underline decoration-dotted underline-offset-2 hover:decoration-solid cursor-pointer"
        title="View what changed (diff)"
      >You have unsubmitted changes (saved locally) - view diff</button>
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

        {#if !isWordRecord && !isTextRecord}
          <div class="mt-3">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs font-ui text-on-surface-secondary">Coverage</span>
              <span class="text-[10px] text-on-surface-muted font-ui">
                {pendingKindedSpans.length === 0
                  ? "none marked"
                  : `${pendingKindedSpans.length} range${pendingKindedSpans.length === 1 ? "" : "s"}, ${pendingSpanLineCount} line${pendingSpanLineCount === 1 ? "" : "s"}`}
              </span>
            </div>
            <CoverageStrip
              lineCount={bodyLineCount}
              pending={pendingKindedSpans}
              previous={mergeSpans([...myObservedSpans, ...myPlayedSpans])}
              onjump={scrollToBodyLine}
            />
            <p class="text-[10px] text-on-surface-muted mt-1 font-ui">
              Amber = coverage this session (solid observed, dotted played);
              green = your previous coverage. Submitting with no edits but
              coverage marked records "looked, all fine".
            </p>
          </div>
        {:else if isTextRecord && textVerdict}
          <div class="mt-3 flex items-center gap-2">
            <span class="text-xs font-ui text-on-surface-secondary">Read coverage</span>
            <span class="text-xs font-ui font-medium text-on-surface tabular-nums">
              {observedPercent(textVerdict.observed_coverage)}%
            </span>
            {#if textVerdict.digestible}
              <span class="text-[10px] font-ui text-success">fully read</span>
            {/if}
          </div>
        {:else if isWordRecord && wordVerdict}
          <div class="mt-3 flex items-center gap-2">
            <span class="text-xs font-ui text-on-surface-secondary">Observed</span>
            <span class="text-xs font-ui font-medium text-on-surface tabular-nums">
              {observedPercent(wordVerdict.observed_coverage)}%
            </span>
            <span class="text-[10px] font-ui text-on-surface-muted">
              of {wordVerdict.total_units} words
            </span>
            {#if wordVerdict.digestible}
              <span class="text-[10px] font-ui text-success">fully observed</span>
            {/if}
          </div>
        {/if}

        {#if submitError}
          <p class="text-xs text-error mt-2">{submitError}</p>
        {/if}

        <div class="flex items-center gap-2 mt-4">
          <div class="flex-1"></div>
          <button
            onclick={() => { showSubmitForm = false; submitAndAdvance = false; }}
            class="text-xs font-ui text-on-surface-muted px-3 py-1.5 rounded cursor-pointer hover:text-on-surface"
          >Cancel</button>
          <button
            onclick={() => { submitAndAdvance = false; handleSubmit(); }}
            disabled={submitting}
            class="text-xs font-ui font-medium px-4 py-1.5 bg-primary text-on-primary rounded cursor-pointer hover:bg-primary-hover"
          >
            {submitting ? "Submitting..." : doc.dirty ? "Submit review" : "Approve"}
          </button>
          {#if hasNext}
            <button
              onclick={() => { submitAndAdvance = true; handleSubmit(); }}
              disabled={submitting}
              class="text-xs font-ui font-medium px-4 py-1.5 bg-primary/80 text-on-primary rounded cursor-pointer hover:bg-primary"
              title="Submit, then jump to the next record in the list"
            >
              {doc.dirty ? "Submit & next" : "Approve & next"}
            </button>
          {/if}
        </div>
      </div>
    </div>
  {/if}

  {#snippet speakersPanel()}
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
          rows={wordSpeakerRows}
          {namedSpeakers}
          {selectedSpeakers}
          {filteredSpeakers}
          onselect={handleSpeakerSelection}
          onfilter={(id) => {
            // Show only this speaker; clicking the sole-filtered speaker clears
            // it. Multi-speaker filters are still built via the section eye.
            filteredSpeakers =
              filteredSpeakers.size === 1 && filteredSpeakers.has(id)
                ? new Set()
                : new Set([id]);
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
  {/snippet}

  <div class="flex-1 min-h-0 {theatreActive ? 'grid' : 'flex'}" style={theatreActive ? theatreGridStyle : ''}>
    {#if visibleCols.source}
      <!-- Source panel: in theatre it's the full-width video band (header +
           video only; speakers lift out to their own column below). -->
      <div
        class="flex flex-col min-h-0 border-border {theatreActive ? 'border-b bg-black' : `${colWidthClass} border-r`}"
        style={theatreActive ? 'grid-area: src' : ''}
      >
        <div class="px-3 py-2 bg-surface-alt border-b border-border flex-none flex items-center gap-3">
          <span class="text-xs font-ui font-medium text-on-surface-secondary uppercase flex-none">Original</span>
          {#if ingest.frontmatter.source_url && !ytId}
            <!-- For YouTube videos the source link lives in the player's
                 control bar, so it isn't duplicated in this header. -->
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
          <!-- Container reshapes between modes; #yt-player keeps the exact
               same classes and parent across the toggle so the YouTube
               iframe is never reparented (which would reload the video). -->
          <!-- The whole video area is black (theatre field). The outer wrapper's
               classes change between modes but the inner #yt-player parent stays
               the same element, so the iframe never reparents/reloads. h-auto
               overrides the iframe's height="360" so aspect-video drives it. -->
          <div
            class={theatreActive
              ? "flex-none w-full mx-auto bg-black"
              : "flex-none bg-black"}
            style={theatreActive ? "max-width: calc(46vh * 16 / 9)" : ""}
          >
            <div class="w-full">
              <div id="yt-player" class="w-full h-auto aspect-video"></div>
              <div class="flex items-center gap-1 px-3 py-2">
                <span class="text-[10px] font-ui uppercase tracking-wide text-white/40 mr-1 flex-none">Speed</span>
                {#each playbackRates as rate (rate)}
                  <button
                    onclick={() => setPlaybackRate(rate)}
                    class="text-xs font-ui rounded px-1.5 py-0.5 tabular-nums transition-colors cursor-pointer
                      {playbackRate === rate
                      ? 'bg-white/15 text-white font-medium'
                      : 'text-white/50 hover:bg-white/10 hover:text-white'}"
                    title="Set playback speed to {rate}x"
                  >
                    {rate}x
                  </button>
                {/each}
                <div class="ml-auto flex items-center gap-1 flex-none">
                  <button
                    onclick={() => { theatreMode = !theatreMode; }}
                    class="p-1 rounded transition-colors {theatreMode ? 'bg-white/15 text-white' : 'text-white/60 hover:bg-white/10 hover:text-white'}"
                    title={theatreMode ? "Exit theatre mode" : "Theatre mode: video across the top, columns below"}
                    aria-label="Toggle theatre mode"
                  >
                    {#if theatreMode}
                      <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 9H5V5m10 0v4h4M5 15h4v4m6 0v-4h4" /></svg>
                    {:else}
                      <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="1.5" /></svg>
                    {/if}
                  </button>
                  {#if ingest.frontmatter.source_url}
                    <a
                      href={ingest.frontmatter.source_url}
                      target="_blank"
                      rel="noopener"
                      class="p-1 rounded text-white/70 hover:bg-white/10 transition-colors flex items-center"
                      title={ytId ? "Watch on YouTube" : "Open the source video"}
                      aria-label={ytId ? "Watch on YouTube" : "Open the source video"}
                    >
                      {#if ytId}
                        <!-- YouTube logo -->
                        <svg class="w-6 h-6" viewBox="0 0 24 24" aria-hidden="true">
                          <path fill="#FF0000" d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8z" />
                          <path fill="#fff" d="M9.6 15.6V8.4l6.2 3.6z" />
                        </svg>
                      {:else}
                        <!-- Generic video-source icon for an unrecognised platform -->
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                          <rect x="2" y="4" width="20" height="16" rx="2" />
                          <path stroke-linecap="round" stroke-linejoin="round" d="M10 9l5 3-5 3z" />
                        </svg>
                      {/if}
                    </a>
                  {/if}
                </div>
              </div>
            </div>
          </div>
        {:else if localSourceUrl && (isAudio || isVideo)}
          <div class="flex-none p-4">
            <video
              controls
              src={localSourceUrl}
              class="w-full rounded"
              ontimeupdate={(e) => {
                const el = e.currentTarget;
                currentTime = el.currentTime;
                if (!el.paused) {
                  trackPlayback(el.currentTime, Number.isFinite(el.duration) ? el.duration : undefined);
                }
              }}
              onseeking={() => { playWindow = null; }}
            >
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
            {#if ingest.frontmatter.source_url && !dragging}
              <!-- The archived capture isn't served here (web originals live at
                   their source URL); link out so the reviewer can check the
                   extraction against the live page. -->
              <p class="text-on-surface-secondary">The original isn't archived here.</p>
              <a
                href={ingest.frontmatter.source_url}
                target="_blank"
                rel="noopener"
                class="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-ui bg-primary
                  text-on-primary rounded hover:bg-primary-hover transition-colors"
              >
                Open the original page &rsaquo;
              </a>
              <p class="text-on-surface-muted text-xs">or drop the source file to view it here</p>
            {:else}
              <p>{dragging ? "Drop file here" : "Drop a source file here to view alongside the ingest"}</p>
            {/if}
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

        <!-- Speakers panel. In normal layout it sits below the media in the
             source column; in theatre it lifts out to its own column beneath
             the full-width video (rendered as the `spk` grid item below). -->
        {#if hasTranscript && !theatreActive}
          <div class="flex-1 overflow-auto border-t border-border min-h-0">
            {@render speakersPanel()}
          </div>
        {/if}
    </div>
    {/if}

    {#if theatreActive && hasTranscript}
      <!-- Speakers as its own column beneath the video in theatre mode. -->
      <div style="grid-area: spk" class="flex flex-col min-h-0 overflow-auto border-r border-border">
        {@render speakersPanel()}
      </div>
    {/if}

    {#if visibleCols.ingest}
    <!-- Ingest panel -->
    <div
      class="flex flex-col min-h-0 {theatreActive ? '' : colWidthClass} {visibleCols.digest ? 'border-r border-border' : ''}"
      style={theatreActive ? 'grid-area: ing' : ''}
    >
      <!-- Source URL bar shown when the source column is hidden (e.g. for web ingests) -->
      {#if !visibleCols.source && ingest.frontmatter.source_url}
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
      <!-- Panel header with view tabs and controls. flex-wrap so the strip
           reflows cleanly when the column is narrow (three-column layout). -->
      <div class="px-3 py-2 bg-surface-alt border-b border-border flex flex-wrap items-center gap-x-1 gap-y-1.5">
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

          <!-- Skip-irrelevant-during-playback toggle -->
          {#if view === "ingest" && hasTranscript && ytId && irrelevantCount > 0}
            <button
              onclick={() => { skipIrrelevant = !skipIrrelevant; }}
              class="flex items-center gap-1 cursor-pointer px-1.5 py-0.5 rounded-full transition-colors text-xs font-ui font-medium
                {skipIrrelevant
                  ? 'bg-primary/10 text-primary'
                  : 'text-on-surface-muted hover:text-on-surface hover:bg-surface'}"
              title={skipIrrelevant
                ? "Skipping irrelevant content during playback - click to play through it"
                : "Playing through irrelevant content - click to skip it"}
            >
              <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M4 5v14l8-7zM13 5v14l8-7z" />
              </svg>
              Skip
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
                  ? `${irrelevantCount} irrelevant ${isWordRecord ? "words" : "segments"} hidden - click to show`
                  : `Showing ${irrelevantCount} irrelevant ${isWordRecord ? "words" : "segments"} - click to hide`}
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
        <div class="border-b border-border bg-surface-alt/50 px-4 py-3 flex-none flex flex-col gap-3">
          <EditableMetadata
            publisher={livePublisher}
            creators={liveCreators}
            canEdit={!!user}
            onsave={({ publisher, creators }) =>
              doc.updateFrontmatter({ publisher, creators })}
          />
          <!-- Acquisition provenance: where this record came from. -->
          <div class="flex items-baseline gap-2 text-xs font-ui">
            <span class="text-on-surface-muted w-32 flex-none">Origin</span>
            {#if liveProvenance.kind === "url"}
              <a
                href={liveProvenance.label}
                target="_blank"
                rel="noopener noreferrer"
                class="text-primary hover:underline truncate"
                title={liveProvenance.label}
              >{liveProvenance.label}</a>
            {:else if liveProvenance.kind === "file"}
              <span class="text-on-surface" title="Local source file">
                {liveProvenance.label} <span class="text-on-surface-muted">(local file)</span>
              </span>
            {:else}
              <span class="text-warning font-medium" title="Acquisition origin is unrecoverable">
                {liveProvenance.label}
              </span>
            {/if}
          </div>
          <details class="text-xs">
            <summary class="cursor-pointer text-on-surface-muted hover:text-on-surface select-none">
              Raw frontmatter
            </summary>
            <pre class="mt-2 font-mono text-on-surface whitespace-pre-wrap">{currentRawFrontmatter}</pre>
          </details>
        </div>
      {/if}

      <!-- Review history panel: who edited this record, newest first. Its own
           panel with a title-bar toggle - provenance must be findable, not
           buried inside the metadata drawer. -->
      {#if showHistory}
        <div class="border-b border-border bg-surface-alt/50 px-4 py-3 flex-none max-h-64 overflow-y-auto">
          <ReviewHistory hash={ingest.content_hash} startOpen />
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
                  disabled={unlocking}
                  placeholder="64-character hex hash"
                  class="flex-1 text-xs font-mono bg-surface border border-border rounded px-3 py-2
                    text-on-surface outline-none focus:border-primary placeholder:text-on-surface-muted/50
                    disabled:opacity-50"
                />
                <button
                  type="submit"
                  disabled={unlocking}
                  class="text-xs font-ui font-medium px-4 py-2 rounded cursor-pointer
                    bg-primary text-on-primary hover:bg-primary-hover
                    disabled:opacity-50 disabled:cursor-default"
                >
                  {unlocking ? "Checking..." : "Verify"}
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
            bind:this={rawTextarea}
            data-scroll-sync
            value={currentBody()}
            oninput={(e) => doc.editBody((e.target as HTMLTextAreaElement).value)}
            onscroll={handleContentScroll}
            class="flex-1 w-full resize-none bg-surface text-xs text-on-surface leading-relaxed
              p-4 font-mono outline-none border-none"
            spellcheck="false"
          ></textarea>
          {#if findOpen}
            <FindReplaceBar
              bind:this={findBar}
              text={currentBody()}
              onreplace={(t) => doc.editBody(t)}
              onlocate={(start, end) => {
                rawTextarea?.focus();
                rawTextarea?.setSelectionRange(start, end);
              }}
              onclose={() => {
                findOpen = false;
              }}
            />
          {/if}
        </div>

      {:else if isWordRecord}
        <!-- Per-word-timestamp record: isolated word-level editor. No
             coverage gutter or mark-observed wiring in this view by design. -->
        {#if filteredSpeakers.size > 0}
          <div class="px-3 py-1.5 bg-primary-container/20 border-b border-border flex items-center gap-2 flex-wrap flex-none">
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
        <div class="relative flex-1 flex flex-col min-h-0">
          <WordTranscript
            body={currentBody()}
            namedSpeakers={namedSpeakersOrdered}
            {currentTime}
            {filteredSpeakers}
            {hideIrrelevant}
            storageKey={`workbench:observed:${ingest.content_hash}`}
            notesStorageKey={`workbench:notes:${ingest.content_hash}`}
            serverObserved={serverObservedWords}
            {claimHighlight}
            onreassign={(from, to, speaker) => doc.reassignWords(from, to, speaker)}
            onreplaceselection={(from, to, w) => doc.replaceSelection(from, to, w)}
            onseek={(seconds) => {
              if (ytPlayer && playerReady) {
                ytPlayer.seekTo(Math.max(0, seconds), true);
                ytPlayer.playVideo();
              }
            }}
            onmarkresume={(seconds) => {
              // Park the playhead at the marked word (paused) so the reviewer's
              // next Play resumes from there - and so continued playback doesn't
              // auto-observe the still-unobserved word just past the marker.
              if (ytPlayer && playerReady) {
                ytPlayer.seekTo(Math.max(0, seconds), true);
                ytPlayer.pauseVideo();
              }
            }}
            onverdict={(v) => (wordVerdict = v)}
          />
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
            <div class="w-px h-4 bg-border mx-1" aria-hidden="true"></div>
            <!-- Observed toggle: personal review-tracking, not a content edit.
                 Clears both pending tiers when the whole selection is marked;
                 never touches submitted coverage or the irrelevant tag. -->
            <button
              onclick={toggleSelectedObserved}
              class="text-xs font-ui px-2 py-1 rounded cursor-pointer border border-transparent text-on-surface-muted hover:border-border hover:text-warning"
              title={selectionAllMarked
                ? "Remove pending played/observed marks from the selected segments"
                : "Mark all selected segments as observed (pending coverage)"}
            >
              {selectionAllMarked ? "Clear observed" : "Mark observed"}
            </button>
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
                  {@const sp = [SPEAKER_IRRELEVANT, SPEAKER_NARRATOR, SPEAKER_EXTERNAL_FOOTAGE, SPEAKER_GROUP].filter((s) => s !== current)}
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
                    {@const sp = [SPEAKER_IRRELEVANT, SPEAKER_NARRATOR, SPEAKER_EXTERNAL_FOOTAGE, SPEAKER_GROUP].filter((s) => s !== current)}
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
                      namedSpeakers={namedSpeakersOrdered}
                      onsplit={(pieces) => {
                        doc.splitSegmentMulti(segment.speaker, segment.time, pieces);
                        splittingIndex = null;
                      }}
                      oncancel={() => { splittingIndex = null; }}
                    />
                  </div>
                {:else}
                  {@const sentencePickerOpen = speakerPicker?.kind === "sentence" && speakerPicker.key === segment.index}
                  {@const backwards = nonMonotonicIndices.has(segment.index)}
                  <div
                    data-segment-index={segment.index}
                    class="relative px-4 py-1 border-l-2 transition-colors cursor-pointer select-none group/row
                      {isSelected
                        ? 'bg-primary/15 border-primary'
                        : 'border-transparent hover:bg-primary-container/15'}"
                    role="button"
                    tabindex="0"
                    onclick={(e) => handleSegmentClick(segment, e)}
                    onkeydown={(e) => { if (e.key === 'Enter') handleSegmentClick(segment, e as unknown as MouseEvent); }}
                  >
                    {#if pendingSegments.has(segment.index)}
                      <div
                        class="absolute left-0.5 inset-y-0.5 w-0.5 rounded bg-warning/80 pointer-events-none"
                        title="Observed - marked or edited (unsubmitted)"
                      ></div>
                    {:else if playedSegments.has(segment.index)}
                      <div
                        class="absolute left-0.5 inset-y-0.5 w-0.5 rounded pointer-events-none"
                        style="background: repeating-linear-gradient(to bottom, var(--color-warning) 0 3px, transparent 3px 6px)"
                        title="Played through during this session (unsubmitted)"
                      ></div>
                    {:else if coveredSegments.has(segment.index)}
                      <div
                        class="absolute left-0.5 inset-y-0.5 w-0.5 rounded bg-success/70 pointer-events-none"
                        title="Inside your previous review coverage (observed)"
                      ></div>
                    {:else if playedCoveredSegments.has(segment.index)}
                      <div
                        class="absolute left-0.5 inset-y-0.5 w-0.5 rounded pointer-events-none"
                        style="background: repeating-linear-gradient(to bottom, var(--color-success) 0 3px, transparent 3px 6px)"
                        title="Inside your previous review coverage (played)"
                      ></div>
                    {/if}
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
                          {@const sp = [SPEAKER_IRRELEVANT, SPEAKER_NARRATOR, SPEAKER_EXTERNAL_FOOTAGE, SPEAKER_GROUP].filter((s) => s !== current)}
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
                      <button
                        onclick={(e) => { e.stopPropagation(); suppressHoverResume = true; editingIndex = segment.index; }}
                        class="flex-none self-start pt-0.5 text-right font-mono tabular-nums text-[10px] leading-relaxed min-w-[3.25rem] cursor-pointer hover:text-primary transition-colors
                          {backwards ? 'text-error font-semibold' : 'text-on-surface-muted/45 group-hover/row:text-on-surface-muted'}"
                        title={backwards
                          ? `Timestamp goes backwards (${secondsToTime(segment.seconds)}) - the timeline should only move forwards. Click to edit.`
                          : `${secondsToTime(segment.seconds)} - click to edit timestamp`}
                      >
                        {#if backwards}
                          <span aria-hidden="true">&#9650;</span>
                        {/if}{secondsToTime(segment.seconds)}
                      </button>
                      <span class="text-sm text-on-surface leading-relaxed flex-1">{segment.lines.join(" ")}</span>
                      {#if isSingleSelected}
                        <div
                          class="flex items-center gap-0.5 flex-none pt-0.5"
                          role="toolbar"
                          tabindex="-1"
                          onmouseenter={onControlsEnter}
                          onmouseleave={onControlsLeave}
                        >
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
                          {#if visibleSegments[0]?.index !== segment.index}
                            <button onclick={(e) => {
                                e.stopPropagation();
                                const pos = visibleSegments.findIndex((s) => s.index === segment.index);
                                const prev = pos > 0 ? visibleSegments[pos - 1] : null;
                                if (prev) {
                                  doc.mergeSegmentInto(segment.speaker, segment.time, prev.speaker, prev.time);
                                  selected = new Set();
                                }
                              }}
                              class="p-0.5 rounded cursor-pointer text-on-surface-muted/50 hover:text-on-surface hover:bg-surface-alt transition-colors"
                              title="Merge up: append this segment onto the one above">
                              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 19V5M5 12l7-7 7 7" /></svg>
                            </button>
                          {/if}
                          {#if segment.lines.join("\n").length > 1}
                            <button onclick={(e) => { e.stopPropagation(); suppressHoverResume = true; splittingIndex = segment.index; }}
                              class="p-0.5 rounded cursor-pointer text-on-surface-muted/50 hover:text-on-surface hover:bg-surface-alt transition-colors"
                              title="Split this segment">
                              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" d="M12 2v20M2 12h4M18 12h4" /></svg>
                            </button>
                          {/if}
                          <button onclick={(e) => { e.stopPropagation(); suppressHoverResume = true; editingIndex = segment.index; }}
                            class="p-0.5 rounded cursor-pointer text-on-surface-muted/50 hover:text-primary hover:bg-surface-alt transition-colors"
                            title="Edit timestamp and text">
                            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                              <path stroke-linecap="round" stroke-linejoin="round" d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                              <path stroke-linecap="round" stroke-linejoin="round" d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>
                          <div class="w-px h-3.5 bg-border mx-0.5" aria-hidden="true"></div>
                          <!-- Observed toggle: review tracking, kept apart from the edit actions -->
                          <button onclick={(e) => { e.stopPropagation(); toggleSelectedObserved(); }}
                            class="p-0.5 rounded cursor-pointer text-on-surface-muted/50 hover:text-warning hover:bg-warning/15 transition-colors"
                            title={selectionAllMarked
                              ? "Clear pending played/observed marks on this segment"
                              : "Mark this segment as observed (pending coverage)"}
                            aria-label={selectionAllMarked
                              ? "Clear pending coverage marks on this segment"
                              : "Mark this segment as observed"}>
                            {#if selectionAllMarked}
                              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M3 7l4-4 14 14-4 4L3 7zM14 4l6 6M5 19l4-4" />
                              </svg>
                            {:else}
                              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                            {/if}
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
        {#if isTextRecord}
          <ReadableText
            body={currentBody()}
            renderBlock={(src) => renderRedactions(marked.parse(preprocessAnnotations(src)) as string)}
            previousObserved={myObservedSpans}
            storageKey={`workbench:read:${ingest.content_hash}`}
            bind:containerEl={proseContainer}
            onscroll={handleContentScroll}
            onverdict={(v) => (textVerdict = v)}
          />
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
      {/if}
    </div>
    {/if}

    {#if visibleCols.digest && digest}
    <!-- Digest panel -->
    <div
      class="flex flex-col min-h-0 {theatreActive ? '' : colWidthClass}"
      style={theatreActive ? 'grid-area: dig' : ''}
    >
      <div class="px-3 py-2 bg-surface-alt border-b border-border flex-none flex items-center gap-3">
        <span class="text-xs font-ui font-medium text-on-surface-secondary uppercase flex-none">Digest</span>
        <span class="text-xs text-on-surface-muted font-ui flex-none">{digest.model}</span>
        <span class="text-xs text-on-surface-muted font-ui flex-none" title="Schema version">{digest.schema}</span>
        <span class="text-xs text-on-surface-muted font-ui flex-none ml-auto tabular-nums">
          {digest.nodes.length} nodes ·
          {(digest.domain_claims?.length || 0) + (digest.infrastructure_claims?.length || 0)} claims
        </span>
      </div>

      <!-- View controls: claim-type filter pills + collapse-all -->
      <div class="px-3 py-2 bg-surface border-b border-border flex-none flex flex-wrap items-center gap-1.5 text-xs font-ui">
        <span class="text-on-surface-muted">Show:</span>
        {#each CLAIM_TYPES as ct}
          {@const on = claimTypeFilter[ct]}
          <button
            type="button"
            onclick={() => toggleClaimType(ct)}
            class="px-2 py-0.5 rounded transition-colors cursor-pointer capitalize
              {on
                ? 'bg-primary/15 text-primary font-medium'
                : 'bg-surface-alt text-on-surface-muted hover:bg-surface line-through opacity-60'}"
            title="{on ? 'Hide' : 'Show'} {ct} claims"
          >{ct}</button>
        {/each}
        <button
          type="button"
          onclick={() => {
            const target = !allClaimTypesOn;
            claimTypeFilter = Object.fromEntries(CLAIM_TYPES.map((t) => [t, target]));
          }}
          class="ml-1 px-2 py-0.5 rounded text-on-surface-muted hover:bg-surface-alt cursor-pointer"
          title={allClaimTypesOn ? "Hide all" : "Show all"}
        >{allClaimTypesOn ? "none" : "all"}</button>

        <span class="ml-auto"></span>
        <button
          type="button"
          onclick={() => {
            const anyOpen = !collapsed.nodes || !collapsed.domain || !collapsed.infrastructure;
            collapsed = { nodes: anyOpen, domain: anyOpen, infrastructure: anyOpen };
          }}
          class="px-2 py-0.5 rounded text-on-surface-muted hover:bg-surface-alt cursor-pointer"
          title="Collapse or expand all sections"
        >{(collapsed.nodes && collapsed.domain && collapsed.infrastructure) ? "expand all" : "collapse all"}</button>
      </div>

      <!-- Active filter indicator: outside the scroll container so it sits
           flush against the controls bar instead of becoming a sticky island
           inside the padded scroll area. -->
      {#if selectedNodeIds.size > 0}
        <div class="px-3 py-2 bg-primary/10 border-b border-primary/40 flex-none flex items-center gap-2 text-xs font-ui">
          <span class="text-on-surface-muted flex-none">
            Filtering by{selectedNodeIds.size > 1 ? ` (${selectedNodeIds.size}, any of)` : ""}:
          </span>
          <div class="flex flex-wrap gap-1 min-w-0">
            {#each selectedNodeNames as name, i}
              {@const nodeId = [...selectedNodeIds][i]}
              <span class="font-mono text-primary font-medium inline-flex items-center gap-1 bg-primary/15 rounded px-1.5 py-0.5">
                {name}
                <button
                  type="button"
                  onclick={() => _toggleNodeFilter(nodeId, true)}
                  class="text-primary/70 hover:text-primary cursor-pointer"
                  title="Remove from filter"
                  aria-label="Remove {name} from filter"
                >×</button>
              </span>
            {/each}
          </div>
          <button
            type="button"
            onclick={() => { selectedNodeIds = new Set(); }}
            class="ml-auto px-2 py-0.5 rounded text-primary hover:bg-primary/15 cursor-pointer font-medium flex-none"
            title="Clear filter"
          >Clear</button>
        </div>
      {/if}

      <div class="flex-1 overflow-auto px-5 py-5 space-y-8">
        <!-- Nodes grouped by type. One name per line, divider between rows. -->
        <section>
          <button
            type="button"
            onclick={() => toggleCollapsed("nodes")}
            class="w-full text-left text-xs font-ui font-semibold uppercase tracking-wide text-on-surface-secondary mb-3 pb-2 border-b border-border flex items-center gap-2 cursor-pointer hover:text-on-surface"
            title={collapsed.nodes ? "Expand nodes" : "Collapse nodes"}
          >
            <svg
              class="w-3 h-3 transition-transform {collapsed.nodes ? '' : 'rotate-90'}"
              fill="currentColor"
              viewBox="0 0 20 20"
            ><path d="M6 5l8 5-8 5V5z" /></svg>
            Nodes <span class="opacity-50 tabular-nums font-normal normal-case">{digest.nodes.length}</span>
          </button>
          {#if !collapsed.nodes}
          <div class="space-y-5">
            {#each NODE_TYPE_ORDER as nodeType}
              {@const ofType = digest.nodes.filter(n => n.type === nodeType)}
              {#if ofType.length > 0}
                <div>
                  <div class="text-[11px] font-ui font-medium uppercase tracking-wider text-on-surface-muted mb-1.5 flex items-baseline gap-2">
                    <span>{NODE_TYPE_PLURALS[nodeType] || nodeType}</span>
                    <span class="opacity-60 tabular-nums normal-case font-normal">{ofType.length}</span>
                  </div>
                  <ul class="divide-y divide-border/60">
                    {#each ofType as n (n.id)}
                      <li class="leading-snug">
                        <button
                          type="button"
                          onclick={(e) => toggleNodeFilter(n.id, e)}
                          title={selectedNodeIds.has(n.id) ? "Click to clear; Ctrl/Cmd/Shift+click to remove from selection" : "Click to filter; Ctrl/Cmd/Shift+click to add to selection"}
                          class="w-full text-left py-1.5 px-1 -mx-1 text-sm font-mono break-words rounded transition-colors cursor-pointer
                            {selectedNodeIds.has(n.id)
                              ? 'bg-primary/15 text-primary'
                              : 'hover:bg-surface-alt'}"
                        >{n.name}</button>
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}
            {/each}
          </div>
          {/if}
        </section>

        <!-- Claims (domain first, then infrastructure). Card per claim,
             clear visible boundaries. -->
        {#each claimSections as section, sectionIndex}
          {@const sectionKey = (sectionIndex === 0 ? "domain" : "infrastructure")}
          {@const isCollapsed = collapsed[sectionKey]}
          {#if section.total > 0}
            <section>
              <button
                type="button"
                onclick={() => toggleCollapsed(sectionKey)}
                class="w-full text-left text-xs font-ui font-semibold uppercase tracking-wide text-on-surface-secondary mb-3 pb-2 border-b border-border flex items-center gap-2 cursor-pointer hover:text-on-surface"
                title={isCollapsed ? "Expand " + section.label : "Collapse " + section.label}
              >
                <svg
                  class="w-3 h-3 transition-transform {isCollapsed ? '' : 'rotate-90'}"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                ><path d="M6 5l8 5-8 5V5z" /></svg>
                {section.label}
                <span class="opacity-50 tabular-nums font-normal normal-case">
                  {#if (selectedNodeIds.size > 0 || !allClaimTypesOn) && section.claims.length !== section.total}
                    {section.claims.length} / {section.total}
                  {:else}
                    {section.total}
                  {/if}
                </span>
              </button>
              {#if !isCollapsed && section.claims.length === 0}
                <p class="text-xs text-on-surface-muted font-ui italic mb-2">
                  No claims match the current filters.
                </p>
              {/if}
              {#if !isCollapsed}
              <ul class="space-y-3">
                {#each section.claims as c (c.id)}
                  <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
                  <li
                    data-claim-id={c.id}
                    role="button"
                    tabindex="0"
                    onclick={(e) => _onClaimCardClick(c, e)}
                    onkeydown={(e) => _onClaimCardKey(c, e)}
                    class="bg-surface-alt/40 border border-border rounded-md px-3.5 py-3 text-sm leading-relaxed claim-card cursor-pointer hover:bg-surface-alt/70 transition-colors"
                    title="Click to highlight this claim's quote in the ingest"
                  >
                    <!-- Metadata row -->
                    <div class="text-[11px] font-ui text-on-surface-muted mb-2 flex gap-x-2 gap-y-1 flex-wrap items-center">
                      <span class="px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium uppercase tracking-wide text-[10px]">
                        {c.type}
                      </span>
                      {#if c.attestation}
                        <span class="opacity-70">{c.attestation.replace("_", "-")}</span>
                      {/if}
                      {#if c.speaker}
                        <span class="opacity-50">·</span>
                        <span>by <span class="font-mono text-on-surface">{c.speaker.name}</span></span>
                      {/if}
                      {#if c.date}
                        <span class="opacity-50">·</span>
                        <span class="tabular-nums">{c.date}</span>
                      {/if}
                      {#if c.date_range}
                        <span class="opacity-50">·</span>
                        <span class="tabular-nums">{c.date_range[0]} to {c.date_range[1]}</span>
                      {/if}
                      {#if c.location}
                        <span class="opacity-50">·</span>
                        <span class="opacity-70">{c.location}</span>
                      {/if}
                    </div>

                    <!-- Claim text -->
                    <div class="text-on-surface">{c.text}</div>

                    <!-- Verbatim quote, indented to make the relationship obvious -->
                    {#if c.quote}
                      <blockquote class="mt-2 pl-3 border-l-2 border-border/70 text-xs italic text-on-surface-muted leading-relaxed">
                        {c.quote}
                      </blockquote>
                    {/if}

                    <!-- Referenced nodes (click to filter claims to that node) -->
                    {#if c.refs && c.refs.length > 0}
                      <div class="mt-2.5 flex flex-wrap gap-1 pt-2 border-t border-border/40">
                        {#each c.refs as r}
                          {#if r.id}
                            <button
                              type="button"
                              onclick={(e) => toggleNodeFilter(r.id!, e)}
                              class="text-[10px] px-1.5 py-0.5 rounded border font-mono transition-colors cursor-pointer
                                {selectedNodeIds.has(r.id)
                                  ? 'bg-primary/15 border-primary/40 text-primary'
                                  : 'bg-surface border-border hover:bg-surface-alt'}"
                              title={selectedNodeIds.has(r.id) ? `In filter (Ctrl/Shift+click to remove): ${r.name}` : `Filter to ${r.name} (Ctrl/Shift+click to add to selection)`}
                            >{r.name}</button>
                          {:else}
                            <span class="text-[10px] px-1.5 py-0.5 rounded bg-surface border border-border font-mono opacity-60"
                                  title="No id - cannot filter">{r.name}</span>
                          {/if}
                        {/each}
                      </div>
                    {/if}
                  </li>
                {/each}
              </ul>
              {/if}
            </section>
          {/if}
        {/each}
      </div>
    </div>
    {/if}
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
      canPreview={!!ytId && playerReady}
      onpreview={previewSeek}
      onsave={(newSpeaker, newTime, newText) => {
        // Target by index, not (speaker, time): the latter isn't unique
        // (split halves share it), which let edits land on the wrong segment.
        const idx = editSegment.index;
        doc.editSegmentByIndex(idx, newSpeaker, newTime, newText);
        editingIndex = null;
        // Keep the selection on the segment we just edited rather than
        // letting auto-follow snap it to wherever the preview left the video.
        selected = new Set([idx]);
        activeSegment = idx;
        lastClicked = idx;
        autoFollowPaused = true;
        if (autoFollowTimer) clearTimeout(autoFollowTimer);
        autoFollowTimer = setTimeout(() => { autoFollowPaused = false; }, 1500);
      }}
      oncancel={() => { editingIndex = null; }}
    />
  {/if}
{/if}
