<script lang="ts">
  import Papicon from '../Papicon.svelte';
  import Chart from '../charts/Chart.svelte';
  import { m } from '../../i18n';

  let { data } = $props<{
    data: {
      metrics: {
        totalRuns: number;
        totalSubmissions: number;
        completedSubmissions: number;
        avgSubmissionsPerRun: number;
        completionRate: number;
      };
      topPerformers: Array<{
        userId: string;
        name: string;
        submissions: number;
        validated: number;
        avgScore: number;
      }>;
      difficultyDistribution: Array<{ difficulty: string; count: number }>;
      trend: Array<{ dateKey: string; count: number }>;
    };
  }>();

  const trendChartData = $derived({
    labels: data.trend.map(t => t.dateKey.slice(5)),
    datasets: [{
      label: m.d7_algo_challenges_launched(),
      data: data.trend.map(t => t.count),
      borderColor: '#6366f1',
      backgroundColor: 'rgba(99, 102, 241, 0.1)',
      fill: true,
      tension: 0.4,
      pointRadius: 0,
      gradient: {
        backgroundColor: {
          axis: 'y',
          colors: {
            0: 'rgba(99, 102, 241, 0)',
            100: 'rgba(99, 102, 241, 0.2)'
          }
        }
      }
    }]
  });

  const difficultyChartData = $derived({
    labels: data.difficultyDistribution.map(d => d.difficulty || m.d7_unknown()),
    datasets: [{
      label: m.d7_algo_challenges_count(),
      data: data.difficultyDistribution.map(d => d.count),
      backgroundColor: ['#10b981', '#f59e0b', '#ef4444'],
      borderRadius: 8,
      borderSkipped: false
    }]
  });

  const performerChartData = $derived({
    labels: data.topPerformers.slice(0, 10).map(p => p.name),
    datasets: [{
      label: m.d7_algo_avg_score(),
      data: data.topPerformers.slice(0, 10).map(p => p.avgScore),
      backgroundColor: '#6366f1',
      borderRadius: 8,
      borderSkipped: false
    }]
  });

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: true, position: 'top' as const }
    }
  };
</script>

<div class="space-y-6">
  <!-- Key Metrics -->
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
    <div class="premium-card p-6 rounded-xl space-y-3">
      <div class="flex items-center justify-between">
        <Papicon icon="Code" size={20} class="text-primary" />
        <span class="text-[11px] font-bold text-on-surface-variant/40 uppercase">{m.d7_challenges()}</span>
      </div>
      <p class="text-2xl font-semibold text-on-surface">{data.metrics.totalRuns}</p>
      <p class="text-[11px] font-bold text-on-surface-variant/60">{m.d7_algo_launched()}</p>
    </div>

    <div class="premium-card p-6 rounded-xl space-y-3">
      <div class="flex items-center justify-between">
        <Papicon icon="FileText" size={20} class="text-secondary" />
        <span class="text-[11px] font-bold text-on-surface-variant/40 uppercase">{m.d7_submissions()}</span>
      </div>
      <p class="text-2xl font-semibold text-on-surface">{data.metrics.totalSubmissions}</p>
      <p class="text-[11px] font-bold text-on-surface-variant/60">{m.d7_algo_submitted()}</p>
    </div>

    <div class="premium-card p-6 rounded-xl space-y-3">
      <div class="flex items-center justify-between">
        <Papicon icon="CheckCircle" size={20} class="text-emerald-500" />
        <span class="text-[11px] font-bold text-on-surface-variant/40 uppercase">{m.d7_algo_completed()}</span>
      </div>
      <p class="text-2xl font-semibold text-on-surface">{data.metrics.completedSubmissions}</p>
      <p class="text-[11px] font-bold text-on-surface-variant/60">{m.d7_algo_validated_lc()}</p>
    </div>

    <div class="premium-card p-6 rounded-xl space-y-3">
      <div class="flex items-center justify-between">
        <Papicon icon="BarChart2" size={20} class="text-blue-500" />
        <span class="text-[11px] font-bold text-on-surface-variant/40 uppercase">{m.d7_algo_average()}</span>
      </div>
      <p class="text-2xl font-semibold text-on-surface">{data.metrics.avgSubmissionsPerRun}</p>
      <p class="text-[11px] font-bold text-on-surface-variant/60">{m.d7_algo_per_challenge()}</p>
    </div>

    <div class="premium-card p-6 rounded-xl space-y-3 bg-emerald-500/5 border-emerald-500/20">
      <div class="flex items-center justify-between">
        <Papicon icon="Target" size={20} class="text-emerald-500" />
        <span class="text-[11px] font-bold text-on-surface-variant/40 uppercase">{m.d7_algo_rate()}</span>
      </div>
      <p class="text-2xl font-semibold text-emerald-500">{data.metrics.completionRate}%</p>
      <p class="text-[11px] font-bold text-on-surface-variant/60">{m.d7_algo_completed_lc()}</p>
    </div>
  </div>

  <!-- Charts -->
  <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
    <!-- Trend Chart -->
    <div class="premium-card p-8 rounded-xl space-y-6">
      <div class="flex items-center gap-4">
        <div class="bg-primary/10 p-3 rounded-lg text-primary">
          <Papicon icon="TrendingUp" size={24} />
        </div>
        <div>
          <h4 class="font-semibold text-on-surface">{m.d7_algo_challenge_trend()}</h4>
          <p class="text-[11px] font-bold text-on-surface-variant/40">{m.d7_algo_challenges_per_day()}</p>
        </div>
      </div>
      <div class="h-[300px]">
        <Chart data={trendChartData} type="line" height={300} options={chartOptions} />
      </div>
    </div>

    <!-- Difficulty Distribution -->
    <div class="premium-card p-8 rounded-xl space-y-6">
      <div class="flex items-center gap-4">
        <div class="bg-secondary/10 p-3 rounded-lg text-secondary">
          <Papicon icon="Layers" size={24} />
        </div>
        <div>
          <h4 class="font-semibold text-on-surface">{m.d7_algo_difficulty_distribution()}</h4>
          <p class="text-[11px] font-bold text-on-surface-variant/40">{m.d7_algo_challenge_breakdown()}</p>
        </div>
      </div>
      <div class="h-[300px]">
        <Chart data={difficultyChartData} type="bar" height={300} options={chartOptions} />
      </div>
    </div>
  </div>

  <!-- Top Performers -->
  <div class="premium-card p-8 rounded-xl space-y-6">
    <div class="flex items-center gap-4">
      <div class="bg-tertiary/10 p-3 rounded-lg text-tertiary">
        <Papicon icon="Users" size={24} />
      </div>
      <div>
        <h4 class="font-semibold text-on-surface">{m.d7_algo_top_performers()}</h4>
        <p class="text-[11px] font-bold text-on-surface-variant/40">{m.d7_algo_avg_score_per_participant()}</p>
      </div>
    </div>
    <div class="h-[300px]">
      <Chart data={performerChartData} type="bar" height={300} options={{ ...chartOptions, indexAxis: 'y' }} />
    </div>

    <!-- Table -->
    <div class="overflow-x-auto mt-6">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-outline-variant/10">
            <th class="text-left px-4 py-3 font-semibold text-on-surface-variant/60 text-[10px] uppercase">#</th>
            <th class="text-left px-4 py-3 font-semibold text-on-surface-variant/60 text-[10px] uppercase">{m.d7_algo_participant()}</th>
            <th class="text-center px-4 py-3 font-semibold text-on-surface-variant/60 text-[10px] uppercase">{m.d7_submissions()}</th>
            <th class="text-center px-4 py-3 font-semibold text-on-surface-variant/60 text-[10px] uppercase">{m.d7_algo_validated()}</th>
            <th class="text-center px-4 py-3 font-semibold text-on-surface-variant/60 text-[10px] uppercase">{m.d7_algo_avg_score_col()}</th>
          </tr>
        </thead>
        <tbody>
          {#each data.topPerformers.slice(0, 20) as performer, idx}
            <tr class="border-b border-outline-variant/5 hover:bg-surface-container-high/20 transition-colors">
              <td class="px-4 py-3 font-bold text-on-surface-variant/60">{idx + 1}</td>
              <td class="px-4 py-3 font-bold text-on-surface">{performer.name}</td>
              <td class="px-4 py-3 text-center text-on-surface">{performer.submissions}</td>
              <td class="px-4 py-3 text-center font-bold text-emerald-500">{performer.validated}</td>
              <td class="px-4 py-3 text-center font-semibold text-on-surface">{performer.avgScore.toFixed(2)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
</div>

