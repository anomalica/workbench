<script lang="ts">
  import { setArticleDirectives } from "$lib/api";

  // Presentation directives for one assembled article: short instructions that
  // shape how the assembler renders it (style, grammar, disambiguation,
  // formatting, naming) across every language. PRESENTATION-ONLY - a directive
  // can never add, drop, or change a fact; facts flow through the graph/claims.
  // Read-only for logged-out viewers; editable when a reviewer is logged in.
  let {
    section,
    slug,
    directives = [],
    canEdit = false,
  }: {
    section: string;
    slug: string;
    directives?: string[];
    canEdit?: boolean;
  } = $props();

  // Editable working copy of the directives; synced from the server on each save.
  // svelte-ignore state_referenced_locally
  let items = $state<string[]>([...directives]);
  let open = $state(false);
  let draft = $state("");
  let saving = $state(false);
  let error = $state<string | null>(null);

  async function commit(next: string[]) {
    saving = true;
    error = null;
    const prev = items;
    items = next; // optimistic
    try {
      items = await setArticleDirectives(section, slug, next);
    } catch (e) {
      items = prev; // rollback on failure
      error =
        e instanceof Error && e.message.includes("401")
          ? "Session expired - log in again to edit directives."
          : "Couldn't save - try again.";
    } finally {
      saving = false;
    }
  }

  function add() {
    const s = draft.trim();
    if (!s || saving) return;
    draft = "";
    commit([...items, s]);
  }

  function remove(i: number) {
    if (saving) return;
    commit(items.filter((_, j) => j !== i));
  }
</script>

<div class="font-ui text-xs mt-2">
  <button
    onclick={() => (open = !open)}
    class="flex items-center gap-1 text-on-surface-secondary hover:text-on-surface
      cursor-pointer transition-colors"
    aria-expanded={open}
  >
    <span class="transition-transform {open ? 'rotate-90' : ''}">&rsaquo;</span>
    Presentation directives{items.length ? ` (${items.length})` : ""}
  </button>

  {#if open}
    <div class="mt-1.5 pl-3 border-l border-border space-y-2">
      <p class="text-on-surface-muted leading-snug">
        Presentation only - style, grammar, disambiguation, naming. Applies to every
        language. A directive never changes facts.
      </p>

      {#if items.length}
        <ul class="space-y-1">
          {#each items as d, i (d)}
            <li class="flex items-start gap-2">
              <span class="text-primary/70 leading-snug">&bull;</span>
              <span class="text-on-surface-secondary leading-snug flex-1">{d}</span>
              {#if canEdit}
                <button
                  onclick={() => remove(i)}
                  disabled={saving}
                  class="text-on-surface-muted hover:text-error flex-none cursor-pointer
                    transition-colors disabled:opacity-40"
                  title="Remove this directive"
                  aria-label="Remove directive">&times;</button>
              {/if}
            </li>
          {/each}
        </ul>
      {:else}
        <p class="text-on-surface-muted">None yet.</p>
      {/if}

      {#if canEdit}
        <div class="flex items-center gap-2 pt-0.5">
          <input
            bind:value={draft}
            onkeydown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder="e.g. Use the full name Luis Elizondo"
            disabled={saving}
            class="flex-1 min-w-0 bg-surface border border-border rounded px-2 py-1
              text-on-surface placeholder:text-on-surface-muted focus:outline-none
              focus:border-primary disabled:opacity-50"
          />
          <button
            onclick={add}
            disabled={saving || !draft.trim()}
            class="flex-none px-2.5 py-1 rounded bg-primary/10 text-primary
              hover:bg-primary/20 cursor-pointer transition-colors
              disabled:opacity-40 disabled:cursor-default">Add</button>
        </div>
      {/if}

      {#if error}<p class="text-error">{error}</p>{/if}
    </div>
  {/if}
</div>
