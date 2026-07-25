<script lang="ts">
  import Chart from './charts/Chart.svelte';
  import { onMount } from 'svelte';
  import { m } from '../i18n';

  let { data = [], labelKey = 'label', valueKey = 'value', color = '#6366f1', height = 200 }: {
    data: any[]; labelKey?: string; valueKey?: string; color?: string; height?: number;
  } = $props();

  function getResolvedColor(c: string) {
    if (typeof window === 'undefined') return c;
    if (c.startsWith('var(')) {
      const match = c.match(/var\((--[^)]+)\)/);
      if (match) return getComputedStyle(document.documentElement).getPropertyValue(match[1]).trim();
    }
    return c;
  }

  const resolvedColor = $derived(getResolvedColor(color));

  const chartData = $derived({
    labels: data.map(d => d[labelKey]),
    datasets: [{
      label: m.d4_linechart_activity(),
      data: data.map(d => d[valueKey]),
      borderColor: resolvedColor,
      borderWidth: 3,
      pointRadius: 0,
      pointHoverRadius: 6,
      pointHoverBackgroundColor: resolvedColor,
      pointHoverBorderColor: '#fff',
      pointHoverBorderWidth: 3,
      tension: 0.4,
      fill: true,
      gradient: {
        backgroundColor: {
          axis: 'y',
          colors: {
            0: resolvedColor + '00',
            100: resolvedColor + '44'
          }
        }
      }
    }]
  });

  const options = {
    scales: {
      x: { display: true },
      y: { display: true, beginAtZero: true }
    }
  };
</script>

<div class="w-full" style="height: {height}px">
  <Chart data={chartData} type="line" {height} {options} />
</div>



