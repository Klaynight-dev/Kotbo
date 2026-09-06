<script lang="ts">
  /**
   * Tuile de metrique de la console admin.
   *
   * Ajoute par rapport a `MetricCard` : variation chiffree, etincelle
   * d'historique et etat de chargement reel (squelette a la bonne taille, pour
   * que la grille ne saute pas quand les donnees arrivent).
   */
  import Papicon from '../Papicon.svelte';
  import AdminSparkline from './AdminSparkline.svelte';

  const {
    label,
    value,
    hint = '',
    icon = 'activity',
    tone = 'primary',
    delta = null,
    deltaSuffix = '',
    series = [],
    loading = false,
    href = '',
  }: {
    label: string;
    value: string | number;
    hint?: string;
    icon?: string;
    tone?: 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';
    /** Variation relative en pourcentage. Positif = hausse. */
    delta?: number | null;
    deltaSuffix?: string;
    series?: number[];
    loading?: boolean;
    href?: string;
  } = $props();

  const tones: Record<string, { chip: string; accent: string }> = {
    primary: { chip: 'bg-primary/12 text-primary', accent: 'var(--primary-color)' },
    success: { chip: 'bg-emerald-500/12 text-emerald-500', accent: '#10b981' },
    warning: { chip: 'bg-amber-500/12 text-amber-500', accent: '#f59e0b' },
    danger: { chip: 'bg-red-500/12 text-red-500', accent: '#ef4444' },
    info: { chip: 'bg-sky-500/12 text-sky-500', accent: '#0ea5e9' },
    neutral: { chip: 'bg-on-surface/8 text-on-surface-variant', accent: '#71717a' },
  };

  const toneConfig = $derived(tones[tone] ?? tones.primary);
  const deltaPositive = $derived(typeof delta === 'number' && delta > 0);
  const deltaNeutral = $derived(typeof delta === 'number' && Math.abs(delta) < 0.05);
</script>

<svelte:element
  this={href ? 'a' : 'div'}
  href={href || undefined}
  class="group relative rounded-2xl border border-outline-variant/25 bg-surface-container-lowest/70 p-4 flex flex-col gap-3 transition-colors
    {href ? 'hover:border-primary/40 hover:bg-surface-container-low/70 focus-visible:outline-2 focus-visible:outline-primary' : ''}"
>
  <div class="flex items-start justify-between gap-3">
    <div class="min-w-0">
      <p class="text-[11px] font-semibold uppercase tracking-wider text-on-surface-variant truncate">{label}</p>
      {#if loading}
        <div class="mt-2 h-8 w-24 rounded-lg bg-on-surface/8 animate-pulse"></div>
      {:else}
        <p class="text-[26px] leading-none font-semibold text-on-surface mt-2 tabular-nums truncate">{value}</p>
      {/if}
    </div>
    <div class="w-9 h-9 shrink-0 rounded-xl flex items-center justify-center {toneConfig.chip}">
      <Papicon {icon} size={17} />
    </div>
  </div>

  <div class="flex items-end justify-between gap-3 min-h-6">
    <div class="flex items-center gap-2 min-w-0">
      {#if typeof delta === 'number' && !loading}
        <span
          class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-semibold tabular-nums
            {deltaNeutral
              ? 'bg-on-surface/8 text-on-surface-variant'
              : deltaPositive
                ? 'bg-emerald-500/12 text-emerald-500'
                : 'bg-red-500/12 text-red-500'}"
        >
          {#if !deltaNeutral}
            <Papicon icon={deltaPositive ? 'ArrowUp' : 'ArrowDown'} size={10} />
          {/if}
          {Math.abs(delta).toFixed(1)}%{deltaSuffix}
        </span>
      {/if}
      {#if hint}
        <span class="text-[12px] text-on-surface-variant truncate">{hint}</span>
      {/if}
    </div>

    {#if series.length > 1}
      <AdminSparkline values={series} color={toneConfig.accent} width={72} height={22} />
    {/if}
  </div>
</svelte:element>
