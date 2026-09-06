/**
 * Routes de facturation.
 *
 * Deux publics très différents cohabitent ici, et c'est voulu :
 *
 *   - `/api/billing/webhook` est appelé par **Stripe**. Pas de session, pas de
 *     CORS : l'authentification est la signature cryptographique du corps de la
 *     requête. C'est la seule route de tout le projet dont l'appelant n'est pas
 *     un navigateur.
 *   - `/api/dashboard/guilds/:guildId/billing/*` est appelé par le **dashboard**,
 *     avec la session et le contrôle de rôle habituels. Ces routes ne débitent
 *     jamais rien : elles ouvrent une page hébergée par Stripe et renvoient son
 *     URL. Aucun numéro de carte ne traverse notre infrastructure, ce qui nous
 *     tient à l'écart du périmètre PCI.
 *
 * Toute l'attribution repose sur `metadata.guildId`, posé par `stripeService` au
 * moment d'ouvrir la session de paiement.
 */

import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { createMiddleware } from 'hono/factory';
import type { Client } from 'discord.js';
import {
  GIFT_DURATIONS_MONTHS,
  PLAN_KEYS,
  PLAN_REGISTRY,
  canPurchasePlan,
  getPlanDefinition,
  giftPriceCents,
  isGiftDuration,
  normalizePlanKey,
  planForMemberCount,
  type PlanKey,
} from '@kotbo/contracts';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { requireAuth } from '../middleware/auth.js';
import { requireGuildAccess } from '../middleware/guildAccess.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { dashboardSensitiveRateLimiter } from '../../limiters.js';
import {
  createCheckoutSession,
  createPortalSession,
  ensureCustomer,
  getStripe,
  isBillingEnabled,
  sellablePlans,
  type Stripe,
} from '../../../services/billing/stripeService.js';
import { syncSubscription, guildIdForSubscription } from '../../../services/billing/subscriptionSync.js';
import { recordBillingConsent } from '../../../services/billing/consentService.js';
import {
  recordFailedInvoice,
  recordInvoice,
  recordSubscriptionTransition,
} from '../../../services/billing/billingAnalytics.js';
import { trackAcquisitionStep } from '../../../services/analytics/acquisitionService.js';
import {
  TRIAL_DAYS,
  attachTrialSession,
  checkTrialEligibility,
  releaseTrialReservation,
  reserveTrial,
} from '../../../services/billing/trialService.js';
import {
  GIFT_METADATA_KIND,
  applyGiftPayment,
  createGiftCheckout,
  listGiftsForGuild,
  listGiftsPurchasedBy,
  redeemGiftCode,
  releaseGiftSession,
} from '../../../services/billing/giftService.js';

const BASE = '/api/dashboard/guilds/{guildId}/billing';

/** Droits de l'appelant sur la facturation, résolus une fois par requête. */
interface BillingAccessContext {
  canManage: boolean;
  isOwner: boolean;
  staffAccess: boolean;
}

declare module 'hono' {
  interface ContextVariableMap {
    billingAccess: BillingAccessContext;
  }
}

/** Offres achetables en ligne. `CUSTOM` se négocie, il n'est pas proposé ici. */
const PurchasablePlan = z.enum(['PLUS', 'PRO', 'ULTIMATE']);
const Interval = z.enum(['month', 'year']);

export function createBillingRouter(client: Client): OpenAPIHono {
  const router = new OpenAPIHono();

  // ═══════════════════════════════════════════════════════════════════════════
  // Webhook Stripe
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Déclaré hors d'`openapi()` : la vérification de signature exige le corps
   * **brut**, or le validateur zod-openapi le consomme et le reformate. Un
   * simple `.post()` nous laisse lire le texte tel qu'il est arrivé.
   *
   * Ni `requireAuth` ni rate-limit : Stripe n'a pas de session, et brider le
   * débit reviendrait à jeter des événements de paiement en cas de rafale.
   */
  router.post('/api/billing/webhook', async (c) => {
    const stripe = getStripe();
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();

    if (!stripe || !webhookSecret) {
      logger.warn('Billing', 'Webhook reçu alors que la facturation n\'est pas configurée.');
      return c.json({ error: 'Facturation non configurée' }, 503);
    }

    const signature = c.req.header('stripe-signature');
    if (!signature) return c.json({ error: 'Signature Stripe absente' }, 400);

    const rawBody = await c.req.text();

    let event: Stripe.Event;
    try {
      // Variante asynchrone : elle s'appuie sur la Web Crypto API, disponible
      // sous Bun, là où la variante synchrone attend le `crypto` de Node.
      event = await stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret);
    } catch (err) {
      // Un 400 est la bonne réponse : Stripe ne réessaiera pas un corps qu'il
      // n'a pas signé, et un attaquant n'apprend rien.
      logger.warn('Billing', 'Signature de webhook invalide :', err);
      return c.json({ error: 'Signature invalide' }, 400);
    }

    // Idempotence. Stripe garantit *au moins* une livraison : le même événement
    // peut revenir après un timeout ou un rejeu manuel. La clé primaire fait le
    // verrou, sans transaction ni cache.
    try {
      await prisma.billingEvent.create({
        data: { id: event.id, type: event.type, payload: event as unknown as object },
      });
    } catch {
      logger.debug('Billing', `Événement ${event.id} déjà traité, ignoré.`);
      return c.json({ received: true, duplicate: true }, 200);
    }

    try {
      const guildId = await handleEvent(event);
      if (guildId) await prisma.billingEvent.update({ where: { id: event.id }, data: { guildId } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await prisma.billingEvent.update({ where: { id: event.id }, data: { error: message } }).catch(() => null);
      logger.error('Billing', `Traitement de l'événement ${event.id} (${event.type}) en échec :`, err);

      // 500 : Stripe rejouera l'événement pendant 3 jours. La ligne
      // `BillingEvent` est déjà posée, donc le rejeu serait rejeté comme
      // doublon - on la supprime pour que la nouvelle tentative aboutisse.
      await prisma.billingEvent.delete({ where: { id: event.id } }).catch(() => null);
      return c.json({ error: 'Traitement en échec' }, 500);
    }

    return c.json({ received: true }, 200);
  });

  /**
   * Aiguillage des événements. Renvoie le serveur concerné, pour la trace.
   *
   * La liste est volontairement courte : tous les changements d'abonnement
   * (souscription, changement d'offre, renouvellement, résiliation, impayé)
   * finissent par produire un `customer.subscription.*`, et `syncSubscription`
   * recalcule l'état complet à partir de l'abonnement. Écouter plus
   * d'événements multiplierait les chemins sans rien apporter.
   */
  async function handleEvent(event: Stripe.Event): Promise<string | null> {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;

        // Un cadeau est un paiement unique : il n'a pas d'abonnement à relire,
        // et son traitement (application immédiate ou génération du code) vit
        // dans `giftService`.
        if (session.metadata?.kind === GIFT_METADATA_KIND) {
          // Avant d'appliquer quoi que ce soit : la preuve de ce qui a ete
          // accepte doit survivre meme si l'application echoue ensuite.
          await recordBillingConsent(session, 'GIFT');
          return applyGiftPayment(session);
        }

        await recordBillingConsent(session, 'SUBSCRIPTION');

        const guildId = session.metadata?.guildId ?? session.client_reference_id ?? null;

        // Le paiement est encaissé mais l'abonnement n'est pas encore forcément
        // dans l'état final. On le relit plutôt que de déduire quoi que ce soit
        // de la session : `customer.subscription.created` arrivera de toute
        // façon, et les deux chemins convergent vers le même `syncSubscription`.
        const subscriptionId =
          typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
        if (!subscriptionId) return guildId;

        const stripe = getStripe();
        const subscription = await stripe!.subscriptions.retrieve(subscriptionId);
        await syncSubscription(subscription);
        return guildId ?? (await guildIdForSubscription(subscription));
      }

      case 'checkout.session.expired': {
        // Session ouverte puis abandonnée. Si elle portait un essai, la
        // réservation est libérée : regarder la page de paiement ne consomme
        // pas les 15 jours.
        const session = event.data.object as Stripe.Checkout.Session;
        await releaseTrialReservation({ checkoutSessionId: session.id });
        // Même raisonnement pour un cadeau abandonné : la ligne en attente
        // disparaît, l'acheteur ne garde pas un cadeau fantôme dans sa liste.
        await releaseGiftSession(session.id);

        const abandonedGuildId = session.metadata?.guildId ?? session.client_reference_id ?? null;
        if (abandonedGuildId) {
          // Le seul endroit ou l'abandon de paiement se voit : sans lui, un
          // serveur parti a l'ecran Stripe puis revenu en arriere serait
          // indiscernable d'un serveur qui n'a jamais essaye.
          trackAcquisitionStep({
            step: 'checkout_abandoned',
            guildId: abandonedGuildId,
            metadata: { plan: session.metadata?.plan ?? null, interval: session.metadata?.interval ?? null },
          });
        }
        return abandonedGuildId;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = event.data.object as Stripe.Subscription;
        // Avant `syncSubscription`, imperativement : Stripe n'envoie pas « le
        // client a resilie » ni « le client est monte en offre », il envoie
        // l'objet complet. C'est la comparaison avec l'etat connu qui dit ce
        // qui s'est passe, et cet etat est sur le point d'etre ecrase.
        await recordSubscriptionTransition(subscription);
        await syncSubscription(subscription);
        return guildIdForSubscription(subscription);
      }

      case 'invoice.paid': {
        // Le chiffre d'affaires reel entre ici, et nulle part ailleurs.
        const invoice = event.data.object as Stripe.Invoice;
        await recordInvoice(invoice);
        return invoice.parent?.subscription_details?.metadata?.guildId ?? null;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        await recordFailedInvoice(invoice);
        return invoice.parent?.subscription_details?.metadata?.guildId ?? null;
      }

      default:
        logger.debug('Billing', `Événement ${event.type} ignoré.`);
        return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Routes dashboard
  // ═══════════════════════════════════════════════════════════════════════════

  const PlanCard = z.object({
    key: z.enum(PLAN_KEYS),
    name: z.string(),
    tagline: z.string(),
    description: z.string(),
    /** Tranche de taille servie par l'offre, `null` pour `FREE`. */
    memberRange: z.object({ min: z.number(), max: z.number().nullable() }).nullable(),
    priceCents: z.object({ month: z.number(), year: z.number() }).nullable(),
    /** Vraie uniquement pour l'offre correspondant à la taille de ce serveur. */
    purchasable: z.boolean(),
  });

  /**
   * Essai gratuit, tel que le dashboard doit le présenter. `days` est renvoyé
   * même quand l'essai n'est plus disponible : la page l'affiche dans son texte
   * d'explication, et la durée ne doit pas être écrite en dur côté client.
   */
  const TrialInfo = z.object({
    available: z.boolean(),
    days: z.number(),
    reason: z
      .enum(['already_used_by_user', 'already_used_by_guild', 'guild_has_subscription', 'plan_not_eligible'])
      .nullable(),
  });

  const Gift = z.object({
    id: z.string(),
    code: z.string().nullable(),
    plan: z.enum(PLAN_KEYS),
    planName: z.string(),
    months: z.number(),
    source: z.string(),
    amountCents: z.number().nullable(),
    purchasedById: z.string(),
    targetGuildId: z.string().nullable(),
    paidAt: z.string().nullable(),
    redeemedByGuildId: z.string().nullable(),
    redeemedAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    note: z.string().nullable(),
    createdAt: z.string(),
  });

  const BillingStatus = z.object({
    enabled: z.boolean(),
    plan: z.enum(PLAN_KEYS),
    planName: z.string(),
    status: z.string().nullable(),
    currentPeriodEnd: z.string().nullable(),
    cancelAtPeriodEnd: z.boolean(),
    hasSubscription: z.boolean(),
    /** Taille du serveur, `null` si le bot ne la connaît pas encore. */
    memberCount: z.number().nullable(),
    /** Offre imposée par cette taille : la seule souscriptible en ligne. */
    eligiblePlan: z.enum(PLAN_KEYS),
    /** Faux pour un membre du staff en lecture seule (voir `staffAccess`). */
    canManage: z.boolean(),
    /** L'utilisateur connecté est celui qui a engagé la dépense. */
    isBillingOwner: z.boolean(),
    /** La page est ouverte à tout le staff, et non aux seuls administrateurs. */
    staffAccess: z.boolean(),
    accessExpiresAt: z.string().nullable(),
    trial: TrialInfo,
    plans: z.array(PlanCard),
    /** Cadeaux offerts par l'utilisateur connecté, et reçus par ce serveur. */
    giftsPurchased: z.array(Gift),
    giftsReceived: z.array(Gift),
  });

  const statusRoute = createRoute({
    method: 'get',
    path: BASE,
    summary: "Offre du serveur et grille tarifaire",
    tags: ['Billing'],
    request: { params: z.object({ guildId: z.string() }) },
    responses: {
      200: { description: 'État de facturation', content: { 'application/json': { schema: BillingStatus } } },
    },
  });

  /**
   * Qui a le droit de voir, et qui a le droit d'agir.
   *
   * Trois profils très différents peuvent légitimement ouvrir cette page, et
   * les confondre revenait soit à afficher un montant débité à toute l'équipe
   * de modération, soit à fermer sa propre facture à celui qui la paie :
   *
   *   - l'**administrateur** du serveur : il décide de la dépense, il peut tout ;
   *   - le **payeur** (`billingOwnerId`) : celui qui a engagé la dépense garde
   *     l'accès même s'il perd ses droits Discord - on ne coupe personne de sa
   *     propre facture ;
   *   - le **staff**, seulement si le serveur l'a explicitement décidé
   *     (`billingStaffAccess`), et alors en lecture seule : voir l'offre en
   *     cours n'est pas la même chose que déclencher un prélèvement.
   *
   * Le niveau `viewer` de `requireGuildAccess` sert de premier filtre (être
   * membre du serveur) ; la règle ci-dessus fait le reste.
   */
  const requireBillingAccess = createMiddleware(async (c, next) => {
    const guildId = c.req.param('guildId')!;
    const userId = c.var.auth.userId;
    const level = c.var.guildAccess.level;

    const guild = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { billingOwnerId: true, billingStaffAccess: true },
    });

    const isOwner = Boolean(guild?.billingOwnerId && guild.billingOwnerId === userId);
    const canManage = level === 'admin' || isOwner;
    const canRead = canManage || (level === 'moderator' && Boolean(guild?.billingStaffAccess));

    if (!canRead) {
      throw new HTTPException(403, {
        message: "La facturation de ce serveur est réservée à ses administrateurs.",
      });
    }
    // Toute écriture (paiement, portail, cadeau, réglage) demande le niveau
    // complet : un membre du staff en lecture ne doit pas pouvoir engager
    // le serveur d'un simple clic.
    if (!canManage && c.req.method !== 'GET') {
      throw new HTTPException(403, {
        message: "Seuls les administrateurs du serveur peuvent modifier la facturation.",
      });
    }

    c.set('billingAccess', { canManage, isOwner, staffAccess: Boolean(guild?.billingStaffAccess) });
    await next();
  });

  // Deux enregistrements et non un seul : `use()` avec un chemin exact ne
  // couvre pas les sous-routes, et `/*` ne couvre pas le chemin nu. Les oublier
  // laisserait `/billing/checkout` et `/billing/portal` ouverts sans session -
  // n'importe qui pourrait ouvrir une session de paiement au nom d'un serveur.
  const GUARDED = BASE.replace('{guildId}', ':guildId');
  router.use(GUARDED, requireAuth, requireGuildAccess(client, 'viewer'), requireBillingAccess);
  router.use(`${GUARDED}/*`, requireAuth, requireGuildAccess(client, 'viewer'), requireBillingAccess);

  router.openapi(statusRoute, async (c) => {
    const { guildId } = c.req.valid('param');

    const guild = await prisma.guild.findUnique({
      where: { id: guildId },
      select: {
        plan: true,
        stripeSubscriptionId: true,
        stripeSubscriptionStatus: true,
        stripeCurrentPeriodEnd: true,
        stripeCancelAtPeriodEnd: true,
        accessExpiresAt: true,
      },
    });

    const sellable = new Set(sellablePlans());
    const plan = normalizePlanKey(guild?.plan);

    // La taille du serveur décide de l'offre : les fonctionnalités étant
    // identiques d'une offre payante à l'autre, c'est le seul critère qui
    // reste. `memberCount` vient du cache de discord.js, rempli à la connexion.
    const memberCount = client.guilds.cache.get(guildId)?.memberCount ?? null;
    const eligiblePlan = planForMemberCount(memberCount);

    const [giftsPurchased, giftsReceived] = await Promise.all([
      listGiftsPurchasedBy(c.var.auth.userId),
      listGiftsForGuild(guildId),
    ]);

    // Éligibilité évaluée sur PRO : les offres vendues en ligne partagent la
    // même règle, et l'essai se consomme une fois quelle que soit celle qui
    // le déclenche. Elle dépend de l'utilisateur connecté, pas seulement du
    // serveur - deux administrateurs du même serveur peuvent voir un bouton
    // différent, et c'est exactement ce que la règle « une fois par compte
    // Discord » implique.
    const trial = await checkTrialEligibility(guildId, c.var.auth.userId, 'PRO');

    return c.json({
      enabled: isBillingEnabled(),
      plan,
      planName: getPlanDefinition(plan).name,
      status: guild?.stripeSubscriptionStatus ?? null,
      currentPeriodEnd: guild?.stripeCurrentPeriodEnd?.toISOString() ?? null,
      cancelAtPeriodEnd: guild?.stripeCancelAtPeriodEnd ?? false,
      hasSubscription: Boolean(guild?.stripeSubscriptionId),
      memberCount,
      eligiblePlan,
      canManage: c.var.billingAccess.canManage,
      isBillingOwner: c.var.billingAccess.isOwner,
      staffAccess: c.var.billingAccess.staffAccess,
      // Fin de la période offerte, quand le serveur tourne sur un cadeau : il
      // n'a pas d'abonnement Stripe, donc pas de `currentPeriodEnd`.
      accessExpiresAt: guild?.accessExpiresAt?.toISOString() ?? null,
      trial: { available: trial.eligible, days: trial.days, reason: trial.reason ?? null },
      plans: PLAN_REGISTRY.map((definition) => ({
        key: definition.key,
        name: definition.name,
        tagline: definition.tagline,
        description: definition.description,
        memberRange: definition.memberRange,
        priceCents: definition.displayPriceCents,
        // Seule l'offre du palier est achetable : proposer les autres
        // laisserait un serveur de 80 000 membres payer le tarif d'un serveur
        // de 500, pour exactement les mêmes fonctionnalités.
        purchasable: sellable.has(definition.key) && definition.key === eligiblePlan,
      })),
      giftsPurchased,
      giftsReceived,
    }, 200);
  });

  // ─── Ouverture d'une session de paiement ───────────────────────────────────

  const checkoutRoute = createRoute({
    method: 'post',
    path: `${BASE}/checkout`,
    summary: "Ouvre une session de paiement Stripe",
    tags: ['Billing'],
    request: {
      params: z.object({ guildId: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({ plan: PurchasablePlan, interval: Interval }),
          },
        },
      },
    },
    responses: {
      200: { description: 'URL de paiement', content: { 'application/json': { schema: z.object({ url: z.string() }) } } },
      409: { description: 'Offre ne correspondant pas à la taille du serveur', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      503: { description: 'Facturation non configurée', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  });

  // Ces deux routes ouvrent des sessions côté Stripe : on les bride comme les
  // autres actions sensibles, un clic répété ne devant pas créer dix sessions.
  router.use(`${GUARDED}/checkout`, rateLimit(dashboardSensitiveRateLimiter, 10, 60 * 1000));
  router.use(`${GUARDED}/portal`, rateLimit(dashboardSensitiveRateLimiter, 10, 60 * 1000));

  router.openapi(checkoutRoute, async (c) => {
    if (!isBillingEnabled()) return c.json({ error: 'Facturation non configurée sur cette instance.' }, 503);

    const { guildId } = c.req.valid('param');
    const { plan, interval } = c.req.valid('json');
    const auth = c.var.auth;

    const guild = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { stripeCustomerId: true },
    });

    const discordGuild = client.guilds.cache.get(guildId) ?? null;

    // Le palier est une règle, pas une suggestion : le dashboard n'affiche
    // qu'une offre achetable, mais la requête vient du navigateur et se
    // rejoue. Sans ce contrôle, un serveur de 80 000 membres souscrirait le
    // tarif d'un serveur de 500 en changeant un mot dans le corps JSON.
    const memberCount = discordGuild?.memberCount ?? null;
    if (!canPurchasePlan(plan as PlanKey, memberCount)) {
      const expected = getPlanDefinition(planForMemberCount(memberCount));
      return c.json(
        {
          error: `Avec ${memberCount ?? '?'} membres, ce serveur relève de l'offre ${expected.name}.`,
        },
        409,
      );
    }

    try {
      const customerId = await ensureCustomer(guildId, guild?.stripeCustomerId ?? null, {
        guildName: discordGuild?.name,
        ownerId: discordGuild?.ownerId,
      });

      // Écrit avant la redirection : si l'utilisateur abandonne le paiement, le
      // client Stripe existe déjà et sera réutilisé au lieu d'en créer un second.
      // `billingOwnerId` : celui qui engage la dépense garde l'accès à la page
      // de facturation même s'il perd ses droits d'administration Discord.
      await prisma.guild.upsert({
        where: { id: guildId },
        update: { stripeCustomerId: customerId, billingOwnerId: auth.userId },
        create: { id: guildId, stripeCustomerId: customerId, billingOwnerId: auth.userId },
      });

      // L'essai est réservé *avant* d'appeler Stripe : l'insertion en base est
      // le verrou qui garantit « une fois par compte Discord », et un
      // aller-retour réseau laisserait passer un second clic. En échec de
      // réservation, on ouvre simplement un parcours d'achat sans essai plutôt
      // que de renvoyer une erreur.
      const eligibility = await checkTrialEligibility(guildId, auth.userId, plan as PlanKey);
      const trialReserved =
        eligibility.eligible && (await reserveTrial(guildId, auth.userId, plan as PlanKey, interval));

      let session: { id: string; url: string };
      try {
        session = await createCheckoutSession({
          guildId,
          customerId,
          plan: plan as PlanKey,
          interval,
          initiatedBy: auth.userId,
          trialDays: trialReserved ? TRIAL_DAYS : 0,
        });
      } catch (err) {
        // Stripe n'a pas ouvert la page : l'essai n'a jamais démarré, la
        // réservation ne doit pas rester posée.
        if (trialReserved) await releaseTrialReservation({ discordUserId: auth.userId });
        throw err;
      }

      if (trialReserved) await attachTrialSession(auth.userId, session.id);

      // Haut du tunnel de paiement. Enregistre ici et non a la reception du
      // webhook : ce qui interesse, c'est justement l'ecart entre les sessions
      // ouvertes et celles qui aboutissent.
      trackAcquisitionStep({
        step: 'checkout_started',
        guildId,
        discordUserId: auth.userId,
        metadata: { plan, interval, trialReserved, sessionId: session.id },
      });
      if (trialReserved) {
        trackAcquisitionStep({
          step: 'trial_reserved',
          guildId,
          discordUserId: auth.userId,
          metadata: { plan, interval },
        });
      }

      return c.json({ url: session.url }, 200);
    } catch (err) {
      logger.error('Billing', `Ouverture du paiement impossible pour ${guildId}:`, err);
      throw new HTTPException(502, { message: "Stripe n'a pas pu ouvrir la page de paiement." });
    }
  });

  // ─── Portail client (factures, moyen de paiement, résiliation) ─────────────

  const portalRoute = createRoute({
    method: 'post',
    path: `${BASE}/portal`,
    summary: 'Ouvre le portail client Stripe',
    tags: ['Billing'],
    request: { params: z.object({ guildId: z.string() }) },
    responses: {
      200: { description: 'URL du portail', content: { 'application/json': { schema: z.object({ url: z.string() }) } } },
      404: { description: 'Aucun client Stripe', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
      503: { description: 'Facturation non configurée', content: { 'application/json': { schema: z.object({ error: z.string() }) } } },
    },
  });

  router.openapi(portalRoute, async (c) => {
    if (!isBillingEnabled()) return c.json({ error: 'Facturation non configurée sur cette instance.' }, 503);

    const { guildId } = c.req.valid('param');
    const guild = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { stripeCustomerId: true },
    });

    if (!guild?.stripeCustomerId) {
      return c.json({ error: "Ce serveur n'a jamais souscrit d'abonnement." }, 404);
    }

    try {
      const url = await createPortalSession(guildId, guild.stripeCustomerId);
      return c.json({ url }, 200);
    } catch (err) {
      logger.error('Billing', `Ouverture du portail impossible pour ${guildId}:`, err);
      throw new HTTPException(502, { message: "Stripe n'a pas pu ouvrir le portail client." });
    }
  });

  // ─── Ouverture de la facturation au staff ─────────────────────────────────

  const staffAccessRoute = createRoute({
    method: 'patch',
    path: `${BASE}/staff-access`,
    summary: 'Ouvre ou ferme la facturation au staff du serveur',
    tags: ['Billing'],
    request: {
      params: z.object({ guildId: z.string() }),
      body: { content: { 'application/json': { schema: z.object({ enabled: z.boolean() }) } } },
    },
    responses: {
      200: {
        description: 'Réglage enregistré',
        content: { 'application/json': { schema: z.object({ staffAccess: z.boolean() }) } },
      },
    },
  });

  router.openapi(staffAccessRoute, async (c) => {
    const { guildId } = c.req.valid('param');
    const { enabled } = c.req.valid('json');

    await prisma.guild.upsert({
      where: { id: guildId },
      update: { billingStaffAccess: enabled },
      create: { id: guildId, billingStaffAccess: enabled },
    });

    logger.info('Billing', `Facturation ${enabled ? 'ouverte' : 'refermée'} au staff de ${guildId}.`);
    return c.json({ staffAccess: enabled }, 200);
  });

  // ─── Offrir Kotbo ─────────────────────────────────────────────────────────

  /** Durées proposées, telles que le registre les déclare. */
  const GiftMonths = z
    .number()
    .int()
    .refine((value) => isGiftDuration(value), { message: 'Durée de cadeau invalide.' });

  const giftCheckoutRoute = createRoute({
    method: 'post',
    path: `${BASE}/gift/checkout`,
    summary: "Ouvre le paiement d'un cadeau",
    tags: ['Billing'],
    request: {
      params: z.object({ guildId: z.string() }),
      body: {
        content: {
          'application/json': {
            schema: z.object({
              months: GiftMonths,
              // Offre offerte. Ignorée quand un serveur destinataire est
              // désigné : c'est alors sa taille qui décide.
              plan: PurchasablePlan.optional(),
              // Serveur destinataire, ou omis pour un code à transmettre.
              targetGuildId: z.string().optional(),
              note: z.string().max(200).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: {
        description: 'URL de paiement',
        content: { 'application/json': { schema: z.object({ url: z.string(), amountCents: z.number() }) } },
      },
      400: {
        description: 'Demande invalide',
        content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      },
      503: {
        description: 'Facturation non configurée',
        content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      },
    },
  });

  router.use(`${GUARDED}/gift/checkout`, rateLimit(dashboardSensitiveRateLimiter, 10, 60 * 1000));
  router.use(`${GUARDED}/gift/redeem`, rateLimit(dashboardSensitiveRateLimiter, 10, 60 * 1000));

  router.openapi(giftCheckoutRoute, async (c) => {
    if (!isBillingEnabled()) return c.json({ error: 'Facturation non configurée sur cette instance.' }, 503);

    const { guildId } = c.req.valid('param');
    const { months, plan, targetGuildId, note } = c.req.valid('json');

    // Cadeau destiné à un serveur précis : son offre est celle de sa taille,
    // pas celle que l'acheteur aurait choisie. Le bot doit y être présent -
    // sans quoi il n'y a ni taille connue, ni serveur à créditer.
    let giftPlan: PlanKey;
    if (targetGuildId) {
      const target = client.guilds.cache.get(targetGuildId);
      if (!target) {
        return c.json(
          { error: "Kotbo n'est pas présent sur ce serveur : invitez-le avant de lui offrir une offre." },
          400,
        );
      }
      giftPlan = planForMemberCount(target.memberCount);
      if (giftPlan === 'CUSTOM') {
        return c.json(
          { error: "Ce serveur relève de l'offre sur mesure : elle se met en place après un rendez-vous." },
          400,
        );
      }
    } else {
      // Sans destinataire, l'acheteur choisit le palier. Le code sera refusé à
      // l'activation s'il vise un serveur plus grand que l'offre payée.
      giftPlan = (plan ?? 'PRO') as PlanKey;
    }

    if (!giftPriceCents(giftPlan, months)) {
      return c.json({ error: 'Cette offre ne peut pas être offerte.' }, 400);
    }

    try {
      const result = await createGiftCheckout({
        plan: giftPlan,
        months,
        purchasedById: c.var.auth.userId,
        purchasedFromGuildId: guildId,
        targetGuildId: targetGuildId ?? null,
        note: note ?? null,
      });
      return c.json({ url: result.url, amountCents: result.amountCents }, 200);
    } catch (err) {
      logger.error('Billing', `Ouverture du paiement d'un cadeau impossible pour ${c.var.auth.userId}:`, err);
      throw new HTTPException(502, { message: "Stripe n'a pas pu ouvrir la page de paiement." });
    }
  });

  // ─── Activation d'un code cadeau ──────────────────────────────────────────

  const giftRedeemRoute = createRoute({
    method: 'post',
    path: `${BASE}/gift/redeem`,
    summary: 'Active un code cadeau sur ce serveur',
    tags: ['Billing'],
    request: {
      params: z.object({ guildId: z.string() }),
      body: { content: { 'application/json': { schema: z.object({ code: z.string().min(4).max(40) }) } } },
    },
    responses: {
      200: {
        description: 'Cadeau activé',
        content: {
          'application/json': {
            schema: z.object({
              plan: z.enum(PLAN_KEYS),
              months: z.number(),
              expiresAt: z.string().nullable(),
              message: z.string(),
            }),
          },
        },
      },
      400: {
        description: 'Code refusé',
        content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      },
    },
  });

  /**
   * Messages de refus. Écrits ici plutôt que renvoyés bruts : « plan_below_tier »
   * ne dit rien à l'administrateur qui vient de recevoir un code d'un ami.
   */
  const REDEEM_ERRORS: Record<string, string> = {
    unknown_code: "Ce code n'existe pas. Vérifiez la saisie : les codes ne contiennent ni O, ni I, ni S.",
    not_paid: "Ce code n'est pas encore payé. Réessayez dans un instant.",
    already_used: 'Ce code a déjà été utilisé.',
    guild_has_subscription:
      "Ce serveur a un abonnement en cours : résiliez-le d'abord, le code restera valable.",
    plan_below_tier: 'Ce code porte une offre trop petite pour la taille de ce serveur.',
  };

  router.openapi(giftRedeemRoute, async (c) => {
    const { guildId } = c.req.valid('param');
    const { code } = c.req.valid('json');

    const memberCount = client.guilds.cache.get(guildId)?.memberCount ?? null;
    const result = await redeemGiftCode(code, guildId, c.var.auth.userId, memberCount);

    if (!result.ok) {
      const detail =
        result.reason === 'plan_below_tier' && result.requiredPlan
          ? ` Il faut un cadeau ${getPlanDefinition(result.requiredPlan).name}.`
          : '';
      return c.json({ error: `${REDEEM_ERRORS[result.reason] ?? 'Code refusé.'}${detail}` }, 400);
    }

    const { application, gift } = result;
    return c.json(
      {
        plan: application.plan,
        months: application.months,
        expiresAt: application.expiresAt?.toISOString() ?? null,
        message: application.keptPermanentAccess
          ? `Offre ${gift.planName} activée. Ce serveur a déjà un accès sans expiration : aucune date n'a été posée.`
          : `Offre ${gift.planName} activée pour ${application.months} mois.`,
      },
      200,
    );
  });

  return router;
}
