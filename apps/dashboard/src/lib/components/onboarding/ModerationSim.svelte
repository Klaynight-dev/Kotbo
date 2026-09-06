<script lang="ts">
  /**
   * Kotbo a l'oeuvre, dans un faux salon.
   *
   * L'ecran de moderation demandait de choisir entre « Souple », « Equilibre »
   * et « Strict » sur la foi de trois paragraphes. Personne ne sait ce que ces
   * mots recouvrent avant d'avoir vu un serveur tourner - et le jour ou on le
   * sait, on ne repasse plus par cet ecran.
   *
   * Ici, les memes messages traversent le salon, et c'est le reglage retenu qui
   * decide de leur sort. Changer de niveau rejoue la scene : on ne lit plus une
   * description, on voit la difference. C'est le seul endroit du parcours ou
   * l'ecart entre deux reponses se constate au lieu de se croire.
   *
   * Rien de choquant n'y passe. Un lien d'invitation, un mur de majuscules, une
   * rafale de mentions, un compte cree il y a une heure : c'est ce que la
   * moderation retire vraiment le plus souvent, et c'est lisible sans avoir a
   * censurer des insultes sur le premier ecran que voit un nouveau client.
   *
   * Les couleurs sont ecrites en dur, hors des jetons du tableau de bord : ce
   * cadre imite Discord, il ne suit pas le theme de Kotbo.
   */
  import { m } from '../../i18n';
  import type { ModerationLevel } from '../../onboarding';
  import Papicon from '../Papicon.svelte';

  const { level, autoplay = true }: { level: ModerationLevel; autoplay?: boolean } = $props();

  type Verdict = 'kept' | 'deleted' | 'held';

  type Line = {
    author: string;
    color: string;
    /** Initiale affichee a la place d'un avatar : aucun visage invente. */
    initial: string;
    text: string;
    /** Mention de compte trop recent, affichee sous le pseudo. */
    fresh?: boolean;
    /** Le sort du message, par niveau de moderation. */
    verdict: Record<ModerationLevel, Verdict>;
    reason: () => string;
  };

  const KEPT: Record<ModerationLevel, Verdict> = { light: 'kept', standard: 'kept', strict: 'kept' };

  const LINES: Line[] = [
    {
      author: 'Maë',
      color: '#3ba55d',
      initial: 'M',
      text: 'Quelqu’un a vu le dernier patch ? Ça a l’air énorme',
      verdict: KEPT,
      reason: () => m.onb_sim_passes(),
    },
    {
      author: 'promo_bot',
      color: '#faa61a',
      initial: 'P',
      text: 'REJOIGNEZ VITE discord.gg/xxxxxx 5000 MEMBRES 🔥🔥🔥',
      // Un lien d'invitation saute a tous les niveaux : c'est precisement ce que
      // « le strict necessaire » veut dire.
      verdict: { light: 'deleted', standard: 'deleted', strict: 'deleted' },
      reason: () => m.onb_sim_reason_invite(),
    },
    {
      author: 'Tom',
      color: '#5865f2',
      initial: 'T',
      text: 'perso je trouve ça bien équilibré cette fois',
      verdict: KEPT,
      reason: () => m.onb_sim_passes(),
    },
    {
      author: 'kkkkk',
      color: '#eb459e',
      initial: 'K',
      text: 'AAAAAAAA AAAAAAAA AAAAAAAA AAAAAAAA AAAAAAAA',
      verdict: { light: 'kept', standard: 'deleted', strict: 'deleted' },
      reason: () => m.onb_sim_reason_spam(),
    },
    {
      author: 'kkkkk',
      color: '#eb459e',
      initial: 'K',
      text: '@Maë @Tom @Léa @Sam @Noa @Ana @Jo @Max répondez',
      verdict: { light: 'kept', standard: 'deleted', strict: 'deleted' },
      reason: () => m.onb_sim_reason_flood(),
    },
    {
      author: 'user_84021',
      color: '#747f8d',
      initial: 'U',
      text: 'salut, je viens d’arriver',
      fresh: true,
      // Le seul cas ou « strict » se distingue : un compte de quelques heures
      // n'est pas fautif, il est simplement mis a l'ecart le temps d'un captcha.
      verdict: { light: 'kept', standard: 'kept', strict: 'held' },
      reason: () => m.onb_sim_reason_young(),
    },
  ];

  const CAPTIONS: Record<ModerationLevel, () => string> = {
    light: () => m.onb_sim_caption_light(),
    standard: () => m.onb_sim_caption_standard(),
    strict: () => m.onb_sim_caption_strict(),
  };

  /** Rythme du defile. Assez lent pour lire chaque message, assez court pour ne pas lasser. */
  const STEP_MS = 620;
  /** Delai entre l'apparition d'un message et le verdict de Kotbo. */
  const VERDICT_MS = 480;

  let shown = $state(0);
  let judged = $state(0);
  let playing = $state(false);

  const reduced =
    typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

  function play() {
    // Le reglage systeme demande d'arreter les animations, pas d'en cacher le
    // resultat : tout s'affiche d'un coup, deja juge.
    if (reduced) {
      shown = LINES.length;
      judged = LINES.length;
      playing = false;
      return;
    }
    shown = 0;
    judged = 0;
    playing = true;
  }

  // Les messages arrivent a leur rythme.
  $effect(() => {
    if (!playing || shown >= LINES.length) return;
    const timer = setTimeout(() => { shown += 1; }, STEP_MS);
    return () => clearTimeout(timer);
  });

  // Le verdict les suit avec un temps de retard : sans ce decalage, le message
  // apparaitrait deja barre et l'on ne verrait jamais Kotbo agir.
  $effect(() => {
    if (!playing || judged >= shown) return;
    const timer = setTimeout(() => { judged += 1; }, VERDICT_MS);
    return () => clearTimeout(timer);
  });

  // La scene est finie quand tout est affiche et tout est juge. `playing`
  // retombe dans un minuteur et non dans le corps de l'effet : l'ecrire ici
  // relancerait l'effet, qui le lit.
  $effect(() => {
    if (!playing || shown < LINES.length || judged < LINES.length) return;
    const timer = setTimeout(() => { playing = false; }, 0);
    return () => clearTimeout(timer);
  });

  // Changer de niveau rejoue la scene : c'est la comparaison qui a de la valeur,
  // pas la scene elle-meme.
  $effect(() => {
    void level;
    if (autoplay) play();
  });
</script>

<div class="rounded-xl overflow-hidden border border-black/25 shadow-sm">
  <div class="flex items-center justify-between gap-2 px-3.5 py-2.5 bg-[#2b2d31] border-b border-black/25">
    <span class="flex items-center gap-2 min-w-0">
      <span class="text-[#80848e] text-[17px] leading-none font-medium">#</span>
      <span class="text-[13px] font-semibold text-[#dbdee1] truncate">général</span>
    </span>
    <button
      type="button"
      onclick={play}
      class="shrink-0 inline-flex items-center gap-1 text-[11px] font-medium text-[#949ba4] hover:text-[#dbdee1] transition-colors"
    >
      <Papicon icon="refresh-cw" size={11} />
      {m.onb_sim_replay()}
    </button>
  </div>

  <div class="bg-[#313338] px-3.5 py-3 space-y-2.5 min-h-[260px]" aria-live="polite">
    {#each LINES.slice(0, shown) as line, index (index)}
      {@const verdict = index < judged ? line.verdict[level] : 'kept'}
      <div class="line flex gap-2.5">
        <span
          class="w-7 h-7 rounded-full shrink-0 flex items-center justify-center text-[11px] font-bold text-white"
          style="background-color: {line.color}"
        >
          {line.initial}
        </span>

        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5 flex-wrap">
            <span class="text-[13.5px] font-medium text-[#f2f3f5]">{line.author}</span>
            {#if line.fresh}
              <span class="text-[9.5px] font-semibold uppercase tracking-wide px-1 py-px rounded bg-[#4e5058] text-[#dbdee1]">
                nouveau
              </span>
            {/if}
          </div>

          <p
            class="text-[13.5px] leading-[1.4] break-words transition-all duration-300
            {verdict === 'kept' ? 'text-[#dbdee1]' : 'text-[#72767d] line-through decoration-[#f23f43]/60'}"
          >
            {line.text}
          </p>

          {#if verdict !== 'kept'}
            <p class="verdict mt-1 inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium
              {verdict === 'deleted' ? 'bg-[#f23f43]/15 text-[#f77f81]' : 'bg-[#faa61a]/15 text-[#f0b232]'}">
              <Papicon icon={verdict === 'deleted' ? 'trash' : 'clock'} size={10} />
              {verdict === 'deleted' ? m.onb_sim_deleted_by() : m.onb_sim_held()}
              <span class="text-[#949ba4]">· {line.reason()}</span>
            </p>
          {/if}
        </div>
      </div>
    {/each}

    {#if shown === 0}
      <p class="text-[12.5px] text-[#949ba4] py-6 text-center">{m.onb_sim_title()}…</p>
    {/if}
  </div>
</div>

<p class="mt-2.5 text-[12.5px] leading-relaxed text-on-surface-variant/60">
  {CAPTIONS[level]()}
</p>

<style>
  .line {
    animation: appear 240ms ease-out both;
  }

  .verdict {
    animation: appear 200ms ease-out both;
  }

  @keyframes appear {
    from { opacity: 0; transform: translateY(5px); }
    to { opacity: 1; transform: none; }
  }

  @media (prefers-reduced-motion: reduce) {
    .line, .verdict { animation: none; }
  }
</style>
