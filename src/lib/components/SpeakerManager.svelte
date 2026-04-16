<script lang="ts">
  import type { Segment } from "$lib/transcript";
  import { speakerColour, isDefaultSpeakerName } from "$lib/transcript";

  let {
    segments,
    namedSpeakers,
    selectedSpeakers,
    onselect,
    onrename,
    onmerge,
    ontoggleirrelevant,
    onaddnamed,
    onremovenamed,
    onrenamenamed,
  }: {
    segments: Segment[];
    namedSpeakers: string[];
    selectedSpeakers: Set<string>;
    onselect: (id: string, e?: MouseEvent) => void;
    onrename: (id: string, name: string) => void;
    onmerge: (sourceIds: string[], targetName: string) => void;
    ontoggleirrelevant: (id: string) => void;
    onaddnamed: (name: string) => void;
    onremovenamed: (name: string) => void;
    onrenamenamed: (oldName: string, newName: string) => void;
  } = $props();

  interface SpeakerRow {
    id: string;
    total: number;
    relevant: number;
    allIrrelevant: boolean;
  }

  // Build speaker rows from segments, sorted by first appearance
  let speakerRows = $derived((): SpeakerRow[] => {
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

  // Split into named (non-default names or in the namedSpeakers list) and unnamed
  let named = $derived(
    speakerRows().filter((r) => !isDefaultSpeakerName(r.id) || namedSpeakers.includes(r.id)),
  );
  let unnamed = $derived(
    speakerRows().filter((r) => isDefaultSpeakerName(r.id) && !namedSpeakers.includes(r.id)),
  );

  // Named speakers from frontmatter that don't have segments yet
  let unassignedNamed = $derived(
    namedSpeakers.filter((n) => !speakerRows().some((r) => r.id === n)),
  );

  // New speaker input
  let newSpeakerName = $state("");
  let showNewInput = $state(false);

  function addSpeaker() {
    const name = newSpeakerName.trim();
    if (name && !namedSpeakers.includes(name)) {
      onaddnamed(name);
      newSpeakerName = "";
      showNewInput = false;
    }
  }

  // Editing
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
      const isUnassigned = unassignedNamed.includes(editingId);
      if (isUnassigned) {
        onrenamenamed(editingId, editingValue.trim());
      } else {
        onrename(editingId, editingValue.trim());
      }
    }
    editingId = null;
  }

  function cancelEdit() {
    editingId = null;
  }

  // Assign an unnamed speaker to a named one
  let assigningId = $state<string | null>(null);

  function assignSpeaker(unnamedId: string, namedId: string) {
    onmerge([unnamedId], namedId);
    assigningId = null;
  }
</script>

<!-- Named speakers -->
<div class="mb-3">
  <div class="flex items-center gap-2 px-2 py-1 mb-1">
    <span class="text-xs font-ui font-medium text-on-surface-secondary uppercase flex-1">Named</span>
    <button
      onclick={() => { showNewInput = !showNewInput; }}
      class="text-xs font-ui text-primary cursor-pointer hover:underline"
    >
      + Add
    </button>
  </div>

  {#if showNewInput}
    <form class="flex items-center gap-2 px-2 py-1 mb-1" onsubmit={(e) => { e.preventDefault(); addSpeaker(); }}>
      <input
        type="text"
        bind:value={newSpeakerName}
        placeholder="Speaker name"
        class="flex-1 text-sm font-ui bg-surface border border-border rounded px-2 py-1
          text-on-surface outline-none focus:border-primary placeholder:text-on-surface-muted/50"
      />
      <button type="submit" class="text-xs font-ui font-medium px-2 py-1 bg-primary text-on-primary rounded cursor-pointer hover:bg-primary-hover">
        Add
      </button>
    </form>
  {/if}

  {#each named as row}
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
      <span class="w-3 h-3 rounded-full flex-none" style="background-color: {speakerColour(row.id)}"></span>
      {#if editingId === row.id}
        <input
          bind:this={editInputEl}
          type="text"
          bind:value={editingValue}
          onblur={commitEdit}
          onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitEdit(); } else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); } }}
          onclick={(e) => e.stopPropagation()}
          class="flex-1 min-w-0 bg-surface text-sm font-ui text-on-surface outline-none px-1 py-0.5 rounded border border-primary"
        />
      {:else}
        <span class="flex-1 min-w-0 text-sm font-ui text-on-surface truncate {row.allIrrelevant ? 'line-through' : ''}">{row.id}</span>
        <button
          onclick={(e) => { e.stopPropagation(); startEdit(row.id); }}
          class="opacity-0 group-hover:opacity-100 cursor-pointer p-0.5 text-on-surface-muted hover:text-primary transition-opacity"
          title="Rename"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </button>
      {/if}
      <span class="text-xs text-on-surface-muted flex-none font-mono tabular-nums">{row.total}</span>
      <button
        onclick={(e) => { e.stopPropagation(); ontoggleirrelevant(row.id); }}
        class="cursor-pointer p-0.5 flex-none transition-colors
          {row.allIrrelevant ? 'text-on-surface-muted hover:text-success' : 'text-on-surface-muted/40 hover:text-error'}"
        title={row.allIrrelevant ? 'Mark relevant' : 'Mark irrelevant'}
      >
        {#if row.allIrrelevant}
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        {:else}
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
          </svg>
        {/if}
      </button>
    </div>
  {/each}

  <!-- Named speakers not yet assigned to any segments -->
  {#each unassignedNamed as name}
    <div class="group flex items-center gap-2 px-2 py-1.5 rounded text-sm cursor-pointer transition-colors select-none hover:bg-surface-alt"
      role="button"
      tabindex="0"
      onclick={(e) => onselect(name, e)}
      onkeydown={(e) => { if (editingId !== name && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onselect(name); } }}
    >
      <span class="w-3 h-3 rounded-full flex-none" style="background-color: {speakerColour(name)}"></span>
      {#if editingId === name}
        <input
          bind:this={editInputEl}
          type="text"
          bind:value={editingValue}
          onblur={commitEdit}
          onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitEdit(); } else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); } }}
          onclick={(e) => e.stopPropagation()}
          class="flex-1 min-w-0 bg-surface text-sm font-ui text-on-surface outline-none px-1 py-0.5 rounded border border-primary"
        />
      {:else}
        <span class="flex-1 text-sm font-ui text-on-surface-muted truncate">{name}</span>
        <button
          onclick={(e) => { e.stopPropagation(); startEdit(name); }}
          class="opacity-0 group-hover:opacity-100 cursor-pointer p-0.5 text-on-surface-muted hover:text-primary transition-opacity"
          title="Rename"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </button>
      {/if}
      <span class="text-xs text-on-surface-muted flex-none font-mono tabular-nums">0</span>
      <button
        onclick={(e) => { e.stopPropagation(); onremovenamed(name); }}
        class="opacity-0 group-hover:opacity-100 text-on-surface-muted/40 hover:text-error cursor-pointer p-0.5 transition-opacity"
        title="Remove"
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  {/each}

  {#if named.length === 0 && unassignedNamed.length === 0}
    <p class="text-xs text-on-surface-muted px-2 py-1 italic">No named speakers yet</p>
  {/if}
</div>

<!-- Unnamed speakers -->
{#if unnamed.length > 0}
  <div>
    <div class="px-2 py-1 mb-1">
      <span class="text-xs font-ui font-medium text-on-surface-muted uppercase">Unnamed ({unnamed.length})</span>
    </div>

    {#each unnamed as row}
      {@const isSelected = selectedSpeakers.has(row.id)}
      <div
        class="group flex items-center gap-2 px-2 py-1.5 rounded text-sm cursor-pointer transition-colors select-none
          {isSelected ? 'bg-primary-container/30 ring-1 ring-primary/30' : 'hover:bg-surface-alt'}
          {row.allIrrelevant ? 'opacity-50' : ''}"
        role="button"
        tabindex="0"
        onclick={(e) => { if (assigningId !== row.id) onselect(row.id, e); }}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onselect(row.id); } }}
      >
        <span class="w-3 h-3 rounded-full flex-none" style="background-color: {speakerColour(row.id)}"></span>
        <span class="flex-1 text-sm font-ui text-on-surface-muted truncate">{row.id}</span>

        <!-- Assign to named speaker -->
        <div class="relative">
          <button
            onclick={(e) => { e.stopPropagation(); assigningId = assigningId === row.id ? null : row.id; }}
            class="text-xs font-ui text-primary cursor-pointer hover:underline opacity-0 group-hover:opacity-100 transition-opacity"
            title="Assign to a named speaker"
          >
            Assign
          </button>
          {#if assigningId === row.id}
            <div class="absolute right-0 top-full mt-1 z-20 bg-surface-raised border border-border rounded shadow-lg py-1 min-w-40 max-h-48 overflow-auto">
              {#each namedSpeakers as name}
                <button
                  onclick={(e) => { e.stopPropagation(); assignSpeaker(row.id, name); }}
                  class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface"
                >
                  <span class="inline-block w-2 h-2 rounded-full mr-2 align-middle" style="background-color: {speakerColour(name)}"></span>
                  {name}
                </button>
              {/each}
              {#each named.filter((n) => !namedSpeakers.includes(n.id)) as namedRow}
                <button
                  onclick={(e) => { e.stopPropagation(); assignSpeaker(row.id, namedRow.id); }}
                  class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface"
                >
                  <span class="inline-block w-2 h-2 rounded-full mr-2 align-middle" style="background-color: {speakerColour(namedRow.id)}"></span>
                  {namedRow.id}
                </button>
              {/each}
              {#if namedSpeakers.length === 0 && named.length === 0}
                <p class="text-xs text-on-surface-muted px-3 py-1.5 italic">Add named speakers first</p>
              {/if}
            </div>
          {/if}
        </div>

        <span class="text-xs text-on-surface-muted flex-none font-mono tabular-nums">{row.total}</span>
        <button
          onclick={(e) => { e.stopPropagation(); ontoggleirrelevant(row.id); }}
          class="cursor-pointer p-0.5 flex-none transition-colors
            {row.allIrrelevant ? 'text-on-surface-muted hover:text-success' : 'text-on-surface-muted/40 hover:text-error'}"
          title={row.allIrrelevant ? 'Mark relevant' : 'Mark irrelevant'}
        >
          {#if row.allIrrelevant}
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          {:else}
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
            </svg>
          {/if}
        </button>
      </div>
    {/each}
  </div>
{/if}
