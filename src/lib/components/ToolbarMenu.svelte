<script lang="ts">
  /**
   * One labelled choice in the toolbar above the list: "Type: Podcast",
   * "Date: Published".
   *
   * The type filter used to be a row of chips, one per type. That was fine at
   * four - PDF, web, audio, video - and stopped being fine when document_type
   * arrived and the row grew to seventeen. Seventeen chips is not a control a
   * reviewer scans, it is a wall, and on a narrow display it shoved the review
   * status and the record count off the edge. Every option still shows, in a
   * list, with how many records it would leave.
   *
   * The Date selector already worked this way with its own open/close/outside
   * click wiring in App.svelte; this is that wiring, shared, so the two read as
   * one control and the next selector does not grow a third copy.
   */

  export interface MenuOption {
    id: string;
    label: string;
    /** Shown after the label where it helps to know before picking. */
    count?: number;
  }

  interface Props {
    label: string;
    value: string;
    options: MenuOption[];
    onpick: (id: string) => void;
    title?: string;
  }

  let { label, value, options, onpick, title }: Props = $props();

  let open = $state(false);
  let root = $state<HTMLDivElement | undefined>();

  let current = $derived(options.find((o) => o.id === value)?.label ?? value);

  function pick(id: string) {
    onpick(id);
    open = false;
  }

  function onDocMousedown(e: MouseEvent) {
    if (!root?.contains(e.target as Node)) open = false;
  }
  function onDocKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") open = false;
  }

  $effect(() => {
    if (!open) return;
    document.addEventListener("mousedown", onDocMousedown);
    document.addEventListener("keydown", onDocKeydown);
    return () => {
      document.removeEventListener("mousedown", onDocMousedown);
      document.removeEventListener("keydown", onDocKeydown);
    };
  });
</script>

<div class="flex items-center gap-2 relative" bind:this={root}>
  <span class="text-xs font-ui text-on-surface-muted">{label}:</span>
  <button
    onclick={() => (open = !open)}
    class="text-xs font-ui px-2 py-1 rounded cursor-pointer transition-colors
      flex items-center gap-1 bg-surface text-on-surface-secondary
      hover:bg-surface/60 border border-border whitespace-nowrap"
    {title}
    aria-haspopup="listbox"
    aria-expanded={open}
  >
    {current}
    <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" d="M6 9l6 6 6-6" />
    </svg>
  </button>
  {#if open}
    <div
      role="listbox"
      class="absolute top-full left-0 mt-1 min-w-40 max-h-96 overflow-y-auto z-30
        bg-surface border border-border rounded shadow-lg py-1"
    >
      {#each options as o (o.id)}
        <button
          role="option"
          aria-selected={o.id === value}
          onclick={() => pick(o.id)}
          class="w-full text-left text-xs font-ui px-3 py-1.5 hover:bg-surface-alt cursor-pointer
            flex items-baseline gap-3
            {o.id === value ? 'text-primary font-medium' : 'text-on-surface'}"
        >
          <span class="flex-1">{o.label}</span>
          {#if o.count !== undefined}
            <span class="text-on-surface-muted tabular-nums">{o.count}</span>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>
