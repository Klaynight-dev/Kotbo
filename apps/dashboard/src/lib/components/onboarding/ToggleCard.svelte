<script lang="ts">
  /**
   * Une case a cocher qui a la taille de ce qu'elle engage.
   *
   * `ChoiceCard` repond a « laquelle ? » ; celle-ci repond a « lesquelles ? ».
   * La difference n'est pas qu'esthetique : une reponse unique se remplace,
   * une reponse multiple s'accumule, et l'on doit voir d'un coup d'oeil combien
   * de cases sont cochees sans les recompter une a une. D'ou la case elle-meme,
   * dessinee a gauche - une bordure et une teinte de fond ne suffisent pas a
   * dire « il y en a quatre ».
   *
   * Comme sa voisine, elle ne se distingue jamais par la seule couleur : la
   * case porte une coche, lisible pour qui distingue mal les teintes.
   */
  import type { Snippet } from 'svelte';
  import Papicon from '../Papicon.svelte';

  const {
    label,
    pitch,
    detail,
    icon,
    emoji,
    meta,
    selected = false,
    disabled = false,
    children,
    onclick,
  }: {
    label: string;
    pitch?: string;
    detail?: string;
    icon?: string;
    /** Prefere a `icon` quand l'element en porte un : un motif de ticket, un objet. */
    emoji?: string;
    /** Mention discrete a droite : un prix, une duree, un nombre d'ecrans. */
    meta?: string;
    selected?: boolean;
    disabled?: boolean;
    children?: Snippet;
    onclick: () => void;
  } = $props();
</script>

<button
  type="button"
  {onclick}
  {disabled}
  aria-pressed={selected}
  class="toggle group relative w-full text-left rounded-2xl border p-4 transition-all duration-200
         focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40
         disabled:opacity-45 disabled:cursor-not-allowed
         {selected
           ? 'border-primary bg-primary/[0.05] shadow-sm shadow-primary/10'
           : 'border-outline-variant/40 hover:border-primary/45 hover:bg-surface-container-low/50'}"
>
  <div class="flex items-start gap-3.5">
    <span
      class="box mt-0.5 w-[18px] h-[18px] shrink-0 rounded-[6px] border-[1.5px] flex items-center justify-center transition-colors
      {selected ? 'bg-primary border-primary text-on-primary' : 'border-outline-variant/60 text-transparent'}"
    >
      <Papicon icon="check" size={11} />
    </span>

    {#if emoji}
      <span class="text-[19px] leading-none mt-px shrink-0">{emoji}</span>
    {:else if icon}
      <span
        class="icon w-9 h-9 shrink-0 rounded-xl flex items-center justify-center transition-colors
        {selected ? 'bg-primary/15 text-primary' : 'bg-surface-container text-on-surface-variant/70'}"
      >
        <Papicon {icon} size={17} />
      </span>
    {/if}

    <div class="min-w-0 flex-1">
      <div class="flex items-baseline justify-between gap-3">
        <h3 class="text-[14.5px] font-semibold text-on-surface leading-tight">{label}</h3>
        {#if meta}
          <span class="text-[11px] font-medium tabular-nums text-on-surface-variant/40 shrink-0">{meta}</span>
        {/if}
      </div>

      {#if pitch}
        <p class="mt-0.5 text-[13px] font-medium text-on-surface-variant/70">{pitch}</p>
      {/if}
      {#if detail}
        <p class="mt-1.5 text-[12.5px] text-on-surface-variant/55 leading-relaxed">{detail}</p>
      {/if}
      {@render children?.()}
    </div>
  </div>
</button>

<style>
  .toggle:hover:not(:disabled) {
    transform: translateY(-1px);
  }

  .toggle:active:not(:disabled) {
    transform: translateY(0);
  }

  .toggle:hover:not(:disabled) .icon {
    transform: scale(1.06);
  }

  .icon {
    transition: transform 200ms ease-out, background-color 200ms, color 200ms;
  }

  /* La coche apparait d'un ressort court : sur un ecran de onze cases, c'est ce
     qui fait sentir qu'on en coche une plutot qu'on en subit l'etat. */
  .box {
    transition: background-color 160ms, border-color 160ms, color 120ms;
  }

  @media (prefers-reduced-motion: reduce) {
    .toggle:hover:not(:disabled) { transform: none; }
    .toggle:hover:not(:disabled) .icon { transform: none; }
  }
</style>
