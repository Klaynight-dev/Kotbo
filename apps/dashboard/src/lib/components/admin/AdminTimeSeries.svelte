<script lang="ts">
  /**
   * Courbe temporelle multi-series de la supervision.
   *
   * SVG rendu a la main plutot que Chart.js : les series de sante sont courtes
   * (quelques centaines de points), rafraichies toutes les 30 s, et on veut un
   * survol qui lit *toutes* les series a l'abscisse pointee - ce qui demandait
   * plus de configuration Chart.js que de code ici.
   */
  const {
    series = [],
    height = 190,
    formatValue = (value: number) => String(Math.round(value)),
    formatTime = (t: number) => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
    emptyLabel = 'Pas encore de données : la collecte démarre à la première consultation.',
  }: {
    series?: { key: string; label: string; color: string; points: { t: number; v: number }[] }[];
    height?: number;
    formatValue?: (value: number) => string;
    formatTime?: (t: number) => string;
    emptyLabel?: string;
  } = $props();

  const VIEW_WIDTH = 1000;
  const PADDING_Y = 10;

  let hoverIndex = $state<number | null>(null);
  let container = $state<HTMLDivElement | null>(null);

  const activeSeries = $derived(series.filter((s) => s.points.length > 1));
  const pointCount = $derived(activeSeries.length > 0 ? Math.max(...activeSeries.map((s) => s.points.length)) : 0);

  const bounds = $derived.by(() => {
    const values = activeSeries.flatMap((s) => s.points.map((p) => p.v));
    if (values.length === 0) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    // On force un plancher a zero pour les series positives : sinon une
    // variation de 2 % occupe toute la hauteur et se lit comme une panne.
    const low = min >= 0 && min < max * 0.35 ? 0 : min;
    return { min: low, max: max === low ? low + 1 : max };
  });

  function toPath(points: { t: number; v: number }[], area = false): string {
    if (!bounds || points.length < 2) return '';
    const stepX = VIEW_WIDTH / (points.length - 1);
    const usable = height - PADDING_Y * 2;
    const coords = points.map((point, index) => {
      const x = index * stepX;
      const ratio = (point.v - bounds.min) / (bounds.max - bounds.min);
      const y = PADDING_Y + usable - ratio * usable;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    if (!area) return `M${coords.join(' L')}`;
    return `M0,${height} L${coords.join(' L')} L${VIEW_WIDTH},${height} Z`;
  }

  function onPointerMove(event: PointerEvent) {
    if (!container || pointCount < 2) return;
    const rect = container.getBoundingClientRect();
    const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    hoverIndex = Math.round(ratio * (pointCount - 1));
  }

  const hoverTime = $derived.by(() => {
    if (hoverIndex === null) return null;
    const reference = activeSeries.find((s) => s.points[hoverIndex!]);
    return reference?.points[hoverIndex]?.t ?? null;
  });
</script>

{#if activeSeries.length === 0}
  <div class="flex items-center justify-center text-center px-6" style="height: {height}px">
    <p class="text-[13px] text-on-surface-variant max-w-sm">{emptyLabel}</p>
  </div>
{:else}
  <div class="space-y-3">
    <div
      bind:this={container}
      role="img"
      aria-label="Historique de supervision"
      class="relative"
      style="height: {height}px"
      onpointermove={onPointerMove}
      onpointerleave={() => (hoverIndex = null)}
    >
      <svg
        viewBox="0 0 {VIEW_WIDTH} {height}"
        preserveAspectRatio="none"
        class="w-full h-full overflow-visible"
      >
        <!-- Lignes de repere -->
        {#each [0, 0.25, 0.5, 0.75, 1] as ratio (ratio)}
          <line
            x1="0"
            x2={VIEW_WIDTH}
            y1={PADDING_Y + (height - PADDING_Y * 2) * ratio}
            y2={PADDING_Y + (height - PADDING_Y * 2) * ratio}
            stroke="currentColor"
            stroke-width="1"
            class="text-on-surface/8"
            vector-effect="non-scaling-stroke"
          />
        {/each}

        {#each activeSeries as line (line.key)}
          <defs>
            <linearGradient id="grad-{line.key}" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color={line.color} stop-opacity="0.22" />
              <stop offset="100%" stop-color={line.color} stop-opacity="0" />
            </linearGradient>
          </defs>
          <path d={toPath(line.points, true)} fill="url(#grad-{line.key})" />
          <path
            d={toPath(line.points)}
            fill="none"
            stroke={line.color}
            stroke-width="2"
            stroke-linejoin="round"
            stroke-linecap="round"
            vector-effect="non-scaling-stroke"
          />
        {/each}

        {#if hoverIndex !== null && pointCount > 1}
          {@const x = (hoverIndex / (pointCount - 1)) * VIEW_WIDTH}
          <line
            x1={x}
            x2={x}
            y1="0"
            y2={height}
            stroke="currentColor"
            stroke-width="1"
            class="text-on-surface/25"
            vector-effect="non-scaling-stroke"
          />
        {/if}
      </svg>

      {#if hoverIndex !== null && hoverTime !== null}
        <div
          class="pointer-events-none absolute top-1 rounded-xl border border-outline-variant/30 bg-surface-container-lowest/95 backdrop-blur px-3 py-2 shadow-lg text-[12px] min-w-36 z-10"
          style="left: clamp(0px, {(hoverIndex / Math.max(pointCount - 1, 1)) * 100}%, calc(100% - 9rem))"
        >
          <p class="font-semibold text-on-surface-variant mb-1 tabular-nums">{formatTime(hoverTime)}</p>
          {#each activeSeries as line (line.key)}
            {@const point = line.points[hoverIndex]}
            {#if point}
              <div class="flex items-center justify-between gap-3">
                <span class="flex items-center gap-1.5 text-on-surface-variant">
                  <span class="w-2 h-2 rounded-full" style="background: {line.color}"></span>
                  {line.label}
                </span>
                <span class="font-semibold text-on-surface tabular-nums">{formatValue(point.v)}</span>
              </div>
            {/if}
          {/each}
        </div>
      {/if}
    </div>

    <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
      {#each activeSeries as line (line.key)}
        <span class="inline-flex items-center gap-1.5 text-[12px] text-on-surface-variant">
          <span class="w-2.5 h-2.5 rounded-full" style="background: {line.color}"></span>
          {line.label}
        </span>
      {/each}
    </div>
  </div>
{/if}
