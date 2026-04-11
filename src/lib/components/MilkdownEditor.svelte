<script lang="ts">
  import { Crepe } from "@milkdown/crepe";
  import "@milkdown/crepe/theme/common/style.css";
  import "@milkdown/crepe/theme/frame.css";

  let {
    value,
    onchange,
  }: {
    value: string;
    onchange: (content: string) => void;
  } = $props();

  let container: HTMLDivElement | undefined = $state();
  let crepe: Crepe | null = null;

  $effect(() => {
    if (!container) return;

    const instance = new Crepe({
      root: container,
      defaultValue: value,
    });

    instance.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        onchange(markdown);
      });
    });

    instance.create().then(() => {
      crepe = instance;
    });

    return () => {
      crepe?.destroy();
      crepe = null;
    };
  });
</script>

<div bind:this={container} class="milkdown-editor flex-1 overflow-auto"></div>

<style>
  .milkdown-editor {
    border-left: 2px solid var(--color-primary-muted);
    background: color-mix(in srgb, var(--color-surface-alt) 30%, transparent);
  }

  .milkdown-editor :global(.milkdown) {
    height: 100%;
  }

  .milkdown-editor :global(.milkdown .editor) {
    padding: 1.5rem 2rem;
    outline: none;
    min-height: 100%;
  }
</style>
