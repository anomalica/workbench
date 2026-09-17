<script lang="ts">
  let {
    count,
    scopes = [],
    state = null,
    onopen,
  }: {
    count: number;
    scopes?: ("frontmatter" | "body")[];
    state?: import("$lib/api").HousekeepingState | null;
    onopen: () => void;
  } = $props();

  const scopeLabel = $derived(
    scopes.length === 2 ? "metadata and body" : scopes[0] === "body" ? "body" : "metadata",
  );
  const blocked = $derived(state !== "ready" && state !== "excluded-review-state");
</script>

{#if blocked}
  <aside
    class="flex flex-none flex-col gap-2 border-b border-warning/40 bg-warning-container px-4 py-2.5
      text-sm text-on-warning-container sm:flex-row sm:items-center"
    aria-label="Housekeeping blocks content review"
  >
    <p class="min-w-0 flex-1">
      {#if state === "needs-decisions" && count > 0}
        <strong>{count} housekeeping proposal{count === 1 ? "" : "s"}</strong>
        {count === 1 ? " is" : " are"} waiting in this record's {scopeLabel}.
      {:else if state === "pending-research"}
        <strong>Housekeeping research is still pending.</strong>
      {:else if state === "failed-research"}
        <strong>Housekeeping research failed.</strong> Retry it or record an authenticated waiver.
      {:else if state === "pending-deterministic"}
        <strong>Deterministic housekeeping checks are still pending.</strong>
      {:else if state === "failed-deterministic"}
        <strong>Deterministic housekeeping checks failed.</strong> They must be retried successfully.
      {:else if state === "due"}
        <strong>A current housekeeping pass is required.</strong>
      {:else}
        <strong>Housekeeping state is unavailable.</strong>
      {/if}
      Content review editing and submission are blocked until the record is ready.
    </p>
    <button
      type="button"
      onclick={onopen}
      class="w-fit flex-none font-ui font-semibold underline underline-offset-2 hover:no-underline"
    >
      Review in Housekeeping
    </button>
  </aside>
{/if}
