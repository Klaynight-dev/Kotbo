<script lang="ts">
  import { onMount } from 'svelte';
  import { router } from 'tinro';
  import { resolveTabFromUrl, gotoTab } from '../lib/tabRouting';
  import { fetchPulseData, refreshPulse, fetchPredictions } from '../lib/api';
  import { toast } from '../lib/stores/toast.svelte';
  import ModulePage from '../lib/components/ModulePage.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import EmptyState from '../lib/components/EmptyState.svelte';

  type TabId = 'sante' | 'predictions' | 'apercu';

  let loading = $state(true);
  let pulseData: any = $state(null);
  let predData: any = $state(null);
  const pulseTabs = ['apercu', 'sante', 'predictions'] as const;
  let activeTab: TabId = $state('apercu');

  $effect(() => {
    const _path = $router.path;
    activeTab = resolveTabFromUrl('/pulse', pulseTabs, 'apercu') as TabId;
  });
  let period = $state(30);

  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: 'apercu', label: 'Aperçu', icon: 'layout' },
    { id: 'sante', label: 'Santé', icon: 'heart' },
    { id: 'predictions', label: 'Prédictions', icon: 'trending-up' },
  ];

  async function load() {
    loading = true;
    try {
      const [pulse, pred] = await Promise.all([
        fetchPulseData(),
        fetchPredictions(period),
      ]);
      pulseData = pulse;
      predData = pred;
    } catch {
      toast.error('Erreur lors du chargement des données');
    } finally {
      loading = false;
    }
  }

  async function handleRefresh() {
    try {
      const [pulse, pred] = await Promise.all([
        refreshPulse(),
        fetchPredictions(period),
      ]);
      pulseData = pulse;
      predData = pred;
      toast.success('Pulse recalculé');
    } catch {
      toast.error('Erreur lors du rafraîchissement');
    }
  }

  async function changePeriod(p: number) {
    period = p;
    try {
      predData = await fetchPredictions(period);
    } catch {
      toast.error('Erreur lors du chargement des prédictions');
    }
  }

  // ---- Pulse helpers ----
  function getScoreColor(score: number): string {
    if (score >= 80) return '#10b981';
    if (score >= 60) return 'var(--primary-color)';
    if (score >= 40) return '#f59e0b';
    return '#f43f5e';
  }

  function getScoreLabel(score: number): string {
    if (score >= 80) return 'Excellent';
    if (score >= 60) return 'Bon';
    if (score >= 40) return 'Moyen';
    if (score >= 20) return 'Faible';
    return 'Critique';
  }

  function getTrendIcon(trend: string): string {
    if (trend === 'UP') return 'trending-up';
    if (trend === 'DOWN') return 'trending-down';
    return 'minus';
  }

  function getAlertClasses(severity: string): string {
    if (severity === 'danger') return 'bg-rose-500/10 text-rose-500 border border-rose-500/15';
    if (severity === 'warning') return 'bg-amber-500/10 text-amber-500 border border-amber-500/15';
    if (severity === 'success') return 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/15';
    return 'bg-primary/10 text-primary border border-primary/15';
  }

  function getAlertIcon(severity: string): string {
    if (severity === 'success') return 'check-circle';
    if (severity === 'danger') return 'alert-circle';
    return 'alert-triangle';
  }

  // ---- Predictions helpers ----
  function getAnomalyClasses(severity: string): string {
    if (severity === 'danger') return 'bg-rose-500/10 text-rose-500 border border-rose-500/15';
    if (severity === 'warning') return 'bg-amber-500/10 text-amber-500 border border-amber-500/15';
    return 'bg-primary/10 text-primary border border-primary/15';
  }

  onMount(load);
</script>

<ModulePage
  title="Pulse — Intelligence Serveur"
  description="Score de santé, prédictions et analyse en temps réel."
  icon="activity"
>
  {#snippet actions()}
    <button class="px-4 py-2 bg-primary text-on-primary text-[13px] font-medium rounded-xl shadow-sm active:scale-[0.98] transition-all flex items-center gap-2" onclick={handleRefresh}>
      <Papicon icon="refresh-cw" size={16} />
      Recalculer
    </button>
    <div class="flex gap-1">
      {#each [7, 14, 30, 60, 90] as p}
        <button
          class="px-3 py-1.5 text-xs font-bold rounded-lg transition-all {period === p ? 'bg-primary text-on-primary shadow-sm' : 'bg-surface-container-high/40 text-on-surface-variant hover:bg-surface-container-high/60'}"
          onclick={() => changePeriod(p)}
        >{p}j</button>
      {/each}
    </div>
  {/snippet}

<!-- ======================== TABS ======================== -->
<div class="tab-group w-fit mb-6">
  {#each tabs as tab}
    <button
      class="tab-button {activeTab === tab.id ? 'active' : ''}"
      onclick={() => gotoTab('/pulse', tab.id, 'apercu')}
    >
      <Papicon icon={tab.icon} size={15} />
      {tab.label}
    </button>
  {/each}
</div>

<!-- ======================== CONTENT ======================== -->
{#if loading}
  <div class="flex flex-col items-center justify-center py-16 text-on-surface-variant/50 gap-4">
    <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
    <p class="text-sm">Chargement des données...</p>
  </div>
{:else}

  <!-- ==================== TAB: SANTE ==================== -->
  {#if activeTab === 'sante'}
    {#if pulseData}
      <div class="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
        <!-- Score principal -->
        <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 flex flex-col items-center justify-center gap-3">
          <div class="w-36 h-36 rounded-full border-[6px] flex flex-col items-center justify-center" style="border-color: {getScoreColor(pulseData.current.score)}">
            <span class="text-5xl font-bold text-on-surface leading-none">{pulseData.current.score}</span>
            <span class="text-sm text-on-surface-variant/60">/100</span>
          </div>
          <div class="text-base font-semibold text-on-surface">{getScoreLabel(pulseData.current.score)}</div>
          <div class="flex items-center gap-1 text-sm {pulseData.current.trend === 'UP' ? 'text-emerald-500' : pulseData.current.trend === 'DOWN' ? 'text-rose-500' : 'text-on-surface-variant'}">
            <Papicon icon={getTrendIcon(pulseData.current.trend)} size={16} />
            {#if pulseData.current.trendDelta !== 0}
              <span>{pulseData.current.trendDelta > 0 ? '+' : ''}{pulseData.current.trendDelta} pts</span>
            {:else}
              <span>Stable</span>
            {/if}
          </div>
        </div>

        <!-- Sous-scores -->
        <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
          <h3 class="text-base font-semibold flex items-center gap-2.5">
            <Papicon icon="bar-chart-2" size={18} />
            Détail des scores
          </h3>
          <div class="space-y-3">
            {#each [
              { label: 'Activité', value: pulseData.current.activityScore, icon: 'message-circle' },
              { label: 'Modération', value: pulseData.current.moderationScore, icon: 'shield' },
              { label: 'Croissance', value: pulseData.current.growthScore, icon: 'trending-up' },
              { label: 'Engagement', value: pulseData.current.engagementScore, icon: 'users' },
              { label: 'Santé', value: pulseData.current.healthScore, icon: 'activity' },
            ] as sub}
              <div class="grid grid-cols-[120px_1fr_40px] items-center gap-3">
                <div class="flex items-center gap-2 text-sm text-on-surface-variant">
                  <Papicon icon={sub.icon} size={14} />
                  <span>{sub.label}</span>
                </div>
                <div class="h-2 bg-surface-container-high rounded-full overflow-hidden">
                  <div class="h-2 rounded-full transition-all duration-500" style="width: {sub.value}%; background: {getScoreColor(sub.value)}"></div>
                </div>
                <span class="text-sm font-semibold text-right">{sub.value}</span>
              </div>
            {/each}
          </div>
        </div>

        <!-- Metriques du jour -->
        <div class="lg:col-span-2 bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
          <h3 class="text-base font-semibold flex items-center gap-2.5">
            <Papicon icon="activity" size={18} />
            Métriques du jour
          </h3>
          <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
            <div class="bg-surface-container-high/30 rounded-xl p-4 text-center">
              <div class="text-2xl font-bold">{pulseData.metrics.totalMessages.toLocaleString()}</div>
              <div class="text-xs font-medium text-on-surface-variant/60 mt-1">Messages</div>
            </div>
            <div class="bg-surface-container-high/30 rounded-xl p-4 text-center">
              <div class="text-2xl font-bold">{Math.round(pulseData.metrics.totalVoiceMinutes / 60)}h</div>
              <div class="text-xs font-medium text-on-surface-variant/60 mt-1">Vocal</div>
            </div>
            <div class="bg-surface-container-high/30 rounded-xl p-4 text-center">
              <div class="text-2xl font-bold">{pulseData.metrics.activeMembers}/{pulseData.metrics.totalMembers}</div>
              <div class="text-xs font-medium text-on-surface-variant/60 mt-1">Membres actifs</div>
            </div>
            <div class="bg-surface-container-high/30 rounded-xl p-4 text-center">
              <div class="text-2xl font-bold {pulseData.metrics.membersJoined > pulseData.metrics.membersLeft ? 'text-emerald-500' : ''}">
                +{pulseData.metrics.membersJoined} / -{pulseData.metrics.membersLeft}
              </div>
              <div class="text-xs font-medium text-on-surface-variant/60 mt-1">Arrivées / Départs</div>
            </div>
            <div class="bg-surface-container-high/30 rounded-xl p-4 text-center">
              <div class="text-2xl font-bold">{pulseData.metrics.sanctionsCount}</div>
              <div class="text-xs font-medium text-on-surface-variant/60 mt-1">Sanctions</div>
            </div>
            <div class="bg-surface-container-high/30 rounded-xl p-4 text-center">
              <div class="text-2xl font-bold">{pulseData.metrics.ticketsResolved}/{pulseData.metrics.ticketsOpen + pulseData.metrics.ticketsResolved}</div>
              <div class="text-xs font-medium text-on-surface-variant/60 mt-1">Tickets résolus</div>
            </div>
          </div>
        </div>

        <!-- Alertes -->
        {#if pulseData.current.alerts && pulseData.current.alerts.length > 0}
          <div class="lg:col-span-2 bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
            <h3 class="text-base font-semibold flex items-center gap-2.5">
              <Papicon icon="alert-triangle" size={18} />
              Alertes & Recommandations
            </h3>
            <div class="space-y-2">
              {#each pulseData.current.alerts as alert}
                <div class="flex items-center gap-3 px-4 py-3 rounded-xl text-sm {getAlertClasses(alert.severity)}">
                  <Papicon icon={getAlertIcon(alert.severity)} size={16} />
                  <span>{alert.message}</span>
                </div>
              {/each}
            </div>
          </div>
        {/if}

        <!-- Historique 30j -->
        {#if pulseData.history && pulseData.history.length > 1}
          <div class="lg:col-span-2 bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
            <h3 class="text-base font-semibold flex items-center gap-2.5">
              <Papicon icon="bar-chart" size={18} />
              Évolution sur 30 jours
            </h3>
            <div class="flex items-end gap-0.5 h-[120px]">
              {#each pulseData.history as point}
                <div
                  class="flex-1 min-w-1 rounded-t transition-all duration-300 hover:opacity-100 opacity-80"
                  style="height: {point.score}%; background: {getScoreColor(point.score)}"
                  title="{point.dateKey}: {point.score}/100"
                ></div>
              {/each}
            </div>
            <div class="flex justify-between text-xs font-medium text-on-surface-variant/60">
              <span>{pulseData.history[0]?.dateKey?.slice(5)}</span>
              <span>{pulseData.history[pulseData.history.length - 1]?.dateKey?.slice(5)}</span>
            </div>
          </div>
        {/if}
      </div>
    {:else}
      <EmptyState icon="heart" title="Aucune donnée Pulse" description="Cliquez sur « Recalculer » pour générer le premier snapshot." />
    {/if}

  <!-- ==================== TAB: PREDICTIONS ==================== -->
  {:else if activeTab === 'predictions'}
    {#if predData}
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <!-- Forecast cards -->
        <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
          <h3 class="text-base font-semibold flex items-center gap-2.5">
            <Papicon icon="trending-up" size={18} />
            Prévision de croissance
          </h3>
          <div class="grid grid-cols-3 gap-4">
            <div class="bg-surface-container-high/30 rounded-xl 0 p-4 text-center">
              <div class="text-2xl font-bold">{predData.growthForecast.predicted7d.toLocaleString()}</div>
              <div class="text-xs font-medium text-on-surface-variant/60 mt-1">Membres 7j</div>
            </div>
            <div class="bg-surface-container-high/30 rounded-xl p-4 text-center">
              <div class="text-2xl font-bold">{predData.growthForecast.predicted30d.toLocaleString()}</div>
              <div class="text-xs font-medium text-on-surface-variant/60 mt-1">Membres 30j</div>
            </div>
            <div class="bg-surface-container-high/30 rounded-xl p-4 text-center">
              <div class="text-2xl font-bold">{predData.growthForecast.confidence}%</div>
              <div class="text-xs font-medium text-on-surface-variant/60 mt-1">Confiance</div>
            </div>
          </div>
        </div>

        <!-- Seasonality -->
        <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
          <h3 class="text-base font-semibold flex items-center gap-2.5">
            <Papicon icon="clock" size={18} />
            Saisonnalité
          </h3>
          <div class="space-y-3">
            <div class="flex items-center gap-2.5 text-sm text-on-surface-variant">
              <Papicon icon="arrow-up-circle" size={16} />
              <span>Jour le plus actif: <strong class="text-on-surface">{predData.seasonality.busiestDay}</strong></span>
            </div>
            <div class="flex items-center gap-2.5 text-sm text-on-surface-variant">
              <Papicon icon="arrow-down-circle" size={16} />
              <span>Jour le plus calme: <strong class="text-on-surface">{predData.seasonality.quietestDay}</strong></span>
            </div>
            <div class="flex items-center gap-2.5 text-sm text-on-surface-variant">
              <Papicon icon="clock" size={16} />
              <span>Heure de pointe: <strong class="text-on-surface">{predData.seasonality.busiestHour}h</strong></span>
            </div>
            <div class="flex items-center gap-2.5 text-sm text-on-surface-variant">
              <Papicon icon="moon" size={16} />
              <span>Heure creuse: <strong class="text-on-surface">{predData.seasonality.quietestHour}h</strong></span>
            </div>
          </div>
        </div>

        <!-- Trend charts -->
        {#each [
          { title: 'Membres', data: predData.membersTrend, color: 'var(--primary-color)' },
          { title: 'Messages', data: predData.messagesTrend, color: '#10b981' },
          { title: 'Minutes vocales', data: predData.voiceTrend, color: '#f59e0b' },
        ] as trend}
          {#if trend.data && trend.data.length > 0}
            {@const maxVal = Math.max(...trend.data.map((p: any) => p.value), 1)}
            <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
              <h3 class="text-base font-semibold flex items-center gap-2.5">
                <Papicon icon="bar-chart-2" size={18} />
                {trend.title}
              </h3>
              <div class="flex items-end gap-0.5 h-[100px]">
                {#each trend.data as point}
                  <div
                    class="flex-1 min-w-1 rounded-t transition-all duration-300 hover:opacity-100 {point.predicted ? 'opacity-40 border border-dotted' : 'opacity-80'}"
                    style="height: {(point.value / maxVal) * 100}%; background: {trend.color}"
                    title="{point.dateKey}: {point.value}"
                  ></div>
                {/each}
              </div>
              <div class="flex gap-4 text-xs font-medium text-on-surface-variant/60">
                <span class="flex items-center gap-1.5">
                  <span class="w-2 h-2 rounded-sm" style="background: {trend.color}"></span>
                  Réel
                </span>
                <span class="flex items-center gap-1.5">
                  <span class="w-2 h-2 rounded-sm opacity-40" style="background: {trend.color}"></span>
                  Prédit
                </span>
              </div>
            </div>
          {/if}
        {/each}

        <!-- Anomalies -->
        {#if predData.anomalies && predData.anomalies.length > 0}
          <div class="lg:col-span-2 bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
            <h3 class="text-base font-semibold flex items-center gap-2.5">
              <Papicon icon="alert-triangle" size={18} />
              Anomalies détectées
            </h3>
            <div class="space-y-2">
              {#each predData.anomalies as anomaly}
                <div class="flex items-center gap-3 px-4 py-3 rounded-xl text-sm {getAnomalyClasses(anomaly.severity)}">
                  <Papicon icon={anomaly.type === 'spike' ? 'arrow-up' : 'arrow-down'} size={16} />
                  <span class="flex-1">{anomaly.message}</span>
                  <span class="text-xs text-on-surface-variant/60">Attendu: {anomaly.expectedRange.min} &mdash; {anomaly.expectedRange.max}</span>
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    {:else}
      <EmptyState icon="trending-up" title="Aucune donnée de prédiction" description="Les prédictions apparaîtront quand assez d'historique aura été collecté." />
    {/if}

  <!-- ==================== TAB: APERCU ==================== -->
  {:else if activeTab === 'apercu'}
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <!-- Left: Pulse summary -->
      <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
        <h3 class="text-base font-semibold flex items-center gap-2.5">
          <Papicon icon="heart" size={18} />
          Santé du serveur
        </h3>
        {#if pulseData}
          <div class="flex items-center gap-4">
            <div class="w-20 h-20 rounded-full border-[5px] flex flex-col items-center justify-center shrink-0" style="border-color: {getScoreColor(pulseData.current.score)}">
              <span class="text-2xl font-bold text-on-surface leading-none">{pulseData.current.score}</span>
              <span class="text-[10px] text-on-surface-variant/60">/100</span>
            </div>
            <div class="flex flex-col gap-1">
              <span class="text-base font-semibold">{getScoreLabel(pulseData.current.score)}</span>
              <div class="flex items-center gap-1 text-sm {pulseData.current.trend === 'UP' ? 'text-emerald-500' : pulseData.current.trend === 'DOWN' ? 'text-rose-500' : 'text-on-surface-variant'}">
                <Papicon icon={getTrendIcon(pulseData.current.trend)} size={14} />
                {#if pulseData.current.trendDelta !== 0}
                  <span>{pulseData.current.trendDelta > 0 ? '+' : ''}{pulseData.current.trendDelta} pts</span>
                {:else}
                  <span>Stable</span>
                {/if}
              </div>
            </div>
          </div>
          <!-- Quick subscores -->
          <div class="space-y-2">
            {#each [
              { label: 'Activité', value: pulseData.current.activityScore },
              { label: 'Modération', value: pulseData.current.moderationScore },
              { label: 'Croissance', value: pulseData.current.growthScore },
              { label: 'Engagement', value: pulseData.current.engagementScore },
              { label: 'Santé', value: pulseData.current.healthScore },
            ] as sub}
              <div class="grid grid-cols-[90px_1fr_30px] items-center gap-2">
                <span class="text-xs text-on-surface-variant/60">{sub.label}</span>
                <div class="h-1.5 bg-surface-container-high rounded-full overflow-hidden">
                  <div class="h-1.5 rounded-full transition-all duration-500" style="width: {sub.value}%; background: {getScoreColor(sub.value)}"></div>
                </div>
                <span class="text-xs font-semibold text-right">{sub.value}</span>
              </div>
            {/each}
          </div>
          <!-- Alerts -->
          {#if pulseData.current.alerts && pulseData.current.alerts.length > 0}
            <div class="space-y-1.5 pt-2 border-t border-outline-variant/10">
              <h4 class="text-[13px] font-medium text-on-surface-variant/60">Alertes</h4>
              {#each pulseData.current.alerts.slice(0, 3) as alert}
                <div class="flex items-center gap-2 px-3 py-2 rounded-lg text-xs {getAlertClasses(alert.severity)}">
                  <Papicon icon={getAlertIcon(alert.severity)} size={14} />
                  <span>{alert.message}</span>
                </div>
              {/each}
            </div>
          {/if}
        {:else}
          <p class="text-sm text-on-surface-variant/60">Aucune donnée Pulse</p>
        {/if}
      </div>

      <!-- Right: Predictions summary -->
      <div class="bg-surface-container-low/30 border border-outline-variant/10 rounded-xl p-6 space-y-4">
        <h3 class="text-base font-semibold flex items-center gap-2.5">
          <Papicon icon="trending-up" size={18} />
          Prédictions
        </h3>
        {#if predData}
          <div class="grid grid-cols-3 gap-3">
            <div class="bg-surface-container-high/30 rounded-xl p-3 text-center">
              <div class="text-lg font-bold">{predData.growthForecast.predicted7d.toLocaleString()}</div>
              <div class="text-xs font-medium text-on-surface-variant/60 mt-0.5">Membres 7j</div>
            </div>
            <div class="bg-surface-container-high/30 rounded-xl p-3 text-center">
              <div class="text-lg font-bold">{predData.growthForecast.predicted30d.toLocaleString()}</div>
              <div class="text-xs font-medium text-on-surface-variant/60 mt-0.5">Membres 30j</div>
            </div>
            <div class="bg-surface-container-high/30 rounded-xl p-3 text-center">
              <div class="text-lg font-bold">{predData.growthForecast.confidence}%</div>
              <div class="text-xs font-medium text-on-surface-variant/60 mt-0.5">Confiance</div>
            </div>
          </div>
          <div class="space-y-2 text-sm text-on-surface-variant">
            <span class="flex items-center gap-2">
              <Papicon icon="arrow-up-circle" size={14} />
              Pic: <strong class="text-on-surface">{predData.seasonality.busiestDay}</strong> à <strong class="text-on-surface">{predData.seasonality.busiestHour}h</strong>
            </span>
            <span class="flex items-center gap-2">
              <Papicon icon="arrow-down-circle" size={14} />
              Creux: <strong class="text-on-surface">{predData.seasonality.quietestDay}</strong> à <strong class="text-on-surface">{predData.seasonality.quietestHour}h</strong>
            </span>
          </div>
          <!-- Anomalies -->
          {#if predData.anomalies && predData.anomalies.length > 0}
            <div class="space-y-1.5 pt-2 border-t border-outline-variant/10">
              <h4 class="text-[13px] font-medium text-on-surface-variant/60">Anomalies</h4>
              {#each predData.anomalies.slice(0, 3) as anomaly}
                <div class="flex items-center gap-2 px-3 py-2 rounded-lg text-xs {getAnomalyClasses(anomaly.severity)}">
                  <Papicon icon={anomaly.type === 'spike' ? 'arrow-up' : 'arrow-down'} size={14} />
                  <span>{anomaly.message}</span>
                </div>
              {/each}
            </div>
          {/if}
        {:else}
          <p class="text-sm text-on-surface-variant/60">Aucune donnée de prédiction</p>
        {/if}
      </div>
    </div>
  {/if}
{/if}
</ModulePage>
