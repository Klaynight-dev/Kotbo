/**
 * consentService.ts
 *
 * Conserver la preuve de ce que le client a accepté en payant.
 *
 * La case cochée sur la page Stripe porte deux choses à la fois : l'acceptation
 * des conditions générales de vente, et la renonciation expresse au droit de
 * rétractation sans laquelle Kotbo ne pourrait pas ouvrir les modules avant
 * quatorze jours (art. L221-25 et L221-28 du code de la consommation).
 *
 * Pourquoi une copie locale alors que Stripe garde la session : parce qu'une
 * renonciation ne vaut que si l'on peut la produire, des mois plus tard, face à
 * une réclamation. La session Stripe n'est pas un support dont nous soyons
 * maîtres - elle dépend d'un compte tiers, d'une rétention que nous ne fixons
 * pas, et elle ne dit rien de la version des CGV alors en vigueur. Un client
 * qui conteste en janvier ce qu'il a accepté en juin doit pouvoir se voir
 * opposer le texte exact qu'il a lu.
 *
 * Ce module n'échoue jamais bruyamment : un consentement non enregistré est un
 * problème d'archivage, pas une raison de faire échouer un webhook Stripe déjà
 * encaissé. Il est journalisé en avertissement, ce qui le rend rattrapable.
 */

import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { CGV_VERSION, type Stripe } from './stripeService.js';

/** Nature de l'achat. Le texte affiché au client diffère de l'un à l'autre. */
export type ConsentKind = 'SUBSCRIPTION' | 'GIFT';

/**
 * Enregistre le consentement porté par une session de paiement aboutie.
 *
 * Idempotent par construction : la clé primaire est l'identifiant de session
 * Stripe, si bien qu'un webhook rejoué ne crée pas un second enregistrement et
 * n'écrase pas le premier. C'est le premier passage qui fait foi - c'est lui
 * qui correspond au moment où la case a réellement été cochée.
 */
export async function recordBillingConsent(
  session: Stripe.Checkout.Session,
  kind: ConsentKind,
): Promise<void> {
  // `consent` est nul sur les sessions ouvertes avant la mise en place du
  // recueil, et sur celles qu'aucune case n'accompagne. On enregistre quand
  // même la ligne : savoir qu'une commande n'a pas de consentement attaché est
  // précisément l'information utile en cas de litige.
  const accepted = session.consent?.terms_of_service === 'accepted';
  const acceptedAt = accepted ? new Date((session.created ?? Date.now() / 1000) * 1000) : null;

  const metadata = session.metadata ?? {};
  const guildId = metadata.guildId ?? metadata.targetGuildId ?? session.client_reference_id ?? null;
  const discordUserId = metadata.initiatedBy ?? metadata.purchasedById ?? null;

  try {
    await prisma.billingConsent.upsert({
      where: { checkoutSessionId: session.id },
      // Rien à mettre à jour : un consentement ne se corrige pas après coup.
      // L'upsert sert uniquement à absorber le rejeu sans lever d'erreur.
      update: {},
      create: {
        checkoutSessionId: session.id,
        guildId,
        discordUserId,
        kind,
        documentVersion: CGV_VERSION,
        termsAcceptedAt: acceptedAt,
        // Portée par la même case que les CGV : le message affiché couvre les
        // deux. Les colonnes restent distinctes pour pouvoir répondre
        // précisément, sans relire le texte de l'époque.
        withdrawalWaivedAt: acceptedAt,
        plan: metadata.plan ?? null,
        interval: metadata.interval ?? null,
      },
    });

    if (!accepted) {
      logger.warn(
        'Billing',
        `Session ${session.id} encaissée sans consentement aux CGV : aucune renonciation à la rétractation opposable.`,
      );
    }
  } catch (error) {
    logger.warn('Billing', `Consentement de la session ${session.id} non enregistré : ${String(error)}`);
  }
}
