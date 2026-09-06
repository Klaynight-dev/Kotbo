/**
 * giftService.ts
 *
 * Offrir Kotbo à un serveur.
 *
 * Un cadeau n'est pas un abonnement, et c'est toute la raison d'être de ce
 * fichier : pas de reconduction, pas de carte enregistrée chez le bénéficiaire,
 * pas de portail de résiliation. Un paiement unique (ou un geste commercial)
 * ouvre une offre pour une durée fixe, puis le serveur retombe sur `FREE` de
 * lui-même quand la période s'achève - le cron `access-lifecycle` s'en charge,
 * exactement comme pour un essai.
 *
 * Trois portes d'entrée, une seule sortie :
 *
 *   - `createGiftCheckout`  : achat en ligne, avec ou sans serveur destinataire.
 *   - `applyGiftPayment`    : Stripe confirme l'encaissement (webhook).
 *   - `grantAdminGift`      : geste commercial posé depuis l'administration.
 *
 * Toutes finissent dans `applyGiftToGuild`, qui est le seul endroit à savoir
 * *comment* un cadeau se traduit en droits : activation si besoin, offre posée
 * par `planService`, durée posée par `accessService`. Aucune de ces couches
 * n'est court-circuitée, et les colonnes `stripeSubscription*` du serveur ne
 * sont jamais touchées : un cadeau ne doit pas ressembler à un abonnement dont
 * le bénéficiaire chercherait la facture.
 */

import {
  comparePlans,
  getPlanDefinition,
  giftPriceCents,
  isGiftDuration,
  normalizePlanKey,
  planForMemberCount,
  type PlanKey,
} from '@kotbo/contracts';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getDashboardOrigin } from '../../api/shared/core.js';
import { checkoutConsent, getStripe } from './stripeService.js';
import { setGuildPlan } from '../system/planService.js';
import { extendAccess, getAccessStatus } from '../system/accessService.js';
import { activateGuild, isGuildActivated } from '../../utils/activation.js';
import type { Stripe } from './stripeService.js';

/** Provenance d'un cadeau. Voir le modèle `BillingGift` pour le détail. */
export type GiftSource = 'PURCHASE_CODE' | 'PURCHASE_DIRECT' | 'ADMIN';

/** Marqueur posé dans les métadonnées Stripe pour aiguiller le webhook. */
export const GIFT_METADATA_KIND = 'gift';

export interface GiftView {
  id: string;
  code: string | null;
  plan: PlanKey;
  planName: string;
  months: number;
  source: GiftSource;
  amountCents: number | null;
  purchasedById: string;
  targetGuildId: string | null;
  paidAt: string | null;
  redeemedByGuildId: string | null;
  redeemedAt: string | null;
  expiresAt: string | null;
  note: string | null;
  createdAt: string;
}

/**
 * Durée d'un cadeau en minutes, calculée sur le calendrier et non sur des mois
 * de trente jours : offrir « trois mois » le 31 janvier doit finir le 30 avril,
 * pas à une date décalée de deux jours dont personne ne comprendrait l'origine.
 */
export function monthsToMinutes(months: number, from: Date = new Date()): number {
  const end = new Date(from.getTime());
  end.setMonth(end.getMonth() + months);
  return Math.round((end.getTime() - from.getTime()) / 60_000);
}

/**
 * Code à transmettre au bénéficiaire. Alphabet sans les caractères qui se
 * confondent à l'oral ou à la lecture (O/0, I/1, S/5) : un code cadeau se
 * recopie souvent à la main depuis une capture d'écran.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ2346789';

function randomBlock(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Code unique. La collision est improbable (30^8) mais la boucle la traite
 * quand même : l'unicité est portée par la colonne, autant ne pas rendre un
 * cadeau payé inutilisable pour un tirage malheureux.
 */
async function generateGiftCode(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = `GIFT-${randomBlock(4)}-${randomBlock(4)}`;
    const existing = await prisma.billingGift.findUnique({ where: { code }, select: { id: true } });
    if (!existing) return code;
  }
  throw new Error("Impossible de générer un code cadeau unique.");
}

export function toGiftView(gift: {
  id: string;
  code: string | null;
  plan: string;
  months: number;
  source: string;
  amountCents: number | null;
  purchasedById: string;
  targetGuildId: string | null;
  paidAt: Date | null;
  redeemedByGuildId: string | null;
  redeemedAt: Date | null;
  expiresAt: Date | null;
  note: string | null;
  createdAt: Date;
}): GiftView {
  const plan = normalizePlanKey(gift.plan);
  return {
    id: gift.id,
    code: gift.code,
    plan,
    planName: getPlanDefinition(plan).name,
    months: gift.months,
    source: gift.source as GiftSource,
    amountCents: gift.amountCents,
    purchasedById: gift.purchasedById,
    targetGuildId: gift.targetGuildId,
    paidAt: gift.paidAt?.toISOString() ?? null,
    redeemedByGuildId: gift.redeemedByGuildId,
    redeemedAt: gift.redeemedAt?.toISOString() ?? null,
    expiresAt: gift.expiresAt?.toISOString() ?? null,
    note: gift.note,
    createdAt: gift.createdAt.toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
// Application d'un cadeau à un serveur
// ─────────────────────────────────────────────────────────────

export interface GiftApplication {
  guildId: string;
  plan: PlanKey;
  months: number;
  /** Fin de la période offerte, ou `null` si le serveur a un accès permanent. */
  expiresAt: Date | null;
  /**
   * Vrai quand le serveur bénéficiait déjà d'un accès sans expiration : l'offre
   * est posée, mais aucune date n'est écrite. Dégrader un accès permanent en
   * accès à durée limitée serait une régression, pas un cadeau.
   */
  keptPermanentAccess: boolean;
}

/**
 * Traduit un cadeau en droits réels sur un serveur.
 *
 * Trois écritures, dans cet ordre, et chacune dans le service qui en a la
 * charge :
 *   1. activation, si le bot n'était pas encore activé - un cadeau doit rendre
 *      le serveur utilisable, pas seulement lui poser une étiquette ;
 *   2. l'offre, par `planService`, qui purge les caches de modules ;
 *   3. la durée, par `accessService`, qui alimente rappels et expiration.
 *
 * La durée s'ajoute au temps restant plutôt que de le remplacer : recevoir un
 * cadeau ne doit jamais faire perdre des jours déjà payés.
 */
async function applyGiftToGuild(
  guildId: string,
  plan: PlanKey,
  months: number,
  context: { reason: string },
): Promise<GiftApplication> {
  // Ici et non chez les trois appelants : c'est le seul point de passage
  // commun, et un cadeau applique sans trace serait un serveur payant sorti de
  // nulle part dans les statistiques. Pose avant l'application : l'origine
  // interesse meme si l'octroi echoue plus loin.
  //
  // Le montant n'est pas transmis : un cadeau est un revenu ponctuel, il
  // n'entre jamais dans le MRR, qui est recurrent par definition. Il est lu
  // depuis BillingGift au moment de l'agregation.
  const { trackAcquisitionStep } = await import('../analytics/acquisitionService.js');
  trackAcquisitionStep({
    step: 'gift_redeemed',
    guildId,
    metadata: { plan, months, reason: context.reason },
  });

  // `activateGuild` consomme un code : on lui en fabrique un, jamais diffusé,
  // plutôt que de réécrire à la main l'upsert, la diffusion inter-shards et la
  // cascade vers les serveurs staff qu'il porte déjà.
  if (!isGuildActivated(guildId)) {
    const minutes = monthsToMinutes(months);
    const internalCode = `GIFT-INTERNAL-${randomBlock(6)}`;
    await prisma.activationCode.create({
      data: {
        code: internalCode,
        createdById: 'billing.gift',
        isActive: true,
        accessType: 'SUBSCRIPTION',
        durationMinutes: minutes,
        label: context.reason,
      },
    });
    const activation = await activateGuild(guildId, internalCode);
    await setGuildPlan(guildId, plan, context.reason);
    return {
      guildId,
      plan,
      months,
      expiresAt: activation.expiresAt,
      keptPermanentAccess: false,
    };
  }

  await setGuildPlan(guildId, plan, context.reason);

  const current = await getAccessStatus(guildId);
  if (current?.accessType === 'PERMANENT') {
    logger.info('Billing', `Cadeau appliqué à ${guildId} sans date : accès déjà permanent.`);
    return { guildId, plan, months, expiresAt: null, keptPermanentAccess: true };
  }

  const status = await extendAccess(guildId, monthsToMinutes(months), { type: 'SUBSCRIPTION' });
  return {
    guildId,
    plan,
    months,
    expiresAt: status?.accessExpiresAt ?? null,
    keptPermanentAccess: false,
  };
}

// ─────────────────────────────────────────────────────────────
// Achat en ligne
// ─────────────────────────────────────────────────────────────

export interface GiftCheckoutOptions {
  plan: PlanKey;
  months: number;
  /** Compte Discord qui offre. */
  purchasedById: string;
  /** Serveur depuis lequel l'achat est lancé, pour la trace. */
  purchasedFromGuildId: string | null;
  /**
   * Serveur destinataire, ou `null` pour un cadeau à transmettre sous forme de
   * code. Le premier s'applique dès l'encaissement, le second attend son
   * activation par le bénéficiaire.
   */
  targetGuildId: string | null;
  note?: string | null;
}

/**
 * Ouvre le paiement d'un cadeau et renvoie l'URL Stripe.
 *
 * Le cadeau est enregistré **avant** l'appel à Stripe, sans date de paiement :
 * c'est cette ligne que le webhook retrouvera par `metadata.giftId`. Une ligne
 * sans `paidAt` n'ouvre aucun droit, un abandon de paiement ne coûte donc rien.
 *
 * Le montant est calculé ici, pas côté client : le prix affiché est indicatif
 * partout ailleurs, il devient contractuel au moment de débiter.
 */
export async function createGiftCheckout(
  options: GiftCheckoutOptions,
): Promise<{ url: string; giftId: string; amountCents: number }> {
  const stripe = getStripe();
  if (!stripe) throw new Error('Facturation Stripe non configurée.');

  const definition = getPlanDefinition(options.plan);
  if (!definition.selfServe) {
    throw new Error(`L'offre ${definition.name} ne peut pas être offerte en ligne.`);
  }
  if (!isGiftDuration(options.months)) {
    throw new Error('Durée de cadeau invalide.');
  }

  const amountCents = giftPriceCents(options.plan, options.months);
  if (!amountCents) throw new Error(`Aucun tarif public pour l'offre ${options.plan}.`);

  const gift = await prisma.billingGift.create({
    data: {
      plan: options.plan,
      months: options.months,
      purchasedById: options.purchasedById,
      purchasedFromGuildId: options.purchasedFromGuildId,
      targetGuildId: options.targetGuildId,
      source: options.targetGuildId ? 'PURCHASE_DIRECT' : 'PURCHASE_CODE',
      amountCents,
      note: options.note?.trim() || null,
    },
  });

  const dashboard = getDashboardOrigin();
  const metadata = {
    kind: GIFT_METADATA_KIND,
    giftId: gift.id,
    plan: options.plan,
    months: String(options.months),
    purchasedById: options.purchasedById,
    ...(options.targetGuildId ? { targetGuildId: options.targetGuildId } : {}),
  };

  try {
    const session = await stripe.checkout.sessions.create({
      // Paiement unique et non abonnement : rien ne se reconduit, il n'y a donc
      // rien à résilier ensuite pour le bénéficiaire comme pour l'acheteur.
      mode: 'payment',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'eur',
            // Prix construit à la volée : un cadeau n'a pas de `price_...`
            // préenregistré, et en créer un par couple offre/durée
            // multiplierait les variables d'environnement sans rien apporter.
            unit_amount: amountCents,
            // Les tarifs affichés par Kotbo sont TTC : la taxe est comprise
            // dans ce montant, elle ne s'y ajoute pas au moment de payer.
            tax_behavior: 'inclusive',
            product_data: {
              name: `Kotbo ${definition.name} - ${options.months} mois offerts`,
              description: options.targetGuildId
                ? `Offert au serveur ${options.targetGuildId}`
                : 'Code cadeau à transmettre au serveur de votre choix',
            },
          },
        },
      ],
      metadata,
      payment_intent_data: { metadata },
      // Sans client rattaché, Stripe n'a pas d'adresse : elle est obligatoire
      // pour la TVA, et le client créé au passage porte la facture de l'acheteur.
      customer_creation: 'always',
      billing_address_collection: 'required',
      automatic_tax: { enabled: true },
      allow_promotion_codes: true,
      // Acceptation des CGV et renonciation a la retractation. Le texte differe
      // de celui d'un abonnement : un cadeau ne se reconduit pas et n'ouvre pas
      // d'essai, faire signer l'inverse viderait la renonciation de sa valeur.
      ...checkoutConsent('GIFT'),
      success_url: `${dashboard}/billing?gift=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${dashboard}/billing?gift=cancelled`,
    });

    if (!session.url) throw new Error("Stripe n'a pas renvoyé d'URL de paiement.");

    await prisma.billingGift.update({
      where: { id: gift.id },
      data: { stripeSessionId: session.id },
    });

    logger.info(
      'Billing',
      `Cadeau ${gift.id} (${options.plan}, ${options.months} mois) mis en paiement par ${options.purchasedById}.`,
    );
    return { url: session.url, giftId: gift.id, amountCents };
  } catch (err) {
    // La session n'a pas été ouverte : la ligne en attente n'a plus de raison
    // d'exister et polluerait la liste des cadeaux de l'acheteur.
    await prisma.billingGift.delete({ where: { id: gift.id } }).catch(() => null);
    throw err;
  }
}

/**
 * Encaissement confirmé par Stripe. Renvoie le serveur concerné quand le cadeau
 * s'applique immédiatement, `null` quand il attend son code.
 *
 * Idempotent : un événement rejoué retrouve un cadeau déjà payé et s'arrête là,
 * sans re-créditer quoi que ce soit.
 */
export async function applyGiftPayment(session: Stripe.Checkout.Session): Promise<string | null> {
  const giftId = session.metadata?.giftId;
  if (!giftId) {
    logger.warn('Billing', `Session cadeau ${session.id} sans giftId dans les métadonnées.`);
    return null;
  }

  const gift = await prisma.billingGift.findUnique({ where: { id: giftId } });
  if (!gift) {
    logger.warn('Billing', `Cadeau ${giftId} introuvable pour la session ${session.id}.`);
    return null;
  }
  if (gift.paidAt) {
    logger.debug('Billing', `Cadeau ${giftId} déjà encaissé, événement ignoré.`);
    return gift.redeemedByGuildId ?? gift.targetGuildId;
  }

  const paidAt = new Date();
  const plan = normalizePlanKey(gift.plan);

  // Cadeau destiné à un serveur précis : il s'applique sans code, l'acheteur
  // n'a rien à transmettre.
  if (gift.targetGuildId) {
    const applied = await applyGiftToGuild(gift.targetGuildId, plan, gift.months, {
      reason: `cadeau ${gift.id} de ${gift.purchasedById}`,
    });
    await prisma.billingGift.update({
      where: { id: gift.id },
      data: {
        paidAt,
        redeemedByGuildId: gift.targetGuildId,
        redeemedById: gift.purchasedById,
        redeemedAt: paidAt,
        expiresAt: applied.expiresAt,
      },
    });
    logger.success('Billing', `Cadeau ${gift.id} appliqué à ${gift.targetGuildId} (${plan}, ${gift.months} mois).`);
    return gift.targetGuildId;
  }

  // Cadeau sans destinataire : le code n'est fabriqué qu'une fois l'argent
  // encaissé, pour qu'un code affiché soit toujours un code valable.
  const code = await generateGiftCode();
  await prisma.billingGift.update({ where: { id: gift.id }, data: { paidAt, code } });
  logger.success('Billing', `Cadeau ${gift.id} payé, code ${code} généré.`);
  return null;
}

/** Session de paiement abandonnée : la ligne en attente est effacée. */
export async function releaseGiftSession(sessionId: string): Promise<void> {
  await prisma.billingGift
    .deleteMany({ where: { stripeSessionId: sessionId, paidAt: null } })
    .catch(() => null);
}

// ─────────────────────────────────────────────────────────────
// Activation d'un code cadeau
// ─────────────────────────────────────────────────────────────

export type RedeemFailure =
  | 'unknown_code'
  | 'not_paid'
  | 'already_used'
  | 'guild_has_subscription'
  | 'plan_below_tier';

export type RedeemResult =
  | { ok: true; application: GiftApplication; gift: GiftView }
  | { ok: false; reason: RedeemFailure; requiredPlan?: PlanKey };

/**
 * Active un code cadeau sur un serveur.
 *
 * Deux refus méritent leur cas :
 *   - le serveur porte déjà un abonnement Stripe : empiler une période offerte
 *     sur un abonnement qui continue de prélever donnerait le sentiment d'avoir
 *     payé deux fois. Il faut d'abord résilier, le code reste valable ;
 *   - le code porte une offre inférieure au palier du serveur : les offres
 *     ayant les mêmes fonctionnalités, seul le nombre de membres les distingue,
 *     et un code Pro ne peut pas couvrir un serveur qui relève d'Ultimate. Un
 *     code *supérieur* passe en revanche sans discuter - l'acheteur a payé plus
 *     que nécessaire, ce n'est pas au bénéficiaire d'en faire les frais.
 */
export async function redeemGiftCode(
  rawCode: string,
  guildId: string,
  redeemedById: string,
  memberCount: number | null,
): Promise<RedeemResult> {
  const code = rawCode.trim().toUpperCase();
  const gift = await prisma.billingGift.findUnique({ where: { code } });

  if (!gift) return { ok: false, reason: 'unknown_code' };
  if (!gift.paidAt) return { ok: false, reason: 'not_paid' };
  if (gift.redeemedAt) return { ok: false, reason: 'already_used' };

  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { stripeSubscriptionId: true },
  });
  if (guild?.stripeSubscriptionId) return { ok: false, reason: 'guild_has_subscription' };

  const plan = normalizePlanKey(gift.plan);
  const requiredPlan = planForMemberCount(memberCount);
  if (comparePlans(plan, requiredPlan) < 0) {
    return { ok: false, reason: 'plan_below_tier', requiredPlan };
  }
  const application = await applyGiftToGuild(guildId, plan, gift.months, {
    reason: `code cadeau ${code}`,
  });

  // `updateMany` avec la condition « pas encore activé » : deux clics
  // simultanés sur le même code ne doivent pas créditer deux serveurs. Le
  // second ne trouve plus de ligne à mettre à jour.
  const claimed = await prisma.billingGift.updateMany({
    where: { id: gift.id, redeemedAt: null },
    data: {
      redeemedByGuildId: guildId,
      redeemedById,
      redeemedAt: new Date(),
      expiresAt: application.expiresAt,
    },
  });
  if (claimed.count === 0) return { ok: false, reason: 'already_used' };

  const updated = await prisma.billingGift.findUnique({ where: { id: gift.id } });
  logger.success('Billing', `Code cadeau ${code} activé sur ${guildId} (${plan}, ${gift.months} mois).`);
  return { ok: true, application, gift: toGiftView(updated ?? gift) };
}

// ─────────────────────────────────────────────────────────────
// Geste commercial (administration Kotbo)
// ─────────────────────────────────────────────────────────────

/**
 * Offre une période à un serveur sans aucun paiement : partenariat,
 * dédommagement, essai prolongé. Passe par le même chemin qu'un cadeau acheté,
 * pour que l'historique d'un serveur ne dépende pas de la façon dont il a
 * obtenu son offre.
 */
export async function grantAdminGift(options: {
  guildId: string;
  plan: PlanKey;
  months: number;
  actorId: string;
  note?: string | null;
}): Promise<{ application: GiftApplication; gift: GiftView }> {
  if (!isGiftDuration(options.months)) throw new Error('Durée de cadeau invalide.');

  const plan = normalizePlanKey(options.plan);
  if (plan === 'FREE') throw new Error("« Gratuit » n'est pas une offre que l'on peut offrir.");

  const application = await applyGiftToGuild(options.guildId, plan, options.months, {
    reason: `geste commercial de ${options.actorId}`,
  });

  const now = new Date();
  const gift = await prisma.billingGift.create({
    data: {
      plan,
      months: options.months,
      purchasedById: options.actorId,
      targetGuildId: options.guildId,
      source: 'ADMIN',
      // Ni montant ni date de paiement : rien n'a été encaissé. `paidAt` est
      // renseigné parce que le cadeau est bien honoré, ce qui évite qu'il
      // apparaisse comme « en attente de paiement » dans les listes.
      paidAt: now,
      redeemedByGuildId: options.guildId,
      redeemedById: options.actorId,
      redeemedAt: now,
      expiresAt: application.expiresAt,
      note: options.note?.trim() || null,
    },
  });

  return { application, gift: toGiftView(gift) };
}

// ─────────────────────────────────────────────────────────────
// Lectures
// ─────────────────────────────────────────────────────────────

/** Cadeaux offerts par un compte, les plus récents d'abord. */
export async function listGiftsPurchasedBy(userId: string, limit = 25): Promise<GiftView[]> {
  const rows = await prisma.billingGift.findMany({
    where: { purchasedById: userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  return rows.map(toGiftView);
}

/** Cadeaux reçus par un serveur, les plus récents d'abord. */
export async function listGiftsForGuild(guildId: string, limit = 25): Promise<GiftView[]> {
  const rows = await prisma.billingGift.findMany({
    where: { redeemedByGuildId: guildId },
    orderBy: { redeemedAt: 'desc' },
    take: limit,
  });
  return rows.map(toGiftView);
}
