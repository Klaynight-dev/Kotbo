<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchPredictions } from '../lib/api';
  import { toast } from '../lib/stores/toast.svelte';
  import Papicon from '../lib/components/Papicon.svelte';
  import { m } from '../lib/i18n';

  let loading = $state(true);
  let data: any = $state(null);
  let period = $state(30);

  async function load() {
    loading = true;
    try {
      data = await fetchPredictions(period);
    } catch {
      toast.error(m.pred_load_error());
    } finally {
      loading = false;
    }
  }

  function getSeverityClass(severity: string): string {
    if (severity === 'danger') return 'anomaly-danger';
    if (severity === 'warning') return 'anomaly-warning';
    return 'anomaly-info';
  }

  onMount(load);
</script>

<div class="page-header">
  <div class="header-left">
    <h1><Papicon name="trending-up" size={24} /> {m.pred_title()}</h1>
    <p class="subtitle">{m.pred_subtitle()}</p>
  </div>
  <div class="period-selector">
    {#each [7, 14, 30, 60, 90] as p}
      <button class="btn btn-sm" class:active={period === p} onclick={() => { period = p; load(); }}>{m.pred_days_btn({ count: p })}</button>
    {/each}
  </div>
</div>

{#if loading}
  <div class="loading-container"><div class="spinner"></div></div>
{:else if data}
  <div class="pred-grid">
    <!-- Forecast -->
    <div class="card forecast-card">
      <h3>{m.pred_growth_title()}</h3>
      <div class="forecast-numbers">
        <div class="forecast-item">
          <span class="forecast-value">{data.growthForecast.predicted7d.toLocaleString()}</span>
          <span class="forecast-label">{m.pred_members_7d()}</span>
        </div>
        <div class="forecast-item">
          <span class="forecast-value">{data.growthForecast.predicted30d.toLocaleString()}</span>
          <span class="forecast-label">{m.pred_members_30d()}</span>
        </div>
        <div class="forecast-item">
          <span class="forecast-value">{data.growthForecast.confidence}%</span>
          <span class="forecast-label">{m.pred_confidence()}</span>
        </div>
      </div>
    </div>

    <!-- Seasonality -->
    <div class="card seasonality-card">
      <h3>{m.pred_seasonality_title()}</h3>
      <div class="season-items">
        <div class="season-item">
          <Papicon name="arrow-up-circle" size={16} />
          <span>{m.pred_busiest_day()} <strong>{data.seasonality.busiestDay}</strong></span>
        </div>
        <div class="season-item">
          <Papicon name="arrow-down-circle" size={16} />
          <span>{m.pred_quietest_day()} <strong>{data.seasonality.quietestDay}</strong></span>
        </div>
        <div class="season-item">
          <Papicon name="clock" size={16} />
          <span>{m.pred_busiest_hour()} <strong>{data.seasonality.busiestHour}h</strong></span>
        </div>
        <div class="season-item">
          <Papicon name="moon" size={16} />
          <span>{m.pred_quietest_hour()} <strong>{data.seasonality.quietestHour}h</strong></span>
        </div>
      </div>
    </div>

    <!-- Trends Charts -->
    {#each [
      { title: m.pred_trend_members(), data: data.membersTrend, color: 'var(--color-primary)' },
      { title: m.pred_trend_messages(), data: data.messagesTrend, color: '#22c55e' },
      { title: m.pred_trend_voice(), data: data.voiceTrend, color: '#f59e0b' },
    ] as trend}
      {@const maxVal = Math.max(...trend.data.map((p: any) => p.value), 1)}
      <div class="card trend-card">
        <h3>{trend.title}</h3>
        <div class="trend-chart">
          {#each trend.data as point}
            <div
              class="trend-bar"
              class:predicted={point.predicted}
              style="height: {(point.value / maxVal) * 100}%; background: {trend.color}"
              data-tooltip="{point.dateKey} : {point.value.toLocaleString('fr-FR')}{point.predicted ? ` ${m.pred_tooltip_predicted()}` : ''}"
            ></div>
          {/each}
        </div>
        <div class="chart-legend">
          <span class="legend-item"><span class="legend-dot" style="background: {trend.color}"></span> {m.pred_legend_real()}</span>
          <span class="legend-item"><span class="legend-dot predicted-dot" style="background: {trend.color}"></span> {m.pred_legend_predicted()}</span>
        </div>
      </div>
    {/each}

    <!-- Anomalies -->
    {#if data.anomalies.length > 0}
      <div class="card anomalies-card">
        <h3>{m.pred_anomalies_title()}</h3>
        <div class="anomalies-list">
          {#each data.anomalies as anomaly}
            <div class="anomaly {getSeverityClass(anomaly.severity)}">
              <Papicon name={anomaly.type === 'spike' ? 'arrow-up' : 'arrow-down'} size={16} />
              <span class="anomaly-msg">{anomaly.message}</span>
              <span class="anomaly-range">{m.pred_expected_range({ min: anomaly.expectedRange.min, max: anomaly.expectedRange.max })}</span>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .page-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1.5rem; }
  .header-left h1 { display: flex; align-items: center; gap: 0.5rem; font-size: 1.5rem; margin: 0; }
  .subtitle { color: color-mix(in srgb, var(--color-on-surface-variant) 75%, transparent); margin: 0.25rem 0 0; font-size: 0.875rem; }
  .period-selector { display: flex; gap: 0.25rem; }
  .period-selector .active { background: var(--color-primary); color: white; }

  .pred-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
  .card { background: var(--color-surface); border: 1px solid var(--color-outline-variant); border-radius: 12px; padding: 1.25rem; }
  .card h3 { margin: 0 0 1rem; font-size: 0.95rem; color: var(--color-on-surface-variant); }

  .forecast-card { grid-column: 1; }
  .forecast-numbers { display: flex; gap: 1.5rem; }
  .forecast-item { display: flex; flex-direction: column; }
  .forecast-value { font-size: 1.75rem; font-weight: 700; color: var(--color-on-surface); }
  .forecast-label { font-size: 0.75rem; color: color-mix(in srgb, var(--color-on-surface-variant) 75%, transparent); }

  .season-items { display: flex; flex-direction: column; gap: 0.5rem; }
  .season-item { display: flex; align-items: center; gap: 0.5rem; font-size: 0.875rem; }

  .trend-chart { display: flex; align-items: flex-end; gap: 1px; height: 100px; }
  .trend-bar { flex: 1; min-width: 3px; border-radius: 2px 2px 0 0; opacity: 0.8; transition: opacity 0.2s; position: relative; }
  .trend-bar:hover { opacity: 1; }
  .trend-bar.predicted { opacity: 0.4; border: 1px dashed; }

  .trend-bar::after {
    content: attr(data-tooltip);
    position: absolute;
    bottom: calc(100% + 8px);
    left: 50%;
    transform: translateX(-50%) translateY(4px);
    background: rgba(15, 23, 42, 0.95);
    color: #fff;
    padding: 6px 10px;
    border-radius: 8px;
    font-size: 11px;
    font-family: 'Inter', sans-serif;
    font-weight: 600;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.15s ease, transform 0.15s ease;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
    border: 1px solid rgba(255, 255, 255, 0.15);
    z-index: 10;
  }

  .trend-bar:hover::after {
    opacity: 1;
    transform: translateX(-50%) translateY(0);
  }

  .chart-legend { display: flex; gap: 1rem; margin-top: 0.5rem; font-size: 0.75rem; color: color-mix(in srgb, var(--color-on-surface-variant) 75%, transparent); }
  .legend-item { display: flex; align-items: center; gap: 0.25rem; }
  .legend-dot { width: 8px; height: 8px; border-radius: 2px; }
  .predicted-dot { opacity: 0.4; }

  .anomalies-card { grid-column: 1 / -1; }
  .anomalies-list { display: flex; flex-direction: column; gap: 0.5rem; }
  .anomaly { display: flex; align-items: center; gap: 0.5rem; padding: 0.6rem 0.75rem; border-radius: 8px; font-size: 0.85rem; }
  .anomaly-msg { flex: 1; }
  .anomaly-range { font-size: 0.75rem; color: color-mix(in srgb, var(--color-on-surface-variant) 75%, transparent); }
  .anomaly-danger { background: rgba(237, 66, 69, 0.1); color: var(--color-error); }
  .anomaly-warning { background: rgba(254, 231, 92, 0.1); color: var(--color-warning); }
  .anomaly-info { background: rgba(88, 101, 242, 0.1); color: var(--color-primary); }

  .loading-container { display: flex; justify-content: center; padding: 4rem; grid-column: 1 / -1; }

  @media (max-width: 768px) { .pred-grid { grid-template-columns: 1fr; } }
</style>
