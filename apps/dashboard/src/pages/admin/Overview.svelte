<script lang="ts">
  /**
   * Vue d'ensemble de la console admin.
   *
   * L'ancienne version n'affichait qu'un instantané : quatre compteurs et une
   * barre de mémoire, sans historique. Impossible d'y voir une fuite mémoire
   * lente, une dégradation de ping ou de savoir si l'état affiché est frais.
   * Cette version s'appuie sur l'historique échantillonné côté bot
   * (`/api/admin/health/series`) et met en avant ce qui demande une action.
   */
  import { onMount, onDestroy } from 'svelte';
  import {
    fetchAdminStats,
    fetchAdminHealthSeries,
    fetchAdminGuilds,
    fetchBroadcastHistory,
    fetchAdminAudit,
    type AdminHealthSeries,
    type AdminAuditEntry,
    type BroadcastLogEntry,
  } from '../../lib/api';
  import { subscribeRealtime } from '../../lib/stores/realtime.svelte';
  import Papicon from '../../lib/components/Papicon.svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminCard from '../../lib/components/admin/AdminCard.svelte';
  import AdminStat from '../../lib/components/admin/AdminStat.svelte';
  import AdminBadge from '../../lib/components/admin/AdminBadge.svelte';
  import AdminTimeSeries from '../../lib/components/admin/AdminTimeSeries.svelte';
  import type { AdminTone } from '../../lib/components/admin/types';

  interface AdminStats {
    guildCount: number;
    userCount: number;
    activeSanctions: number;
    dailyAlgoSubmissions: number;
    uptime: number;
    memoryUsage: { rss: number; heapTotal: number; heapUsed: number; external: number; arrayBuffers: number };
    shardCount: number;
    onlineShardCount: number;
    averageShardPing: number;
  }

  interface AdminGuild {
    id: string;
    name: string;
    icon: string | null;
    memberCount: number;
    activated: boolean;
    joinedAt: string | null;
    shardId: number;
  }

  let stats = $state<AdminStats | null>(null);
  let series = $state<AdminHealthSeries | null>(null);
  let guilds = $state<AdminGuild[]>([]);
  let recentBroadcasts = $state<BroadcastLogEntry[]>([]);
  let auditTrail = $state<AdminAuditEntry[]>([]);

  let loading = $state(true);
  let error = $state<string | null>(null);
  let lastRefresh = $state<Date | null>(null);
  let window_ = $state(60);
  let metric = $state<'memory' | 'ping' | 'reach'>('memory');
  let unsubscribeRealtime: (() => void) | null = null;

  const windows = [
    { value: 15, label: '15 min' },
    { value: 60, label: '1 h' },
    { value: 360, label: '6 h' },
    { value: 1440, label: '24 h' },
  ];

  async function load(initial = false) {
    if (initial) loading = true;
    try {
      const [statsData, seriesData, guildData, broadcasts, audit] = await Promise.all([
        fetchAdminStats() as Promise<AdminStats>,
        fetchAdminHealthSeries(window_).catch(() => null),
        initial ? fetchAdminGuilds().catch(() => ({ guilds: [] })) : Promise.resolve(null),
        initial ? fetchBroadcastHistory(5).catch(() => ({ logs: [] })) : Promise.resolve(null),
        initial ? fetchAdminAudit({ limit: 8 }).catch(() => ({ entries: [], nextCursor: null })) : Promise.resolve(null),
      ]);

      stats = statsData;
      series = seriesData;
      if (guildData) guilds = guildData.guilds ?? [];
      if (broadcasts) recentBroadcasts = broadcasts.logs;
      if (audit) auditTrail = audit.entries;

      lastRefresh = new Date();
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Erreur de chargement';
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load(true);
    unsubscribeRealtime = subscribeRealtime({
      types: ['bot_guilds_changed'],
      guildScoped: false,
      fallbackMs: 30_000,
      onUpdate: () => void load(),
    });
  });

  onDestroy(() => {
    unsubscribeRealtime?.();
  });

  // Changer de fenêtre ne doit recharger que la série, pas toute la page.
  async function changeWindow(minutes: number) {
    window_ = minutes;
    series = await fetchAdminHealthSeries(minutes).catch(() => null);
  }

  // ── Dérivés ───────────────────────────────────────────────────────────────
  const samples = $derived(series?.samples ?? []);

  const chartSeries = $derived.by(() => {
    if (samples.length < 2) return [];
    if (metric === 'memory') {
      return [
        { key: 'heap', label: 'Heap utilisé', color: 'var(--primary-color)', points: samples.map((s) => ({ t: s.t, v: s.heapUsed / 1024 / 1024 })) },
        { key: 'rss', label: 'RSS', color: '#a855f7', points: samples.map((s) => ({ t: s.t, v: s.rss / 1024 / 1024 })) },
      ];
    }
    if (metric === 'ping') {
      return [
        { key: 'ping', label: 'Ping moyen', color: '#0ea5e9', points: samples.map((s) => ({ t: s.t, v: s.averagePing })) },
        { key: 'cpu', label: 'CPU (%)', color: '#f59e0b', points: samples.map((s) => ({ t: s.t, v: s.cpu })) },
      ];
    }
    return [
      { key: 'guilds', label: 'Serveurs', color: '#10b981', points: samples.map((s) => ({ t: s.t, v: s.guilds })) },
      { key: 'shards', label: 'Shards en ligne', color: '#ef4444', points: samples.map((s) => ({ t: s.t, v: s.onlineShards })) },
    ];
  });

  const chartUnit = $derived(metric === 'memory' ? ' Mo' : metric === 'ping' ? '' : '');

  const heapSeries = $derived(samples.map((s) => s.heapUsed));
  const pingSeries = $derived(samples.map((s) => s.averagePing));
  const guildSeries = $derived(samples.map((s) => s.guilds));

  const heapPercent = $derived(
    stats ? Math.round((stats.memoryUsage.heapUsed / stats.memoryUsage.heapTotal) * 100) : 0,
  );

  /** Variation du heap sur la fenêtre, en % : c'est le signal de fuite mémoire. */
  const heapDelta = $derived.by(() => {
    if (samples.length < 2) return null;
    const first = samples[0].heapUsed;
    const last = samples[samples.length - 1].heapUsed;
    if (first === 0) return null;
    return ((last - first) / first) * 100;
  });

  const pingDelta = $derived.by(() => {
    if (samples.length < 2) return null;
    const first = samples[0].averagePing;
    const last = samples[samples.length - 1].averagePing;
    if (first === 0) return null;
    return ((last - first) / first) * 100;
  });

  const shardsHealthy = $derived(stats ? stats.onlineShardCount === stats.shardCount && stats.shardCount > 0 : false);

  /**
   * Points d'attention : la vue d'ensemble doit dire quoi faire, pas seulement
   * afficher des nombres.
   */
  const alerts = $derived.by(() => {
    const list: { tone: AdminTone; icon: string; title: string; detail: string; href?: string }[] = [];
    if (!stats) return list;

    if (!shardsHealthy) {
      list.push({
        tone: 'danger',
        icon: 'Zap',
        title: `${stats.shardCount - stats.onlineShardCount} shard(s) hors ligne`,
        detail: 'Des serveurs ne reçoivent plus d’événements tant que le shard n’est pas revenu.',
        href: '/admin/shards',
      });
    }
    if (heapPercent > 85) {
      list.push({
        tone: 'danger',
        icon: 'AlertTriangle',
        title: `Mémoire heap à ${heapPercent}%`,
        detail: 'Le processus approche de sa limite : un redémarrage contrôlé vaut mieux qu’un OOM.',
      });
    } else if (heapDelta !== null && heapDelta > 25 && window_ >= 60) {
      list.push({
        tone: 'warning',
        icon: 'TrendingUp',
        title: `Heap +${heapDelta.toFixed(0)}% sur la fenêtre`,
        detail: 'Croissance continue : surveillez, cela ressemble à une fuite mémoire.',
      });
    }
    if (stats.averageShardPing > 250) {
      list.push({
        tone: 'warning',
        icon: 'activity',
        title: `Ping Discord élevé (${stats.averageShardPing} ms)`,
        detail: 'Latence passerelle dégradée : les interactions peuvent expirer.',
      });
    }

    const inactive = guilds.filter((g) => !g.activated).length;
    if (inactive > 0) {
      list.push({
        tone: 'info',
        icon: 'Key',
        title: `${inactive} serveur(s) non activé(s)`,
        detail: 'Ils n’ont pas consommé de code d’activation et n’ont accès qu’aux fonctions de base.',
        href: '/admin/servers',
      });
    }

    return list;
  });

  const topGuilds = $derived([...guilds].sort((a, b) => b.memberCount - a.memberCount).slice(0, 6));
  const activatedCount = $derived(guilds.filter((g) => g.activated).length);

  // ── Formatage ─────────────────────────────────────────────────────────────
  function formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}j ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
  }

  function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 o';
    const units = ['o', 'Ko', 'Mo', 'Go'];
    const index = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${parseFloat((bytes / 1024 ** index).toFixed(1))} ${units[index]}`;
  }

  function formatNumber(value: number): string {
    return value.toLocaleString('fr-FR');
  }

  function relativeTime(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime();
    const minutes = Math.round(diff / 60_000);
    if (minutes < 1) return "à l'instant";
    if (minutes < 60) return `il y a ${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `il y a ${hours} h`;
    return `il y a ${Math.round(hours / 24)} j`;
  }
</script>

<AdminShell
  title="Vue d’ensemble"
  description="État de l’instance Kotbo, tendances de santé et points demandant une intervention."
>
  {#snippet actions()}
    {#if lastRefresh}
      <span class="text-[12px] text-on-surface-variant tabular-nums hidden sm:block">
        Actualisé {relativeTime(lastRefresh.toISOString())}
      </span>
    {/if}
    <button
      type="button"
      onclick={() => load(true)}
      class="h-9 px-3.5 rounded-xl bg-on-surface/6 hover:bg-on-surface/10 border border-outline-variant/25 text-[13px] font-semibold text-on-surface-variant hover:text-on-surface transition inline-flex items-center gap-2"
    >
      <Papicon icon="RefreshCw" size={13} />
      Actualiser
    </button>
  {/snippet}

  {#if error}
    <div class="rounded-2xl border border-red-500/30 bg-red-500/8 p-4 flex items-start gap-3">
      <Papicon icon="AlertTriangle" size={18} class="text-red-500 mt-0.5 shrink-0" />
      <div>
        <p class="text-sm font-semibold text-red-600 dark:text-red-400">Impossible de joindre l’API du bot</p>
        <p class="text-[13px] text-on-surface-variant mt-0.5">{error}</p>
      </div>
    </div>
  {/if}

  <!-- Métriques principales -->
  <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
    <AdminStat
      label="Serveurs"
      value={stats ? formatNumber(stats.guildCount) : '-'}
      hint="{activatedCount} activés"
      icon="Server"
      tone="primary"
      series={guildSeries}
      {loading}
      href="/admin/servers"
    />
    <AdminStat
      label="Membres cumulés"
      value={stats ? formatNumber(stats.userCount) : '-'}
      hint={stats && stats.guildCount > 0 ? `${Math.round(stats.userCount / stats.guildCount)} par serveur` : ''}
      icon="Users"
      tone="info"
      {loading}
    />
    <AdminStat
      label="Shards en ligne"
      value={stats ? `${stats.onlineShardCount}/${stats.shardCount}` : '-'}
      hint="{stats?.averageShardPing ?? 0} ms de ping moyen"
      icon="Zap"
      tone={shardsHealthy ? 'success' : 'danger'}
      series={pingSeries}
      delta={pingDelta}
      {loading}
      href="/admin/shards"
    />
    <AdminStat
      label="Mémoire heap"
      value="{heapPercent}%"
      hint={stats ? `${formatBytes(stats.memoryUsage.heapUsed)} / ${formatBytes(stats.memoryUsage.heapTotal)}` : ''}
      icon="Cpu"
      tone={heapPercent > 85 ? 'danger' : heapPercent > 65 ? 'warning' : 'success'}
      series={heapSeries}
      delta={heapDelta}
      {loading}
    />
  </div>

  <!-- Points d'attention -->
  {#if alerts.length > 0}
    <AdminCard title="Points d’attention" icon="AlertTriangle" tone={alerts.some((a) => a.tone === 'danger') ? 'danger' : 'warning'}>
      <ul class="space-y-2">
        {#each alerts as alert (alert.title)}
          <li class="flex items-start gap-3 p-3 rounded-xl bg-surface-container-low/50 border border-outline-variant/20">
            <div
              class="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center
                {alert.tone === 'danger' ? 'bg-red-500/12 text-red-500'
                  : alert.tone === 'warning' ? 'bg-amber-500/12 text-amber-500'
                    : 'bg-sky-500/12 text-sky-500'}"
            >
              <Papicon icon={alert.icon} size={15} />
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-[13.5px] font-semibold text-on-surface">{alert.title}</p>
              <p class="text-[12.5px] text-on-surface-variant mt-0.5 leading-snug">{alert.detail}</p>
            </div>
            {#if alert.href}
              <a
                href={alert.href}
                class="shrink-0 h-8 px-3 rounded-lg bg-on-surface/6 hover:bg-on-surface/10 text-[12px] font-semibold text-on-surface-variant hover:text-on-surface transition inline-flex items-center gap-1.5"
              >
                Ouvrir
                <Papicon icon="ChevronRight" size={11} />
              </a>
            {/if}
          </li>
        {/each}
      </ul>
    </AdminCard>
  {:else if !loading && stats}
    <div class="rounded-2xl border border-emerald-500/25 bg-emerald-500/8 p-4 flex items-center gap-3">
      <Papicon icon="CheckCircle" size={18} class="text-emerald-500 shrink-0" />
      <p class="text-[13.5px] text-emerald-700 dark:text-emerald-300">
        Aucun point d’attention : shards complets, mémoire et latence dans les clous.
      </p>
    </div>
  {/if}

  <!-- Historique de santé -->
  <AdminCard title="Santé dans le temps" icon="activity" tone="primary" padded={false}>
    {#snippet actions()}
      <div class="flex items-center gap-1 p-0.5 rounded-lg bg-on-surface/6">
        {#each [
          { value: 'memory' as const, label: 'Mémoire' },
          { value: 'ping' as const, label: 'Latence' },
          { value: 'reach' as const, label: 'Couverture' },
        ] as option (option.value)}
          <button
            type="button"
            onclick={() => (metric = option.value)}
            class="h-7 px-2.5 rounded-md text-[12px] font-semibold transition
              {metric === option.value ? 'bg-surface-container-lowest text-on-surface shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}"
          >
            {option.label}
          </button>
        {/each}
      </div>
      <div class="flex items-center gap-1 p-0.5 rounded-lg bg-on-surface/6">
        {#each windows as option (option.value)}
          <button
            type="button"
            onclick={() => changeWindow(option.value)}
            class="h-7 px-2.5 rounded-md text-[12px] font-semibold transition
              {window_ === option.value ? 'bg-surface-container-lowest text-on-surface shadow-sm' : 'text-on-surface-variant hover:text-on-surface'}"
          >
            {option.label}
          </button>
        {/each}
      </div>
    {/snippet}

    <div class="p-5">
      <AdminTimeSeries
        series={chartSeries}
        formatValue={(value) => `${Math.round(value)}${chartUnit}`}
        emptyLabel="L’historique se remplit à partir de la première consultation de la console - revenez dans quelques minutes."
      />

      {#if series?.peak && samples.length > 1}
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5 pt-4 border-t border-outline-variant/20">
          <div>
            <p class="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Pic heap</p>
            <p class="text-[15px] font-semibold text-on-surface tabular-nums mt-0.5">{formatBytes(series.peak.heapUsed)}</p>
          </div>
          <div>
            <p class="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Pic RSS</p>
            <p class="text-[15px] font-semibold text-on-surface tabular-nums mt-0.5">{formatBytes(series.peak.rss)}</p>
          </div>
          <div>
            <p class="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Pic ping</p>
            <p class="text-[15px] font-semibold text-on-surface tabular-nums mt-0.5">{series.peak.averagePing} ms</p>
          </div>
          <div>
            <p class="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant">Tendance heap</p>
            <p class="text-[15px] font-semibold tabular-nums mt-0.5 {series.heapTrendPerHour > 0 ? 'text-amber-500' : 'text-emerald-500'}">
              {series.heapTrendPerHour >= 0 ? '+' : ''}{formatBytes(Math.abs(series.heapTrendPerHour))}/h
            </p>
          </div>
        </div>
      {/if}
    </div>
  </AdminCard>

  <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
    <!-- Système -->
    <AdminCard title="Processus" icon="Cpu" tone="info">
      <dl class="space-y-2.5">
        {#each [
          { label: 'Uptime', value: stats ? formatUptime(stats.uptime) : '-' },
          { label: 'RSS', value: stats ? formatBytes(stats.memoryUsage.rss) : '-' },
          { label: 'Heap total', value: stats ? formatBytes(stats.memoryUsage.heapTotal) : '-' },
          { label: 'Externe', value: stats ? formatBytes(stats.memoryUsage.external) : '-' },
          { label: 'Sanctions actives', value: stats ? formatNumber(stats.activeSanctions) : '-' },
          { label: 'Soumissions algo', value: stats ? formatNumber(stats.dailyAlgoSubmissions) : '-' },
        ] as entry (entry.label)}
          <div class="flex items-center justify-between gap-3">
            <dt class="text-[13px] text-on-surface-variant">{entry.label}</dt>
            <dd class="text-[13px] font-semibold text-on-surface tabular-nums">{entry.value}</dd>
          </div>
        {/each}
      </dl>
    </AdminCard>

    <!-- Plus gros serveurs -->
    <AdminCard title="Plus gros serveurs" icon="Server" tone="primary">
      {#snippet actions()}
        <a href="/admin/servers" class="text-[12px] font-semibold text-primary hover:underline">Tout voir</a>
      {/snippet}

      {#if topGuilds.length === 0}
        <p class="text-[13px] text-on-surface-variant py-4 text-center">Aucun serveur chargé.</p>
      {:else}
        <ul class="space-y-2">
          {#each topGuilds as guild (guild.id)}
            <li class="flex items-center gap-2.5">
              <div class="w-7 h-7 shrink-0 rounded-lg bg-on-surface/6 overflow-hidden flex items-center justify-center">
                {#if guild.icon}
                  <img src={guild.icon} alt="" class="w-full h-full object-cover" loading="lazy" />
                {:else}
                  <Papicon icon="Server" size={12} class="text-on-surface-variant" />
                {/if}
              </div>
              <span class="flex-1 min-w-0 text-[13px] font-medium text-on-surface truncate">{guild.name}</span>
              {#if !guild.activated}
                <AdminBadge size="sm" label="Inactif" tone="warning" />
              {/if}
              <span class="text-[12px] font-semibold text-on-surface-variant tabular-nums">{formatNumber(guild.memberCount)}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </AdminCard>

    <!-- Activité admin -->
    <AdminCard title="Activité admin" icon="ClipboardList" tone="neutral">
      {#snippet actions()}
        <a href="/admin/audit" class="text-[12px] font-semibold text-primary hover:underline">Journal</a>
      {/snippet}

      {#if auditTrail.length === 0}
        <p class="text-[13px] text-on-surface-variant py-4 text-center leading-snug">
          Aucune action enregistrée pour l’instant. Le journal se remplit dès la prochaine action sensible.
        </p>
      {:else}
        <ul class="space-y-2.5">
          {#each auditTrail.slice(0, 6) as entry (entry.id)}
            <li class="flex items-start gap-2.5">
              <span class="w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 {entry.outcome === 'OK' ? 'bg-emerald-500' : 'bg-red-500'}"></span>
              <div class="min-w-0">
                <p class="text-[12.5px] text-on-surface leading-snug">{entry.summary}</p>
                <p class="text-[11px] text-on-surface-variant mt-0.5">
                  <span class="font-mono">{entry.action}</span> · {relativeTime(entry.createdAt)}
                </p>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </AdminCard>
  </div>

  <!-- Dernières annonces -->
  {#if recentBroadcasts.length > 0}
    <AdminCard title="Dernières annonces globales" icon="Megaphone" tone="warning">
      {#snippet actions()}
        <a href="/admin/broadcast" class="text-[12px] font-semibold text-primary hover:underline">Console d’annonces</a>
      {/snippet}

      <ul class="space-y-2">
        {#each recentBroadcasts as log (log.id)}
          <li class="flex items-center gap-3 p-2.5 rounded-xl bg-surface-container-low/40 border border-outline-variant/20">
            <span class="w-1 h-8 rounded-full shrink-0" style="background: {log.color}"></span>
            <div class="min-w-0 flex-1">
              <p class="text-[13px] font-semibold text-on-surface truncate">{log.title}</p>
              <p class="text-[11.5px] text-on-surface-variant">{relativeTime(log.createdAt)} · {log.username ?? log.sentBy}</p>
            </div>
            <div class="text-right shrink-0">
              <p class="text-[13px] font-semibold text-on-surface tabular-nums">
                <span class="text-emerald-500">{log.successCount}</span>
                {#if log.failCount > 0}
                  <span class="text-on-surface-variant">/</span><span class="text-red-500">{log.failCount}</span>
                {/if}
              </p>
              <p class="text-[11px] text-on-surface-variant tabular-nums">sur {log.totalTargeted}</p>
            </div>
          </li>
        {/each}
      </ul>
    </AdminCard>
  {/if}
</AdminShell>
