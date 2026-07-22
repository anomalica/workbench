<script lang="ts">
  import { parseWords } from "$lib/transcript-words";
  import { buildContextIndex } from "$lib/highlight-context";

  // The list of every mark on a word record - highlights, span notes and point
  // beats - for the collapsible "Markup" section in the left panel. Parses the
  // same body the transcript renders.
  //
  // Clicking a row scrolls the transcript to it and emphasises it; clicking it
  // again, or pressing anywhere in the transcript, drops that emphasis. It is a
  // pointer, not a selection - nothing is "held", so there is nothing to
  // dismiss. Hovering reveals a DELETE, drawn as a bin: it wore a ✕ while the
  // emphasis was stuck, and a ✕ on a tinted row reads as "clear this selection"
  // when it actually destroys the mark.
  let {
    body,
    onfocus,
    onremovehighlight,
    onremovenote,
    onremovepointnote,
    onremovecontext,
    onremovelink,
    linkTitles = new Map(),
    focusedId = null,
  }: {
    body: string;
    onfocus: (from: number, to: number, id: string) => void;
    onremovehighlight: (id: string) => void;
    onremovenote: (id: string) => void;
    onremovepointnote: (gIndex: number, ordinal: number) => void;
    /** Drop the edge "`of` needs `needs`". The edge is authored on the `of` side,
     *  so that is the only end offering removal - the same rule the transcript's
     *  chain strip follows, so the two views never disagree about who owns it. */
    onremovecontext?: (of: string, needs: string) => void;
    onremovelink?: (id: string) => void;
    /** content_hash -> title, for naming a link's target record. A target not
     *  in the map (list still loading) falls back to its short hash. */
    linkTitles?: Map<string, string>;
    focusedId?: string | null;
  } = $props();

  interface Mark {
    id: string;
    kind: "highlight" | "note" | "point" | "link";
    from: number;
    to: number;
    excerpt: string;
    text: string;
    gIndex?: number;
    ordinal?: number;
    target?: string;
    quote?: string;
  }

  let parsed = $derived(parseWords(body));

  function excerptOf(from: number, to: number): string {
    const s = parsed.words
      .slice(from, to + 1)
      .map((w) => w.text)
      .join(" ");
    return s.length > 70 ? `${s.slice(0, 70)}…` : s;
  }

  let marks = $derived.by<Mark[]>(() => {
    const out: Mark[] = [];
    for (const h of parsed.highlights) {
      out.push({
        id: `h:${h.id}`,
        kind: "highlight",
        from: h.fromWord,
        to: h.toWord,
        excerpt: excerptOf(h.fromWord, h.toWord),
        text: "",
      });
    }
    for (const l of parsed.links) {
      out.push({
        id: `l:${l.id}`,
        kind: "link",
        from: l.fromWord,
        to: l.toWord,
        excerpt: excerptOf(l.fromWord, l.toWord),
        text: "",
        target: l.target,
        ...(l.quote !== undefined ? { quote: l.quote } : {}),
      });
    }
    for (const n of parsed.spanNotes) {
      out.push({
        id: `n:${n.id}`,
        kind: "note",
        from: n.fromWord,
        to: n.toWord,
        excerpt: excerptOf(n.fromWord, n.toWord),
        text: n.text,
      });
    }
    parsed.words.forEach((w, g) => {
      (w.notes ?? []).forEach((t, ordinal) => {
        out.push({
          id: `p:${g}:${ordinal}`,
          kind: "point",
          from: g,
          to: g,
          excerpt: excerptOf(g, g),
          text: t,
          gIndex: g,
          ordinal,
        });
      });
    });
    return out.sort((a, b) => a.from - b.from || a.to - b.to);
  });

  let highlightById = $derived(new Map(parsed.highlights.map((h) => [h.id, h])));

  let contextIndex = $derived(buildContextIndex(parsed.highlightContexts));

  /** An id plus the words it covers. A null excerpt is DANGLING - the passage
   *  was deleted - which the row renders as repairable rather than hiding. */
  function linked(ids: string[]): { id: string; excerpt: string | null }[] {
    return ids.map((id) => {
      const t = highlightById.get(id);
      return { id, excerpt: t ? excerptOf(t.fromWord, t.toWord) : null };
    });
  }

  function jumpTo(id: string) {
    const t = highlightById.get(id);
    if (t) onfocus(t.fromWord, t.toWord, `h:${id}`);
  }

  /** The target record's title, or its short hash while the list loads. */
  function linkTargetLabel(target?: string): string {
    const hash = (target ?? "").replace(/^sha256:/, "");
    return linkTitles.get(hash) ?? `${hash.slice(0, 12)}...`;
  }

  function remove(m: Mark) {
    if (m.kind === "highlight") onremovehighlight(m.id.slice(2));
    else if (m.kind === "link") onremovelink?.(m.id.slice(2));
    else if (m.kind === "note") onremovenote(m.id.slice(2));
    else if (m.gIndex !== undefined && m.ordinal !== undefined)
      onremovepointnote(m.gIndex, m.ordinal);
  }

  const KIND_LABEL: Record<Mark["kind"], string> = {
    highlight: "Highlight",
    note: "Note",
    point: "Beat",
    link: "Link",
  };
</script>

{#if marks.length === 0}
  <p class="px-1 py-2 text-xs text-on-surface-muted leading-relaxed">
    Select words in the transcript, then Highlight or Note. Selections can span speakers here.
  </p>
{:else}
  <!-- Marks are spaced apart, their context lines tucked tight underneath, so a
       chained pair reads as one group. Evenly spaced, a "Needed by" line sits as
       close to the NEXT mark as to the one it belongs to. -->
  <ul class="space-y-2">
    {#each marks as m (m.id)}
      <li>
        <div
          class="group rounded px-2 py-1.5 cursor-pointer transition-colors
            {focusedId === m.id ? 'bg-primary-container/30' : 'hover:bg-surface-alt'}"
          role="button"
          tabindex="0"
          onclick={() => onfocus(m.from, m.to, m.id)}
          onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onfocus(m.from, m.to, m.id); } }}
        >
          <div class="flex items-center justify-between gap-2">
            <span
              class="text-[10px] font-ui uppercase tracking-wide
                {m.kind === 'highlight' ? 'text-warning/80' : m.kind === 'note' || m.kind === 'link' ? 'text-primary/80' : 'text-on-surface-muted'}"
            >{KIND_LABEL[m.kind]}</span>
            <button
              onclick={(e) => { e.stopPropagation(); remove(m); }}
              class="opacity-0 group-hover:opacity-100 text-on-surface-muted/70 hover:text-error cursor-pointer"
              title="Delete this {KIND_LABEL[m.kind].toLowerCase()}"
              aria-label="Delete this {KIND_LABEL[m.kind].toLowerCase()}"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round"
                  d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 002 2h8a2 2 0 002-2l1-12M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2" />
              </svg>
            </button>
          </div>
          {#if m.kind === "link"}
            <p class="text-xs text-on-surface mt-0.5 truncate" title={m.target}>
              &rarr; {linkTargetLabel(m.target)}
            </p>
            {#if m.quote}
              <p class="text-xs text-on-surface-muted mt-0.5 italic truncate" title={m.quote}>at: "{m.quote}"</p>
            {/if}
          {/if}
          {#if m.text}
            <p class="text-xs text-on-surface mt-0.5 whitespace-pre-wrap">{m.text}</p>
          {/if}
          <p class="text-xs text-on-surface-secondary mt-0.5 italic truncate">"{m.excerpt}"</p>
        </div>

        {#if m.kind === "highlight"}
          {@const raw = m.id.slice(2)}
          {@const needs = linked(contextIndex.needs(raw))}
          {@const deps = linked(contextIndex.dependents(raw))}
          {#if needs.length || deps.length}
            <!-- The chain, shown as the passages themselves. The raw ids ("10",
                 "11") say nothing to a reviewer; the words they cover say
                 everything, so this is the one place the link is legible. -->
            <div class="ml-4 mt-1 pl-2.5 border-l-2 border-border space-y-1">
              {#each needs as n (n.id)}
                <div class="group/edge flex items-baseline gap-1.5">
                  <span class="flex-none text-[10px] font-ui uppercase tracking-wide text-primary/70">Needs</span>
                  {#if n.excerpt === null}
                    <span
                      class="flex-1 min-w-0 text-xs italic text-error/80 line-through truncate"
                      title="That passage was deleted. The link is kept rather than dropped - remove it, or re-highlight the passage."
                    >deleted passage</span>
                  {:else}
                    <button
                      onclick={() => jumpTo(n.id)}
                      class="flex-1 min-w-0 text-left text-xs italic text-on-surface-secondary truncate hover:text-primary cursor-pointer"
                      title="Go to the passage this one depends on"
                    >"{n.excerpt}"</button>
                  {/if}
                  <button
                    onclick={() => onremovecontext?.(raw, n.id)}
                    class="flex-none opacity-0 group-hover/edge:opacity-100 text-on-surface-muted/70 hover:text-error cursor-pointer text-[11px] leading-none"
                    title="Unlink - removes the link only, both highlights stay"
                    aria-label="Remove this context link"
                  >&#x2715;</button>
                </div>
              {/each}
              {#each deps as d (d.id)}
                <div class="flex items-baseline gap-1.5">
                  <span class="flex-none text-[10px] font-ui uppercase tracking-wide text-on-surface-muted">Needed by</span>
                  <button
                    onclick={() => jumpTo(d.id)}
                    class="flex-1 min-w-0 text-left text-xs italic text-on-surface-muted truncate hover:text-primary cursor-pointer"
                    title="Go to the later passage that depends on this one"
                  >"{d.excerpt}"</button>
                </div>
              {/each}
            </div>
          {/if}
        {/if}
      </li>
    {/each}
  </ul>
{/if}
