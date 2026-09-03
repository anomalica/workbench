<script lang="ts">
  // Renaming a node, wherever a node is shown.
  //
  // The name is the page title and its web address, so this is the one control
  // that changes published output from a browse list. Two things make it worth
  // its own component rather than a text box:
  //
  // - The name being reached for usually EXISTS already, spelled a little
  //   differently. So it suggests live nodes as you type, with their type and
  //   weight, which is how a duplicate gets noticed at all.
  // - Typing a name another node already has is not an error. It says the two
  //   are one thing, and the server merges them into the node holding the name.
  //   Across two different node types that inference is weak, so that case comes
  //   back to be confirmed rather than assumed.
  import {
    fetchNameCheck,
    renameTopic,
    type GraphNodeRef,
    type NameCheck,
    type NameSuggestion,
  } from "$lib/api";
  import { subjectSuggest } from "$lib/subject-suggest.svelte";

  let {
    node,
    onchanged,
    oncancel,
  }: {
    node: { id: string; name: string; node_type?: string; claims?: number };
    /** Called after the graph actually changed, with a sentence saying what and,
     *  for a merge, the id of the node that survived it. */
    onchanged: (message: string, survivorId?: string) => void;
    oncancel: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let draft = $state(node.name);
  const suggest = subjectSuggest({
    excludeId: () => node.id,
    // The box opens pre-filled, and a list of names like the current one is
    // noise until somebody starts typing.
    ignore: () => node.name,
  });
  let busy = $state(false);
  let message = $state<string | null>(null);
  let clash = $state<{ target: GraphNodeRef; source: GraphNodeRef } | null>(null);
  /** The live node whose name the box now holds exactly - which means pressing
   *  the button MERGES rather than renames. The button says so instead of a
   *  confirmation step: picking a suggestion and pressing enter should not fold
   *  a 428-claim subject into a 22-claim one while the button still says
   *  "Rename". */
  let matched = $state<NameSuggestion | null>(null);

  const unchanged = $derived(!draft.trim() || draft.trim() === node.name);

  /** What this NAME will render as on the page, and where it breaks the naming
   *  convention. The two are different things and the difference is invisible in
   *  a text box: the title rule already renders "Unidentified Anomalous
   *  Phenomena (UAP)" as "UAPs", so somebody who wants that title reasonably
   *  types it into the only field they can see - and names the node after an
   *  acronym the matcher cannot use. Advisory, never a block. */
  let check = $state<NameCheck | null>(null);
  let checkTimer: ReturnType<typeof setTimeout> | undefined;

  function recheck() {
    clearTimeout(checkTimer);
    const q = draft.trim();
    if (!q) {
      check = null;
      return;
    }
    checkTimer = setTimeout(async () => {
      check = await fetchNameCheck(q);
    }, 150);
  }

  $effect(() => {
    recheck();
  });

  function onInput() {
    matched = null;
    suggest.search(draft);
    recheck();
  }

  function pick(s: NameSuggestion) {
    draft = s.name;
    matched = s;
    suggest.clear();
  }

  function onkey(e: KeyboardEvent) {
    if (suggest.key(e, pick)) return;
    if (e.key === "Escape") oncancel();
    else if (e.key === "Enter") save();
  }

  // The list arrives after the debounce, so the exact match is recomputed from
  // it rather than at keystroke time.
  $effect(() => {
    if (suggest.items.length) matched = suggest.exact(draft);
  });

  /** Every outcome here comes back with a zero exit: they are answers, not
   *  failures, and each has its own next step. */
  const OUTCOME: Record<string, string> = {
    rejected: "The rename did not go through.",
    lost: "That node no longer resolves - the graph was rebuilt. Reload and try again.",
    pending: "Queued. The assimilator has not applied it yet.",
  };

  async function save(confirmMerge = false) {
    const proposed = draft.trim();
    if (!proposed || proposed === node.name) return oncancel();
    busy = true;
    message = null;
    try {
      const outcome = await renameTopic(node.id, node.name, proposed, undefined, confirmMerge);
      if (outcome.status === "clash" && outcome.target && outcome.source) {
        // Left open: the answer to this is a decision, not a retry.
        clash = { target: outcome.target, source: outcome.source };
        return;
      }
      clash = null;
      suggest.clear();
      if (outcome.status === "merged" && outcome.merged_into) {
        onchanged(
          `"${node.name}" folded into "${outcome.merged_into.name}", which now holds ` +
            `${outcome.merged_into.claims + (node.claims ?? 0)} claims. The old name still finds it.`,
          outcome.merged_into.id,
        );
      } else if (outcome.ok) {
        onchanged(`Renamed to "${proposed}".`);
      } else {
        message = outcome.note ?? OUTCOME[outcome.status] ?? outcome.status;
      }
    } catch (e) {
      message = String(e);
    } finally {
      busy = false;
    }
  }
</script>

<div class="text-xs">
  <div class="flex flex-wrap items-center gap-2">
    <label class="text-on-surface-muted" for="rename-{node.id}">New name</label>
    <input
      id="rename-{node.id}"
      bind:value={draft}
      oninput={onInput}
      onkeydown={onkey}
      autocomplete="off"
      disabled={busy}
      class="min-w-64 flex-1 rounded border border-border bg-surface-alt px-2 py-1 text-sm text-on-surface"
    />
    <button
      onclick={() => save()}
      disabled={busy || unchanged}
      class="rounded bg-primary px-2 py-1 text-on-primary disabled:opacity-50"
    >{matched ? "Merge into it" : "Rename"}</button>
    <button
      onclick={oncancel}
      class="rounded px-2 py-1 text-on-surface-muted hover:text-on-surface"
    >Cancel</button>
  </div>

  {#if suggest.items.length}
    <!-- Said once, above: picking any row puts its exact name in the box, and an
         exact name merges rather than renames. On every row it was eight copies
         of one sentence. -->
    <p class="mt-2 text-on-surface-muted">
      Already in the graph - picking one merges this into it.
    </p>
    <ul class="mt-1 flex flex-col overflow-hidden rounded border border-border">
      {#each suggest.items as s, i (s.id)}
        <li>
          <button
            onclick={() => pick(s)}
            onmouseenter={() => (suggest.highlighted = i)}
            class="flex w-full flex-wrap items-baseline gap-x-2 px-2 py-1.5 text-left
                   {i === suggest.highlighted ? 'bg-primary-container' : 'bg-surface-alt'}"
          >
            <span class="text-on-surface">{s.name}</span>
            <span class="text-[0.65rem] uppercase text-on-surface-muted">{s.node_type}</span>
            <span class="tabular-nums text-on-surface-secondary">{s.claims} claims</span>
            {#if s.via}
              <span class="text-on-surface-muted">also “{s.via}”</span>
            {/if}
            {#if s.exact}
              <span class="ml-auto text-on-surface-muted">exactly what you typed</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}

  {#if check && (check.warnings.length || check.title !== draft.trim())}
    <div class="mt-2 flex flex-col gap-1">
      {#if check.title !== draft.trim()}
        <p class="text-on-surface-muted">
          This is the subject's NAME. Its page will be titled
          <strong class="text-on-surface">{check.title}</strong> - the title
          shortens it; the name stays in full.
        </p>
      {/if}
      {#each check.warnings as w}
        <p class="rounded border border-warning/40 bg-warning-container/30 px-2 py-1 text-on-surface">
          {w}
        </p>
      {/each}
    </div>
  {/if}

  {#if matched}
    <p class="mt-2 text-on-surface">
      <strong>{matched.name}</strong> already has this name, so this is a merge:
      {matched.node_type === node.node_type ? "" : `a ${node.node_type} into a ${matched.node_type}, `}this
      subject's {node.claims ?? 0} claims move onto it and its {matched.claims} stay,
      under the one name. Reversible, and the old name still finds it.
    </p>
  {:else}
    <p class="mt-2 text-on-surface-muted">
      This name becomes the page's title and its web address. It is recorded as a
      correction, so it survives the graph being rebuilt. Give it a name another
      subject already has and the two are merged into one.
    </p>
  {/if}

  {#if clash}
    <div class="mt-2 rounded border border-warning/40 bg-warning-container/30 px-3 py-2">
      <p class="text-on-surface">
        <strong>{clash.target.name}</strong> already has that name, but it is a
        {clash.target.node_type} and this is a {clash.source.node_type}. Merging them
        makes one {clash.target.node_type} holding
        {clash.target.claims + clash.source.claims} claims.
      </p>
      <div class="mt-2 flex items-center gap-2">
        <button
          onclick={() => save(true)}
          disabled={busy}
          class="rounded bg-warning px-2 py-1 text-on-warning disabled:opacity-50"
        >Merge them anyway</button>
        <button
          onclick={() => (clash = null)}
          class="rounded px-2 py-1 text-on-surface-muted hover:text-on-surface"
        >Leave them separate</button>
      </div>
    </div>
  {/if}

  {#if message}
    <p class="mt-2 rounded border border-warning/30 bg-warning-container/30 px-3 py-2 text-on-surface">
      {message}
    </p>
  {/if}
</div>
