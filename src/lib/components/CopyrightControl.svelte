<script lang="ts">
  /**
   * Who is allowed to see this record.
   *
   * `copyright.status` is not a label - it is the gate. It decides whether the
   * body is served to anyone who asks, whether the original file is downloadable,
   * and whether the audio's waveform is public. Anomalica is not a redistribution
   * channel, and a record moved from `restricted` to a public status goes into
   * the next public snapshot with its body intact.
   *
   * That IS reversible on our side: the snapshot blanks a gated record's body
   * at build time, so narrowing the status drops it at the next build and the
   * CDN is purged. What is not reversible is a copy someone already took, or a
   * crawler's index - which is why widening asks first and narrowing does not.
   */
  import { isPubliclyViewable, type CopyrightStatus } from "$lib/api";

  interface Props {
    status: CopyrightStatus;
    canEdit?: boolean;
    onchange: (status: CopyrightStatus) => void;
  }

  let { status, canEdit = false, onchange }: Props = $props();

  const OPTIONS: { value: CopyrightStatus; label: string; note: string }[] = [
    {
      value: "public_domain",
      label: "Public domain",
      note: "No copyright subsists. Body and original served to anyone.",
    },
    {
      value: "open_licence",
      label: "Open licence",
      note: "Licensed for redistribution. Body and original served to anyone.",
    },
    {
      value: "publicly_accessible",
      label: "Publicly accessible",
      note: "Published openly by its source. Body served; we are not the only place it exists.",
    },
    {
      value: "licensed",
      label: "Licensed",
      note: "In copyright, we hold a copy. Body gated behind proof of possession.",
    },
    {
      value: "restricted",
      label: "Restricted",
      note: "In copyright, no redistribution right. Body gated behind proof of possession.",
    },
  ];

  let pending = $state<CopyrightStatus | null>(null);
  let open = $state(false);

  let current = $derived(OPTIONS.find((o) => o.value === status));

  function choose(next: CopyrightStatus) {
    open = false;
    if (next === status) return;
    // Widening is the irreversible half: once a public record syncs, it has
    // been published, whatever the record says afterwards.
    if (!isPubliclyViewable(status) && isPubliclyViewable(next)) {
      pending = next;
      return;
    }
    onchange(next);
  }
</script>

<div class="flex items-baseline gap-2 text-xs font-ui">
  <span class="text-on-surface-muted w-32 flex-none">Access</span>
  {#if canEdit}
    <div class="relative inline-block min-w-0">
      <button
        onclick={() => (open = !open)}
        class="text-left cursor-pointer rounded px-1 -mx-1 hover:bg-surface-alt transition-colors
          {isPubliclyViewable(status) ? 'text-on-surface' : 'text-warning'}"
        title={current?.note}
      >
        {current?.label ?? status}
        <span class="text-on-surface-muted/60">edit</span>
      </button>
      {#if open}
        <div
          role="menu"
          tabindex="-1"
          class="absolute top-full left-0 mt-1 z-40 bg-surface-raised border border-border
            rounded shadow-lg py-1 w-80"
        >
          {#each OPTIONS as option}
            <button
              onclick={() => choose(option.value)}
              class="block w-full text-left px-3 py-1.5 cursor-pointer hover:bg-primary-container/30
                {option.value === status ? 'bg-primary/10' : ''}"
            >
              <span
                class="text-sm {isPubliclyViewable(option.value)
                  ? 'text-on-surface'
                  : 'text-warning'}">{option.label}</span
              >
              <span class="block text-[11px] text-on-surface-muted leading-snug"
                >{option.note}</span
              >
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <span class={isPubliclyViewable(status) ? "text-on-surface" : "text-warning"}>
      {current?.label ?? status}
    </span>
  {/if}
</div>

{#if pending}
  <!-- Not a toast afterwards: the question has to be asked while it can still
       be answered no. -->
  <div
    class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
    onclick={(e) => { if (e.target === e.currentTarget) pending = null; }}
    role="presentation"
  >
    <div class="bg-surface-raised border border-border rounded-lg shadow-xl max-w-md w-full p-5">
      <h2 class="text-base font-ui font-medium text-on-surface">Publish this record?</h2>
      <p class="text-sm font-ui text-on-surface-secondary leading-relaxed mt-2">
        Moving it to <span class="text-on-surface">{OPTIONS.find((o) => o.value === pending)?.label}</span>
        serves its full text, and its original file, to anyone who asks - through the CDN, as
        soon as this syncs.
      </p>
      <p class="text-sm font-ui text-on-surface-secondary leading-relaxed mt-2">
        You can take it down again - the next snapshot build drops the body and the CDN is
        purged. What you cannot take back is a copy someone already downloaded, or a crawler
        already indexed. Only publish material that really carries no redistribution
        restriction.
      </p>
      <div class="flex justify-end gap-2 mt-4">
        <button
          onclick={() => (pending = null)}
          class="text-sm font-ui px-3 py-1.5 rounded cursor-pointer text-on-surface-secondary hover:bg-surface-alt"
          >Cancel</button
        >
        <button
          onclick={() => {
            const next = pending;
            pending = null;
            if (next) onchange(next);
          }}
          class="text-sm font-ui px-3 py-1.5 rounded cursor-pointer bg-warning text-on-surface"
          >Publish it</button
        >
      </div>
    </div>
  </div>
{/if}
