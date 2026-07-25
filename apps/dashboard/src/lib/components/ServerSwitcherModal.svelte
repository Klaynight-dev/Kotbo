<script lang="ts">
  import { onMount } from 'svelte';
  import { fade, scale } from 'svelte/transition';
  import Papicon from './Papicon.svelte';
  import { authStore } from '../stores/auth.svelte';
  import { serverSwitcherStore } from '../stores/serverSwitcher.svelte';
  import { resolveGuildIconSrc } from '../discordMedia';
  import { m } from '../i18n';

  let query = $state('');
  let selectedIndex = $state(0);
  let inputEl = $state<HTMLInputElement>();
  let expandedGroups = $state<Set<string>>(new Set());

  const open = $derived(serverSwitcherStore.open);

  type GuildGroup = { main: any; staffChild: any | null };

  // Un serveur staff est imbriqué sous son serveur principal plutôt que listé à plat.
  const guildGroups = $derived.by((): GuildGroup[] => {
    const staffChildByMainId = new Map(
      authStore.guilds
        .filter((g) => g.isStaffServer && g.pairedGuildId)
        .map((g) => [g.pairedGuildId, g]),
    );

    // Un serveur staff n'a sa propre ligne top-level que si son principal n'est pas accessible.
    return authStore.guilds
      .filter((g) => !g.isStaffServer || !authStore.guilds.some((m) => m.id === g.pairedGuildId))
      .map((main) => ({ main, staffChild: staffChildByMainId.get(main.id) ?? null }));
  });

  const filteredGroups = $derived.by(() => {
    const q = query.toLowerCase().trim();
    if (!q) return guildGroups;
    return guildGroups.filter(
      ({ main, staffChild }) =>
        main.name.toLowerCase().includes(q) || staffChild?.name.toLowerCase().includes(q),
    );
  });

  // Liste à plat des lignes visibles (principal + staff imbriqué déplié) pour la navigation clavier.
  const visibleRows = $derived.by(() => {
    const q = query.toLowerCase().trim();
    const rows: Array<{ guild: any; nested: boolean }> = [];
    for (const { main, staffChild } of filteredGroups) {
      rows.push({ guild: main, nested: false });
      const forceExpand = !!q && staffChild?.name.toLowerCase().includes(q);
      if (staffChild && (expandedGroups.has(main.id) || forceExpand)) {
        rows.push({ guild: staffChild, nested: true });
      }
    }
    return rows;
  });

  $effect(() => {
    if (open) {
      query = '';
      selectedIndex = 0;
      setTimeout(() => inputEl?.focus(), 50);
    }
  });

  function close() {
    serverSwitcherStore.close();
  }

  function toggleGroup(mainGuildId: string): void {
    const next = new Set(expandedGroups);
    if (next.has(mainGuildId)) next.delete(mainGuildId);
    else next.add(mainGuildId);
    expandedGroups = next;
  }

  function selectGuild(guildId: string) {
    if (guildId === authStore.selectedGuildId) {
      close();
      return;
    }
    authStore.setGuild(guildId);
    close();
    window.location.reload();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!open) return;
    const items = visibleRows;

    if (e.key === 'Escape') {
      close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
    }
    if (e.key === 'Enter' && items[selectedIndex]) {
      e.preventDefault();
      selectGuild(items[selectedIndex].guild.id);
    }
  }
</script>

{#if open}
  <div
    class="fixed inset-0 z-100 flex items-start justify-center pt-[15vh] px-4"
    role="dialog"
    aria-modal="true"
    aria-label={m.d7_server_switcher()}
    tabindex="-1"
    onkeydown={(e) => { if (e.key === 'Escape') close(); }}
  >
    <button
      type="button"
      class="absolute inset-0 bg-black/40 border-none cursor-default w-full h-full text-left p-0"
      onclick={close}
      aria-label={m.d7_close()}
      transition:fade={{ duration: 100 }}
    ></button>

    <div
      class="relative z-10 w-full max-w-md bg-surface-container-lowest border border-outline-variant rounded-xl shadow-lg overflow-hidden"
      role="document"
      transition:scale={{ start: 0.98, duration: 150 }}
    >
      <div class="flex items-center gap-2.5 px-3 py-2.5 border-b border-outline-variant">
        <Papicon icon="Search" size={15} class="text-on-surface-variant/40 shrink-0" />
        <input
          bind:this={inputEl}
          bind:value={query}
          oninput={() => selectedIndex = 0}
          onkeydown={handleKeydown}
          type="text"
          placeholder={m.d7_search_server()}
          class="flex-1 bg-transparent text-sm text-on-surface placeholder-on-surface-variant/40 focus:outline-none"
        />
        <kbd class="hidden sm:flex px-1.5 py-0.5 rounded bg-surface-container border border-outline-variant text-[10px] font-medium text-on-surface-variant/40 leading-none">
          ESC
        </kbd>
      </div>

      <div class="max-h-[50vh] overflow-y-auto py-1">
        <p class="text-[10px] font-medium uppercase tracking-wider text-on-surface-variant px-3 py-1.5">
          {m.d7_servers_count({ count: filteredGroups.length })}
        </p>

        {#each visibleRows as row, idx (row.guild.id)}
          {@const guild = row.guild}
          {@const isSelected = idx === selectedIndex}
          {@const isActive = guild.id === authStore.selectedGuildId}
          {@const iconUrl = resolveGuildIconSrc(guild.id, guild.icon)}
          {@const group = row.nested ? null : filteredGroups.find((g) => g.main.id === guild.id)}
          {@const isExpanded = expandedGroups.has(guild.id)}

          <div
            class="w-full flex items-center gap-1 mx-1 rounded-lg"
            style="width: calc(100% - 0.5rem)"
          >
            {#if row.nested}
              <div class="w-5 shrink-0"></div>
            {:else if group?.staffChild}
              <button
                type="button"
                onclick={(e) => { e.stopPropagation(); toggleGroup(guild.id); }}
                class="w-5 h-5 shrink-0 flex items-center justify-center rounded text-on-surface-variant/40 hover:text-on-surface transition-transform duration-150 {isExpanded ? 'rotate-90' : ''}"
                aria-label={isExpanded ? m.d7_collapse() : m.d7_show_linked_staff()}
              >
                <Papicon icon="ChevronRight" size={12} />
              </button>
            {:else}
              <div class="w-5 shrink-0"></div>
            {/if}

            <button
              onclick={() => selectGuild(guild.id)}
              onmouseenter={() => selectedIndex = idx}
              class="flex-1 flex items-center gap-2.5 px-2 py-2 rounded-lg text-left transition-colors duration-100
 {isSelected ? 'bg-primary/8 text-primary' : 'text-on-surface-variant hover:bg-surface-container'}"
            >
              {#if iconUrl}
                <img
                  src={iconUrl}
                  alt={guild.name}
                  referrerpolicy="no-referrer"
                  class="w-6 h-6 rounded object-cover"
                />
              {:else}
                <div class="w-6 h-6 rounded bg-primary/10 flex items-center justify-center text-[10px] font-medium text-primary">
                  {guild.name.charAt(0)}
                </div>
              {/if}

              <div class="flex-1 min-w-0">
                <p class="text-sm leading-none truncate flex items-center gap-1.5">
                  {guild.name}
                  {#if guild.isStaffServer}
                    <span class="text-[9px] font-medium uppercase tracking-wide px-1 py-0.5 rounded bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-200 dark:border-blue-500/20">{m.d7_staff()}</span>
                  {/if}
                  {#if isActive}
                    <span class="text-[9px] font-medium uppercase tracking-wide px-1 py-0.5 rounded bg-primary/10 text-primary">{m.d7_current()}</span>
                  {/if}
                </p>
                <p class="text-[10px] text-on-surface-variant mt-0.5 truncate">
                  {guild.accessLevel === 'admin' ? m.d7_admin() : guild.accessLevel === 'moderator' ? m.d7_moderator() : m.d7_member()}
                </p>
              </div>

              {#if isSelected}
                <kbd class="text-[9px] text-primary/50 leading-none">↵</kbd>
              {/if}
            </button>
          </div>
        {:else}
          <div class="flex flex-col items-center py-8 gap-1.5 text-center">
            <Papicon icon="SearchX" size={24} class="text-on-surface-variant/30" />
            <p class="text-sm text-on-surface-variant/50">{m.d7_no_server_found()}</p>
          </div>
        {/each}
      </div>

      <div class="flex items-center gap-3 px-3 py-2 border-t border-outline-variant bg-surface-container">
        <div class="flex items-center gap-1 text-[10px] text-on-surface-variant/40">
          <kbd class="px-1 py-0.5 rounded bg-surface-container-highest border border-outline-variant font-mono text-[9px]">↑↓</kbd>
          {m.d7_navigate()}
        </div>
        <div class="flex items-center gap-1 text-[10px] text-on-surface-variant/40">
          <kbd class="px-1 py-0.5 rounded bg-surface-container-highest border border-outline-variant font-mono text-[9px]">↵</kbd>
          {m.d7_select()}
        </div>
      </div>
    </div>
  </div>
{/if}
