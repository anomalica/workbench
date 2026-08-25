<script lang="ts">
  import type { Segment } from "$lib/transcript";
  import { anonymousLabel, asAnonymousSpeaker, assignableSpecialSpeakers, isAnonymousSpeaker, isDefaultSpeakerName, isSpecialSpeaker, SPEAKER_IRRELEVANT, SPEAKER_NARRATOR, SPEAKER_EXTERNAL_FOOTAGE, SPEAKER_GROUP } from "$lib/transcript";
  import SpeakerDot from "./SpeakerDot.svelte";
  import { fetchSpeakers } from "$lib/api";
  import { type KnownSpeaker, suggestSpeakers } from "$lib/speaker-suggest";
  import { nearMiss } from "$lib/near-miss";

  let {
    segments,
    rows = null,
    externalRows = [],
    onexternalgo,
    externalOnly = false,
    onexternalonly,
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
    /** Pre-computed speaker rows (id + count) in first-appearance order. When
     *  given (per-word records, where total is a WORD count) it replaces the
     *  segment-derived rows; null falls back to counting segments (v1). */
    rows?: { id: string; total: number }[] | null;
    /** Speakers who appear ONLY inside quoted passages, with their word counts.
     *  Listed apart: they are voices in somebody else's recording, so they are
     *  not this record's participants and not the reviewer's unnamed backlog -
     *  but hiding them entirely loses the fact that the clips are there. */
    externalRows?: { id: string; total: number }[];
    /** Go to a quoted voice's first passage. Filtering to them is the wrong
     *  verb: there is one thing to look at, and the reviewer wants to be taken
     *  to it. */
    onexternalgo?: (speaker: string) => void;
    /** Whether the transcript is showing quoted passages only. */
    externalOnly?: boolean;
    onexternalonly?: (on: boolean) => void;
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

  // Speaker rows: pre-computed when given (word records), else built from
  // segments, sorted by first appearance.
  let speakerRows = $derived((): SpeakerRow[] => {
    if (rows) return rows;
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

  // Split into named, unnamed, and special.
  //
  // Named means we know WHO it is. A bracketed name is a description of
  // somebody whose name is unknown - `[interviewer 2]`, `[audience member]` -
  // so it belongs with the unnamed however carefully it was written. Listing
  // it as named is what invites the rest of the pipeline to treat
  // "interviewer 2" as a person and follow them between records.
  let anonymous = $derived((id: string) => isAnonymousSpeaker(id) && !isSpecialSpeaker(id));
  let named = $derived(
    speakerRows().filter(
      (r) =>
        (!isDefaultSpeakerName(r.id) && !isSpecialSpeaker(r.id) && !anonymous(r.id)) ||
        (namedSpeakers.includes(r.id) && !anonymous(r.id)),
    ),
  );
  let unnamed = $derived(
    speakerRows().filter((r) => anonymous(r.id) || (isDefaultSpeakerName(r.id) && !namedSpeakers.includes(r.id))),
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

  /** Names the corpus already uses. Fetched once, when the reviewer first opens
   *  the input - there is no point paying for it on every record load when
   *  most sessions never name anyone. */
  let known = $state<KnownSpeaker[]>([]);
  let knownLoaded = false;
  function loadKnown() {
    if (knownLoaded) return;
    knownLoaded = true;
    fetchSpeakers()
      .then((s) => (known = s))
      // A suggestion list is a convenience; failing to get one must never
      // stand between the reviewer and naming a speaker.
      .catch(() => {});
  }

  // Fetched when the sidebar mounts, not when the input opens. Opening it and
  // typing immediately beat the request, so the near-miss check ran against an
  // empty list and accepted a misspelling in silence - which is the one thing
  // it exists to stop.
  $effect(() => {
    loadKnown();
  });

  /** Whether the speaker being added is described rather than named. Held as a
   *  flag rather than typed brackets: the reviewer is filling an empty box, and
   *  wrapping it as they toggle would put the cursor outside the brackets they
   *  are meant to type inside. The brackets are shown either side of the box
   *  instead, so what will be written is still visible. */
  let newAnonymous = $state(false);

  function toggleNewAnonymous() {
    newAnonymous = !newAnonymous;
  }

  let suggestions = $derived(
    newAnonymous || isAnonymousSpeaker(newSpeakerName)
      ? []
      : suggestSpeakers(known, newSpeakerName, namedSpeakers),
  );



  function takeSuggestion(name: string) {
    newSpeakerName = name;
    addSpeaker();
  }

  /** A name that is one slip from an existing one, held for confirmation. It
   *  SUGGESTS: people with similar names exist, and rewriting silently is how
   *  one person's words end up filed under another. */
  let pendingNear = $state<{ typed: string; existing: string } | null>(null);

  function addSpeaker() {
    const name = newSpeakerName.trim();
    if (name && !pendingNear && !newAnonymous && !isAnonymousSpeaker(name)) {
      const near = nearMiss(name, [...known.map((k) => k.name), ...namedSpeakers]);
      if (near) {
        pendingNear = { typed: name, existing: near };
        return;
      }
    }
    const written = newAnonymous ? asAnonymousSpeaker(name) : name;
    if (written && !namedSpeakers.includes(written)) {
      onaddnamed(written);
      newSpeakerName = "";
      newAnonymous = false;
      showNewInput = false;
      pendingNear = null;
    }
  }

  // Editing
  let editingId = $state<string | null>(null);
  let editingValue = $state("");

  /** Renaming a diarisation id to a person is where a name is usually first
   *  written, so the same list has to appear there. */
  let editSuggestions = $derived(
    isAnonymousSpeaker(editingValue)
      ? []
      : suggestSpeakers(
          known,
          editingValue,
          namedSpeakers.filter((n) => n !== editingId),
        ),
  );

  function takeEditSuggestion(name: string) {
    editingValue = name;
    commitEdit();
  }

  let editInputEl: HTMLInputElement | undefined = $state();

  function startEdit(id: string) {
    editingId = id;
    editingValue = id;
    loadKnown();
    setTimeout(() => editInputEl?.focus(), 0);
  }

  /** Whether the name being typed is a description rather than a name.
   *
   *  Toggling it rewrites the value in place, so the reviewer sees exactly what
   *  will be written - the brackets are the record's own notation, not a flag
   *  stored somewhere else. */
  let editAnonymous = $derived(isAnonymousSpeaker(editingValue));

  function toggleEditAnonymous() {
    editingValue = editAnonymous ? anonymousLabel(editingValue) : asAnonymousSpeaker(editingValue);
    editInputEl?.focus();
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

  // Merge a named speaker into another speaker (all their turns become it).
  let mergingId = $state<string | null>(null);

  function mergeInto(sourceId: string, targetId: string) {
    if (sourceId !== targetId) onmerge([sourceId], targetId);
    mergingId = null;
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
  let externalIds = $derived(externalRows.map((r) => r.id));
  let externalFilterActive = $derived(sectionFilterActive(externalIds));

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
    {@const isSelected = filteredSpeakers.has(row.id)}
    <div
      class="group flex items-center gap-2 px-2 py-1.5 rounded text-sm cursor-pointer transition-colors select-none
        {isSelected ? 'bg-primary-container/30 ring-1 ring-primary/30' : 'hover:bg-surface-alt'}"
      role="button"
      tabindex="0"
      onclick={(e) => { if (editingId !== row.id && mergingId !== row.id) onfilter(row.id); }}
      onkeydown={(e) => { if (editingId !== row.id && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onfilter(row.id); } }}
    >
      <button
        onclick={(e) => { e.stopPropagation(); onfilter(row.id); }}
        class="flex-none cursor-pointer"
        title="Click to filter to this speaker; click others to add them (several at once)"
      >
        <SpeakerDot speaker={row.id} size="md" ring={filteredSpeakers.has(row.id)} />
      </button>
      {#if editingId === row.id}
        <div class="relative flex-1 min-w-0 flex items-center gap-1.5">
          <input
            bind:this={editInputEl}
            type="text"
            bind:value={editingValue}
            onblur={commitEdit}
            onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitEdit(); } else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); } }}
            onclick={(e) => e.stopPropagation()}
            class="flex-1 min-w-0 bg-surface text-sm font-ui text-on-surface outline-none px-1 py-0.5 rounded border border-primary"
          />
          {@render anonymousToggle(editAnonymous, toggleEditAnonymous)}
          {@render nameSuggestions(editSuggestions, takeEditSuggestion)}
        </div>
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

        <!-- Merge this speaker into another -->
        {#if speakerRows().length > 1}
          <div class="relative">
            <button
              onclick={(e) => { e.stopPropagation(); mergingId = mergingId === row.id ? null : row.id; }}
              class="text-xs font-ui text-on-surface-muted hover:text-primary cursor-pointer flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
              title="Merge this speaker into another (their turns become the one you pick)"
            >
              Merge
              <svg class="w-3 h-3" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {#if mergingId === row.id}
              <div class="absolute right-0 top-full mt-1 z-20 bg-surface-raised border border-border rounded shadow-lg py-1 min-w-40 max-h-48 overflow-auto">
                {#each named.filter((n) => n.id !== row.id) as t}
                  <button
                    onclick={(e) => { e.stopPropagation(); mergeInto(row.id, t.id); }}
                    class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface"
                  >
                    <SpeakerDot speaker={t.id} inline />
                    {t.id}
                  </button>
                {/each}
                {#each unnamed as t}
                  <button
                    onclick={(e) => { e.stopPropagation(); mergeInto(row.id, t.id); }}
                    class="block w-full text-left px-3 py-1.5 text-sm font-ui cursor-pointer hover:bg-primary-container/30 text-on-surface-muted"
                  >
                    <SpeakerDot speaker={t.id} inline />
                    {t.id}
                  </button>
                {/each}
                <div class="border-t border-border mt-1 pt-1">
                  {#each assignableSpecialSpeakers() as specialName}
                    <button
                      onclick={(e) => { e.stopPropagation(); mergeInto(row.id, specialName); }}
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
        {/if}
      {/if}
      <button
        onclick={(e) => { e.stopPropagation(); onfilter(row.id); }}
        class="text-xs font-mono tabular-nums flex-none px-1.5 py-0.5 rounded cursor-pointer transition-colors
          {filteredSpeakers.has(row.id)
            ? 'bg-primary/20 text-primary'
            : 'text-on-surface-muted hover:bg-surface hover:text-on-surface'}"
        title="Click to filter to this speaker; click others to add them (several at once)"
      >{row.total}</button>
    </div>
  {/each}

  <!-- Named speakers not yet assigned to any segments -->
  {#each unassignedNamed as name}
    <div class="group flex items-center gap-2 px-2 py-1.5 rounded text-sm cursor-pointer transition-colors select-none hover:bg-surface-alt"
      role="button"
      tabindex="0"
      onclick={() => onfilter(name)}
      onkeydown={(e) => { if (editingId !== name && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onfilter(name); } }}
    >
      <SpeakerDot speaker={name} size="md" />
      {#if editingId === name}
        <div class="relative flex-1 min-w-0">
          <input
            bind:this={editInputEl}
            type="text"
            bind:value={editingValue}
            onblur={commitEdit}
            onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitEdit(); } else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); } }}
            onclick={(e) => e.stopPropagation()}
            class="w-full bg-surface text-sm font-ui text-on-surface outline-none px-1 py-0.5 rounded border border-primary"
          />
          {@render nameSuggestions(editSuggestions, takeEditSuggestion)}
        </div>
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
    <form class="px-2 py-1 mt-1" onsubmit={(e) => { e.preventDefault(); addSpeaker(); }}>
      <div class="flex items-center gap-2">
      {#if newAnonymous}
        <span class="flex-none font-ui text-sm text-primary select-none">[</span>
      {/if}
      <input
        type="text"
        bind:value={newSpeakerName}
        placeholder={newAnonymous ? "Who they were" : "Speaker name"}
        class="flex-1 min-w-0 text-sm font-ui bg-surface border border-border rounded px-2 py-1
          text-on-surface outline-none focus:border-primary placeholder:text-on-surface-muted/50"
        onkeydown={(e) => { if (e.key === 'Escape') { showNewInput = false; newSpeakerName = ''; newAnonymous = false; } }}
      />
      {#if newAnonymous}
        <span class="flex-none font-ui text-sm text-primary select-none">]</span>
      {/if}
      {@render anonymousToggle(newAnonymous, toggleNewAnonymous)}
      <button type="submit" class="text-xs font-ui font-medium px-2 py-1 bg-primary text-on-primary rounded cursor-pointer hover:bg-primary-hover">
        Add
      </button>
      </div>
      {#if pendingNear}
        <!-- Ask, never rewrite: "Ross Couthart" is a slip, but two people can
             genuinely have names a character apart. -->
        <div class="mt-1 rounded border border-warning/60 bg-warning/10 px-2 py-1.5 text-xs font-ui">
          <p class="text-on-surface mb-1.5">
            Close to <span class="font-medium">{pendingNear.existing}</span>, which the corpus
            already uses. Same person?
          </p>
          <div class="flex items-center gap-3">
            <button
              onclick={() => { newSpeakerName = pendingNear!.existing; pendingNear = null; addSpeaker(); }}
              class="font-medium text-primary cursor-pointer hover:underline"
            >Use {pendingNear.existing}</button>
            <button
              onclick={() => { const t = pendingNear!.typed; pendingNear = null; newSpeakerName = t; addSpeaker(); }}
              class="text-on-surface-muted cursor-pointer hover:text-on-surface"
            >Keep {pendingNear.typed}</button>
          </div>
        </div>
      {:else if suggestions.length > 0}
        <!-- Names already in the corpus. The point is the SPELLING: the same
             person gets written two ways across records and nothing downstream
             can tell them apart afterwards, so the existing form is shown
             while the next one is being typed. -->
        <ul class="mt-1 border border-border rounded bg-surface overflow-hidden">
          {#each suggestions as s (s.name)}
            <li>
              <button
                type="button"
                onclick={() => takeSuggestion(s.name)}
                class="w-full text-left px-2 py-1 text-xs font-ui cursor-pointer flex items-baseline gap-2 hover:bg-primary-container/30"
                title="Use this spelling - already in {s.ingests} ingest{s.ingests === 1 ? '' : 's'}"
              >
                <span class="text-on-surface flex-1 truncate">{s.name}</span>
                <span class="text-[10px] tabular-nums text-on-surface-muted flex-none">{s.ingests}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </form>
  {:else}
    <button
      onclick={() => { showNewInput = true; loadKnown(); }}
      class="text-xs font-ui text-primary cursor-pointer hover:underline px-2 py-1 mt-0.5"
    >
      + Add new speaker
    </button>
  {/if}
</div>

{#snippet anonymousToggle(on: boolean, toggle: () => void)}
  <!-- Held down rather than clicked: the input commits on blur, and a click
       blurs it first, so the toggle would land after the name was already
       written. -->
  <button
    onpointerdown={(e) => { e.preventDefault(); e.stopPropagation(); toggle(); }}
    onclick={(e) => e.stopPropagation()}
    class="flex-none px-1.5 py-0.5 rounded text-xs font-ui font-medium border transition-colors cursor-pointer
      {on
        ? 'bg-primary/15 border-primary/40 text-primary'
        : 'border-border text-on-surface-muted hover:text-on-surface hover:border-on-surface-muted'}"
    title={on
      ? "This is a description, not a name - nothing will treat it as a person. Click to make it a real name."
      : "Mark as a description: use when the real name is unknown ([interviewer 2], [audience member])"}
  >
    [&nbsp;]
  </button>
{/snippet}

{#snippet nameSuggestions(items: KnownSpeaker[], take: (name: string) => void)}
  {#if items.length > 0}
    <ul class="absolute left-0 right-0 top-full z-20 mt-0.5 border border-border rounded bg-surface shadow-lg overflow-hidden">
      {#each items as s (s.name)}
        <li>
          <button
            type="button"
            onmousedown={(e) => e.preventDefault()}
            onclick={() => take(s.name)}
            class="w-full text-left px-2 py-1 text-xs font-ui cursor-pointer flex items-baseline gap-2 hover:bg-primary-container/30"
            title="Use this spelling - already in {s.ingests} ingest{s.ingests === 1 ? '' : 's'}"
          >
            <span class="text-on-surface flex-1 truncate">{s.name}</span>
            <span class="text-[10px] tabular-nums text-on-surface-muted flex-none">{s.ingests}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}



<!-- Special speakers -->
{#if special.length > 0}
  <div class="mt-3 mb-3">
    <div class="px-2 py-1 mb-1">
      <span class="text-xs font-ui font-medium text-on-surface-muted uppercase">Special ({special.length})</span>
    </div>

    {#each special as row}
      {@const isSelected = filteredSpeakers.has(row.id)}
      <div
        class="group flex items-center gap-2 px-2 py-1.5 rounded text-sm cursor-pointer transition-colors select-none
          {isSelected ? 'bg-primary-container/30 ring-1 ring-primary/30' : 'hover:bg-surface-alt'}"
        role="button"
        tabindex="0"
        onclick={(e) => onfilter(row.id)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onfilter(row.id); } }}
      >
        <button
          onclick={(e) => { e.stopPropagation(); onfilter(row.id); }}
          class="flex-none cursor-pointer"
          title="Click to filter to this speaker; click others to add them (several at once)"
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
          title="Click to filter to this speaker; click others to add them (several at once)"
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
      {@const isSelected = filteredSpeakers.has(row.id)}
      <div
        class="group flex items-center gap-2 px-2 py-1.5 rounded text-sm cursor-pointer transition-colors select-none
          {isSelected ? 'bg-primary-container/30 ring-1 ring-primary/30' : 'hover:bg-surface-alt'}"
        role="button"
        tabindex="0"
        onclick={(e) => { if (assigningId !== row.id && editingId !== row.id) onfilter(row.id); }}
        onkeydown={(e) => { if (editingId !== row.id && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onfilter(row.id); } }}
      >
        <button
          onclick={(e) => { e.stopPropagation(); onfilter(row.id); }}
          class="flex-none cursor-pointer"
          title="Click to filter to this speaker; click others to add them (several at once)"
        >
          <SpeakerDot speaker={row.id} size="md" ring={filteredSpeakers.has(row.id)} />
        </button>
        {#if editingId === row.id}
          <div class="relative flex-1 min-w-0 flex items-center gap-1.5">
            <input
              bind:this={editInputEl}
              type="text"
              bind:value={editingValue}
              onblur={commitEdit}
              onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitEdit(); } else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); } }}
              onclick={(e) => e.stopPropagation()}
              class="flex-1 min-w-0 bg-surface text-sm font-ui text-on-surface outline-none px-1 py-0.5 rounded border border-primary"
            />
            {@render anonymousToggle(editAnonymous, toggleEditAnonymous)}
            {@render nameSuggestions(editSuggestions, takeEditSuggestion)}
          </div>
        {:else}
          <span class="flex-1 min-w-0 text-sm font-ui text-on-surface-muted truncate">{row.id}</span>
          <button
            onclick={(e) => { e.stopPropagation(); startEdit(row.id); }}
            class="opacity-0 group-hover:opacity-100 cursor-pointer p-0.5 text-on-surface-muted hover:text-primary transition-opacity"
            title="Rename this speaker everywhere"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
        {/if}


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
                {#each assignableSpecialSpeakers() as specialName}
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
          title="Click to filter to this speaker; click others to add them (several at once)"
        >{row.total}</button>
      </div>
    {/each}
  </div>
{/if}

{#if externalRows.length > 0}
  <div class="mt-3">
    <div class="flex items-center gap-2 px-2 py-1 mb-1">
      <span class="text-xs font-ui font-medium text-on-surface-muted uppercase flex-1"
        >External ({externalRows.length})</span
      >
      <button
        onclick={() => onexternalonly?.(!externalOnly)}
        class="p-0.5 rounded cursor-pointer transition-colors
          {externalOnly
            ? 'bg-primary/20 text-primary'
            : 'text-on-surface-muted/50 hover:text-on-surface hover:bg-surface'}"
        title={externalOnly ? "Show the whole transcript" : "Show quoted passages only"}
      >
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
    </div>
    {#each externalRows as row}
      {@const isSelected = filteredSpeakers.has(row.id)}
      <div
        class="group flex items-center gap-2 px-2 py-1.5 rounded text-sm cursor-pointer transition-colors select-none
          {isSelected
            ? 'bg-primary-container/30 ring-1 ring-primary/30 text-on-surface'
            : 'text-on-surface-muted/70 hover:bg-surface-alt'}"
        role="button"
        tabindex="0"
        onclick={() => { if (editingId !== row.id) onexternalgo?.(row.id); }}
        onkeydown={(e) => { if (editingId !== row.id && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onexternalgo?.(row.id); } }}
        title="Go to this voice's first quoted passage"
      >
        <span
          class="flex-none w-2.5 h-2.5 rounded-full border border-current opacity-50"
          aria-hidden="true"
        ></span>
        {#if editingId === row.id}
          <div class="relative flex-1 min-w-0 flex items-center gap-1.5">
            <input
              bind:this={editInputEl}
              type="text"
              bind:value={editingValue}
              onblur={commitEdit}
              onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitEdit(); } else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); } }}
              onclick={(e) => e.stopPropagation()}
              class="flex-1 min-w-0 bg-surface text-sm font-ui text-on-surface outline-none px-1 py-0.5 rounded border border-primary"
            />
            {@render anonymousToggle(editAnonymous, toggleEditAnonymous)}
            {@render nameSuggestions(editSuggestions, takeEditSuggestion)}
          </div>
        {:else}
          <span class="flex-1 min-w-0 truncate">{row.id}</span>
          <button
            onclick={(e) => { e.stopPropagation(); startEdit(row.id); }}
            class="opacity-0 group-hover:opacity-100 cursor-pointer p-0.5 text-on-surface-muted hover:text-primary transition-opacity"
            title="Rename this voice everywhere"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path stroke-linecap="round" stroke-linejoin="round" d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
        {/if}
        <span class="flex-none text-[10px] font-mono tabular-nums text-on-surface-muted/50">{row.total}</span>
      </div>
    {/each}
  </div>
{/if}

