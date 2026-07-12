<script lang="ts">
  import { parseWords } from "$lib/transcript-words";

  // The record body (parsed here for the mark list) plus callbacks. Kept in sync
  // with the transcript by parsing the same body prop.
  let {
    body,
    onfocus,
    onremovehighlight,
    onremovenote,
    onremovepointnote,
    focusedId = null,
  }: {
    body: string;
    onfocus: (from: number, to: number, id: string) => void;
    onremovehighlight: (id: string) => void;
    onremovenote: (id: string) => void;
    onremovepointnote: (gIndex: number, ordinal: number) => void;
    focusedId?: string | null;
  } = $props();

  interface Mark {
    id: string;
    kind: "highlight" | "note" | "point";
    from: number;
    to: number;
    excerpt: string;
    text: string;
    // point-note only:
    gIndex?: number;
    ordinal?: number;
  }

  let parsed = $derived(parseWords(body));

  function excerptOf(from: number, to: number): string {
    const s = parsed.words
      .slice(from, to + 1)
      .map((w) => w.text)
      .join(" ");
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  }

  // Every mark in document order: highlights, span notes, and the point
  // event-notes (each anchored after a word). One flat, sorted list.
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

  function remove(m: Mark) {
    if (m.kind === "highlight") onremovehighlight(m.id.slice(2));
    else if (m.kind === "note") onremovenote(m.id.slice(2));
    else if (m.gIndex !== undefined && m.ordinal !== undefined)
      onremovepointnote(m.gIndex, m.ordinal);
  }

  const KIND_LABEL: Record<Mark["kind"], string> = {
    highlight: "Highlight",
    note: "Note",
    point: "Beat",
  };
</script>

<aside class="w-72 flex-none border-l border-border flex flex-col min-h-0 bg-surface-alt/40">
  <div class="flex-none px-4 py-2.5 border-b border-border">
    <h2 class="text-sm font-ui font-semibold text-on-surface">
      Marks
      {#if marks.length}
        <span class="ml-1 text-xs font-normal text-on-surface-muted tabular-nums">({marks.length})</span>
      {/if}
    </h2>
  </div>
  <div class="flex-1 overflow-auto">
    {#if marks.length === 0}
      <p class="px-4 py-6 text-sm text-on-surface-muted">
        Select words in the transcript, then Highlight or Note. Marks can span speakers here.
      </p>
    {:else}
      <ul>
        {#each marks as m (m.id)}
          <li>
            <div
              class="group px-4 py-2.5 border-b border-border/50 cursor-pointer transition-colors
                {focusedId === m.id ? 'bg-primary-container/25' : 'hover:bg-surface-alt'}"
              role="button"
              tabindex="0"
              onclick={() => onfocus(m.from, m.to, m.id)}
              onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onfocus(m.from, m.to, m.id); } }}
            >
              <div class="flex items-center justify-between gap-2">
                <span
                  class="text-[10px] font-ui uppercase tracking-wide
                    {m.kind === 'highlight' ? 'text-warning/80' : m.kind === 'note' ? 'text-primary/80' : 'text-on-surface-muted'}"
                >{KIND_LABEL[m.kind]}</span>
                <button
                  onclick={(e) => { e.stopPropagation(); remove(m); }}
                  class="opacity-0 group-hover:opacity-100 text-on-surface-muted/70 hover:text-error cursor-pointer"
                  title="Remove" aria-label="Remove mark"
                >
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path stroke-linecap="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {#if m.text}
                <p class="text-sm text-on-surface mt-0.5 whitespace-pre-wrap">{m.text}</p>
              {/if}
              <p class="text-xs text-on-surface-secondary mt-0.5 italic truncate">"{m.excerpt}"</p>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</aside>
