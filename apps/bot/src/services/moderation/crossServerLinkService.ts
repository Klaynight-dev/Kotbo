import type { Client } from 'discord.js';
import { LinkedAccountStatus, LinkedAccountType } from '@prisma/client';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { getSharingSiblingGuildIds } from './crossServerSanctionService.js';
import type { DcSignal } from './dc/types.js';

/**
 * Liens de double comptes déjà posés sur d'AUTRES serveurs.
 *
 * Deux usages :
 *  - Détection : si le staff d'un autre serveur a déjà lié ce membre à un autre
 *    compte, c'est une preuve forte. Plus le nombre de serveurs ayant posé le
 *    même lien est élevé, plus le score monte (voir `crossServerLinkScore`).
 *  - Fiche membre : on suggère au modérateur de reproduire ici un lien qui
 *    existe déjà ailleurs, sans l'appliquer automatiquement.
 *
 * Confidentialité : exactement les mêmes règles que le casier cross-serveur
 * (`getSharingSiblingGuildIds`) - même instance white-label, partage réciproque.
 * On n'expose jamais qui a posé le lien sur le serveur distant, seulement le nom
 * du serveur, le type de lien, son statut et sa date.
 */

const CACHE_TTL_SECONDS = 90;
const MAX_LINK_ROWS = 400;
const MAX_SUGGESTIONS = 12;
const MAX_GUILDS_PER_SUGGESTION = 8;
const MAX_REASON_LENGTH = 200;

/** Plafond du bonus de score apporté par les liens distants. */
const CROSS_SERVER_LINK_SCORE_CAP = 85;
/** Poids du serveur le plus probant, puis des suivants (rendements décroissants). */
const FIRST_GUILD_WEIGHT = 40;
const EXTRA_GUILD_WEIGHT = 18;

export type CrossServerLinkGuild = {
  guildId: string;
  guildName: string;
  type: LinkedAccountType;
  status: LinkedAccountStatus;
  reason: string | null;
  linkedAt: string;
};

export type CrossServerLinkSuggestion = {
  /** L'autre compte du lien (le "partenaire"). */
  userId: string;
  userTag: string | null;
  avatarUrl: string | null;
  /** Le partenaire est-il connu sur le serveur courant (profil existant, non parti) ? */
  presentOnGuild: boolean;
  /** Le lien existe-t-il déjà ici ? Si oui, il n'y a rien à suggérer au staff. */
  alreadyLinkedHere: boolean;
  /** Nombre de serveurs distincts portant ce lien. */
  serverCount: number;
  /** Parmi eux, combien l'ont posé à la main (décision humaine, plus probante). */
  manualCount: number;
  guilds: CrossServerLinkGuild[];
  /** Bonus de score de détection apporté par ce lien (0-85). */
  score: number;
};

export type CrossServerLinkSummary = {
  /** true si le serveur courant participe au partage cross-serveur. */
  enabled: boolean;
  /** Nombre de serveurs distincts, tous partenaires confondus. */
  serverCount: number;
  suggestions: CrossServerLinkSuggestion[];
};

function disabledSummary(): CrossServerLinkSummary {
  return { enabled: false, serverCount: 0, suggestions: [] };
}

/**
 * Poids d'un serveur dans le score, selon la nature du lien qu'il porte.
 *
 * Un lien posé à la main par un staff est une décision humaine. Un lien
 * AUTOMATIC n'est que la détection du bot rejouée ailleurs : le compter aussi
 * fort créerait une boucle d'auto-confirmation entre serveurs (A détecte, B lit
 * A et détecte, C lit A et B...). Il pèse donc nettement moins.
 * Un lien REJECTED est une preuve *contre* : il ne compte pas du tout.
 */
function guildWeight(link: { type: LinkedAccountType; status: LinkedAccountStatus }): number {
  if (link.status === LinkedAccountStatus.REJECTED) return 0;
  const manual = link.type === LinkedAccountType.MANUAL;
  if (link.status === LinkedAccountStatus.VALIDATED) return manual ? 1 : 0.6;
  return manual ? 0.5 : 0.3; // PENDING
}

/**
 * Score apporté par un même lien présent sur plusieurs serveurs.
 *
 * Le serveur le plus probant porte l'essentiel du score ; chaque serveur
 * supplémentaire ajoute moins, mais le total reste strictement croissant avec le
 * nombre de serveurs - c'est tout l'intérêt du signal.
 */
export function crossServerLinkScore(links: { type: LinkedAccountType; status: LinkedAccountStatus }[]): number {
  const weights = links.map(guildWeight).filter((w) => w > 0).sort((a, b) => b - a);
  if (weights.length === 0) return 0;
  const raw = FIRST_GUILD_WEIGHT * weights[0]
    + EXTRA_GUILD_WEIGHT * weights.slice(1).reduce((sum, w) => sum + w, 0);
  return Math.min(CROSS_SERVER_LINK_SCORE_CAP, Math.round(raw));
}

function buildCacheKey(guildId: string, userId: string): string {
  return `xlink:${guildId}:${userId}`;
}

function truncateReason(reason: string | null): string | null {
  if (!reason) return null;
  return reason.length > MAX_REASON_LENGTH ? `${reason.slice(0, MAX_REASON_LENGTH)}…` : reason;
}

/**
 * Regroupe par partenaire les liens portant sur `userId` sur les serveurs frères.
 *
 * Cœur commun de la détection et de la fiche membre : une seule requête, pas de
 * client Discord requis (les noms de serveurs sont résolus plus haut).
 */
async function fetchPartnerLinks(
  guildId: string,
  userId: string,
): Promise<Map<string, CrossServerLinkGuild[]> | null> {
  const siblingIds = await getSharingSiblingGuildIds(guildId);
  if (siblingIds === null) return null;
  if (siblingIds.length === 0) return new Map();

  const rows = await prisma.linkedAccount.findMany({
    where: {
      guildId: { in: siblingIds },
      status: { not: LinkedAccountStatus.REJECTED },
      OR: [{ user1Id: userId }, { user2Id: userId }],
    },
    select: {
      guildId: true,
      user1Id: true,
      user2Id: true,
      type: true,
      status: true,
      reason: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
    take: MAX_LINK_ROWS,
  });

  const byPartner = new Map<string, CrossServerLinkGuild[]>();
  for (const row of rows) {
    const partnerId = row.user1Id === userId ? row.user2Id : row.user1Id;
    if (partnerId === userId) continue;
    const entries = byPartner.get(partnerId) ?? [];
    entries.push({
      guildId: row.guildId,
      guildName: row.guildId, // résolu plus tard, quand un client Discord est disponible
      type: row.type,
      status: row.status,
      reason: truncateReason(row.reason),
      linkedAt: row.createdAt.toISOString(),
    });
    byPartner.set(partnerId, entries);
  }

  return byPartner;
}

/**
 * Signaux de détection tirés des liens déjà posés sur d'autres serveurs.
 *
 * Un signal par partenaire, dont le score croît avec le nombre de serveurs
 * concernés. Utilisé à l'arrivée d'un membre comme au recalcul depuis le
 * dashboard - aucune dépendance à un objet Discord.
 */
export async function computeCrossServerLinkSignals(guildId: string, userId: string): Promise<DcSignal[]> {
  let byPartner: Map<string, CrossServerLinkGuild[]> | null;
  try {
    byPartner = await fetchPartnerLinks(guildId, userId);
  } catch (err) {
    logger.error('CrossServerLinks', `Erreur calcul des signaux pour ${userId} sur ${guildId}: ${String(err)}`);
    return [];
  }
  if (!byPartner || byPartner.size === 0) return [];

  const signals: DcSignal[] = [];
  for (const [partnerId, guilds] of byPartner) {
    const score = crossServerLinkScore(guilds);
    if (score <= 0) continue;

    const serverCount = new Set(guilds.map((g) => g.guildId)).size;
    const manualCount = guilds.filter((g) => g.type === LinkedAccountType.MANUAL).length;
    const validatedCount = guilds.filter((g) => g.status === LinkedAccountStatus.VALIDATED).length;
    const plural = serverCount > 1 ? 's' : '';

    signals.push({
      type: 'cross_server_link',
      score,
      label: `Déjà lié à <@${partnerId}> sur ${serverCount} autre${plural} serveur${plural}`,
      matchedUserId: partnerId,
      detail:
        `Le lien existe sur ${serverCount} serveur${plural} de la même instance `
        + `(${validatedCount} validé${validatedCount > 1 ? 's' : ''}, ${manualCount} posé${manualCount > 1 ? 's' : ''} manuellement par un staff). `
        + `Le score augmente avec le nombre de serveurs ayant posé le même lien.`,
    });
  }

  // Les partenaires les plus corroborés d'abord : c'est ce que le staff doit voir.
  signals.sort((a, b) => b.score - a.score);
  return signals.slice(0, MAX_SUGGESTIONS);
}

/**
 * Résumé affiché dans la fiche membre : « ce compte est déjà lié à X ailleurs ».
 * Mémoïsé (cache L1 + L2) comme le casier cross-serveur.
 */
export async function getCrossServerLinkSummary(
  client: Client,
  guildId: string,
  userId: string,
): Promise<CrossServerLinkSummary> {
  if (!/^\d{15,25}$/.test(userId)) return disabledSummary();

  const cacheKey = buildCacheKey(guildId, userId);
  const cached = await cache.get<CrossServerLinkSummary>(cacheKey).catch(() => null);
  if (cached) return cached;

  try {
    const summary = await computeLinkSummary(client, guildId, userId);
    await cache.set(cacheKey, summary, CACHE_TTL_SECONDS).catch(() => {});
    return summary;
  } catch (err) {
    logger.error('CrossServerLinks', `Erreur calcul du résumé pour ${userId} sur ${guildId}: ${String(err)}`);
    return disabledSummary();
  }
}

async function computeLinkSummary(
  client: Client,
  guildId: string,
  userId: string,
): Promise<CrossServerLinkSummary> {
  const byPartner = await fetchPartnerLinks(guildId, userId);
  if (byPartner === null) return disabledSummary();
  if (byPartner.size === 0) return { ...disabledSummary(), enabled: true };

  const partnerIds = [...byPartner.keys()];

  // Un seul aller-retour pour les profils locaux et pour les liens déjà posés ici.
  const [profiles, localLinks] = await Promise.all([
    prisma.memberProfile.findMany({
      where: { guildId, userId: { in: partnerIds } },
      select: { userId: true, userTag: true, username: true, displayName: true, avatarUrl: true, guildLeftAt: true },
    }).catch(() => []),
    prisma.linkedAccount.findMany({
      where: {
        guildId,
        OR: [
          { user1Id: userId, user2Id: { in: partnerIds } },
          { user2Id: userId, user1Id: { in: partnerIds } },
        ],
      },
      select: { user1Id: true, user2Id: true },
    }).catch(() => []),
  ]);

  const profileById = new Map(profiles.map((p) => [p.userId, p]));
  const linkedHere = new Set(localLinks.map((l) => (l.user1Id === userId ? l.user2Id : l.user1Id)));

  const resolveGuildName = (id: string): string => client.guilds.cache.get(id)?.name ?? 'Serveur inconnu';

  const allGuilds = new Set<string>();
  const suggestions: CrossServerLinkSuggestion[] = [];

  for (const [partnerId, guilds] of byPartner) {
    const score = crossServerLinkScore(guilds);
    if (score <= 0) continue;

    for (const g of guilds) allGuilds.add(g.guildId);

    const profile = profileById.get(partnerId);
    suggestions.push({
      userId: partnerId,
      userTag: profile?.displayName ?? profile?.userTag ?? profile?.username ?? null,
      avatarUrl: profile?.avatarUrl ?? null,
      presentOnGuild: !!profile && !profile.guildLeftAt,
      alreadyLinkedHere: linkedHere.has(partnerId),
      serverCount: new Set(guilds.map((g) => g.guildId)).size,
      manualCount: guilds.filter((g) => g.type === LinkedAccountType.MANUAL).length,
      guilds: guilds
        .slice(0, MAX_GUILDS_PER_SUGGESTION)
        .map((g) => ({ ...g, guildName: resolveGuildName(g.guildId) })),
      score,
    });
  }

  // À traiter en premier : ce qui n'est pas encore lié ici, puis le plus corroboré.
  suggestions.sort((a, b) => Number(a.alreadyLinkedHere) - Number(b.alreadyLinkedHere) || b.score - a.score);

  return {
    enabled: true,
    serverCount: allGuilds.size,
    suggestions: suggestions.slice(0, MAX_SUGGESTIONS),
  };
}
