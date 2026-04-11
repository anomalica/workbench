<script lang="ts">
  let {
    value,
    onchange,
  }: {
    value: string;
    onchange: (content: string) => void;
  } = $props();

  let textarea: HTMLTextAreaElement | undefined = $state();

  function wrap(before: string, after: string) {
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = textarea.value;
    const selected = text.slice(start, end);
    const replacement = before + selected + after;
    textarea.value = text.slice(0, start) + replacement + text.slice(end);
    onchange(textarea.value);
    // Place cursor after the inserted text
    textarea.focus();
    textarea.selectionStart = start + before.length;
    textarea.selectionEnd = start + before.length + selected.length;
  }

  function insertAtLine(prefix: string) {
    if (!textarea) return;
    const start = textarea.selectionStart;
    const text = textarea.value;
    // Find the start of the current line
    const lineStart = text.lastIndexOf("\n", start - 1) + 1;
    textarea.value = text.slice(0, lineStart) + prefix + text.slice(lineStart);
    onchange(textarea.value);
    textarea.focus();
    textarea.selectionStart = start + prefix.length;
    textarea.selectionEnd = start + prefix.length;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === "b") { e.preventDefault(); wrap("**", "**"); }
    else if (e.key === "i") { e.preventDefault(); wrap("*", "*"); }
    else if (e.key === "k") { e.preventDefault(); wrap("[", "](url)"); }
  }
</script>

<div class="flex flex-col flex-1 min-h-0 border-l-2 border-primary/30 bg-surface-alt/30">
  <!-- Toolbar -->
  <div class="flex items-center gap-0.5 px-3 py-1.5 border-b border-border flex-none">
    <button onclick={() => wrap("**", "**")} class="toolbar-btn" title="Bold (Ctrl+B)">
      <strong>B</strong>
    </button>
    <button onclick={() => wrap("*", "*")} class="toolbar-btn" title="Italic (Ctrl+I)">
      <em>I</em>
    </button>
    <button onclick={() => wrap("[", "](url)")} class="toolbar-btn" title="Link (Ctrl+K)">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
        <path stroke-linecap="round" d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
      </svg>
    </button>
    <div class="w-px h-4 bg-border mx-1"></div>
    <button onclick={() => insertAtLine("# ")} class="toolbar-btn" title="Heading 1">H1</button>
    <button onclick={() => insertAtLine("## ")} class="toolbar-btn" title="Heading 2">H2</button>
    <button onclick={() => insertAtLine("### ")} class="toolbar-btn" title="Heading 3">H3</button>
    <div class="w-px h-4 bg-border mx-1"></div>
    <button onclick={() => insertAtLine("> ")} class="toolbar-btn" title="Blockquote">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20" />
        <path stroke-linecap="round" d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 5v3" />
      </svg>
    </button>
    <button onclick={() => insertAtLine("- ")} class="toolbar-btn" title="List item">
      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" />
        <line x1="3" y1="6" x2="3.01" y2="6" /><line x1="3" y1="12" x2="3.01" y2="12" /><line x1="3" y1="18" x2="3.01" y2="18" />
      </svg>
    </button>
  </div>

  <!-- Editor -->
  <textarea
    bind:this={textarea}
    {value}
    oninput={(e) => onchange((e.target as HTMLTextAreaElement).value)}
    onkeydown={handleKeydown}
    class="flex-1 w-full resize-none bg-transparent text-sm text-on-surface leading-relaxed
      p-4 outline-none border-none font-[inherit]"
    spellcheck="true"
  ></textarea>
</div>

<style>
  .toolbar-btn {
    font-size: 0.75rem;
    font-family: var(--font-ui);
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
    cursor: pointer;
    color: var(--color-on-surface-secondary);
    transition: background-color 0.15s, color 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 1.75rem;
  }

  .toolbar-btn:hover {
    background: var(--color-surface);
    color: var(--color-on-surface);
  }
</style>
