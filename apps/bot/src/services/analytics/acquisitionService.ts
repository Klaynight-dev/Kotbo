/**
 * acquisitionService.ts
 *
 * Point d'écriture unique du tunnel d'acquisition.
 *
 * Une dizaine d'endroits du bot franchissent une étape du tunnel : l'arrivée
 * sur un serveur, le départ, chaque écran du parcours de configuration, chaque
 * événement Stripe. Tous passent par `recordAcquisitionStep`, et aucun ne
 * touche `AcquisitionEvent` ni `GuildLifecycle` directement. C'est ce qui
 * garantit que la projection reste cohérente : `firstPaidAt` ne peut pas être
 * écrit deux fois avec deux logiques différentes selon l'appelant.
 *
 * ── Ce module n'échoue jamais ───────────────────────────────────────────────
 *
 * Toutes les fonctions publiques avalent leurs erreurs. Une statistique perdue
 * est un trou dans une courbe ; une exception remontée depuis un webhook Stripe
 * déjà encaissé, ou depuis `GuildCreate`, casse quelque chose que le client
 * paie. Les appelants font `void recordAcquisitionStep(...)` sans `await` :
 * l'écriture ne doit jamais s'insérer dans le chemin critique.
 *
 * ── Deux écritures, deux durées de vie ──────────────────────────────────────
 *
 *   - `AcquisitionEvent` : le fait brut, horodaté, purgé à treize mois.
 *   - `GuildLifecycle`   : la projection, un serveur par ligne, conservée.
 *
 * La seconde n'est pas un cache de la première : elle porte des cumuls
 * (`lifetimeCents`, `reinstallCount`) que la purge rendrait irrécupérables, et
 * c'est elle que lisent les cohortes - rescanner le journal à chaque affichage
 * ne tiendrait pas la charge.
 */

import { createHmac } from 'node:crypto';
import {
  isAcquisitionStep,
  type AcquisitionStep,
  type ActivationOrigin,
  type ChurnReason,
} from '@kotbo/contracts';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

export interface AcquisitionStepInput {
  step: AcquisitionStep;
  guildId?: string | null;
  /** Identifiant Discord en clair. Haché ici, jamais stocké tel quel. */
  discordUserId?: string | null;
  visitorId?: string | null;
  source?: string | null;
  campaign?: string | null;
  content?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Horodatage du fait, si différent de maintenant (reprise d'historique). */
  occurredAt?: Date;
}

// ─────────────────────────────────────────────────────────────
// Pseudonymisation
// ─────────────────────────────────────────────────────────────

let secretWarned = false;

/**
 * Hache un identifiant Discord.
 *
 * HMAC et non SHA brut : un identifiant Discord est un entier de dix-huit
 * chiffres, donc un espace assez petit pour être balayé exhaustivement. Un
 * simple condensat serait réversible en quelques heures, et le journal
 * redeviendrait nominatif.
 *
 * Sans `ANALYTICS_HASH_SECRET`, on renvoie `null` plutôt que l'identifiant en
 * clair : mieux vaut perdre la capacité à compter des parcours distincts que
 * constituer un fichier d'utilisateurs identifiés par accident de
 * configuration. L'avertissement n'est émis qu'une fois, pour ne pas noyer les
 * journaux.
 */
export function hashActor(discordUserId: string | null | undefined): string | null {
  if (!discordUserId) return null;

  const secret = process.env.ANALYTICS_HASH_SECRET?.trim();
  if (!secret) {
    if (!secretWarned) {
      secretWarned = true;
      logger.warn(
        'Acquisition',
        'ANALYTICS_HASH_SECRET absente : les parcours ne seront pas rattachés à une personne. '
          + "Aucun identifiant n'est stocké en clair.",
      );
    }
    return null;
  }

  return createHmac('sha256', secret).update(discordUserId).digest('hex');
}

// ─────────────────────────────────────────────────────────────
// Projection vers GuildLifecycle
// ─────────────────────────────────────────────────────────────

type Lifecycle = Awaited<ReturnType<typeof prisma.guildLifecycle.findUnique>>;

/** Champs que la projection sait écrire. Volontairement partiel. */
type LifecyclePatch = Record<string, unknown>;

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Ce qu'une étape change dans l'état du serveur.
 *
 * Le principe qui gouverne tout le tableau : **une date de première fois ne
 * s'écrase pas**. `firstPaidAt` doit rester la date du premier paiement, même
 * quand le serveur repaie deux ans plus tard après un churn - sans quoi les
 * cohortes se déplaceraient toutes seules et la rétention deviendrait
 * ininterprétable. D'où le `?? undefined` répété : `undefined` dit à Prisma de
 * ne pas toucher au champ.
 */
export function projectStep(
  input: AcquisitionStepInput,
  existing: Lifecycle,
  at: Date,
): LifecyclePatch {
  const meta = input.metadata ?? {};
  const patch: LifecyclePatch = {};

  // La provenance se pose à la première occasion et ne bouge plus : un serveur
  // arrivé par Google reste arrivé par Google, même si un membre du staff se
  // reconnecte plus tard depuis un lien Discord.
  if (!existing?.source && input.source) patch.source = input.source;
  if (!existing?.campaign && input.campaign) patch.campaign = input.campaign;
  if (!existing?.content && input.content) patch.content = input.content;

  switch (input.step) {
    case 'bot_joined': {
      if (!existing?.invitedAt) patch.invitedAt = at;
      const members = num(meta.memberCount);
      if (members !== null) {
        patch.memberCount = members;
        if (existing?.memberCountAtInvite == null) patch.memberCountAtInvite = members;
      }
      if (str(meta.locale)) patch.locale = str(meta.locale);
      if (str(meta.timezone)) patch.timezone = str(meta.timezone);
      if (str(meta.instanceId)) patch.instanceId = str(meta.instanceId);
      break;
    }

    case 'bot_reinstalled': {
      // Un retour n'est pas une acquisition neuve : on incrémente plutôt que de
      // réécrire `invitedAt`, sinon le serveur changerait de cohorte et le haut
      // du tunnel compterait deux fois la même communauté.
      patch.reinstallCount = (existing?.reinstallCount ?? 0) + 1;
      patch.botRemovedAt = null;
      const members = num(meta.memberCount);
      if (members !== null) patch.memberCount = members;
      break;
    }

    case 'bot_removed': {
      patch.botRemovedAt = at;
      if (!existing?.churnedAt) {
        patch.churnedAt = at;
        patch.churnReason = 'BOT_REMOVED' satisfies ChurnReason;
      }
      break;
    }

    case 'dashboard_first_open':
      if (!existing?.dashboardFirstOpenedAt) patch.dashboardFirstOpenedAt = at;
      break;

    case 'onboarding_started':
      if (!existing?.onboardingStartedAt) patch.onboardingStartedAt = at;
      break;

    case 'onboarding_step': {
      const step = str(meta.step);
      if (step) {
        patch.onboardingLastStep = step;
        // Première visite de chaque écran, horodatée. On garde la première et
        // non la dernière : c'est elle qui situe l'écran dans le parcours, un
        // retour en arrière ne devant pas le faire paraître plus tardif.
        const seen = (existing?.onboardingSteps as Record<string, string> | null) ?? {};
        if (!seen[step]) patch.onboardingSteps = { ...seen, [step]: at.toISOString() };
      }
      if (!existing?.onboardingStartedAt) patch.onboardingStartedAt = at;
      break;
    }

    case 'onboarding_completed': {
      if (!existing?.onboardingCompletedAt) patch.onboardingCompletedAt = at;
      const startedAt = existing?.onboardingStartedAt;
      if (startedAt && existing?.onboardingSeconds == null) {
        patch.onboardingSeconds = Math.max(0, Math.round((at.getTime() - startedAt.getTime()) / 1000));
      }
      if (str(meta.serverKind)) patch.serverKind = str(meta.serverKind);
      if (Array.isArray(meta.tracks)) {
        patch.tracks = meta.tracks.filter((t): t is string => typeof t === 'string');
      }
      break;
    }

    case 'plan_viewed':
      if (!existing?.pricingViewedAt) patch.pricingViewedAt = at;
      break;

    case 'checkout_started':
      patch.checkoutStartedAt = at;
      // Une nouvelle tentative efface l'abandon précédent : sinon un serveur
      // qui a abandonné puis payé resterait compté comme abandon.
      patch.checkoutAbandonedAt = null;
      break;

    case 'checkout_abandoned':
      patch.checkoutAbandonedAt = at;
      break;

    case 'trial_started':
      if (!existing?.trialStartedAt) patch.trialStartedAt = at;
      if (meta.trialEndsAt instanceof Date) patch.trialEndsAt = meta.trialEndsAt;
      break;

    case 'trial_converted':
      if (!existing?.trialConvertedAt) patch.trialConvertedAt = at;
      break;

    case 'trial_expired':
      if (!existing?.churnedAt) {
        patch.churnedAt = at;
        patch.churnReason = 'TRIAL_EXPIRED' satisfies ChurnReason;
      }
      break;

    case 'first_payment':
    case 'payment': {
      if (!existing?.firstPaidAt) patch.firstPaidAt = at;
      const cents = num(meta.amountCents);
      if (cents !== null) patch.lifetimeCents = (existing?.lifetimeCents ?? 0) + cents;
      const mrr = num(meta.mrrCents);
      if (mrr !== null) patch.mrrCents = mrr;
      if (str(meta.plan)) patch.plan = str(meta.plan);
      if (str(meta.interval)) patch.interval = str(meta.interval);
      // Un paiement après un départ est une réactivation : la sortie est levée,
      // mais `firstPaidAt` reste celle de la première fois.
      if (existing?.churnedAt) {
        patch.churnedAt = null;
        patch.churnReason = null;
      }
      break;
    }

    case 'plan_upgraded':
    case 'plan_downgraded': {
      if (str(meta.plan)) patch.plan = str(meta.plan);
      if (str(meta.interval)) patch.interval = str(meta.interval);
      const mrr = num(meta.mrrCents);
      if (mrr !== null) patch.mrrCents = mrr;
      break;
    }

    case 'subscription_ended':
      if (!existing?.churnedAt) {
        patch.churnedAt = at;
        patch.churnReason = (str(meta.churnReason) ?? 'VOLUNTARY') as ChurnReason;
      }
      patch.mrrCents = 0;
      break;

    case 'payment_failed':
      // Pas un churn : Stripe réessaie plusieurs jours. C'est
      // `subscription_ended` qui tranchera si l'impayé persiste.
      break;

    case 'access_expired':
      if (!existing?.churnedAt) {
        patch.churnedAt = at;
        patch.churnReason = 'TRIAL_EXPIRED' satisfies ChurnReason;
      }
      patch.mrrCents = 0;
      break;

    case 'code_activated':
      if (!existing?.activationOrigin) {
        patch.activationOrigin = (str(meta.origin) ?? 'CODE') as ActivationOrigin;
      }
      break;

    case 'gift_redeemed':
      if (!existing?.activationOrigin) patch.activationOrigin = 'GIFT' satisfies ActivationOrigin;
      break;

    default:
      // Les étapes d'amont (`site_visit`, `pricing_viewed`…) n'ont pas de
      // serveur : elles vivent dans le journal seul.
      break;
  }

  return patch;
}

// ─────────────────────────────────────────────────────────────
// Écriture
// ─────────────────────────────────────────────────────────────

/**
 * Enregistre le franchissement d'une étape.
 *
 * N'attend rien de l'appelant : ni `await`, ni gestion d'erreur. Une étape
 * inconnue est refusée ici plutôt qu'écrite - c'est la dernière barrière avant
 * la base, et une colonne `step` alimentée par n'importe quelle chaîne rendrait
 * le tunnel illisible.
 */
export async function recordAcquisitionStep(input: AcquisitionStepInput): Promise<void> {
  if (!isAcquisitionStep(input.step)) {
    logger.warn('Acquisition', `Étape inconnue ignorée : « ${String(input.step)} ».`);
    return;
  }

  const at = input.occurredAt ?? new Date();

  try {
    await prisma.acquisitionEvent.create({
      data: {
        step: input.step,
        guildId: input.guildId ?? null,
        actorHash: hashActor(input.discordUserId),
        visitorId: input.visitorId ?? null,
        source: input.source ?? null,
        campaign: input.campaign ?? null,
        content: input.content ?? null,
        metadata: (input.metadata ?? undefined) as never,
        occurredAt: at,
      },
    });
  } catch (error) {
    logger.warn('Acquisition', `Événement « ${input.step} » non enregistré : ${String(error)}`);
    // On tente quand même la projection : perdre le fait brut est moins grave
    // que laisser l'état du serveur en arrière.
  }

  if (!input.guildId) return;

  try {
    const existing = await prisma.guildLifecycle.findUnique({ where: { guildId: input.guildId } });
    const patch = projectStep(input, existing, at);
    if (Object.keys(patch).length === 0) return;

    await prisma.guildLifecycle.upsert({
      where: { guildId: input.guildId },
      update: patch,
      create: { guildId: input.guildId, ...patch },
    });
  } catch (error) {
    logger.warn('Acquisition', `Projection de « ${input.step} » en échec pour ${input.guildId}: ${String(error)}`);
  }
}

/**
 * Serveurs dont l'ouverture du dashboard a deja ete signalee dans ce processus.
 *
 * `dashboard_first_open` doit etre pose une seule fois, mais la route qui le
 * declenche est appelee a chaque chargement de page. Sans ce filtre en memoire,
 * chaque affichage couterait une lecture de `GuildLifecycle` pour decouvrir
 * qu'il n'y a rien a ecrire.
 *
 * Un redemarrage vide l'ensemble : on refera alors une lecture inutile par
 * serveur, ce qui est sans consequence - la projection, elle, n'ecrase pas une
 * date deja posee.
 */
const dashboardOpenSeen = new Set<string>();

/**
 * Signale que le dashboard a ete ouvert pour ce serveur.
 *
 * Etape charniere du tunnel : elle separe les serveurs ou le bot a ete pose
 * puis oublie de ceux ou quelqu'un est reellement venu s'en servir. Sans elle,
 * les deux se ressemblent.
 */
export function trackDashboardOpen(guildId: string): void {
  if (dashboardOpenSeen.has(guildId)) return;
  dashboardOpenSeen.add(guildId);
  void recordAcquisitionStep({ step: 'dashboard_first_open', guildId });
}

/**
 * Variante sans `await` pour les chemins critiques.
 *
 * Existe pour rendre l'intention lisible à l'appel : `void record(...)` se lit
 * comme un oubli, `trackAcquisitionStep(...)` comme une décision.
 */
export function trackAcquisitionStep(input: AcquisitionStepInput): void {
  void recordAcquisitionStep(input);
}
