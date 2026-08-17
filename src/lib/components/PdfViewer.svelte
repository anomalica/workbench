<script lang="ts">
  /**
   * The original PDF, rendered here rather than handed to the browser.
   *
   * The browser's own viewer cannot be told to change page. Its only control
   * is the `#page=` fragment on load, and a fragment-only change to an iframe
   * is a same-document navigation the viewer ignores - so the previous version
   * forced it by minting a new object URL, which made the viewer tear down and
   * re-parse the whole file. On a 68MB scan that is a black flash and several
   * seconds of work to move one page, every time a divider is clicked or the
   * text is scrolled past a boundary.
   *
   * Rendering the pages ourselves makes the jump instant, and page navigation
   * is the whole point of having the original beside the text: a reviewer is
   * checking an extraction against the page it came from.
   *
   * Pages render only when they are near the viewport. A placeholder of the
   * right height stands in for the rest, so the scrollbar is honest from the
   * start and a hundred-page file does not rasterise a hundred canvases to
   * show one.
   */
  import { onMount, tick, untrack } from "svelte";

  interface Props {
    /** The file's bytes, however they were obtained. */
    blob: Blob;
    /** Page to bring into view. Changing this scrolls; it does not reload. */
    page?: number;
    /** Fired with the page that occupies the viewport as the user scrolls,
     *  so the text pane can follow the original as well as drive it. */
    onpagechange?: (page: number) => void;
    class?: string;
  }

  let { blob, page = 1, onpagechange, class: klass = "" }: Props = $props();

  interface PageSlot {
    number: number;
    width: number;
    height: number;
    canvas?: HTMLCanvasElement;
    rendered: boolean;
    rendering: boolean;
  }

  let doc = $state<any>(null);
  let slots = $state<PageSlot[]>([]);
  let container = $state<HTMLDivElement | undefined>();
  let failed = $state<string | null>(null);
  let loading = $state(true);
  /** Width the pages are rasterised to; tracks the pane so a resize re-renders
   *  at the right resolution rather than scaling a stale bitmap. */
  let paneWidth = $state(0);
  /** Set while a programmatic scroll is in flight, so the observer that reports
   *  the visible page does not report the pages passed on the way there. */
  let scrolling = false;
  /** Pages currently near the viewport. Held rather than acted on directly,
   *  because the observer fires before the pane has been measured and a page
   *  that was already on screen would never get a second intersection to
   *  trigger its render. */
  let near = $state(new Set<number>());

  /** How far outside the viewport to keep pages rendered. One screen either
   *  side: enough that scrolling never shows an empty box, few enough that a
   *  long file holds a handful of canvases rather than all of them. */
  const RENDER_MARGIN = "100% 0px";

  onMount(async () => {
    try {
      const pdfjs = await import("pdfjs-dist");
      // The worker is bundled from the same package, so it matches the build
      // exactly - a mismatched worker version fails at parse time with a
      // message that does not say so.
      pdfjs.GlobalWorkerOptions.workerSrc = (
        await import("pdfjs-dist/build/pdf.worker.mjs?url")
      ).default;
      const data = await blob.arrayBuffer();
      doc = await pdfjs.getDocument({ data }).promise;
      const first = await doc.getPage(1);
      const viewport = first.getViewport({ scale: 1 });
      // Every page is assumed the size of the first for its placeholder. A
      // mixed-size document corrects itself as each page renders; the point of
      // the estimate is only that the scrollbar is roughly right at once.
      slots = Array.from({ length: doc.numPages }, (_, i) => ({
        number: i + 1,
        width: viewport.width,
        height: viewport.height,
        rendered: false,
        rendering: false,
      }));
      loading = false;
      await tick();
      if (page > 1) scrollToPage(page);
    } catch (e) {
      failed = e instanceof Error ? e.message : String(e);
      loading = false;
    }
  });

  async function renderPage(slot: PageSlot) {
    if (!doc || slot.rendered || slot.rendering || !slot.canvas || !paneWidth) return;
    slot.rendering = true;
    try {
      const pdfPage = await doc.getPage(slot.number);
      const base = pdfPage.getViewport({ scale: 1 });
      const scale = paneWidth / base.width;
      // Rasterise at device resolution, then let CSS scale it back down, or
      // the text on a scan is unreadable on a high-density display.
      const dpr = window.devicePixelRatio || 1;
      const viewport = pdfPage.getViewport({ scale: scale * dpr });
      const canvas = slot.canvas;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = "100%";
      canvas.style.height = "auto";
      const context = canvas.getContext("2d");
      if (!context) return;
      await pdfPage.render({ canvasContext: context, viewport }).promise;
      slot.height = base.height * scale;
      slot.rendered = true;
    } catch {
      // A page that will not render leaves its placeholder; the rest of the
      // document is still usable, which is what matters for a review tool.
    } finally {
      slot.rendering = false;
    }
  }

  /** Render whatever is near the viewport, whenever either the set of near
   *  pages or the width they must be rasterised at changes. */
  $effect(() => {
    const width = paneWidth;
    const pages = near;
    if (!width) return;
    // Untracked: rendering flips `rendered` and `rendering` on the slots, and
    // reading them here as well would make each render schedule the next pass
    // that starts it again.
    untrack(() => {
      for (const n of pages) {
        const slot = slots.find((s) => s.number === n);
        if (slot) renderPage(slot);
      }
    });
  });

  /** Track what is near the viewport, and report what is in it. */
  $effect(() => {
    if (!container || !slots.length) return;
    const nearby = new IntersectionObserver(
      (entries) => {
        const next = new Set(near);
        for (const entry of entries) {
          const n = Number((entry.target as HTMLElement).dataset.page);
          if (entry.isIntersecting) next.add(n);
          else next.delete(n);
        }
        near = next;
      },
      { root: container, rootMargin: RENDER_MARGIN },
    );
    const visible = new IntersectionObserver(
      (entries) => {
        if (scrolling) return;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const n = Number((entry.target as HTMLElement).dataset.page);
          if (n && n !== page) onpagechange?.(n);
        }
      },
      { root: container, rootMargin: "-45% 0px -45% 0px" },
    );
    for (const el of container.querySelectorAll("[data-page]")) {
      nearby.observe(el);
      visible.observe(el);
    }
    return () => {
      nearby.disconnect();
      visible.disconnect();
    };
  });

  /** Re-rasterise what is on screen when the pane is resized. */
  $effect(() => {
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width - 24;
      if (width > 0 && Math.abs(width - paneWidth) > 8) {
        paneWidth = width;
        for (const slot of slots) slot.rendered = false;
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  });

  export function scrollToPage(n: number) {
    const target = container?.querySelector(`[data-page="${n}"]`);
    if (!target) return;
    scrolling = true;
    target.scrollIntoView({ behavior: "auto", block: "start" });
    setTimeout(() => {
      scrolling = false;
    }, 120);
  }

  // The page prop is a request to move, not a reload.
  $effect(() => {
    const n = page;
    if (!loading && container) scrollToPage(n);
  });
</script>

<div bind:this={container} class="overflow-auto h-full bg-surface-alt {klass}">
  {#if loading}
    <p class="text-sm font-ui text-on-surface-muted p-6">Opening the original...</p>
  {:else if failed}
    <p class="text-sm font-ui text-on-surface-muted p-6">
      This PDF could not be opened here. {failed}
    </p>
  {:else}
    {#each slots as slot (slot.number)}
      <div
        data-page={slot.number}
        class="relative mx-3 my-3 bg-white shadow-sm"
        style={slot.rendered ? "" : `aspect-ratio: ${slot.width} / ${slot.height}`}
      >
        <canvas bind:this={slot.canvas} class="block w-full"></canvas>
        {#if !slot.rendered}
          <span
            class="absolute inset-0 flex items-center justify-center text-xs font-ui text-on-surface-muted/50"
            >{slot.number}</span
          >
        {/if}
      </div>
    {/each}
  {/if}
</div>
