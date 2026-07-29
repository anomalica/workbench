<script lang="ts">
  /**
   * Markup for records that are documents rather than transcripts.
   *
   * A word record gets its bar from WordTranscript, where every word is an
   * element and a selection is a pair of indices. A scanned memo has no such
   * handle, so this wraps the rendered prose, watches the browser's own
   * selection, and anchors it back into the body by text (`prose-anchor.ts`).
   * The reviewer's gesture is the same one either side: select, then say what
   * the selection is.
   */
  import { insertHighlight, insertSpanNote, locateSelection, mintId } from "$lib/prose-anchor";

  interface Props {
  /** Rendered HTML of the body, when this renders its own prose. */
  html?: string;
  /** Or the prose renderer to wrap - ReadableText for text records, which
   *  brings its own block structure and read-coverage. Either way the
   *  selection is the browser's, so the bar does not care which. */
  children?: import("svelte").Snippet;
  /** The raw body the markers get spliced into. */
  body: string;
  /** Read-only reviewers see the prose and no bar. */
  canMark?: boolean;
  /** A new body to save. */
  onbody?: (body: string) => void;
  onscroll?: (e: Event) => void;
  containerEl?: HTMLElement;
  class?: string;
  }

  let {
  html = "",
  children,
  body,
  canMark = false,
  onbody,
  onscroll,
  containerEl = $bindable(),
  class: klass = "",
  }: Props = $props();

  /** The live selection, captured at mouseup: the text itself plus the text
   *  before it, which is what tells two identical sentences apart. */
  let picked = $state<{ text: string; before: string; top: number; left: number } | null>(null);
  let composing = $state(false);
  let noteText = $state("");
  let failed = $state(false);
  let noteBox = $state<HTMLTextAreaElement | undefined>();

  /** How much lead-in to keep. Long enough to separate repeated headings on
   *  different pages, short enough that an edit elsewhere cannot invalidate it
   *  (it is used once, at the moment of the click, and never stored). */
  const LEAD = 160;

  function capture() {
  if (!canMark || composing) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    picked = null;
    return;
  }
  const range = sel.getRangeAt(0);
  if (!containerEl?.contains(range.commonAncestorContainer)) return;
  const text = sel.toString();
  if (!text.trim()) {
    picked = null;
    return;
  }
  const lead = document.createRange();
  lead.setStart(containerEl, 0);
  lead.setEnd(range.startContainer, range.startOffset);
  const box = range.getBoundingClientRect();
  const host = containerEl.getBoundingClientRect();
  picked = {
    text,
    before: lead.toString().slice(-LEAD),
    // Viewport coordinates: the prose may scroll in this element or in a
    // child that brings its own scroller, and fixed positioning is right
    // either way.
    top: Math.max(8, box.top - 46),
    left: Math.max(8, Math.min(box.left + box.width / 2 - 90, host.width - 200)),
  };
  failed = false;
  }

  function dismiss() {
  picked = null;
  composing = false;
  noteText = "";
  failed = false;
  }

  function span() {
  if (!picked) return null;
  return locateSelection(body, picked.text, picked.before);
  }

  function saveNote() {
  const at = span();
  if (!at || !noteText.trim()) {
    failed = !at;
    return;
  }
  onbody?.(insertSpanNote(body, at, mintId(body), noteText.trim()));
  window.getSelection()?.removeAllRanges();
  dismiss();
  }

  function highlight() {
  const at = span();
  if (!at) {
    failed = true;
    return;
  }
  onbody?.(insertHighlight(body, at, mintId(body)));
  window.getSelection()?.removeAllRanges();
  dismiss();
  }

  function startNote() {
  composing = true;
  queueMicrotask(() => noteBox?.focus());
  }
</script>

<svelte:window
  onkeydown={(e) => {
  if (e.key === "Escape" && picked) {
    e.preventDefault();
    dismiss();
  }
  }}
/>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  bind:this={containerEl}
  class={children ? "contents" : klass}
  data-scroll-sync={children ? undefined : true}
  onscroll={children ? undefined : onscroll}
  onmouseup={capture}
>
{#if children}
  {@render children()}
{:else}
  {@html html}
{/if}
</div>

{#if picked && canMark}
  <div
    class="fixed z-50 flex items-center gap-2 bg-surface-raised border border-primary/60
      ring-2 ring-primary/25 rounded-full shadow-xl px-3 py-1.5"
    style="top: {picked.top}px; left: {picked.left}px"
  >
    {#if composing}
      <textarea
        bind:this={noteBox}
        bind:value={noteText}
        rows="1"
        placeholder="What these words miss - handwriting, a stamp, what is on the page"
        class="w-80 text-xs font-ui bg-surface border border-border rounded px-2 py-1
          text-on-surface placeholder:text-on-surface-muted resize-none"
        onkeydown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            saveNote();
          }
          if (e.key === "Escape") {
            e.preventDefault();
            dismiss();
          }
        }}
      ></textarea>
      <button
        onclick={saveNote}
        class="text-xs font-ui font-medium text-primary cursor-pointer hover:underline"
      >
        Save
      </button>
    {:else}
      <button
        onclick={highlight}
        aria-label="Highlight"
        title="Highlight these words (highlights may overlap)"
        class="text-primary cursor-pointer p-1 rounded hover:bg-primary/10 transition-colors"
      >
        <svg
          class="w-4 h-4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M14.5 3.5l6 6-7.5 7.5H7.5l-1.5-4 8.5-9.5z"
          />
          <path stroke-linecap="round" stroke-width="3.5" d="M5.5 21h13" />
        </svg>
      </button>
      <button
        onclick={startNote}
        aria-label="Note"
        title="Attach a note over these words - handwriting, a stamp, context the words miss"
        class="text-primary cursor-pointer p-1 rounded hover:bg-primary/10 transition-colors"
      >
        <svg
          class="w-4 h-4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.75"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            d="M4 5.5A1.5 1.5 0 015.5 4h13A1.5 1.5 0 0120 5.5v9a1.5 1.5 0 01-1.5 1.5H9l-5 4V5.5zM8 8h8M8 11.5h5"
          />
        </svg>
      </button>
    {/if}
    <button
      onclick={dismiss}
      aria-label="Clear selection"
      class="p-0.5 rounded cursor-pointer text-on-surface-muted/60 hover:text-on-surface
        hover:bg-surface-alt transition-colors"
    >
      <svg
        class="w-3.5 h-3.5"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  </div>
{/if}

{#if failed && picked}
  <!-- Declining is the safe outcome: the same words appear on several pages
       and nothing in the selection says which one. -->
  <div
    class="fixed z-50 max-w-xs text-xs font-ui bg-surface-raised border border-amber-500/60
      rounded shadow-xl px-3 py-2 text-on-surface-secondary"
    style="top: {picked.top + 44}px; left: {picked.left}px"
  >
    These words appear more than once and the surrounding text does not say which. Select a
    longer passage, or one including nearby wording that is unique.
  </div>
{/if}
