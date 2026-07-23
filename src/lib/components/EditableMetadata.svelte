<script lang="ts">
  let {
    title,
    publisher,
    creators,
    canEdit = false,
    onsave,
  }: {
    title: string;
    publisher: string;
    creators: string[];
    canEdit?: boolean;
    /** Persist all fields in one edit. "" / [] clear the respective key -
     *  except title, which never clears: a record must stay findable in the
     *  list, so an emptied title keeps the current one. */
    onsave: (data: { title: string; publisher: string; creators: string[] }) => void;
  } = $props();

  let editing = $state(false);
  let draftTitle = $state("");
  let draftPublisher = $state("");
  let draftCreators = $state<string[]>([]);

  function startEdit() {
    draftTitle = title;
    draftPublisher = publisher;
    draftCreators = creators.length > 0 ? [...creators] : [""];
    editing = true;
  }

  function cancel() {
    editing = false;
  }

  function save() {
    onsave({
      title: draftTitle.trim() || title,
      publisher: draftPublisher,
      creators: draftCreators.map((c) => c.trim()).filter((c) => c !== ""),
    });
    editing = false;
  }

  function addCreator() {
    draftCreators = [...draftCreators, ""];
  }

  function removeCreator(i: number) {
    draftCreators = draftCreators.filter((_, idx) => idx !== i);
    if (draftCreators.length === 0) draftCreators = [""];
  }

  // Move the publisher value into creators - the common reclassification
  // (a person mislabelled as publisher, e.g. Lex Fridman).
  function publisherToCreator() {
    const p = draftPublisher.trim();
    if (!p) return;
    const slots = draftCreators.filter((c) => c.trim() !== "");
    draftCreators = [...slots, p];
    draftPublisher = "";
  }
</script>

<div class="text-xs font-ui">
  {#if !editing}
    <div class="flex flex-col gap-1">
      <div class="flex items-baseline gap-2">
        <span class="text-on-surface-muted w-32 flex-none">Title</span>
        <span class="text-on-surface">{title}</span>
      </div>
      <div class="flex items-baseline gap-2">
        <span class="text-on-surface-muted w-32 flex-none">Publisher</span>
        <span class="text-on-surface">{publisher || "—"}</span>
      </div>
      <div class="flex items-baseline gap-2">
        <span class="text-on-surface-muted w-32 flex-none">Authors / Creators</span>
        <span class="text-on-surface">{creators.length > 0 ? creators.join(", ") : "—"}</span>
      </div>
      {#if canEdit}
        <div>
          <button
            onclick={startEdit}
            class="mt-1 text-primary hover:underline cursor-pointer font-medium"
          >
            Edit
          </button>
        </div>
      {/if}
    </div>
  {:else}
    <div class="flex flex-col gap-3 max-w-md">
      <label class="flex flex-col gap-1">
        <span class="text-on-surface-muted">Title</span>
        <input
          type="text"
          bind:value={draftTitle}
          placeholder="What this record actually is"
          class="bg-surface border border-border rounded px-2 py-1 text-on-surface
            outline-none focus:border-primary placeholder:text-on-surface-muted/50"
        />
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-on-surface-muted">Publisher</span>
        <div class="flex items-center gap-2">
          <input
            type="text"
            bind:value={draftPublisher}
            placeholder="e.g. The Debrief"
            class="flex-1 bg-surface border border-border rounded px-2 py-1 text-on-surface
              outline-none focus:border-primary placeholder:text-on-surface-muted/50"
          />
          <button
            onclick={publisherToCreator}
            disabled={!draftPublisher.trim()}
            class="flex-none px-2 py-1 rounded font-medium whitespace-nowrap
              {draftPublisher.trim()
                ? 'text-primary hover:bg-surface cursor-pointer'
                : 'text-on-surface-muted/40 cursor-default'}"
            title="Move this value into Authors / Creators (it's a person, not a publisher)"
          >
            Move to creators
          </button>
        </div>
      </label>

      <div class="flex flex-col gap-1">
        <span class="text-on-surface-muted">Authors / Creators</span>
        {#each draftCreators as _, i}
          <div class="flex items-center gap-2">
            <input
              type="text"
              bind:value={draftCreators[i]}
              placeholder="e.g. Ramsey, Chris"
              class="flex-1 bg-surface border border-border rounded px-2 py-1 text-on-surface
                outline-none focus:border-primary placeholder:text-on-surface-muted/50"
            />
            <button
              onclick={() => removeCreator(i)}
              class="flex-none p-1 rounded text-on-surface-muted/60 hover:text-on-surface hover:bg-surface cursor-pointer"
              title="Remove"
              aria-label="Remove creator"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        {/each}
        <div>
          <button onclick={addCreator} class="text-primary hover:underline cursor-pointer font-medium">
            + Add creator
          </button>
        </div>
      </div>

      <div class="flex items-center gap-3">
        <button
          onclick={save}
          class="px-3 py-1 rounded bg-primary text-on-primary font-medium hover:bg-primary-hover cursor-pointer"
        >
          Save
        </button>
        <button onclick={cancel} class="text-on-surface-muted hover:text-on-surface cursor-pointer">
          Cancel
        </button>
        <span class="text-on-surface-muted/70">
          Saved into the record; commits when you submit the review.
        </span>
      </div>
    </div>
  {/if}
</div>
