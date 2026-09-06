<script lang="ts">
  /**
   * Analytics.svelte
   *
   * Tableau de bord d'analyse commerciale et du tunnel d'acquisition.
   * Onglets :
   *   1. Tunnel d'acquisition (visite -> invite -> onboarding -> paiement)
   *   2. Revenus & MRR (cascade MRR, ARPA, répartition, factures)
   *   3. Segments & Paliers (dimension drilldown, matrice hors palier)
   *   4. Rétention, Produit & Risques (cohortes M0-M12, signaux faibles, modules)
   *   5. Seuils & Alertes (configuration des alertes Discord)
   */
  import { onMount } from 'svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';
  import AdminCard from '../../lib/components/admin/AdminCard.svelte';
  import AdminStat from '../../lib/components/admin/AdminStat.svelte';
  import AdminDrawer from '../../lib/components/admin/AdminDrawer.svelte';
  import Papicon from '../../lib/components/Papicon.svelte';
  import { toast } from '../../lib/stores/toast.svelte';
  import type { AnalyticsDimension } from '@kotbo/contracts';
  import {
    fetchAdminFunnelStats,
    fetchAdminOnboardingFunnel,
    fetchAdminRevenueStats,
    fetchAdminRetentionCohorts,
    fetchAdminSegmentsStats,
    fetchAdminModuleCorrelations,
    fetchAdminAnalyticsGuilds,
    fetchAdminRisksSummary,
    fetchAdminAlertThresholds,
    saveAdminAlertThresholds,
    downloadAdminAnalyticsCsv,
    type FunnelStatsResult,
    type OnboardingFunnelResult,
    type RevenueStatsResult,
    type CohortRow,
    type SegmentsStatsResult,
    type ModuleCorrelationsResult,
    type RisksSummaryResult,
    type AlertThresholds,
    type GuildExplorerItem,
  } from '../../lib/api';

  // ── Navigation & Filtres ───────────────────────────────────────────────────
  type TabKey = 'funnel' | 'revenue' | 'segments' | 'retention' | 'alerts';
  let activeTab = $state<TabKey>('funnel');

  type PeriodPreset = '7d' | '30d' | '90d' | '12m' | 'custom';
  let periodPreset = $state<PeriodPreset>('30d');
  let customFrom = $state('');
  let customTo = $state('');
  let comparePrevious = $state(false);

  let loading = $state(true);
  let error = $state<string | null>(null);

  // ── Données des onglets ────────────────────────────────────────────────────
  let funnelData = $state<FunnelStatsResult | null>(null);
  let onboardingData = $state<OnboardingFunnelResult | null>(null);
  let revenueData = $state<RevenueStatsResult | null>(null);
  let cohortsData = $state<CohortRow[]>([]);
  let segmentsData = $state<SegmentsStatsResult | null>(null);
  let modulesData = $state<ModuleCorrelationsResult | null>(null);
  let risksData = $state<RisksSummaryResult | null>(null);
  let alertThresholds = $state<AlertThresholds | null>(null);
  let recentAlerts = $state<Array<{ key: string; lastFiredAt: string; lastValue: number | null }>>([]);

  // Segments dimension
  let selectedDimension = $state<AnalyticsDimension>('size');

  // ── Panneau latéral d'inspection (Drilldown) ──────────────────────────────
  let drawerOpen = $state(false);
  let drawerTitle = $state('Détail des serveurs');
  let drawerSubtitle = $state('');
  let drawerFilter = $state<string | undefined>(undefined);
  let drawerDimension = $state<AnalyticsDimension | undefined>(undefined);
  let drawerBucket = $state<string | undefined>(undefined);
  let drawerGuilds = $state<GuildExplorerItem[]>([]);
  let drawerPage = $state(1);
  let drawerTotalPages = $state(1);
  let drawerTotalCount = $state(0);
  let drawerLoading = $state(false);

  // ── Calcul des bornes de dates ─────────────────────────────────────────────
  function getQueryDates() {
    if (periodPreset === 'custom' && customFrom && customTo) {
      return { from: customFrom, to: customTo };
    }
    const now = new Date();
    const to = now.toISOString();
    let fromDate = new Date();

    if (periodPreset === '7d') fromDate.setDate(now.getDate() - 7);
    else if (periodPreset === '30d') fromDate.setDate(now.getDate() - 30);
    else if (periodPreset === '90d') fromDate.setDate(now.getDate() - 90);
    else if (periodPreset === '12m') fromDate.setFullYear(now.getFullYear() - 1);

    return { from: fromDate.toISOString(), to };
  }

  // ── Chargement principal ───────────────────────────────────────────────────
  async function loadAll() {
    loading = true;
    error = null;
    const { from, to } = getQueryDates();

    try {
      if (activeTab === 'funnel') {
        const [funnel, onboarding] = await Promise.all([
          fetchAdminFunnelStats({ from, to, compare: comparePrevious }),
          fetchAdminOnboardingFunnel({ from, to }),
        ]);
        funnelData = funnel;
        onboardingData = onboarding;
      } else if (activeTab === 'revenue') {
        revenueData = await fetchAdminRevenueStats({ from, to, compare: comparePrevious });
      } else if (activeTab === 'segments') {
        segmentsData = await fetchAdminSegmentsStats({ dimension: selectedDimension, from, to });
      } else if (activeTab === 'retention') {
        const [cohortsRes, modulesRes, risksRes] = await Promise.all([
          fetchAdminRetentionCohorts(),
          fetchAdminModuleCorrelations(),
          fetchAdminRisksSummary(),
        ]);
        cohortsData = cohortsRes.cohorts;
        modulesData = modulesRes;
        risksData = risksRes;
      } else if (activeTab === 'alerts') {
        const alertsRes = await fetchAdminAlertThresholds();
        alertThresholds = alertsRes.thresholds;
        recentAlerts = alertsRes.recentAlerts;
      }
    } catch (err) {
      error = err instanceof Error ? err.message : 'Erreur de chargement des statistiques';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    // Recharger lors d'un changement d'onglet ou de filtre
    const _tab = activeTab;
    const _preset = periodPreset;
    const _comp = comparePrevious;
    const _dim = selectedDimension;
    void loadAll();
  });

  onMount(() => {
    void loadAll();
  });

  // ── Drilldown Drawer ───────────────────────────────────────────────────────
  async function openDrawer(params: {
    title: string;
    subtitle?: string;
    filter?: string;
    dimension?: AnalyticsDimension;
    bucket?: string;
  }) {
    drawerTitle = params.title;
    drawerSubtitle = params.subtitle ?? '';
    drawerFilter = params.filter;
    drawerDimension = params.dimension;
    drawerBucket = params.bucket;
    drawerPage = 1;
    drawerOpen = true;
    await loadDrawerGuilds();
  }

  async function loadDrawerGuilds() {
    drawerLoading = true;
    try {
      const res = await fetchAdminAnalyticsGuilds({
        page: drawerPage,
        limit: 20,
        filter: drawerFilter,
        dimension: drawerDimension,
        bucket: drawerBucket,
      });
      drawerGuilds = res.guilds;
      drawerTotalPages = res.pagination.totalPages;
      drawerTotalCount = res.pagination.total;
    } catch (err) {
      toast.error('Erreur lors du chargement des serveurs');
    } finally {
      drawerLoading = false;
    }
  }

  function changeDrawerPage(nextPage: number) {
    if (nextPage < 1 || nextPage > drawerTotalPages) return;
    drawerPage = nextPage;
    void loadDrawerGuilds();
  }

  // ── Sauvegarde des alertes ─────────────────────────────────────────────────
  let savingAlerts = $state(false);
  async function handleSaveAlerts() {
    if (!alertThresholds) return;
    savingAlerts = true;
    try {
      await saveAdminAlertThresholds(alertThresholds);
      toast.success('Seuils d’alerte enregistrés');
    } catch (err) {
      toast.error('Erreur lors de l’enregistrement');
    } finally {
      savingAlerts = false;
    }
  }

  // ── Export CSV ─────────────────────────────────────────────────────────────
  let exportingCsv = $state(false);
  async function handleExportCsv() {
    exportingCsv = true;
    const { from, to } = getQueryDates();
    try {
      await downloadAdminAnalyticsCsv(activeTab, {
        from,
        to,
        dimension: selectedDimension,
        filter: drawerFilter,
      });
      toast.success('Export CSV téléchargé');
    } catch (err) {
      toast.error("Échec de l'export CSV");
    } finally {
      exportingCsv = false;
    }
  }

  // ── Formateurs ─────────────────────────────────────────────────────────────
  function formatEuros(cents: number | null | undefined): string {
    if (cents === null || cents === undefined) return '0,00 €';
    return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
  }

  function formatPercent(val: number | null | undefined): string {
    if (val === null || val === undefined) return '0.0 %';
    return `${val.toFixed(1)} %`;
  }

  function formatDuration(seconds: number | null | undefined): string {
    if (seconds === null || seconds === undefined) return '-';
    if (seconds < 60) return `${seconds} s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m < 60) return `${m} min ${s > 0 ? `${s} s` : ''}`.trim();
    const h = Math.floor(m / 60);
    return `${h} h ${m % 60} min`;
  }

  function getRetentionBg(rate: number): string {
    if (rate >= 85) return 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30';
    if (rate >= 70) return 'bg-teal-500/20 text-teal-400 border-teal-500/30';
    if (rate >= 50) return 'bg-amber-500/20 text-amber-400 border-amber-500/30';
    if (rate >= 30) return 'bg-orange-500/20 text-orange-400 border-orange-500/30';
    return 'bg-rose-500/20 text-rose-400 border-rose-500/30';
  }
</script>

<AdminShell
  title="Acquisition & Revenus"
  description="Tunnel d'acquisition, chiffre d'affaires, cohortes de rétention et signaux faibles"
>
  {#snippet actions()}
    <div class="flex items-center gap-2 flex-wrap">
      <!-- Sélecteur de période -->
      <div class="flex items-center rounded-xl bg-surface-container-high p-1 border border-outline-variant/30 text-xs font-semibold">
        <button
          type="button"
          class="px-2.5 py-1 rounded-lg transition {periodPreset === '7d' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:text-on-surface'}"
          onclick={() => { periodPreset = '7d'; }}
        >
          7j (Direct)
        </button>
        <button
          type="button"
          class="px-2.5 py-1 rounded-lg transition {periodPreset === '30d' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:text-on-surface'}"
          onclick={() => { periodPreset = '30d'; }}
        >
          30j
        </button>
        <button
          type="button"
          class="px-2.5 py-1 rounded-lg transition {periodPreset === '90d' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:text-on-surface'}"
          onclick={() => { periodPreset = '90d'; }}
        >
          90j
        </button>
        <button
          type="button"
          class="px-2.5 py-1 rounded-lg transition {periodPreset === '12m' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:text-on-surface'}"
          onclick={() => { periodPreset = '12m'; }}
        >
          1 an
        </button>
      </div>

      <!-- Comparaison période précédente -->
      {#if activeTab === 'funnel' || activeTab === 'revenue'}
        <button
          type="button"
          class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold transition
            {comparePrevious ? 'bg-primary/15 text-primary border-primary/40' : 'bg-surface-container-high border-outline-variant/30 text-on-surface-variant hover:text-on-surface'}"
          onclick={() => { comparePrevious = !comparePrevious; }}
        >
          <Papicon icon="GitCompare" size={13} />
          Comparer
        </button>
      {/if}

      <!-- Export CSV -->
      <button
        type="button"
        disabled={exportingCsv}
        class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-surface-container-high border border-outline-variant/30 text-xs font-semibold text-on-surface hover:bg-surface-container-highest transition disabled:opacity-50"
        onclick={handleExportCsv}
      >
        <Papicon icon="Download" size={13} />
        {exportingCsv ? 'Export...' : 'Export CSV'}
      </button>

      <!-- Rafraîchir -->
      <button
        type="button"
        disabled={loading}
        class="w-8 h-8 flex items-center justify-center rounded-xl bg-surface-container-high border border-outline-variant/30 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-highest transition"
        onclick={loadAll}
        aria-label="Rafraîchir"
      >
        <Papicon icon="RefreshCw" size={13} class={loading ? 'animate-spin' : ''} />
      </button>
    </div>
  {/snippet}

  <!-- Bandeau d'onglets principaux -->
  <div class="flex border-b border-outline-variant/20 mb-6 gap-1 overflow-x-auto pb-1">
    <button
      type="button"
      class="flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm transition shrink-0
        {activeTab === 'funnel' ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high'}"
      onclick={() => { activeTab = 'funnel'; }}
    >
      <Papicon icon="Filter" size={15} />
      Tunnel d'acquisition
    </button>
    <button
      type="button"
      class="flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm transition shrink-0
        {activeTab === 'revenue' ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high'}"
      onclick={() => { activeTab = 'revenue'; }}
    >
      <Papicon icon="CreditCard" size={15} />
      Chiffre d'affaires & MRR
    </button>
    <button
      type="button"
      class="flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm transition shrink-0
        {activeTab === 'segments' ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high'}"
      onclick={() => { activeTab = 'segments'; }}
    >
      <Papicon icon="PieChart" size={15} />
      Segments & Paliers
    </button>
    <button
      type="button"
      class="flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm transition shrink-0
        {activeTab === 'retention' ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high'}"
      onclick={() => { activeTab = 'retention'; }}
    >
      <Papicon icon="Activity" size={15} />
      Rétention, Produit & Risques
    </button>
    <button
      type="button"
      class="flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm transition shrink-0
        {activeTab === 'alerts' ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high'}"
      onclick={() => { activeTab = 'alerts'; }}
    >
      <Papicon icon="Bell" size={15} />
      Seuils d'alerte
    </button>
  </div>

  {#if error}
    <div class="mb-6 p-4 rounded-2xl bg-danger/10 border border-danger/25 text-danger flex items-center gap-3">
      <Papicon icon="AlertTriangle" size={18} />
      <span class="text-sm font-semibold">{error}</span>
    </div>
  {/if}

  {#if loading && !funnelData && !revenueData && !segmentsData}
    <div class="py-24 text-center text-on-surface-variant">
      <Papicon icon="RefreshCw" size={28} class="animate-spin mx-auto mb-3 text-primary" />
      <p class="text-sm font-medium">Chargement des indicateurs...</p>
    </div>
  {:else}

    <!-- ═══════════════════════════════════════════════════════════════════════ -->
    <!-- ONGLET 1 : TUNNEL D'ACQUISITION                                         -->
    <!-- ═══════════════════════════════════════════════════════════════════════ -->
    {#if activeTab === 'funnel' && funnelData}
      {@const steps = funnelData.steps ?? []}
      {@const firstStep = steps[0]}
      {@const botJoinedStep = steps.find(s => s.step === 'bot_joined')}
      {@const paidStep = steps.find(s => s.step === 'first_payment')}

      <!-- 4 Stats clés -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <AdminStat
          label="Visites uniques"
          value={firstStep?.count ?? 0}
          icon="Eye"
          tone="primary"
          hint="Événements site_visit"
        />
        <AdminStat
          label="Installations Bot"
          value={botJoinedStep?.count ?? 0}
          icon="Bot"
          tone="info"
          hint={`${formatPercent(botJoinedStep?.conversionFromFirst ?? botJoinedStep?.conversionTop)} des visites`}
        />
        <AdminStat
          label="Parcours Onboarding"
          value={`${onboardingData?.totalCompleted ?? 0} finis`}
          icon="CheckCircle"
          tone="success"
          hint={`${formatPercent(onboardingData?.completionRate)} taux de succès`}
        />
        <AdminStat
          label="Clients Payants"
          value={paidStep?.count ?? 0}
          icon="CreditCard"
          tone="warning"
          hint={`${formatPercent(paidStep?.conversionFromFirst ?? paidStep?.conversionTop)} conversion globale`}
        />
      </div>

      <!-- Tunnel visuel étape par étape -->
      <AdminCard title="Étapes principales du tunnel" description="Taux de conversion d'une étape à l'autre et délais médians" class="mb-6">
        <div class="space-y-3 py-2">
          {#each steps as step, idx}
            {@const maxCount = firstStep?.count || 1}
            {@const barWidth = Math.max(4, Math.round((step.count / maxCount) * 100))}
            <div class="p-3.5 rounded-2xl bg-surface-container-low border border-outline-variant/15 hover:border-primary/40 transition">
              <div class="flex items-center justify-between gap-4 mb-2">
                <div class="flex items-center gap-3 min-w-0">
                  <span class="w-6 h-6 rounded-lg bg-surface-container-highest text-on-surface-variant font-mono text-xs flex items-center justify-center font-bold">
                    {idx + 1}
                  </span>
                  <div class="min-w-0">
                    <span class="text-sm font-bold text-on-surface truncate block">{step.name ?? step.label ?? step.step}</span>
                    <span class="text-[11px] font-mono text-on-surface-variant">{step.step}</span>
                  </div>
                </div>

                <div class="flex items-center gap-4 text-right shrink-0">
                  <div>
                    <span class="text-base font-black text-on-surface">{step.count.toLocaleString('fr-FR')}</span>
                    <span class="text-xs text-on-surface-variant block">{formatPercent(step.conversionFromFirst ?? step.conversionTop)} du total</span>
                  </div>
                  {#if idx > 0}
                    <div class="w-20 text-right">
                      <span class="text-xs font-bold {(step.conversionFromPrev ?? step.conversionPrevious ?? 0) >= 50 ? 'text-emerald-400' : 'text-amber-400'}">
                        {formatPercent(step.conversionFromPrev ?? step.conversionPrevious)}
                      </span>
                      <span class="text-[10px] text-on-surface-variant block">étape préc.</span>
                    </div>
                  {/if}
                  {#if step.medianDurationSeconds !== null}
                    <div class="hidden sm:block text-right w-24">
                      <span class="text-xs font-mono text-on-surface-variant">{formatDuration(step.medianDurationSeconds)}</span>
                      <span class="text-[10px] text-on-surface-variant/80 block">délai médian</span>
                    </div>
                  {/if}
                </div>
              </div>

              <!-- Jauge de progression -->
              <div class="w-full h-2 rounded-full bg-surface-container-highest overflow-hidden">
                <div
                  class="h-full rounded-full transition-all duration-500 {idx === steps.length - 1 ? 'bg-amber-400' : 'bg-primary'}"
                  style="width: {barWidth}%"
                ></div>
              </div>
            </div>
          {/each}
        </div>
      </AdminCard>

      <!-- Répartition Sources & Contenus -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        <!-- Sources -->
        <AdminCard title="Provenance du trafic" description="Classification CNIL : Discord, Moteurs de recherche, Direct">
          <div class="divide-y divide-outline-variant/15 text-sm">
            <div class="grid grid-cols-4 py-2 font-bold text-xs text-on-surface-variant uppercase tracking-wider">
              <span>Source</span>
              <span class="text-right">Visites</span>
              <span class="text-right">Bots</span>
              <span class="text-right">Clients</span>
            </div>
            {#each Object.entries(funnelData.sources ?? {}) as [src, val]}
              <div class="grid grid-cols-4 py-2.5 items-center">
                <span class="font-semibold text-on-surface capitalize">{src}</span>
                <span class="text-right font-mono text-on-surface-variant">{val.visits}</span>
                <span class="text-right font-mono text-on-surface-variant">{val.joins}</span>
                <span class="text-right font-mono font-bold text-amber-400">{val.paid}</span>
              </div>
            {/each}
          </div>
        </AdminCard>

        <!-- Contenus de liens -->
        <AdminCard title="Emplacements des boutons" description="Performance par bouton d'invitation (hero, navbar, pricing...)">
          <div class="divide-y divide-outline-variant/15 text-sm">
            <div class="grid grid-cols-4 py-2 font-bold text-xs text-on-surface-variant uppercase tracking-wider">
              <span>Bouton (content)</span>
              <span class="text-right">Clics</span>
              <span class="text-right">Bots</span>
              <span class="text-right">Clients</span>
            </div>
            {#each Object.entries(funnelData.contents ?? {}) as [cnt, val]}
              <div class="grid grid-cols-4 py-2.5 items-center">
                <span class="font-mono text-xs text-on-surface truncate">{cnt}</span>
                <span class="text-right font-mono text-on-surface-variant">{val.clicks}</span>
                <span class="text-right font-mono text-on-surface-variant">{val.joins}</span>
                <span class="text-right font-mono font-bold text-amber-400">{val.paid}</span>
              </div>
            {/each}
          </div>
        </AdminCard>
      </div>

      <!-- Zoom Onboarding -->
      {#if onboardingData}
        <AdminCard title="Parcours d'onboarding" description="Déperdition entre les étapes de configuration" class="mb-6">
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div class="p-3 rounded-xl bg-surface-container-high">
              <span class="text-xs text-on-surface-variant">Démarrés</span>
              <p class="text-xl font-black text-on-surface">{onboardingData.totalStarted}</p>
            </div>
            <div class="p-3 rounded-xl bg-surface-container-high">
              <span class="text-xs text-on-surface-variant">Complétés</span>
              <p class="text-xl font-black text-emerald-400">{onboardingData.totalCompleted}</p>
            </div>
            <div class="p-3 rounded-xl bg-surface-container-high">
              <span class="text-xs text-on-surface-variant">Durée médiane</span>
              <p class="text-xl font-black text-on-surface">{formatDuration(onboardingData.medianDurationSeconds)}</p>
            </div>
          </div>

          <div class="space-y-2">
            <span class="text-xs font-bold text-on-surface-variant uppercase tracking-wider block mb-2">Points d'abandon :</span>
            {#each (onboardingData.stepDropOffs ?? []) as drop}
              <div class="flex items-center justify-between p-2.5 rounded-xl bg-surface-container-low border border-outline-variant/15 text-sm">
                <span class="font-mono text-xs text-on-surface">{drop.step}</span>
                <div class="flex items-center gap-3">
                  <span class="font-mono text-xs text-on-surface-variant">{drop.count} abandons</span>
                  <span class="px-2 py-0.5 rounded text-xs font-bold {drop.dropOffRate > 20 ? 'bg-rose-500/20 text-rose-400' : 'bg-surface-container-highest text-on-surface-variant'}">
                    {formatPercent(drop.dropOffRate)}
                  </span>
                </div>
              </div>
            {/each}
          </div>
        </AdminCard>
      {/if}
    {/if}

    <!-- ═══════════════════════════════════════════════════════════════════════ -->
    <!-- ONGLET 2 : REVENUS & MRR                                                -->
    <!-- ═══════════════════════════════════════════════════════════════════════ -->
    {#if activeTab === 'revenue' && revenueData}
      <!-- 4 Stats clés -->
      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <AdminStat
          label="MRR Récurrent"
          value={formatEuros(revenueData.mrrCents)}
          icon="TrendingUp"
          tone="primary"
          hint={`ARR : ${formatEuros(revenueData.arrCents)}`}
        />
        <AdminStat
          label="ARPA (Revenu / Serveur)"
          value={formatEuros(revenueData.arpaCents)}
          icon="DollarSign"
          tone="info"
          hint={`${revenueData.payingGuilds} serveurs payants`}
        />
        <AdminStat
          label="Encaissé réel période"
          value={formatEuros(revenueData.collectedCents)}
          icon="CreditCard"
          tone="success"
          hint="Total factures payées"
        />
        <AdminStat
          label="Chiffre d'Affaires Net"
          value={formatEuros(revenueData.waterfall.mrrEndCents - revenueData.waterfall.mrrStartCents)}
          icon="Activity"
          tone={revenueData.waterfall.mrrEndCents >= revenueData.waterfall.mrrStartCents ? 'success' : 'danger'}
          hint="Delta sur la période"
        />
      </div>

      <!-- Cascade de MRR (Pont de variation) -->
      <AdminCard title="Cascade de MRR (Waterfall)" description="Évolution du MRR : Nouveaux, Expansions, Contractions et Churn" class="mb-6">
        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 py-2">
          <div class="p-3 rounded-2xl bg-surface-container-high border border-outline-variant/20 text-center">
            <span class="text-xs font-semibold text-on-surface-variant block mb-1">MRR Début</span>
            <span class="text-base font-black text-on-surface">{formatEuros(revenueData.waterfall.mrrStartCents)}</span>
          </div>
          <div class="p-3 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 text-center">
            <span class="text-xs font-semibold text-emerald-400 block mb-1">+ Nouveau</span>
            <span class="text-base font-black text-emerald-400">+{formatEuros(revenueData.waterfall.newCents)}</span>
          </div>
          <div class="p-3 rounded-2xl bg-teal-500/10 border border-teal-500/30 text-center">
            <span class="text-xs font-semibold text-teal-400 block mb-1">+ Expansion</span>
            <span class="text-base font-black text-teal-400">+{formatEuros(revenueData.waterfall.expansionCents)}</span>
          </div>
          <div class="p-3 rounded-2xl bg-orange-500/10 border border-orange-500/30 text-center">
            <span class="text-xs font-semibold text-orange-400 block mb-1">- Contraction</span>
            <span class="text-base font-black text-orange-400">-{formatEuros(revenueData.waterfall.contractionCents)}</span>
          </div>
          <div class="p-3 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-center">
            <span class="text-xs font-semibold text-rose-400 block mb-1">- Churn</span>
            <span class="text-base font-black text-rose-400">-{formatEuros(revenueData.waterfall.churnCents)}</span>
          </div>
          <div class="p-3 rounded-2xl bg-primary/15 border border-primary/40 text-center">
            <span class="text-xs font-semibold text-primary block mb-1">MRR Fin</span>
            <span class="text-base font-black text-primary">{formatEuros(revenueData.waterfall.mrrEndCents)}</span>
          </div>
        </div>
      </AdminCard>

      <!-- Répartitions Offres & Intervalles -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
        <!-- Par Offre -->
        <AdminCard title="Répartition par Offre" description="PLUS, PRO, ULTIMATE et CUSTOM">
          <div class="space-y-3 py-2">
            {#each Object.entries(revenueData.byPlan ?? {}) as [plan, item]}
              {@const totalMrr = revenueData.mrrCents || 1}
              {@const pct = Math.round((item.mrrCents / totalMrr) * 100)}
              <div class="p-3 rounded-xl bg-surface-container-low border border-outline-variant/15">
                <div class="flex items-center justify-between text-sm mb-1.5">
                  <span class="font-bold text-on-surface">{plan}</span>
                  <div class="flex items-center gap-3">
                    <span class="text-xs text-on-surface-variant font-mono">{item.count} serveurs</span>
                    <span class="font-black text-on-surface">{formatEuros(item.mrrCents)}</span>
                  </div>
                </div>
                <div class="w-full h-1.5 rounded-full bg-surface-container-highest overflow-hidden">
                  <div class="h-full rounded-full bg-primary" style="width: {pct}%"></div>
                </div>
              </div>
            {/each}
          </div>
        </AdminCard>

        <!-- Par Périodicité -->
        <AdminCard title="Répartition Mensuel vs Annuel" description="Souscriptions au mois vs engagement annuel">
          <div class="grid grid-cols-2 gap-4 py-2">
            <div class="p-4 rounded-2xl bg-surface-container-low border border-outline-variant/15 text-center">
              <span class="text-xs font-semibold text-on-surface-variant block mb-1">Mensuel</span>
              <p class="text-xl font-black text-on-surface">{revenueData.byInterval.month.count}</p>
              <span class="text-xs text-primary font-mono font-bold block mt-1">
                {formatEuros(revenueData.byInterval.month.mrrCents)} / m
              </span>
            </div>
            <div class="p-4 rounded-2xl bg-surface-container-low border border-outline-variant/15 text-center">
              <span class="text-xs font-semibold text-on-surface-variant block mb-1">Annuel (-17%)</span>
              <p class="text-xl font-black text-emerald-400">{revenueData.byInterval.year.count}</p>
              <span class="text-xs text-emerald-400 font-mono font-bold block mt-1">
                {formatEuros(revenueData.byInterval.year.mrrCents)} / m
              </span>
            </div>
          </div>
        </AdminCard>
      </div>

      <!-- Factures Récentes -->
      <AdminCard title="Dernières factures réelles" description="Extraites des événements Stripe et enregistrées dans BillingInvoice">
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead>
              <tr class="border-b border-outline-variant/20 text-xs font-bold text-on-surface-variant uppercase tracking-wider">
                <th class="py-2.5 px-3">Date</th>
                <th class="py-2.5 px-3">Serveur</th>
                <th class="py-2.5 px-3">Offre</th>
                <th class="py-2.5 px-3">Intervalle</th>
                <th class="py-2.5 px-3 text-right">Montant TTC</th>
                <th class="py-2.5 px-3 text-center">Statut</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-outline-variant/15">
              {#each (revenueData.recentInvoices ?? []) as inv}
                <tr class="hover:bg-surface-container-highest/30 transition">
                  <td class="py-2.5 px-3 font-mono text-xs text-on-surface-variant">
                    {inv.paidAt ? new Date(inv.paidAt).toLocaleDateString('fr-FR') : '-'}
                  </td>
                  <td class="py-2.5 px-3 font-mono text-xs text-on-surface font-semibold">
                    {inv.guildId ?? 'Inconnu'}
                  </td>
                  <td class="py-2.5 px-3 text-xs font-bold text-on-surface">{inv.plan}</td>
                  <td class="py-2.5 px-3 text-xs text-on-surface-variant capitalize">{inv.interval ?? 'mois'}</td>
                  <td class="py-2.5 px-3 text-right font-mono font-bold text-on-surface">
                    {formatEuros(inv.amountPaidCents)}
                  </td>
                  <td class="py-2.5 px-3 text-center">
                    <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-emerald-500/20 text-emerald-400">
                      {inv.status}
                    </span>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </AdminCard>
    {/if}

    <!-- ═══════════════════════════════════════════════════════════════════════ -->
    <!-- ONGLET 3 : SEGMENTS & PALIERS                                           -->
    <!-- ═══════════════════════════════════════════════════════════════════════ -->
    {#if activeTab === 'segments' && segmentsData}
      <!-- Sélecteur de Dimension -->
      <div class="flex items-center gap-2 mb-6 flex-wrap">
        <span class="text-xs font-bold text-on-surface-variant uppercase tracking-wider mr-2">Axe d'analyse :</span>
        {#each [
          { id: 'size', label: 'Taille du serveur' },
          { id: 'source', label: 'Provenance (CNIL)' },
          { id: 'instance', label: 'Instance (White-label)' },
          { id: 'locale', label: 'Langue' },
          { id: 'kind', label: 'Type de communauté' },
        ] as dim}
          <button
            type="button"
            class="px-3 py-1.5 rounded-xl text-xs font-semibold transition
              {selectedDimension === dim.id ? 'bg-primary text-on-primary' : 'bg-surface-container-high border border-outline-variant/30 text-on-surface-variant hover:text-on-surface'}"
            onclick={() => { selectedDimension = dim.id as AnalyticsDimension; }}
          >
            {dim.label}
          </button>
        {/each}
      </div>

      <!-- Table de Distribution -->
      <AdminCard title="Distribution des serveurs et conversion" description="Cliquez sur une ligne pour voir les serveurs correspondants" class="mb-6">
        <div class="overflow-x-auto">
          <table class="w-full text-left text-sm">
            <thead>
              <tr class="border-b border-outline-variant/20 text-xs font-bold text-on-surface-variant uppercase tracking-wider">
                <th class="py-2.5 px-3">Segment</th>
                <th class="py-2.5 px-3 text-right">Serveurs</th>
                <th class="py-2.5 px-3 text-right">Payants</th>
                <th class="py-2.5 px-3 text-right">Essais</th>
                <th class="py-2.5 px-3 text-right">Conversion</th>
                <th class="py-2.5 px-3 text-right">MRR Total</th>
                <th class="py-2.5 px-3 text-right">LTV Moyenne</th>
                <th class="py-2.5 px-3 text-center">Action</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-outline-variant/15">
              {#each (segmentsData.distribution ?? []) as row}
                <tr class="hover:bg-surface-container-highest/30 transition">
                  <td class="py-3 px-3 font-semibold text-on-surface">{row.bucket || '(Non renseigné)'}</td>
                  <td class="py-3 px-3 text-right font-mono text-on-surface-variant">{row.totalGuilds}</td>
                  <td class="py-3 px-3 text-right font-mono font-bold text-emerald-400">{row.payingGuilds}</td>
                  <td class="py-3 px-3 text-right font-mono text-amber-400">{row.trialGuilds}</td>
                  <td class="py-3 px-3 text-right font-mono font-bold text-on-surface">{formatPercent(row.conversionRate)}</td>
                  <td class="py-3 px-3 text-right font-mono font-bold text-primary">{formatEuros(row.mrrCents)}</td>
                  <td class="py-3 px-3 text-right font-mono text-on-surface-variant">{formatEuros(row.avgLtvCents)}</td>
                  <td class="py-3 px-3 text-center">
                    <button
                      type="button"
                      class="px-2.5 py-1 rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-xs font-semibold text-primary transition"
                      onclick={() => openDrawer({
                        title: `Serveurs du segment ${row.bucket}`,
                        dimension: selectedDimension,
                        bucket: row.bucket,
                      })}
                    >
                      Voir
                    </button>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </AdminCard>

      <!-- Matrice Serveurs Hors Palier -->
      <AdminCard
        title="Serveurs hors palier (Opportunités d'Up-sell)"
        description="Serveurs dont le nombre de membres dépasse la limite de leur offre souscrite"
      >
        {#if (segmentsData.outOfTierMatrix ?? []).length === 0}
          <div class="py-8 text-center text-on-surface-variant">
            <Papicon icon="CheckCircle" size={24} class="mx-auto mb-2 text-emerald-400" />
            <p class="text-sm font-semibold">Tous les serveurs sont actuellement sur une offre adaptée à leur taille.</p>
          </div>
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-left text-sm">
              <thead>
                <tr class="border-b border-outline-variant/20 text-xs font-bold text-on-surface-variant uppercase tracking-wider">
                  <th class="py-2.5 px-3">Serveur</th>
                  <th class="py-2.5 px-3 text-right">Membres</th>
                  <th class="py-2.5 px-3">Offre actuelle</th>
                  <th class="py-2.5 px-3">Offre recommandée</th>
                  <th class="py-2.5 px-3 text-right">MRR actuel</th>
                  <th class="py-2.5 px-3 text-center">Action</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-outline-variant/15">
                {#each (segmentsData.outOfTierMatrix ?? []) as oot}
                  <tr class="hover:bg-surface-container-highest/30 transition">
                    <td class="py-3 px-3 font-semibold text-on-surface">{oot.guildName}</td>
                    <td class="py-3 px-3 text-right font-mono font-bold text-amber-400">
                      {oot.memberCount.toLocaleString('fr-FR')}
                    </td>
                    <td class="py-3 px-3">
                      <span class="px-2 py-0.5 rounded text-xs font-bold bg-surface-container-highest text-on-surface-variant">
                        {oot.currentPlan}
                      </span>
                    </td>
                    <td class="py-3 px-3">
                      <span class="px-2 py-0.5 rounded text-xs font-bold bg-primary/20 text-primary">
                        {oot.recommendedPlan}
                      </span>
                    </td>
                    <td class="py-3 px-3 text-right font-mono font-bold text-on-surface">{formatEuros(oot.mrrCents)}</td>
                    <td class="py-3 px-3 text-center">
                      <button
                        type="button"
                        class="px-2.5 py-1 rounded-lg bg-primary text-on-primary text-xs font-semibold hover:bg-primary/90 transition"
                        onclick={() => openDrawer({
                          title: oot.guildName,
                          subtitle: `ID: ${oot.guildId} · ${oot.memberCount} membres`,
                          filter: 'out_of_tier',
                        })}
                      >
                        Inspecter
                      </button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </AdminCard>
    {/if}

    <!-- ═══════════════════════════════════════════════════════════════════════ -->
    <!-- ONGLET 4 : RÉTENTION, PRODUIT & RISQUES                                 -->
    <!-- ═══════════════════════════════════════════════════════════════════════ -->
    {#if activeTab === 'retention'}
      <!-- Signaux faibles / Risques -->
      {#if risksData}
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <AdminStat
            label="Inactifs > 14 jours"
            value={risksData.summary.inactivePayingCount}
            icon="AlertCircle"
            tone="danger"
            hint="Serveurs payants sans activité bot"
          />
          <AdminStat
            label="Usage en chute > 50%"
            value={risksData.summary.decliningUsageCount}
            icon="TrendingDown"
            tone="warning"
            hint="Baisse d'usage semaine / semaine"
          />
          <AdminStat
            label="Fin d'essai sous 48h"
            value={risksData.summary.expiringTrials48hCount}
            icon="Clock"
            tone="info"
            hint="À convertir en premier paiement"
          />
          <AdminStat
            label="MRR à Risque"
            value={formatEuros(risksData.summary.atRiskMrrCents)}
            icon="AlertTriangle"
            tone="danger"
            hint="Total MRR des signaux faibles"
          />
        </div>
      {/if}

      <!-- Matrice de Cohortes M0 à M12 -->
      <AdminCard title="Matrice de rétention par cohorte (M0 à M12)" description="Taux de rétention des serveurs payants par mois d'acquisition" class="mb-6">
        {#if cohortsData.length === 0}
          <p class="py-8 text-center text-sm text-on-surface-variant">Pas encore assez d'historique de cohortes disponible.</p>
        {:else}
          <div class="overflow-x-auto">
            <table class="w-full text-center text-xs border-collapse">
              <thead>
                <tr class="border-b border-outline-variant/20 text-on-surface-variant font-bold">
                  <th class="py-2.5 px-3 text-left">Cohorte</th>
                  <th class="py-2.5 px-2">Serveurs</th>
                  {#each Array.from({ length: 13 }) as _, i}
                    <th class="py-2.5 px-2">M{i}</th>
                  {/each}
                </tr>
              </thead>
              <tbody class="divide-y divide-outline-variant/10">
                {#each (cohortsData ?? []) as cohort}
                  <tr>
                    <td class="py-2 px-3 text-left font-mono font-bold text-on-surface">{cohort.cohortMonth}</td>
                    <td class="py-2 px-2 font-mono text-on-surface-variant">{cohort.initialGuilds}</td>
                    {#each Array.from({ length: 13 }) as _, offset}
                      {@const p = cohort.periods?.find((x) => x.periodIndex === offset) ?? cohort.periods?.[offset]}
                      <td class="py-1 px-1">
                        {#if p && ((p.retentionRate !== null && p.retentionRate !== undefined) || (p.retainedPct !== null && p.retainedPct !== undefined))}
                          {@const rate = p.retentionRate ?? p.retainedPct ?? 0}
                          <div class="py-1.5 rounded-lg border font-mono font-bold {getRetentionBg(rate)}">
                            {Math.round(rate)}%
                          </div>
                        {:else}
                          <span class="text-on-surface-variant/30">-</span>
                        {/if}
                      </td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </AdminCard>

      <!-- Modules : Adoption & Drop-off -->
      {#if modulesData}
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
          <AdminCard title="Adoption des modules (FREE vs Payant)" description="Comparaison des fonctionnalités activées selon l'offre">
            <div class="divide-y divide-outline-variant/15 text-sm">
              <div class="grid grid-cols-3 py-2 font-bold text-xs text-on-surface-variant uppercase tracking-wider">
                <span>Module</span>
                <span class="text-right">Offre FREE</span>
                <span class="text-right">Offres Payantes</span>
              </div>
              {#each (modulesData.moduleAdoption ?? []).slice(0, 8) as mod}
                <div class="grid grid-cols-3 py-2.5 items-center">
                  <span class="font-semibold text-on-surface">{mod.module}</span>
                  <span class="text-right font-mono text-on-surface-variant">{formatPercent(mod.freeAdoptionRate)}</span>
                  <span class="text-right font-mono font-bold text-emerald-400">{formatPercent(mod.paidAdoptionRate)}</span>
                </div>
              {/each}
            </div>
          </AdminCard>

          <AdminCard title="Modules drop-off avant Churn" description="Dernières fonctionnalités désactivées avant la résiliation">
            <div class="divide-y divide-outline-variant/15 text-sm">
              <div class="grid grid-cols-2 py-2 font-bold text-xs text-on-surface-variant uppercase tracking-wider">
                <span>Module</span>
                <span class="text-right">Arrêts avant Churn</span>
              </div>
              {#each (modulesData.churnDropOffModules ?? []) as cdo}
                <div class="grid grid-cols-2 py-2.5 items-center">
                  <span class="font-semibold text-on-surface">{cdo.module}</span>
                  <span class="text-right font-mono font-bold text-rose-400">{cdo.dropOffCount}</span>
                </div>
              {/each}
            </div>
          </AdminCard>
        </div>
      {/if}
    {/if}

    <!-- ═══════════════════════════════════════════════════════════════════════ -->
    <!-- ONGLET 5 : SEUILS D'ALERTE                                              -->
    <!-- ═══════════════════════════════════════════════════════════════════════ -->
    {#if activeTab === 'alerts'}
      <div class="max-w-2xl space-y-6">
        <AdminCard title="Seuils de déclenchement des alertes Discord" description="Alertes transmises sur le salon Discord de supervision admin">
          {#if alertThresholds}
            <div class="space-y-4 py-2">
              <div>
                <label for="th-churn" class="block text-xs font-bold text-on-surface mb-1">
                  Seuil de saut de Churn hebdomadaire (%)
                </label>
                <input
                  id="th-churn"
                  type="number"
                  step="0.5"
                  bind:value={alertThresholds.churnRateWeeklyPercent}
                  class="w-full px-3.5 py-2 rounded-xl bg-surface-container-high border border-outline-variant/30 text-on-surface text-sm focus:outline-none focus:border-primary"
                />
                <span class="text-[11px] text-on-surface-variant">Alerte si le churn rate hebdomadaire dépasse ce seuil (défaut : 5%)</span>
              </div>

              <div>
                <label for="th-trial" class="block text-xs font-bold text-on-surface mb-1">
                  Chute de conversion d'essai (%)
                </label>
                <input
                  id="th-trial"
                  type="number"
                  step="1"
                  bind:value={alertThresholds.trialConversionDropPercent}
                  class="w-full px-3.5 py-2 rounded-xl bg-surface-container-high border border-outline-variant/30 text-on-surface text-sm focus:outline-none focus:border-primary"
                />
                <span class="text-[11px] text-on-surface-variant">Alerte si la conversion de fin d'essai chute de plus de X% (défaut : 20%)</span>
              </div>

              <div>
                <label for="th-onboard" class="block text-xs font-bold text-on-surface mb-1">
                  Taux minimal de complétion de configuration (%)
                </label>
                <input
                  id="th-onboard"
                  type="number"
                  step="1"
                  bind:value={alertThresholds.onboardingCompletionMinPercent}
                  class="w-full px-3.5 py-2 rounded-xl bg-surface-container-high border border-outline-variant/30 text-on-surface text-sm focus:outline-none focus:border-primary"
                />
                <span class="text-[11px] text-on-surface-variant">Alerte si la complétion du wizard passe sous ce seuil (défaut : 40%)</span>
              </div>

              <div>
                <label for="th-oot" class="block text-xs font-bold text-on-surface mb-1">
                  Nombre maximal de serveurs hors palier tolérés
                </label>
                <input
                  id="th-oot"
                  type="number"
                  step="1"
                  bind:value={alertThresholds.outOfTierMaxCount}
                  class="w-full px-3.5 py-2 rounded-xl bg-surface-container-high border border-outline-variant/30 text-on-surface text-sm focus:outline-none focus:border-primary"
                />
                <span class="text-[11px] text-on-surface-variant">Alerte si le nombre de serveurs dépassant leur palier atteint ce niveau (défaut : 10)</span>
              </div>

              <div class="pt-3">
                <button
                  type="button"
                  disabled={savingAlerts}
                  class="px-5 py-2.5 rounded-xl bg-primary text-on-primary font-bold text-sm hover:bg-primary/90 transition disabled:opacity-50"
                  onclick={handleSaveAlerts}
                >
                  {savingAlerts ? 'Enregistrement...' : 'Enregistrer les seuils'}
                </button>
              </div>
            </div>
          {/if}
        </AdminCard>

        <!-- Historique des alertes récentes -->
        <AdminCard title="Dernières alertes émises" description="Historique des alertes envoyées par le cron de surveillance">
          {#if (recentAlerts ?? []).length === 0}
            <p class="py-4 text-center text-sm text-on-surface-variant">Aucune alerte récente enregistrée.</p>
          {:else}
            <div class="divide-y divide-outline-variant/15 text-sm">
              {#each (recentAlerts ?? []) as al}
                <div class="py-2.5 flex items-center justify-between">
                  <div>
                    <span class="font-bold text-on-surface">{al.key}</span>
                    <span class="text-xs text-on-surface-variant block">
                      Valeur mesurée : {al.lastValue ?? 'N/A'}
                    </span>
                  </div>
                  <span class="font-mono text-xs text-on-surface-variant">
                    {new Date(al.lastFiredAt).toLocaleString('fr-FR')}
                  </span>
                </div>
              {/each}
            </div>
          {/if}
        </AdminCard>
      </div>
    {/if}
  {/if}

  <!-- ═════════════════════════════════════════════════════════════════════════ -->
  <!-- DRAWER D'INSPECTION DÉTAILLÉE (DRILLDOWN)                                 -->
  <!-- ═════════════════════════════════════════════════════════════════════════ -->
  <AdminDrawer
    bind:open={drawerOpen}
    title={drawerTitle}
    subtitle={drawerSubtitle}
    width="lg"
  >
    {#if drawerLoading}
      <div class="py-16 text-center text-on-surface-variant">
        <Papicon icon="RefreshCw" size={24} class="animate-spin mx-auto mb-2 text-primary" />
        <p class="text-sm font-medium">Chargement de la liste des serveurs...</p>
      </div>
    {:else if drawerGuilds.length === 0}
      <div class="py-16 text-center text-on-surface-variant">
        <Papicon icon="Server" size={24} class="mx-auto mb-2 text-on-surface-variant/50" />
        <p class="text-sm font-medium">Aucun serveur dans cette sélection.</p>
      </div>
    {:else}
      <div class="space-y-3">
        <p class="text-xs font-semibold text-on-surface-variant mb-2">
          {drawerTotalCount} serveur(s) trouvé(s) (page {drawerPage} / {drawerTotalPages})
        </p>
        {#each drawerGuilds as g}
          <div class="p-3.5 rounded-2xl bg-surface-container-high border border-outline-variant/20 hover:border-primary/40 transition">
            <div class="flex items-start justify-between gap-3 mb-2">
              <div class="flex items-center gap-3">
                {#if g.icon}
                  <img src={g.icon} alt="" class="w-9 h-9 rounded-xl object-cover bg-surface-container-highest" />
                {:else}
                  <div class="w-9 h-9 rounded-xl bg-surface-container-highest flex items-center justify-center font-black text-xs text-on-surface-variant">
                    {(g.name || g.guildId).slice(0, 2).toUpperCase()}
                  </div>
                {/if}
                <div>
                  <h4 class="text-sm font-bold text-on-surface leading-tight">{g.name}</h4>
                  <span class="text-[11px] font-mono text-on-surface-variant">{g.guildId}</span>
                </div>
              </div>

              <div class="text-right">
                <span class="px-2 py-0.5 rounded text-xs font-bold uppercase {g.plan !== 'FREE' ? 'bg-amber-500/20 text-amber-400' : 'bg-surface-container-highest text-on-surface-variant'}">
                  {g.plan}
                </span>
                <span class="text-xs font-bold font-mono text-on-surface block mt-1">
                  {formatEuros(g.mrrCents)} / m
                </span>
              </div>
            </div>

            <div class="flex items-center gap-4 text-xs text-on-surface-variant flex-wrap pt-2 border-t border-outline-variant/15">
              <span>Membres : <strong class="text-on-surface">{g.memberCount}</strong></span>
              {#if g.source}
                <span>Source : <strong class="text-on-surface capitalize">{g.source}</strong></span>
              {/if}
              {#if g.firstPaidAt}
                <span>Client depuis : <strong class="text-on-surface">{new Date(g.firstPaidAt).toLocaleDateString('fr-FR')}</strong></span>
              {/if}
            </div>

            {#if g.riskReasons && g.riskReasons.length > 0}
              <div class="mt-2.5 pt-2 border-t border-danger/20 flex items-center gap-2 flex-wrap">
                <span class="text-[10px] font-bold uppercase text-danger">Risque :</span>
                {#each g.riskReasons as r}
                  <span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-danger/15 text-danger border border-danger/30">
                    {r}
                  </span>
                {/each}
              </div>
            {/if}
          </div>
        {/each}

        <!-- Pagination Drawer -->
        {#if drawerTotalPages > 1}
          <div class="flex items-center justify-between pt-4">
            <button
              type="button"
              disabled={drawerPage <= 1}
              class="px-3 py-1.5 rounded-xl bg-surface-container-high border border-outline-variant/30 text-xs font-semibold disabled:opacity-40"
              onclick={() => changeDrawerPage(drawerPage - 1)}
            >
              Précédent
            </button>
            <span class="text-xs text-on-surface-variant">Page {drawerPage} sur {drawerTotalPages}</span>
            <button
              type="button"
              disabled={drawerPage >= drawerTotalPages}
              class="px-3 py-1.5 rounded-xl bg-surface-container-high border border-outline-variant/30 text-xs font-semibold disabled:opacity-40"
              onclick={() => changeDrawerPage(drawerPage + 1)}
            >
              Suivant
            </button>
          </div>
        {/if}
      </div>
    {/if}
  </AdminDrawer>
</AdminShell>
