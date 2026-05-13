<script lang="ts">
  import { Editor, rootCtx, defaultValueCtx } from "@milkdown/core";
  import { commonmark } from "@milkdown/preset-commonmark";
  import { nord } from "@milkdown/theme-nord";
  import { listener, listenerCtx } from "@milkdown/plugin-listener";

  let {
    value,
    onchange,
  }: {
    value: string;
    onchange: (content: string) => void;
  } = $props();

  let container: HTMLDivElement | undefined = $state();
  let editor: Editor | null = null;
  let lastValueSet = "";

  $effect(() => {
    if (!container) return;
    const target = container;
    lastValueSet = value;
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, target);
        ctx.set(defaultValueCtx, value);
        ctx.get(listenerCtx).markdownUpdated((_, md) => {
          if (md === lastValueSet) return;
          lastValueSet = md;
          onchange(md);
        });
      })
      .config(nord)
      .use(commonmark)
      .use(listener)
      .create()
      .then((e) => {
        editor = e;
      });

    return () => {
      editor?.destroy();
      editor = null;
    };
  });
</script>

<div class="flex-1 flex flex-col min-h-0 border-l-2 border-primary/30 overflow-auto">
  <div bind:this={container} class="milkdown-host flex-1"></div>
</div>

<style>
  .milkdown-host :global(.milkdown) {
    background: transparent;
  }
  .milkdown-host :global(.milkdown .editor) {
    padding: 1.5rem 2rem;
    max-width: none;
  }
</style>
