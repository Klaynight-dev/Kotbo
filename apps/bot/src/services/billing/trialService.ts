/**
 * trialService.ts
 *
 * Essai gratuit de 15 jours, une seule fois.
 *
 * La règle commerciale tient en une phrase, mais elle a deux sujets : un essai
 * par **compte Discord**, et un essai par **serveur**. Les deux sont
 * nécessaires - la première fermeture seule laisserait un serveur enchaîner les
 * essais en faisant cliquer ses administrateurs à tour de rôle, la seconde
 * seule laisserait une personne créer un serveur neuf à chaque fois.
 *
 * L'essai passe par Stripe (`trial_period_days` sur la session de paiement) et
 * non par un accès posé à la main : Stripe demande une carte sans la débiter,
 * envoie lui-même le rappel de fin d'essai imposé en Europe, et bascule
 * l'abonnement en `active` au quinzième jour. Le webhook n'a rien de particulier
 * à faire - `trialing` fait déjà partie des statuts qui ouvrent le service, et
 * la fin d'essai arrive comme un simple `customer.subscription.updated`.
 *
 * Ce fichier ne porte donc que l'éligibilité et sa réservation ; le reste du
 * cycle de vie appartient à `subscriptionSync`.
 */

import { TRIAL_DAYS, planAllowsTrial, type BillingInterval, type PlanKey } from '@kotbo/contracts';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

export { TRIAL_DAYS };

/** Pourquoi l'essai n'est pas proposé. Traduit côté dashboard. */
export type TrialIneligibility =
  | 'already_used_by_user'
  | 'already_used_by_guild'
  | 'guild_has_subscription'
  | 'plan_not_eligible';

export interface TrialEligibility {
  /** Vrai si un essai peut être ouvert ici et maintenant. */
  eligible: boolean;
  days: number;
  reason?: TrialIneligibility;
}

/**
 * Le serveur `guildId` peut-il ouvrir un essai à l'initiative de `discordUserId` ?
 *
 * Purement consultatif : c'est l'unicité en base qui tranche vraiment, au
 * moment de `reserveTrial`. Cette fonction sert à peindre le bouton, et deux
 * clics simultanés ne peuvent donc pas la contourner.
 */
export async function checkTrialEligibility(
  guildId: string,
  discordUserId: string,
  plan: PlanKey,
): Promise<TrialEligibility> {
  if (!planAllowsTrial(plan)) return { eligible: false, days: TRIAL_DAYS, reason: 'plan_not_eligible' };

  // Un serveur déjà abonné n'a rien à essayer : le changement d'offre se fait
  // au prorata dans le portail Stripe, et y greffer un essai reviendrait à
  // offrir quinze jours à chaque montée d'offre.
  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { stripeSubscriptionId: true },
  });
  if (guild?.stripeSubscriptionId) {
    return { eligible: false, days: TRIAL_DAYS, reason: 'guild_has_subscription' };
  }

  const [byUser, byGuild] = await Promise.all([
    prisma.billingTrial.findUnique({ where: { discordUserId }, select: { discordUserId: true } }),
    prisma.billingTrial.findUnique({ where: { guildId }, select: { discordUserId: true } }),
  ]);

  if (byUser) return { eligible: false, days: TRIAL_DAYS, reason: 'already_used_by_user' };
  if (byGuild) return { eligible: false, days: TRIAL_DAYS, reason: 'already_used_by_guild' };

  return { eligible: true, days: TRIAL_DAYS };
}

/**
 * Réserve l'essai avant d'ouvrir la session de paiement.
 *
 * Posée **avant** l'appel à Stripe, et non après : entre les deux il y a un
 * aller-retour réseau, largement de quoi laisser passer un second clic. C'est
 * l'insertion qui fait le verrou - l'échec d'unicité (P2002) signifie « déjà
 * utilisé », et se traduit par un parcours d'achat sans essai plutôt que par
 * une erreur.
 *
 * Renvoie `true` si l'essai est réservé, `false` s'il était déjà consommé.
 */
export async function reserveTrial(
  guildId: string,
  discordUserId: string,
  plan: PlanKey,
  interval: BillingInterval,
): Promise<boolean> {
  try {
    await prisma.billingTrial.create({
      data: { discordUserId, guildId, plan, interval },
    });
    return true;
  } catch (err) {
    logger.debug('Billing', `Essai déjà consommé pour ${discordUserId} / ${guildId}.`, err);
    return false;
  }
}

/**
 * Rattache la réservation à la session de paiement qui vient d'être créée.
 *
 * Sans ce rattachement, une session abandonnée ne pourrait plus être retrouvée
 * et l'essai resterait consommé pour rien.
 */
export async function attachTrialSession(discordUserId: string, checkoutSessionId: string): Promise<void> {
  await prisma.billingTrial
    .update({ where: { discordUserId }, data: { checkoutSessionId } })
    .catch((err) => logger.warn('Billing', `Session ${checkoutSessionId} non rattachée à l'essai :`, err));
}

/**
 * Libère une réservation d'essai.
 *
 * Deux appelants : l'échec de création de la session côté Stripe, et
 * l'événement `checkout.session.expired` quand le client ferme l'onglet sans
 * payer. Dans les deux cas aucun essai n'a démarré - le retenir serait punir
 * quelqu'un qui a seulement regardé le prix.
 */
export async function releaseTrialReservation(where: { discordUserId?: string; checkoutSessionId?: string }): Promise<void> {
  const filter = where.discordUserId
    ? { discordUserId: where.discordUserId }
    : where.checkoutSessionId
      ? { checkoutSessionId: where.checkoutSessionId }
      : null;
  if (!filter) return;

  // `deleteMany` et non `delete` : la ligne peut ne pas exister (session sans
  // essai, réservation déjà confirmée), et ce n'est pas une erreur.
  const { count } = await prisma.billingTrial.deleteMany({
    // Une réservation confirmée ne se libère plus : l'essai a réellement
    // démarré, la session expirée qui traîne ne doit pas l'effacer.
    where: { ...filter, subscriptionId: null },
  });

  if (count > 0) logger.info('Billing', `Réservation d'essai libérée (${JSON.stringify(filter)}).`);
}

/**
 * Marque l'essai comme réellement démarré, une fois l'abonnement créé.
 *
 * C'est ce qui transforme une réservation en essai consommé : à partir d'ici,
 * la ligne ne peut plus être libérée, même si Stripe annonce plus tard
 * l'expiration de la session de paiement.
 */
export async function confirmTrialStarted(guildId: string, subscriptionId: string, startedAt: Date): Promise<void> {
  const { count } = await prisma.billingTrial.updateMany({
    where: { guildId, subscriptionId: null },
    data: { subscriptionId, startedAt },
  });

  if (count > 0) logger.info('Billing', `Essai de ${TRIAL_DAYS} jours démarré pour ${guildId} (${subscriptionId}).`);
}
