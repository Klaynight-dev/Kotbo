/** Facturation Stripe : offre du serveur, souscription, portail client. */
import { authStore } from '../stores/auth.svelte';
import { dashboardRequest } from './client';

export type PlanKey = 'FREE' | 'PLUS' | 'PRO' | 'ULTIMATE' | 'CUSTOM';
export type BillingInterval = 'month' | 'year';

export interface PlanCard {
  key: PlanKey;
  name: string;
  tagline: string;
  description: string;
  /** Tranche de taille servie par l'offre, `null` pour `FREE`. */
  memberRange: { min: number; max: number | null } | null;
  priceCents: { month: number; year: number } | null;
  /** Faux quand l'offre ne se vend pas en ligne, ou qu'un prix Stripe manque. */
  purchasable: boolean;
}

/** Essai gratuit : disponible ou non, et pourquoi. */
export interface TrialInfo {
  available: boolean;
  /** Durée de l'essai en jours, décidée côté serveur (jamais écrite en dur ici). */
  days: number;
  reason: 'already_used_by_user' | 'already_used_by_guild' | 'guild_has_subscription' | 'plan_not_eligible' | null;
}

export interface BillingStatus {
  /** Faux si l'instance n'a pas de clé Stripe : la page l'annonce au lieu de proposer des boutons morts. */
  enabled: boolean;
  plan: PlanKey;
  planName: string;
  /** Statut Stripe brut (`active`, `past_due`, `canceled`…), null sans abonnement. */
  status: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  hasSubscription: boolean;
  /**
   * Dépend de l'administrateur connecté autant que du serveur : l'essai se
   * consomme une fois par compte Discord, deux administrateurs du même serveur
   * peuvent donc voir un bouton différent.
   */
  trial: TrialInfo;
  plans: PlanCard[];
}

export async function fetchBillingStatus(guildId = authStore.selectedGuildId ?? undefined): Promise<BillingStatus | null> {
  return dashboardRequest('/billing', { method: 'GET', guildId, errorContext: 'API Error (Billing):' });
}

/**
 * Ouvre une session de paiement et renvoie l'URL Stripe.
 *
 * L'appelant redirige lui-même : le paiement se déroule entièrement sur un
 * domaine Stripe, aucune donnée bancaire ne transite par le dashboard.
 *
 * L'essai gratuit n'est pas un paramètre : c'est le serveur qui décide s'il
 * l'accorde, à partir de la même règle que celle affichée par `trial`. Le
 * laisser au client permettrait de le réclamer en boucle.
 */
export async function startCheckout(
  plan: Exclude<PlanKey, 'FREE' | 'CUSTOM'>,
  interval: BillingInterval,
  guildId = authStore.selectedGuildId ?? undefined,
): Promise<string | null> {
  const result = await dashboardRequest('/billing/checkout', {
    method: 'POST',
    payload: { plan, interval },
    guildId,
    silent: true,
    errorContext: 'API Error (Checkout):',
  });
  return result?.url ?? null;
}

/** Portail Stripe : factures, moyen de paiement, changement d'offre, résiliation. */
export async function openBillingPortal(guildId = authStore.selectedGuildId ?? undefined): Promise<string | null> {
  const result = await dashboardRequest('/billing/portal', {
    method: 'POST',
    guildId,
    silent: true,
    errorContext: 'API Error (Portal):',
  });
  return result?.url ?? null;
}
