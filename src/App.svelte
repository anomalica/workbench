<script lang="ts">
  import {
    fetchIngests,
    fetchIngest,
    fetchCurrentUser,
    fetchReviewedHashes,
  } from "$lib/api";
  import type { IngestSummary, IngestDetail, User } from "$lib/api";
  import FileDropZone from "$lib/components/FileDropZone.svelte";
  import IngestList from "$lib/components/IngestList.svelte";
  import IngestViewer from "$lib/components/IngestViewer.svelte";

  let user = $state<User | null>(null);

  fetchCurrentUser().then((u) => {
    user = u;
    if (u) loadReviews();
  });

  let ingests = $state<IngestSummary[]>([]);
  let selectedIngest = $state<IngestDetail | null>(null);
  let sourceFile = $state<File | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let searchQuery = $state("");
  let filterType = $state<string>("all");
  let filterReviewed = $state<"all" | "pending" | "reviewed">("all");
  let reviewedHashes = $state<Set<string>>(new Set());
  let sortBy = $state<"date" | "title" | "type" | "publisher" | "author" | "copyright">("date");
  let sortAsc = $state(false);

  async function loadReviews() {
    const hashes = await fetchReviewedHashes();
    reviewedHashes = new Set(hashes);
  }

  function setReviewed(hash: string, reviewed: boolean) {
    const next = new Set(reviewedHashes);
    if (reviewed) next.add(hash);
    else next.delete(hash);
    reviewedHashes = next;
  }

  let filteredIngests = $derived(
    ingests
      .filter((i) => {
        if (filterType !== "all" && i.source_type !== filterType) return false;
        if (filterReviewed === "reviewed" && !reviewedHashes.has(i.content_hash)) return false;
        if (filterReviewed === "pending" && reviewedHashes.has(i.content_hash)) return false;
        if (searchQuery.trim()) {
          const q = searchQuery.toLowerCase();
          return (
            i.title.toLowerCase().includes(q) ||
            i.date.includes(q) ||
            i.publisher.toLowerCase().includes(q)
          );
        }
        return true;
      })
      .sort((a, b) => {
        let va: string;
        let vb: string;
        if (sortBy === "date") { va = a.date; vb = b.date; }
        else if (sortBy === "title") { va = a.title.toLowerCase(); vb = b.title.toLowerCase(); }
        else if (sortBy === "type") { va = a.source_type; vb = b.source_type; }
        else if (sortBy === "publisher") { va = a.publisher || "zzz"; vb = b.publisher || "zzz"; }
        else if (sortBy === "author") {
          va = (a.authors[0] || "zzz").toLowerCase();
          vb = (b.authors[0] || "zzz").toLowerCase();
        }
        else { va = a.copyright_status; vb = b.copyright_status; }
        const cmp = va < vb ? -1 : va > vb ? 1 : 0;
        return sortAsc ? cmp : -cmp;
      }),
  );

  let sourceTypes = $derived(
    [...new Set(ingests.map((i) => i.source_type))].sort(),
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

  async function selectIngest(hash: string, file: File | null = null) {
    try {
      selectedIngest = await fetchIngest(hash);
      sourceFile = file;
      error = null;
      // Put the public hash in the URL so password managers can associate with it
      const publicHash = selectedIngest.public_hash;
      history.pushState(null, "", `/${publicHash}`);
    } catch (e) {
      error = `Failed to load ingest: ${hash}`;
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
    sourceFile = null;
    error = null;
    history.pushState(null, "", "/");
  }

  // On load: check URL for a public hash and try to open the matching ingest
  async function checkUrlHash() {
    const path = window.location.pathname.slice(1);
    if (path && /^[a-f0-9]{56}$/.test(path)) {
      // Find the ingest whose public hash matches
      await loadIngests();
      const match = ingests.find((i) => i.public_hash === path);
      if (match) {
        selectIngest(match.content_hash);
        return;
      }
    }
    loadIngests();
  }

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
    <div class="flex-1"></div>
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
    {#if selectedIngest}
      <IngestViewer
        ingest={selectedIngest}
        {sourceFile}
        {user}
        reviewed={reviewedHashes.has(selectedIngest.content_hash)}
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
          <span class="text-xs text-on-surface-muted">
            {filteredIngests.length}{filteredIngests.length !== ingests.length ? ` of ${ingests.length}` : ''} records
          </span>
        </div>

        <!-- Ingest list -->
        <div class="flex-1 overflow-auto">
          {#if error}
            <div class="mx-6 mt-4 bg-error-container text-on-error-container px-4 py-3 rounded text-sm">
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
              onsort={(field) => {
                if (sortBy === field) { sortAsc = !sortAsc; }
                else { sortBy = field as typeof sortBy; sortAsc = field === "title" || field === "author"; }
              }}
              onselect={(hash) => selectIngest(hash)}
            />
          {:else if searchQuery || filterType !== "all"}
            <p class="text-on-surface-muted text-sm p-6">No ingests match your search.</p>
          {:else}
            <p class="text-on-surface-muted text-sm p-6">No ingests found.</p>
          {/if}
        </div>
      </div>
    {/if}
  </main>
</div>
