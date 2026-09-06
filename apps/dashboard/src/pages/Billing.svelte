<script lang="ts">
  /**
   * Facturation du serveur.
   *
   * La page ne manipule ni carte bancaire ni montant : elle affiche l'offre en
   * cours, propose les offres supérieures, et redirige vers des pages hébergées
   * par Stripe pour tout le reste. C'est ce qui nous tient hors du périmètre PCI
   * et évite de réimplémenter un formulaire de paiement.
   *
   * Deux états méritent un traitement à part, parce qu'ils arrivent vraiment :
   *   - `enabled: false` - l'instance n'a pas de clé Stripe (auto-hébergé,
   *     white-label). Afficher des boutons qui renverraient 503 serait pire que
   *     de dire clairement que la facturation n'est pas branchée ici.
   *   - `past_due` - le prélèvement a échoué mais l'accès court encore. Le
   *     bandeau doit être visible sans être bloquant : le client a quelques
   *     jours pour corriger sa carte avant la coupure.
   */
  import { onMount } from 'svelte';
  import { fetchBillingStatus, openBillingPortal, startCheckout } from '../lib/api';
  import type { BillingInterval, BillingStatus, PlanCard, PlanKey } from '../lib/api/billing';
  import { toast } from '../lib/stores/toast.svelte';
  import Papicon from '../lib/components/Papicon.svelte';

  let status = $state<BillingStatus | null>(null);
  let loading = $state(true);
  let interval = $state<BillingInterval>('month');
  /** Offre dont le bouton est en cours de traitement, pour ne pas figer toute la page. */
  let pending = $state<PlanKey | 'portal' | null>(null);

  const PLAN_ORDER: PlanKey[] = ['FREE', 'PLUS', 'PRO', 'ULTIMATE', 'CUSTOM'];

  const currentPlan = $derived(status?.plan ?? 'FREE');
  const orderedPlans = $derived(
    (status?.plans ?? []).slice().sort((a, b) => PLAN_ORDER.indexOf(a.key) - PLAN_ORDER.indexOf(b.key)),
  );

  /**
   * Économie annuelle affichée sur le sélecteur. La remise n'est pas la même
   * d'un palier à l'autre : on annonce donc la **plus faible**, qui est vraie
   * pour tout le monde. Prendre celle d'une offre en particulier promettrait
   * à certains serveurs une remise qu'ils ne verraient pas sur leur carte.
   */
  const yearlySavingPercent = $derived.by(() => {
    const savings = (status?.plans ?? [])
      .map((p) => p.priceCents)
      .filter((price): price is { month: number; year: number } => !!price && price.month > 0)
      .map((price) => Math.round((1 - price.year / (price.month * 12)) * 100));
    return savings.length > 0 ? Math.min(...savings) : 0;
  });

  function rank(plan: PlanKey): number {
    return PLAN_ORDER.indexOf(plan);
  }

  function formatPrice(cents: number): string {
    return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
  }

  function formatDate(iso: string | null): string {
    if (!iso) return '-';
    return new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  /**
   * Libellé du statut Stripe. On traduit plutôt que d'afficher `past_due` brut :
   * l'administrateur d'un serveur Discord n'a pas à connaître le vocabulaire
   * interne d'un prestataire de paiement.
   */
  const STATUS_LABELS: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' }> = {
    active: { label: 'Actif', tone: 'ok' },
    trialing: { label: "Période d'essai", tone: 'ok' },
    past_due: { label: 'Paiement en échec', tone: 'warn' },
    unpaid: { label: 'Impayé', tone: 'bad' },
    canceled: { label: 'Résilié', tone: 'bad' },
    incomplete: { label: 'Paiement incomplet', tone: 'warn' },
    incomplete_expired: { label: 'Paiement abandonné', tone: 'bad' },
    paused: { label: 'En pause', tone: 'warn' },
  };

  const statusInfo = $derived(status?.status ? STATUS_LABELS[status.status] ?? null : null);

  const trial = $derived(status?.trial ?? null);
  /** Vrai quand les boutons d'achat doivent annoncer l'essai plutôt que le prix. */
  const trialAvailable = $derived(Boolean(trial?.available));

  /**
   * Pourquoi l'essai n'est pas proposé. On l'explique au lieu de faire
   * disparaître la mention : un administrateur qui a lu « 15 jours offerts » sur
   * le site et ne voit rien ici doit comprendre d'où vient la différence.
   */
  const TRIAL_REASONS: Record<string, string> = {
    already_used_by_user: "Vous avez déjà utilisé votre essai gratuit sur un serveur. Il est offert une seule fois par compte Discord.",
    already_used_by_guild: "Ce serveur a déjà bénéficié de son essai gratuit.",
    guild_has_subscription: "Ce serveur est déjà abonné : le changement d'offre se fait au prorata depuis le portail Stripe.",
    plan_not_eligible: "Cette offre ne comporte pas d'essai gratuit.",
  };

  const trialReasonText = $derived(trial && !trial.available && trial.reason ? TRIAL_REASONS[trial.reason] ?? null : null);

  async function load() {
    loading = true;
    status = await fetchBillingStatus();
    loading = false;
  }

  async function subscribe(plan: PlanKey) {
    if (plan === 'FREE' || plan === 'CUSTOM') return;
    pending = plan;
    const url = await startCheckout(plan, interval);
    pending = null;

    if (!url) {
      toast.error("Impossible d'ouvrir la page de paiement. Réessayez dans un instant.");
      return;
    }
    // Redirection dans l'onglet courant : Stripe nous renverra sur /billing.
    window.location.href = url;
  }

  async function manage() {
    pending = 'portal';
    const url = await openBillingPortal();
    pending = null;

    if (!url) {
      toast.error("Impossible d'ouvrir le portail de facturation.");
      return;
    }
    window.location.href = url;
  }

  onMount(() => {
    // Retour de Stripe. Le webhook a peut-être quelques secondes de retard sur
    // la redirection : on recharge une seconde fois pour éviter d'afficher
    // l'ancienne offre à quelqu'un qui vient tout juste de payer.
    const params = new URLSearchParams(window.location.search);
    const checkout = params.get('checkout');

    if (checkout === 'success') {
      toast.success('Paiement accepté, merci ! Votre offre est en cours d\'activation.');
      setTimeout(load, 2500);
    } else if (checkout === 'cancelled') {
      toast.info('Paiement annulé, aucun montant n\'a été débité.');
    }

    if (checkout) window.history.replaceState({}, '', window.location.pathname);
    load();
  });
</script>

<div class="max-w-6xl mx-auto px-4 md:px-8 pb-24 space-y-6">
  <header class="pt-6 space-y-5">
    <div class="flex items-start gap-3 min-w-0">
      <div class="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
        <Papicon name="CreditCard" size={20} />
      </div>
      <div class="min-w-0">
        <h1 class="text-xl font-semibold text-on-surface tracking-tight leading-tight">Facturation</h1>
        <p class="text-[13px] text-on-surface-variant leading-relaxed max-w-xl">
          L'offre de ce serveur détermine les modules disponibles. Paiement et factures sont gérés par Stripe.
        </p>
      </div>
    </div>
  </header>

  {#if loading}
    <div class="space-y-3">
      {#each Array(3) as _}
        <div class="h-32 rounded-xl bg-surface-container-low/40 animate-pulse"></div>
      {/each}
    </div>
  {:else if !status}
    <div class="rounded-xl border border-outline-variant/40 bg-surface-container-low p-6 text-sm text-on-surface-variant">
      Impossible de charger l'état de facturation. Réessayez dans un instant.
    </div>
  {:else if !status.enabled}
    <div class="rounded-xl border border-outline-variant/40 bg-surface-container-low p-6 space-y-2">
      <h2 class="text-sm font-semibold text-on-surface">Facturation non activée sur cette instance</h2>
      <p class="text-[13px] text-on-surface-variant leading-relaxed max-w-2xl">
        Cette installation de Kotbo n'a pas de clé Stripe configurée : tous les modules suivent
        la configuration du serveur, sans offre commerciale. C'est le fonctionnement normal
        d'une instance auto-hébergée ou en marque blanche.
      </p>
    </div>
  {:else}
    <!-- ── Offre en cours ────────────────────────────────────────────────── -->
    <section class="rounded-xl border border-outline-variant/40 bg-surface-container-low p-5 space-y-4">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="space-y-1">
          <span class="text-[11px] uppercase tracking-wide text-on-surface-variant font-medium">Offre en cours</span>
          <div class="flex items-center gap-2.5">
            <h2 class="text-lg font-semibold text-on-surface">{status.planName}</h2>
            {#if statusInfo}
              <span
                class="px-2 py-0.5 rounded-md text-[11px] font-medium border {statusInfo.tone === 'ok'
                  ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
                  : statusInfo.tone === 'warn'
                    ? 'bg-amber-500/10 text-amber-500 border-amber-500/20'
                    : 'bg-red-500/10 text-red-500 border-red-500/20'}"
              >
                {statusInfo.label}
              </span>
            {/if}
          </div>

          {#if status.currentPeriodEnd}
            <p class="text-[13px] text-on-surface-variant">
              {#if status.cancelAtPeriodEnd}
                Résiliation demandée - accès conservé jusqu'au {formatDate(status.currentPeriodEnd)}.
              {:else}
                Prochain renouvellement le {formatDate(status.currentPeriodEnd)}.
              {/if}
            </p>
          {/if}
        </div>

        {#if status.hasSubscription}
          <button
            onclick={manage}
            disabled={pending !== null}
            class="flex items-center gap-2 h-9 px-3 rounded-lg bg-primary/10 text-primary border border-primary/20 hover:bg-primary/15 transition-colors disabled:opacity-50 text-sm font-medium"
          >
            <Papicon name="Settings" size={16} />
            {pending === 'portal' ? 'Ouverture…' : 'Gérer mon abonnement'}
          </button>
        {/if}
      </div>

      {#if status.status === 'past_due'}
        <div class="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3 text-[13px] text-amber-600 dark:text-amber-400 leading-relaxed">
          Le dernier prélèvement a échoué. Votre serveur garde son accès pendant que Stripe
          réessaie, mais mettez à jour votre moyen de paiement pour éviter une coupure.
        </div>
      {/if}
    </section>

    <!-- ── Essai gratuit ─────────────────────────────────────────────────── -->
    {#if trial && trialAvailable}
      <div class="rounded-xl border border-primary/30 bg-primary/5 p-4 flex items-start gap-3">
        <div class="w-8 h-8 rounded-lg bg-primary/15 text-primary flex items-center justify-center shrink-0">
          <Papicon name="Gift" size={16} />
        </div>
        <div class="space-y-1 min-w-0">
          <h2 class="text-sm font-semibold text-on-surface">{trial.days} jours d'essai gratuit</h2>
          <p class="text-[13px] text-on-surface-variant leading-relaxed">
            Choisissez une offre ci-dessous : les {trial.days} premiers jours ne sont pas facturés. Une carte
            est demandée par Stripe mais n'est débitée qu'à la fin de l'essai, et vous pouvez résilier avant
            sans rien payer. L'essai est offert une fois par compte Discord.
          </p>
        </div>
      </div>
    {:else if trialReasonText}
      <p class="text-[12px] text-on-surface-variant/80 text-center">{trialReasonText}</p>
    {/if}

    <!-- ── Sélecteur de périodicité ──────────────────────────────────────── -->
    <div class="flex justify-center">
      <div class="flex gap-1 p-1 rounded-lg bg-surface-container-low border border-outline-variant/40">
        <button
          onclick={() => (interval = 'month')}
          class="px-4 h-8 rounded-md text-xs font-medium transition-colors {interval === 'month'
            ? 'bg-primary text-on-primary'
            : 'text-on-surface-variant hover:text-on-surface'}"
        >
          Mensuel
        </button>
        <button
          onclick={() => (interval = 'year')}
          class="px-4 h-8 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 {interval === 'year'
            ? 'bg-primary text-on-primary'
            : 'text-on-surface-variant hover:text-on-surface'}"
        >
          Annuel
          {#if yearlySavingPercent > 0}
            <span class="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-500 font-semibold">
              −{yearlySavingPercent}%
            </span>
          {/if}
        </button>
      </div>
    </div>

    <!-- ── Grille des offres ─────────────────────────────────────────────── -->
    <section class="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {#each orderedPlans as plan (plan.key)}
        {@const isCurrent = plan.key === currentPlan}
        {@const isUpgrade = rank(plan.key) > rank(currentPlan)}
        <article
          class="rounded-xl border p-5 flex flex-col gap-4 transition-colors {isCurrent
            ? 'border-primary/50 bg-primary/5'
            : 'border-outline-variant/40 bg-surface-container-low'}"
        >
          <div class="space-y-1.5">
            <div class="flex items-center justify-between gap-2">
              <h3 class="text-base font-semibold text-on-surface">{plan.name}</h3>
              {#if isCurrent}
                <span class="text-[10px] uppercase tracking-wide font-semibold px-2 py-0.5 rounded bg-primary/15 text-primary">
                  Actuel
                </span>
              {/if}
            </div>
            <p class="text-[13px] text-on-surface-variant leading-snug">{plan.tagline}</p>
          </div>

          <div class="min-h-[3rem]">
            {#if plan.priceCents}
              <div class="flex items-baseline gap-1">
                <span class="text-2xl font-semibold text-on-surface tracking-tight">
                  {formatPrice(interval === 'month' ? plan.priceCents.month : plan.priceCents.year)}
                </span>
                <span class="text-xs text-on-surface-variant">/{interval === 'month' ? 'mois' : 'an'}</span>
              </div>
              <p class="text-[11px] text-on-surface-variant/70 mt-0.5">
                TTC, par serveur Discord{#if trialAvailable && plan.purchasable}&nbsp;- après l'essai{/if}
              </p>
            {:else if plan.key === 'FREE'}
              <div class="text-2xl font-semibold text-on-surface tracking-tight">Gratuit</div>
            {:else}
              <div class="text-base font-semibold text-on-surface">Sur devis</div>
            {/if}
          </div>

          <p class="text-[12px] text-on-surface-variant leading-relaxed flex-1">{plan.description}</p>

          <div class="text-[12px] text-on-surface-variant flex items-center gap-1.5 pt-1 border-t border-outline-variant/30">
            <Papicon name="LayoutGrid" size={14} />
            {#if plan.memberRange}
              <span>
                {plan.memberRange.max === null
                  ? `Au-delà de ${plan.memberRange.min.toLocaleString('fr-FR')} membres`
                  : plan.memberRange.min === 0
                    ? `Jusqu'à ${plan.memberRange.max.toLocaleString('fr-FR')} membres`
                    : `De ${plan.memberRange.min.toLocaleString('fr-FR')} à ${plan.memberRange.max.toLocaleString('fr-FR')} membres`}
              </span>
            {:else}
              <span>Aucun module actif</span>
            {/if}
          </div>

          {#if isCurrent}
            <button disabled class="h-9 rounded-lg text-sm font-medium bg-surface-container text-on-surface-variant cursor-default">
              Votre offre
            </button>
          {:else if plan.key === 'CUSTOM'}
            <a
              href="https://kotbo.fr/contact"
              target="_blank"
              rel="noopener noreferrer"
              class="h-9 rounded-lg text-sm font-medium border border-outline-variant/40 text-on-surface hover:bg-surface-container transition-colors flex items-center justify-center"
            >
              Nous contacter
            </a>
          {:else if plan.purchasable && isUpgrade}
            <button
              onclick={() => subscribe(plan.key)}
              disabled={pending !== null}
              class="h-9 rounded-lg text-sm font-medium bg-primary text-on-primary hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {pending === plan.key
                ? 'Ouverture…'
                : trialAvailable
                  ? `Essayer ${plan.name} ${trial?.days} jours`
                  : `Passer à ${plan.name}`}
            </button>
          {:else if status.hasSubscription}
            <!-- Rétrograder ou changer d'offre en cours d'abonnement se fait
                 dans le portail Stripe, qui gère seul le prorata. -->
            <button
              onclick={manage}
              disabled={pending !== null}
              class="h-9 rounded-lg text-sm font-medium border border-outline-variant/40 text-on-surface-variant hover:bg-surface-container transition-colors disabled:opacity-50"
            >
              Changer d'offre
            </button>
          {:else}
            <!-- Aucun geste possible sur cette carte. Trois raisons très
                 différentes aboutissent ici, et « Indisponible » les confondait
                 toutes : un serveur sous accord sur mesure a déjà tout, une
                 offre inférieure n'est pas un achat, et un prix Stripe manquant
                 est une erreur de configuration de l'instance. -->
            <button disabled class="h-9 rounded-lg text-sm font-medium bg-surface-container text-on-surface-variant/50 cursor-default">
              {currentPlan === 'CUSTOM'
                ? 'Compris dans votre accord'
                : !isUpgrade
                  ? 'Offre inférieure'
                  : 'Bientôt disponible'}
            </button>
          {/if}
        </article>
      {/each}
    </section>

    <p class="text-[12px] text-on-surface-variant/70 text-center leading-relaxed max-w-2xl mx-auto">
      Paiement sécurisé par Stripe. Résiliable à tout moment depuis « Gérer mon abonnement » ;
      l'accès est conservé jusqu'à la fin de la période déjà réglée.{#if trialAvailable}{' '}
        Résilier pendant l'essai n'entraîne aucun prélèvement.{/if}
    </p>
  {/if}
</div>
