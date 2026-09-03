<script lang="ts">
  import type { GraphNodeDetail, GraphClaim } from "$lib/api";
  import RenameEditor from "./RenameEditor.svelte";

  let {
    node,
    loading = false,
    canRename = false,
    onchanged = () => {},
  }: {
    node: GraphNodeDetail | null;
    loading?: boolean;
    canRename?: boolean;
    /** A rename or merge landed: the parent refreshes and, for a merge,
     *  recentres on the node that survived. */
    onchanged?: (message: string, survivorId?: string) => void;
  } = $props();

  let renaming = $state(false);

  function changed(message: string, survivorId?: string) {
    renaming = false;
    onchanged(message, survivorId);
  }

  // Group the node's claims by source record - the reviewer reads merges in the
  // context of which sources assert what about this entity.
  let groups = $derived.by(() => {
    const m = new Map<string, GraphClaim[]>();
    for (const c of node?.claims ?? []) {
      const key = c.record_title;
      if (!m.has(key)) m.set(key, []);
      m.get(key)!.push(c);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });
</script>

{#if loading}
  <div class="flex-1 flex items-center justify-center text-on-surface-muted text-sm font-ui">
    Loading entity...
  </div>
{:else if !node}
  <div class="flex-1 flex items-center justify-center text-on-surface-muted text-sm font-ui px-6 text-center">
    Select an entity to see what was merged into it.
  </div>
{:else}
  <div class="flex-1 overflow-auto px-6 py-5">
    <!-- Identity -->
    <div class="flex items-baseline gap-3 flex-wrap">
      <h2 class="text-xl text-on-surface font-medium">{node.name}</h2>
      <span class="text-[10px] font-ui font-medium text-primary uppercase tracking-wide px-1.5 py-0.5 rounded bg-primary/10">
        {node.node_type}
      </span>
      {#if canRename}
        <!-- Here as well as on the topics list, because the topics list only
             holds what has been proposed for a page - the duplicates worth
             joining are usually not on it. -->
        <button
          onclick={() => (renaming = !renaming)}
          title="Rename - the name is the page title and its address"
          aria-label="Rename"
          class="rounded p-1 {renaming ? 'bg-primary-container text-on-surface' : 'text-on-surface-muted hover:bg-surface-alt hover:text-primary'}"
        >
          <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24" aria-hidden="true">
            <path stroke-linecap="round" stroke-linejoin="round" d="M16.5 4.5l3 3L8 19H5v-3L16.5 4.5z" />
          </svg>
        </button>
      {/if}
    </div>

    {#if renaming}
      <div class="mt-3 rounded-lg border border-border bg-surface-alt px-4 py-3">
        <RenameEditor
          node={{ id: node.id, name: node.name, node_type: node.node_type, claims: node.claim_count }}
          onchanged={changed}
          oncancel={() => (renaming = false)}
        />
      </div>
    {/if}

    <!-- Merge decisions: the whole point of the view. Prominent. -->
    <div class="mt-4 rounded-lg border border-border bg-surface-alt px-4 py-3">
      {#if node.aliases.length > 0}
        <div class="text-xs font-ui font-medium text-on-surface-secondary uppercase tracking-wide mb-2">
          Assembled from {node.aliases.length} surface
          {node.aliases.length === 1 ? "form" : "forms"} merged into this entity
        </div>
        <div class="flex flex-wrap gap-1.5">
          {#each node.aliases as alias}
            <span class="text-sm font-ui px-2 py-1 rounded border border-primary/30 bg-primary/5 text-on-surface">
              {alias}
            </span>
          {/each}
        </div>
        <p class="mt-2 text-xs text-on-surface-muted">
          If any of these are not the same entity, that's a bad merge.
        </p>
      {:else}
        <div class="text-xs font-ui text-on-surface-muted">
          No merges - a single surface form, nothing was folded into this entity.
        </div>
      {/if}
    </div>

    <!-- Claims grouped by source -->
    <div class="mt-5">
      <div class="text-xs font-ui font-medium text-on-surface-secondary uppercase tracking-wide mb-3">
        {node.claim_count} {node.claim_count === 1 ? "claim references" : "claims reference"} this entity
        {#if node.claims_truncated}
          <span class="text-on-surface-muted normal-case font-normal">
            (showing first {node.claims.length})
          </span>
        {/if}
      </div>

      {#each groups as [record, claims]}
        <div class="mb-5">
          <div class="text-sm font-medium text-on-surface mb-2 flex items-baseline gap-2 flex-wrap">
            {#if claims[0]?.record_public_hash}
              <a href={`/${claims[0].record_public_hash}`} class="truncate text-primary hover:underline" title="Open the source record in the Records tab">{record}</a>
            {:else}
              <span class="truncate">{record}</span>
            {/if}
            {#if claims[0]?.record_producer}
              <span class="text-xs font-ui font-normal text-on-surface-muted">by
                <a href={`/graph/${claims[0].record_producer.id}`} class="text-primary hover:underline">{claims[0].record_producer.name}</a>
              </span>
            {/if}
            <span class="text-xs text-on-surface-muted font-ui flex-none ml-auto">{claims.length}</span>
          </div>
          <div class="space-y-2.5">
            {#each claims as claim}
              {@const corefs = (claim.corefs ?? []).filter((c) => c.id !== claim.speaker?.id)}
              <div class="rounded-md border border-border/70 bg-surface-alt/40 px-3 py-2.5 text-sm leading-relaxed">
                <div class="flex gap-x-2 gap-y-1 flex-wrap items-center text-[11px] font-ui text-on-surface-muted mb-1.5">
                  <span class="px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium uppercase tracking-wide text-[10px]">
                    {claim.claim_type}
                  </span>
                  {#if claim.attestation}
                    <span class="opacity-80">{claim.attestation.replace("_", "-")}</span>
                  {/if}
                  {#if claim.location}
                    <span class="opacity-50">·</span>
                    <span>{claim.location}</span>
                  {/if}
                </div>
                <p class="text-on-surface">{claim.content}</p>
                {#if claim.excerpt}
                  <p class="mt-1.5 pl-3 border-l-2 border-border/70 text-xs italic text-on-surface-secondary">
                    {claim.excerpt}
                  </p>
                {/if}
                {#if claim.speaker}
                  <div class="mt-1.5 text-[11px] font-ui text-on-surface-muted">
                    said by <a href={`/graph/${claim.speaker.id}`} class="text-primary hover:underline">{claim.speaker.name}</a>
                  </div>
                {/if}
                {#if corefs.length > 0}
                  <div class="mt-1 text-[11px] font-ui text-on-surface-muted flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                    <span>also references</span>
                    {#each corefs as ref}
                      <a href={`/graph/${ref.id}`} class="text-primary hover:underline" title={ref.node_type}>{ref.name}</a>
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  </div>
{/if}
