<script lang="ts">
  // What this record is ABOUT, asserted by a person.
  //
  // The pipeline links two records only through a named entity they share. Two
  // records about the same UNNAMED thing - one operation under two agency-style
  // names, one encounter told twice with no shared wording - stay apart, and
  // measurement says they will: claim similarity finds nothing without shared
  // wording, and name matching cannot separate a true pair from house-style
  // noise. That residue is a link a person has to assert, and this is where.
  //
  // A tag is RECORD-level. It attaches no claim to the subject, so it feeds
  // nothing that counts claims - not the page gate, not scoring, not the brief.
  // It says "this record is about that", nothing more.
  import { addRecordTag, fetchRecordTags, removeRecordTag, type RecordTag } from "$lib/api";
  import { subjectSuggest } from "$lib/subject-suggest.svelte";

  let { hash, canTag = false }: { hash: string; canTag?: boolean } = $props();

  let tags = $state<RecordTag[]>([]);
  let draft = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);
  const suggest = subjectSuggest({});

  /** The live subject whose name is typed exactly. Tagging that means tagging
   *  THAT subject; anything else makes a new topic, which is why the button
   *  says which of the two it is about to do. */
  const matched = $derived(suggest.items.length ? suggest.exact(draft) : null);

  async function load() {
    try {
      tags = await fetchRecordTags(hash);
    } catch (e) {
      error = String(e);
    }
  }

  $effect(() => {
    hash;
    load();
  });

  async function add() {
    const name = draft.trim();
    if (!name) return;
    busy = true;
    error = null;
    try {
      const out = await addRecordTag(hash, name, matched?.node_type ?? "topic");
      if (!out.ok) error = out.reason || `The tag could not be applied (${out.status}).`;
      draft = "";
      suggest.clear();
      await load();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  async function drop(tag: RecordTag) {
    busy = true;
    try {
      await removeRecordTag(hash, tag.tag_id);
      await load();
    } catch (e) {
      error = String(e);
    } finally {
      busy = false;
    }
  }

  function onkey(e: KeyboardEvent) {
    if (suggest.key(e, (s) => ((draft = s.name), suggest.clear()))) return;
    if (e.key === "Enter") add();
  }
</script>

<div class="flex flex-col gap-1.5 text-xs font-ui">
  <div class="flex items-baseline gap-2">
    <span class="w-32 flex-none text-on-surface-muted">About</span>
    <div class="flex flex-1 flex-wrap items-center gap-1.5">
      {#each tags as t (t.tag_id)}
        <span
          class="flex items-center gap-1 rounded-full border px-2 py-0.5
            {t.status === 'applied'
            ? 'border-border bg-surface text-on-surface'
            : t.status === 'pending'
              ? 'border-warning/40 bg-warning-container/30 text-on-surface'
              : 'border-error/40 bg-error/5 text-error'}"
          title={t.status === "applied"
            ? `Tagged by ${t.by ?? "somebody"}`
            : (t.reason ?? t.status)}
        >
          <!-- The name it RESOLVED to when that differs from the name typed:
               the subject was renamed or merged since, and the alias carried
               the tag across. Showing the old name would be a lie. -->
          {t.resolved_name ?? t.name}
          {#if t.status !== "applied"}
            <span class="text-[0.65rem] uppercase tracking-wide">{t.status}</span>
          {/if}
          {#if canTag}
            <button
              onclick={() => drop(t)}
              disabled={busy}
              aria-label="Remove tag"
              title="Withdraw this - the record keeps that it was asserted"
              class="text-on-surface-muted hover:text-error">×</button
            >
          {/if}
        </span>
      {/each}
      {#if !tags.length}
        <span class="text-on-surface-muted">Nothing asserted yet.</span>
      {/if}
    </div>
  </div>

  {#if canTag}
    <div class="flex items-baseline gap-2">
      <span class="w-32 flex-none"></span>
      <div class="flex-1">
        <div class="flex flex-wrap items-center gap-2">
          <input
            bind:value={draft}
            oninput={() => suggest.search(draft)}
            onkeydown={onkey}
            autocomplete="off"
            disabled={busy}
            placeholder="What is this record about?"
            class="min-w-56 flex-1 rounded border border-border bg-surface px-2 py-1 text-on-surface"
          />
          <button
            onclick={add}
            disabled={busy || !draft.trim()}
            class="rounded bg-primary px-2 py-1 text-on-primary disabled:opacity-50"
          >{matched ? "Tag it" : "Tag as a new topic"}</button>
        </div>

        {#if suggest.items.length}
          <!-- Offered before a new one is made: the subject being reached for
               usually exists already, spelled a little differently, and a second
               node for it is the thing this is meant to prevent. -->
          <ul class="mt-1.5 flex flex-col overflow-hidden rounded border border-border">
            {#each suggest.items as s, i (s.id)}
              <li>
                <button
                  onclick={() => ((draft = s.name), suggest.clear())}
                  onmouseenter={() => (suggest.highlighted = i)}
                  class="flex w-full flex-wrap items-baseline gap-x-2 px-2 py-1.5 text-left
                    {i === suggest.highlighted ? 'bg-primary-container' : 'bg-surface-alt'}"
                >
                  <span class="text-on-surface">{s.name}</span>
                  <span class="text-[0.65rem] uppercase text-on-surface-muted">{s.node_type}</span>
                  <span class="tabular-nums text-on-surface-secondary">{s.claims} claims</span>
                  {#if s.via}<span class="text-on-surface-muted">also “{s.via}”</span>{/if}
                </button>
              </li>
            {/each}
          </ul>
        {/if}

        {#if !matched && draft.trim()}
          <p class="mt-1.5 text-on-surface-muted">
            No subject of that name yet, so this makes one - a topic. Pick from the
            list instead if it is one of those.
          </p>
        {/if}
        {#if error}
          <p class="mt-1.5 text-error">{error}</p>
        {/if}
      </div>
    </div>
  {/if}
</div>
