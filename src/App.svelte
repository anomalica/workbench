<script lang="ts">
  import { fetchIngests, fetchIngest } from "$lib/api";
  import type { IngestSummary, IngestDetail } from "$lib/api";
  import FileDropZone from "$lib/components/FileDropZone.svelte";
  import IngestList from "$lib/components/IngestList.svelte";
  import IngestViewer from "$lib/components/IngestViewer.svelte";

  let ingests = $state<IngestSummary[]>([]);
  let selectedIngest = $state<IngestDetail | null>(null);
  let sourceFile = $state<File | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);

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
  }

  loadIngests();
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
  </header>

  <main class="flex-1 flex flex-col min-h-0">
    {#if selectedIngest}
      <IngestViewer ingest={selectedIngest} {sourceFile} onback={goBack} />
    {:else}
      <div class="flex-1 overflow-auto">
        <div class="max-w-3xl mx-auto w-full p-8 flex flex-col gap-6">
          <div>
            <h1 class="text-2xl font-semibold mb-2">Review Workbench</h1>
            <p class="text-on-surface-secondary text-sm">
              Drop a source file to match it against an ingest, or browse available ingests below.
            </p>
          </div>

          <FileDropZone onmatch={handleMatch} onnomatch={handleNoMatch} />

          {#if error}
            <div class="bg-error-container text-on-error-container px-4 py-3 rounded text-sm">
              {error}
            </div>
          {/if}

          {#if loading}
            <p class="text-on-surface-muted text-sm">Loading ingests...</p>
          {:else if ingests.length > 0}
            <div>
              <h2 class="font-ui font-medium text-on-surface-secondary text-sm uppercase tracking-wide mb-3">
                Available ingests ({ingests.length})
              </h2>
              <IngestList {ingests} onselect={(hash) => selectIngest(hash)} />
            </div>
          {:else if !error}
            <p class="text-on-surface-muted text-sm">No ingests found.</p>
          {/if}
        </div>
      </div>
    {/if}
  </main>
</div>
