<script lang="ts">
  import Papicon from '../Papicon.svelte';
  import { m } from '../../i18n';

  type HeatmapMetric = 'messages' | 'voice' | 'active' | 'joins' | 'leaves' | 'net';
  type HeatmapCell = { messages: number; voice: number; active: number; joins?: number; leaves?: number; net?: number };

  let { data } = $props<{
    data: Record<number, Record<number, HeatmapCell>>;
  }>();

  let metric = $state<HeatmapMetric>('messages');

  const dayNames = [m.d4_day_short_sun(), m.d4_day_short_mon(), m.d4_day_short_tue(), m.d4_day_short_wed(), m.d4_day_short_thu(), m.d4_day_short_fri(), m.d4_day_short_sat()];
  const dayNamesFull = [m.d4_day_full_sun(), m.d4_day_full_mon(), m.d4_day_full_tue(), m.d4_day_full_wed(), m.d4_day_full_thu(), m.d4_day_full_fri(), m.d4_day_full_sat()];
  const hours = Array.from({ length: 24 }, (_, i) => i);

  let showValues = $state(false);
  let hoveredDow = $state<number | null>(null);
  let hoveredHour = $state<number | null>(null);

  const metricConfig = {
    messages: { label: m.d4_hm_metric_messages(), icon: 'ChatCircleDots', unit: 'msg', color1: '#312e81', color2: '#4f46e5', color3: '#818cf8', colorPeak: '#c7d2fe', negative: false },
    voice: { label: m.d4_hm_metric_voice(), icon: 'Microphone', unit: 'min', color1: '#701a75', color2: '#a21caf', color3: '#e879f9', colorPeak: '#fae8ff', negative: false },
    active: { label: m.d4_hm_metric_active(), icon: 'Users', unit: m.d4_hm_unit_members(), color1: '#064e3b', color2: '#059669', color3: '#34d399', colorPeak: '#d1fae5', negative: false },
    joins: { label: m.d4_hm_metric_joins(), icon: 'LogIn', unit: m.d4_hm_unit_members(), color1: '#064e3b', color2: '#059669', color3: '#34d399', colorPeak: '#d1fae5', negative: false },
    leaves: { label: m.d4_hm_metric_leaves(), icon: 'LogOut', unit: m.d4_hm_unit_members(), color1: '#7c2d12', color2: '#ea580c', color3: '#fb923c', colorPeak: '#ffedd5', negative: false },
    net: { label: m.d4_hm_metric_net(), icon: 'TrendUp', unit: 'net', color1: '#1e3a5f', color2: '#2563eb', color3: '#60a5fa', colorPeak: '#dbeafe', negative: true },
  };

  const activityMetrics = ['messages', 'voice', 'active'] as const;
  const fluxMetrics = ['joins', 'leaves', 'net'] as const;

  /** joins/leaves = moyennes issues de GuildDailyStat.membersJoined / membersLeft */
  function cellValue(dow: number, hour: number): number {
    const cell = data[dow]?.[hour];
    if (!cell) return 0;
    if (metric === 'net') {
      return cell.net ?? ((cell.joins ?? 0) - (cell.leaves ?? 0));
    }
    return (cell as Record<string, number>)[metric] ?? 0;
  }

  const fluxMetricActive = $derived(fluxMetrics.includes(metric as (typeof fluxMetrics)[number]));

  const maxValue = $derived.by(() => {
    let max = 0;
    for (let dow = 0; dow < 7; dow++) {
      for (let hour = 0; hour < 24; hour++) {
        const val = cellValue(dow, hour);
        const magnitude = metric === 'net' ? Math.abs(val) : val;
        if (magnitude > max) max = magnitude;
      }
    }
    return max;
  });

  const totalValue = $derived.by(() => {
    let total = 0;
    for (let dow = 0; dow < 7; dow++) {
      for (let hour = 0; hour < 24; hour++) {
        total += cellValue(dow, hour);
      }
    }
    return total;
  });

  // Find the peak cell
  const peakCell = $derived.by(() => {
    let peak = { dow: 0, hour: 0, val: 0 };
    for (let dow = 0; dow < 7; dow++) {
      for (let hour = 0; hour < 24; hour++) {
        const val = cellValue(dow, hour);
        const magnitude = metric === 'net' ? Math.abs(val) : val;
        const peakMag = metric === 'net' ? Math.abs(peak.val) : peak.val;
        if (magnitude > peakMag) peak = { dow, hour, val };
      }
    }
    return peak;
  });

  // Day sums for row totals
  const dayTotals = $derived.by(() => {
    return Array.from({ length: 7 }, (_, dow) =>
      Array.from({ length: 24 }).reduce((sum, _, h) => sum + cellValue(dow, h), 0) as number
    );
  });

  // Hour sums for column totals
  const hourTotals = $derived.by(() => {
    return Array.from({ length: 24 }, (_, h) =>
      Array.from({ length: 7 }).reduce((sum, _, dow) => sum + cellValue(dow, h), 0) as number
    );
  });

  const maxDayTotal = $derived(Math.max(...dayTotals.map((v) => metric === 'net' ? Math.abs(v) : v), 1));
  const maxHourTotal = $derived(Math.max(...hourTotals.map((v) => metric === 'net' ? Math.abs(v) : v), 1));

  function getCellStyle(val: number, max: number): string {
    if (max === 0 || Math.abs(val) < 0.01) return 'background: rgba(255,255,255,0.03); border-color: rgba(255,255,255,0.04);';
    const magnitude = metric === 'net' ? Math.abs(val) : val;
    const t = magnitude / max;
    const cfg = metricConfig[metric];
    if (metric === 'net' && val < 0) {
      if (t < 0.15) return 'background: #7f1d1d25; border-color: #7f1d1d40;';
      if (t < 0.35) return 'background: #7f1d1d60; border-color: #b91c1c50;';
      if (t < 0.55) return 'background: #b91c1c80; border-color: #dc262670;';
      if (t < 0.75) return 'background: #dc2626cc; border-color: #ef444480;';
      if (t < 0.9) return 'background: #f87171dd; border-color: #f87171; box-shadow: 0 0 8px #f8717140;';
      return 'background: #fecaca; border-color: #fecaca; color: #0f172a; box-shadow: 0 0 12px #f8717180;';
    }
    if (t < 0.15) return `background: ${cfg.color1}25; border-color: ${cfg.color1}40;`;
    if (t < 0.35) return `background: ${cfg.color1}60; border-color: ${cfg.color2}50;`;
    if (t < 0.55) return `background: ${cfg.color2}80; border-color: ${cfg.color2}70;`;
    if (t < 0.75) return `background: ${cfg.color2}cc; border-color: ${cfg.color3}80;`;
    if (t < 0.9) return `background: ${cfg.color3}dd; border-color: ${cfg.color3}; box-shadow: 0 0 8px ${cfg.color3}40;`;
    return `background: ${cfg.colorPeak}; border-color: ${cfg.colorPeak}; color: #0f172a; box-shadow: 0 0 12px ${cfg.color3}80;`;
  }

  function getCellTextColor(val: number, max: number): string {
    if (max === 0 || val === 0) return 'rgba(255,255,255,0.15)';
    const magnitude = metric === 'net' ? Math.abs(val) : val;
    const t = magnitude / max;
    if (t < 0.55) return 'rgba(255,255,255,0.5)';
    if (t < 0.9) return 'rgba(255,255,255,0.95)';
    return '#0f172a';
  }

  function formatFlux(v: number): string {
    const abs = Math.abs(v);
    const prefix = v < 0 ? '−' : v > 0 && metric === 'net' ? '+' : '';
    if (abs >= 1000) return `${prefix}${(abs / 1000).toFixed(1)}k`;
    if (abs % 1 !== 0) return `${prefix}${abs.toFixed(1)}`;
    return `${prefix}${abs}`;
  }

  function formatVal(v: number): string {
    if (fluxMetricActive) return formatFlux(v);
    const abs = Math.abs(v);
    if (abs >= 1000) return `${(abs / 1000).toFixed(1)}k`;
    return abs.toString();
  }

  const cfg = $derived(metricConfig[metric]);

  // Best time slot description
  const bestSlot = $derived(
    peakCell.val > 0
      ? m.d4_hm_best_slot({ day: dayNamesFull[peakCell.dow], hour: String(peakCell.hour).padStart(2, '0') })
      : m.d4_no_data()
  );
</script>

<div class="space-y-6">
  <!-- Header Card -->
  <div class="premium-card p-6 md:p-8 rounded-xl space-y-6">
    <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
      <div class="flex items-center gap-4">
        <div class="bg-primary/10 p-3 rounded-lg text-primary">
          <Papicon icon="fire" size={24} />
        </div>
        <div>
          <h3 class="text-xl font-semibold text-on-surface">{m.d4_hm_title()}</h3>
          <p class="text-xs font-bold text-on-surface-variant/40">
            {fluxMetricActive
              ? m.d4_hm_subtitle_flux()
              : m.d4_hm_subtitle_default()}
          </p>
        </div>
      </div>

      <!-- Controls -->
      <div class="flex flex-col items-end gap-2">
        <div class="flex flex-wrap items-center justify-end gap-2">
          {#each activityMetrics as mk}
            <button
              onclick={() => metric = mk}
              class="flex items-center gap-1.5 px-3 py-2 rounded-xl font-semibold text-[10px] uppercase tracking-widest transition-all duration-200 border {metric === mk
 ? 'bg-primary text-on-primary border-primary '
                : 'bg-surface-container-high/40 text-on-surface-variant/60 border-outline-variant/10 hover:bg-surface-container-high hover:text-on-surface'}"
            >
              <Papicon icon={metricConfig[mk].icon} size={12} />
              {metricConfig[mk].label}
            </button>
          {/each}
        </div>
        <div class="flex flex-wrap items-center justify-end gap-2">
          {#each fluxMetrics as mk}
            <button
              onclick={() => metric = mk}
              class="flex items-center gap-1.5 px-3 py-2 rounded-xl font-semibold text-[10px] uppercase tracking-widest transition-all duration-200 border {metric === mk
 ? 'bg-emerald-600 text-white border-emerald-500 shadow-sm'
                : 'bg-surface-container-high/40 text-on-surface-variant/60 border-outline-variant/10 hover:bg-surface-container-high hover:text-on-surface'}"
            >
              <Papicon icon={metricConfig[mk].icon} size={12} />
              {metricConfig[mk].label}
            </button>
          {/each}
        </div>

        <!-- Show values toggle -->
        <button
          onclick={() => showValues = !showValues}
          class="flex items-center gap-1.5 px-3 py-2 rounded-xl font-semibold text-[10px] uppercase tracking-widest transition-all duration-200 border {showValues
 ? 'bg-surface-container-high text-on-surface border-outline-variant/30'
            : 'text-on-surface-variant/40 border-outline-variant/10 hover:bg-surface-container-high'}"
          title={m.d4_hm_show_values()}
        >
          <Papicon icon="Hash" size={12} />
          {m.d4_hm_values()}
        </button>
      </div>
    </div>

    <!-- Summary stats -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
      <div class="bg-surface-container-high/30 rounded-lg p-4 border border-outline-variant/5">
        <p class="text-[11px] font-semibold uppercase tracking-widest text-on-surface-variant/40 mb-1">{m.d4_hm_period_total()}</p>
        <p class="text-lg font-semibold text-on-surface {metric === 'net' && totalValue < 0 ? 'text-rose-400' : metric === 'net' && totalValue > 0 ? 'text-emerald-400' : ''}">
          {metric === 'net' && totalValue > 0 ? '+' : ''}{totalValue.toLocaleString('fr-FR')}
          <span class="text-xs font-bold text-on-surface-variant/40">{cfg.unit}</span>
        </p>
      </div>
      <div class="bg-surface-container-high/30 rounded-lg p-4 border border-outline-variant/5">
        <p class="text-[11px] font-semibold uppercase tracking-widest text-on-surface-variant/40 mb-1">{m.d4_hm_absolute_peak()}</p>
        <p class="text-lg font-semibold text-on-surface">
          {metric === 'net' && peakCell.val > 0 ? '+' : ''}{peakCell.val.toLocaleString('fr-FR')}
          <span class="text-xs font-bold text-on-surface-variant/40">{cfg.unit}</span>
        </p>
      </div>
      <div class="bg-surface-container-high/30 rounded-lg p-4 border border-outline-variant/5 md:col-span-2">
        <p class="text-[11px] font-semibold uppercase tracking-widest text-on-surface-variant/40 mb-1">{m.d4_hm_peak_hour()}</p>
        <p class="text-base font-semibold text-on-surface flex items-center gap-2">
          <Papicon icon="Lightning" size={14} class="text-amber-400" />
          {bestSlot}
        </p>
      </div>
    </div>
  </div>

  <!-- Heatmap Grid Card -->
  <div class="premium-card p-4 md:p-8 rounded-xl overflow-hidden">
    <div class="overflow-x-auto">
      <div class="min-w-[700px]">
        <!-- Hour axis labels -->
        <div class="flex items-center mb-1 pl-14 pr-14">
          {#each hours as hour}
            <div class="flex-1 text-center">
              {#if hour % 3 === 0}
                <span class="text-[11px] font-semibold text-on-surface-variant/40">{String(hour).padStart(2, '0')}h</span>
              {/if}
            </div>
          {/each}
        </div>

        <!-- Heatmap rows -->
        {#each { length: 7 } as _, dow}
          {@const isHovDow = hoveredDow === dow}
          <div class="flex items-center gap-1 mb-0.5 group/row">
            <!-- Day label -->
            <div
              class="w-12 flex-shrink-0 flex items-center justify-end pr-2 cursor-default"
              onmouseenter={() => { hoveredDow = dow; hoveredHour = null; }}
              onmouseleave={() => hoveredDow = null}
              role="button"
              tabindex="-1"
            >
              <span class="text-[10px] font-semibold uppercase tracking-wider transition-colors duration-150 {isHovDow ? 'text-on-surface' : 'text-on-surface-variant/50'}">{dayNames[dow]}</span>
            </div>

            <!-- Cells -->
            {#each hours as hour}
              {@const val = cellValue(dow, hour)}
              {@const isHovHour = hoveredHour === hour}
              {@const isPeak = dow === peakCell.dow && hour === peakCell.hour && (metric === 'net' ? peakCell.val !== 0 : peakCell.val > 0)}
              <div
                class="flex-1 aspect-square rounded-lg border transition-all duration-150 flex items-center justify-center cursor-default relative group/cell
 {(isHovDow || isHovHour) ? 'scale-[1.12] z-10 shadow-lg' : ''}
                  {isPeak ? 'ring-1 ring-amber-400/60' : ''}"
                style="{getCellStyle(val, maxValue)}"
                onmouseenter={() => { hoveredDow = dow; hoveredHour = hour; }}
                onmouseleave={() => { hoveredDow = null; hoveredHour = null; }}
                role="button"
                tabindex="-1"
                aria-label={m.d4_hm_cell_aria({ day: dayNamesFull[dow], hour: String(hour).padStart(2,'0'), value: val, unit: cfg.unit })}
              >
                <!-- Value text -->
                {#if showValues && Math.abs(val) >= 0.05}
                  <span class="text-[10px] font-semibold leading-none select-none" style="color: {getCellTextColor(val, maxValue)}">
                    {formatVal(val)}
                  </span>
                {:else if isPeak && !showValues}
                  <div class="w-1 h-1 rounded-full bg-amber-400/60"></div>
                {/if}

                <!-- Tooltip -->
                <div class="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-surface-container-highest/95 text-on-surface rounded-xl text-[10px] font-bold
 opacity-0 group-hover/cell:opacity-100 transition-all duration-150 pointer-events-none whitespace-nowrap z-50
                  border border-outline-variant/20 shadow-sm shadow-black/40">
                  <div class="font-semibold text-[11px]">{m.d4_hm_tooltip_range({ day: dayNamesFull[dow], start: String(hour).padStart(2, '0'), end: String(hour + 1).padStart(2, '0') })}</div>
                  <div class="text-primary font-semibold mt-0.5">
                    {fluxMetricActive ? formatFlux(val) : val.toLocaleString('fr-FR')} {cfg.unit}
                  </div>
                  {#if maxValue > 0}
                    <div class="text-on-surface-variant/40 text-[11px] mt-0.5">{m.d4_hm_pct_of_peak({ pct: Math.round((Math.abs(val) / maxValue) * 100) })}</div>
                  {/if}
                </div>
              </div>
            {/each}

            <!-- Row total bar -->
            <div class="w-12 flex-shrink-0 pl-1.5 flex items-center" title={m.d4_hm_day_total_title({ day: dayNamesFull[dow], value: dayTotals[dow], unit: cfg.unit })}>
              <div class="h-3 rounded-full bg-surface-container-high overflow-hidden w-full">
                <div class="h-full rounded-full transition-all duration-500" style="width: {Math.round((Math.abs(dayTotals[dow]) / maxDayTotal) * 100)}%; background: {dayTotals[dow] < 0 && metric === 'net' ? '#ef4444' : cfg.color2}"></div>
              </div>
            </div>
          </div>
        {/each}

        <!-- Column total bars -->
        <div class="flex items-end mt-2 pl-14 pr-14">
          {#each hours as hour}
            <div class="flex-1 flex flex-col items-center gap-0.5" title={m.d4_hm_hour_total_title({ hour: String(hour).padStart(2,'0'), value: hourTotals[hour], unit: cfg.unit })}>
              <div class="w-full max-w-[16px] mx-auto">
                <div class="rounded-t transition-all duration-500" style="height: {Math.round((Math.abs(hourTotals[hour]) / maxHourTotal) * 28)}px; background: {hourTotals[hour] < 0 && metric === 'net' ? '#ef444480' : cfg.color2 + '40'}; min-height: 2px;"></div>
              </div>
            </div>
          {/each}
        </div>
      </div>
    </div>

    <!-- Legend -->
    <div class="flex items-center justify-center gap-3 pt-6 mt-2 border-t border-outline-variant/10 flex-wrap">
      <span class="text-[11px] font-semibold text-on-surface-variant/40 uppercase tracking-widest">{m.d4_hm_intensity()}</span>
      <div class="flex items-center gap-1.5">
        <div class="w-3 h-3 rounded border border-white/5" style="background: rgba(255,255,255,0.04)"></div>
        <div class="w-5 h-4 rounded" style="background: {cfg.color1}60"></div>
        <div class="w-5 h-4 rounded" style="background: {cfg.color2}80"></div>
        <div class="w-5 h-4 rounded" style="background: {cfg.color2}cc"></div>
        <div class="w-5 h-4 rounded" style="background: {cfg.color3}dd"></div>
        <div class="w-5 h-5 rounded border" style="background: {cfg.colorPeak}; border-color: {cfg.colorPeak}"></div>
      </div>
      <div class="flex items-center gap-3 text-[11px] font-bold text-on-surface-variant/40">
        <span>{m.d4_hm_low()}</span>
        <span class="w-8 h-px bg-outline-variant/20"></span>
        <span>{m.d4_hm_high()}</span>
      </div>
      {#if peakCell.val !== 0}
        <div class="flex items-center gap-1.5 text-[11px] font-bold text-amber-400/70 border border-amber-400/20 px-2 py-1 rounded-lg">
          <div class="w-2 h-2 rounded-full border border-amber-400/60"></div>
          {metric === 'net' ? m.d4_hm_flux_peak() : m.d4_hm_activity_peak()}
        </div>
      {/if}
      {#if metric === 'net'}
        <div class="flex items-center gap-1.5 text-[11px] font-bold text-emerald-400/70 border border-emerald-400/20 px-2 py-1 rounded-lg">
          <div class="w-2 h-2 rounded" style="background: {metricConfig.net.color2}"></div>
          {m.d4_hm_net_gain()}
        </div>
        <div class="flex items-center gap-1.5 text-[11px] font-bold text-rose-400/70 border border-rose-400/20 px-2 py-1 rounded-lg">
          <div class="w-2 h-2 rounded bg-rose-500/80"></div>
          {m.d4_hm_net_loss()}
        </div>
      {/if}
    </div>
  </div>

  <!-- Hour breakdown -->
  <div class="premium-card p-6 md:p-8 rounded-xl space-y-4">
    <div class="flex items-center gap-3">
      <div class="bg-primary/10 p-2.5 rounded-xl text-primary">
        <Papicon icon="Clock" size={18} />
      </div>
      <div>
        <h4 class="text-base font-semibold text-on-surface">{m.d4_hm_breakdown_title()}</h4>
        <p class="text-[10px] font-bold text-on-surface-variant/40">{m.d4_hm_breakdown_subtitle()}</p>
      </div>
    </div>
    <div class="grid grid-cols-4 md:grid-cols-6 gap-2">
      {#each [
        { label: m.d4_hm_slot_night(), range: '00h–05h', hours: [0,1,2,3,4,5] },
        { label: m.d4_hm_slot_morning(), range: '06h–11h', hours: [6,7,8,9,10,11] },
        { label: m.d4_hm_slot_noon(), range: '12h–14h', hours: [12,13,14] },
        { label: m.d4_hm_slot_afternoon(), range: '15h–17h', hours: [15,16,17] },
        { label: m.d4_hm_slot_evening(), range: '18h–21h', hours: [18,19,20,21] },
        { label: m.d4_hm_slot_late_night(), range: '22h–23h', hours: [22,23] },
      ] as slot}
        {@const slotTotal = slot.hours.reduce((s, h) => s + hourTotals[h], 0)}
        {@const slotPct = totalValue > 0 ? Math.round((slotTotal / totalValue) * 100) : 0}
        <div class="bg-surface-container-high/20 rounded-lg p-4 border border-outline-variant/5 text-center space-y-2">
          <p class="text-[11px] font-semibold uppercase tracking-widest text-on-surface-variant/50">{slot.label}</p>
          <p class="text-[11px] text-on-surface-variant/30">{slot.range}</p>
          <p class="text-base font-semibold text-on-surface">{slotPct}%</p>
          <div class="h-1 bg-surface-container-high rounded-full overflow-hidden">
            <div class="h-full rounded-full" style="width: {slotPct}%; background: {cfg.color2}"></div>
          </div>
        </div>
      {/each}
    </div>
  </div>
</div>
