<script lang="ts">
  import { Editor, rootCtx, defaultValueCtx } from "@milkdown/core";
  import {
    commonmark,
    toggleStrongCommand,
    toggleEmphasisCommand,
    toggleLinkCommand,
    wrapInHeadingCommand,
    wrapInBlockquoteCommand,
    wrapInBulletListCommand,
  } from "@milkdown/preset-commonmark";
  import { nord } from "@milkdown/theme-nord";
  import { listener, listenerCtx } from "@milkdown/plugin-listener";
  import { callCommand, replaceAll } from "@milkdown/utils";
  import { untrack } from "svelte";

  let {
    value,
    onchange,
  }: {
    value: string;
    onchange: (content: string) => void;
  } = $props();

  let container: HTMLDivElement | undefined = $state();
  let editor: Editor | null = null;
  // Tracks the last markdown that flowed in either direction so the
  // two-way sync doesn't trigger feedback loops.
  let lastValueSet = "";

  // Create the editor once. Reads value via untrack so changing the
  // value prop later doesn't tear the editor down and rebuild it (which
  // was clearing the user's selection mid-edit).
  $effect(() => {
    if (!container) return;
    const target = container;
    const initial = untrack(() => value);
    lastValueSet = initial;
    Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, target);
        ctx.set(defaultValueCtx, initial);
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

  // When the parent pushes in a value that doesn't match what the
  // editor just emitted (e.g. discard, undo, switching records),
  // replace the editor content. Skips when the value is our own emit
  // coming back through props.
  $effect(() => {
    const md = value;
    if (md === lastValueSet) return;
    if (!editor) return;
    lastValueSet = md;
    editor.action(replaceAll(md));
  });

  function run(commandKey: Parameters<typeof callCommand>[0], payload?: unknown) {
    if (!editor) return;
    editor.action(callCommand(commandKey, payload));
  }

  function promptLink() {
    const url = window.prompt("Link URL");
    if (!url) return;
    run(toggleLinkCommand.key, { href: url });
  }
</script>

<div class="flex-1 flex flex-col min-h-0 border-l-2 border-primary/30">
  <!-- Toolbar -->
  <div class="flex items-center gap-0.5 px-3 py-1.5 border-b border-border flex-none">
    <button onmousedown={(e) => e.preventDefault()} onclick={() => run(toggleStrongCommand.key)} class="toolbar-btn" title="Bold (Ctrl+B)">
      <strong>B</strong>
    </button>
    <button onmousedown={(e) => e.preventDefault()} onclick={() => run(toggleEmphasisCommand.key)} class="toolbar-btn" title="Italic (Ctrl+I)">
      <em>I</em>
    </button>
    <button onmousedown={(e) => e.preventDefault()} onclick={promptLink} class="toolbar-btn" title="Link (Ctrl+K)">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
        <path stroke-linecap="round" d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
      </svg>
    </button>
    <div class="w-px h-4 bg-border mx-1"></div>
    <button onmousedown={(e) => e.preventDefault()} onclick={() => run(wrapInHeadingCommand.key, 1)} class="toolbar-btn" title="Heading 1">H1</button>
    <button onmousedown={(e) => e.preventDefault()} onclick={() => run(wrapInHeadingCommand.key, 2)} class="toolbar-btn" title="Heading 2">H2</button>
    <button onmousedown={(e) => e.preventDefault()} onclick={() => run(wrapInHeadingCommand.key, 3)} class="toolbar-btn" title="Heading 3">H3</button>
    <div class="w-px h-4 bg-border mx-1"></div>
    <button onmousedown={(e) => e.preventDefault()} onclick={() => run(wrapInBlockquoteCommand.key)} class="toolbar-btn" title="Blockquote">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20" />
        <path stroke-linecap="round" d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 5v3" />
      </svg>
    </button>
    <button onmousedown={(e) => e.preventDefault()} onclick={() => run(wrapInBulletListCommand.key)} class="toolbar-btn" title="Bullet list">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
        <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
      </svg>
    </button>
  </div>

  <div bind:this={container} class="milkdown-host flex-1 overflow-auto"></div>
</div>

<style>
  /* Match Ingest view's line-height (Tailwind prose ~1.75) and font feel. */
  .milkdown-host :global(.milkdown) {
    background: transparent;
  }
  .milkdown-host :global(.milkdown .editor) {
    padding: 1.5rem 2rem;
    max-width: none;
    line-height: 1.75;
    font-size: 0.95rem;
  }
  .milkdown-host :global(.milkdown .editor p) {
    margin: 0 0 1em 0;
  }
  .milkdown-host :global(.milkdown .editor h1),
  .milkdown-host :global(.milkdown .editor h2),
  .milkdown-host :global(.milkdown .editor h3) {
    margin-top: 1.5em;
    margin-bottom: 0.5em;
  }

  .toolbar-btn {
    font-size: 0.75rem;
    font-family: var(--font-ui);
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
    cursor: pointer;
    color: var(--color-on-surface-secondary);
    background: transparent;
    border: none;
    transition: background-color 0.15s, color 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 1.75rem;
  }
  .toolbar-btn:hover {
    background: color-mix(in srgb, var(--color-primary) 12%, transparent);
    color: var(--color-on-surface);
  }
  .toolbar-btn:active {
    background: color-mix(in srgb, var(--color-primary) 22%, transparent);
  }
</style>
