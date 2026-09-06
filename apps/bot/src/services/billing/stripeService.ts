/**
 * stripeService.ts
 *
 * Tout ce qui parle à l'API Stripe. Rien d'autre dans le projet n'importe le
 * paquet `stripe` : le reste du code manipule des offres (`PlanKey`) et des
 * durées, pas des objets Stripe.
 *
 * Deux conséquences voulues :
 *   - la facturation est **optionnelle**. Sans `STRIPE_SECRET_KEY`, ce module
 *     reste inerte, les routes renvoient 503 et le bot tourne exactement comme
 *     avant. Une instance auto-hébergée ou white-label n'a rien à configurer.
 *   - remplacer Stripe un jour ne touche que ce fichier et le webhook.
 *
 * Le lien offre ↔ prix Stripe passe par les variables d'environnement dont
 * `PLAN_REGISTRY` déclare les noms (`STRIPE_PRICE_PRO_MONTHLY`…). C'est ce qui
 * permet d'avoir des identifiants différents en test et en production sans
 * toucher au code ni à la base.
 */

import Stripe from 'stripe';
import {
  PLAN_REGISTRY,
  getPlanDefinition,
  type BillingInterval,
  type PlanKey,
} from '@kotbo/contracts';
import { logger } from '../../utils/logger.js';
import { getDashboardOrigin } from '../../api/shared/core.js';

let client: Stripe | null | undefined;

/**
 * Client Stripe, ou `null` si la facturation n'est pas configurée.
 * Construit à la première demande : le bot démarre sans clé Stripe.
 */
export function getStripe(): Stripe | null {
  if (client !== undefined) return client;

  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) {
    logger.info('Billing', 'STRIPE_SECRET_KEY absente : facturation désactivée.');
    client = null;
    return client;
  }

  // `apiVersion` est volontairement laissée au défaut du paquet : le SDK ne
  // type ce champ que par sa propre version courante, si bien qu'y épingler une
  // autre chaîne ne compile pas et, surtout, ne correspondrait plus aux types
  // avec lesquels on relit les objets reçus. C'est donc la montée de version du
  // paquet npm qui fait évoluer l'API - à faire en relisant le changelog Stripe,
  // les champs déplacés étant la source d'ennuis habituelle (`current_period_end`
  // a par exemple migré de l'abonnement vers ses lignes).
  client = new Stripe(secretKey, {
    // Bun n'expose pas l'agent HTTP de Node attendu par défaut ; ce client
    // s'appuie sur l'implémentation `fetch` native.
    httpClient: Stripe.createFetchHttpClient(),
    appInfo: { name: 'Kotbo', url: 'https://kotbo.fr' },
  });

  logger.success(
    'Billing',
    `Stripe initialisé (${secretKey.startsWith('sk_live_') ? 'PRODUCTION' : 'test'}).`,
  );
  return client;
}

/** La facturation est-elle utilisable sur cette instance ? */
export function isBillingEnabled(): boolean {
  return getStripe() !== null;
}

// ─────────────────────────────────────────────────────────────
// Correspondance offre ↔ prix Stripe
// ─────────────────────────────────────────────────────────────

/**
 * Identifiant du prix Stripe pour une offre et une périodicité, ou `null` si
 * l'offre ne se vend pas en ligne ou si la variable n'est pas renseignée.
 */
export function priceIdFor(plan: PlanKey, interval: BillingInterval): string | null {
  const definition = getPlanDefinition(plan);
  if (!definition.priceEnv) return null;
  return process.env[definition.priceEnv[interval]]?.trim() || null;
}

/**
 * Retrouve l'offre et la périodicité correspondant à un prix Stripe.
 *
 * Utilisé par le webhook : c'est le prix souscrit qui fait foi, pas les
 * métadonnées, car un changement d'offre depuis le portail client Stripe ne
 * repasse pas par notre code et ne met donc aucune métadonnée à jour.
 */
export function planForPriceId(priceId: string): { plan: PlanKey; interval: BillingInterval } | null {
  for (const definition of PLAN_REGISTRY) {
    if (!definition.priceEnv) continue;
    for (const interval of ['month', 'year'] as BillingInterval[]) {
      if (process.env[definition.priceEnv[interval]]?.trim() === priceId) {
        return { plan: definition.key, interval };
      }
    }
  }
  return null;
}

/**
 * Offres réellement vendables : celles marquées `selfServe` **et** dont les deux
 * prix sont renseignés. Sert à ne pas afficher un bouton « S'abonner » qui
 * renverrait une erreur parce qu'un `price_...` manque dans le `.env`.
 */
export function sellablePlans(): PlanKey[] {
  return PLAN_REGISTRY.filter(
    (p) => p.selfServe && priceIdFor(p.key, 'month') && priceIdFor(p.key, 'year'),
  ).map((p) => p.key);
}

// ─────────────────────────────────────────────────────────────
// Client Stripe rattaché au serveur
// ─────────────────────────────────────────────────────────────

/**
 * Crée le client Stripe d'un serveur, ou renvoie l'existant.
 *
 * Le client porte le serveur, pas l'utilisateur : c'est l'abonnement d'une
 * guilde, et le propriétaire Discord peut changer. `metadata.guildId` est la
 * seule chose qui permette au webhook de retrouver le serveur quand l'événement
 * ne porte rien d'autre - il est donc écrit à la création *et* réaffirmé
 * ensuite, au cas où un client aurait été créé à la main depuis Stripe.
 */
export async function ensureCustomer(
  guildId: string,
  existingCustomerId: string | null,
  hints: { guildName?: string; ownerId?: string } = {},
): Promise<string> {
  const stripe = getStripe();
  if (!stripe) throw new Error('Facturation Stripe non configurée.');

  if (existingCustomerId) {
    const customer = await stripe.customers.retrieve(existingCustomerId).catch(() => null);
    // Un client supprimé côté Stripe ne doit pas bloquer le serveur : on en
    // recrée un plutôt que de renvoyer une erreur incompréhensible.
    if (customer && !customer.deleted) return existingCustomerId;
    logger.warn('Billing', `Client Stripe ${existingCustomerId} introuvable pour ${guildId} : recréation.`);
  }

  const created = await stripe.customers.create({
    name: hints.guildName ? `${hints.guildName} (${guildId})` : `Serveur Discord ${guildId}`,
    metadata: {
      guildId,
      ...(hints.ownerId ? { discordOwnerId: hints.ownerId } : {}),
    },
  });

  return created.id;
}

// ─────────────────────────────────────────────────────────────
// Parcours d'achat
// ─────────────────────────────────────────────────────────────

/**
 * Version des conditions générales de vente en vigueur.
 *
 * Recopiée dans `BillingConsent` à chaque commande : sans elle, on saurait
 * qu'un client a accepté « les conditions » sans pouvoir dire lesquelles. À
 * incrémenter à chaque modification substantielle des CGV, en même temps que la
 * date affichée sur la page.
 */
export const CGV_VERSION = '2026-09-05';

/**
 * Consentement recueilli sur la page de paiement.
 *
 * `required` et non `auto` : la case doit être cochée pour que le paiement
 * aboutisse. Stripe affiche alors « J'accepte les conditions générales », le
 * lien pointant vers l'adresse renseignée dans le tableau de bord Stripe
 * (Réglages → Paiements → Conditions de service). **Sans cette adresse
 * configurée côté Stripe, la création de session échoue** - c'est le seul
 * réglage de ce dispositif qui ne vit pas dans le code.
 */
const CONSENT_COLLECTION: Stripe.Checkout.SessionCreateParams.ConsentCollection = {
  terms_of_service: 'required',
};

/**
 * Texte accolé à la case, et c'est lui qui fait le travail juridique.
 *
 * Kotbo ouvre les modules dès la confirmation du paiement. Pour un
 * consommateur, fournir un contenu numérique avant l'expiration du délai de
 * quatorze jours suppose deux choses distinctes : qu'il **demande
 * expressément** l'exécution immédiate, et qu'il **renonce expressément** à sa
 * rétractation (art. L221-25 et L221-28 du code de la consommation). Stripe n'a
 * pas de champ dédié à cette renonciation ; c'est donc ce message qui la porte,
 * et `session.consent.terms_of_service` qui atteste qu'elle a été cochée.
 *
 * Deux formulations plutôt qu'une : un abonnement se reconduit et peut ouvrir
 * un essai, un cadeau est un paiement unique sans reconduction. Faire signer au
 * client un texte qui décrit autre chose que ce qu'il achète viderait la
 * renonciation de sa valeur.
 */
const CONSENT_TEXT_SUBSCRIPTION: Stripe.Checkout.SessionCreateParams.CustomText = {
  terms_of_service_acceptance: {
    message:
      "En cochant cette case, vous acceptez les conditions générales de vente de Kotbo. "
      + "Vous demandez expressément que le service soit fourni dès la confirmation du paiement, "
      + "avant la fin du délai de rétractation de quatorze jours, et vous renoncez expressément "
      + "à ce droit de rétractation une fois vos accès ouverts (art. L221-25 et L221-28 du code "
      + "de la consommation). L'essai gratuit, lorsqu'il s'applique, n'entraîne aucun débit "
      + "jusqu'à son terme et reste résiliable à tout moment.",
  },
};

const CONSENT_TEXT_GIFT: Stripe.Checkout.SessionCreateParams.CustomText = {
  terms_of_service_acceptance: {
    message:
      "En cochant cette case, vous acceptez les conditions générales de vente de Kotbo. "
      + "Vous demandez expressément que la période offerte soit ouverte dès la confirmation du "
      + "paiement, avant la fin du délai de rétractation de quatorze jours, et vous renoncez "
      + "expressément à ce droit de rétractation (art. L221-25 et L221-28 du code de la "
      + "consommation). Un cadeau est un paiement unique : il ne se reconduit pas et n'ouvre "
      + "droit à aucun remboursement.",
  },
};

/** Consentement à appliquer à une session, selon la nature de l'achat. */
export function checkoutConsent(kind: 'SUBSCRIPTION' | 'GIFT'): {
  consent_collection: Stripe.Checkout.SessionCreateParams.ConsentCollection;
  custom_text: Stripe.Checkout.SessionCreateParams.CustomText;
} {
  return {
    consent_collection: CONSENT_COLLECTION,
    custom_text: kind === 'GIFT' ? CONSENT_TEXT_GIFT : CONSENT_TEXT_SUBSCRIPTION,
  };
}

export interface CheckoutOptions {
  guildId: string;
  customerId: string;
  plan: PlanKey;
  interval: BillingInterval;
  /** Utilisateur Discord à l'origine du clic, conservé pour l'audit. */
  initiatedBy: string;
  /** Jours d'essai gratuit offerts, 0 pour aucun. */
  trialDays?: number;
}

/**
 * Ouvre une session de paiement et renvoie son identifiant et l'URL vers
 * laquelle rediriger. L'identifiant sert à rattacher une réservation d'essai à
 * la session, pour pouvoir la libérer si le client abandonne.
 *
 * `guildId` est écrit à trois endroits (session, abonnement, client) : chacun
 * des événements que le webhook traite n'en expose qu'un sous-ensemble, et
 * dépendre d'un seul obligerait à un aller-retour supplémentaire vers l'API
 * Stripe à chaque réception.
 */
export async function createCheckoutSession(
  options: CheckoutOptions,
): Promise<{ id: string; url: string }> {
  const stripe = getStripe();
  if (!stripe) throw new Error('Facturation Stripe non configurée.');

  const priceId = priceIdFor(options.plan, options.interval);
  if (!priceId) throw new Error(`Aucun prix Stripe configuré pour l'offre ${options.plan}.`);

  const dashboard = getDashboardOrigin();
  const metadata = {
    guildId: options.guildId,
    plan: options.plan,
    interval: options.interval,
    initiatedBy: options.initiatedBy,
  };

  const trialDays = options.trialDays && options.trialDays > 0 ? options.trialDays : 0;

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: options.customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    // Redondant avec les métadonnées, mais c'est le champ que l'interface
    // Stripe affiche en tête de session : précieux pour un support humain.
    client_reference_id: options.guildId,
    metadata,
    subscription_data: {
      metadata,
      ...(trialDays
        ? {
            trial_period_days: trialDays,
            // Fin de l'essai sans moyen de paiement valide : on annule plutôt
            // que de laisser un abonnement impayé s'ouvrir. Le serveur retombe
            // sur l'offre gratuite, sans dette ni relance.
            trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
          }
        : {}),
    },
    allow_promotion_codes: true,
    // Acceptation des CGV et renonciation à la rétractation : sans elle, les
    // modules ne pourraient pas s'ouvrir avant quatorze jours.
    ...checkoutConsent('SUBSCRIPTION'),
    // Obligation TVA européenne : l'adresse du client détermine le taux.
    billing_address_collection: 'required',
    automatic_tax: { enabled: true },
    customer_update: { address: 'auto', name: 'auto' },
    success_url: `${dashboard}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${dashboard}/billing?checkout=cancelled`,
  });

  if (!session.url) throw new Error("Stripe n'a pas renvoyé d'URL de paiement.");
  logger.info(
    'Billing',
    `Session de paiement ${session.id} ouverte pour ${options.guildId} (${options.plan}/${options.interval}` +
      `${trialDays ? `, essai de ${trialDays} jours` : ''}).`,
  );
  return { id: session.id, url: session.url };
}

/**
 * Ouvre le portail client Stripe : factures, moyen de paiement, changement
 * d'offre et résiliation.
 *
 * Tout ce que Stripe sait faire mieux que nous est délégué ici plutôt que
 * réimplémenté dans le dashboard - et c'est aussi ce qui couvre l'obligation
 * légale de permettre une résiliation en ligne aussi simple que la souscription.
 */
export async function createPortalSession(guildId: string, customerId: string): Promise<string> {
  const stripe = getStripe();
  if (!stripe) throw new Error('Facturation Stripe non configurée.');

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${getDashboardOrigin()}/billing`,
  });

  logger.info('Billing', `Portail client ouvert pour ${guildId}.`);
  return session.url;
}

/**
 * Récupère un abonnement, ou `null` s'il n'existe plus côté Stripe (supprimé,
 * ou identifiant obsolète après un changement de compte Stripe).
 */
export async function retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription | null> {
  const stripe = getStripe();
  if (!stripe) return null;
  return stripe.subscriptions.retrieve(subscriptionId).catch(() => null);
}

export type { Stripe };
