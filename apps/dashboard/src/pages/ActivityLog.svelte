<script lang="ts">
  import { m } from '../lib/i18n';
  import { dashboardStore } from '../lib/stores/dashboard.svelte';
  import { authStore } from '../lib/stores/auth.svelte';
  import { refreshDashboardOnMount } from '../lib/dashboardLifecycle';
  import RefreshButton from '../lib/components/RefreshButton.svelte';
  import FormInput from '../lib/components/FormInput.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import ColumnSortFilter, { type ColumnFilterOption } from '../lib/components/sanctions/ColumnSortFilter.svelte';


  type ActivitySortField = 'date' | 'user' | 'module' | 'action' | 'type';

  let searchQuery = $state('');
  let filters = $state({
    users: [] as string[],
    modules: [] as string[],
    actions: [] as string[],
    types: [] as string[],
  });
  let sortField = $state<ActivitySortField>('date');
  let sortDirection = $state<'asc' | 'desc'>('desc');

  // Filter to only Dashboard logs
  const dashboardLogs = $derived(dashboardStore.state.auditTrail.filter(entry => entry.source !== 'discord'));

  const uniqueUsers = $derived([...new Set(dashboardLogs.map((entry) => entry.user))].sort((a, b) => a.localeCompare(b, 'fr')));
  const uniqueModules = $derived([...new Set(dashboardLogs.map((entry) => entry.module))].sort((a, b) => a.localeCompare(b, 'fr')));
  const uniqueActions = $derived([...new Set(dashboardLogs.map((entry) => entry.action))].sort((a, b) => a.localeCompare(b, 'fr')));
  const uniqueTypes = $derived([...new Set(dashboardLogs.map((entry) => entry.eventType))].sort((a, b) => a.localeCompare(b, 'fr')));

  const userFilterOptions = $derived<ColumnFilterOption[]>(
    uniqueUsers.map((user) => ({ value: user, label: user }))
  );
  const moduleFilterOptions = $derived<ColumnFilterOption[]>(
    uniqueModules.map((moduleName) => ({ value: moduleName, label: moduleName }))
  );
  const actionFilterOptions = $derived<ColumnFilterOption[]>(
    uniqueActions.map((actionName) => ({ value: actionName, label: actionName }))
  );
  const typeFilterOptions = $derived<ColumnFilterOption[]>(
    uniqueTypes.map((eventType) => ({ value: eventType, label: eventType }))
  );

  const hasActiveFiltersOrSort = $derived(
    filters.users.length > 0
      || filters.modules.length > 0
      || filters.actions.length > 0
      || filters.types.length > 0
      || sortField !== 'date'
      || sortDirection !== 'desc'
  );

  function toggleFilter(filterType: 'users' | 'modules' | 'actions' | 'types', value: string) {
    const list = filters[filterType];
    if (list.includes(value)) {
      filters[filterType] = list.filter((entry) => entry !== value);
      return;
    }
    filters[filterType] = [...list, value];
  }

  function toggleSort(field: ActivitySortField) {
    if (sortField === field) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      return;
    }
    sortField = field;
    sortDirection = 'asc';
  }

  function sortDirectionFor(field: ActivitySortField) {
    return sortField === field ? sortDirection : null;
  }

  function resetFiltersAndSort() {
    filters = {
      users: [],
      modules: [],
      actions: [],
      types: [],
    };
    sortField = 'date';
    sortDirection = 'desc';
  }

  const filteredLogs = $derived(
    [...dashboardLogs]
    .filter(log => {
      const matchesSearch = searchQuery === '' || 
        log.action.toLowerCase().includes(searchQuery.toLowerCase()) ||
        log.details.toLowerCase().includes(searchQuery.toLowerCase()) ||
        log.module.toLowerCase().includes(searchQuery.toLowerCase()) ||
        log.user.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesModule = filters.modules.length === 0 || filters.modules.includes(log.module);
      const matchesAction = filters.actions.length === 0 || filters.actions.includes(log.action);
      const matchesType = filters.types.length === 0 || filters.types.includes(log.eventType);
      const matchesUser = filters.users.length === 0 || filters.users.includes(log.user);
      return matchesSearch && matchesModule && matchesAction && matchesType && matchesUser;
    })
    .sort((left, right) => {
      let result = 0;
      switch (sortField) {
        case 'date':
          result = new Date(left.dateIso).getTime() - new Date(right.dateIso).getTime();
          break;
        case 'user':
          result = left.user.localeCompare(right.user, 'fr');
          break;
        case 'module':
          result = left.module.localeCompare(right.module, 'fr');
          break;
        case 'action':
          result = left.action.localeCompare(right.action, 'fr');
          break;
        case 'type':
          result = left.eventType.localeCompare(right.eventType, 'fr');
          break;
      }
      return sortDirection === 'asc' ? result : -result;
    })
  );

  const stats = $derived([
    { label: 'Actions (Total)', val: dashboardLogs.length, sub: 'Configuration', subClass: 'text-primary' },
    { label: 'Modules', val: new Set(dashboardLogs.map(l => l.module)).size, sub: 'Sources', subClass: 'text-green-600' },
    { label: 'Utilisateurs', val: new Set(dashboardLogs.map(l => l.user)).size, sub: 'Unique', subClass: 'text-purple-600' }
  ]);

  function extractUserIdFromText(value: string | null | undefined) {
    if (!value) return null;

    const mentionMatch = value.match(/<@!?(\d{15,25})>/);
    if (mentionMatch?.[1]) return mentionMatch[1];

    const parenthesizedIdMatch = value.match(/\((\d{15,25})\)/);
    if (parenthesizedIdMatch?.[1]) return parenthesizedIdMatch[1];

    return null;
  }

  function hideUserIds(value: string) {
    return value
      .replace(/\(<@!?\d{15,25}>\)/g, '')
      .replace(/<@!?\d{15,25}>/g, '@utilisateur')
      .replace(/\((\d{15,25})\)/g, '');
  }

  function replaceEntityMentions(value: string) {
    return value
      .replace(/<#(\d{15,25})>/g, (_, channelId: string) => {
        const channel = dashboardStore.state.discordChannels.find((entry) => entry.id === channelId);
        const name = channel ? channel.name : 'salon-inconnu';
        return `<a href="https://discord.com/channels/${authStore.selectedGuildId}/${channelId}" target="_blank" class="mention-link">#${name}</a>`;
      })
      .replace(/<@&(\d{15,25})>/g, (_, roleId: string) => {
        const role = dashboardStore.state.discordRoles.find((entry) => entry.id === roleId);
        const name = role ? role.name : 'role-inconnu';
        return `<span class="mention">@${name}</span>`;
      });
  }

  function parseDetailsStructure(details: string) {
    if (!details) return { badges: [], blocks: [] };
    
    let clean = details;
    const userMatch = clean.match(/^([^|]+?\(<@!?\d{15,25}>\))/);
    if (userMatch) {
      clean = clean.replace(userMatch[0], '').trim();
    }
    clean = clean.replace(/\|?\s*Salon:\s*<#\d+>\s*/gi, '');
    clean = clean.replace(/^\|\s*/, '').trim();

    const parts = clean.split(/\s*\|\s*/);
    const badges: Array<{ key: string | null; value: string }> = [];
    const blocks: Array<{ key: string; value: string }> = [];

    for (const part of parts) {
      const colIndex = part.indexOf(':');
      if (colIndex > -1) {
        const key = part.slice(0, colIndex).trim();
        const value = part.slice(colIndex + 1).trim();
        const cleanKey = replaceEntityMentions(hideUserIds(key));
        const cleanVal = replaceEntityMentions(hideUserIds(value));
        
        if (['contenu', 'raison', 'description', 'reason', 'contenu d\'origine', 'nouveau contenu', 'arguments'].includes(key.toLowerCase()) || value.length > 50) {
          blocks.push({ key: cleanKey, value: cleanVal });
        } else {
          badges.push({ key: cleanKey, value: cleanVal });
        }
      } else {
        const cleanVal = replaceEntityMentions(hideUserIds(part));
        if (cleanVal) {
          if (cleanVal.length > 50) {
            blocks.push({ key: m.ctv_details(), value: cleanVal });
          } else {
            badges.push({ key: null, value: cleanVal });
          }
        }
      }
    }
    
    return { badges, blocks };
  }
</script>


<ModulePage
  title={m.ctv_activity_log()}
  description="Historique des actions de configuration pour {dashboardStore.state.guildName}."
  icon="history"
  featureKey="activity"
>
  {#snippet actions()}
    <RefreshButton
      onClick={() => dashboardStore.refresh()}
      loading={dashboardStore.state.loading}
      label="Actualiser"
      className="px-5 py-2.5 font-bold "
      iconClass="text-lg"
    />
  {/snippet}


<div class="section-card p-6 mb-8 font-inter">
  <div class="flex flex-col md:flex-row md:items-center gap-4 justify-between">
    <div class="space-y-2 w-full md:max-w-2xl">
      <label class="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest ml-1" for="search">Recherche</label>
      <div class="relative top-1.5">
        <Papicon icon="search" size={18} class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <FormInput
          id="search"
          type="text"
          bind:value={searchQuery}
          placeholder={m.ctv_action_details_module_user()}
          className="w-full pl-10 pr-4 py-2.5 bg-slate-50 dark:bg-slate-800 border-none rounded-xl text-sm focus:ring-2 focus:ring-primary/20 transition-all"
        />
      </div>
    </div>

    <div class="flex items-center gap-3">
      <span class="text-xs font-bold text-on-surface-variant">{filteredLogs.length} / {dashboardLogs.length} événement(s)</span>
      {#if hasActiveFiltersOrSort}
        <button
          type="button"
          onclick={resetFiltersAndSort}
          class="text-xs font-bold text-primary hover:text-primary/80 transition"
        >
          Réinitialiser filtres et tri
        </button>
      {/if}
    </div>
  </div>
</div>


<div class="section-card-flush font-inter">
  <div class="overflow-x-auto">
    <table class="w-full text-left border-collapse">
      <thead>
        <tr class="bg-slate-50 dark:bg-white/5">
          <th class="px-6 py-5">
            <ColumnSortFilter
              label="Horodatage"
              sortDirection={sortDirectionFor('date')}
              onToggleSort={() => toggleSort('date')}
            />
          </th>
          <th class="px-6 py-5">
            <ColumnSortFilter
              label="Utilisateur"
              sortDirection={sortDirectionFor('user')}
              onToggleSort={() => toggleSort('user')}
              options={userFilterOptions}
              selectedValues={filters.users}
              onToggleValue={(value) => toggleFilter('users', value)}
              searchable={true}
            />
          </th>
          <th class="px-6 py-5">
            <ColumnSortFilter
              label="Module / Source"
              sortDirection={sortDirectionFor('module')}
              onToggleSort={() => toggleSort('module')}
              options={moduleFilterOptions}
              selectedValues={filters.modules}
              onToggleValue={(value) => toggleFilter('modules', value)}
            />
          </th>
          <th class="px-6 py-5">
            <ColumnSortFilter
              label="Action"
              sortDirection={sortDirectionFor('action')}
              onToggleSort={() => toggleSort('action')}
              options={actionFilterOptions}
              selectedValues={filters.actions}
              onToggleValue={(value) => toggleFilter('actions', value)}
              searchable={true}
            />
          </th>
          <th class="px-6 py-5 text-[10px] font-bold text-on-surface-variant uppercase tracking-widest">Détails</th>
          <th class="px-6 py-5">
            <div class="flex justify-center">
              <ColumnSortFilter
                label="Type"
                sortDirection={sortDirectionFor('type')}
                onToggleSort={() => toggleSort('type')}
                options={typeFilterOptions}
                selectedValues={filters.types}
                onToggleValue={(value) => toggleFilter('types', value)}
              />
            </div>
          </th>
        </tr>
      </thead>
      <tbody class="divide-y divide-slate-50 dark:divide-slate-800">
        {#each filteredLogs as entry}
          {@const parsed = parseDetailsStructure(entry.details)}
          <tr class="hover:bg-slate-50 dark:hover:bg-white/5 transition-colors group">
            <td class="px-6 py-6">
              <div class="text-xs">
                <p class="font-bold text-slate-800 dark:text-slate-200">{new Date(entry.dateIso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</p>
                <p class="text-[10px] text-slate-400 font-medium">{new Date(entry.dateIso).toLocaleDateString()}</p>
              </div>
            </td>
            <td class="px-6 py-6">
              <span class="inline-flex max-w-40 truncate rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-[11px] font-bold text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
                {entry.user}
              </span>
            </td>
            <td class="px-6 py-6 font-bold text-sm text-primary">
              {entry.module}
            </td>
            <td class="px-6 py-6 font-medium text-sm text-slate-600 dark:text-slate-200">
              {entry.action}
            </td>
            <td class="px-6 py-6 max-w-md">
              <div class="space-y-2">
                {#if parsed.badges.length > 0}
                  <div class="flex flex-wrap gap-1.5">
                    {#each parsed.badges as item}
                      {#if item.key}
                        <div class="inline-flex items-center gap-1 bg-surface-container-high border border-outline-variant/10 rounded-lg px-2 py-0.5 text-[10px] text-on-surface-variant font-medium">
                          <span class="text-on-surface-variant/70 font-semibold">{item.key}:</span>
                          <span class="text-on-surface break-all">{@html item.value}</span>
                        </div>
                      {:else}
                        <div class="inline-flex items-center bg-surface-container-high/40 border border-outline-variant/10 rounded-lg px-2 py-0.5 text-[10px] text-on-surface-variant break-all">
                          {@html item.value}
                        </div>
                      {/if}
                    {/each}
                  </div>
                {/if}
                {#each parsed.blocks as block}
                  <div class="bg-surface-container-low border-l-2 border-primary/50 rounded-r-lg px-3 py-1.5 text-xs text-on-surface-variant space-y-0.5 max-w-full overflow-hidden">
                    <p class="text-[11px] font-semibold uppercase tracking-wider text-primary/80">{block.key}</p>
                    <p class="break-all whitespace-pre-wrap leading-relaxed text-on-surface">{@html block.value}</p>
                  </div>
                {/each}
              </div>
            </td>
            <td class="px-6 py-6 text-center">
              <span class="inline-flex items-center justify-center w-24 px-3 py-1 rounded-full text-[10px] font-bold 
 {entry.eventType === 'Automatique' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}">
                {entry.eventType}
              </span>
            </td>
          </tr>
        {/each}

        {#if filteredLogs.length === 0}
          <tr>
            <td colspan="6" class="px-6 py-20 text-center text-on-surface-variant opacity-50">
              <Papicon icon="history" size={40} class="mb-2 mx-auto" />
              <p class="text-sm font-medium">{m.ctv_aucun_vnement_ne_correspond_vo()}</p>
            </td>
          </tr>
        {/if}
      </tbody>
    </table>
  </div>
</div>


<div class="grid grid-cols-1 md:grid-cols-3 gap-6 mt-12 font-inter">
  {#each stats as kpi}
    <div class="bg-surface-container-low p-6 rounded-lg border border-outline-variant/10">
      <p class="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest">{kpi.label}</p>
      <div class="flex items-end justify-between mt-2">
        <p class="text-lg font-semibold text-on-surface">{kpi.val}</p>
        <span class="text-[10px] font-bold {kpi.subClass}">{kpi.sub}</span>
      </div>
    </div>
  {/each}
</div>
</ModulePage>

