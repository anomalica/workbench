<script lang="ts">
  import {
    fetchIngests,
    fetchIngest,
    fetchDigest,
    fetchCurrentUser,
    fetchReviewedHashes,
    fetchSchedule,
    fetchIngestTitles,
    provenanceOf,
  } from "$lib/api";
  import type {
    IngestSummary,
    IngestDetail,
    DigestDocument,
    User,
  } from "$lib/api";
  import FileDropZone from "$lib/components/FileDropZone.svelte";
  import IngestList from "$lib/components/IngestList.svelte";
  import IngestViewer from "$lib/components/IngestViewer.svelte";
  import GraphView from "$lib/components/GraphView.svelte";
  import ScheduleView from "$lib/components/ScheduleView.svelte";
  import CurateMock from "$lib/components/CurateMock.svelte";
  import type { ScheduleQueue, IngestTitle } from "$lib/schedule";
  import { carryoverState } from "$lib/carryover";
  import { themeState } from "$lib/theme.svelte";

  let user = $state<User | null>(null);
  // Top-level view: record review (default), knowledge-graph review, or the
  // prioritised work-queue Schedule view.
  let appMode = $state<"records" | "graph" | "schedule" | "curate-mock">("records");
  // A node to open directly in the graph view (deep link /graph/<node_id>), so a
  // claim-count / any link can jump straight to that node's claims in context.
  let graphNodeId = $state<string | undefined>(undefined);

  // The scheduler's queue, fetched lazily (when the Schedule tab or the Records
  // "sort by demand" first needs it). Its recordDemand map drives the sort.
  let scheduleQueue = $state<ScheduleQueue | null>(null);
  // {content_hash -> {title, source_url}} for un-ingested sources, so the Schedule
  // view shows transcription jobs' episode titles + source links, not hashes.
  let ingestTitles = $state<Record<string, IngestTitle>>({});
  let scheduleRequested = false;
  async function loadSchedule() {
    if (scheduleRequested) return;
    scheduleRequested = true;
    try {
      scheduleQueue = await fetchSchedule();
    } catch {
      scheduleRequested = false; // allow a retry
      return;
    }
    try {
      ingestTitles = await fetchIngestTitles();
    } catch {
      /* titles are best-effort; the UI keeps the hash fallback */
    }
  }
  // True while a cold-load deep link (e.g. /<public_hash>#claim-<uuid>) is
  // resolving: list fetch then record + digest fetch. Drives a centred
  // "Opening record..." indicator so the user sees progress instead of a
  // blank list. Set true synchronously by checkUrlHash on boot when the
  // URL points at a specific record, cleared in selectIngest's finally.
  let openingRecord = $state(false);

  fetchCurrentUser().then((u) => {
    user = u;
    if (u) loadReviews();
  });

  let ingests = $state<IngestSummary[]>([]);
  let selectedIngest = $state<IngestDetail | null>(null);
  let selectedDigest = $state<DigestDocument | null>(null);
  let sourceFile = $state<File | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let searchQuery = $state("");
  let filterType = $state<string>("all");
  let filterReviewed = $state<"all" | "pending" | "reviewed">("all");
  // Click-to-filter on a creator or publisher value (empty = no filter).
  let filterCreator = $state<string>("");
  let filterPublisher = $state<string>("");
  // Show only records that are currently digestible (100% observed).
  let filterDigestible = $state(false);
  // Show only records whose acquisition origin is untraceable.
  let filterUntraceable = $state(false);
  let reviewedTimes = $state<Record<string, string>>({});
  let reviewedHashes = $derived(new Set(Object.keys(reviewedTimes)));
  // Records whose review was carried over from a re-ingest and not yet
  // re-verified - they must read as "verify", never "reviewed", even though a
  // stale review trailer exists for the (hash-stable) record.
  let needsVerifyHashes = $derived(
    new Set(
      ingests
        .filter(
          (i) =>
            carryoverState(i.review_carryover?.at, reviewedTimes[i.content_hash]) ===
            "needs_verify",
        )
        .map((i) => i.content_hash),
    ),
  );
  let sortBy = $state<
    | "date"
    | "title"
    | "type"
    | "publisher"
    | "creator"
    | "digestible"
    | "digested"
    | "copyright"
    | "demand"
  >("date");
  let sortAsc = $state(false);
  // Which date the date column shows (and what "Date" sort uses).
  // Lives in the toolbar above the list as a separate selector;
  // the table's Date column header stays a plain sort-direction toggle.
  let dateField = $state<"published" | "ingested" | "reviewed">("published");
  let dateMenuOpen = $state(false);

  const DATE_FIELD_LABELS: Record<typeof dateField, string> = {
    published: "Published",
    ingested: "Ingested",
    reviewed: "Reviewed",
  };

  async function loadReviews() {
    reviewedTimes = await fetchReviewedHashes();
  }

  function setReviewed(hash: string, reviewed: boolean) {
    const next = { ...reviewedTimes };
    if (reviewed) next[hash] = new Date().toISOString();
    else delete next[hash];
    reviewedTimes = next;
  }

  function dateValueFor(i: IngestSummary): string {
    if (dateField === "ingested") return i.date_ingested || "";
    if (dateField === "reviewed") return reviewedTimes[i.content_hash] || "";
    return i.date || "";
  }

  function pickDateField(f: typeof dateField) {
    dateField = f;
    dateMenuOpen = false;
  }

  function handleDocClickForDateMenu(e: MouseEvent) {
    if (!dateMenuOpen) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest("[data-date-menu]")) return;
    if (t?.closest('[data-date-menu-trigger="1"]')) return;
    dateMenuOpen = false;
  }

  $effect(() => {
    if (!dateMenuOpen) return;
    document.addEventListener("mousedown", handleDocClickForDateMenu);
    return () => document.removeEventListener("mousedown", handleDocClickForDateMenu);
  });

  let filteredIngests = $derived(
    ingests
      .filter((i) => {
        if (filterType !== "all" && i.source_type !== filterType) return false;
        if (filterCreator && !i.creators.includes(filterCreator)) return false;
        if (filterPublisher && i.publisher !== filterPublisher) return false;
        if (filterDigestible && !i.digestible) return false;
        if (filterUntraceable && provenanceOf(i).traceable) return false;
        // A carried-over record awaiting verification counts as pending, not
        // reviewed, even though a stale trailer marks its hash reviewed.
        const isReviewed =
          reviewedHashes.has(i.content_hash) && !needsVerifyHashes.has(i.content_hash);
        if (filterReviewed === "reviewed" && !isReviewed) return false;
        if (filterReviewed === "pending" && isReviewed) return false;
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          return (
            i.title.toLowerCase().includes(q) ||
            i.date.includes(q) ||
            i.publisher.toLowerCase().includes(q) ||
            i.creators.some((c) => c.toLowerCase().includes(q))
          );
        }
        return true;
      })
      .sort((a, b) => {
        let va: string;
        let vb: string;
        if (sortBy === "digestible") {
          // Numeric on observed coverage, so partially-covered records order
          // sensibly between fully digestible and untouched.
          const cmp =
            a.observed_coverage < b.observed_coverage
              ? -1
              : a.observed_coverage > b.observed_coverage
                ? 1
                : 0;
          return sortAsc ? cmp : -cmp;
        }
        if (sortBy === "digested") {
          const cmp = Number(a.digested) - Number(b.digested);
          return sortAsc ? cmp : -cmp;
        }
        if (sortBy === "demand") {
          // The scheduler's per-record priority (same signal as the Schedule
          // view's Review lane), so a reviewer can sort by what to review next.
          // Records the graph hasn't scored sort off a 0 baseline (last, desc).
          const m = scheduleQueue?.recordDemand ?? {};
          const cmp = (m[a.content_hash] ?? 0) - (m[b.content_hash] ?? 0);
          return sortAsc ? cmp : -cmp;
        }
        if (sortBy === "date") {
          const ad = dateValueFor(a);
          const bd = dateValueFor(b);
          // Empty values always last regardless of direction.
          if (!ad && !bd) return 0;
          if (!ad) return 1;
          if (!bd) return -1;
          va = ad;
          vb = bd;
        }
        else if (sortBy === "title") { va = a.title.toLowerCase(); vb = b.title.toLowerCase(); }
        else if (sortBy === "type") { va = a.source_type; vb = b.source_type; }
        else if (sortBy === "publisher") { va = a.publisher || "zzz"; vb = b.publisher || "zzz"; }
        else if (sortBy === "creator") {
          va = (a.creators[0] || "zzz").toLowerCase();
          vb = (b.creators[0] || "zzz").toLowerCase();
        }
        else { va = a.copyright_status; vb = b.copyright_status; }
        const cmp = va < vb ? -1 : va > vb ? 1 : 0;
        return sortAsc ? cmp : -cmp;
      }),
  );

  let sourceTypes = $derived(
    [...new Set(ingests.map((i) => i.source_type))].sort(),
  );

  // {content_hash -> title} so the Schedule view shows record titles instead of
  // the scheduler's hash/slug labels (un-ingested sources have no record here).
  let recordTitles = $derived(
    Object.fromEntries(ingests.map((i) => [i.content_hash, i.title])),
  );

  async function loadIngests() {
    try {
      ingests = await fetchIngests();
    } catch (e) {
      error = "Could not connect to the backend. Is the API server running?";
    } finally {
      loading = false;
    }
  }

  // Position of the currently-open record within the filtered+sorted list,
  // so the next/prev nav obeys what the user sees in the list view rather
  // than picking arbitrarily.
  let currentIndex = $derived(
    selectedIngest
      ? filteredIngests.findIndex(
          (i) => i.content_hash === selectedIngest!.content_hash,
        )
      : -1,
  );
  let hasNext = $derived(
    currentIndex >= 0 && currentIndex < filteredIngests.length - 1,
  );
  let hasPrev = $derived(currentIndex > 0);

  function goNext() {
    if (!hasNext) return;
    const next = filteredIngests[currentIndex + 1];
    if (next) selectIngest(next.content_hash);
  }

  function goPrev() {
    if (!hasPrev) return;
    const prev = filteredIngests[currentIndex - 1];
    if (prev) selectIngest(prev.content_hash);
  }

  async function selectIngest(hash: string, file: File | null = null) {
    try {
      const [ingest, digest] = await Promise.all([
        fetchIngest(hash),
        fetchDigest(hash).catch(() => null),
      ]);
      selectedIngest = ingest;
      selectedDigest = digest;
      sourceFile = file;
      error = null;
      // Put the public hash in the URL so password managers can associate
      // with it. Preserve any existing fragment (e.g. #claim-<uuid> from a
      // deep-link arrival) so IngestViewer's hash-watcher can still see it.
      const publicHash = selectedIngest.public_hash;
      const fragment = window.location.hash || "";
      history.pushState(null, "", `/${publicHash}${fragment}`);
    } catch (e) {
      error = `Failed to load ingest: ${hash}`;
    } finally {
      openingRecord = false;
    }
  }

  function handleMatch(hash: string, file: File) {
    selectIngest(hash, file);
  }

  function handleNoMatch(hash: string, file: File) {
    error = `No ingest found for ${file.name} (hash: ${hash.slice(0, 12)}...)`;
  }

  function goBack() {
    selectedIngest = null;
    selectedDigest = null;
    sourceFile = null;
    error = null;
    appMode = "records";
    history.pushState(null, "", "/");
  }

  // On load: check URL for a public hash and try to open the matching ingest
  function showRecords() {
    appMode = "records";
    if (!selectedIngest) history.pushState(null, "", "/");
  }

  function showGraph() {
    graphNodeId = undefined; // nav click opens the list, not a specific node
    appMode = "graph";
    history.pushState(null, "", "/graph");
  }

  function showSchedule() {
    appMode = "schedule";
    loadSchedule();
    history.pushState(null, "", "/schedule");
  }

  async function checkUrlHash() {
    const path = window.location.pathname.slice(1);
    if (path === "curate-mock") {
      appMode = "curate-mock";
      return; // self-contained mock; no data load needed
    }
    if (path.startsWith("graph/")) {
      const id = path.slice("graph/".length);
      if (id) {
        graphNodeId = id;
        appMode = "graph";
        loadIngests();
        return;
      }
    }
    if (path === "graph" || path === "schedule") {
      appMode = path;
      if (path === "schedule") loadSchedule();
      loadIngests();
      return;
    }
    if (path && /^[a-f0-9]{56}$/.test(path)) {
      openingRecord = true;
      await loadIngests();
      const match = ingests.find((i) => i.public_hash === path);
      if (match) {
        selectIngest(match.content_hash);
        return;
      }
      // Valid-looking hash but no matching record (e.g. a deep link to a record
      // still parked in store/v1/ awaiting re-ingestion). The list is already
      // loaded; surface a notice instead of silently dropping the reviewer on
      // it with no explanation for why their link didn't open.
      openingRecord = false;
      error =
        "That record isn't available for review yet - it may be pending re-ingestion. Showing all records.";
      return;
    }
    loadIngests();
  }

  // What the cold-load loading indicator says. If the URL has a #claim-
  // fragment we tell the user we're going somewhere specific, otherwise
  // a generic message.
  let openingLabel = $derived.by(() => {
    if (typeof window === "undefined") return "Opening record...";
    return /^#claim-/i.test(window.location.hash)
      ? "Opening claim..."
      : "Opening record...";
  });

  checkUrlHash();
</script>

<div class="h-screen flex flex-col">
  <header class="bg-teal-950/95 backdrop-blur-sm px-6 py-2 font-ui flex items-center gap-3 flex-none">
    <a
      href="/"
      onclick={(e) => { e.preventDefault(); goBack(); }}
      class="flex items-center gap-3 {selectedIngest ? 'cursor-pointer hover:opacity-80' : ''} transition-opacity"
      title={selectedIngest ? 'Back to ingest list' : ''}
    >
      <img src="/logo-darkmode.svg" alt="Anomalica" class="h-4" />
      <span class="text-bone/60 text-sm leading-none mt-auto">Workbench</span>
    </a>
    <nav class="flex items-center gap-1 ml-2">
      <button
        onclick={showRecords}
        class="text-sm font-ui px-2.5 py-1 rounded cursor-pointer transition-colors
          {appMode === 'records' ? 'bg-bone/15 text-bone' : 'text-bone/50 hover:text-bone/80 hover:bg-bone/10'}"
      >Records</button>
      <button
        onclick={showGraph}
        class="text-sm font-ui px-2.5 py-1 rounded cursor-pointer transition-colors
          {appMode === 'graph' ? 'bg-bone/15 text-bone' : 'text-bone/50 hover:text-bone/80 hover:bg-bone/10'}"
        title="Review the assimilator's merged knowledge graph"
      >Graph</button>
      <button
        onclick={showSchedule}
        class="text-sm font-ui px-2.5 py-1 rounded cursor-pointer transition-colors
          {appMode === 'schedule' ? 'bg-bone/15 text-bone' : 'text-bone/50 hover:text-bone/80 hover:bg-bone/10'}"
        title="The prioritised work queue - what runs next"
      >Schedule</button>
    </nav>
    <div class="flex-1"></div>
    <button
      onclick={() => themeState.toggle()}
      class="p-1.5 rounded text-bone/60 hover:text-bone hover:bg-bone/10 transition-colors"
      title={themeState.isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label="Toggle dark mode"
    >
      {#if themeState.isDark}
        <!-- sun -->
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="4" />
          <path stroke-linecap="round" d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      {:else}
        <!-- moon -->
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      {/if}
    </button>
    {#if user}
      <div class="flex items-center gap-2">
        {#if user.avatar_url}
          <img src={user.avatar_url} alt="" class="w-5 h-5 rounded-full" />
        {/if}
        <span class="text-bone/80 text-sm">{user.name}</span>
        <a href="/api/auth/logout" class="text-bone/40 text-xs hover:text-bone/60 transition-colors">Log out</a>
      </div>
    {:else}
      <a href="/api/auth/login" class="text-bone/60 text-sm hover:text-bone transition-colors">Log in</a>
    {/if}
  </header>

  <main class="flex-1 flex flex-col min-h-0">
    {#if appMode === "curate-mock"}
      <CurateMock />
    {:else if appMode === "schedule"}
      <ScheduleView queue={scheduleQueue} {recordTitles} {ingestTitles} />
    {:else if appMode === "graph"}
      <GraphView initialNodeId={graphNodeId} />
    {:else if openingRecord && !selectedIngest}
      <!-- Cold-load deep-link: list + record + digest are fetching. Show a
           centred indicator so the user knows the click registered. Hidden
           the moment selectedIngest is set; IngestViewer then takes over
           and runs its own claim-scroll/flash. -->
      <div class="flex-1 flex flex-col items-center justify-center gap-3 text-on-surface-muted">
        <svg class="w-6 h-6 animate-spin text-primary" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
        </svg>
        <p class="text-sm font-ui">{openingLabel}</p>
      </div>
    {:else if selectedIngest}
      <IngestViewer
        ingest={selectedIngest}
        digest={selectedDigest}
        {sourceFile}
        {user}
        reviewed={reviewedHashes.has(selectedIngest.content_hash) &&
          !needsVerifyHashes.has(selectedIngest.content_hash)}
        needsVerify={needsVerifyHashes.has(selectedIngest.content_hash)}
        {hasNext}
        {hasPrev}
        onnext={goNext}
        onprev={goPrev}
        onreviewedchange={(hash, reviewed) => setReviewed(hash, reviewed)}
        onback={goBack}
      />
    {:else}
      <div class="flex-1 flex flex-col min-h-0">
        <!-- Search and filter bar -->
        <div class="px-6 py-3 border-b border-border bg-surface-alt flex items-center gap-3 flex-none">
          <input
            type="search"
            placeholder="Search ingests..."
            bind:value={searchQuery}
            class="flex-1 max-w-md text-sm bg-surface border border-border rounded px-3 py-1.5
              text-on-surface outline-none focus:border-primary placeholder:text-on-surface-muted/50"
          />
          <div class="flex items-center gap-1">
            <button
              onclick={() => { filterType = "all"; }}
              class="text-xs font-ui px-2 py-1 rounded cursor-pointer transition-colors
                {filterType === 'all' ? 'bg-primary text-on-primary' : 'text-on-surface-secondary hover:bg-surface'}"
            >All</button>
            {#each sourceTypes as type}
              <button
                onclick={() => { filterType = type; }}
                class="text-xs font-ui px-2 py-1 rounded cursor-pointer transition-colors
                  {filterType === type ? 'bg-primary text-on-primary' : 'text-on-surface-secondary hover:bg-surface'}"
              >{type.charAt(0).toUpperCase() + type.slice(1)}</button>
            {/each}
          </div>
          {#if user}
            <div class="flex items-center gap-1 border-l border-border pl-3">
              {#each [["all", "All"], ["pending", "Pending"], ["reviewed", "Reviewed"]] as [id, label]}
                <button
                  onclick={() => { filterReviewed = id as typeof filterReviewed; }}
                  class="text-xs font-ui px-2 py-1 rounded cursor-pointer transition-colors
                    {filterReviewed === id ? 'bg-primary text-on-primary' : 'text-on-surface-secondary hover:bg-surface'}"
                >{label}</button>
              {/each}
            </div>
          {/if}

          <div class="flex items-center gap-1 border-l border-border pl-3">
            <button
              onclick={() => { filterDigestible = !filterDigestible; }}
              class="text-xs font-ui px-2 py-1 rounded cursor-pointer transition-colors
                {filterDigestible ? 'bg-success/20 text-success' : 'text-on-surface-secondary hover:bg-surface'}"
              title="Show only records that are digestible (100% observed)"
            >Digestible</button>
            <button
              onclick={() => { filterUntraceable = !filterUntraceable; }}
              class="text-xs font-ui px-2 py-1 rounded cursor-pointer transition-colors
                {filterUntraceable ? 'bg-warning/20 text-warning' : 'text-on-surface-secondary hover:bg-surface'}"
              title="Show only records with no recoverable source/origin"
            >Untraceable</button>
          </div>

          <div class="flex items-center gap-1 border-l border-border pl-3">
            <button
              onclick={() => { sortBy = "demand"; sortAsc = false; loadSchedule(); }}
              class="text-xs font-ui px-2 py-1 rounded cursor-pointer transition-colors
                {sortBy === 'demand' ? 'bg-primary text-on-primary' : 'text-on-surface-secondary hover:bg-surface'}"
              title="Sort by review demand - the scheduler's per-record priority (what to review next). Records not yet in the graph rank last."
            >Sort by demand</button>
          </div>

          <!-- Date-field selector: what value the Date column shows
               and what "Date" sort uses. Lives in the toolbar so the
               column header itself stays a plain sort-direction toggle. -->
          <div class="flex items-center gap-2 border-l border-border pl-3 relative">
            <span class="text-xs font-ui text-on-surface-muted">Date:</span>
            <button
              data-date-menu-trigger="1"
              onclick={() => { dateMenuOpen = !dateMenuOpen; }}
              class="text-xs font-ui px-2 py-1 rounded cursor-pointer transition-colors
                flex items-center gap-1 bg-surface text-on-surface-secondary
                hover:bg-surface/60 border border-border"
              title="Change which date the Date column shows"
            >
              {DATE_FIELD_LABELS[dateField]}
              <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {#if dateMenuOpen}
              <div
                data-date-menu
                class="absolute top-full left-0 mt-1 min-w-32 z-30 bg-surface border border-border rounded shadow-lg py-1"
              >
                {#each (["published", "ingested", "reviewed"] as Array<typeof dateField>) as f}
                  <button
                    onclick={() => pickDateField(f)}
                    class="w-full text-left text-xs font-ui px-3 py-1.5 hover:bg-surface-alt cursor-pointer
                      {dateField === f ? 'text-primary font-medium' : 'text-on-surface'}"
                  >
                    {DATE_FIELD_LABELS[f]}
                  </button>
                {/each}
              </div>
            {/if}
          </div>

          {#if filterCreator}
            <button
              onclick={() => { filterCreator = ""; }}
              class="text-xs font-ui px-2 py-1 rounded cursor-pointer bg-primary/10 text-primary hover:bg-primary/20 flex items-center gap-1"
              title="Clear creator filter"
            >
              {filterCreator}
              <span aria-hidden="true">&#x2715;</span>
            </button>
          {/if}
          {#if filterPublisher}
            <button
              onclick={() => { filterPublisher = ""; }}
              class="text-xs font-ui px-2 py-1 rounded cursor-pointer bg-primary/10 text-primary hover:bg-primary/20 flex items-center gap-1"
              title="Clear publisher filter"
            >
              {filterPublisher}
              <span aria-hidden="true">&#x2715;</span>
            </button>
          {/if}

          <span class="text-xs text-on-surface-muted">
            {filteredIngests.length}{filteredIngests.length !== ingests.length ? ` of ${ingests.length}` : ''} records
          </span>
        </div>

        <!-- Ingest list -->
        <div class="flex-1 overflow-auto">
          {#if error}
            <div class="mx-6 my-4 bg-error-container text-on-error-container px-4 py-3 rounded-lg text-sm leading-relaxed">
              {error}
            </div>
          {/if}

          {#if loading}
            <p class="text-on-surface-muted text-sm p-6">Loading ingests...</p>
          {:else if filteredIngests.length > 0}
            <IngestList
              ingests={filteredIngests}
              {sortBy}
              {sortAsc}
              {reviewedHashes}
              {needsVerifyHashes}
              {reviewedTimes}
              {dateField}
              onsort={(field) => {
                if (sortBy === field) { sortAsc = !sortAsc; }
                else { sortBy = field as typeof sortBy; sortAsc = field === "title" || field === "creator"; }
              }}
              onselect={(hash) => selectIngest(hash)}
              onfiltercreator={(c) => { filterCreator = filterCreator === c ? "" : c; }}
              onfilterpublisher={(p) => { filterPublisher = filterPublisher === p ? "" : p; }}
            />
          {:else if searchQuery || filterType !== "all" || filterCreator || filterPublisher || filterDigestible || filterUntraceable}
            <p class="text-on-surface-muted text-sm p-6">No ingests match your search.</p>
          {:else}
            <p class="text-on-surface-muted text-sm p-6">No ingests found.</p>
          {/if}
        </div>
      </div>
    {/if}
  </main>
</div>
