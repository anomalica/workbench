<script lang="ts">
  import type { Segment } from "$lib/transcript";

  let {
    segments,
    selectedSpeakers,
    onselect,
    onrename,
    onmerge,
    ontoggleirrelevant,
  }: {
    segments: Segment[];
    selectedSpeakers: Set<string>;
    onselect: (id: string, e?: MouseEvent) => void;
    onrename: (id: string, name: string) => void;
    onmerge: (sourceIds: string[], targetName: string) => void;
    ontoggleirrelevant: (id: string) => void;
  } = $props();

  let mergeTarget = $state<string | null>(null);

  // Auto-pick the best merge target when selection changes.
  // Prefers a non-default name ("Luis Elizondo" over "Speaker 6").
  $effect(() => {
    if (selectedSpeakers.size >= 2) {
      const ids = [...selectedSpeakers];
      const nonDefault = ids.filter((id) => !/^Speaker \d+$/i.test(id));
      mergeTarget = nonDefault.length > 0 ? nonDefault[0] : ids[0];
    } else {
      mergeTarget = null;
    }
  });

  interface SpeakerRow {
    id: string;
    total: number;
    relevant: number;
    allIrrelevant: boolean;
  }

  // Stable order: by first appearance in the transcript. Renaming a
  // speaker keeps the row in the same position because the renamed
  // speaker still first appears at the same segment index.
  let speakers = $derived((): SpeakerRow[] => {
    const firstSeen = new Map<string, number>();
    const totals = new Map<string, number>();
    const relevants = new Map<string, number>();
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!seg.speaker) continue;
      if (!firstSeen.has(seg.speaker)) firstSeen.set(seg.speaker, i);
      totals.set(seg.speaker, (totals.get(seg.speaker) ?? 0) + 1);
      if (!seg.irrelevant) {
        relevants.set(seg.speaker, (relevants.get(seg.speaker) ?? 0) + 1);
      }
    }
    return [...firstSeen.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => ({
        id,
        total: totals.get(id) ?? 0,
        relevant: relevants.get(id) ?? 0,
        allIrrelevant: (relevants.get(id) ?? 0) === 0,
      }));
  });

  let editingId = $state<string | null>(null);
  let editingValue = $state("");
  let editInputEl: HTMLInputElement | undefined = $state();

  function startEdit(id: string) {
    editingId = id;
    editingValue = id;
    setTimeout(() => editInputEl?.focus(), 0);
  }

  function commitEdit() {
    if (editingId && editingValue.trim() && editingValue.trim() !== editingId) {
      onrename(editingId, editingValue.trim());
    }
    editingId = null;
  }

  function cancelEdit() {
    editingId = null;
  }

  function handleEditKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  }
</script>

<div class="space-y-1">
  {#if selectedSpeakers.size >= 2 && mergeTarget}
    <div class="sticky top-9 z-10 px-2 py-2 mb-2 bg-primary-container/30 rounded space-y-2">
      <div class="text-xs font-ui text-on-primary-container">Merge into:</div>
      <div class="flex flex-wrap gap-1">
        {#each [...selectedSpeakers] as id}
          <button
            onclick={() => { mergeTarget = id; }}
            class="text-xs font-ui px-2 py-1 rounded cursor-pointer transition-colors inline-flex items-center gap-1
              {mergeTarget === id
                ? 'bg-primary text-on-primary'
                : 'bg-surface text-on-surface-secondary hover:bg-surface-alt'}"
          >
            <span class="w-2 h-2 rounded-full" style="background-color: {speakerColour(id)}"></span>
            {id}
          </button>
        {/each}
      </div>
      <button
        onclick={() => { if (mergeTarget) onmerge([...selectedSpeakers], mergeTarget); }}
        class="text-xs font-ui font-medium px-3 py-1 bg-primary text-on-primary rounded cursor-pointer hover:bg-primary-hover w-full"
      >
        Merge {selectedSpeakers.size} speakers into {mergeTarget}
      </button>
    </div>
  {/if}

  {#each speakers() as row}
    {@const isSelected = selectedSpeakers.has(row.id)}
    <div
      class="group flex items-center gap-2 px-2 py-1.5 rounded text-sm cursor-pointer transition-colors select-none
        {isSelected ? 'bg-primary-container/30 ring-1 ring-primary/30' : 'hover:bg-surface-alt'}
        {row.allIrrelevant ? 'opacity-50' : ''}"
      role="button"
      tabindex="0"
      onclick={(e) => { if (editingId !== row.id) onselect(row.id, e); }}
      onkeydown={(e) => { if (editingId !== row.id && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onselect(row.id); } }}
    >
      <span
        class="w-3 h-3 rounded-full flex-none"
        style="background-color: {speakerColour(row.id)}"
      ></span>

      {#if editingId === row.id}
        <input
          bind:this={editInputEl}
          type="text"
          bind:value={editingValue}
          onblur={commitEdit}
          onkeydown={handleEditKeydown}
          onclick={(e) => e.stopPropagation()}
          class="flex-1 min-w-0 bg-surface text-sm font-ui text-on-surface
            outline-none px-1 py-0.5 rounded border border-primary"
        />
      {:else}
        <span class="flex-1 min-w-0 text-sm font-ui text-on-surface truncate
          {row.allIrrelevant ? 'line-through' : ''}">
          {row.id}
        </span>
        <button
          onclick={(e) => { e.stopPropagation(); startEdit(row.id); }}
          class="opacity-0 group-hover:opacity-100 focus:opacity-100 cursor-pointer p-0.5 text-on-surface-muted hover:text-primary transition-opacity"
          title="Rename"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </button>
      {/if}

      <span class="text-xs text-on-surface-muted flex-none font-mono tabular-nums">
        {#if row.relevant < row.total && row.relevant > 0}
          {row.relevant}/{row.total}
        {:else}
          {row.total}
        {/if}
      </span>

      <button
        onclick={(e) => { e.stopPropagation(); ontoggleirrelevant(row.id); }}
        class="cursor-pointer p-0.5 flex-none transition-colors
          {row.allIrrelevant
            ? 'text-on-surface-muted hover:text-success'
            : 'text-on-surface-muted/40 hover:text-error'}"
        title={row.allIrrelevant
          ? 'Currently irrelevant - click to mark relevant'
          : 'Currently relevant - click to mark irrelevant'}
      >
        {#if row.allIrrelevant}
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        {:else}
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        {/if}
      </button>
    </div>
  {/each}
</div>

<script lang="ts" module>
  const SPEAKER_COLOURS = [
    "#0B6E6E", "#B35A28", "#2D7D46", "#7B4DAA",
    "#C4543B", "#3B7FC4", "#8B6914", "#C44B8B",
    "#4A8B6E", "#6E4A8B",
  ];

  function speakerColour(speaker: string): string {
    const num = parseInt(speaker.replace(/\D/g, "") || "0", 10);
    return SPEAKER_COLOURS[num % SPEAKER_COLOURS.length];
  }
</script>
