<script lang="ts">
  let {
    count,
    scopes = [],
    onopen,
  }: {
    count: number;
    scopes?: ("frontmatter" | "body")[];
    onopen: () => void;
  } = $props();

  const scopeLabel = $derived(
    scopes.length === 2 ? "metadata and body" : scopes[0] === "body" ? "body" : "metadata",
  );
</script>

{#if count > 0}
  <aside
    class="flex flex-none flex-col gap-2 border-b border-warning/40 bg-warning-container px-4 py-2.5
      text-sm text-on-warning-container sm:flex-row sm:items-center"
    aria-label="Outstanding housekeeping proposals"
  >
    <p class="min-w-0 flex-1">
      <strong>{count} housekeeping proposal{count === 1 ? "" : "s"}</strong>
      {count === 1 ? " is" : " are"} waiting for review in this record's
      {scopeLabel}. Check {count === 1 ? "it" : "them"} before editing.
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
