<script lang="ts">
  /**
   * Gestion des serveurs de l'instance.
   *
   * L'ancienne version affichait une grille de cartes avec tous les boutons
   * d'action visibles en permanence : illisible au-delà d'une dizaine de
   * serveurs, sans tri, et le filtre se limitait au nom. Cette version passe
   * en table triable et filtrable, et déporte les actions dans une fiche
   * serveur - les actions destructrices ne sont plus à un clic de distance
   * pendant qu'on parcourt la liste.
   */
  import { onMount, onDestroy } from 'svelte';
  import { toast } from '../../lib/stores/toast.svelte';
  import { confirmDialog } from '../../lib/stores/confirmDialog.svelte';
  import { subscribeRealtime } from '../../lib/stores/realtime.svelte';
  import {
    fetchAdminStats,
    fetchAdminGuilds,
    fetchAdminGuildInvite,
    leaveAdminGuild,
    deactivateAdminGuild,
    activateAdminGuildAuto,
    rescanAdminGuildStats,
    resyncAdminGuildData,
    reconcileStaffServers,
    resetAdminGuildServerTemplate,
  } from '../../lib/api';
  import Papicon from '../../lib/components/Papicon.svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminStat from '../../lib/components/admin/AdminStat.svelte';
  import AdminTable from '../../lib/components/admin/AdminTable.svelte';
  import AdminToolbar from '../../lib/components/admin/AdminToolbar.svelte';
  import AdminBadge from '../../lib/components/admin/AdminBadge.svelte';
  import AdminDrawer from '../../lib/components/admin/AdminDrawer.svelte';
  import type { AdminTableColumn, AdminTone } from '../../lib/components/admin/types';

  type ScrapeStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

  interface AdminGuild {
    id: string;
    name: string;
    icon: string | null;
    memberCount: number;
    joinedAt: string;
    activated: boolean;
    activationCode: string | null;
    serverTemplateAppliedAt: string | null;
    serverTemplateAppliedBy: string | null;
    statsConfig?: {
      historicalScrapeStatus?: ScrapeStatus;
      historicalScrapedMessages?: number;
      historicalScrapeError?: string | null;
      historicalScrapeProgress?: { scrapedChannelsCount: number; totalChannelsCount: number; scrapedMessagesCount: number };
      memberScrapeStatus?: ScrapeStatus;
      memberScrapedCount?: number;
      memberScrapeError?: string | null;
      memberScrapeProgress?: { scrapedCount: number; totalCount: number };
      fullSyncStatus?: 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
      fullSyncStage?: 'MEMBERS' | 'HISTORY' | null;
      fullSyncError?: string | null;
    } | null;
    shardId: number;
  }

  interface AdminStats {
    guildCount: number;
    userCount: number;
    shardCount: number;
    onlineShardCount: number;
  }

  let stats = $state<AdminStats | null>(null);
  let guilds = $state<AdminGuild[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let reconciling = $state(false);
  let busyIds = $state<string[]>([]);

  let search = $state('');
  let statusFilter = $state('ALL');
  let sortKey = $state('memberCount');
  let sortDir = $state<'asc' | 'desc'>('desc');

  let detailOpen = $state(false);
  let selected = $state<AdminGuild | null>(null);

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribeRealtime: (() => void) | null = null;

  /**
   * Le sondage rapide ne sert qu'aux barres de progression.
   *
   * Les scans de membres et d'historique avancent en tâche de fond sans rien
   * annoncer : leur progression ne peut se lire qu'en redemandant. Mais elle
   * n'intéresse que le temps d'un scan - le reste du temps, cette page
   * redemandait la liste complète des serveurs de l'instance toutes les cinq
   * secondes pour n'y rien voir changer.
   *
   * L'arrivée et le départ d'un serveur, eux, sont annoncés : c'est
   * l'abonnement plus bas qui s'en charge, à la seconde.
   */
  const SYNCING_POLL_MS = 5_000;

  $effect(() => {
    const wanted = syncingCount > 0;
    if (wanted && !pollTimer) {
      pollTimer = setInterval(() => {
        if (document.hidden) return;
        void refreshGuilds();
      }, SYNCING_POLL_MS);
    } else if (!wanted && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });

  onMount(() => {
    void load(true);

    unsubscribeRealtime = subscribeRealtime({
      types: ['bot_guilds_changed'],
      // Vue d'instance : tous les serveurs la concernent, pas seulement celui
      // qui est sélectionné dans le sélecteur.
      guildScoped: false,
      // Filet : ce que les scans font en fond n'émet aucun événement, et un
      // scan peut démarrer depuis un autre onglet.
      fallbackMs: 30_000,
      onUpdate: () => void refreshGuildsAndStats(),
    });
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    unsubscribeRealtime?.();
  });

  async function load(initial = false) {
    if (initial) loading = true;
    try {
      const [statsData, guildData] = await Promise.all([fetchAdminStats(), fetchAdminGuilds()]);
      stats = statsData as AdminStats;
      guilds = guildData.guilds as AdminGuild[];
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Erreur de chargement';
    } finally {
      loading = false;
    }
  }

  async function refreshGuilds() {
    try {
      guilds = (await fetchAdminGuilds()).guilds as AdminGuild[];
      // La fiche ouverte doit suivre la progression sans se refermer.
      if (selected) selected = guilds.find((g) => g.id === selected!.id) ?? selected;
    } catch {
      // Silencieux : c'est un rafraîchissement d'arrière-plan, l'erreur de
      // chargement initial est déjà signalée.
    }
  }

  /**
   * Un serveur qui arrive ou qui part change aussi les compteurs d'en-tête :
   * les rafraîchir séparément afficherait « 42 serveurs » au-dessus d'une
   * table qui en liste 43.
   */
  async function refreshGuildsAndStats() {
    await Promise.all([
      refreshGuilds(),
      fetchAdminStats()
        .then((data) => { stats = data as AdminStats; })
        .catch(() => {}),
    ]);
  }

  // ── Dérivés ───────────────────────────────────────────────────────────────
  const activatedCount = $derived(guilds.filter((g) => g.activated).length);
  const syncingCount = $derived(guilds.filter((g) => isSyncing(g)).length);
  const failedCount = $derived(guilds.filter((g) => hasFailure(g)).length);

  function isSyncing(guild: AdminGuild): boolean {
    const config = guild.statsConfig;
    return config?.fullSyncStatus === 'IN_PROGRESS'
      || config?.historicalScrapeStatus === 'IN_PROGRESS'
      || config?.memberScrapeStatus === 'IN_PROGRESS';
  }

  function hasFailure(guild: AdminGuild): boolean {
    const config = guild.statsConfig;
    return config?.fullSyncStatus === 'FAILED'
      || config?.historicalScrapeStatus === 'FAILED'
      || config?.memberScrapeStatus === 'FAILED';
  }

  const filtered = $derived.by(() => {
    const needle = search.trim().toLowerCase();
    let rows = guilds.filter((guild) =>
      !needle || guild.name.toLowerCase().includes(needle) || guild.id.includes(needle),
    );

    if (statusFilter === 'ACTIVATED') rows = rows.filter((g) => g.activated);
    else if (statusFilter === 'INACTIVE') rows = rows.filter((g) => !g.activated);
    else if (statusFilter === 'SYNCING') rows = rows.filter(isSyncing);
    else if (statusFilter === 'FAILED') rows = rows.filter(hasFailure);

    const direction = sortDir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      switch (sortKey) {
        case 'name': return a.name.localeCompare(b.name, 'fr') * direction;
        case 'joinedAt': return (new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime()) * direction;
        case 'shardId': return (a.shardId - b.shardId) * direction;
        case 'activated': return (Number(a.activated) - Number(b.activated)) * direction;
        default: return (a.memberCount - b.memberCount) * direction;
      }
    });
  });

  // ── Actions ───────────────────────────────────────────────────────────────
  function setBusy(guildId: string, busy: boolean) {
    busyIds = busy ? [...busyIds, guildId] : busyIds.filter((id) => id !== guildId);
  }

  async function run(guildId: string, action: () => Promise<unknown>, successMessage?: string) {
    setBusy(guildId, true);
    try {
      const result = (await action()) as { message?: string; code?: string } | undefined;
      toast.success(successMessage ?? result?.message ?? 'Action effectuée');
      await refreshGuilds();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur');
    } finally {
      setBusy(guildId, false);
    }
  }

  async function handleInvite(guild: AdminGuild) {
    try {
      const data = await fetchAdminGuildInvite(guild.id);
      if (data.url) window.open(data.url, '_blank', 'noopener');
      else toast.error('Aucune invitation générée');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur d'invitation");
    }
  }

  async function handleLeave(guild: AdminGuild) {
    if (!(await confirmDialog.danger(
      `Faire quitter le bot de « ${guild.name} » ?`,
      'Le bot perd immédiatement l’accès au serveur. Les données déjà collectées restent en base.',
      'Faire quitter',
    ))) return;

    setBusy(guild.id, true);
    try {
      await leaveAdminGuild(guild.id);
      guilds = guilds.filter((g) => g.id !== guild.id);
      if (selected?.id === guild.id) detailOpen = false;
      toast.success(`Bot retiré de ${guild.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur');
    } finally {
      setBusy(guild.id, false);
    }
  }

  async function handleActivate(guild: AdminGuild) {
    if (!(await confirmDialog.ask({ title: `Activer « ${guild.name} » ?`, confirmLabel: 'Activer' }))) return;
    await run(guild.id, async () => {
      const res = await activateAdminGuildAuto(guild.id);
      return { message: `Serveur activé - code ${res.code}` };
    });
  }

  async function handleDeactivate(guild: AdminGuild) {
    if (!(await confirmDialog.ask({
      title: `Désactiver « ${guild.name} » ?`,
      description: 'Le serveur repasse aux fonctions de base jusqu’à une nouvelle activation.',
      confirmLabel: 'Désactiver',
      variant: 'warning',
    }))) return;
    await run(guild.id, () => deactivateAdminGuild(guild.id), 'Serveur désactivé');
  }

  async function handleResync(guild: AdminGuild) {
    if (!(await confirmDialog.ask({
      title: `Synchroniser toutes les données de « ${guild.name} » ?`,
      description: 'Les membres sont remis à jour, puis le scan historique reprend à son dernier curseur. Rien n’est supprimé ni compté deux fois.',
      confirmLabel: 'Tout synchroniser',
      variant: 'warning',
    }))) return;
    await run(guild.id, () => resyncAdminGuildData(guild.id));
  }

  async function handleResetTemplate(guild: AdminGuild) {
    if (!(await confirmDialog.ask({
      title: `Rouvrir la mise en place de « ${guild.name} » ?`,
      description: `Faite par ${guild.serverTemplateAppliedBy ?? 'un administrateur'}. Les salons déjà créés restent en place : une nouvelle mise en place les reprend au lieu de les doubler.`,
      confirmLabel: 'Rouvrir',
      variant: 'warning',
    }))) return;
    await run(guild.id, () => resetAdminGuildServerTemplate(guild.id));
  }

  async function handleReconcile() {
    reconciling = true;
    try {
      const res = await reconcileStaffServers();
      toast.success(`Serveurs staff synchronisés : ${res.checked} vérifié(s) · ${res.activated} activé(s) · ${res.deactivated} désactivé(s)`);
      await refreshGuilds();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur');
    } finally {
      reconciling = false;
    }
  }

  function openDetail(guild: AdminGuild) {
    selected = guild;
    detailOpen = true;
  }

  // ── Affichage ─────────────────────────────────────────────────────────────
  function formatNumber(value: number): string {
    return value.toLocaleString('fr-FR');
  }

  function formatDate(value: string | null): string {
    if (!value) return '-';
    return new Date(value).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  const scrapeTone: Record<ScrapeStatus, AdminTone> = {
    NOT_STARTED: 'neutral',
    IN_PROGRESS: 'info',
    COMPLETED: 'success',
    FAILED: 'danger',
  };
  const scrapeLabel: Record<ScrapeStatus, string> = {
    NOT_STARTED: 'Jamais lancé',
    IN_PROGRESS: 'En cours',
    COMPLETED: 'Terminé',
    FAILED: 'Échec',
  };

  function syncProgress(guild: AdminGuild): { label: string; percent: number } | null {
    const config = guild.statsConfig;
    if (!config) return null;

    if (config.memberScrapeStatus === 'IN_PROGRESS' && config.memberScrapeProgress) {
      const { scrapedCount, totalCount } = config.memberScrapeProgress;
      return {
        label: `Membres ${formatNumber(scrapedCount)} / ${formatNumber(totalCount)}`,
        percent: totalCount > 0 ? Math.min(100, Math.round((scrapedCount / totalCount) * 100)) : 0,
      };
    }
    if (config.historicalScrapeStatus === 'IN_PROGRESS' && config.historicalScrapeProgress) {
      const { scrapedChannelsCount, totalChannelsCount, scrapedMessagesCount } = config.historicalScrapeProgress;
      return {
        label: `Salons ${scrapedChannelsCount} / ${totalChannelsCount} · ${formatNumber(scrapedMessagesCount)} messages`,
        percent: totalChannelsCount > 0 ? Math.min(100, Math.round((scrapedChannelsCount / totalChannelsCount) * 100)) : 0,
      };
    }
    return null;
  }

  const columns: AdminTableColumn[] = [
    { key: 'name', label: 'Serveur', sortKey: 'name' },
    { key: 'status', label: 'État', sortKey: 'activated', width: 'w-44' },
    { key: 'members', label: 'Membres', sortKey: 'memberCount', align: 'right', width: 'w-28' },
    { key: 'shard', label: 'Shard', sortKey: 'shardId', align: 'right', width: 'w-20', hideBelow: 'md' },
    { key: 'joined', label: 'Ajouté le', sortKey: 'joinedAt', align: 'right', width: 'w-32', hideBelow: 'lg' },
    { key: 'actions', label: '', align: 'right', width: 'w-24' },
  ];
</script>

<AdminShell
  title="Serveurs"
  description="Inventaire des serveurs où Kotbo est présent, avec leur état d’activation et l’avancement des synchronisations."
>
  {#snippet actions()}
    <button
      type="button"
      onclick={handleReconcile}
      disabled={reconciling}
      class="h-9 px-3.5 rounded-xl bg-on-surface/6 hover:bg-on-surface/10 border border-outline-variant/25 text-[13px] font-semibold text-on-surface-variant hover:text-on-surface transition disabled:opacity-50 inline-flex items-center gap-2"
    >
      {#if reconciling}
        <span class="w-3.5 h-3.5 rounded-full border-2 border-on-surface-variant/30 border-t-on-surface-variant animate-spin"></span>
      {:else}
        <Papicon icon="RefreshCw" size={13} />
      {/if}
      Resynchroniser les serveurs staff
    </button>
  {/snippet}

  {#if error}
    <div class="rounded-2xl border border-red-500/30 bg-red-500/8 p-4 flex items-start gap-3">
      <Papicon icon="AlertTriangle" size={18} class="text-red-500 mt-0.5 shrink-0" />
      <p class="text-[13.5px] text-red-600 dark:text-red-400">{error}</p>
    </div>
  {/if}

  <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
    <AdminStat label="Serveurs" value={formatNumber(guilds.length)} icon="Server" tone="primary" {loading} />
    <AdminStat
      label="Activés"
      value={formatNumber(activatedCount)}
      hint={guilds.length > 0 ? `${Math.round((activatedCount / guilds.length) * 100)}% du parc` : ''}
      icon="CheckCircle"
      tone="success"
      {loading}
    />
    <AdminStat
      label="Synchronisations"
      value={formatNumber(syncingCount)}
      hint="en cours"
      icon="RefreshCw"
      tone={syncingCount > 0 ? 'info' : 'neutral'}
      {loading}
    />
    <AdminStat
      label="Membres cumulés"
      value={stats ? formatNumber(stats.userCount) : '-'}
      icon="Users"
      tone="info"
      {loading}
    />
  </div>

  <AdminToolbar
    bind:search
    bind:activeFilter={statusFilter}
    placeholder="Rechercher par nom ou ID…"
    filters={[
      { value: 'ALL', label: 'Tous', count: guilds.length },
      { value: 'ACTIVATED', label: 'Activés', count: activatedCount },
      { value: 'INACTIVE', label: 'Non activés', count: guilds.length - activatedCount },
      { value: 'SYNCING', label: 'En synchro', count: syncingCount },
      { value: 'FAILED', label: 'En échec', count: failedCount },
    ]}
    resultCount={filtered.length}
    resultLabel="serveur"
  />

  <AdminTable
    {columns}
    rows={filtered}
    {loading}
    bind:sortKey
    bind:sortDir
    emptyTitle="Aucun serveur"
    emptyHint="Ajustez la recherche ou le filtre pour élargir la liste."
    emptyIcon="Server"
  >
    {#snippet row(item, _index)}
      {@const guild = item as AdminGuild}
      {@const progress = syncProgress(guild)}
      <tr class="border-b border-outline-variant/12 hover:bg-on-surface/3 transition-colors">
        <td class="px-4 py-3">
          <button type="button" onclick={() => openDetail(guild)} class="flex items-center gap-3 min-w-0 text-left group">
            <div class="w-9 h-9 shrink-0 rounded-xl bg-on-surface/6 overflow-hidden flex items-center justify-center">
              {#if guild.icon}
                <img src={guild.icon} alt="" class="w-full h-full object-cover" loading="lazy" />
              {:else}
                <Papicon icon="Server" size={15} class="text-on-surface-variant" />
              {/if}
            </div>
            <div class="min-w-0">
              <p class="text-[13.5px] font-semibold text-on-surface truncate group-hover:text-primary transition-colors">{guild.name}</p>
              <p class="text-[11.5px] text-on-surface-variant font-mono truncate">{guild.id}</p>
            </div>
          </button>
        </td>

        <td class="px-4 py-3">
          <div class="flex flex-col gap-1 items-start">
            <AdminBadge
              label={guild.activated ? 'Activé' : 'Non activé'}
              tone={guild.activated ? 'success' : 'neutral'}
              dot
            />
            {#if progress}
              <div class="w-full max-w-36">
                <div class="h-1 rounded-full bg-on-surface/10 overflow-hidden">
                  <div class="h-full bg-sky-500 rounded-full transition-all duration-500" style="width: {progress.percent}%"></div>
                </div>
                <p class="text-[10.5px] text-on-surface-variant mt-0.5 tabular-nums truncate">{progress.label}</p>
              </div>
            {:else if hasFailure(guild)}
              <AdminBadge size="sm" label="Synchro en échec" tone="danger" />
            {/if}
          </div>
        </td>

        <td class="px-4 py-3 text-right">
          <span class="text-[13px] font-semibold text-on-surface tabular-nums">{formatNumber(guild.memberCount)}</span>
        </td>

        <td class="px-4 py-3 text-right hidden md:table-cell">
          <span class="text-[12.5px] text-on-surface-variant tabular-nums">#{guild.shardId}</span>
        </td>

        <td class="px-4 py-3 text-right hidden lg:table-cell">
          <span class="text-[12.5px] text-on-surface-variant">{formatDate(guild.joinedAt)}</span>
        </td>

        <td class="px-4 py-3">
          <div class="flex items-center justify-end gap-1">
            <button
              type="button"
              onclick={() => handleInvite(guild)}
              aria-label="Créer une invitation"
              title="Créer une invitation"
              class="w-8 h-8 rounded-lg bg-on-surface/6 text-on-surface-variant hover:bg-on-surface/12 hover:text-on-surface transition flex items-center justify-center"
            >
              <Papicon icon="Link" size={13} />
            </button>
            <button
              type="button"
              onclick={() => openDetail(guild)}
              aria-label="Ouvrir la fiche"
              title="Fiche serveur"
              class="w-8 h-8 rounded-lg bg-on-surface/6 text-on-surface-variant hover:bg-primary/12 hover:text-primary transition flex items-center justify-center"
            >
              <Papicon icon="ChevronRight" size={13} />
            </button>
          </div>
        </td>
      </tr>
    {/snippet}
  </AdminTable>
</AdminShell>

<!-- Fiche serveur -->
<AdminDrawer bind:open={detailOpen} width="md" title={selected?.name ?? ''} subtitle={selected?.id ?? ''}>
  {#if selected}
    {@const guild = selected}
    {@const busy = busyIds.includes(guild.id)}
    <div class="space-y-5">
      <div class="flex items-center gap-3">
        <div class="w-14 h-14 shrink-0 rounded-2xl bg-on-surface/6 overflow-hidden flex items-center justify-center">
          {#if guild.icon}
            <img src={guild.icon} alt="" class="w-full h-full object-cover" />
          {:else}
            <Papicon icon="Server" size={22} class="text-on-surface-variant" />
          {/if}
        </div>
        <div class="min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <AdminBadge label={guild.activated ? 'Activé' : 'Non activé'} tone={guild.activated ? 'success' : 'neutral'} dot />
            <AdminBadge label="Shard #{guild.shardId}" tone="neutral" size="sm" />
          </div>
          <p class="text-[12.5px] text-on-surface-variant mt-1">
            {formatNumber(guild.memberCount)} membres · rejoint le {formatDate(guild.joinedAt)}
          </p>
        </div>
      </div>

      <!-- Synchronisations -->
      <div class="rounded-xl border border-outline-variant/25 bg-surface-container-low/40 p-3.5 space-y-3">
        <p class="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Collecte de données</p>

        {#each [
          {
            key: 'members',
            label: 'Membres',
            status: guild.statsConfig?.memberScrapeStatus ?? 'NOT_STARTED',
            detail: guild.statsConfig?.memberScrapedCount != null
              ? `${formatNumber(guild.statsConfig.memberScrapedCount)} membres enregistrés`
              : null,
            error: guild.statsConfig?.memberScrapeError,
          },
          {
            key: 'history',
            label: 'Historique des messages',
            status: guild.statsConfig?.historicalScrapeStatus ?? 'NOT_STARTED',
            detail: guild.statsConfig?.historicalScrapedMessages != null
              ? `${formatNumber(guild.statsConfig.historicalScrapedMessages)} messages scannés`
              : null,
            error: guild.statsConfig?.historicalScrapeError,
          },
        ] as job (job.key)}
          <div class="space-y-1">
            <div class="flex items-center justify-between gap-2">
              <span class="text-[13px] text-on-surface">{job.label}</span>
              <AdminBadge size="sm" label={scrapeLabel[job.status as ScrapeStatus]} tone={scrapeTone[job.status as ScrapeStatus]} />
            </div>
            {#if job.detail}
              <p class="text-[11.5px] text-on-surface-variant tabular-nums">{job.detail}</p>
            {/if}
            {#if job.error}
              <p class="text-[11.5px] text-red-500 leading-snug">{job.error}</p>
            {/if}
          </div>
        {/each}

        {#if guild.statsConfig?.fullSyncStatus === 'IN_PROGRESS'}
          <p class="text-[12px] text-sky-600 dark:text-sky-400">
            Synchronisation complète en cours - étape&nbsp;: {guild.statsConfig.fullSyncStage === 'MEMBERS' ? 'membres' : 'historique'}.
          </p>
        {/if}
      </div>

      <!-- Activation -->
      <div class="rounded-xl border border-outline-variant/25 bg-surface-container-low/40 p-3.5 space-y-2">
        <p class="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Activation</p>
        <div class="flex items-center justify-between gap-3">
          <span class="text-[13px] text-on-surface-variant">Code utilisé</span>
          <span class="text-[13px] font-mono font-semibold text-on-surface">{guild.activationCode ?? '-'}</span>
        </div>
        <div class="flex items-center justify-between gap-3">
          <span class="text-[13px] text-on-surface-variant">Mise en place</span>
          <span class="text-[13px] text-on-surface">
            {guild.serverTemplateAppliedAt ? formatDate(guild.serverTemplateAppliedAt) : 'Jamais faite'}
          </span>
        </div>
      </div>

      <!-- Actions -->
      <div class="space-y-2">
        <p class="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Actions</p>

        <button
          type="button"
          onclick={() => handleInvite(guild)}
          class="w-full h-10 rounded-xl bg-on-surface/6 hover:bg-on-surface/10 text-[13px] font-semibold text-on-surface transition inline-flex items-center justify-center gap-2"
        >
          <Papicon icon="Link" size={14} />
          Créer une invitation
        </button>

        <button
          type="button"
          onclick={() => run(guild.id, () => rescanAdminGuildStats(guild.id, false))}
          disabled={busy}
          class="w-full h-10 rounded-xl bg-on-surface/6 hover:bg-on-surface/10 text-[13px] font-semibold text-on-surface transition disabled:opacity-50 inline-flex items-center justify-center gap-2"
        >
          <Papicon icon="Search" size={14} />
          Relancer le scan des statistiques
        </button>

        <button
          type="button"
          onclick={() => handleResync(guild)}
          disabled={busy}
          class="w-full h-10 rounded-xl bg-sky-500/12 text-sky-600 dark:text-sky-400 border border-sky-500/25 hover:bg-sky-500/18 text-[13px] font-semibold transition disabled:opacity-50 inline-flex items-center justify-center gap-2"
        >
          <Papicon icon="RefreshCw" size={14} />
          Synchroniser toutes les données
        </button>

        <button
          type="button"
          onclick={() => handleResetTemplate(guild)}
          disabled={busy}
          class="w-full h-10 rounded-xl bg-on-surface/6 hover:bg-on-surface/10 text-[13px] font-semibold text-on-surface transition disabled:opacity-50 inline-flex items-center justify-center gap-2"
        >
          <Papicon icon="Layers" size={14} />
          Rouvrir la mise en place du serveur
        </button>

        {#if guild.activated}
          <button
            type="button"
            onclick={() => handleDeactivate(guild)}
            disabled={busy}
            class="w-full h-10 rounded-xl bg-amber-500/12 text-amber-600 dark:text-amber-400 border border-amber-500/25 hover:bg-amber-500/18 text-[13px] font-semibold transition disabled:opacity-50 inline-flex items-center justify-center gap-2"
          >
            <Papicon icon="Ban" size={14} />
            Désactiver le serveur
          </button>
        {:else}
          <button
            type="button"
            onclick={() => handleActivate(guild)}
            disabled={busy}
            class="w-full h-10 rounded-xl bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border border-emerald-500/25 hover:bg-emerald-500/18 text-[13px] font-semibold transition disabled:opacity-50 inline-flex items-center justify-center gap-2"
          >
            <Papicon icon="Key" size={14} />
            Activer automatiquement
          </button>
        {/if}

        <button
          type="button"
          onclick={() => handleLeave(guild)}
          disabled={busy}
          class="w-full h-10 rounded-xl bg-red-500/12 text-red-600 dark:text-red-400 border border-red-500/25 hover:bg-red-500/18 text-[13px] font-semibold transition disabled:opacity-50 inline-flex items-center justify-center gap-2"
        >
          <Papicon icon="LogOut" size={14} />
          Faire quitter le bot
        </button>
      </div>
    </div>
  {/if}
</AdminDrawer>
