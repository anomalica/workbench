<script lang="ts">
  import {
    commitStructure,
    fetchStructureCandidates,
    previewStructure,
    type StructureCandidate,
    type StructureCandidates,
    type StructurePreview,
    type StructureRequest,
    type StructureSelectionEntry,
  } from "$lib/api";

  interface Props {
    initialParent?: string | null;
    oncommitted?: () => void | Promise<void>;
  }

  interface OutputDraft {
    id: string;
    title: string;
    documentType: string;
  }

  interface PageDraft {
    key: string;
    parentHash: string;
    parentTitle: string;
    assetHash: string;
    assetFilePage: number;
    sourceType: "pdf" | "image";
    excerpt: string;
  }

  let { initialParent = null, oncommitted }: Props = $props();

  const DOCUMENT_TYPES = [
    "book",
    "paper",
    "report",
    "article",
    "letter",
    "email",
    "statement",
    "form",
    "transcript",
    "slide",
    "interview",
    "documentary",
    "footage",
    "podcast",
    "lecture",
    "broadcast",
    "recording",
  ];

  let candidates = $state<StructureCandidates | null>(null);
  let selected = $state<string[]>([]);
  let outputs = $state<OutputDraft[]>([]);
  let memberships = $state<Record<string, string[]>>({});
  let pageOrder = $state<string[]>([]);
  let preview = $state<StructurePreview | null>(null);
  let previewRequest = $state<StructureRequest | null>(null);
  let loading = $state(true);
  let previewing = $state(false);
  let committing = $state(false);
  let error = $state("");
  let notice = $state("");
  let editVersion = 0;
  let nextOutput = 1;

  const selectedParents = $derived(
    selected
      .map((hash) => candidates?.parents.find((candidate) => candidate.content_hash === hash))
      .filter((candidate) => candidate !== undefined) as StructureCandidate[],
  );

  const pages = $derived.by((): PageDraft[] => {
    const unordered = selectedParents.flatMap((parent) =>
      parent.pages.map((page, index) => ({
        key: `${parent.content_hash}:${index}`,
        parentHash: parent.content_hash,
        parentTitle: parent.title,
        assetHash: page.asset_hash,
        assetFilePage: page.asset_file_page,
        sourceType: page.source_type,
        excerpt: page.excerpt,
      })),
    );
    const byKey = new Map(unordered.map((page) => [page.key, page]));
    return pageOrder.map((key) => byKey.get(key)).filter((page) => page !== undefined) as PageDraft[];
  });

  const mode = $derived(selected.length === 1 ? "split" : selected.length > 1 ? "compose" : null);

  const readyToPreview = $derived.by(() => {
    if (!candidates || !mode || previewing || committing) return false;
    if (mode === "split" && outputs.length < 2) return false;
    if (mode === "compose" && outputs.length !== 1) return false;
    if (outputs.some((output) => !output.title.trim())) return false;
    return outputs.every((output) =>
      pages.some((page) => memberships[page.key]?.includes(output.id)),
    );
  });

  function newOutput(title: string): OutputDraft {
    return { id: `output-${nextOutput++}`, title, documentType: "" };
  }

  function invalidatePreview() {
    editVersion += 1;
    preview = null;
    previewRequest = null;
    notice = "";
  }

  function pageDrafts(parents: StructureCandidate[]): PageDraft[] {
    return parents.flatMap((parent) =>
      parent.pages.map((page, index) => ({
        key: `${parent.content_hash}:${index}`,
        parentHash: parent.content_hash,
        parentTitle: parent.title,
        assetHash: page.asset_hash,
        assetFilePage: page.asset_file_page,
        sourceType: page.source_type,
        excerpt: page.excerpt,
      })),
    );
  }

  function configureSelection(next: string[]) {
    selected = next;
    invalidatePreview();
    error = "";
    nextOutput = 1;
    const parents = next
      .map((hash) => candidates?.parents.find((candidate) => candidate.content_hash === hash))
      .filter((candidate) => candidate !== undefined) as StructureCandidate[];
    const nextPages = pageDrafts(parents);
    pageOrder = nextPages.map((page) => page.key);
    memberships = {};

    if (parents.length === 1) {
      const first = newOutput(`${parents[0].title} - Part 1`);
      const second = newOutput(`${parents[0].title} - Part 2`);
      outputs = [first, second];
      const splitAt = Math.max(1, Math.ceil(nextPages.length / 2));
      memberships = Object.fromEntries(
        nextPages.map((page, index) => [page.key, [index < splitAt ? first.id : second.id]]),
      );
    } else if (parents.length > 1) {
      const output = newOutput(parents.map((parent) => parent.title).join(" + "));
      outputs = [output];
      memberships = Object.fromEntries(nextPages.map((page) => [page.key, [output.id]]));
    } else {
      outputs = [];
    }
  }

  function toggleParent(candidate: StructureCandidate) {
    const next = selected.includes(candidate.content_hash)
      ? selected.filter((hash) => hash !== candidate.content_hash)
      : [...selected, candidate.content_hash];
    configureSelection(next);
  }

  function updateOutput(id: string, field: "title" | "documentType", value: string) {
    outputs = outputs.map((output) =>
      output.id === id ? { ...output, [field]: value } : output,
    );
    invalidatePreview();
  }

  function setPageMembership(key: string, outputId: string, included: boolean) {
    const current = memberships[key] ?? [];
    const next = included
      ? [...current.filter((id) => id !== outputId), outputId]
      : current.filter((id) => id !== outputId);
    memberships = { ...memberships, [key]: next };
    invalidatePreview();
  }

  function movePage(key: string, offset: -1 | 1) {
    const from = pageOrder.indexOf(key);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= pageOrder.length) return;
    const next = [...pageOrder];
    [next[from], next[to]] = [next[to], next[from]];
    pageOrder = next;
    invalidatePreview();
  }

  function addOutput() {
    outputs = [...outputs, newOutput(`Part ${outputs.length + 1}`)];
    invalidatePreview();
  }

  function removeOutput(id: string) {
    if (outputs.length <= 2) return;
    const remaining = outputs.filter((output) => output.id !== id);
    outputs = remaining;
    memberships = Object.fromEntries(
      Object.entries(memberships).map(([key, values]) => [
        key,
        values.filter((value) => value !== id),
      ]),
    );
    invalidatePreview();
  }

  function selectionFor(page: PageDraft): StructureSelectionEntry {
    return page.sourceType === "image"
      ? { asset_hash: page.assetHash, selector: { type: "whole" } }
      : {
          asset_hash: page.assetHash,
          selector: { type: "pdf_page", page: page.assetFilePage },
        };
  }

  function buildRequest(): StructureRequest {
    if (!candidates) throw new Error("Structure candidates are not loaded");
    return {
      schema: "anomalica/record-structure/1",
      viewed_ref: candidates.viewed_ref,
      parents: [...selected],
      outputs: outputs.map((output) => ({
        metadata: {
          title: output.title.trim(),
          ...(output.documentType ? { document_type: output.documentType } : {}),
        },
        selection: pages
          .filter((page) => memberships[page.key]?.includes(output.id))
          .map(selectionFor),
      })),
    };
  }

  async function load() {
    loading = true;
    error = "";
    try {
      candidates = await fetchStructureCandidates();
      const requested = initialParent?.startsWith("sha256:")
        ? initialParent
        : initialParent
          ? `sha256:${initialParent}`
          : null;
      configureSelection(
        requested && candidates.parents.some((candidate) => candidate.content_hash === requested)
          ? [requested]
          : [],
      );
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      loading = false;
    }
  }

  async function derivePreview() {
    if (!readyToPreview) return;
    const request = buildRequest();
    const version = editVersion;
    previewing = true;
    error = "";
    notice = "";
    try {
      const result = await previewStructure(request);
      if (version !== editVersion) return;
      preview = result;
      previewRequest = request;
    } catch (reason) {
      if (version === editVersion) {
        error = reason instanceof Error ? reason.message : String(reason);
      }
    } finally {
      previewing = false;
    }
  }

  async function commitPreview() {
    const viewed = preview;
    const request = previewRequest;
    if (!viewed || !request || committing) return;
    committing = true;
    error = "";
    try {
      const result = await commitStructure(request);
      await oncommitted?.();
      await load();
      notice = `Created ${result.created.length} Record${result.created.length === 1 ? "" : "s"} and retired ${result.retired.length} temporary parent${result.retired.length === 1 ? "" : "s"}.`;
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      committing = false;
    }
  }

  $effect(() => {
    void load();
  });
</script>

<div class="flex min-h-0 flex-1 flex-col bg-surface lg:flex-row">
  <aside
    class="flex-none border-b border-border bg-surface-alt p-4 lg:w-[25rem] lg:overflow-y-auto lg:border-r lg:border-b-0"
  >
    <p class="font-ui text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">
      Record definition
    </p>
    <h1 class="mt-1 font-serif text-2xl text-on-surface">Structure Records</h1>
    <p class="mt-2 text-xs leading-relaxed text-on-surface-muted">
      Select one temporary Record to split it, or select several in the order they should be
      composed. Only complete PDF pages and whole standalone images are available.
    </p>

    {#if loading}
      <p class="mt-6 text-sm text-on-surface-muted">Loading temporary Records...</p>
    {:else if candidates}
      <div class="mt-5 space-y-2">
        {#each candidates.parents as candidate (candidate.content_hash)}
          {@const order = selected.indexOf(candidate.content_hash)}
          <label
            class="block cursor-pointer border p-3 transition-colors {order >= 0
              ? 'border-primary bg-surface'
              : 'border-border bg-surface-alt hover:bg-surface'}"
          >
            <span class="flex items-start gap-3">
              <input
                type="checkbox"
                class="mt-0.5 accent-primary"
                checked={order >= 0}
                aria-label={`Select ${candidate.title}`}
                onchange={() => toggleParent(candidate)}
              />
              <span class="min-w-0 flex-1">
                <span class="flex items-start justify-between gap-2">
                  <span class="text-sm font-semibold leading-snug text-on-surface">
                    {candidate.title}
                  </span>
                  {#if order >= 0}
                    <span
                      class="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-on-primary"
                      title="Composition order"
                    >{order + 1}</span>
                  {/if}
                </span>
                <span class="mt-1 block text-xs text-on-surface-muted">
                  {candidate.pages.length} {candidate.pages.length === 1 ? "page" : "pages"} ·
                  {candidate.assets.map((asset) => asset.file_format.toUpperCase()).join(" + ")}
                </span>
                <span class="mt-1 block truncate font-mono text-[10px] text-on-surface-muted/70">
                  {candidate.content_hash}
                </span>
              </span>
            </span>
          </label>
        {/each}
      </div>

      {#if candidates.parents.length === 0}
        <p class="mt-6 text-sm text-on-surface-muted">No live temporary Records are ready.</p>
      {/if}

      {#if candidates.blocked.length > 0}
        <details class="mt-5 border border-error/30 bg-error-container/40 p-3 text-xs">
          <summary class="cursor-pointer font-semibold text-error">
            {candidates.blocked.length} blocked temporary
            {candidates.blocked.length === 1 ? " Record" : " Records"}
          </summary>
          <div class="mt-3 space-y-3 text-on-error-container">
            {#each candidates.blocked as blocked}
              <div>
                <p class="font-mono text-[10px]">{blocked.path}</p>
                <p class="mt-0.5 leading-relaxed">{blocked.detail}</p>
              </div>
            {/each}
          </div>
        </details>
      {/if}
    {/if}
  </aside>

  <section class="min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-4 sm:p-6">
    {#if notice}
      <div class="mb-5 border border-success/30 bg-success/10 px-4 py-3 text-sm text-success" role="status">
        {notice}
      </div>
    {/if}
    {#if error}
      <div class="mb-5 border border-error/30 bg-error-container px-4 py-3 text-sm text-on-error-container" role="alert">
        {error}
      </div>
    {/if}

    {#if !mode}
      <div class="mx-auto flex min-h-72 max-w-xl flex-col items-center justify-center text-center">
        <h2 class="font-serif text-xl text-on-surface">Choose temporary parents</h2>
        <p class="mt-2 text-sm leading-relaxed text-on-surface-muted">
          One parent opens a split. Two or more parents open a composition in selection order.
        </p>
      </div>
    {:else}
      <div class="mx-auto max-w-5xl">
        <div class="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-4">
          <div class="min-w-0">
            <p class="font-ui text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">
              {mode === "split" ? "Split one parent" : `Compose ${selected.length} parents`}
            </p>
            <h2 class="mt-1 font-serif text-xl text-on-surface">
              {mode === "split" ? "Choose pages for each final Record" : "Choose and order the new Record"}
            </h2>
          </div>
          {#if mode === "split"}
            <button
              class="border border-border bg-surface-alt px-3 py-1.5 text-xs font-medium text-on-surface hover:bg-surface"
              onclick={addOutput}
            >Add output Record</button>
          {/if}
        </div>

        <div class="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.8fr)]">
          <div class="min-w-0">
            <h3 class="font-ui text-xs font-semibold uppercase tracking-wide text-on-surface-muted">
              Source pages
            </h3>
            <div class="mt-2 space-y-2">
              {#each pages as page (page.key)}
                <article class="border border-border bg-surface-alt p-3">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary">
                      {page.sourceType === "image" ? "Whole image" : `PDF page ${page.assetFilePage}`}
                    </span>
                    {#if selected.length > 1}
                      <span class="truncate text-xs text-on-surface-muted">{page.parentTitle}</span>
                    {/if}
                  </div>
                  <p class="mt-2 text-xs leading-relaxed text-on-surface-secondary">
                    {page.excerpt || "No text excerpt for this image."}
                  </p>
                  <div class="mt-3 flex items-center gap-1" aria-label={`Order ${page.sourceType === "image" ? "image" : `PDF page ${page.assetFilePage}`}`}>
                    <button
                      class="border border-border bg-surface px-2 py-1 text-[11px] text-on-surface-muted hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-35"
                      disabled={pages[0]?.key === page.key}
                      onclick={() => movePage(page.key, -1)}
                      aria-label={`Move ${page.sourceType === "image" ? "image" : `PDF page ${page.assetFilePage}`} earlier`}
                    >Earlier</button>
                    <button
                      class="border border-border bg-surface px-2 py-1 text-[11px] text-on-surface-muted hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-35"
                      disabled={pages.at(-1)?.key === page.key}
                      onclick={() => movePage(page.key, 1)}
                      aria-label={`Move ${page.sourceType === "image" ? "image" : `PDF page ${page.assetFilePage}`} later`}
                    >Later</button>
                  </div>
                  <fieldset class="mt-3 border-t border-border pt-2">
                    <legend class="pr-2 text-[10px] font-semibold uppercase tracking-wide text-on-surface-muted">
                      {mode === "split" ? "Use in final Records" : "Use in final Record"}
                    </legend>
                    <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                      {#each outputs as output, index (output.id)}
                        {@const pageLabel = page.sourceType === "image" ? "image" : `PDF page ${page.assetFilePage}`}
                        {@const outputLabel = output.title || `Output ${index + 1}`}
                        <label class="flex items-center gap-1.5 text-xs text-on-surface-muted">
                          <input
                            type="checkbox"
                            class="accent-primary"
                            checked={memberships[page.key]?.includes(output.id) ?? false}
                            aria-label={`Include ${pageLabel} in ${outputLabel}`}
                            onchange={(event) =>
                              setPageMembership(page.key, output.id, event.currentTarget.checked)}
                          />
                          {mode === "split" ? outputLabel : "Include"}
                        </label>
                      {/each}
                    </div>
                  </fieldset>
                </article>
              {/each}
            </div>
          </div>

          <div>
            <h3 class="font-ui text-xs font-semibold uppercase tracking-wide text-on-surface-muted">
              Final Records
            </h3>
            <div class="mt-2 space-y-3">
              {#each outputs as output, index (output.id)}
                {@const assignedCount = pages.filter((page) => memberships[page.key]?.includes(output.id)).length}
                <fieldset class="min-w-0 border border-border bg-surface p-4">
                  <legend class="px-1 text-xs font-semibold text-on-surface">
                    Output {index + 1} · {assignedCount} {assignedCount === 1 ? "page" : "pages"}
                  </legend>
                  <label class="block text-xs font-medium text-on-surface-secondary" for={`${output.id}-title`}>
                    Title
                  </label>
                  <input
                    id={`${output.id}-title`}
                    class="mt-1 w-full border border-border bg-surface-alt px-2.5 py-1.5 text-sm text-on-surface outline-none focus:border-primary"
                    value={output.title}
                    oninput={(event) => updateOutput(output.id, "title", event.currentTarget.value)}
                  />
                  <label class="mt-3 block text-xs font-medium text-on-surface-secondary" for={`${output.id}-type`}>
                    Document type <span class="font-normal text-on-surface-muted">(optional)</span>
                  </label>
                  <select
                    id={`${output.id}-type`}
                    class="mt-1 w-full border border-border bg-surface-alt px-2.5 py-1.5 text-sm text-on-surface outline-none focus:border-primary"
                    value={output.documentType}
                    onchange={(event) => updateOutput(output.id, "documentType", event.currentTarget.value)}
                  >
                    <option value="">Not specified</option>
                    {#each DOCUMENT_TYPES as type}
                      <option value={type}>{type}</option>
                    {/each}
                  </select>
                  {#if assignedCount === 0}
                    <p class="mt-2 text-xs text-error">Assign at least one page to this output.</p>
                  {/if}
                  {#if mode === "split" && outputs.length > 2}
                    <button
                      class="mt-3 text-xs text-error hover:underline"
                      onclick={() => removeOutput(output.id)}
                    >Remove output</button>
                  {/if}
                </fieldset>
              {/each}
            </div>
          </div>
        </div>

        <div class="mt-6 border-t border-border pt-5">
          <div class="flex flex-wrap items-center gap-3">
            <button
              class="bg-primary px-4 py-2 text-sm font-semibold text-on-primary disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!readyToPreview}
              onclick={derivePreview}
            >{previewing ? "Deriving preview..." : "Preview final Records"}</button>
            <p class="text-xs text-on-surface-muted">
              A page may be omitted or used in several outputs. The server verifies the committed Assets
              and derives identity, body, page map and source map.
            </p>
          </div>
        </div>

        {#if preview}
          <section class="mt-6 border border-primary/40 bg-primary/5 p-4 sm:p-5" aria-label="Structure preview">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p class="font-ui text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">
                  Server-derived preview
                </p>
                <h3 class="mt-1 font-serif text-xl text-on-surface">
                  {preview.outputs.length} final {preview.outputs.length === 1 ? "Record" : "Records"}
                </h3>
              </div>
              <span class="font-mono text-[10px] text-on-surface-muted" title={preview.viewed_ref}>
                Git {preview.viewed_ref.slice(0, 12)}
              </span>
            </div>
            <div class="mt-4 grid gap-3 md:grid-cols-2">
              {#each preview.outputs as output}
                <article class="border border-border bg-surface p-3">
                  <h4 class="text-sm font-semibold text-on-surface">{output.title}</h4>
                  <p class="mt-1 break-all font-mono text-[10px] text-on-surface-muted">{output.content_hash}</p>
                  <p class="mt-2 text-xs text-on-surface-secondary">
                    {output.page_map.length} {output.page_map.length === 1 ? "page" : "pages"} ·
                    {output.assets.length} {output.assets.length === 1 ? "Asset" : "Assets"}
                  </p>
                  <ol class="mt-2 space-y-1 text-[11px] text-on-surface-muted">
                    {#each output.page_map as mapped}
                      <li>
                        Record page {mapped.record_page} ← Asset page {mapped.asset_file_page}
                        <span class="font-mono">{mapped.asset_hash.slice(0, 18)}...</span>
                      </li>
                    {/each}
                  </ol>
                </article>
              {/each}
            </div>
            <div class="mt-5 flex flex-wrap items-center gap-3 border-t border-primary/20 pt-4">
              <button
                class="bg-primary px-4 py-2 text-sm font-semibold text-on-primary disabled:cursor-not-allowed disabled:opacity-50"
                disabled={committing}
                onclick={commitPreview}
              >{committing ? "Committing atomically..." : "Commit structure"}</button>
              <p class="max-w-2xl text-xs leading-relaxed text-on-surface-muted">
                This creates every final Record and retires every selected parent in one Git commit.
                No review or derived sidecars are copied.
              </p>
            </div>
          </section>
        {/if}
      </div>
    {/if}
  </section>
</div>
