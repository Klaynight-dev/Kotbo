/**
 * billingAnalytics.ts
 *
 * Ce que Kotbo gagne réellement, et non ce qu'il devrait gagner.
 *
 * `PLAN_REGISTRY.displayPriceCents` sert à peindre la page tarifs ; s'en servir
 * pour calculer un chiffre d'affaires produirait un nombre faux dès qu'une
 * remise, une taxe, un prix négocié ou un remboursement entre en jeu. Ce module
 * recopie donc les factures Stripe telles qu'elles sont, et c'est de là que
 * sortent le MRR et l'encaissé.
 *
 * `BillingEvent` ne peut pas jouer ce rôle : elle garde les webhooks bruts
 * trois jours, le temps de servir de verrou d'idempotence. Ce n'est pas un
 * historique comptable, et sa purge quotidienne effacerait la seule trace des
 * montants.
 *
 * Comme le reste du tunnel, ce module n'échoue jamais bruyamment : une facture
 * non recopiée est un trou dans une courbe, pas une raison de faire échouer un
 * webhook portant un paiement déjà encaissé. Le cron `billing-invoice-sync` la
 * rattrapera.
 */

import { normalizePlanKey, type BillingInterval, type PlanKey } from '@kotbo/contracts';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { planForPriceId, type Stripe } from './stripeService.js';
import { trackAcquisitionStep } from '../analytics/acquisitionService.js';

/** Nombre de mois d'une période, pour ramener un abonnement annuel au mois. */
const MONTHS_PER_INTERVAL: Record<BillingInterval, number> = { month: 1, year: 12 };

/**
 * Revenu mensuel normalisé, en centimes.
 *
 * Un abonnement annuel de 49,99 € pèse 4,17 € par mois, pas 49,99 € : les
 * additionner tels quels ferait paraître un client annuel douze fois plus
 * rentable qu'il ne l'est, et le MRR bondirait puis s'effondrerait au rythme
 * des renouvellements plutôt que de décrire l'activité.
 *
 * Arrondi à l'entier : le centime perdu sur chaque ligne est sans effet à
 * l'échelle où ce chiffre se lit, et un MRR à décimales laisserait croire à une
 * précision qui n'existe pas.
 */
export function monthlyCents(totalCents: number, interval: BillingInterval | null | undefined): number {
  if (!Number.isFinite(totalCents) || totalCents <= 0) return 0;
  const months = MONTHS_PER_INTERVAL[interval ?? 'month'] ?? 1;
  return Math.round(totalCents / months);
}

/** Identifiant de l'abonnement qui a produit la facture, selon l'API courante. */
function subscriptionIdOf(invoice: Stripe.Invoice): string | null {
  const details = invoice.parent?.subscription_details?.subscription;
  if (typeof details === 'string') return details;
  return details?.id ?? null;
}

function customerIdOf(invoice: Stripe.Invoice): string | null {
  const customer = invoice.customer;
  if (typeof customer === 'string') return customer;
  return customer?.id ?? null;
}

/** Somme des remises et des taxes, que Stripe expose en tableaux. */
function sumAmounts(entries: Array<{ amount: number }> | null | undefined): number {
  if (!entries?.length) return 0;
  return entries.reduce((total, entry) => total + (entry.amount ?? 0), 0);
}

/** Offre et périodicité facturées, lues sur le prix de la première ligne. */
function planOf(invoice: Stripe.Invoice): { plan: PlanKey; interval: BillingInterval | null } {
  for (const line of invoice.lines?.data ?? []) {
    const price = line.pricing?.price_details?.price;
    const priceId = typeof price === 'string' ? price : null;
    const resolved = priceId ? planForPriceId(priceId) : null;
    if (resolved) return resolved;
  }
  return { plan: 'FREE', interval: null };
}

/**
 * Rattache une facture à un serveur.
 *
 * Trois chemins parce que chacun manque dans certains cas : les métadonnées de
 * l'abonnement ne sont pas recopiées sur toutes les factures, et une facture
 * peut arriver avant que l'abonnement ne soit rattaché. Le client Stripe est le
 * dernier recours, et le plus fiable sur la durée : il ne change jamais.
 */
async function guildIdOf(invoice: Stripe.Invoice): Promise<string | null> {
  const fromMetadata = invoice.parent?.subscription_details?.metadata?.guildId;
  if (typeof fromMetadata === 'string' && fromMetadata) return fromMetadata;

  const subscriptionId = subscriptionIdOf(invoice);
  if (subscriptionId) {
    const row = await prisma.guild
      .findFirst({ where: { stripeSubscriptionId: subscriptionId }, select: { id: true } })
      .catch(() => null);
    if (row) return row.id;
  }

  const customerId = customerIdOf(invoice);
  if (customerId) {
    const row = await prisma.guild
      .findFirst({ where: { stripeCustomerId: customerId }, select: { id: true } })
      .catch(() => null);
    if (row) return row.id;
  }

  return null;
}

/**
 * Recopie une facture et enregistre l'étape correspondante.
 *
 * Idempotent par l'identifiant Stripe : un webhook rejoué ou une reprise qui
 * recouvre la période déjà couverte ne crée pas de doublon, et ne double donc
 * pas le chiffre d'affaires. C'est la propriété qui compte le plus ici -
 * `lifetimeCents` étant un cumul, une facture comptée deux fois resterait
 * fausse pour toujours.
 */
export async function recordInvoice(
  invoice: Stripe.Invoice,
  ingestedBy: 'webhook' | 'backfill' = 'webhook',
): Promise<void> {
  if (!invoice.id) return;

  try {
    const guildId = await guildIdOf(invoice);
    const { plan, interval } = planOf(invoice);
    const paidAt = invoice.status_transitions?.paid_at
      ? new Date(invoice.status_transitions.paid_at * 1000)
      : null;

    const data = {
      guildId,
      customerId: customerIdOf(invoice),
      subscriptionId: subscriptionIdOf(invoice),
      plan,
      interval,
      status: invoice.status ?? 'draft',
      currency: invoice.currency ?? 'eur',
      subtotalCents: invoice.subtotal ?? 0,
      discountCents: sumAmounts(invoice.total_discount_amounts),
      taxCents: sumAmounts(invoice.total_taxes),
      totalCents: invoice.total ?? 0,
      amountPaidCents: invoice.amount_paid ?? 0,
      // Stripe expose les remboursements sur le paiement, pas sur la facture :
      // la colonne existe pour la reprise, qui les lit ailleurs.
      amountRefundedCents: 0,
      periodStart: invoice.period_start ? new Date(invoice.period_start * 1000) : null,
      periodEnd: invoice.period_end ? new Date(invoice.period_end * 1000) : null,
      issuedAt: new Date((invoice.created ?? Date.now() / 1000) * 1000),
      paidAt,
      ingestedBy,
    };

    // `create` seul et non `upsert` sur les champs : une facture ne change plus
    // une fois payée, et écraser une ligne existante ferait perdre la trace de
    // ce qui a été observé en direct au profit d'une reprise plus tardive.
    const existing = await prisma.billingInvoice.findUnique({ where: { id: invoice.id } });
    if (existing) {
      // Sauf changement de statut : une facture ouverte qui devient payée doit
      // être mise à jour, sans quoi elle resterait un impayé éternel.
      if (existing.status !== data.status) {
        await prisma.billingInvoice.update({
          where: { id: invoice.id },
          data: { status: data.status, amountPaidCents: data.amountPaidCents, paidAt: data.paidAt },
        });
      }
      return;
    }

    await prisma.billingInvoice.create({ data: { id: invoice.id, ...data } });

    if (!guildId) {
      logger.warn('Billing', `Facture ${invoice.id} sans serveur rattaché : absente des statistiques par serveur.`);
      return;
    }

    if (data.status !== 'paid' || data.amountPaidCents <= 0) return;

    // Première facture payée du serveur ? La distinction fonde toutes les
    // cohortes : `first_payment` date l'entrée dans la clientèle payante,
    // `payment` ne fait qu'ajouter au cumul.
    const priorPaid = await prisma.billingInvoice.count({
      where: { guildId, status: 'paid', id: { not: invoice.id } },
    });

    trackAcquisitionStep({
      step: priorPaid === 0 ? 'first_payment' : 'payment',
      guildId,
      metadata: {
        amountCents: data.amountPaidCents,
        mrrCents: monthlyCents(data.totalCents, interval),
        plan,
        interval,
        invoiceId: invoice.id,
      },
      occurredAt: paidAt ?? undefined,
    });
  } catch (error) {
    logger.warn('Billing', `Facture ${invoice.id} non recopiée : ${String(error)}`);
  }
}

/** Échec de prélèvement : ni un churn ni un paiement, mais un signal de risque. */
export async function recordFailedInvoice(invoice: Stripe.Invoice): Promise<void> {
  await recordInvoice(invoice);
  try {
    const guildId = await guildIdOf(invoice);
    if (!guildId) return;
    trackAcquisitionStep({
      step: 'payment_failed',
      guildId,
      metadata: { amountCents: invoice.amount_due ?? 0, attempt: invoice.attempt_count ?? null },
    });
  } catch (error) {
    logger.warn('Billing', `Impayé de ${invoice.id} non enregistré : ${String(error)}`);
  }
}

/**
 * Compare l'état d'un abonnement à celui que la base connaissait, et en déduit
 * les étapes franchies.
 *
 * Stripe n'envoie pas « le client a résilié » ni « le client est monté en
 * offre » : il envoie `customer.subscription.updated` avec l'objet complet.
 * C'est donc à la comparaison de dire ce qui s'est passé - et c'est pour cela
 * que cette fonction doit être appelée **avant** que `syncSubscription`
 * n'écrase l'état précédent.
 */
export async function recordSubscriptionTransition(subscription: Stripe.Subscription): Promise<void> {
  try {
    const before = await prisma.guild.findFirst({
      where: { stripeSubscriptionId: subscription.id },
      select: { id: true, plan: true, stripeCancelAtPeriodEnd: true, stripeSubscriptionStatus: true },
    });
    if (!before) return;

    const guildId = before.id;
    const priceId = subscription.items.data[0]?.price?.id ?? null;
    const resolved = priceId ? planForPriceId(priceId) : null;
    const after = resolved?.plan ?? 'FREE';
    const interval = resolved?.interval ?? null;

    // Résiliation programmée, et son annulation. Deux étapes distinctes : un
    // client qui revient sur sa décision est le signal le plus utile qui soit
    // pour comprendre ce qui retient.
    const cancelling = subscription.cancel_at_period_end ?? false;
    if (cancelling && !before.stripeCancelAtPeriodEnd) {
      trackAcquisitionStep({ step: 'cancel_scheduled', guildId, metadata: { plan: after } });
    } else if (!cancelling && before.stripeCancelAtPeriodEnd) {
      trackAcquisitionStep({ step: 'cancel_reverted', guildId, metadata: { plan: after } });
    }

    if (subscription.status === 'canceled' && before.stripeSubscriptionStatus !== 'canceled') {
      trackAcquisitionStep({
        step: 'subscription_ended',
        guildId,
        // Un abonnement qui s'arrête sur impayé n'est pas un départ choisi :
        // les confondre ferait passer un problème de carte bancaire pour un
        // rejet du produit.
        metadata: {
          churnReason: before.stripeSubscriptionStatus === 'past_due' ? 'PAYMENT_FAILED' : 'VOLUNTARY',
        },
      });
      return;
    }

    if (subscription.status === 'trialing' && before.stripeSubscriptionStatus !== 'trialing') {
      trackAcquisitionStep({
        step: 'trial_started',
        guildId,
        metadata: {
          plan: after,
          interval,
          trialEndsAt: subscription.trial_end ? new Date(subscription.trial_end * 1000) : null,
        },
      });
    }

    if (subscription.status === 'active' && before.stripeSubscriptionStatus === 'trialing') {
      trackAcquisitionStep({ step: 'trial_converted', guildId, metadata: { plan: after, interval } });
    }

    const previous = normalizePlanKey(before.plan);
    if (after !== 'FREE' && previous !== 'FREE' && after !== previous) {
      const { comparePlans } = await import('@kotbo/contracts');
      trackAcquisitionStep({
        step: comparePlans(after, previous) > 0 ? 'plan_upgraded' : 'plan_downgraded',
        guildId,
        metadata: { plan: after, from: previous, interval },
      });
    }
  } catch (error) {
    logger.warn('Billing', `Transition de ${subscription.id} non enregistrée : ${String(error)}`);
  }
}
