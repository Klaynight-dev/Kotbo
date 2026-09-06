<script lang="ts">
  /**
   * Une reponse possible, en grand.
   *
   * Le parcours ne pose qu'une question par ecran : ses reponses peuvent donc
   * occuper la place qu'il faut pour se lire sans effort, au lieu d'etre
   * ramassees dans une liste deroulante. La carte selectionnee se distingue par
   * sa bordure et sa pastille, jamais par la seule couleur de fond - elle doit
   * rester lisible pour qui distingue mal les teintes.
   *
   * Le survol souleve la carte d'un pixel et la selection fait respirer sa
   * pastille une fois. C'est peu, et c'est voulu : sur un ecran qui ne propose
   * que trois cartes, la moindre reponse du curseur suffit a donner le
   * sentiment de manipuler quelque chose plutot que de remplir un formulaire.
   */
  import Papicon from '../Papicon.svelte';

  const {
    label,
    pitch,
    detail,
    icon,
    selected = false,
    badge,
    onclick,
  }: {
    label: string;
    pitch?: string;
    detail?: string;
    icon?: string;
    selected?: boolean;
    /** Mention discrete en haut a droite : « Recommandé », par exemple. */
    badge?: string;
    onclick: () => void;
  } = $props();
</script>

<button
  type="button"
  {onclick}
  aria-pressed={selected}
  class="choice group relative w-full text-left rounded-2xl border p-5 transition-all duration-200
         focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40
         {selected
           ? 'border-primary bg-primary/[0.05] shadow-sm shadow-primary/10'
           : 'border-outline-variant/40 hover:border-primary/45 hover:bg-surface-container-low/50'}"
>
  {#if badge}
    <span class="absolute top-4 right-4 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full bg-primary/15 text-primary">
      {badge}
    </span>
  {/if}

  <div class="flex items-start gap-3.5">
    {#if icon}
      <div
        class="icon w-10 h-10 shrink-0 rounded-xl flex items-center justify-center transition-colors
        {selected ? 'bg-primary/15 text-primary' : 'bg-surface-container text-on-surface-variant/70'}"
      >
        <Papicon {icon} size={18} />
      </div>
    {/if}

    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2">
        <h2 class="text-[15px] font-semibold text-on-surface leading-tight">{label}</h2>
        {#if selected}
          <span class="tick w-4 h-4 shrink-0 rounded-full bg-primary text-on-primary flex items-center justify-center">
            <Papicon icon="check" size={10} />
          </span>
        {/if}
      </div>

      {#if pitch}
        <p class="mt-0.5 text-[13.5px] font-medium text-on-surface-variant/75">{pitch}</p>
      {/if}
      {#if detail}
        <p class="mt-2 text-[13px] text-on-surface-variant/60 leading-relaxed">{detail}</p>
      {/if}
    </div>
  </div>
</button>

<style>
  .choice:hover:not(:disabled) {
    transform: translateY(-1px);
  }

  .choice:active {
    transform: translateY(0);
  }

  .choice:hover .icon {
    transform: scale(1.06);
  }

  .icon {
    transition: transform 200ms ease-out, background-color 200ms, color 200ms;
  }

  /* Joue une seule fois, a l'apparition de la pastille : c'est une confirmation
     du clic, pas un element qui bouge en permanence sur la page. */
  .tick {
    animation: pop 260ms cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  @keyframes pop {
    from { transform: scale(0.2); opacity: 0; }
    to { transform: scale(1); opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .choice:hover:not(:disabled) { transform: none; }
    .choice:hover .icon { transform: none; }
    .tick { animation: none; }
  }
</style>
