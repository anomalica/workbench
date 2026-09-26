import { afterEach, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/svelte";
import PdfViewer from "./PdfViewer.svelte";

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 3,
      getPage: async () => ({ getViewport: () => ({ width: 600, height: 800 }) }),
    }),
  }),
}));

vi.mock("pdfjs-dist/build/pdf.worker.mjs?url", () => ({ default: "worker" }));

const originalIntersectionObserver = globalThis.IntersectionObserver;
const originalResizeObserver = globalThis.ResizeObserver;
const originalScrollIntoView = Element.prototype.scrollIntoView;

afterEach(() => {
  globalThis.IntersectionObserver = originalIntersectionObserver;
  globalThis.ResizeObserver = originalResizeObserver;
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

it("reports a manually visible page without snapping back to its boundary", async () => {
  const observers: { callback: IntersectionObserverCallback; options?: IntersectionObserverInit }[] = [];
  globalThis.IntersectionObserver = class {
    constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      observers.push({ callback, options });
    }
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  } as unknown as typeof IntersectionObserver;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
  const scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll;
  const onpagechange = vi.fn();
  const blob = { arrayBuffer: async () => new ArrayBuffer(1) } as Blob;
  const view = render(PdfViewer, { props: { blob, onpagechange, pageRequest: { page: 1 } } });

  await waitFor(() => expect(view.container.querySelectorAll("[data-page]")).toHaveLength(3));
  await waitFor(() => expect(observers).toHaveLength(2));
  await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
  // The viewer suppresses reports during its own requested scroll.
  await new Promise((resolve) => setTimeout(resolve, 130));
  const visible = observers.find(({ options }) => options?.rootMargin?.startsWith("-45%"))!;
  visible.callback(
    [{ isIntersecting: true, target: view.container.querySelector('[data-page="2"]')! } as unknown as IntersectionObserverEntry],
    {} as IntersectionObserver,
  );
  expect(onpagechange).toHaveBeenCalledWith(2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(scroll).toHaveBeenCalledTimes(1);

  await view.rerender({ blob, onpagechange, pageRequest: { page: 3 } });
  await waitFor(() => expect(scroll).toHaveBeenCalledTimes(2));
  expect(scroll.mock.instances[1]).toBe(view.container.querySelector('[data-page="3"]'));
});
