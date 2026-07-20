<script lang="ts">
  import { parseWords } from "$lib/transcript-words";

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
    gIndex?: number;
    ordinal?: number;
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

{#if marks.length === 0}
  <p class="px-1 py-2 text-xs text-on-surface-muted leading-relaxed">
    Select words in the transcript, then Highlight or Note. Selections can span speakers here.
  </p>
{:else}
  <ul class="space-y-0.5">
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
                {m.kind === 'highlight' ? 'text-warning/80' : m.kind === 'note' ? 'text-primary/80' : 'text-on-surface-muted'}"
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
          {#if m.text}
            <p class="text-xs text-on-surface mt-0.5 whitespace-pre-wrap">{m.text}</p>
          {/if}
          <p class="text-xs text-on-surface-secondary mt-0.5 italic truncate">"{m.excerpt}"</p>
        </div>
      </li>
    {/each}
  </ul>
{/if}
