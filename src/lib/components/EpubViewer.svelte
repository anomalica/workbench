<script lang="ts">
  import { parseEpub, flattenEpubToHtml, type ParsedEpub } from "$lib/epub";

  let { file }: { file: File } = $props();

  let parsed = $state<ParsedEpub | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);

  $effect(() => {
    const f = file;
    if (!f) {
      parsed = null;
      return;
    }
    loading = true;
    error = null;
    parseEpub(f)
      .then((p) => {
        parsed = p;
        loading = false;
      })
      .catch((e) => {
        error = e instanceof Error ? e.message : String(e);
        loading = false;
      });
  });

  let flattenedHtml = $derived(parsed ? flattenEpubToHtml(parsed) : "");
</script>

<div class="flex-1 flex flex-col min-h-0 bg-surface">
  {#if loading}
    <div class="flex-1 flex items-center justify-center text-on-surface-muted">
      <div class="text-center">
        <svg class="w-6 h-6 mx-auto mb-2 animate-spin text-primary" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
        </svg>
        <p class="text-xs font-ui">Reading EPUB...</p>
      </div>
    </div>
  {:else if error}
    <div class="flex-1 flex items-center justify-center text-on-surface-muted p-8">
      <div class="text-center max-w-sm">
        <p class="text-sm text-error mb-2">Could not read this EPUB</p>
        <p class="text-xs">{error}</p>
      </div>
    </div>
  {:else if parsed}
    <iframe
      title="EPUB source"
      sandbox=""
      srcdoc={flattenedHtml}
      class="flex-1 w-full border-none bg-white"
    ></iframe>
  {/if}
</div>
