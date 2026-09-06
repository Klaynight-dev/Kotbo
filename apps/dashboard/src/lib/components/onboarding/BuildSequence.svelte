<script lang="ts">
  /**
   * Le montage du serveur, pendant qu'il a lieu.
   *
   * C'est le seul endroit du parcours ou Kotbo fait quelque chose de visible sur
   * Discord, et c'etait un bouton qui passait a « En cours… » puis a l'ecran
   * suivant. Le travail reel - une trentaine de roles, categories et salons
   * crees un par un - ne se voyait nulle part, et l'ecran d'apres annoncait des
   * chiffres qu'on n'avait pas vus arriver.
   *
   * Ici, chaque element s'affiche a mesure, dans l'ordre ou Discord le cree :
   * les roles d'abord, puis chaque categorie suivie de ses salons. Le compteur
   * suit. On regarde son serveur se construire, et c'est cette minute-la qui
   * donne envie de garder ce qu'on vient de voir apparaitre.
   *
   * L'animation ne devance jamais le serveur : tant que l'appel n'a pas rendu,
   * elle s'arrete avant le dernier element plutot que d'annoncer une pose qui
   * n'est pas finie. Une reponse qui tarde donne une attente honnete ; une
   * reponse rapide fait defiler le reste d'un coup.
   */
  import Papicon from '../Papicon.svelte';

  const {
    items,
    ready = false,
    onfinished,
  }: {
    items: { key: string; name: string; kind: string; mode?: 'create' | 'adopt' }[];
    /** Le serveur a rendu : l'animation peut aller jusqu'au bout. */
    ready?: boolean;
    onfinished?: () => void;
  } = $props();

  /** Rythme de croisiere : assez lent pour se lire, assez court pour ne pas lasser. */
  const CRUISE_MS = 90;
  /** Rythme de rattrapage, une fois le serveur revenu. */
  const CATCH_UP_MS = 22;

  let revealed = $state(0);
  let finished = $state(false);
  let list = $state<HTMLElement | null>(null);

  const total = $derived(items.length);
  /** Sans reponse du serveur, l'animation s'arrete a un element de la fin. */
  const ceiling = $derived(ready ? total : Math.max(0, total - 1));
  const shown = $derived(items.slice(0, revealed));

  const icons: Record<string, string> = {
    role: 'shield',
    category: 'folder',
    text: 'message-circle',
    voice: 'headphones',
  };

  $effect(() => {
    if (finished || revealed >= ceiling) return;

    const delay = ready ? CATCH_UP_MS : CRUISE_MS;
    const timer = setTimeout(() => { revealed += 1; }, delay);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (finished || !ready || revealed < total) return;

    // `finished` se pose dans le minuteur, jamais dans le corps de l'effet.
    // L'ecrire ici relancait l'effet - il lit `finished` -, et le nettoyage du
    // passage precedent annulait le minuteur avant qu'il ne tire : la sequence
    // s'arretait a 19/19 sans jamais rendre la main, et seul un rechargement
    // debloquait l'etape.
    //
    // Le temps d'arret, lui, reste : le dernier salon doit avoir eu le temps
    // d'apparaitre, sinon le recapitulatif le recouvre aussitot.
    const timer = setTimeout(() => {
      finished = true;
      onfinished?.();
    }, 450);
    return () => clearTimeout(timer);
  });

  // La liste grandit vers le bas : sans cela, ce qui vient d'etre pose sort du
  // cadre et l'on regarde une zone qui ne bouge plus.
  $effect(() => {
    void revealed;
    if (list) list.scrollTop = list.scrollHeight;
  });
</script>

<div class="rounded-2xl border border-primary/30 bg-primary/[0.03] overflow-hidden">
  <!-- Compteur -->
  <div class="px-5 pt-5 pb-4">
    <div class="flex items-baseline justify-between gap-4 mb-3">
      <p class="text-[13px] font-semibold text-on-surface">
        {finished ? 'Serveur monté.' : 'Kotbo monte votre serveur…'}
      </p>
      <p class="text-[13px] font-semibold tabular-nums text-primary">
        {revealed}<span class="text-on-surface-variant/45"> / {total}</span>
      </p>
    </div>

    <div class="h-1.5 rounded-full bg-outline-variant/25 overflow-hidden">
      <div
        class="h-full rounded-full bg-primary transition-[width] duration-200 ease-out"
        style="width: {total ? (revealed / total) * 100 : 0}%"
      ></div>
    </div>
  </div>

  <!-- Ce qui vient d'être posé -->
  <div
    bind:this={list}
    class="max-h-[240px] overflow-hidden px-5 pb-5 space-y-1.5"
    aria-live="polite"
  >
    {#each shown as item, index (item.key + index)}
      <div class="row flex items-center gap-2.5">
        <span class="w-5 h-5 shrink-0 rounded-md bg-primary/15 text-primary flex items-center justify-center">
          <Papicon icon={icons[item.kind] ?? 'circle'} size={11} />
        </span>
        <span class="text-[13px] text-on-surface-variant/85 truncate flex-1 min-w-0">{item.name}</span>
        {#if item.mode === 'adopt'}
          <!-- Il existait avant Kotbo : rien n'a ete cree, seul le branchement
               est nouveau. La coche verte de la creation mentirait. -->
          <span class="shrink-0 text-[11px] font-medium text-on-surface-variant/45">relié</span>
        {:else}
          <Papicon icon="check" size={12} class="shrink-0 text-emerald-500" />
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .row {
    animation: appear 220ms ease-out both;
  }

  @keyframes appear {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .row { animation: none; }
  }
</style>
