<script lang="ts">
  import { onMount } from 'svelte';
  import { toast } from '../../lib/stores/toast.svelte';
  import { fetchAdminModuleStats } from '../../lib/api';
  import Papicon from '../../lib/components/Papicon.svelte';
  import Skeleton from '../../lib/components/Skeleton.svelte';
  import AdminShell from '../../lib/components/admin/AdminShell.svelte';

  interface ModuleStats {
    topModules?: Array<{ name: string; usageCount: number; usagePercentage: number }>;
    activationRate?: Array<{ name: string; activeGuilds: number; rate: number }>;
    activationDetails?: Array<{ name: string; activeGuilds: number; rate: number; trend: 'up' | 'down' | 'stable'; change: number }>;
    usageDetails?: Array<{ name: string; totalUsage: number; avgDailyUsage: number; peakUsage: number }>;
    performanceDetails?: Array<{ name: string; avgResponseTime: number; errorRate: number; performanceScore: number }>;
  }

  let moduleStats = $state<ModuleStats | null>(null);
  let moduleStatsLoading = $state(false);
  let moduleStatsPeriod = $state(30);
  let moduleStatsView = $state<'summary' | 'activation' | 'usage' | 'performance'>('summary');

  async function loadModuleStats() {
    moduleStatsLoading = true;
    try {
      const data = await fetchAdminModuleStats({
        periodDays: moduleStatsPeriod,
        summary: moduleStatsView === 'summary',
      });
      moduleStats = data;
    } catch (err: any) {
      toast.error(err.message || 'Erreur lors du chargement des statistiques de modules');
    } finally {
      moduleStatsLoading = false;
    }
  }

  onMount(() => {
    void loadModuleStats();
  });

  $effect(() => {
    void loadModuleStats();
  });
</script>

<AdminShell title="Modules" description="Activation, usage et performance des modules Kotbo sur l’ensemble du parc.">
  <div class="space-y-6 pb-12 animate-in fade-in slide-in-from-bottom-3 duration-600">
  <!-- Controls -->
  <div class="flex flex-wrap items-center justify-between gap-4">
    <div class="flex items-center gap-4">
      <h2 class="text-xl font-semibold font-headline flex items-center gap-3 px-2">
        <Papicon icon="Box" size={24} class="text-purple-400" />
        Statistiques des Modules
      </h2>
    </div>
    <div class="flex items-center gap-4">
      <div class="flex items-center gap-2 bg-surface/50 rounded-xl px-4 py-2 border border-outline-variant/10">
        <span class="text-xs font-bold text-on-surface-variant/60">Période:</span>
        <select
          bind:value={moduleStatsPeriod}
          onchange={() => loadModuleStats()}
          class="bg-transparent text-sm font-bold text-on-surface focus:outline-none cursor-pointer"
        >
          <option value={7}>7 jours</option>
          <option value={30}>30 jours</option>
          <option value={90}>90 jours</option>
        </select>
      </div>
      <div class="flex gap-2">
        <button
          onclick={() => { moduleStatsView = 'summary'; loadModuleStats(); }}
          class="px-4 py-2 rounded-xl font-bold text-sm transition-all {moduleStatsView === 'summary' ? 'bg-primary text-on-primary' : 'bg-surface/50 text-on-surface-variant hover:bg-on-surface/10'}"
        >
          Résumé
        </button>
        <button
          onclick={() => { moduleStatsView = 'activation'; loadModuleStats(); }}
          class="px-4 py-2 rounded-xl font-bold text-sm transition-all {moduleStatsView === 'activation' ? 'bg-primary text-on-primary' : 'bg-surface/50 text-on-surface-variant hover:bg-on-surface/10'}"
        >
          Activation
        </button>
        <button
          onclick={() => { moduleStatsView = 'usage'; loadModuleStats(); }}
          class="px-4 py-2 rounded-xl font-bold text-sm transition-all {moduleStatsView === 'usage' ? 'bg-primary text-on-primary' : 'bg-surface/50 text-on-surface-variant hover:bg-on-surface/10'}"
        >
          Utilisation
        </button>
        <button
          onclick={() => { moduleStatsView = 'performance'; loadModuleStats(); }}
          class="px-4 py-2 rounded-xl font-bold text-sm transition-all {moduleStatsView === 'performance' ? 'bg-primary text-on-primary' : 'bg-surface/50 text-on-surface-variant hover:bg-on-surface/10'}"
        >
          Performance
        </button>
      </div>
    </div>
  </div>

  {#if moduleStatsLoading}
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
      <Skeleton height="120px" class="rounded-[2.25rem]" />
      <Skeleton height="120px" class="rounded-[2.25rem]" />
      <Skeleton height="120px" class="rounded-[2.25rem]" />
      <Skeleton height="120px" class="rounded-[2.25rem]" />
    </div>
  {:else if moduleStatsView === 'summary' && moduleStats}
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-8">
      <!-- Top Modules -->
      <div class="space-y-6">
        <h3 class="text-lg font-semibold text-on-surface">Modules les plus utilisés</h3>
        <div class="premium-card rounded-[2.25rem] p-8 space-y-4">
          {#each moduleStats.topModules?.slice(0, 5) || [] as module}
            <div class="flex items-center justify-between p-4 bg-surface/30 rounded-xl">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary font-bold">
                  {module.name.charAt(0)}
                </div>
                <div>
                  <p class="font-bold text-on-surface">{module.name}</p>
                  <p class="text-xs text-on-surface-variant">{module.usageCount} utilisations</p>
                </div>
              </div>
              <div class="text-right">
                <p class="text-sm font-semibold text-on-surface">{module.usagePercentage}%</p>
              </div>
            </div>
          {/each}
          {#if !moduleStats.topModules || moduleStats.topModules.length === 0}
            <p class="text-sm text-center text-on-surface-variant/50 py-4">Aucune donnée disponible</p>
          {/if}
        </div>
      </div>

      <!-- Activation Rate -->
      <div class="space-y-6">
        <h3 class="text-lg font-semibold text-on-surface">Taux d'activation</h3>
        <div class="premium-card rounded-[2.25rem] p-8 space-y-4">
          {#each moduleStats.activationRate?.slice(0, 5) || [] as module}
            <div class="flex items-center justify-between p-4 bg-surface/30 rounded-xl">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center text-emerald-500 font-bold">
                  {module.name.charAt(0)}
                </div>
                <div>
                  <p class="font-bold text-on-surface">{module.name}</p>
                  <p class="text-xs text-on-surface-variant">{module.activeGuilds} serveurs actifs</p>
                </div>
              </div>
              <div class="text-right">
                <p class="text-sm font-semibold text-emerald-400">{module.rate}%</p>
              </div>
            </div>
          {/each}
          {#if !moduleStats.activationRate || moduleStats.activationRate.length === 0}
            <p class="text-sm text-center text-on-surface-variant/50 py-4">Aucune donnée disponible</p>
          {/if}
        </div>
      </div>
    </div>
  {:else if moduleStatsView === 'activation' && moduleStats}
    <div class="premium-card rounded-[2.25rem] p-8">
      <h3 class="text-lg font-semibold text-on-surface mb-6">Détail des activations par module</h3>
      <div class="overflow-hidden rounded-lg border border-outline-variant/10">
        <table class="w-full text-sm">
          <thead class="bg-surface/40 text-left text-[10px] uppercase tracking-wider text-on-surface-variant/50">
            <tr>
              <th class="px-4 py-3">Module</th>
              <th class="px-4 py-3">Serveurs actifs</th>
              <th class="px-4 py-3">Taux d'activation</th>
              <th class="px-4 py-3">Tendance</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/10">
            {#each moduleStats.activationDetails || [] as module}
              <tr class="bg-surface/10">
                <td class="px-4 py-3 font-bold text-on-surface">{module.name}</td>
                <td class="px-4 py-3">{module.activeGuilds}</td>
                <td class="px-4 py-3 text-emerald-400 font-semibold">{module.rate}%</td>
                <td class="px-4 py-3">
                  {#if module.trend === 'up'}
                    <span class="text-emerald-400">↗ +{module.change}%</span>
                  {:else if module.trend === 'down'}
                    <span class="text-error">↘ {module.change}%</span>
                  {:else}
                    <span class="text-on-surface-variant">→ {module.change}%</span>
                  {/if}
                </td>
              </tr>
            {/each}
            {#if !moduleStats.activationDetails || moduleStats.activationDetails.length === 0}
              <tr>
                <td colspan="4" class="px-4 py-8 text-center text-sm text-on-surface-variant/50">Aucune donnée disponible</td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
    </div>
  {:else if moduleStatsView === 'usage' && moduleStats}
    <div class="premium-card rounded-[2.25rem] p-8">
      <h3 class="text-lg font-semibold text-on-surface mb-6">Statistiques d'utilisation</h3>
      <div class="overflow-hidden rounded-lg border border-outline-variant/10">
        <table class="w-full text-sm">
          <thead class="bg-surface/40 text-left text-[10px] uppercase tracking-wider text-on-surface-variant/50">
            <tr>
              <th class="px-4 py-3">Module</th>
              <th class="px-4 py-3">Utilisations totales</th>
              <th class="px-4 py-3">Utilisations/jour</th>
              <th class="px-4 py-3">Pic d'utilisation</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/10">
            {#each moduleStats.usageDetails || [] as module}
              <tr class="bg-surface/10">
                <td class="px-4 py-3 font-bold text-on-surface">{module.name}</td>
                <td class="px-4 py-3">{module.totalUsage.toLocaleString()}</td>
                <td class="px-4 py-3">{module.avgDailyUsage.toLocaleString()}</td>
                <td class="px-4 py-3">{module.peakUsage.toLocaleString()}</td>
              </tr>
            {/each}
            {#if !moduleStats.usageDetails || moduleStats.usageDetails.length === 0}
              <tr>
                <td colspan="4" class="px-4 py-8 text-center text-sm text-on-surface-variant/50">Aucune donnée disponible</td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
    </div>
  {:else if moduleStatsView === 'performance' && moduleStats}
    <div class="premium-card rounded-[2.25rem] p-8">
      <h3 class="text-lg font-semibold text-on-surface mb-6">Métriques de performance</h3>
      <div class="overflow-hidden rounded-lg border border-outline-variant/10">
        <table class="w-full text-sm">
          <thead class="bg-surface/40 text-left text-[10px] uppercase tracking-wider text-on-surface-variant/50">
            <tr>
              <th class="px-4 py-3">Module</th>
              <th class="px-4 py-3">Temps de réponse moyen</th>
              <th class="px-4 py-3">Taux d'erreur</th>
              <th class="px-4 py-3">Score de performance</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-outline-variant/10">
            {#each moduleStats.performanceDetails || [] as module}
              <tr class="bg-surface/10">
                <td class="px-4 py-3 font-bold text-on-surface">{module.name}</td>
                <td class="px-4 py-3">{module.avgResponseTime}ms</td>
                <td class="px-4 py-3 {module.errorRate > 5 ? 'text-error' : 'text-emerald-400'}">{module.errorRate}%</td>
                <td class="px-4 py-3">
                  <div class="flex items-center gap-2">
                    <div class="flex-1 h-2 bg-surface/40 rounded-full overflow-hidden">
                      <div 
                        class="h-full {module.performanceScore >= 80 ? 'bg-emerald-500' : module.performanceScore >= 50 ? 'bg-amber-500' : 'bg-error'}" 
                        style="width: {module.performanceScore}%"
                      ></div>
                    </div>
                    <span class="text-xs font-semibold">{module.performanceScore}/100</span>
                  </div>
                </td>
              </tr>
            {/each}
            {#if !moduleStats.performanceDetails || moduleStats.performanceDetails.length === 0}
              <tr>
                <td colspan="4" class="px-4 py-8 text-center text-sm text-on-surface-variant/50">Aucune donnée disponible</td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
    </div>
  {:else}
    <div class="premium-card rounded-[2.25rem] p-8 text-center">
      <Papicon icon="Box" size={48} class="text-on-surface-variant/40 mx-auto mb-4" />
      <h3 class="text-lg font-bold text-on-surface">Aucune donnée disponible</h3>
      <p class="text-sm text-on-surface-variant mt-2">Les statistiques de modules ne sont pas encore disponibles pour cette vue.</p>
    </div>
  {/if}
  </div>
</AdminShell>
