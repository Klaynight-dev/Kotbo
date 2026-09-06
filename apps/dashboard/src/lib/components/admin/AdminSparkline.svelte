<script lang="ts">
  /**
   * Micro-courbe SVG sans dependance.
   *
   * Chart.js est deja charge par le dashboard, mais instancier un graphique
   * complet par tuile de metrique coute cher pour dessiner une tendance de
   * 70 pixels de large.
   */
  const {
    values = [],
    color = 'currentColor',
    width = 72,
    height = 22,
    filled = true,
  }: {
    values: number[];
    color?: string;
    width?: number;
    height?: number;
    filled?: boolean;
  } = $props();

  const geometry = $derived.by(() => {
    if (values.length < 2) return null;

    const min = Math.min(...values);
    const max = Math.max(...values);
    // Une serie plate doit rendre une ligne mediane, pas une division par zero.
    const span = max - min || 1;
    const stepX = width / (values.length - 1);
    const padding = 1.5;
    const usableHeight = height - padding * 2;

    const points = values.map((value, index) => {
      const x = index * stepX;
      const y = padding + usableHeight - ((value - min) / span) * usableHeight;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    });

    return {
      line: `M${points.join(' L')}`,
      area: `M0,${height} L${points.join(' L')} L${width},${height} Z`,
    };
  });

  const gradientId = `spark-${Math.random().toString(36).slice(2, 9)}`;
</script>

{#if geometry}
  <svg
    {width}
    {height}
    viewBox="0 0 {width} {height}"
    class="shrink-0 overflow-visible"
    role="img"
    aria-label="Tendance récente"
  >
    {#if filled}
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color={color} stop-opacity="0.28" />
          <stop offset="100%" stop-color={color} stop-opacity="0" />
        </linearGradient>
      </defs>
      <path d={geometry.area} fill="url(#{gradientId})" />
    {/if}
    <path
      d={geometry.line}
      fill="none"
      stroke={color}
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
{/if}
