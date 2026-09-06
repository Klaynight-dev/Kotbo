<script lang="ts">
  import { m } from '../lib/i18n';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { updateCommandAccessSettings } from '../lib/api';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import AccessEntitySelector from '../lib/components/AccessEntitySelector.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';

  const availableChannels = $derived(dashboardStore.state.discordChannels || []);
  const availableRoles = $derived(dashboardStore.state.discordRoles || []);
  const commandCatalog = $derived(dashboardStore.state.commandCatalog || []);
  const canManageSettings = $derived(
    !!dashboardStore.state.featureAccess?.commands?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );
  const activeRestrictionCount = $derived(dashboardStore.state.commandRestrictions.length);

  const saveAction = createAsyncActionState();

  let savedRestrictions = $state<any[]>([]);
  let commandSearch = $state('');
  let catalogFilter = $state<string>('all');
  const cmdTabs = ['doc', 'permissions'] as const;
  let activeTab = $state<'doc' | 'permissions'>('doc');

  $effect(() => {
    const _path = $router.path;
    activeTab = resolveTabFromUrl('/command-access', cmdTabs, 'doc') as typeof activeTab;
  });

  // Permission selection state
  let channelMode = $state<'neutral' | 'allowedOnly' | 'blockedOnly'>('neutral');
  let roleMode = $state<'neutral' | 'allowedOnly' | 'blockedOnly'>('neutral');
  let userMode = $state<'neutral' | 'allowedOnly' | 'blockedOnly'>('neutral');
  let selectedCommandName = $state('');
  let userIdInput = $state('');

  // Accordion state for subcommands
  let expandedSubs = $state<Set<string>>(new Set());

  function toggleSubExpand(subName: string) {
    const next = new Set(expandedSubs);
    if (next.has(subName)) next.delete(subName);
    else next.add(subName);
    expandedSubs = next;
  }

  let commandDraft = $state({
    commandName: '',
    allowedChannelIds: [] as string[],
    blockedChannelIds: [] as string[],
    allowedRoleIds: [] as string[],
    blockedRoleIds: [] as string[],
    allowedUserIds: [] as string[],
    blockedUserIds: [] as string[],
  });

  const emptyDraft = () => ({
    commandName: '',
    allowedChannelIds: [] as string[],
    blockedChannelIds: [] as string[],
    allowedRoleIds: [] as string[],
    blockedRoleIds: [] as string[],
    allowedUserIds: [] as string[],
    blockedUserIds: [] as string[],
  });

  const uniqueIds = (ids: string[]) => [...new Set(ids)];
  const normalizeSearchText = (value: string) => value.trim().toLowerCase();

  const channelOptions = $derived(availableChannels.map((channel) => ({
    id: channel.id,
    name: channel.name,
    prefix: '#',
  })));

  const roleOptions = $derived(availableRoles.map((role) => ({
    id: role.id,
    name: role.name,
    prefix: '@',
  })));

  const channelConflicts = $derived(commandDraft.allowedChannelIds.filter((id) => commandDraft.blockedChannelIds.includes(id)));
  const roleConflicts = $derived(commandDraft.allowedRoleIds.filter((id) => commandDraft.blockedRoleIds.includes(id)));
  const userConflicts = $derived(commandDraft.allowedUserIds.filter((id) => commandDraft.blockedUserIds.includes(id)));
  const hasConflicts = $derived(channelConflicts.length > 0 || roleConflicts.length > 0 || userConflicts.length > 0);

  function inferMode(allowedIds: string[], blockedIds: string[]): 'neutral' | 'allowedOnly' | 'blockedOnly' {
    if (allowedIds.length > 0 && blockedIds.length === 0) return 'allowedOnly';
    if (blockedIds.length > 0 && allowedIds.length === 0) return 'blockedOnly';
    return 'neutral';
  }

  const selectedChannelIds = $derived(channelMode === 'allowedOnly' ? commandDraft.allowedChannelIds : commandDraft.blockedChannelIds);
  const selectedRoleIds = $derived(roleMode === 'allowedOnly' ? commandDraft.allowedRoleIds : commandDraft.blockedRoleIds);
  const selectedUserIds = $derived(userMode === 'allowedOnly' ? commandDraft.allowedUserIds : commandDraft.blockedUserIds);

  const channelSelectionDisabled = $derived(channelMode === 'neutral' || !canManageSettings || !selectedCommandName);
  const roleSelectionDisabled = $derived(roleMode === 'neutral' || !canManageSettings || !selectedCommandName);
  const userSelectionDisabled = $derived(userMode === 'neutral' || !canManageSettings || !selectedCommandName);

  const currentRestrictions = $derived.by(() => {
    if (!selectedCommandName) return dashboardStore.state.commandRestrictions || [];
    const nextRules = (dashboardStore.state.commandRestrictions || []).filter(
      (entry) => entry.commandName !== selectedCommandName
    );
    const nextRule = {
      commandName: selectedCommandName,
      allowedChannelIds: uniqueIds(commandDraft.allowedChannelIds),
      blockedChannelIds: uniqueIds(commandDraft.blockedChannelIds),
      allowedRoleIds: uniqueIds(commandDraft.allowedRoleIds),
      blockedRoleIds: uniqueIds(commandDraft.blockedRoleIds),
      allowedUserIds: uniqueIds(commandDraft.allowedUserIds),
      blockedUserIds: uniqueIds(commandDraft.blockedUserIds),
    };

    const hasAnyRestriction =
      nextRule.allowedChannelIds.length > 0
      || nextRule.blockedChannelIds.length > 0
      || nextRule.allowedRoleIds.length > 0
      || nextRule.blockedRoleIds.length > 0
      || nextRule.allowedUserIds.length > 0
      || nextRule.blockedUserIds.length > 0;

    return hasAnyRestriction ? [...nextRules, nextRule] : nextRules;
  });

  $effect(() => {
    const dirty = JSON.stringify(currentRestrictions) !== JSON.stringify(savedRestrictions);
    if (dirty && canManageSettings) {
      untrack(() => {
        unsavedChanges.register({
          id: 'command-access',
          label: m.commands_unsaved_label(),
          onSave: () => saveCommandAccess(),
          onReset: () => {
            dashboardStore.state.commandRestrictions = JSON.parse(JSON.stringify(savedRestrictions));
            if (selectedCommandName) {
              loadCommandDraft(selectedCommandName);
            }
          }
        });
      });
    } else if (!dirty) {
      untrack(() => {
        unsavedChanges.release('command-access');
      });
    }
  });

  onDestroy(() => {
    unsavedChanges.release('command-access');
  });

  onMount(async () => {
    await dashboardStore.refresh();
    savedRestrictions = JSON.parse(JSON.stringify(dashboardStore.state.commandRestrictions || []));
  });

  function loadCommandDraft(commandName: string) {
    const rule = dashboardStore.state.commandRestrictions.find((entry) => entry.commandName === commandName);
    const nextDraft = rule ? {
      commandName: rule.commandName,
      allowedChannelIds: [...rule.allowedChannelIds],
      blockedChannelIds: [...rule.blockedChannelIds],
      allowedRoleIds: [...rule.allowedRoleIds],
      blockedRoleIds: [...rule.blockedRoleIds],
      allowedUserIds: [...(rule.allowedUserIds || [])],
      blockedUserIds: [...(rule.blockedUserIds || [])],
    } : {
      ...emptyDraft(),
      commandName,
    };

    commandDraft = nextDraft;

    channelMode = inferMode(nextDraft.allowedChannelIds, nextDraft.blockedChannelIds);
    roleMode = inferMode(nextDraft.allowedRoleIds, nextDraft.blockedRoleIds);
    userMode = inferMode(nextDraft.allowedUserIds, nextDraft.blockedUserIds);
  }

  function selectCommand(commandName: string) {
    selectedCommandName = commandName;
    loadCommandDraft(commandName);
    saveAction.clearFeedback();
    expandedSubs = new Set();
  }

  function defaultAccessLabel(access: string) {
    if (access === 'administration') return m.common_admin();
    if (access === 'modération') return m.common_mod();
    return m.common_all();
  }

  function defaultAccessBadgeClass(access: string) {
    if (access === 'administration') return 'badge-danger';
    if (access === 'modération') return 'badge-warning';
    return 'badge-success';
  }

  function hasRestriction(commandName: string) {
    return dashboardStore.state.commandRestrictions.some((entry) => entry.commandName === commandName);
  }

  function getRestrictionCounts(commandName: string) {
    const rule = dashboardStore.state.commandRestrictions.find((entry) => entry.commandName === commandName);
    if (!rule) return null;
    const channels = rule.allowedChannelIds.length + rule.blockedChannelIds.length;
    const roles = rule.allowedRoleIds.length + rule.blockedRoleIds.length;
    const users = rule.allowedUserIds.length + rule.blockedUserIds.length;
    return { channels, roles, users, total: channels + roles + users };
  }

  function resolveDraftConflicts() {
    const allowedChannels = new Set(commandDraft.allowedChannelIds);
    const allowedRoles = new Set(commandDraft.allowedRoleIds);
    const allowedUsers = new Set(commandDraft.allowedUserIds);
    commandDraft = {
      ...commandDraft,
      blockedChannelIds: commandDraft.blockedChannelIds.filter((id) => !allowedChannels.has(id)),
      blockedRoleIds: commandDraft.blockedRoleIds.filter((id) => !allowedRoles.has(id)),
      blockedUserIds: commandDraft.blockedUserIds.filter((id) => !allowedUsers.has(id)),
    };
    channelMode = inferMode(commandDraft.allowedChannelIds, commandDraft.blockedChannelIds);
    roleMode = inferMode(commandDraft.allowedRoleIds, commandDraft.blockedRoleIds);
    userMode = inferMode(commandDraft.allowedUserIds, commandDraft.blockedUserIds);
  }

  function setChannelMode(mode: 'neutral' | 'allowedOnly' | 'blockedOnly') {
    channelMode = mode;
    if (mode === 'neutral') {
      commandDraft = { ...commandDraft, allowedChannelIds: [], blockedChannelIds: [] };
      return;
    }
    if (mode === 'allowedOnly') {
      const nextAllowed = commandDraft.allowedChannelIds.length > 0 ? commandDraft.allowedChannelIds : commandDraft.blockedChannelIds;
      commandDraft = { ...commandDraft, allowedChannelIds: uniqueIds(nextAllowed), blockedChannelIds: [] };
      return;
    }
    const nextBlocked = commandDraft.blockedChannelIds.length > 0 ? commandDraft.blockedChannelIds : commandDraft.allowedChannelIds;
    commandDraft = { ...commandDraft, allowedChannelIds: [], blockedChannelIds: uniqueIds(nextBlocked) };
  }

  function setRoleMode(mode: 'neutral' | 'allowedOnly' | 'blockedOnly') {
    roleMode = mode;
    if (mode === 'neutral') {
      commandDraft = { ...commandDraft, allowedRoleIds: [], blockedRoleIds: [] };
      return;
    }
    if (mode === 'allowedOnly') {
      const nextAllowed = commandDraft.allowedRoleIds.length > 0 ? commandDraft.allowedRoleIds : commandDraft.blockedRoleIds;
      commandDraft = { ...commandDraft, allowedRoleIds: uniqueIds(nextAllowed), blockedRoleIds: [] };
      return;
    }
    const nextBlocked = commandDraft.blockedRoleIds.length > 0 ? commandDraft.blockedRoleIds : commandDraft.allowedRoleIds;
    commandDraft = { ...commandDraft, allowedRoleIds: [], blockedRoleIds: uniqueIds(nextBlocked) };
  }

  function setUserMode(mode: 'neutral' | 'allowedOnly' | 'blockedOnly') {
    userMode = mode;
    if (mode === 'neutral') {
      commandDraft = { ...commandDraft, allowedUserIds: [], blockedUserIds: [] };
      return;
    }
    if (mode === 'allowedOnly') {
      const nextAllowed = commandDraft.allowedUserIds.length > 0 ? commandDraft.allowedUserIds : commandDraft.blockedUserIds;
      commandDraft = { ...commandDraft, allowedUserIds: uniqueIds(nextAllowed), blockedUserIds: [] };
      return;
    }
    const nextBlocked = commandDraft.blockedUserIds.length > 0 ? commandDraft.blockedUserIds : commandDraft.allowedUserIds;
    commandDraft = { ...commandDraft, allowedUserIds: [], blockedUserIds: uniqueIds(nextBlocked) };
  }

  function toggleChannelSelection(channelId: string, checked: boolean) {
    if (channelMode === 'neutral') return;
    if (channelMode === 'allowedOnly') {
      const next = checked
        ? [...new Set([...commandDraft.allowedChannelIds, channelId])]
        : commandDraft.allowedChannelIds.filter((entry) => entry !== channelId);
      commandDraft = { ...commandDraft, allowedChannelIds: next };
      return;
    }
    const next = checked
      ? [...new Set([...commandDraft.blockedChannelIds, channelId])]
      : commandDraft.blockedChannelIds.filter((entry) => entry !== channelId);
    commandDraft = { ...commandDraft, blockedChannelIds: next };
  }

  function toggleRoleSelection(roleId: string, checked: boolean) {
    if (roleMode === 'neutral') return;
    if (roleMode === 'allowedOnly') {
      const next = checked
        ? [...new Set([...commandDraft.allowedRoleIds, roleId])]
        : commandDraft.allowedRoleIds.filter((entry) => entry !== roleId);
      commandDraft = { ...commandDraft, allowedRoleIds: next };
      return;
    }
    const next = checked
      ? [...new Set([...commandDraft.blockedRoleIds, roleId])]
      : commandDraft.blockedRoleIds.filter((entry) => entry !== roleId);
    commandDraft = { ...commandDraft, blockedRoleIds: next };
  }

  function clearChannels() {
    channelMode = 'neutral';
    commandDraft = { ...commandDraft, allowedChannelIds: [], blockedChannelIds: [] };
  }

  function clearRoles() {
    roleMode = 'neutral';
    commandDraft = { ...commandDraft, allowedRoleIds: [], blockedRoleIds: [] };
  }

  function clearUsers() {
    userMode = 'neutral';
    commandDraft = { ...commandDraft, allowedUserIds: [], blockedUserIds: [] };
  }

  function clearAllRules() {
    channelMode = 'neutral';
    roleMode = 'neutral';
    userMode = 'neutral';
    commandDraft = { ...commandDraft, ...emptyDraft(), commandName: selectedCommandName };
  }

  function upsertCommandDraft() {
    if (!selectedCommandName) return;
    const nextRule = {
      commandName: selectedCommandName,
      allowedChannelIds: uniqueIds(commandDraft.allowedChannelIds),
      blockedChannelIds: uniqueIds(commandDraft.blockedChannelIds),
      allowedRoleIds: uniqueIds(commandDraft.allowedRoleIds),
      blockedRoleIds: uniqueIds(commandDraft.blockedRoleIds),
      allowedUserIds: uniqueIds(commandDraft.allowedUserIds),
      blockedUserIds: uniqueIds(commandDraft.blockedUserIds),
    };

    const nextRules = dashboardStore.state.commandRestrictions.filter((entry) => entry.commandName !== selectedCommandName);
    const hasAnyRestriction = nextRule.allowedChannelIds.length > 0
      || nextRule.blockedChannelIds.length > 0
      || nextRule.allowedRoleIds.length > 0
      || nextRule.blockedRoleIds.length > 0
      || nextRule.allowedUserIds.length > 0
      || nextRule.blockedUserIds.length > 0;

    dashboardStore.state.commandRestrictions = hasAnyRestriction ? [...nextRules, nextRule] : nextRules;
    commandDraft = { ...nextRule };
  }

  async function saveCommandAccess(): Promise<boolean> {
    if (!canManageSettings) {
      saveAction.setError(m.commands_err_admin_only());
      return false;
    }

    upsertCommandDraft();

    let success = false;
    await saveAction.run(
      async () => {
        const saved = await updateCommandAccessSettings(dashboardStore.state.commandRestrictions);
        if (!saved) return false;

        await dashboardStore.refresh();
        savedRestrictions = JSON.parse(JSON.stringify(dashboardStore.state.commandRestrictions));
        success = true;
        return true;
      },
      {
        successMessage: m.commands_saved_toast(),
        failureMessage: m.commands_save_failed_toast()
      }
    );
    return success;
  }

  function addUserId() {
    if (userSelectionDisabled) return;
    const normalized = userIdInput.trim().replace(/[^0-9]/g, '');
    if (!normalized) return;

    if (userMode === 'allowedOnly') {
      const next = uniqueIds([...commandDraft.allowedUserIds, normalized]);
      commandDraft = { ...commandDraft, allowedUserIds: next };
    } else if (userMode === 'blockedOnly') {
      const next = uniqueIds([...commandDraft.blockedUserIds, normalized]);
      commandDraft = { ...commandDraft, blockedUserIds: next };
    }

    userIdInput = '';
  }

  function removeUserId(userId: string) {
    if (userMode === 'allowedOnly') {
      commandDraft = {
        ...commandDraft,
        allowedUserIds: commandDraft.allowedUserIds.filter((entry) => entry !== userId),
      };
      return;
    }
    if (userMode === 'blockedOnly') {
      commandDraft = {
        ...commandDraft,
        blockedUserIds: commandDraft.blockedUserIds.filter((entry) => entry !== userId),
      };
    }
  }

  const selectedCatalogEntry = $derived(commandCatalog.find((entry) => entry.name === selectedCommandName));
  const hasSelectedRestriction = $derived(hasRestriction(selectedCommandName));

  const filteredCommandCatalog = $derived.by(() => {
    const search = normalizeSearchText(commandSearch);
    const commands = [...commandCatalog];

    const matchesFilter = (command: any) => {
      if (catalogFilter === 'all') return true;
      if (catalogFilter === 'active') return hasRestriction(command.name);
      if (catalogFilter === 'no-rules') return !hasRestriction(command.name);
      return command.category === catalogFilter;
    };

    return commands
      .filter((command) => {
        if (!matchesFilter(command)) return false;
        if (!search) return true;
        
        const basicMatch = command.name.toLowerCase().includes(search)
          || (command.label || '').toLowerCase().includes(search)
          || (command.description || '').toLowerCase().includes(search);
        
        if (basicMatch) return true;

        return command.options?.some((opt: any) => {
          const optMatch = opt.name.toLowerCase().includes(search) || (opt.description || '').toLowerCase().includes(search);
          if (optMatch) return true;
          if (opt.options) {
            return opt.options.some((subOpt: any) => subOpt.name.toLowerCase().includes(search) || (subOpt.description || '').toLowerCase().includes(search));
          }
          return false;
        }) || false;
      })
      .sort((a, b) => {
        const aActive = hasRestriction(a.name) ? 1 : 0;
        const bActive = hasRestriction(b.name) ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        return a.name.localeCompare(b.name, 'fr');
      });
  });

  const categoryCounts = $derived.by(() => {
    const counts: Record<string, number> = { all: commandCatalog.length, active: 0, 'no-rules': 0 };
    for (const cmd of commandCatalog) {
      const active = hasRestriction(cmd.name);
      if (active) counts.active++;
      else counts['no-rules']++;
      
      const cat = cmd.category || 'Autre';
      counts[cat] = (counts[cat] || 0) + 1;
    }
    return counts;
  });

  const categories = $derived([
    { id: 'all', name: m.commands_cat_all(), icon: 'terminal' },
    { id: 'Administration', name: m.commands_cat_admin(), icon: 'lock' },
    { id: 'Modération', name: m.commands_cat_moderation(), icon: 'shield' },
    { id: 'Économie', name: m.commands_cat_economy(), icon: 'Coins' },
    { id: 'Utilitaire', name: m.commands_cat_utility(), icon: 'Gears' },
    { id: 'Communauté', name: m.commands_cat_community(), icon: 'users' },
    { id: 'Fun', name: m.commands_cat_fun(), icon: 'Star' }
  ]);

  $effect(() => {
    if (!selectedCommandName && commandCatalog.length > 0) {
      selectedCommandName = commandCatalog[0].name;
    }
  });

  const hasSubcommands = $derived(
    selectedCatalogEntry?.options?.some((opt: any) => opt.type === 1 || opt.type === 2) ?? false
  );

  function getOptionTypeLabel(type: number): string {
    switch (type) {
      case 1: return m.commands_type_subcommand();
      case 2: return m.commands_type_group();
      case 3: return m.commands_type_string();
      case 4: return m.commands_type_integer();
      case 5: return m.commands_type_boolean();
      case 6: return m.commands_type_user();
      case 7: return m.commands_type_channel();
      case 8: return m.commands_type_role();
      case 9: return m.commands_type_mentionable();
      case 10: return m.commands_type_number();
      case 11: return m.commands_type_attachment();
      default: return m.commands_type_option();
    }
  }

  function getOptionTypeBadgeClass(type: number): string {
    switch (type) {
      case 1: return 'badge-warning';
      case 3: return 'badge-info';
      case 4: return 'badge-info';
      case 5: return 'badge-warning';
      case 6: return 'badge-success';
      case 7: return 'badge-info';
      case 8: return 'badge-info';
      case 9: return 'badge-info';
      case 10: return 'badge-info';
      case 11: return 'badge-neutral';
      default: return 'badge-neutral';
    }
  }

  function buildCommandSignature(cmdName: string, subName?: string, options?: any[]): string {
    const parts = [`/${cmdName}`];
    if (subName) parts.push(subName);
    
    if (options) {
      for (const opt of options) {
        if (opt.type === 1 || opt.type === 2) continue;
        if (opt.required) {
          parts.push(`<${opt.name}>`);
        } else {
          parts.push(`[${opt.name}]`);
        }
      }
    }
    return parts.join(' ');
  }
</script>

<ModulePage
  title={m.commands_page_title()}
  description={m.commands_page_desc()}
  icon="terminal"
  featureKey="commands"
>
  {#snippet actions()}
    <div class="flex items-center gap-3 relative">
      <div class="stat-kpi flex items-center gap-2.5 !py-1.5 !px-3">
        <Papicon icon="Code" size={14} class="text-on-surface-variant" />
        <div class="flex flex-col">
          <span class="section-label !text-[9px]">{m.commands_kpi_total()}</span>
          <span class="text-sm font-semibold text-on-surface">{commandCatalog.length}</span>
        </div>
      </div>
      <div class="stat-kpi flex items-center gap-2.5 !py-1.5 !px-3 !border-primary/20">
        <Papicon icon="Lock" size={14} class="text-primary" />
        <div class="flex flex-col">
          <span class="section-label !text-[9px] !text-primary/70">{m.commands_kpi_restrictions()}</span>
          <span class="text-sm font-semibold text-primary">{activeRestrictionCount}</span>
        </div>
      </div>
    </div>
  {/snippet}

  <!-- ═══════════ MAIN LAYOUT ═══════════ -->
  <div class="grid grid-cols-12 gap-6">

    <!-- ─── Left Column: Categories + Command List ─── -->
    <div class="col-span-12 xl:col-span-4 flex flex-col gap-4">

      <!-- Category filters -->
      <div class="section-card p-4">
        <p class="section-label mb-3 px-1">{m.commands_heading_categories()}</p>
        <div class="flex flex-col gap-0.5">
          {#each categories as cat}
            <button
              type="button"
              onclick={() => { catalogFilter = cat.id; }}
              class="cmd-cat-btn {catalogFilter === cat.id ? 'cmd-cat-btn--active' : ''}"
            >
              <span class="flex items-center gap-2.5">
                <Papicon icon={cat.icon} size={15} class={catalogFilter === cat.id ? 'text-on-primary' : 'text-on-surface-variant'} />
                <span>{cat.name}</span>
              </span>
              <span class="cmd-cat-count {catalogFilter === cat.id ? 'cmd-cat-count--active' : ''}">
                {categoryCounts[cat.id] || 0}
              </span>
            </button>
          {/each}

          <div class="h-px bg-outline-variant/40 my-2"></div>

          <button
            type="button"
            onclick={() => { catalogFilter = 'active'; }}
            class="cmd-cat-btn {catalogFilter === 'active' ? 'cmd-cat-btn--active' : ''}"
          >
            <span class="flex items-center gap-2.5">
              <span class="w-2 h-2 rounded-full bg-emerald-500 {catalogFilter === 'active' ? '' : 'opacity-60'}"></span>
              <span>{m.commands_filter_active()}</span>
            </span>
            <span class="cmd-cat-count {catalogFilter === 'active' ? 'cmd-cat-count--active' : ''}">
              {categoryCounts.active}
            </span>
          </button>
          <button
            type="button"
            onclick={() => { catalogFilter = 'no-rules'; }}
            class="cmd-cat-btn {catalogFilter === 'no-rules' ? 'cmd-cat-btn--active' : ''}"
          >
            <span class="flex items-center gap-2.5">
              <span class="w-2 h-2 rounded-full bg-on-surface-variant/30"></span>
              <span>{m.commands_filter_no_rules()}</span>
            </span>
            <span class="cmd-cat-count {catalogFilter === 'no-rules' ? 'cmd-cat-count--active' : ''}">
              {categoryCounts['no-rules']}
            </span>
          </button>
        </div>
      </div>

      <!-- Search + Command list -->
      <div class="section-card p-4 flex flex-col gap-3">
        <div class="flex items-center justify-between">
          <p class="section-label px-1">{m.commands_heading_list()}</p>
          <span class="badge badge-neutral text-[10px]">{filteredCommandCatalog.length}</span>
        </div>

        <!-- Search input -->
        <div class="relative">
          <Papicon icon="Search" size={15} class="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/50" />
          <input
            id="command-search"
            type="text"
            bind:value={commandSearch}
            placeholder={m.commands_search_ph()}
            class="cmd-search-input"
          />
          {#if commandSearch}
            <button
              type="button"
              onclick={() => { commandSearch = ''; }}
              aria-label={m.common_clear()}
              class="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant/40 hover:text-on-surface transition-colors"
            >
              <Papicon icon="x" size={14} />
            </button>
          {/if}
        </div>

        <!-- Command list -->
        <div class="cmd-list custom-scrollbar">
          {#if filteredCommandCatalog.length === 0}
            <div class="flex flex-col items-center justify-center py-10 text-center">
              <Papicon icon="Search" size={28} class="text-on-surface-variant/30 mb-2" />
              <p class="text-sm text-on-surface-variant/60">{m.commands_no_results()}</p>
            </div>
          {:else}
            {#each filteredCommandCatalog as command}
              <button
                type="button"
                onclick={() => selectCommand(command.name)}
                class="cmd-item {selectedCommandName === command.name ? 'cmd-item--selected' : ''}"
              >
                <div class="min-w-0 flex-1">
                  <p class="cmd-item-name">
                    <span class="text-primary">/</span>{command.name}
                  </p>
                  <p class="cmd-item-desc">{command.description || command.label || ''}</p>
                </div>
                <div class="flex items-center gap-1.5 shrink-0">
                  {#if hasRestriction(command.name)}
                    {@const rc = getRestrictionCounts(command.name)}
                    <span class="badge badge-success !text-[9px] !gap-1 !px-1.5">
                      <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                      {rc?.total}
                    </span>
                  {/if}
                  <span class="badge {defaultAccessBadgeClass(command.defaultAccess)} !text-[9px]">
                    {defaultAccessLabel(command.defaultAccess)}
                  </span>
                </div>
              </button>
            {/each}
          {/if}
        </div>
      </div>
    </div>

    <!-- ─── Right Column: Details ─── -->
    <div class="col-span-12 xl:col-span-8">
      {#if !selectedCommandName || !selectedCatalogEntry}
        <!-- Empty state -->
        <div class="section-card flex flex-col items-center justify-center min-h-[55vh] text-center p-8">
          <div class="w-14 h-14 rounded-xl bg-surface-container flex items-center justify-center mb-4">
            <Papicon icon="terminal" size={28} class="text-on-surface-variant/40" />
          </div>
          <h4 class="text-base font-semibold text-on-surface">{m.commands_empty_select_title()}</h4>
          <p class="text-sm text-on-surface-variant/60 mt-1.5 max-w-xs">{m.commands_empty_select_desc()}</p>
        </div>
      {:else}
        <div class="section-card p-5 xl:p-6 flex flex-col gap-5">

          <!-- Command header -->
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-outline-variant/40">
            <div class="min-w-0">
              <div class="flex items-center gap-2.5 flex-wrap">
                <h2 class="text-xl font-bold tracking-tight text-on-surface font-headline">
                  <span class="text-primary">/</span>{selectedCatalogEntry.name}
                </h2>
                {#if selectedCatalogEntry.category}
                  <span class="badge badge-neutral !text-[9px]">{selectedCatalogEntry.category}</span>
                {/if}
              </div>
              <p class="text-sm text-on-surface-variant/70 mt-1">{selectedCatalogEntry.description || m.commands_no_desc()}</p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              {#if hasSelectedRestriction}
                <span class="badge badge-success !text-[9px] !font-semibold">
                  <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                  {m.commands_badge_active_filters()}
                </span>
              {/if}
              <span class="badge {defaultAccessBadgeClass(selectedCatalogEntry.defaultAccess)} !text-[9px] !font-semibold">
                {defaultAccessLabel(selectedCatalogEntry.defaultAccess)}
              </span>
            </div>
          </div>

          <!-- Tab navigation -->
          <div class="tab-group self-start">
            <button
              type="button"
              onclick={() => gotoTab('/command-access', 'doc', 'doc')}
              class="tab-button {activeTab === 'doc' ? 'active' : ''}"
            >
              <Papicon icon="Paper" size={14} />
              {m.commands_tab_structure()}
            </button>
            <button
              type="button"
              onclick={() => gotoTab('/command-access', 'permissions', 'doc')}
              class="tab-button {activeTab === 'permissions' ? 'active' : ''}"
            >
              <Papicon icon="Lock" size={14} />
              {m.commands_tab_permissions()}
              {#if hasSelectedRestriction}
                <span class="w-1.5 h-1.5 rounded-full bg-primary"></span>
              {/if}
            </button>
          </div>

          <!-- ═══ Tab: Structure / Documentation ═══ -->
          {#if activeTab === 'doc'}
            <div class="flex flex-col gap-4 animate-in fade-in slide-up duration-300">

              <!-- Discord-style command preview -->
              <div class="cmd-discord-preview">
                <div class="flex items-start gap-3">
                  <div class="w-9 h-9 rounded-full shrink-0 bg-gradient-to-tr from-primary to-secondary flex items-center justify-center text-white font-bold text-sm select-none">K</div>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-1.5">
                      <span class="font-semibold text-sm text-[#f2f3f5]">Kotbo</span>
                      <span class="inline-flex items-center gap-0.5 text-[9px] font-bold px-1 py-px rounded bg-[#5865F2] text-white uppercase leading-none">Bot</span>
                      <span class="text-[10px] text-[#949ba4] ml-1">Maintenant</span>
                    </div>
                    <div class="mt-1.5 space-y-1">
                      {#if hasSubcommands}
                        {#each selectedCatalogEntry.options.filter((opt: any) => opt.type === 1 || opt.type === 2) as sub}
                          <div class="cmd-discord-sig">{buildCommandSignature(selectedCatalogEntry.name, sub.name, sub.options)}</div>
                        {/each}
                      {:else}
                        <div class="cmd-discord-sig">{buildCommandSignature(selectedCatalogEntry.name, undefined, selectedCatalogEntry.options)}</div>
                      {/if}
                    </div>
                  </div>
                </div>
              </div>

              <!-- Subcommands accordion or direct params -->
              {#if hasSubcommands}
                <div class="flex flex-col gap-2">
                  <p class="section-label px-1">{m.commands_heading_subcommands()}</p>
                  {#each selectedCatalogEntry.options.filter((opt: any) => opt.type === 1 || opt.type === 2) as sub}
                    <div class="cmd-accordion section-card !rounded-lg overflow-hidden">
                      <button
                        type="button"
                        onclick={() => toggleSubExpand(sub.name)}
                        class="cmd-accordion-header"
                      >
                        <div class="flex items-center gap-2.5 min-w-0">
                          <span class="badge badge-warning !text-[9px]">Sub</span>
                          <span class="font-mono text-sm font-semibold text-on-surface">/{selectedCatalogEntry.name} {sub.name}</span>
                        </div>
                        <div class="flex items-center gap-2">
                          {#if sub.options && sub.options.length > 0}
                            <span class="badge badge-neutral !text-[9px]">{m.commands_params_count({ count: sub.options.length })}</span>
                          {/if}
                          <Papicon
                            icon="ChevronDown"
                            size={16}
                            class="text-on-surface-variant/50 transition-transform duration-200 {expandedSubs.has(sub.name) ? 'rotate-180' : ''}"
                          />
                        </div>
                      </button>

                      {#if expandedSubs.has(sub.name)}
                        <div class="cmd-accordion-body animate-in fade-in slide-up duration-200">
                          <p class="text-xs text-on-surface-variant mb-3">{sub.description || m.commands_no_desc()}</p>
                          
                          {#if sub.options && sub.options.length > 0}
                            <table class="data-table">
                              <thead>
                                <tr>
                                  <th>{m.commands_th_param()}</th>
                                  <th>{m.commands_th_type()}</th>
                                  <th>{m.commands_th_status()}</th>
                                  <th>{m.commands_th_description()}</th>
                                </tr>
                              </thead>
                              <tbody>
                                {#each sub.options as opt}
                                  <tr>
                                    <td class="font-mono font-semibold text-on-surface">{opt.name}</td>
                                    <td><span class="badge {getOptionTypeBadgeClass(opt.type)} !text-[9px]">{getOptionTypeLabel(opt.type)}</span></td>
                                    <td>
                                      {#if opt.required}
                                        <span class="text-error font-semibold text-xs">{m.commands_required()}</span>
                                      {:else}
                                        <span class="text-on-surface-variant/50 text-xs">{m.commands_optional()}</span>
                                      {/if}
                                    </td>
                                    <td class="text-on-surface-variant text-xs">{opt.description || '-'}</td>
                                  </tr>
                                {/each}
                              </tbody>
                            </table>
                          {:else}
                            <p class="text-xs text-on-surface-variant/50 italic">{m.commands_no_params()}</p>
                          {/if}
                        </div>
                      {/if}
                    </div>
                  {/each}
                </div>
              {:else if selectedCatalogEntry.options && selectedCatalogEntry.options.length > 0}
                <div class="flex flex-col gap-2">
                  <p class="section-label px-1">{m.commands_heading_params()}</p>
                  <div class="section-card !rounded-lg overflow-hidden">
                    <table class="data-table">
                      <thead>
                        <tr>
                          <th>{m.commands_th_param()}</th>
                          <th>{m.commands_th_type()}</th>
                          <th>{m.commands_th_status()}</th>
                          <th>{m.commands_th_description()}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {#each selectedCatalogEntry.options as opt}
                          <tr>
                            <td class="font-mono font-semibold text-on-surface">{opt.name}</td>
                            <td><span class="badge {getOptionTypeBadgeClass(opt.type)} !text-[9px]">{getOptionTypeLabel(opt.type)}</span></td>
                            <td>
                              {#if opt.required}
                                <span class="text-error font-semibold text-xs">{m.commands_required()}</span>
                              {:else}
                                <span class="text-on-surface-variant/50 text-xs">{m.commands_optional()}</span>
                              {/if}
                            </td>
                            <td class="text-on-surface-variant text-xs">{opt.description || '-'}</td>
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  </div>
                </div>
              {:else}
                <div class="section-card !rounded-lg flex items-center justify-center p-8 text-center">
                  <p class="text-sm text-on-surface-variant/50 italic">{m.commands_no_params_or_subs()}</p>
                </div>
              {/if}
            </div>

          {:else}
            <!-- ═══ Tab: Permissions ═══ -->
            <div class="flex flex-col gap-4 animate-in fade-in slide-up duration-300">

              {#if hasConflicts}
                <div class="cmd-conflict-banner">
                  <Papicon icon="alert-triangle" size={18} class="text-amber-500 shrink-0 mt-0.5" />
                  <div class="flex-1">
                    <p class="font-semibold text-sm text-on-surface">{m.commands_conflict_title()}</p>
                    <p class="text-xs text-on-surface-variant mt-0.5">{m.commands_conflict_desc()}</p>
                    <button
                      type="button"
                      onclick={resolveDraftConflicts}
                      disabled={!canManageSettings || !selectedCommandName}
                      class="mt-2 px-3 py-1 rounded-md bg-amber-600 text-white text-[10px] font-semibold uppercase tracking-wider hover:bg-amber-700 transition-colors disabled:opacity-50"
                    >
                      {m.commands_resolve_conflicts_btn()}
                    </button>
                  </div>
                </div>
              {/if}

              <!-- Quick actions bar -->
              <div class="flex flex-wrap items-center justify-between gap-3 px-4 py-3 rounded-lg bg-surface-container/60 border border-outline-variant/30">
                <span class="section-label">{m.commands_quick_actions()}</span>
                <div class="flex flex-wrap gap-1.5">
                  <button type="button" onclick={clearChannels} disabled={!canManageSettings} class="cmd-quick-btn">{m.commands_clear_channels()}</button>
                  <button type="button" onclick={clearRoles} disabled={!canManageSettings} class="cmd-quick-btn">{m.commands_clear_roles()}</button>
                  <button type="button" onclick={clearUsers} disabled={!canManageSettings} class="cmd-quick-btn">{m.commands_clear_members()}</button>
                  <button type="button" onclick={clearAllRules} disabled={!canManageSettings} class="cmd-quick-btn cmd-quick-btn--danger">{m.commands_clear_all()}</button>
                </div>
              </div>

              <!-- Permission sections grid -->
              <div class="grid grid-cols-1 md:grid-cols-3 gap-4">

                <!-- Channels section -->
                <div class="cmd-perm-section">
                  <div class="flex items-center justify-between gap-2 mb-3">
                    <div class="flex items-center gap-2">
                      <Papicon icon="TextBubble" size={14} class="text-on-surface-variant/60" />
                      <span class="section-label">{m.commands_sec_channels()}</span>
                    </div>
                    <div class="tab-group !p-0.5 !gap-px">
                      <button type="button" onclick={() => setChannelMode('neutral')} disabled={!canManageSettings} class="tab-button !px-2 !py-0.5 !text-[10px] {channelMode === 'neutral' ? 'active' : ''}">{m.common_all()}</button>
                      <button type="button" onclick={() => setChannelMode('allowedOnly')} disabled={!canManageSettings} class="tab-button !px-2 !py-0.5 !text-[10px] cmd-mode-allow {channelMode === 'allowedOnly' ? 'active cmd-mode-allow--active' : ''}">✓</button>
                      <button type="button" onclick={() => setChannelMode('blockedOnly')} disabled={!canManageSettings} class="tab-button !px-2 !py-0.5 !text-[10px] cmd-mode-block {channelMode === 'blockedOnly' ? 'active cmd-mode-block--active' : ''}">✕</button>
                    </div>
                  </div>

                  <AccessEntitySelector
                    id="channels-selector"
                    options={channelOptions}
                    selectedIds={selectedChannelIds}
                    disabled={channelSelectionDisabled}
                    placeholder={channelMode === 'neutral' ? m.commands_ph_all_channels() : channelMode === 'allowedOnly' ? m.commands_ph_allowed_channels() : m.commands_ph_blocked_channels()}
                    onToggle={toggleChannelSelection}
                  />

                  <p class="text-[11px] text-on-surface-variant/50 mt-2 leading-relaxed">
                    {#if channelMode === 'neutral'}
                      {m.commands_help_channels_neutral()}
                    {:else}
                      {channelMode === 'allowedOnly' ? m.commands_help_channels_allow() : m.commands_help_channels_block()}
                    {/if}
                  </p>
                </div>

                <!-- Roles section -->
                <div class="cmd-perm-section">
                  <div class="flex items-center justify-between gap-2 mb-3">
                    <div class="flex items-center gap-2">
                      <Papicon icon="User" size={14} class="text-on-surface-variant/60" />
                      <span class="section-label">{m.commands_sec_roles()}</span>
                    </div>
                    <div class="tab-group !p-0.5 !gap-px">
                      <button type="button" onclick={() => setRoleMode('neutral')} disabled={!canManageSettings} class="tab-button !px-2 !py-0.5 !text-[10px] {roleMode === 'neutral' ? 'active' : ''}">{m.common_all()}</button>
                      <button type="button" onclick={() => setRoleMode('allowedOnly')} disabled={!canManageSettings} class="tab-button !px-2 !py-0.5 !text-[10px] cmd-mode-allow {roleMode === 'allowedOnly' ? 'active cmd-mode-allow--active' : ''}">✓</button>
                      <button type="button" onclick={() => setRoleMode('blockedOnly')} disabled={!canManageSettings} class="tab-button !px-2 !py-0.5 !text-[10px] cmd-mode-block {roleMode === 'blockedOnly' ? 'active cmd-mode-block--active' : ''}">✕</button>
                    </div>
                  </div>

                  <AccessEntitySelector
                    id="roles-selector"
                    options={roleOptions}
                    selectedIds={selectedRoleIds}
                    disabled={roleSelectionDisabled}
                    placeholder={roleMode === 'neutral' ? m.commands_ph_all_roles() : roleMode === 'allowedOnly' ? m.commands_ph_allowed_roles() : m.commands_ph_blocked_roles()}
                    onToggle={toggleRoleSelection}
                  />

                  <p class="text-[11px] text-on-surface-variant/50 mt-2 leading-relaxed">
                    {#if roleMode === 'neutral'}
                      {m.commands_help_roles_neutral()}
                    {:else if roleMode === 'allowedOnly'}
                      {m.commands_help_roles_allowed({ count: selectedRoleIds.length })}
                    {:else}
                      {m.commands_help_roles_blocked({ count: selectedRoleIds.length })}
                    {/if}
                  </p>
                </div>

                <!-- Members section -->
                <div class="cmd-perm-section">
                  <div class="flex items-center justify-between gap-2 mb-3">
                    <div class="flex items-center gap-2">
                      <Papicon icon="user" size={14} class="text-on-surface-variant/60" />
                      <span class="section-label">{m.commands_sec_members()}</span>
                    </div>
                    <div class="tab-group !p-0.5 !gap-px">
                      <button type="button" onclick={() => setUserMode('neutral')} disabled={!canManageSettings} class="tab-button !px-2 !py-0.5 !text-[10px] {userMode === 'neutral' ? 'active' : ''}">{m.common_all()}</button>
                      <button type="button" onclick={() => setUserMode('allowedOnly')} disabled={!canManageSettings} class="tab-button !px-2 !py-0.5 !text-[10px] cmd-mode-allow {userMode === 'allowedOnly' ? 'active cmd-mode-allow--active' : ''}">✓</button>
                      <button type="button" onclick={() => setUserMode('blockedOnly')} disabled={!canManageSettings} class="tab-button !px-2 !py-0.5 !text-[10px] cmd-mode-block {userMode === 'blockedOnly' ? 'active cmd-mode-block--active' : ''}">✕</button>
                    </div>
                  </div>

                  <div class="flex flex-col gap-2">
                    <div class="flex items-center gap-1.5">
                      <input
                        type="text"
                        bind:value={userIdInput}
                        placeholder={m.commands_ph_user_id()}
                        disabled={userSelectionDisabled}
                        class="cmd-user-input"
                      />
                      <button
                        type="button"
                        onclick={addUserId}
                        disabled={userSelectionDisabled || !userIdInput.trim()}
                        class="cmd-user-add-btn"
                      >
                        <Papicon icon="Plus" size={14} />
                      </button>
                    </div>

                    <div class="max-h-24 overflow-y-auto space-y-1 pr-0.5 custom-scrollbar">
                      {#if selectedUserIds.length === 0}
                        <p class="text-[10px] text-on-surface-variant/40 italic py-1.5">
                          {userMode === 'neutral' ? m.commands_empty_users_neutral() : m.commands_empty_users_configured()}
                        </p>
                      {:else}
                        {#each selectedUserIds as uId}
                          <div class="cmd-user-chip">
                            <span class="font-mono text-[11px] text-on-surface/80">{uId}</span>
                            <button
                              type="button"
                              onclick={() => removeUserId(uId)}
                              disabled={userSelectionDisabled}
                              class="text-error/60 hover:text-error transition-colors disabled:opacity-50"
                            >
                              <Papicon icon="x" size={12} />
                            </button>
                          </div>
                        {/each}
                      {/if}
                    </div>
                  </div>

                  <p class="text-[11px] text-on-surface-variant/50 mt-2 leading-relaxed">
                    {#if userMode === 'neutral'}
                      {m.commands_help_users_neutral()}
                    {:else if userMode === 'allowedOnly'}
                      {m.commands_help_users_allowed({ count: selectedUserIds.length })}
                    {:else}
                      {m.commands_help_users_blocked({ count: selectedUserIds.length })}
                    {/if}
                  </p>
                </div>
              </div>

              <!-- Rule summary -->
              <div class="glass-panel rounded-lg p-4">
                <div class="flex items-center gap-2 mb-3">
                  <Papicon icon="Paper" size={14} class="text-primary" />
                  <span class="text-xs font-semibold text-on-surface">{m.commands_summary_heading()}</span>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 text-[11px] text-on-surface-variant">
                  <div>
                    <span class="font-semibold text-on-surface/80">{m.commands_summary_channels()}</span>
                    {#if channelMode === 'neutral'}
                      {m.common_all()}
                    {:else}
                      {channelMode === 'allowedOnly' ? m.commands_summary_only({ count: selectedChannelIds.length }) : m.commands_summary_blocked({ count: selectedChannelIds.length })}
                    {/if}
                  </div>
                  <div>
                    <span class="font-semibold text-on-surface/80">{m.commands_summary_roles()}</span>
                    {#if roleMode === 'neutral'}
                      {m.common_all()}
                    {:else}
                      {roleMode === 'allowedOnly' ? m.commands_summary_only({ count: selectedRoleIds.length }) : m.commands_summary_blocked({ count: selectedRoleIds.length })}
                    {/if}
                  </div>
                  <div>
                    <span class="font-semibold text-on-surface/80">{m.commands_summary_members()}</span>
                    {#if userMode === 'neutral'}
                      {m.common_all()}
                    {:else}
                      {userMode === 'allowedOnly' ? m.commands_summary_only({ count: selectedUserIds.length }) : m.commands_summary_blocked({ count: selectedUserIds.length })}
                    {/if}
                  </div>
                </div>
              </div>
            </div>
          {/if}

          <!-- Footer feedback -->
          <div class="flex items-center justify-between gap-3 pt-4 border-t border-outline-variant/30">
            <InlineFeedback
              message={saveAction.state.message}
              error={saveAction.state.error}
              idleText={m.commands_footer_idle_text()}
            />
          </div>
        </div>
      {/if}
    </div>
  </div>
</ModulePage>

<style>
  /* ─── Custom scrollbar ─── */
  .custom-scrollbar::-webkit-scrollbar { width: 5px; height: 5px; }
  .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
  .custom-scrollbar::-webkit-scrollbar-thumb { background: var(--outline-variant); border-radius: 10px; }
  .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: var(--outline); }

  /* ─── Category button ─── */
  .cmd-cat-btn {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 0.5rem 0.625rem;
    border-radius: 0.5rem;
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--on-surface-variant);
    transition: all 0.15s ease;
    cursor: pointer;
    border: none;
    background: transparent;
    text-align: left;
  }
  .cmd-cat-btn:hover {
    background: var(--surface-hover);
    color: var(--on-surface);
  }
  .cmd-cat-btn--active {
    background: var(--color-primary) !important;
    color: var(--on-primary-color) !important;
    font-weight: 600;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  }
  .cmd-cat-count {
    font-size: 0.625rem;
    font-weight: 600;
    padding: 0.125rem 0.375rem;
    border-radius: 9999px;
    background: var(--surface-container);
    color: var(--on-surface-variant);
  }
  .cmd-cat-count--active {
    background: rgba(255, 255, 255, 0.2) !important;
    color: var(--on-primary-color) !important;
  }

  /* ─── Search input ─── */
  .cmd-search-input {
    width: 100%;
    padding: 0.5rem 0.75rem 0.5rem 2.25rem;
    border-radius: 0.5rem;
    border: 1px solid var(--outline-variant);
    background: var(--surface-container-low);
    font-size: 0.8125rem;
    color: var(--on-surface);
    outline: none;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .cmd-search-input::placeholder {
    color: var(--on-surface-variant);
    opacity: 0.5;
  }
  .cmd-search-input:focus {
    border-color: var(--color-primary);
    box-shadow: 0 0 0 3px rgba(79, 70, 229, 0.08);
  }

  /* ─── Command list ─── */
  .cmd-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-height: 50vh;
    overflow-y: auto;
    padding-right: 0.25rem;
  }

  /* ─── Command item ─── */
  .cmd-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    width: 100%;
    padding: 0.625rem 0.75rem;
    border-radius: 0.5rem;
    border: 1px solid transparent;
    background: transparent;
    text-align: left;
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .cmd-item:hover {
    background: var(--surface-hover);
    border-color: var(--outline-variant);
  }
  .cmd-item--selected {
    background: var(--surface-selection) !important;
    border-color: var(--color-primary) !important;
    box-shadow: 0 0 0 1px var(--color-primary);
  }
  .cmd-item-name {
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--on-surface);
    white-space: nowrap;
  }
  .cmd-item-desc {
    font-size: 0.6875rem;
    color: var(--on-surface-variant);
    opacity: 0.7;
    margin-top: 0.125rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 200px;
  }

  /* ─── Discord preview ─── */
  .cmd-discord-preview {
    background: #313338;
    border-radius: 0.625rem;
    padding: 0.875rem 1rem;
    border: 1px solid rgba(0, 0, 0, 0.15);
  }
  .cmd-discord-sig {
    background: #2b2d31;
    padding: 0.375rem 0.625rem;
    border-radius: 0.375rem;
    border: 1px solid #1e1f22;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8125rem;
    color: #00b0f4;
    line-height: 1.4;
    word-break: break-all;
  }

  /* ─── Accordion ─── */
  .cmd-accordion-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 0.75rem 1rem;
    background: transparent;
    border: none;
    cursor: pointer;
    transition: background 0.15s ease;
    text-align: left;
    gap: 0.5rem;
  }
  .cmd-accordion-header:hover {
    background: var(--surface-hover);
  }
  .cmd-accordion-body {
    padding: 0 1rem 1rem;
  }

  /* ─── Conflict banner ─── */
  .cmd-conflict-banner {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    padding: 0.875rem 1rem;
    border-radius: 0.5rem;
    border: 1px solid rgba(245, 158, 11, 0.2);
    background: rgba(245, 158, 11, 0.06);
  }

  /* ─── Quick action button ─── */
  .cmd-quick-btn {
    padding: 0.25rem 0.5rem;
    border-radius: 0.375rem;
    border: 1px solid var(--outline-variant);
    background: transparent;
    font-size: 0.625rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--on-surface-variant);
    cursor: pointer;
    transition: all 0.15s ease;
  }
  .cmd-quick-btn:hover {
    background: var(--surface-hover);
    color: var(--on-surface);
  }
  .cmd-quick-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .cmd-quick-btn--danger {
    border-color: rgba(220, 38, 38, 0.2);
    color: var(--color-error);
  }
  .cmd-quick-btn--danger:hover {
    background: rgba(220, 38, 38, 0.06);
  }

  /* ─── Permission section ─── */
  .cmd-perm-section {
    padding: 1rem;
    border-radius: 0.625rem;
    border: 1px solid var(--outline-variant);
    background: var(--surface-container-lowest);
  }

  /* ─── Mode buttons (allow/block active states) ─── */
  .cmd-mode-allow--active {
    background: rgb(16, 185, 129) !important;
    color: white !important;
  }
  .cmd-mode-block--active {
    background: var(--color-error) !important;
    color: white !important;
  }

  /* ─── User input & chips ─── */
  .cmd-user-input {
    flex: 1;
    padding: 0.375rem 0.625rem;
    border-radius: 0.375rem;
    border: 1px solid var(--outline-variant);
    background: var(--surface-container-low);
    font-size: 0.75rem;
    color: var(--on-surface);
    outline: none;
    transition: border-color 0.15s ease;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .cmd-user-input:focus {
    border-color: var(--color-primary);
  }
  .cmd-user-input:disabled {
    opacity: 0.5;
  }
  .cmd-user-add-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: 0.375rem;
    background: var(--color-primary);
    color: var(--on-primary-color);
    border: none;
    cursor: pointer;
    transition: opacity 0.15s ease;
    flex-shrink: 0;
  }
  .cmd-user-add-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .cmd-user-chip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.25rem 0.5rem;
    border-radius: 0.375rem;
    border: 1px solid var(--outline-variant);
    background: var(--surface-container-lowest);
  }
</style>