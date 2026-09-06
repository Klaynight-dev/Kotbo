<script lang="ts">
  /**
   * Un nombre qui monte jusqu'a sa valeur.
   *
   * Reserve au recapitulatif de montage : ailleurs, un chiffre anime est une
   * coquetterie qui retarde la lecture. Ici, il prolonge d'une seconde le
   * moment ou l'on decouvre ce qui vient d'etre pose, et c'est le seul endroit
   * du parcours ou l'on a envie de s'attarder sur un chiffre.
   */
  const { value, duration = 700 }: { value: number; duration?: number } = $props();

  let shown = $state(0);

  $effect(() => {
    const target = value;

    if (typeof window === 'undefined'
      || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      || target <= 0) {
      shown = target;
      return;
    }

    const startedAt = performance.now();
    let frame = requestAnimationFrame(function step(now: number) {
      const progress = Math.min(1, (now - startedAt) / duration);
      // Ralentit en arrivant : la valeur finale se pose au lieu de s'arreter net.
      shown = Math.round(target * (1 - Math.pow(1 - progress, 3)));
      if (progress < 1) frame = requestAnimationFrame(step);
    });

    return () => cancelAnimationFrame(frame);
  });
</script>

<span class="tabular-nums">{shown}</span>
