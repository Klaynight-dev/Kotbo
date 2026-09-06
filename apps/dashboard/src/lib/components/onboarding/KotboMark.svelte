<script lang="ts">
  /**
   * Le logo, en grand.
   *
   * Il n'apparaissait nulle part dans le parcours - un favicon de sept pixels
   * dans un coin d'en-tete, et c'est tout. Or c'est ici, et seulement ici, que
   * le produit se presente : quelqu'un qui vient d'inviter le bot ne sait pas
   * encore a quoi ressemble ce qu'il installe.
   *
   * `halo` pose une lueur derriere la marque. Elle ne tourne ni ne clignote :
   * elle respire lentement, assez pour que l'ecran ne paraisse pas fige, pas
   * assez pour qu'on la regarde.
   */
  const {
    size = 64,
    halo = false,
    class: className = '',
  }: { size?: number; halo?: boolean; class?: string } = $props();
</script>

<span class="mark {className}" style="--mark-size: {size}px">
  {#if halo}
    <span class="halo" aria-hidden="true"></span>
  {/if}
  <img src="/favicon.svg" alt="Kotbo" width={size} height={size} class="relative block rounded-[22%]" />
</span>

<style>
  .mark {
    position: relative;
    display: inline-flex;
    width: var(--mark-size);
    height: var(--mark-size);
    flex: none;
  }

  .halo {
    position: absolute;
    inset: -35%;
    border-radius: 9999px;
    background: radial-gradient(circle, color-mix(in srgb, var(--primary-color) 45%, transparent) 0%, transparent 70%);
    animation: breathe 5s ease-in-out infinite;
  }

  @keyframes breathe {
    0%, 100% { opacity: 0.55; transform: scale(1); }
    50% { opacity: 0.9; transform: scale(1.12); }
  }

  /* Une lueur qui pulse est exactement ce que ce reglage systeme demande
     d'arreter : la marque reste, l'animation disparait. */
  @media (prefers-reduced-motion: reduce) {
    .halo { animation: none; }
  }
</style>
