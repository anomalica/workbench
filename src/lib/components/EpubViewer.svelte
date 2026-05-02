<script lang="ts">
  import { parseEpub, type ParsedEpub, type EpubChapter } from "$lib/epub";

  let { file }: { file: File } = $props();

  let parsed = $state<ParsedEpub | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(false);

  $effect(() => {
    const f = file;
    if (!f) {
      parsed = null;
      return;
    }
    loading = true;
    error = null;
    parseEpub(f)
      .then((p) => {
        parsed = p;
        loading = false;
      })
      .catch((e) => {
        error = e instanceof Error ? e.message : String(e);
        loading = false;
      });
  });

  // Lazy-render iframes only when their wrapper scrolls near the viewport.
  // Each iframe holds inlined data URIs for images plus full chapter HTML,
  // so eagerly rendering 50 chapters is wasteful. We attach the srcdoc
  // attribute when the wrapper enters the rootMargin window and detach it
  // when it leaves to free memory.
  let visible = $state<Set<string>>(new Set());
  let scrollRoot: HTMLDivElement | null = $state(null);

  $effect(() => {
    if (!scrollRoot || !parsed) return;
    const observer = new IntersectionObserver(
      (entries) => {
        let next: Set<string> | null = null;
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.chapterId;
          if (!id) continue;
          if (entry.isIntersecting) {
            if (!visible.has(id)) {
              next = next || new Set(visible);
              next.add(id);
            }
          } else {
            if (visible.has(id)) {
              next = next || new Set(visible);
              next.delete(id);
            }
          }
        }
        if (next) visible = next;
      },
      { root: scrollRoot, rootMargin: "400px 0px" },
    );
    for (const wrapper of scrollRoot.querySelectorAll("[data-chapter-id]")) {
      observer.observe(wrapper);
    }
    return () => observer.disconnect();
  });

  function chapterLabel(c: EpubChapter, index: number): string {
    return c.title || `Section ${index + 1}`;
  }
</script>

<div class="flex-1 flex flex-col min-h-0 bg-surface">
  {#if loading}
    <div class="flex-1 flex items-center justify-center text-on-surface-muted">
      <div class="text-center">
        <svg class="w-6 h-6 mx-auto mb-2 animate-spin text-primary" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
        </svg>
        <p class="text-xs font-ui">Reading EPUB...</p>
      </div>
    </div>
  {:else if error}
    <div class="flex-1 flex items-center justify-center text-on-surface-muted p-8">
      <div class="text-center max-w-sm">
        <p class="text-sm text-error mb-2">Could not read this EPUB</p>
        <p class="text-xs">{error}</p>
      </div>
    </div>
  {:else if parsed}
    <div bind:this={scrollRoot} class="flex-1 overflow-auto">
      {#each parsed.chapters as chapter, i (chapter.id)}
        <section data-chapter-id={chapter.id} class="border-b border-border last:border-b-0">
          <header class="px-4 py-2 bg-surface-alt border-b border-border sticky top-0 z-10">
            <h3 class="text-xs font-ui font-medium text-on-surface-secondary uppercase tracking-wide">
              {chapterLabel(chapter, i)}
            </h3>
          </header>
          {#if visible.has(chapter.id)}
            <iframe
              title={chapterLabel(chapter, i)}
              sandbox=""
              srcdoc={chapter.html}
              class="w-full h-[80vh] border-none bg-white"
            ></iframe>
          {:else}
            <div class="h-[80vh] bg-surface-alt/30"></div>
          {/if}
        </section>
      {/each}
    </div>
  {/if}
</div>
