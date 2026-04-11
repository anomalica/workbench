<script lang="ts">
  import { Editor, rootCtx, defaultValueCtx } from "@milkdown/kit/core";
  import { commonmark } from "@milkdown/kit/preset/commonmark";
  import { listener, listenerCtx } from "@milkdown/kit/plugin/listener";
  import { history } from "@milkdown/kit/plugin/history";
  import { nord } from "@milkdown/theme-nord";
  import "@milkdown/theme-nord/style.css";

  let {
    value,
    onchange,
  }: {
    value: string;
    onchange: (content: string) => void;
  } = $props();

  let container: HTMLDivElement | undefined = $state();
  let editorInstance: Editor | null = null;
  let suppressChange = false;

  $effect(() => {
    if (!container) return;

    Editor.make()
      .config(nord)
      .config((ctx) => {
        ctx.set(rootCtx, container!);
        ctx.set(defaultValueCtx, value);
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          if (!suppressChange) onchange(markdown);
        });
      })
      .use(commonmark)
      .use(listener)
      .use(history)
      .create()
      .then((editor) => {
        editorInstance = editor;
      });

    return () => {
      editorInstance?.destroy();
      editorInstance = null;
    };
  });
</script>

<div
  bind:this={container}
  class="milkdown-wrapper flex-1 overflow-auto border-l-2 border-primary/30 bg-surface-alt/30"
></div>

<style>
  .milkdown-wrapper :global(.milkdown) {
    height: 100%;
    overflow: auto;
  }

  .milkdown-wrapper :global(.milkdown .editor) {
    padding: 1.5rem 2rem;
    outline: none;
    min-height: 100%;
  }

  .milkdown-wrapper :global(.milkdown .editor p) {
    margin-bottom: 0.5rem;
  }

  .milkdown-wrapper :global(.milkdown .editor h1),
  .milkdown-wrapper :global(.milkdown .editor h2),
  .milkdown-wrapper :global(.milkdown .editor h3) {
    margin-top: 1rem;
    margin-bottom: 0.5rem;
  }

  .milkdown-wrapper :global(.milkdown .editor img) {
    max-width: 100%;
    border-radius: 0.25rem;
  }
</style>
