<script lang="ts">
  let {
    title,
    publisher,
    creators,
    datePublished = "",
    sourceUrl = "",
    dateAccessed = "",
    canEdit = false,
    onsave,
  }: {
    title: string;
    publisher: string;
    creators: string[];
    /** `date_published` verbatim at the precision the source evidences. */
    datePublished?: string;
    /** Where this copy came from. Often the only way back to the original for
     *  a record acquired by hand, and the ingester cannot know it for a file
     *  someone downloaded and dropped in. */
    sourceUrl?: string;
    /** `date_accessed` - when the copy above was taken. A page changes; this
     *  says which version of it the record reflects. */
    dateAccessed?: string;
    canEdit?: boolean;
    /** Persist all fields in one edit. "" / [] clear the respective key -
     *  except title, which never clears: a record must stay findable in the
     *  list, so an emptied title keeps the current one. */
    onsave: (data: {
      title: string;
      publisher: string;
      creators: string[];
      datePublished: string;
      sourceUrl: string;
      dateAccessed: string;
    }) => void;
  } = $props();

  let editing = $state(false);
  let draftTitle = $state("");
  let draftPublisher = $state("");
  let draftCreators = $state<string[]>([]);
  let draftDate = $state("");
  let draftUrl = $state("");
  let draftAccessed = $state("");

  // A YEAR, a year-month, or a full date - all three occur in the corpus,
  // because sources state what they state. A picker would force a full date and
  // turn "1947" into "1947-01-01", which invents a day the source never gave.
  const EVIDENCED_DATE_OR_OFFSET_TIMESTAMP_SHAPE =
    /^\d{4}(?:-\d{2}(?:-\d{2}(?:[T ](?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?)?)?$/;
  // Access metadata may carry only the known date or the exact retrieval
  // instant. Keep the offset: converting to a local date changes the evidence.
  // A space separator remains readable for records written by older emitters;
  // current producers use RFC 3339's `T` separator.
  const FULL_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
  const OFFSET_TIMESTAMP_SHAPE =
    /^\d{4}-\d{2}-\d{2}[T ](?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

  function isRealFullDate(value: string): boolean {
    const [year, month, day] = value.slice(0, 10).split("-").map(Number);
    if (!year || month < 1 || month > 12 || day < 1) return false;
    return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function isEvidencedDateOrTimestamp(value: string): boolean {
    if (!EVIDENCED_DATE_OR_OFFSET_TIMESTAMP_SHAPE.test(value)) return false;
    if (value.length === 4) return Number(value) > 0;
    const month = Number(value.slice(5, 7));
    if (value.length === 7) return month >= 1 && month <= 12;
    return isRealFullDate(value);
  }

  function isOffsetTimestamp(value: string): boolean {
    return OFFSET_TIMESTAMP_SHAPE.test(value) && isRealFullDate(value);
  }

  let dateProblem = $derived(
    draftDate.trim() === "" || isEvidencedDateOrTimestamp(draftDate.trim())
      ? ""
      : "Use YYYY, YYYY-MM, YYYY-MM-DD or a full time with Z / an offset",
  );
  let accessedProblem = $derived.by(() => {
    const value = draftAccessed.trim();
    if (value === "" || isOffsetTimestamp(value)) return "";
    // Existing records include date-only access values. Preserve one through an
    // unrelated metadata edit, but do not produce a new date where the field's
    // canonical value is an instant.
    if (FULL_DATE_SHAPE.test(value) && isRealFullDate(value) && value === dateAccessed.trim()) {
      return "";
    }
    return "Use a full time with Z or an offset, such as YYYY-MM-DDTHH:MM:SS+09:00";
  });
  // An address that is not one is worse than none: it reads as a way back to
  // the original and is not.
  let urlProblem = $derived.by(() => {
    const u = draftUrl.trim();
    if (u === "") return "";
    try {
      const parsed = new URL(u);
      return parsed.protocol === "http:" || parsed.protocol === "https:"
        ? ""
        : "Use an http or https address";
    } catch {
      return "Use a full address, including https://";
    }
  });

  function startEdit() {
    draftTitle = title;
    draftPublisher = publisher;
    draftCreators = creators.length > 0 ? [...creators] : [""];
    draftDate = (datePublished || "").trim();
    draftUrl = sourceUrl;
    draftAccessed = (dateAccessed || "").trim();
    editing = true;
  }

  function cancel() {
    editing = false;
  }

  function save() {
    if (dateProblem || accessedProblem || urlProblem) return;
    onsave({
      title: draftTitle.trim() || title,
      publisher: draftPublisher,
      creators: draftCreators.map((c) => c.trim()).filter((c) => c !== ""),
      datePublished: draftDate.trim(),
      sourceUrl: draftUrl.trim(),
      dateAccessed: draftAccessed.trim(),
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
      <div class="flex items-baseline gap-2">
        <span class="text-on-surface-muted w-32 flex-none">Published</span>
        <span class="text-on-surface">{datePublished || "—"}</span>
      </div>
      <div class="flex items-baseline gap-2">
        <span class="text-on-surface-muted w-32 flex-none">Downloaded from</span>
        {#if sourceUrl}
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            class="text-primary hover:underline truncate min-w-0">{sourceUrl}</a
          >
        {:else}
          <span class="text-on-surface">—</span>
        {/if}
      </div>
      {#if dateAccessed}
        <div class="flex items-baseline gap-2">
          <span class="text-on-surface-muted w-32 flex-none">Downloaded on</span>
          <span class="text-on-surface">{dateAccessed}</span>
        </div>
      {/if}
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
        <span class="text-on-surface-muted">Published</span>
        <input
          type="text"
          bind:value={draftDate}
          placeholder="1947, 1947-06, 1947-06-24 or an offset time"
          class="bg-surface border rounded px-2 py-1 text-on-surface outline-none
            placeholder:text-on-surface-muted/50
            {dateProblem ? 'border-error focus:border-error' : 'border-border focus:border-primary'}"
        />
        <span class="text-[11px] {dateProblem ? 'text-error' : 'text-on-surface-muted'}">
          {dateProblem || "Keep exactly the date or offset time evidenced by the source."}
        </span>
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-on-surface-muted">Downloaded from</span>
        <input
          type="text"
          bind:value={draftUrl}
          placeholder="https://..."
          class="bg-surface border rounded px-2 py-1 text-on-surface outline-none
            placeholder:text-on-surface-muted/50
            {urlProblem ? 'border-error focus:border-error' : 'border-border focus:border-primary'}"
        />
        <span class="text-[11px] {urlProblem ? 'text-error' : 'text-on-surface-muted'}">
          {urlProblem ||
            "Where this copy came from. For a file acquired by hand it is the only way back to the original."}
        </span>
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-on-surface-muted">Downloaded on</span>
        <input
          type="text"
          bind:value={draftAccessed}
          placeholder="2026-08-20T12:30:00+09:00"
          class="bg-surface border rounded px-2 py-1 text-on-surface outline-none
            placeholder:text-on-surface-muted/50
            {accessedProblem
              ? 'border-error focus:border-error'
              : 'border-border focus:border-primary'}"
        />
        <span class="text-[11px] {accessedProblem ? 'text-error' : 'text-on-surface-muted'}">
          {accessedProblem || "Exact retrieval time with Z / an offset."}
        </span>
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
