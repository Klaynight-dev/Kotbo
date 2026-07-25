<script lang="ts">
  import Papicon from '../Papicon.svelte';
  import Chart from '../charts/Chart.svelte';
  import DetailedAnalyticsModal from './DetailedAnalyticsModal.svelte';
  import { m } from '../../i18n';

  let { data, onOpenMember, chartLabels } = $props<{ 
    data: any; 
    onOpenMember: (id: string, name: string) => void;
    chartLabels?: any;
  }>();

  const recentSanctions = $derived(data?.recentSanctions || []);
  const topModerators = $derived(data?.topModerators || []);
  const topSanctionedMembers = $derived(data?.topSanctionedMembers || []);
  const stats = $derived([
    { label: m.d4_mod_warnings(), value: data?.totals?.warns || 0, color: '#f59e0b' },
    { label: m.d4_mod_kicks(), value: data?.totals?.kicks || 0, color: '#f97316' },
    { label: m.d4_mod_bans(), value: data?.totals?.bans || 0, color: '#f43f5e' },
    { label: m.d4_mod_timeouts(), value: data?.totals?.timeouts || 0, color: '#8b5cf6' }
  ]);

  const distributionData = $derived({
    labels: stats.map(s => s.label),
    datasets: [{
      data: stats.map(s => s.value),
      backgroundColor: stats.map(s => s.color),
      borderWidth: 0,
      hoverOffset: 10,
      cutout: '75%',
      borderRadius: 4
    }]
  });

  const doughnutOptions = {
    plugins: {
      legend: { display: false }
    },
    maintainAspectRatio: false
  };

  const trendChartData = $derived({
    labels: data?.dailyTrend?.map((d: any) => {
      const parts = d.dateKey.split(' ')[0].split('-');
      return `${parts[2]}/${parts[1]}`;
    }) || [],
    datasets: [{
      label: m.d4_mod_sanctions(),
      data: data?.dailyTrend?.map((d: any) => d.sanctions || 0) || [],
      borderColor: '#f43f5e',
      backgroundColor: 'rgba(244, 63, 94, 0.1)',
      fill: true,
      tension: 0.4,
      pointRadius: 0,
      borderWidth: 3
    }]
  });

  const trendOptions = {
    scales: {
      x: { display: true, grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 7 } },
      y: { display: true, beginAtZero: true, grid: { color: 'rgba(255,255,255,0.05)' } }
    },
    plugins: {
      legend: { display: false }
    },
    maintainAspectRatio: false
  };

  const getAvatar = (url: string | null) => url || 'https://cdn.discordapp.com/embed/avatars/0.png';

  let showModsModal = $state(false);
  let showSanctionedModal = $state(false);
  let showRecentModal = $state(false);

  const getSanctionColor = (type: string) => {
    switch (type) {
      case 'BAN': case 'TEMP_BAN': return '#f43f5e';
      case 'KICK': return '#f97316';
      case 'TIMEOUT': return '#8b5cf6';
      case 'WARN': return '#f59e0b';
      default: return '#64748b';
    }
  };
</script>

<div class="space-y-6">
  <!-- Moderation Stats & Charts -->
  <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
    {#each stats as stat}
      <div class="premium-card p-6 rounded-xl flex flex-col items-center text-center gap-2 group hover: transition-all">
        <div class="p-3 rounded-lg mb-2" style="background: {stat.color}15; color: {stat.color}">
           <Papicon icon="Hammer" size={20} />
        </div>
        <span class="text-lg font-semibold" style="color: {stat.color}">{stat.value}</span>
        <p class="text-xs font-medium text-on-surface-variant/40">{stat.label}</p>
      </div>
    {/each}
  </div>

  <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
    <!-- Distribution Chart -->
    <div class="premium-card p-6 rounded-xl flex flex-col items-center justify-center min-h-[220px]">
      <div class="flex items-center gap-3 mb-6 w-full">
        <div class="p-2 rounded-xl bg-amber-500/10 text-amber-500">
          <Papicon icon="ChartPieSlice" size={18} />
        </div>
        <h4 class="text-sm font-semibold text-on-surface uppercase tracking-widest">{m.d4_distribution()}</h4>
      </div>
      <div class="h-32 w-32 relative">
        <Chart data={distributionData} type="doughnut" height={128} options={doughnutOptions} />
        <div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
           <span class="text-xl font-semibold text-on-surface">{stats.reduce((a, b) => a + b.value, 0)}</span>
           <span class="text-xs font-medium text-on-surface-variant/40">{m.d4_total()}</span>
        </div>
      </div>
    </div>

    <!-- Trend Chart -->
    <div class="premium-card p-6 rounded-xl flex flex-col min-h-[220px] space-y-4">
      <div class="flex items-center gap-3">
        <div class="p-2 rounded-xl bg-rose-500/10 text-rose-500">
          <Papicon icon="ChartLineUp" size={18} />
        </div>
        <h4 class="text-sm font-semibold text-on-surface uppercase tracking-widest">{m.d4_trend()}</h4>
      </div>
      <div class="flex-grow h-[140px]">
        <Chart data={trendChartData} type="line" height={140} options={trendOptions} />
      </div>
    </div>
  </div>

  <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
    <!-- Top Moderators -->
    <div class="premium-card p-8 rounded-xl space-y-6 flex flex-col">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="p-2 rounded-xl bg-primary/10 text-primary">
            <Papicon icon="ShieldCheck" size={20} />
          </div>
          <h3 class="text-lg font-semibold text-on-surface">{m.d4_top_moderators()}</h3>
        </div>
        <button 
          onclick={() => showModsModal = true}
          class="px-4 py-2 rounded-xl bg-surface-container-high/40 hover:bg-surface-container-high text-xs font-bold text-on-surface transition-colors"
        >
          {m.d4_see_more()}
        </button>
      </div>
      <div class="space-y-3 flex-grow pr-2">
        {#each topModerators.slice(0, 5) as mod}
          <button 
            onclick={() => onOpenMember(mod.userId, mod.moderatorTag)}
            class="w-full flex items-center justify-between p-3 rounded-lg bg-surface-container-high/20 hover:bg-surface-container-high/50 transition-all text-left"
          >
            <div class="flex items-center gap-3">
              <img src={getAvatar(mod.avatarUrl)} alt="" class="w-8 h-8 rounded-lg object-cover" />
              <div>
                <p class="text-sm font-semibold text-on-surface">@{mod.moderatorTag}</p>
                <p class="text-[10px] font-bold text-on-surface-variant/40 uppercase tracking-widest">{m.d4_moderation_activity()}</p>
              </div>
            </div>
            <span class="text-sm font-semibold text-primary">{m.d4_count_actions({ count: mod.count })}</span>
          </button>
        {/each}
        {#if topModerators.length === 0}
          <p class="text-sm text-on-surface-variant/40 text-center py-4">{m.d4_no_data_available()}</p>
        {/if}
      </div>
    </div>

    <!-- Top Sanctioned -->
    <div class="premium-card p-8 rounded-xl space-y-6 flex flex-col">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-3">
          <div class="p-2 rounded-xl bg-rose-500/10 text-rose-500">
            <Papicon icon="UserFocus" size={20} />
          </div>
          <h3 class="text-lg font-semibold text-on-surface">{m.d4_sanctioned_members()}</h3>
        </div>
        <button 
          onclick={() => showSanctionedModal = true}
          class="px-4 py-2 rounded-xl bg-surface-container-high/40 hover:bg-surface-container-high text-xs font-bold text-on-surface transition-colors"
        >
          {m.d4_see_more()}
        </button>
      </div>
      <div class="space-y-3 flex-grow pr-2">
        {#each topSanctionedMembers.slice(0, 5) as member}
          <button
            onclick={() => onOpenMember(member.targetUserId, member.targetTag)}
            class="w-full flex items-center justify-between p-3 rounded-lg bg-surface-container-high/20 hover:bg-surface-container-high/50 transition-all text-left"
          >
            <div class="flex items-center gap-3">
              <img src={getAvatar(member.avatarUrl)} alt="" class="w-8 h-8 rounded-lg object-cover" />
              <div>
                <p class="text-sm font-semibold text-on-surface">@{member.targetTag}</p>
                <p class="text-[10px] font-bold text-on-surface-variant/40 uppercase tracking-widest">{m.d4_recidivism()}</p>
              </div>
            </div>
            <span class="text-sm font-semibold text-rose-500">{m.d4_count_sanctions({ count: member.count })}</span>
          </button>
        {/each}
        {#if topSanctionedMembers.length === 0}
          <p class="text-sm text-on-surface-variant/40 text-center py-4">{m.d4_no_sanctioned_member()}</p>
        {/if}
      </div>
    </div>
  </div>

  <!-- Recent Sanctions -->
  <div class="premium-card p-8 rounded-xl space-y-8">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-4">
        <div class="bg-rose-500/10 p-3 rounded-lg text-rose-500">
          <Papicon icon="Gavel" size={24} />
        </div>
        <div>
          <h3 class="text-xl font-semibold text-on-surface">{m.d4_recent_history()}</h3>
          <p class="text-xs font-bold text-on-surface-variant/40">{m.d4_latest_recorded_actions()}</p>
        </div>
      </div>
      <button 
        onclick={() => showRecentModal = true}
        class="px-4 py-2 rounded-xl bg-surface-container-high/40 hover:bg-surface-container-high text-xs font-bold text-on-surface transition-colors"
      >
        Voir plus
      </button>
    </div>

    <div class="space-y-4">
      {#each recentSanctions.slice(0, 5) as sanction}
        <div class="flex flex-col md:flex-row md:items-center justify-between p-5 rounded-xl bg-surface-container-high/30 border border-outline-variant/10 hover:bg-surface-container-high/50 transition-all group gap-4">
          <div class="flex items-center gap-4">
            <button 
              onclick={() => onOpenMember(sanction.targetUserId, sanction.targetTag)}
              class="w-12 h-12 rounded-lg overflow-hidden bg-on-surface/5 flex items-center justify-center transition-transform shrink-0"
            >
              <img src={getAvatar(sanction.targetAvatarUrl)} alt="" class="w-full h-full object-cover" />
            </button>
            <div>
              <div class="flex items-center gap-2">
                <p class="text-sm font-semibold text-on-surface">@{sanction.targetTag}</p>
                <span class="px-2 py-0.5 rounded-lg text-[11px] font-semibold tracking-widest uppercase" style="background: {getSanctionColor(sanction.type)}20; color: {getSanctionColor(sanction.type)}">{sanction.type}</span>
              </div>
              <p class="text-xs font-medium text-on-surface-variant/60 mt-0.5 line-clamp-1">{sanction.reason || m.d4_no_reason_specified()}</p>
            </div>
          </div>
          <div class="flex items-center justify-between md:justify-end gap-6 border-t md:border-t-0 border-outline-variant/5 pt-3 md:pt-0 shrink-0">
            <div class="text-right">
              <p class="text-[11px] font-semibold text-on-surface-variant/40 uppercase tracking-widest">{m.d4_moderator()}</p>
              <div class="flex items-center gap-2 mt-0.5">
                <img src={getAvatar(sanction.moderatorAvatarUrl)} alt="" class="w-5 h-5 rounded-md object-cover" />
                <p class="text-xs font-bold text-on-surface">@{sanction.moderatorTag}</p>
              </div>
            </div>
            <Papicon icon="CaretRight" size={16} class="text-on-surface-variant/20 group-hover:translate-x-1 transition-transform" />
          </div>
        </div>
      {/each}
      {#if recentSanctions.length === 0}
        <div class="py-20 text-center opacity-40">
          <Papicon icon="ShieldCheck" size={48} class="mx-auto mb-4" />
          <p class="text-sm font-bold">{m.d4_clean_moderation_record()}</p>
        </div>
      {/if}
    </div>
  </div>
</div>

<DetailedAnalyticsModal
  open={showModsModal}
  onClose={() => showModsModal = false}
  title={m.d4_top_moderators()}
  subtitle={m.d4_mod_ranking_by_actions()}
  icon="ShieldCheck"
  iconBgClass="bg-primary/10"
  iconColorClass="text-primary"
  type="moderators"
  data={topModerators}
  {onOpenMember}
/>

<DetailedAnalyticsModal
  open={showSanctionedModal}
  onClose={() => showSanctionedModal = false}
  title={m.d4_sanctioned_members()}
  subtitle={m.d4_mod_ranking_by_recidivism()}
  icon="UserFocus"
  iconBgClass="bg-rose-500/10"
  iconColorClass="text-rose-500"
  type="sanctioned"
  data={topSanctionedMembers}
  {onOpenMember}
/>

<DetailedAnalyticsModal
  open={showRecentModal}
  onClose={() => showRecentModal = false}
  title={m.d4_recent_history()}
  subtitle={m.d4_latest_moderation_actions()}
  icon="Gavel"
  iconBgClass="bg-rose-500/10"
  iconColorClass="text-rose-500"
  type="recent_sanctions"
  data={recentSanctions}
  {onOpenMember}
  {getSanctionColor}
/>

<style>
  .premium-card {
    background: rgba(var(--color-surface-container-low), 0.4);
    backdrop-filter: blur(24px);
    border: 1px solid rgba(var(--color-outline-variant), 0.1);
    transition: all 0.4s cubic-bezier(0.2, 1, 0.3, 1);
  }
</style>




