<script lang="ts">
  import {
    AuditAccessError,
    fetchAccountChronology,
    saveAccountChronology,
    type AccountChronologyAccount,
    type AccountChronologyClaim,
    type AccountChronologyView,
  } from "$lib/api";
  import { safeLocalSet } from "$lib/storage";

  let { hash }: { hash: string } = $props();

  type RelationDraft = {
    account_id: string;
    first_claim_id: string;
    relation: "before" | "after" | "unknown" | "simultaneous";
    second_claim_id: string;
  };

  let data = $state<AccountChronologyView | null>(null);
  let accounts = $state<AccountChronologyAccount[]>([]);
  let relations = $state<RelationDraft[]>([]);
  let baseGoldSha = $state<string | null>(null);
  let loading = $state(true);
  let saving = $state(false);
  let error = $state("");
  let saved = $state(false);
  let accessStatus = $state<number | null>(null);
  let selectedSuggestion = $state(0);
  let customTitle = $state("");
  let claimFilter = $state("");
  let loadedHash = $state("");
  let draftNotice = $state("");

  function draftKey(recordHash: string) {
    return `workbench:account-chronology:${recordHash}`;
  }

  function cloneAccounts(value: AccountChronologyAccount[]) {
    return value.map((account) => ({
      ...account,
      spans: account.spans.map((span) => ({ ...span })),
    }));
  }

  function relationsFromGold(view: AccountChronologyView): RelationDraft[] {
    if (!view.gold) return [];
    return [
      ...view.gold.before_pairs.map((pair) => ({
        account_id: pair.account_id,
        first_claim_id: pair.before_claim_id,
        relation: "before" as const,
        second_claim_id: pair.after_claim_id,
      })),
      ...view.gold.unknown_pairs.map((pair) => ({
        account_id: pair.account_id,
        first_claim_id: pair.claim_ids[0],
        relation: "unknown" as const,
        second_claim_id: pair.claim_ids[1],
      })),
      ...view.gold.simultaneous_pairs.map((pair) => ({
        account_id: pair.account_id,
        first_claim_id: pair.claim_ids[0],
        relation: "simultaneous" as const,
        second_claim_id: pair.claim_ids[1],
      })),
    ];
  }

  function restore(view: AccountChronologyView) {
    const stored = localStorage.getItem(draftKey(hash));
    if (stored) {
      try {
        const draft = JSON.parse(stored);
        if (
          draft.digest_sha256 === view.digest_sha256 &&
          Array.isArray(draft.accounts) &&
          Array.isArray(draft.relations)
        ) {
          accounts = draft.accounts;
          relations = draft.relations;
          baseGoldSha = view.gold_sha256;
          if (draft.base_gold_sha256 !== view.gold_sha256) {
            draftNotice =
              "The saved gold changed after this draft began. The draft is preserved against the latest version; review it before saving.";
          }
          return;
        }
      } catch {
        // Keep the evaluator-valid stored gold when the browser draft is corrupt.
      }
    }
    accounts = cloneAccounts(view.gold?.accounts ?? []);
    relations = relationsFromGold(view);
    baseGoldSha = view.gold_sha256;
  }

  $effect(() => {
    const recordHash = hash;
    loading = true;
    error = "";
    draftNotice = "";
    accessStatus = null;
    data = null;
    fetchAccountChronology(recordHash)
      .then((view) => {
        if (hash !== recordHash) return;
        if (!view) {
          loading = false;
          return;
        }
        data = view;
        loadedHash = recordHash;
        restore(view);
        loading = false;
      })
      .catch((reason) => {
        if (hash !== recordHash) return;
        if (reason instanceof AuditAccessError) accessStatus = reason.status;
        else error = reason instanceof Error ? reason.message : String(reason);
        loading = false;
      });
  });

  $effect(() => {
    if (!data || loadedHash !== hash) return;
    safeLocalSet(
      draftKey(hash),
      JSON.stringify({
        digest_sha256: data.digest_sha256,
        base_gold_sha256: baseGoldSha,
        accounts: accounts.map((account) => ({
          id: account.id,
          ...(account.title ? { title: account.title } : {}),
          ...(account.parent_account_id
            ? { parent_account_id: account.parent_account_id }
            : {}),
          spans: account.spans,
        })),
        relations,
      }),
    );
  });

  function uniqueId(title: string): string {
    const stem =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 48) || "account";
    let id = `acct-${stem}`;
    let suffix = 2;
    while (accounts.some((account) => account.id === id)) id = `acct-${stem}-${suffix++}`;
    return id;
  }

  function addAccount(title: string) {
    const clean = title.trim();
    if (!clean) return;
    accounts.push({ id: uniqueId(clean), title: clean, spans: [{ start: 0, end: 1000 }] });
    customTitle = "";
  }

  function addSuggestedAccount() {
    const suggestion = data?.suggestions[selectedSuggestion];
    if (suggestion) addAccount(suggestion.title);
  }

  function removeAccount(index: number) {
    const id = accounts[index].id;
    accounts.splice(index, 1);
    for (const account of accounts) {
      if (account.parent_account_id === id) delete account.parent_account_id;
    }
    relations = relations.filter((relation) => relation.account_id !== id);
  }

  function accountFor(claim: AccountChronologyClaim): string | null {
    if (claim.position === null) return null;
    const containing = accounts
      .filter((account) =>
        account.spans.some(
          (span) => span.start <= (claim.position as number) && (claim.position as number) < span.end,
        ),
      )
      .map((account) => ({
        id: account.id,
        width: account.spans.reduce((total, span) => total + span.end - span.start, 0),
      }))
      .sort((left, right) => left.width - right.width);
    return containing[0]?.id ?? null;
  }

  let assignmentCounts = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const claim of data?.claims ?? []) {
      const account = accountFor(claim);
      if (account) counts.set(account, (counts.get(account) ?? 0) + 1);
    }
    return counts;
  });

  let visibleClaims = $derived.by(() => {
    const query = claimFilter.trim().toLowerCase();
    if (!query) return data?.claims ?? [];
    return (data?.claims ?? []).filter(
      (claim) =>
        claim.text.toLowerCase().includes(query) ||
        claim.id.toLowerCase().includes(query) ||
        (claim.location ?? "").toLowerCase().includes(query),
    );
  });

  function formatTime(milliseconds: number | null): string {
    if (milliseconds === null) return "unlocatable";
    const hours = Math.floor(milliseconds / 3_600_000);
    const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
    const seconds = Math.floor((milliseconds % 60_000) / 1000);
    const millis = milliseconds % 1000;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
  }

  function addRelation() {
    const account = accounts[0];
    if (!account || !data) return;
    const claims = data.claims.filter((claim) => accountFor(claim) === account.id);
    relations.push({
      account_id: account.id,
      first_claim_id: claims[0]?.id ?? "",
      relation: "before",
      second_claim_id: claims[1]?.id ?? "",
    });
  }

  async function save() {
    if (!data || saving) return;
    saving = true;
    saved = false;
    error = "";
    try {
      const next = await saveAccountChronology(hash, {
        base_gold_sha256: baseGoldSha,
        accounts: accounts.map((account) => ({
          id: account.id,
          ...(account.title ? { title: account.title } : {}),
          ...(account.parent_account_id
            ? { parent_account_id: account.parent_account_id }
            : {}),
          spans: account.spans,
        })),
        before_pairs: relations
          .filter((relation) => relation.relation === "before" || relation.relation === "after")
          .map((relation) => ({
            account_id: relation.account_id,
            before_claim_id:
              relation.relation === "before"
                ? relation.first_claim_id
                : relation.second_claim_id,
            after_claim_id:
              relation.relation === "before"
                ? relation.second_claim_id
                : relation.first_claim_id,
          })),
        unknown_pairs: relations
          .filter((relation) => relation.relation === "unknown")
          .map((relation) => ({
            account_id: relation.account_id,
            claim_ids: [relation.first_claim_id, relation.second_claim_id],
          })),
        simultaneous_pairs: relations
          .filter((relation) => relation.relation === "simultaneous")
          .map((relation) => ({
            account_id: relation.account_id,
            claim_ids: [relation.first_claim_id, relation.second_claim_id],
          })),
      });
      data = next;
      baseGoldSha = next.gold_sha256;
      localStorage.removeItem(draftKey(hash));
      accounts = cloneAccounts(next.gold?.accounts ?? []);
      relations = relationsFromGold(next);
      saved = true;
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      saving = false;
    }
  }
</script>

{#if loading}
  <p class="p-6 text-sm text-on-surface-muted">Loading account chronology review...</p>
{:else if accessStatus === 401}
  <p class="p-6 text-sm text-on-surface-muted">Log in to review account chronology.</p>
{:else if accessStatus === 403}
  <p class="p-6 text-sm text-on-surface-muted">This report-only evaluation requires reviewer access.</p>
{:else if !data}
  <p class="p-6 text-sm text-on-surface-muted">No account chronology review is configured for this record.</p>
{:else}
  <div class="account-review p-4 space-y-5">
    <header class="border border-outline-variant bg-surface-container-low p-4">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="font-semibold">Account chronology gold</h2>
        <span class="rounded-sm bg-warning-container px-2 py-0.5 text-xs font-medium text-on-warning-container">Report only</span>
        <span class="font-mono text-xs text-on-surface-muted">{data.coordinate_system}</span>
      </div>
      <p class="mt-2 text-sm text-on-surface-muted">
        This writes private, one-version evaluation gold. It does not change the canonical digest. Account spans use exact media milliseconds; claim assignments follow the narrowest containing account.
      </p>
      {#if data.prediction.status === "blocked"}
        <p class="mt-2 text-xs text-on-surface-muted">Prediction blocked: {data.prediction.reason}</p>
      {/if}
      <div class="mt-3 flex flex-wrap gap-3 font-mono text-[11px] text-on-surface-muted">
        <span title={data.digest_sha256}>digest {data.digest_sha256.slice(0, 12)}</span>
        <span title={data.pre_digest_sha256}>pre-digest {data.pre_digest_sha256.slice(0, 12)}</span>
        <span>{data.claims.length} claims</span>
        <span>{data.claims.filter((claim) => claim.position === null).length} unlocatable</span>
      </div>
    </header>

    <section class="space-y-3">
      <div class="flex flex-wrap items-end gap-2">
        <label class="min-w-64 flex-1 text-xs text-on-surface-muted">
          Legacy reviewed account description (non-scoreable)
          <select bind:value={selectedSuggestion} class="mt-1 w-full border border-outline-variant bg-surface px-2 py-2 text-sm text-on-surface">
            {#each data.suggestions as suggestion, index}
              <option value={index}>{suggestion.title}</option>
            {/each}
          </select>
        </label>
        <button class="border border-outline px-3 py-2 text-sm" onclick={addSuggestedAccount}>Add legacy account</button>
        <label class="min-w-52 text-xs text-on-surface-muted">
          New account title
          <input bind:value={customTitle} class="mt-1 w-full border border-outline-variant bg-surface px-2 py-2 text-sm text-on-surface" />
        </label>
        <button class="border border-outline px-3 py-2 text-sm" onclick={() => addAccount(customTitle)}>Add</button>
      </div>

      {#each accounts as account, accountIndex (account.id)}
        <article class="border border-outline-variant bg-surface p-3">
          <div class="flex flex-wrap items-center gap-2">
            <input bind:value={account.title} aria-label="Account title" class="min-w-64 flex-1 border border-outline-variant bg-surface-container-low px-2 py-1.5 text-sm font-medium" />
            <code class="text-xs text-on-surface-muted">{account.id}</code>
            <span class="text-xs text-on-surface-muted">{assignmentCounts.get(account.id) ?? 0} claims</span>
            <button class="text-xs text-error" onclick={() => removeAccount(accountIndex)}>Remove</button>
          </div>
          <label class="mt-3 block text-xs text-on-surface-muted">
            Nested within
            <select bind:value={account.parent_account_id} class="ml-2 border border-outline-variant bg-surface px-2 py-1 text-sm text-on-surface">
              <option value="">No parent</option>
              {#each accounts.filter((candidate) => candidate.id !== account.id) as candidate}
                <option value={candidate.id}>{candidate.title || candidate.id}</option>
              {/each}
            </select>
          </label>
          <div class="mt-3 space-y-2">
            {#each account.spans as span, spanIndex}
              <div class="flex flex-wrap items-center gap-2">
                <label class="text-xs text-on-surface-muted">Start ms <input type="number" min="0" step="1" bind:value={span.start} class="ml-1 w-32 border border-outline-variant bg-surface px-2 py-1 text-sm text-on-surface" /></label>
                <span class="font-mono text-xs">{formatTime(span.start)}</span>
                <label class="text-xs text-on-surface-muted">End ms <input type="number" min="1" step="1" bind:value={span.end} class="ml-1 w-32 border border-outline-variant bg-surface px-2 py-1 text-sm text-on-surface" /></label>
                <span class="font-mono text-xs">{formatTime(span.end)}</span>
                <button class="text-xs text-error" onclick={() => account.spans.splice(spanIndex, 1)}>Remove span</button>
              </div>
            {/each}
            <button class="text-xs text-primary" onclick={() => account.spans.push({ start: 0, end: 1000 })}>Add interrupted span</button>
          </div>
        </article>
      {/each}
    </section>

    <section class="space-y-3 border-t border-outline-variant pt-4">
      <div class="flex items-center justify-between gap-3">
        <div>
          <h3 class="font-semibold">Account-scoped chronology</h3>
          <p class="text-xs text-on-surface-muted">Record before, reverse order, unknown order, or simultaneous pairs. Both claims must belong to the selected account.</p>
        </div>
        <button class="border border-outline px-3 py-2 text-sm disabled:opacity-40" disabled={accounts.length === 0} onclick={addRelation}>Add pair</button>
      </div>
      {#each relations as relation, relationIndex}
        <div class="grid gap-2 border border-outline-variant p-2 md:grid-cols-[1fr_1.5fr_auto_1.5fr_auto]">
          <select bind:value={relation.account_id} aria-label="Pair account" class="border border-outline-variant bg-surface px-2 py-1 text-sm">
            {#each accounts as account}
              <option value={account.id}>{account.title || account.id}</option>
            {/each}
          </select>
          <select bind:value={relation.first_claim_id} aria-label="First claim" class="min-w-0 border border-outline-variant bg-surface px-2 py-1 text-sm">
            {#each data.claims.filter((claim) => accountFor(claim) === relation.account_id) as claim}
              <option value={claim.id}>{formatTime(claim.position)} {claim.text}</option>
            {/each}
          </select>
          <select bind:value={relation.relation} aria-label="Relation" class="border border-outline-variant bg-surface px-2 py-1 text-sm">
            <option value="before">before</option>
            <option value="after">after</option>
            <option value="unknown">unknown order</option>
            <option value="simultaneous">simultaneous</option>
          </select>
          <select bind:value={relation.second_claim_id} aria-label="Second claim" class="min-w-0 border border-outline-variant bg-surface px-2 py-1 text-sm">
            {#each data.claims.filter((claim) => accountFor(claim) === relation.account_id) as claim}
              <option value={claim.id}>{formatTime(claim.position)} {claim.text}</option>
            {/each}
          </select>
          <button class="text-xs text-error" onclick={() => relations.splice(relationIndex, 1)}>Remove</button>
        </div>
      {/each}
    </section>

    <section class="space-y-3 border-t border-outline-variant pt-4">
      <div class="flex flex-wrap items-center gap-3">
        <h3 class="font-semibold">Claim assignment check</h3>
        <input bind:value={claimFilter} placeholder="Filter claims" class="min-w-60 flex-1 border border-outline-variant bg-surface px-2 py-1.5 text-sm" />
      </div>
      <div class="max-h-[36rem] overflow-auto border border-outline-variant">
        {#each visibleClaims as claim (claim.id)}
          <div class="grid grid-cols-[6rem_8rem_minmax(0,1fr)] gap-2 border-b border-outline-variant px-3 py-2 text-xs last:border-b-0">
            <span class="font-mono">{formatTime(claim.position)}</span>
            <span class="truncate font-medium" title={accountFor(claim) ?? (claim.position === null ? "unlocatable" : "outside")}>
              {accountFor(claim) ?? (claim.position === null ? "unlocatable" : "outside")}
            </span>
            <span>{claim.text}</span>
          </div>
        {/each}
      </div>
    </section>

    {#if error}<p class="text-sm text-error">{error}</p>{/if}
    {#if draftNotice}<p class="text-sm text-warning">{draftNotice}</p>{/if}
    {#if saved}<p class="text-sm text-primary">Evaluator-valid gold saved.</p>{/if}
    <div class="sticky bottom-0 flex items-center justify-between border-t border-outline-variant bg-surface/95 py-3 backdrop-blur">
      <span class="text-xs text-on-surface-muted">{accounts.length} accounts · {relations.length} chronology pairs</span>
      <button class="bg-primary px-4 py-2 text-sm font-medium text-on-primary disabled:opacity-50" disabled={saving || accounts.length === 0} onclick={save}>
        {saving ? "Validating..." : "Validate and save private gold"}
      </button>
    </div>
  </div>
{/if}
