<script lang="ts">
  import { hashFile, ingestExists } from "$lib/api";

  let {
    onmatch,
    onhashing,
    onnomatch,
  }: {
    onmatch: (hash: string, file: File) => void;
    onhashing?: (hashing: boolean) => void;
    onnomatch?: (hash: string, file: File) => void;
  } = $props();

  let dragging = $state(false);
  let status = $state<"idle" | "hashing" | "checking">("idle");
  let fileName = $state("");

  async function handleFile(file: File) {
    fileName = file.name;
    status = "hashing";
    onhashing?.(true);

    const hash = await hashFile(file);

    status = "checking";
    const found = await ingestExists(hash);

    if (found) {
      onmatch(hash, file);
    } else {
      onnomatch?.(hash, file);
    }

    status = "idle";
    onhashing?.(false);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    const file = e.dataTransfer?.files[0];
    if (file) handleFile(file);
  }

  function onInput(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) handleFile(file);
  }
</script>

<div
  class="border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer
    {dragging ? 'border-primary bg-primary-container/30' : 'border-border hover:border-primary/50'}"
  role="button"
  tabindex="0"
  ondragover={(e) => { e.preventDefault(); dragging = true; }}
  ondragleave={() => { dragging = false; }}
  ondrop={onDrop}
  onclick={() => document.getElementById('file-input')?.click()}
  onkeydown={(e) => { if (e.key === 'Enter') document.getElementById('file-input')?.click(); }}
>
  <input id="file-input" type="file" class="hidden" onchange={onInput} />

  {#if status === "hashing"}
    <p class="text-on-surface-secondary">Hashing {fileName}...</p>
  {:else if status === "checking"}
    <p class="text-on-surface-secondary">Looking up ingest for {fileName}...</p>
  {:else}
    <p class="text-on-surface-secondary">
      Drop a source file here or click to browse
    </p>
    <p class="text-on-surface-muted text-sm mt-2">
      The file is hashed locally and matched against known ingests. It is never uploaded.
    </p>
  {/if}
</div>
