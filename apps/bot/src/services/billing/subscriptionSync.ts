/**
 * subscriptionSync.ts
 *
 * Traduit l'état d'un abonnement Stripe en état Kotbo.
 *
 * C'est le seul endroit qui décide « ce statut Stripe donne-t-il droit au
 * service ? ». Le webhook ne fait que lui passer un abonnement ; les commandes
 * de rattrapage aussi. Un seul chemin, donc un seul comportement à vérifier.
 *
 * Principe directeur : **Stripe fait foi**. On ne calcule jamais une date de fin
 * nous-mêmes, on recopie celle de l'abonnement. Un remboursement, un changement
 * d'offre au prorata, une prolongation manuelle depuis l'interface Stripe : tout
 * arrive ici sous forme d'un abonnement mis à jour, et l'état Kotbo suit sans
 * qu'on ait à modéliser la règle de gestion une seconde fois.
 */

import { normalizePlanKey, type PlanKey } from '@kotbo/contracts';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getClient } from '../../utils/client.js';
import { invalidatePlan } from '../system/planService.js';
import { grantAccess, minutesUntil } from '../system/accessService.js';
import { planForPriceId, type Stripe } from './stripeService.js';
import { confirmTrialStarted } from './trialService.js';

/**
 * Statuts Stripe qui ouvrent le service.
 *
 * `past_due` en fait partie volontairement : le premier prélèvement a échoué
 * mais Stripe va réessayer plusieurs jours. Couper immédiatement un serveur
 * pour une carte expirée serait une brutalité commerciale, et l'accès s'arrête
 * de toute façon à `accessExpiresAt` si les relances échouent toutes. Passé ce
 * délai Stripe bascule l'abonnement en `canceled` ou `unpaid`, qui ferment.
 */
const ENTITLING_STATUSES = new Set<Stripe.Subscription.Status>(['active', 'trialing', 'past_due']);

/**
 * Fin de la période payée.
 *
 * Depuis les versions d'API récentes, `current_period_end` ne vit plus sur
 * l'abonnement mais sur chacune de ses lignes. Un abonnement Kotbo n'ayant
 * qu'une ligne, on prend la plus lointaine : c'est correct aujourd'hui et le
 * resterait si une option facturée à part était ajoutée un jour.
 */
function periodEnd(subscription: Stripe.Subscription): Date | null {
  const timestamps = subscription.items.data
    .map((item) => item.current_period_end)
    .filter((value): value is number => typeof value === 'number');

  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps) * 1000);
}

/**
 * Offre correspondant à un abonnement, déduite du prix réellement souscrit.
 *
 * Les métadonnées ne servent que de filet : elles portent l'offre demandée au
 * moment du clic, mais un changement d'offre depuis le portail client Stripe ne
 * repasse pas par notre code et les laisse périmées. Le prix, lui, est toujours
 * à jour.
 */
function planForSubscription(subscription: Stripe.Subscription): PlanKey | null {
  for (const item of subscription.items.data) {
    const priceId = typeof item.price === 'string' ? item.price : item.price?.id;
    const match = priceId ? planForPriceId(priceId) : null;
    if (match) return match.plan;
  }

  const fromMetadata = subscription.metadata?.plan;
  if (fromMetadata) {
    logger.warn(
      'Billing',
      `Prix inconnu sur l'abonnement ${subscription.id} : repli sur l'offre ${fromMetadata} des métadonnées. ` +
        'Vérifier que les variables STRIPE_PRICE_* correspondent aux prix du compte Stripe.',
    );
    return normalizePlanKey(fromMetadata);
  }

  return null;
}

/** Serveur rattaché à un abonnement : métadonnées d'abord, puis la base. */
export async function guildIdForSubscription(subscription: Stripe.Subscription): Promise<string | null> {
  const fromMetadata = subscription.metadata?.guildId;
  if (fromMetadata) return fromMetadata;

  const row = await prisma.guild.findFirst({
    where: { stripeSubscriptionId: subscription.id },
    select: { id: true },
  });
  if (row) return row.id;

  // Dernier recours : le client Stripe porte lui aussi le serveur. Ce chemin
  // sert quand un abonnement a été créé à la main depuis l'interface Stripe.
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  if (!customerId) return null;

  const byCustomer = await prisma.guild.findFirst({
    where: { stripeCustomerId: customerId },
    select: { id: true },
  });
  return byCustomer?.id ?? null;
}

/**
 * Aligne l'état d'un serveur sur son abonnement Stripe.
 *
 * Idempotent : rejouer le même abonnement deux fois produit exactement le même
 * état. C'est ce qui rend sûrs les rejeux de webhook et la commande de
 * resynchronisation.
 */
export async function syncSubscription(subscription: Stripe.Subscription): Promise<void> {
  const guildId = await guildIdForSubscription(subscription);
  if (!guildId) {
    logger.error(
      'Billing',
      `Abonnement ${subscription.id} sans serveur rattaché : aucun accès accordé. ` +
        'Ajouter `guildId` dans les métadonnées de l\'abonnement pour le rattraper.',
    );
    return;
  }

  const entitled = ENTITLING_STATUSES.has(subscription.status);
  const plan = entitled ? (planForSubscription(subscription) ?? 'FREE') : 'FREE';
  const expiresAt = periodEnd(subscription);

  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  const priceId = subscription.items.data[0]?.price
    ? typeof subscription.items.data[0].price === 'string'
      ? subscription.items.data[0].price
      : subscription.items.data[0].price.id
    : null;

  await prisma.guild.upsert({
    where: { id: guildId },
    update: {
      plan,
      stripeCustomerId: customerId ?? undefined,
      stripeSubscriptionId: subscription.id,
      stripeSubscriptionStatus: subscription.status,
      stripePriceId: priceId,
      stripeCancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
      stripeCurrentPeriodEnd: expiresAt,
    },
    // Un paiement peut précéder toute configuration du serveur : la ligne
    // `Guild` est créée à la volée plutôt que de perdre l'abonnement.
    create: {
      id: guildId,
      plan,
      stripeCustomerId: customerId ?? null,
      stripeSubscriptionId: subscription.id,
      stripeSubscriptionStatus: subscription.status,
      stripePriceId: priceId,
      stripeCancelAtPeriodEnd: subscription.cancel_at_period_end ?? false,
      stripeCurrentPeriodEnd: expiresAt,
    },
  });

  // L'essai a réellement démarré : la réservation posée avant la redirection
  // devient un essai consommé, que l'expiration de la session de paiement ne
  // pourra plus libérer. Fait avant l'octroi d'accès, pour qu'un échec plus loin
  // ne rejoue pas un essai déjà servi.
  if (subscription.status === 'trialing') {
    const startedAt = subscription.trial_start ? new Date(subscription.trial_start * 1000) : new Date();
    await confirmTrialStarted(guildId, subscription.id, startedAt);
  }

  if (entitled && expiresAt) {
    // L'activation binaire historique est portée par `activateGuild` (codes) ;
    // un paiement doit produire le même résultat sans consommer de code.
    await prisma.guild.update({
      where: { id: guildId },
      data: { activated: true, activatedAt: new Date(), activatedViaStaffLink: false },
    });

    // `grantAccess` pose la date de fin et remet les rappels à zéro : le cron
    // `access-lifecycle` reprend la main pour prévenir et couper le moment venu.
    // On lui donne la durée jusqu'à la fin de période Stripe, pas 30 jours en
    // dur : un mois n'a pas toujours 30 jours, et un changement d'offre au
    // prorata décale l'échéance.
    await grantAccess(guildId, {
      // `TRIAL` pendant l'essai : les embeds de rappel et le message de fin ne
      // disent pas la même chose selon qu'on interrompt un essai ou un
      // abonnement payé.
      type: subscription.status === 'trialing' ? 'TRIAL' : 'SUBSCRIPTION',
      durationMinutes: Math.max(1, minutesUntil(expiresAt)),
    });

    const { activatedGuilds } = await import('../../utils/activation.js');
    activatedGuilds.add(guildId);

    // Le parcours de configuration s'arrete ici : sa derniere etape est la mise
    // en service, et elle vient d'avoir lieu. C'est la seule sortie qui ne
    // demande rien a personne - le dashboard s'ouvre au retour de Stripe, sans
    // qu'un drapeau de navigateur ait a s'en meler.
    //
    // Un echec n'interrompt pas la synchronisation : l'abonnement, lui, est
    // deja ecrit, `markOnboardingComplete` a journalise, et le rejeu du webhook
    // repassera par ici.
    const { markOnboardingComplete } = await import('../core/onboardingGate.js');
    await markOnboardingComplete(guildId, `abonnement ${subscription.id}`).catch(() => {});
  }

  await invalidatePlan(guildId);

  logger.info(
    'Billing',
    `Serveur ${guildId} synchronisé : offre ${plan}, statut ${subscription.status}` +
      (expiresAt ? `, période jusqu'au ${expiresAt.toISOString()}.` : '.'),
  );

  if (!entitled) await announceSubscriptionLost(guildId, subscription.status);
}

/**
 * Prévient le serveur que son abonnement ne le couvre plus.
 *
 * Distinct de l'expiration gérée par `accessService` : ici la période payée peut
 * encore courir sur le papier, mais Stripe a clos l'abonnement (résiliation
 * immédiate, impayé définitif). Sans ce message, le serveur constaterait la
 * fermeture de ses modules sans la moindre explication.
 */
async function announceSubscriptionLost(guildId: string, status: string): Promise<void> {
  try {
    const { announceAccessRevoked } = await import('../system/accessService.js');
    await announceAccessRevoked(getClient(), guildId);
    logger.info('Billing', `Perte d'abonnement annoncée à ${guildId} (statut ${status}).`);
  } catch (err) {
    // Le client Discord n'est pas toujours disponible (worker, démarrage) ;
    // l'état en base est déjà juste, seule la notification est perdue.
    logger.warn('Billing', `Impossible d'annoncer la perte d'abonnement à ${guildId}:`, err);
  }
}

/**
 * Purge les événements Stripe archivés.
 *
 * La table `billing_events` sert d'abord de verrou d'idempotence : sa valeur
 * s'arrête quand Stripe cesse de rejouer un événement, soit trois jours. La
 * rétention est fixée bien au-delà pour laisser le temps d'enquêter sur un
 * litige de paiement, mais pas au point de conserver indéfiniment des payloads
 * qui contiennent des données de facturation.
 *
 * Les lignes en erreur sont épargnées : ce sont précisément celles qu'on veut
 * pouvoir relire, et elles ne grossissent pas.
 */
const BILLING_EVENT_RETENTION_DAYS = 90;

export async function pruneOldBillingEvents(): Promise<void> {
  const cutoff = new Date(Date.now() - BILLING_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const { count } = await prisma.billingEvent.deleteMany({
    where: { receivedAt: { lt: cutoff }, error: null },
  });

  if (count > 0) logger.info('Billing', `${count} événement(s) Stripe purgé(s) (plus de ${BILLING_EVENT_RETENTION_DAYS} jours).`);
}
