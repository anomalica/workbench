<script lang="ts">
  import * as pdfjsLib from "pdfjs-dist";

  // Use the bundled worker
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url,
  ).href;

  let {
    file,
    page = 1,
  }: {
    file: File;
    page: number;
  } = $props();

  let canvas: HTMLCanvasElement | undefined = $state();
  let container: HTMLDivElement | undefined = $state();
  let totalPages = $state(0);
  let currentPage = $state(1);
  let pdfDoc: pdfjsLib.PDFDocumentProxy | null = null;
  let rendering = $state(false);

  async function loadPdf(file: File) {
    const buffer = await file.arrayBuffer();
    pdfDoc = await pdfjsLib.getDocument({ data: buffer }).promise;
    totalPages = pdfDoc.numPages;
  }

  async function renderPage(pageNum: number) {
    if (!pdfDoc || !canvas || !container || rendering) return;
    if (pageNum < 1 || pageNum > totalPages) return;

    rendering = true;
    currentPage = pageNum;

    const pdfPage = await pdfDoc.getPage(pageNum);
    const unscaledViewport = pdfPage.getViewport({ scale: 1 });

    // Fit to container width
    const containerWidth = container.clientWidth;
    const scale = containerWidth / unscaledViewport.width;
    const viewport = pdfPage.getViewport({ scale });

    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await pdfPage.render({ canvas, viewport }).promise;
    rendering = false;
  }

  // Load PDF when file changes
  $effect(() => {
    if (file) {
      loadPdf(file).then(() => renderPage(page));
    }
  });

  // Re-render when page prop changes
  $effect(() => {
    if (pdfDoc && page !== currentPage) {
      renderPage(page);
    }
  });

  // Re-render on container resize
  $effect(() => {
    if (!container) return;
    const observer = new ResizeObserver(() => {
      if (pdfDoc) renderPage(currentPage);
    });
    observer.observe(container);
    return () => observer.disconnect();
  });
</script>

<div
  bind:this={container}
  class="flex-1 flex flex-col items-center overflow-auto bg-stone/10"
>
  <div class="px-3 py-1.5 flex items-center gap-2 w-full bg-surface-alt border-b border-border flex-none">
    <span class="text-xs font-ui text-on-surface-muted">
      Page {currentPage} of {totalPages}
    </span>
  </div>
  <div class="flex-1 flex items-start justify-center overflow-auto p-2">
    <canvas bind:this={canvas} class="shadow-md"></canvas>
  </div>
</div>
