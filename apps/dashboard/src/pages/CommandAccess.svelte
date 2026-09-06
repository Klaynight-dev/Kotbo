<script lang="ts">
  import { m } from '../lib/i18n';
  import { onMount, onDestroy, untrack } from 'svelte';
  import { unsavedChanges } from '../lib/stores/unsavedChanges.svelte';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { updateCommandAccessSettings } from '../lib/api';
  import { roleDotColor } from '../lib/discordVisuals';
  import InlineFeedback from '../lib/components/InlineFeedback.svelte';
  import ToggleSwitch from '../lib/components/ToggleSwitch.svelte';
  import { createAsyncActionState } from '../lib/asyncAction.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';

  type Rule = {
    commandName: string;
    enabled: boolean;
    allowedChannelIds: string[];
    blockedChannelIds: string[];
    allowedRoleIds: string[];
    blockedRoleIds: string[];
    allowedUserIds: string[];
    blockedUserIds: string[];
  };

  const availableChannels = $derived(dashboardStore.state.discordChannels || []);
  const availableRoles = $derived(dashboardStore.state.discordRoles || []);
  const commandCatalog = $derived(dashboardStore.state.commandCatalog || []);
  const canManageSettings = $derived(
    !!dashboardStore.state.featureAccess?.commands?.canConfigure
      || !!dashboardStore.state.access?.canManageSettings
  );

  const saveAction = createAsyncActionState();

  /** Regles en cours d'edition, indexees par nom de commande. */
  let rules = $state<Record<string, Rule>>({});
  let savedSnapshot = $state('[]');
  let commandSearch = $state('');
  let catalogFilter = $state<string>('all');
  /** Cles `${commande}:${section}` des accordeons ouverts. */
  let expanded = $state<Set<string>>(new Set());
  let userIdInputs = $state<Record<string, string>>({});

  const emptyRule = (commandName: string): Rule => ({
    commandName,
    enabled: true,
    allowedChannelIds: [],
    blockedChannelIds: [],
    allowedRoleIds: [],
    blockedRoleIds: [],
    allowedUserIds: [],
    blockedUserIds: [],
  });

  const cloneRule = (rule: any): Rule => ({
    commandName: rule.commandName,
    enabled: rule.enabled !== false,
    allowedChannelIds: [...(rule.allowedChannelIds || [])],
    blockedChannelIds: [...(rule.blockedChannelIds || [])],
    allowedRoleIds: [...(rule.allowedRoleIds || [])],
    blockedRoleIds: [...(rule.blockedRoleIds || [])],
    allowedUserIds: [...(rule.allowedUserIds || [])],
    blockedUserIds: [...(rule.blockedUserIds || [])],
  });

  /** Une regle neutre (activee, sans liste) n'a pas a etre persistee. */
  const isMeaningful = (rule: Rule) =>
    !rule.enabled
    || rule.allowedChannelIds.length > 0
    || rule.blockedChannelIds.length > 0
    || rule.allowedRoleIds.length > 0
    || rule.blockedRoleIds.length > 0
    || rule.allowedUserIds.length > 0
    || rule.blockedUserIds.length > 0;

  const serializeRules = (source: Record<string, Rule>) => JSON.stringify(
    Object.values(source)
      .filter(isMeaningful)
      .sort((a, b) => a.commandName.localeCompare(b.commandName))
  );

  const payload = $derived(Object.values(rules).filter(isMeaningful));
  const currentSnapshot = $derived(serializeRules(rules));
  const isDirty = $derived(currentSnapshot !== savedSnapshot);

  function hydrateFromStore() {
    const next: Record<string, Rule> = {};
    for (const rule of dashboardStore.state.commandRestrictions || []) {
      if (rule?.commandName) next[rule.commandName] = cloneRule(rule);
    }
    rules = next;
    savedSnapshot = serializeRules(next);
  }

  function ruleFor(commandName: string): Rule {
    return rules[commandName] ?? emptyRule(commandName);
  }

  function patchRule(commandName: string, patch: Partial<Rule>) {
    if (!canManageSettings) return;
    rules = { ...rules, [commandName]: { ...ruleFor(commandName), ...patch } };
  }

  function toggleId(commandName: string, key: 'allowedChannelIds' | 'blockedChannelIds' | 'allowedRoleIds' | 'blockedRoleIds' | 'allowedUserIds' | 'blockedUserIds', id: string) {
    const rule = ruleFor(commandName);
    const list = rule[key];
    const next = list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
    patchRule(commandName, { [key]: next } as Partial<Rule>);
  }

  function toggleCommand(commandName: string, enabled: boolean) {
    patchRule(commandName, { enabled });
  }

  function resetCommand(commandName: string) {
    if (!canManageSettings) return;
    const next = { ...rules };
    delete next[commandName];
    rules = next;
  }

  function toggleSection(key: string) {
    const next = new Set(expanded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    expanded = next;
  }

  function addUserId(commandName: string, key: 'allowedUserIds' | 'blockedUserIds') {
    const raw = (userIdInputs[commandName] || '').replace(/[^0-9]/g, '');
    if (!raw) return;
    const rule = ruleFor(commandName);
    if (!rule[key].includes(raw)) {
      patchRule(commandName, { [key]: [...rule[key], raw] } as Partial<Rule>);
    }
    userIdInputs = { ...userIdInputs, [commandName]: '' };
  }

  const roleName = (id: string) => availableRoles.find((role: any) => role.id === id)?.name || id;
  const channelName = (id: string) => availableChannels.find((channel: any) => channel.id === id)?.name || id;

  function summaryFor(ids: string[], resolve: (id: string) => string, fallback: string) {
    if (ids.length === 0) return fallback;
    if (ids.length <= 3) return ids.map(resolve).join(', ');
    return `${ids.slice(0, 2).map(resolve).join(', ')} +${ids.length - 2}`;
  }

  function restrictionCount(rule: Rule) {
    return rule.allowedChannelIds.length + rule.blockedChannelIds.length
      + rule.allowedRoleIds.length + rule.blockedRoleIds.length
      + rule.allowedUserIds.length + rule.blockedUserIds.length;
  }

  const disabledCount = $derived(Object.values(rules).filter((rule) => !rule.enabled).length);
  const restrictedCount = $derived(
    Object.values(rules).filter((rule) => rule.enabled && restrictionCount(rule) > 0).length
  );

  const categories = $derived([
    { id: 'all', name: m.commands_cat_all() },
    { id: 'Administration', name: m.commands_cat_admin() },
    { id: 'Modération', name: m.commands_cat_moderation() },
    { id: 'Économie', name: m.commands_cat_economy() },
    { id: 'Utilitaire', name: m.commands_cat_utility() },
    { id: 'Communauté', name: m.commands_cat_community() },
    { id: 'Fun', name: m.commands_cat_fun() },
    { id: 'active', name: m.commands_filter_active() },
    { id: 'disabled', name: m.commands_filter_disabled() },
  ]);

  const filteredCommands = $derived.by(() => {
    const search = commandSearch.trim().toLowerCase();

    return commandCatalog
      .filter((command: any) => {
        const rule = rules[command.name];
        if (catalogFilter === 'active' && !(rule && restrictionCount(rule) > 0)) return false;
        if (catalogFilter === 'disabled' && rule?.enabled !== false) return false;
        if (catalogFilter !== 'all' && catalogFilter !== 'active' && catalogFilter !== 'disabled'
          && (command.category || 'Autre') !== catalogFilter) return false;
        if (!search) return true;
        return command.name.toLowerCase().includes(search)
          || (command.label || '').toLowerCase().includes(search)
          || (command.description || '').toLowerCase().includes(search);
      })
      .sort((a: any, b: any) => a.name.localeCompare(b.name, 'fr'));
  });

  const subcommandsOf = (command: any) =>
    (command.options || []).filter((opt: any) => opt.type === 1 || opt.type === 2);

  function buildSignature(name: string, subName?: string, options?: any[]): string {
    const parts = [`/${name}`];
    if (subName) parts.push(subName);
    for (const opt of options || []) {
      if (opt.type === 1 || opt.type === 2) continue;
      parts.push(opt.required ? `<${opt.name}>` : `[${opt.name}]`);
    }
    return parts.join(' ');
  }

  async function save(): Promise<boolean> {
    if (!canManageSettings) {
      saveAction.setError(m.commands_err_admin_only());
      return false;
    }

    let success = false;
    await saveAction.run(
      async () => {
        const saved = await updateCommandAccessSettings(payload);
        if (!saved) return false;
        await dashboardStore.refresh();
        hydrateFromStore();
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

  $effect(() => {
    const dirty = isDirty;
    if (dirty && canManageSettings) {
      untrack(() => {
        unsavedChanges.register({
          id: 'command-access',
          label: m.commands_unsaved_label(),
          onSave: () => save(),
          onReset: () => hydrateFromStore(),
        });
      });
    } else if (!dirty) {
      untrack(() => unsavedChanges.release('command-access'));
    }
  });

  onDestroy(() => unsavedChanges.release('command-access'));

  onMount(async () => {
    await dashboardStore.refresh();
    hydrateFromStore();
  });
</script>

<ModulePage
  title={m.commands_page_title()}
  description={m.commands_page_desc()}
  icon="terminal"
  featureKey="commands"
>
  {#snippet actions()}
    <div class="flex items-center gap-3">
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
          <span class="text-sm font-semibold text-primary">{restrictedCount}</span>
        </div>
      </div>
      <div class="stat-kpi flex items-center gap-2.5 !py-1.5 !px-3">
        <Papicon icon="Power" size={14} class="text-error" />
        <div class="flex flex-col">
          <span class="section-label !text-[9px]">{m.commands_kpi_disabled()}</span>
          <span class="text-sm font-semibold text-on-surface">{disabledCount}</span>
        </div>
      </div>
    </div>
  {/snippet}

  <InlineFeedback state={saveAction} />

  <div class="flex flex-col gap-5">

    <!-- Rappel : Discord reste maitre des permissions natives -->
    <div class="cmd-notice">
      <Papicon icon="Info" size={16} class="shrink-0 mt-0.5 text-on-surface-variant" />
      <p>{m.commands_info_discord()}</p>
    </div>

    <!-- Filtres + recherche -->
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex flex-wrap items-center gap-1.5">
        {#each categories as cat (cat.id)}
          <button
            type="button"
            onclick={() => { catalogFilter = cat.id; }}
            class="cmd-chip {catalogFilter === cat.id ? 'cmd-chip--active' : ''}"
          >
            {cat.name}
          </button>
        {/each}
      </div>

      <div class="relative w-full sm:w-64 shrink-0">
        <Papicon icon="Search" size={15} class="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant/50" />
        <input
          type="text"
          bind:value={commandSearch}
          placeholder={m.commands_search_ph()}
          class="cmd-search-input"
        />
      </div>
    </div>

    <!-- Liste des commandes -->
    {#if filteredCommands.length === 0}
      <div class="section-card flex flex-col items-center justify-center py-14 text-center">
        <Papicon icon="Search" size={28} class="text-on-surface-variant/30 mb-2" />
        <p class="text-sm text-on-surface-variant/60">{m.commands_no_results()}</p>
      </div>
    {:else}
      <div class="flex flex-col gap-3">
        {#each filteredCommands as command (command.name)}
          {@const rule = ruleFor(command.name)}
          {@const rolesKey = `${command.name}:roles`}
          {@const advKey = `${command.name}:advanced`}
          {@const docKey = `${command.name}:doc`}
          {@const subs = subcommandsOf(command)}
          <section class="cmd-card {rule.enabled ? '' : 'cmd-card--off'}">

            <!-- En-tete : nom, description, interrupteur -->
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <code class="cmd-code">/{command.name}</code>
                  {#if restrictionCount(rule) > 0}
                    <span class="badge badge-success !text-[9px]">{restrictionCount(rule)}</span>
                  {/if}
                  {#if !rule.enabled}
                    <span class="badge badge-danger !text-[9px]">{m.commands_badge_disabled()}</span>
                  {/if}
                </div>
                <p class="mt-1.5 text-sm text-on-surface-variant/80">
                  {command.description || command.label || m.commands_no_desc()}
                </p>
              </div>

              <ToggleSwitch
                checked={rule.enabled}
                disabled={!canManageSettings}
                ariaLabel={m.commands_toggle_aria({ name: command.name })}
                onToggle={(value) => toggleCommand(command.name, value)}
              />
            </div>

            {#if !rule.enabled}
              <p class="cmd-off-note">{m.commands_disabled_notice()}</p>
            {:else}
              <!-- Roles autorises -->
              <div class="cmd-accordion">
                <div
                  role="button"
                  tabindex="0"
                  aria-expanded={expanded.has(rolesKey)}
                  onclick={() => toggleSection(rolesKey)}
                  onkeydown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      toggleSection(rolesKey);
                    }
                  }}
                  class="cmd-accordion-head"
                >
                  <span class="cmd-accordion-icon">
                    <Papicon icon="users" size={16} />
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block text-sm font-semibold text-on-surface">{m.commands_roles_allowed()}</span>
                    <span class="mt-0.5 block truncate text-xs text-on-surface-variant/70">
                      {summaryFor(rule.allowedRoleIds, roleName, m.commands_roles_all())}
                    </span>
                  </span>
                  <Papicon
                    icon="ChevronDown"
                    size={16}
                    class="shrink-0 text-on-surface-variant/50 transition-transform duration-200 {expanded.has(rolesKey) ? 'rotate-180' : ''}"
                  />
                </div>

                {#if expanded.has(rolesKey)}
                  <div class="cmd-accordion-body">
                    <div class="cmd-picker custom-scrollbar">
                      {#each availableRoles as role (role.id)}
                        <button
                          type="button"
                          disabled={!canManageSettings}
                          onclick={() => toggleId(command.name, 'allowedRoleIds', role.id)}
                          class="cmd-option {rule.allowedRoleIds.includes(role.id) ? 'cmd-option--on' : ''}"
                        >
                          <span class="cmd-check {rule.allowedRoleIds.includes(role.id) ? 'cmd-check--on' : ''}">
                            {#if rule.allowedRoleIds.includes(role.id)}
                              <Papicon icon="Check" size={11} />
                            {/if}
                          </span>
                          <span class="cmd-dot" style="background-color: {roleDotColor(role.color)};"></span>
                          <span class="truncate">{role.name}</span>
                        </button>
                      {/each}
                    </div>
                    <p class="cmd-hint">{m.commands_roles_hint()}</p>
                  </div>
                {/if}
              </div>

              <!-- Restrictions avancees : salons, roles bloques, membres -->
              <div class="cmd-accordion">
                <div
                  role="button"
                  tabindex="0"
                  aria-expanded={expanded.has(advKey)}
                  onclick={() => toggleSection(advKey)}
                  onkeydown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      toggleSection(advKey);
                    }
                  }}
                  class="cmd-accordion-head"
                >
                  <span class="cmd-accordion-icon">
                    <Papicon icon="Gears" size={16} />
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block text-sm font-semibold text-on-surface">{m.commands_advanced()}</span>
                    <span class="mt-0.5 block truncate text-xs text-on-surface-variant/70">
                      {summaryFor(rule.allowedChannelIds, channelName, m.commands_advanced_summary())}
                    </span>
                  </span>
                  <Papicon
                    icon="ChevronDown"
                    size={16}
                    class="shrink-0 text-on-surface-variant/50 transition-transform duration-200 {expanded.has(advKey) ? 'rotate-180' : ''}"
                  />
                </div>

                {#if expanded.has(advKey)}
                  <div class="cmd-accordion-body flex flex-col gap-4">

                    <div class="grid gap-4 md:grid-cols-2">
                      <div>
                        <p class="section-label mb-1.5">{m.commands_channels_allowed()}</p>
                        <div class="cmd-picker custom-scrollbar">
                          {#each availableChannels as channel (channel.id)}
                            <button
                              type="button"
                              disabled={!canManageSettings}
                              onclick={() => toggleId(command.name, 'allowedChannelIds', channel.id)}
                              class="cmd-option {rule.allowedChannelIds.includes(channel.id) ? 'cmd-option--on' : ''}"
                            >
                              <span class="cmd-check {rule.allowedChannelIds.includes(channel.id) ? 'cmd-check--on' : ''}">
                                {#if rule.allowedChannelIds.includes(channel.id)}
                                  <Papicon icon="Check" size={11} />
                                {/if}
                              </span>
                              <span class="truncate">#{channel.name}</span>
                            </button>
                          {/each}
                        </div>
                      </div>

                      <div>
                        <p class="section-label mb-1.5">{m.commands_roles_blocked()}</p>
                        <div class="cmd-picker custom-scrollbar">
                          {#each availableRoles as role (role.id)}
                            <button
                              type="button"
                              disabled={!canManageSettings}
                              onclick={() => toggleId(command.name, 'blockedRoleIds', role.id)}
                              class="cmd-option {rule.blockedRoleIds.includes(role.id) ? 'cmd-option--off' : ''}"
                            >
                              <span class="cmd-check {rule.blockedRoleIds.includes(role.id) ? 'cmd-check--off' : ''}">
                                {#if rule.blockedRoleIds.includes(role.id)}
                                  <Papicon icon="Check" size={11} />
                                {/if}
                              </span>
                              <span class="cmd-dot" style="background-color: {roleDotColor(role.color)};"></span>
                              <span class="truncate">{role.name}</span>
                            </button>
                          {/each}
                        </div>
                      </div>
                    </div>

                    <div>
                      <p class="section-label mb-1.5">{m.commands_users_section()}</p>
                      <div class="flex items-center gap-2">
                        <input
                          type="text"
                          inputmode="numeric"
                          disabled={!canManageSettings}
                          placeholder={m.commands_ph_user_id()}
                          value={userIdInputs[command.name] || ''}
                          oninput={(event) => {
                            userIdInputs = { ...userIdInputs, [command.name]: (event.currentTarget as HTMLInputElement).value };
                          }}
                          class="cmd-user-input"
                        />
                        <button
                          type="button"
                          disabled={!canManageSettings}
                          onclick={() => addUserId(command.name, 'allowedUserIds')}
                          class="cmd-mini-btn"
                        >
                          {m.commands_users_allow_btn()}
                        </button>
                        <button
                          type="button"
                          disabled={!canManageSettings}
                          onclick={() => addUserId(command.name, 'blockedUserIds')}
                          class="cmd-mini-btn cmd-mini-btn--danger"
                        >
                          {m.commands_users_block_btn()}
                        </button>
                      </div>

                      {#if rule.allowedUserIds.length > 0 || rule.blockedUserIds.length > 0}
                        <div class="mt-2 flex flex-wrap gap-1.5">
                          {#each rule.allowedUserIds as userId (userId)}
                            <button
                              type="button"
                              disabled={!canManageSettings}
                              onclick={() => toggleId(command.name, 'allowedUserIds', userId)}
                              class="cmd-tag cmd-tag--allow"
                            >
                              {userId}
                              <Papicon icon="x" size={11} />
                            </button>
                          {/each}
                          {#each rule.blockedUserIds as userId (userId)}
                            <button
                              type="button"
                              disabled={!canManageSettings}
                              onclick={() => toggleId(command.name, 'blockedUserIds', userId)}
                              class="cmd-tag cmd-tag--block"
                            >
                              {userId}
                              <Papicon icon="x" size={11} />
                            </button>
                          {/each}
                        </div>
                      {/if}
                    </div>

                    {#if restrictionCount(rule) > 0}
                      <button
                        type="button"
                        disabled={!canManageSettings}
                        onclick={() => resetCommand(command.name)}
                        class="cmd-mini-btn cmd-mini-btn--danger self-start"
                      >
                        {m.commands_clear_all()}
                      </button>
                    {/if}
                  </div>
                {/if}
              </div>

              <!-- Structure : signature et sous-commandes -->
              {#if (command.options || []).length > 0}
                <div class="cmd-accordion">
                  <div
                    role="button"
                    tabindex="0"
                    aria-expanded={expanded.has(docKey)}
                    onclick={() => toggleSection(docKey)}
                    onkeydown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        toggleSection(docKey);
                      }
                    }}
                    class="cmd-accordion-head"
                  >
                    <span class="cmd-accordion-icon">
                      <Papicon icon="Paper" size={16} />
                    </span>
                    <span class="min-w-0 flex-1">
                      <span class="block text-sm font-semibold text-on-surface">{m.commands_tab_structure()}</span>
                      <span class="mt-0.5 block truncate text-xs text-on-surface-variant/70">
                        {m.commands_params_count({ count: (command.options || []).length })}
                      </span>
                    </span>
                    <Papicon
                      icon="ChevronDown"
                      size={16}
                      class="shrink-0 text-on-surface-variant/50 transition-transform duration-200 {expanded.has(docKey) ? 'rotate-180' : ''}"
                    />
                  </div>

                  {#if expanded.has(docKey)}
                    <div class="cmd-accordion-body flex flex-col gap-2">
                      {#if subs.length > 0}
                        {#each subs as sub (sub.name)}
                          <div>
                            <div class="cmd-sig">{buildSignature(command.name, sub.name, sub.options)}</div>
                            {#if sub.description}
                              <p class="mt-1 text-xs text-on-surface-variant/70">{sub.description}</p>
                            {/if}
                          </div>
                        {/each}
                      {:else}
                        <div class="cmd-sig">{buildSignature(command.name, undefined, command.options)}</div>
                      {/if}
                    </div>
                  {/if}
                </div>
              {/if}
            {/if}
          </section>
        {/each}
      </div>
    {/if}

    <!-- Barre d'enregistrement -->
    {#if canManageSettings}
      <div class="flex items-center justify-end gap-2">
        {#if isDirty}
          <button type="button" onclick={hydrateFromStore} class="cmd-mini-btn">
            {m.common_cancel()}
          </button>
        {/if}
        <button
          type="button"
          disabled={!isDirty || saveAction.state.loading}
          onclick={save}
          class="btn-primary"
        >
          {m.common_save()}
        </button>
      </div>
    {/if}
  </div>
</ModulePage>

<style>
  .custom-scrollbar::-webkit-scrollbar { width: 5px; height: 5px; }
  .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
  .custom-scrollbar::-webkit-scrollbar-thumb { background: var(--outline-variant); border-radius: 10px; }
  .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: var(--outline); }

  .cmd-notice {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    padding: 0.75rem 1rem;
    border-radius: 0.75rem;
    border: 1px solid var(--outline-variant);
    background: var(--surface-container-low);
    font-size: 0.8125rem;
    color: var(--on-surface-variant);
  }

  .cmd-chip {
    padding: 0.3125rem 0.75rem;
    border-radius: 9999px;
    border: 1px solid transparent;
    background: transparent;
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--on-surface-variant);
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }
  .cmd-chip:hover { background: var(--surface-hover); color: var(--on-surface); }
  .cmd-chip--active {
    border-color: var(--outline);
    background: var(--surface-hover);
    color: var(--on-surface);
    font-weight: 600;
  }

  .cmd-search-input {
    width: 100%;
    padding: 0.5rem 0.75rem 0.5rem 2.25rem;
    border-radius: 0.5rem;
    border: 1px solid var(--outline-variant);
    background: var(--surface-container-low);
    font-size: 0.8125rem;
    color: var(--on-surface);
    outline: none;
    transition: border-color 0.15s ease;
  }
  .cmd-search-input::placeholder { color: var(--on-surface-variant); opacity: 0.5; }
  .cmd-search-input:focus { border-color: var(--color-primary); }

  .cmd-card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 1rem;
    border-radius: 1rem;
    border: 1px solid var(--outline-variant);
    background: var(--surface-container-lowest);
    transition: border-color 0.15s ease, opacity 0.15s ease;
  }
  .cmd-card--off { opacity: 0.72; }

  .cmd-code {
    padding: 0.125rem 0.375rem;
    border-radius: 0.375rem;
    background: var(--surface-container);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8125rem;
    font-weight: 600;
    color: var(--on-surface);
  }

  .cmd-off-note {
    font-size: 0.75rem;
    color: var(--on-surface-variant);
    opacity: 0.75;
  }

  .cmd-accordion {
    border-radius: 0.75rem;
    border: 1px solid var(--outline-variant);
    background: var(--surface-container-lowest);
    overflow: hidden;
  }
  .cmd-accordion-head {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem 1rem;
    cursor: pointer;
    text-align: left;
    transition: background 0.15s ease;
  }
  .cmd-accordion-head:hover { background: var(--surface-hover); }
  .cmd-accordion-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    flex-shrink: 0;
    border-radius: 0.5rem;
    background: var(--surface-container);
    color: var(--on-surface);
  }
  .cmd-accordion-body {
    padding: 1rem;
    border-top: 1px solid var(--outline-variant);
  }

  .cmd-picker {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    max-height: 13rem;
    overflow-y: auto;
    padding: 0.375rem;
    border-radius: 0.75rem;
    border: 1px solid var(--outline-variant);
  }

  .cmd-option {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    width: 100%;
    padding: 0.375rem 0.625rem;
    border-radius: 0.5rem;
    border: none;
    background: transparent;
    font-size: 0.8125rem;
    color: var(--on-surface-variant);
    text-align: left;
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
  }
  .cmd-option:hover:not(:disabled) { background: var(--surface-hover); color: var(--on-surface); }
  .cmd-option:disabled { cursor: not-allowed; opacity: 0.6; }
  .cmd-option--on { color: var(--on-surface); font-weight: 500; }
  .cmd-option--off { color: var(--color-error); font-weight: 500; }

  .cmd-check {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
    border-radius: 0.25rem;
    border: 1px solid var(--outline);
    color: transparent;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  .cmd-check--on {
    background: var(--color-primary);
    border-color: var(--color-primary);
    color: var(--on-primary-color);
  }
  .cmd-check--off {
    background: var(--color-error);
    border-color: var(--color-error);
    color: #fff;
  }

  .cmd-dot {
    width: 0.625rem;
    height: 0.625rem;
    flex-shrink: 0;
    border-radius: 9999px;
  }

  .cmd-hint {
    margin-top: 0.625rem;
    font-size: 0.6875rem;
    line-height: 1.5;
    color: var(--on-surface-variant);
    opacity: 0.8;
  }

  .cmd-sig {
    padding: 0.375rem 0.625rem;
    border-radius: 0.375rem;
    border: 1px solid var(--outline-variant);
    background: var(--surface-container);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem;
    color: var(--on-surface);
    word-break: break-all;
  }

  .cmd-user-input {
    flex: 1;
    min-width: 0;
    padding: 0.375rem 0.625rem;
    border-radius: 0.5rem;
    border: 1px solid var(--outline-variant);
    background: var(--surface-container-low);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem;
    color: var(--on-surface);
    outline: none;
  }
  .cmd-user-input:focus { border-color: var(--color-primary); }
  .cmd-user-input:disabled { opacity: 0.5; }

  .cmd-mini-btn {
    padding: 0.375rem 0.75rem;
    border-radius: 0.5rem;
    border: 1px solid var(--outline-variant);
    background: transparent;
    font-size: 0.75rem;
    font-weight: 600;
    color: var(--on-surface-variant);
    cursor: pointer;
    transition: background 0.15s ease, color 0.15s ease;
    white-space: nowrap;
  }
  .cmd-mini-btn:hover:not(:disabled) { background: var(--surface-hover); color: var(--on-surface); }
  .cmd-mini-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .cmd-mini-btn--danger { border-color: rgba(220, 38, 38, 0.25); color: var(--color-error); }
  .cmd-mini-btn--danger:hover:not(:disabled) { background: rgba(220, 38, 38, 0.08); color: var(--color-error); }

  .cmd-tag {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.1875rem 0.5rem;
    border-radius: 9999px;
    border: 1px solid var(--outline-variant);
    background: var(--surface-container-lowest);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.6875rem;
    color: var(--on-surface-variant);
    cursor: pointer;
  }
  .cmd-tag:disabled { cursor: not-allowed; opacity: 0.6; }
  .cmd-tag--allow { border-color: rgba(16, 185, 129, 0.3); color: rgb(16, 185, 129); }
  .cmd-tag--block { border-color: rgba(220, 38, 38, 0.3); color: var(--color-error); }
</style>
