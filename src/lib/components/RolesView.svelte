<script lang="ts">
  import { onMount } from "svelte";
  import { fetchRoles, setRole, removeRole } from "$lib/api";

  let roles = $state<Record<string, string>>({});
  let options = $state<string[]>(["contributor", "reviewer", "editor"]);
  let self = $state("");
  let loading = $state(true);
  let busy = $state<string | null>(null); // the login currently being written
  let error = $state<string | null>(null);

  // Add-row state.
  let newLogin = $state("");
  let newRole = $state("reviewer");

  let sortedLogins = $derived(Object.keys(roles).sort());
  let adminCount = $derived(Object.values(roles).filter((r) => r === "admin").length);

  async function load() {
    loading = true;
    const data = await fetchRoles();
    roles = data.roles;
    options = data.options;
    self = data.self;
    loading = false;
  }

  async function change(login: string, role: string) {
    if (roles[login] === role) return;
    busy = login;
    error = null;
    const res = await setRole(login, role);
    busy = null;
    if (res.error) {
      error = res.error;
      roles = { ...roles }; // revert the <select> to the stored value
      return;
    }
    roles = res.roles ?? roles;
  }

  async function remove(login: string) {
    busy = login;
    error = null;
    const res = await removeRole(login);
    busy = null;
    if (res.error) {
      error = res.error;
      return;
    }
    roles = res.roles ?? roles;
  }

  async function add() {
    const login = newLogin.trim().toLowerCase();
    if (!login) return;
    busy = login;
    error = null;
    const res = await setRole(login, newRole);
    busy = null;
    if (res.error) {
      error = res.error;
      return;
    }
    roles = res.roles ?? roles;
    newLogin = "";
    newRole = "reviewer";
  }

  function roleHint(role: string): string {
    if (role === "admin") return "manages roles + everything an editor can do";
    if (role === "editor") return "archive + article directives + everything a reviewer can do";
    if (role === "reviewer") return "approves proposals; own edits commit directly";
    return "proposes edits (queued, never committed directly)";
  }

  onMount(load);
</script>

<div class="max-w-3xl mx-auto w-full px-6 py-8">
  <header class="mb-6">
    <h1 class="text-lg font-semibold text-on-surface">Contribution roles</h1>
    <p class="text-sm text-on-surface-secondary mt-1">
      Who may write to live data. Anyone not listed is a <span class="font-medium">contributor</span>
      by default - they can propose edits, but only reviewers and editors commit. Changes commit to
      <code class="text-xs">ingests/roles.yaml</code>.
    </p>
  </header>

  {#if error}
    <p class="mb-4 text-sm text-error bg-error-container/30 border border-error/30 rounded px-3 py-2">{error}</p>
  {/if}

  {#if loading}
    <p class="text-sm text-on-surface-muted">Loading…</p>
  {:else}
    <div class="border border-border rounded-lg overflow-hidden">
      <table class="w-full text-sm">
        <thead>
          <tr class="bg-surface-alt text-on-surface-secondary text-xs font-ui uppercase tracking-wide">
            <th class="text-left font-medium px-4 py-2.5">GitHub login</th>
            <th class="text-left font-medium px-4 py-2.5 w-44">Role</th>
            <th class="px-4 py-2.5 w-20"></th>
          </tr>
        </thead>
        <tbody>
          {#each sortedLogins as login (login)}
            <tr class="border-t border-border/60">
              <td class="px-4 py-2.5 text-on-surface font-mono">
                {login}
                {#if login === self}
                  <span class="ml-1.5 text-[10px] font-ui uppercase tracking-wide text-primary">you</span>
                {/if}
              </td>
              <td class="px-4 py-2">
                <select
                  value={roles[login]}
                  onchange={(e) => change(login, (e.currentTarget as HTMLSelectElement).value)}
                  disabled={busy === login}
                  title={roleHint(roles[login])}
                  class="w-full bg-surface border border-border rounded px-2 py-1 text-sm text-on-surface
                    cursor-pointer disabled:opacity-50 focus:outline-none focus:border-primary"
                >
                  {#each options as opt}
                    <option value={opt}>{opt}</option>
                  {/each}
                </select>
              </td>
              <td class="px-4 py-2 text-right">
                <button
                  onclick={() => remove(login)}
                  disabled={busy === login || (roles[login] === "admin" && adminCount <= 1)}
                  class="text-xs font-ui text-on-surface-muted hover:text-error cursor-pointer disabled:opacity-30 disabled:cursor-default"
                  title={roles[login] === "admin" && adminCount <= 1
                    ? "Can't remove the last admin"
                    : "Remove (reverts to contributor)"}
                >
                  Remove
                </button>
              </td>
            </tr>
          {/each}
          {#if sortedLogins.length === 0}
            <tr><td colspan="3" class="px-4 py-4 text-on-surface-muted">No one is listed - everyone is a contributor.</td></tr>
          {/if}
        </tbody>
      </table>

      <!-- Add row -->
      <div class="flex items-center gap-2 px-4 py-3 border-t border-border bg-surface-alt/50">
        <input
          bind:value={newLogin}
          onkeydown={(e) => { if (e.key === "Enter") add(); }}
          placeholder="github-login"
          class="flex-1 bg-surface border border-border rounded px-2 py-1 text-sm text-on-surface font-mono
            focus:outline-none focus:border-primary"
        />
        <select
          bind:value={newRole}
          class="bg-surface border border-border rounded px-2 py-1 text-sm text-on-surface cursor-pointer focus:outline-none focus:border-primary"
        >
          {#each options as opt}
            <option value={opt}>{opt}</option>
          {/each}
        </select>
        <button
          onclick={add}
          disabled={!newLogin.trim()}
          class="px-3 py-1 rounded text-xs font-ui font-medium bg-primary text-on-primary hover:bg-primary/90 cursor-pointer disabled:opacity-40"
        >
          Add
        </button>
      </div>
    </div>

    <p class="mt-3 text-xs text-on-surface-muted leading-relaxed">
      <span class="font-medium">admin</span> {roleHint("admin")} ·
      <span class="font-medium">editor</span> {roleHint("editor")} ·
      <span class="font-medium">reviewer</span> {roleHint("reviewer")} ·
      <span class="font-medium">contributor</span> {roleHint("contributor")}
    </p>
  {/if}
</div>
