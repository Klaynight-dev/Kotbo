/**
 * Le serveur a-t-il fini son parcours de configuration ?
 *
 * Une seule chose y repond : `Guild.onboardingCompletedAt`. Ni l'offre, ni un
 * acces accorde a la main, ni le statut de la personne connectee, ni ce que
 * garde son navigateur.
 *
 * C'etait le defaut de la regle precedente, qui deduisait le parcours de
 * l'offre : « FREE, sans abonnement, sans acces accorde, sans code ». Un
 * serveur passe en CUSTOM lors d'une reprise, un code genere depuis le panneau
 * d'administration, un geste commercial - autant de fils par lesquels le
 * parcours disparaissait d'un serveur qui ne l'avait jamais traverse. Comme ce
 * sont les administrateurs du bot qui disposent de ces gestes, leurs propres
 * serveurs y echappaient systematiquement : le parcours semblait « saute pour
 * les admins » alors qu'il l'etait pour tout serveur deja servi.
 *
 * Le parcours ne se termine donc plus que de deux manieres, toutes deux ecrites
 * cote serveur : le paiement (`syncSubscription`), ou le dernier ecran lorsqu'il
 * n'y a rien a payer - instance sans facturation, ou serveur dont l'acces a deja
 * ete accorde. Les deux passent par `markOnboardingComplete`.
 *
 * Ce module sert aussi a decider si une route de configuration doit s'ouvrir
 * alors que son module est eteint par l'offre. Le parcours demande a
 * l'administrateur de regler sa moderation, son accueil, son reglement, ses
 * tickets et ses niveaux avant de payer - c'est tout l'interet, il voit ce qu'il
 * achete. Or aucun de ces modules ne figure dans l'offre FREE : la garde des
 * modules refusait ces ecritures, et le parcours butait des l'ecran de
 * moderation sur un serveur qui n'avait, par construction, encore rien pris.
 *
 * Ouvrir l'ecriture n'ouvre pas le service. `moduleGate` continue d'eteindre
 * ces modules au runtime tant que l'offre ne les comprend pas : la ligne est
 * ecrite, elle ne s'applique pas, et le paiement la revele sans qu'aucun
 * traitement n'ait a repasser derriere.
 */
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { isBillingEnabled, sellablePlans } from '../billing/stripeService.js';

/**
 * Segments que le parcours ecrit avant tout paiement.
 *
 * Liste fermee et courte : chaque ajout ouvre une surface d'ecriture a un
 * serveur qui n'a rien pris. N'y mettre qu'un segment qu'un ecran du parcours
 * touche reellement.
 */
export const WIZARD_CONFIG_SEGMENTS = new Set([
  // Ecran « modération » : les filtres de message.
  'automod',
  'banned-words',
  // Ecran « modération » : les seuils anti-raid.
  'raid-protection',
  // Ecran « accueil » : le message de bienvenue.
  'announcement',
  'welcome',
  'welcome-thread',
  // Ecran « règlement » : les articles, puis leur publication.
  'regulation',
  // Ecran « support » : les motifs d'ouverture et la couleur du panneau.
  'tickets',
  // Ecran « progression » : le rythme d'XP et les rôles de palier.
  'leveling',
  // Ecran « logs » : salons et durée de rétention.
  'logs',
  'message-logs',
  'audit-events',
  // Ecran « économie » et boutique RPG.
  'economy',
  'rpg',
  'shop',
  // Ecran « quêtes ».
  'quests',
  // Ecran « drops ».
  'drops',
  // Ecran « mcp ».
  'mcp-keys',
  'mcp-logs',
]);

/** Court : l'etat change une fois, a la fin du parcours, et doit se voir aussitot. */
const CACHE_TTL_SECONDS = 30;

const cacheKeyFor = (guildId: string) => `guild:${guildId}:onboarding_required`;

/**
 * L'instance presente-t-elle un parcours ?
 *
 * Sans facturation en production (sauf `ENABLE_ONBOARDING`), il n'y a rien a
 * mettre en service : une installation auto-hebergee n'a pas d'offre a vendre,
 * et servir le parcours a tous ses serveurs les enfermerait dans un ecran de
 * paiement qui n'existe pas.
 */
export function isOnboardingFeatureEnabled(): boolean {
  return isBillingEnabled()
    || process.env.NODE_ENV !== 'production'
    || process.env.ENABLE_ONBOARDING === 'true';
}

/** Les champs d'acces que lit `canFinishOnboardingWithoutPayment`. */
export type GuildEntitlementFields = {
  plan: string | null;
  stripeSubscriptionId: string | null;
  accessType: string | null;
  activationCode: string | null;
};

/**
 * Le dernier ecran peut-il se conclure sans passer par Stripe ?
 *
 * Deux cas : l'instance ne facture pas, ou le serveur a deja recu son acces
 * autrement - offre posee a la main, abonnement en cours, code d'activation,
 * partenariat. Ces serveurs traversent le parcours comme les autres ; ce qu'on
 * leur epargne, c'est de payer une seconde fois ce qu'ils ont deja.
 *
 * Volontairement distinct de « le parcours est fini » : c'est une porte de
 * sortie, pas un contournement. Il faut avoir atteint le dernier ecran.
 */
export function canFinishOnboardingWithoutPayment(guild: GuildEntitlementFields): boolean {
  if (!isBillingEnabled()) return true;
  // Facturation branchee mais aucune offre vendable - un `price_...` manquant
  // dans le `.env` : reclamer un paiement impossible enfermerait le serveur
  // dans son dernier ecran.
  if (sellablePlans().length === 0) return true;
  return (guild.plan ?? 'FREE') !== 'FREE'
    || !!guild.stripeSubscriptionId
    || (guild.accessType ?? 'PERMANENT') !== 'PERMANENT'
    || !!guild.activationCode;
}

export async function isGuildInOnboarding(guildId: string): Promise<boolean> {
  const cached = await cache.get<boolean>(cacheKeyFor(guildId));
  if (typeof cached === 'boolean') return cached;

  try {
    if (!isOnboardingFeatureEnabled()) {
      await cache.set(cacheKeyFor(guildId), false, CACHE_TTL_SECONDS);
      return false;
    }

    const guild = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { onboardingCompletedAt: true },
    });

    const inOnboarding = !!guild && !guild.onboardingCompletedAt;

    await cache.set(cacheKeyFor(guildId), inOnboarding, CACHE_TTL_SECONDS);
    return inOnboarding;
  } catch (err) {
    // Une base injoignable ne doit pas ouvrir des ecritures : on refuse, la
    // garde des modules reprend la main comme avant.
    logger.error('Onboarding', `Lecture de l'etat de parcours impossible pour ${guildId}:`, err);
    return false;
  }
}

/**
 * Clot le parcours d'un serveur.
 *
 * Idempotent, et la date ne se reecrit pas : c'est la premiere mise en service
 * qui fait foi, un changement d'offre plus tard ne la deplace pas.
 */
export async function markOnboardingComplete(guildId: string, reason: string): Promise<void> {
  try {
    const updated = await prisma.guild.updateMany({
      where: { id: guildId, onboardingCompletedAt: null },
      data: { onboardingCompletedAt: new Date() },
    });

    await cache.delete(cacheKeyFor(guildId));

    if (updated.count > 0) {
      logger.info('Onboarding', `Parcours termine pour ${guildId} (${reason}).`);

      // `updateMany` filtre sur `onboardingCompletedAt: null` : un compte non
      // nul signifie donc que le parcours vient reellement de s'achever, et non
      // qu'on repasse par la. C'est cette garde qui rend l'etape non
      // duplicable, sans verrou supplementaire.
      //
      // Le type de communaute et les pistes sont relus depuis l'etat du
      // parcours : ce sont eux qui repondent a « a quel public Kotbo se vend
      // reellement », et c'est le dernier moment ou ils sont surs.
      const row = await prisma.guild
        .findUnique({ where: { id: guildId }, select: { onboardingState: true } })
        .catch(() => null);
      const state = (row?.onboardingState ?? null) as { kind?: unknown; tracks?: unknown } | null;

      const { trackAcquisitionStep } = await import('../analytics/acquisitionService.js');
      trackAcquisitionStep({
        step: 'onboarding_completed',
        guildId,
        metadata: {
          reason,
          serverKind: typeof state?.kind === 'string' ? state.kind : null,
          tracks: Array.isArray(state?.tracks) ? state.tracks : [],
        },
      });
    }
  } catch (err) {
    logger.error('Onboarding', `Impossible de cloturer le parcours de ${guildId}:`, err);
    throw err;
  }
}
