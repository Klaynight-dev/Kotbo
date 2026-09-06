<script lang="ts">
  /**
   * La mise en service.
   *
   * Le recapitulatif vient de dire ce qui a ete construit ; cet ecran ne fait
   * plus que proposer d'ouvrir le pilotage. Il n'a donc plus a rejouer la liste
   * des reglages - c'etait le doublon qui rendait l'ancien dernier ecran long
   * et froid a la fois.
   *
   * Le paiement passe par Stripe, et par lui seul : la page ouvre une session
   * et redirige, aucune donnee bancaire ne transite ici. L'essai est decide
   * cote serveur - le reclamer depuis le navigateur permettrait de le rejouer.
   */
  import { router } from 'tinro';
  import { authStore } from '../../../stores/auth.svelte';
  import { dashboardStore } from '../../../stores/dashboard.svelte';
  import { toast } from '../../../stores/toast.svelte';
  import { wizard } from '../../../stores/onboardingWizard.svelte';
  import { onboardingData } from '../../../stores/onboardingData.svelte';
  import { completeOnboarding, startCheckout } from '../../../api';
  import KotboMark from '../KotboMark.svelte';
  import Papicon from '../../Papicon.svelte';
  import WizardShell from '../WizardShell.svelte';

  const { onEditTracks }: { onEditTracks: () => void } = $props();

  const billing = $derived(onboardingData.billing);
  const selectedGuild = $derived(
    authStore.guilds.find((guild) => guild.id === authStore.selectedGuildId)
  );
  const guildIconUrl = $derived(
    selectedGuild?.icon
      ? `https://cdn.discordapp.com/icons/${selectedGuild.id}/${selectedGuild.icon}.png?size=128`
      : null
  );

  /** L'offre proposee, deduite de ce que l'instance sait vendre. */
  const offer = $derived(
    billing?.plans.find((card) => card.purchasable && card.key !== 'FREE') ?? null
  );

  /**
   * Ce serveur a-t-il quelque chose a payer pour finir ?
   *
   * Le bot repond : instance sans facturation, ou acces deja accorde - offre
   * posee a la main, abonnement en cours, code de partenariat. Ces serveurs
   * traversent le parcours comme les autres, mais on ne leur reclame pas une
   * seconde fois ce qu'ils ont deja.
   */
  const canFinishWithoutPayment = $derived(
    dashboardStore.state.onboardingCanFinishWithoutPayment === true
  );

  const trialDays = $derived(billing?.trial.available ? billing.trial.days : 0);

  function formatPrice(cents: number): string {
    return (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
  }

  async function goToCheckout() {
    if (onboardingData.busy || !offer) return;
    onboardingData.busy = true;
    const url = await startCheckout(offer.key as 'PLUS' | 'PRO' | 'ULTIMATE', 'month');
    onboardingData.busy = false;
    if (!url) {
      toast.error("La page de paiement n'a pas pu être ouverte. Réessayez dans un instant.");
      return;
    }
    window.location.href = url;
  }

  /**
   * Sortie du parcours quand il n'y a rien a payer.
   *
   * La cloture s'ecrit sur le serveur, pas dans le navigateur : c'est elle qui
   * ouvre le tableau de bord, et c'est le bot qui verifie qu'elle est due. Sans
   * cet aller-retour, le parcours se rouvrirait au prochain chargement - et un
   * simple drapeau local aurait suffi a le sauter sur n'importe quel serveur.
   */
  async function finishWithoutBilling() {
    if (onboardingData.busy) return;
    onboardingData.busy = true;
    try {
      await completeOnboarding();
      wizard.complete('checkout');
      // Le drapeau `onboardingRequired` vient du bot : sans relecture, la page
      // resterait sur le parcours qu'on vient de clore.
      await dashboardStore.refresh();
      router.goto('/');
    } catch (err: any) {
      toast.error(err?.message || "La mise en service n'a pas pu être enregistrée.");
    } finally {
      onboardingData.busy = false;
    }
  }
</script>

<WizardShell
  title="Il ne reste qu'à ouvrir le pilotage."
  lead="Votre serveur tourne déjà. La mise en service vous donne le tableau de bord : statistiques, historiques, réglages fins."
  {onEditTracks}
>
  <div class="flex items-center gap-3.5 rounded-2xl border border-primary/35 bg-primary/[0.04] px-5 py-4 mb-5">
    {#if guildIconUrl}
      <img src={guildIconUrl} alt="" class="w-12 h-12 rounded-2xl object-cover shrink-0" />
    {:else}
      <div class="w-12 h-12 rounded-2xl bg-surface-container flex items-center justify-center text-base font-bold text-on-surface-variant/60 shrink-0">
        {(selectedGuild?.name ?? '?').slice(0, 1).toUpperCase()}
      </div>
    {/if}
    <div class="min-w-0">
      <p class="text-[15px] font-semibold text-on-surface truncate">{selectedGuild?.name ?? 'Votre serveur'}</p>
      <p class="text-[12.5px] text-on-surface-variant/60">Configuré avec Kotbo</p>
    </div>
    <KotboMark size={28} class="ml-auto shrink-0" />
  </div>

  {#if billing && !billing.enabled}
    <div class="rounded-2xl border border-outline-variant/30 bg-surface-container-low/40 p-5">
      <p class="text-sm font-semibold text-on-surface mb-1">Pas de facturation sur cette instance</p>
      <p class="text-[13px] text-on-surface-variant leading-relaxed">
        Cette installation de Kotbo n'a pas de clé Stripe : tous les modules suivent la
        configuration du serveur, sans offre commerciale.
      </p>
    </div>
  {:else if canFinishWithoutPayment}
    <div class="rounded-2xl border border-outline-variant/30 bg-surface-container-low/40 p-5">
      <p class="text-sm font-semibold text-on-surface mb-1">Votre accès est déjà ouvert</p>
      <p class="text-[13px] text-on-surface-variant leading-relaxed">
        Ce serveur dispose déjà de son accès à Kotbo : il n'y a rien à régler ici. La
        configuration que vous venez de poser s'applique dès maintenant.
      </p>
    </div>
  {:else if offer}
    <div class="rounded-2xl border border-outline-variant/35 bg-surface-container-low/40 p-5">
      <div class="flex items-baseline justify-between gap-4 mb-2">
        <p class="text-sm font-semibold text-on-surface">{offer.name}</p>
        {#if offer.priceCents}
          <p class="text-lg font-bold tracking-tight text-on-surface">
            {formatPrice(offer.priceCents.month)}<span class="text-[13px] font-medium text-on-surface-variant/60">/mois</span>
          </p>
        {/if}
      </div>
      <p class="text-[13px] text-on-surface-variant leading-relaxed">
        {offer.description}
      </p>
      {#if trialDays > 0}
        <p class="mt-3 flex items-start gap-2 text-[13px] font-medium text-emerald-500">
          <Papicon icon="gift" size={14} class="mt-0.5 shrink-0" />
          <span>
            {trialDays} jours d'essai gratuit - vous ne serez débité qu'après, et vous pouvez
            arrêter avant.
          </span>
        </p>
      {/if}
      <p class="mt-3 flex items-start gap-2 text-[12px] text-on-surface-variant/55 leading-relaxed">
        <Papicon icon="lock" size={12} class="mt-0.5 shrink-0" />
        <span>
          Le paiement se déroule entièrement sur Stripe : aucune donnée bancaire ne passe
          par Kotbo.
        </span>
      </p>
    </div>
  {/if}

  {#snippet footer()}
    {#if offer && !canFinishWithoutPayment}
      <button
        type="button"
        onclick={goToCheckout}
        disabled={onboardingData.busy}
        class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
      >
        {onboardingData.busy ? 'Ouverture…' : trialDays > 0 ? `Démarrer l'essai de ${trialDays} jours` : 'Mettre en service'}
        <Papicon icon="ChevronRight" size={15} />
      </button>
    {:else}
      <button
        type="button"
        onclick={finishWithoutBilling}
        disabled={onboardingData.busy}
        class="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-primary text-on-primary text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-40"
      >
        Accéder au tableau de bord
        <Papicon icon="ChevronRight" size={15} />
      </button>
    {/if}
  {/snippet}
</WizardShell>
