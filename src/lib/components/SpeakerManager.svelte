<script lang="ts">
  import type { Segment } from "$lib/transcript";
  import { isDefaultSpeakerName, isSpecialSpeaker, SPEAKER_IRRELEVANT, SPEAKER_NARRATOR, SPEAKER_EXTERNAL_FOOTAGE } from "$lib/transcript";
  import SpeakerDot from "./SpeakerDot.svelte";

  let {
    segments,
    namedSpeakers,
    selectedSpeakers,
    filteredSpeakers,
    onselect,
    onfilter,
    onsetfilter,
    onrename,
    onmerge,
    onaddnamed,
    onremovenamed,
    onrenamenamed,
  }: {
    segments: Segment[];
    namedSpeakers: string[];
    selectedSpeakers: Set<string>;
    filteredSpeakers: Set<string>;
    onselect: (id: string, e?: MouseEvent) => void;
    onfilter: (id: string) => void;
    onsetfilter: (ids: string[]) => void;
    onrename: (id: string, name: string) => void;
    onmerge: (sourceIds: string[], targetName: string) => void;
    onaddnamed: (name: string) => void;
    onremovenamed: (name: string) => void;
    onrenamenamed: (oldName: string, newName: string) => void;
  } = $props();

  interface SpeakerRow {
    id: string;
    total: number;
  }

  // Build speaker rows from segments, sorted by first appearance
  let speakerRows = $derived((): SpeakerRow[] => {
    const firstSeen = new Map<string, number>();
    const totals = new Map<string, number>();
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!seg.speaker) continue;
      if (!firstSeen.has(seg.speaker)) firstSeen.set(seg.speaker, i);
      totals.set(seg.speaker, (totals.get(seg.speaker) ?? 0) + 1);
    }
    return [...firstSeen.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => ({
        id,
        total: totals.get(id) ?? 0,
      }));
  });

  // Split into named, unnamed, and special
  let named = $derived(
    speakerRows().filter((r) => (!isDefaultSpeakerName(r.id) && !isSpecialSpeaker(r.id)) || namedSpeakers.includes(r.id)),
  );
  let unnamed = $derived(
    speakerRows().filter((r) => isDefaultSpeakerName(r.id) && !namedSpeakers.includes(r.id)),
  );
  let special = $derived(
    speakerRows().filter((r) => isSpecialSpeaker(r.id)),
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

  // All named-speaker IDs currently present in segments (excludes unassigned).
  let namedIds = $derived(named.map((r) => r.id));
  let unnamedIds = $derived(unnamed.map((r) => r.id));

  // Is the transcript currently filtered to only this section's speakers?
  function sectionFilterActive(ids: string[]): boolean {
    if (ids.length === 0 || filteredSpeakers.size !== ids.length) return false;
    for (const id of ids) if (!filteredSpeakers.has(id)) return false;
    return true;
  }

  let namedFilterActive = $derived(sectionFilterActive(namedIds));
  let unnamedFilterActive = $derived(sectionFilterActive(unnamedIds));

  function toggleSectionFilter(ids: string[], active: boolean) {
    if (active) onsetfilter([]);
    else onsetfilter(ids);
  }
</script>

<!-- Named speakers -->
<div class="mb-3">
  <div class="flex items-center gap-2 px-2 py-1 mb-1">
    <span class="text-xs font-ui font-medium text-on-surface-secondary uppercase flex-1">
      Named{#if named.length + unassignedNamed.length > 0} ({named.length + unassignedNamed.length}){/if}
    </span>
    {#if namedIds.length > 0}
      <button
        onclick={() => toggleSectionFilter(namedIds, namedFilterActive)}
        class="p-0.5 rounded cursor-pointer transition-colors
          {namedFilterActive
            ? 'bg-primary/20 text-primary'
            : 'text-on-surface-muted/50 hover:text-on-surface hover:bg-surface'}"
        title={namedFilterActive ? 'Clear filter' : 'Show only named speakers'}
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
    {/if}
  </div>

  {#each named as row}
    {@const isSelected = selectedSpeakers.has(row.id)}
    <div
      class="group flex items-center gap-2 px-2 py-1.5 rounded text-sm cursor-pointer transition-colors select-none
        {isSelected ? 'bg-primary-container/30 ring-1 ring-primary/30' : 'hover:bg-surface-alt'}"
      role="button"
      tabindex="0"
      onclick={(e) => { if (editingId !== row.id) onselect(row.id, e); }}
      onkeydown={(e) => { if (editingId !== row.id && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onselect(row.id); } }}
    >
      <button
        onclick={(e) => { e.stopPropagation(); onfilter(row.id); }}
        class="flex-none cursor-pointer"
        title="Click to filter the transcript to this speaker"
      >
        <SpeakerDot speaker={row.id} size="md" ring={filteredSpeakers.has(row.id)} />
      </button>
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
        <span class="flex-1 min-w-0 text-sm font-ui text-on-surface truncate">{row.id}</span>
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
      <button
        onclick={(e) => { e.stopPropagation(); onfilter(row.id); }}
        class="text-xs font-mono tabular-nums flex-none px-1.5 py-0.5 rounded cursor-pointer transition-colors
          {filteredSpeakers.has(row.id)
            ? 'bg-primary/20 text-primary'
            : 'text-on-surface-muted hover:bg-surface hover:text-on-surface'}"
        title="Click to filter the transcript to this speaker"
      >{row.total}</button>
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
      <SpeakerDot speaker={name} size="md" />
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
      <span class="text-xs font-mono tabular-nums flex-none px-1.5 py-0.5 text-on-surface-muted/50">0</span>
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

  <!-- Add new named speaker -->
  {#if showNewInput}
    <form class="flex items-center gap-2 px-2 py-1 mt-1" onsubmit={(e) => { e.preventDefault(); addSpeaker(); }}>
      <input
        type="text"
        bind:value={newSpeakerName}
        placeholder="Speaker name"
        class="flex-1 text-sm font-ui bg-surface border border-border rounded px-2 py-1
          text-on-surface outline-none focus:border-primary placeholder:text-on-surface-muted/50"
        onkeydown={(e) => { if (e.key === 'Escape') { showNewInput = false; newSpeakerName = ''; } }}
      />
      <button type="submit" class="text-xs font-ui font-medium px-2 py-1 bg-primary text-on-primary rounded cursor-pointer hover:bg-primary-hover">
        Add
      </button>
    </form>
  {:else}
    <button
      onclick={() => { showNewInput = true; }}
      class="text-xs font-ui text-primary cursor-pointer hover:underline px-2 py-1 mt-0.5"
    >
      + Add new speaker
    </button>
  {/if}
</div>

<!-- Special speakers -->
{#if special.length > 0}
  <div class="mt-3 mb-3">
    <div class="px-2 py-1 mb-1">
      <span class="text-xs font-ui font-medium text-on-surface-muted uppercase">Special ({special.length})</span>
    </div>

    {#each special as row}
      {@const isSelected = selectedSpeakers.has(row.id)}
      <div
        class="group flex items-center gap-2 px-2 py-1.5 rounded text-sm cursor-pointer transition-colors select-none
          {isSelected ? 'bg-primary-container/30 ring-1 ring-primary/30' : 'hover:bg-surface-alt'}"
        role="button"
        tabindex="0"
        onclick={(e) => onselect(row.id, e)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onselect(row.id); } }}
      >
        <button
          onclick={(e) => { e.stopPropagation(); onfilter(row.id); }}
          class="flex-none cursor-pointer"
          title="Click to filter the transcript to this speaker"
        >
          <SpeakerDot speaker={row.id} size="md" ring={filteredSpeakers.has(row.id)} />
        </button>
        <span class="flex-1 text-sm font-ui text-on-surface-muted truncate italic">{row.id}</span>
        <button
          onclick={(e) => { e.stopPropagation(); onfilter(row.id); }}
          class="text-xs font-mono tabular-nums flex-none px-1.5 py-0.5 rounded cursor-pointer transition-colors
            {filteredSpeakers.has(row.id)
              ? 'bg-primary/20 text-primary'
              : 'text-on-surface-muted hover:bg-surface hover:text-on-surface'}"
          title="Click to filter the transcript to this speaker"
        >{row.total}</button>
      </div>
    {/each}
  </div>
{/if}

<!-- Unnamed speakers -->
{#if unnamed.length > 0}
  <div>
    <div class="flex items-center gap-2 px-2 py-1 mb-1">
      <span class="text-xs font-ui font-medium text-on-surface-muted uppercase flex-1">Unnamed ({unnamed.length})</span>
      <button
        onclick={() => toggleSectionFilter(unnamedIds, unnamedFilterActive)}
        class="p-0.5 rounded cursor-pointer transition-colors
          {unnamedFilterActive
            ? 'bg-primary/20 text-primary'
            : 'text-on-surface-muted/50 hover:text-on-surface hover:bg-surface'}"
        title={unnamedFilterActive ? 'Clear filter' : 'Show only unnamed speakers'}
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
    </div>

    {#each unnamed as row}
      {@const isSelected = selectedSpeakers.has(row.id)}
      <div
        class="group flex items-center gap-2 px-2 py-1.5 rounded text-sm cursor-pointer transition-colors select-none
          {isSelected ? 'bg-primary-container/30 ring-1 ring-primary/30' : 'hover:bg-surface-alt'}"
        role="button"
        tabindex="0"
        onclick={(e) => { if (assigningId !== row.id) onselect(row.id, e); }}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onselect(row.id); } }}
      >
        <button
          onclick={(e) => { e.stopPropagation(); onfilter(row.id); }}
          class="flex-none cursor-pointer"
          title="Click to filter the transcript to this speaker"
        >
          <SpeakerDot speaker={row.id} size="md" ring={filteredSpeakers.has(row.id)} />
        </button>
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
                  <SpeakerDot speaker={name} inline />
                  {name}
                </button>
              {/each}
              {#each named.filter((n) => !namedSpeakers.includes(n.id)) as namedRow}
                <button
                  onclick={(e) => { e.stopPropagation(); assignSpeaker(row.id, namedRow.id); }}
                  class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface"
                >
                  <SpeakerDot speaker={namedRow.id} inline />
                  {namedRow.id}
                </button>
              {/each}
              <div class="border-t border-border mt-1 pt-1">
                {#each [SPEAKER_IRRELEVANT, SPEAKER_NARRATOR, SPEAKER_EXTERNAL_FOOTAGE] as specialName}
                  <button
                    onclick={(e) => { e.stopPropagation(); assignSpeaker(row.id, specialName); }}
                    class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface-muted italic"
                  >
                    <SpeakerDot speaker={specialName} inline />
                    {specialName}
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </div>

        <button
          onclick={(e) => { e.stopPropagation(); onfilter(row.id); }}
          class="text-xs font-mono tabular-nums flex-none px-1.5 py-0.5 rounded cursor-pointer transition-colors
            {filteredSpeakers.has(row.id)
              ? 'bg-primary/20 text-primary'
              : 'text-on-surface-muted hover:bg-surface hover:text-on-surface'}"
          title="Click to filter the transcript to this speaker"
        >{row.total}</button>
      </div>
    {/each}
  </div>
{/if}

