import type { Client } from 'discord.js';
import { SanctionType, SanctionStatus } from '@prisma/client';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';

/**
 * Casier "cross-serveur".
 *
 * Objectif : dans le casier d'un membre (commande /casier + modal dashboard), afficher
 * si le même utilisateur - ou l'un de ses comptes liés (DC) - a déjà été sanctionné sur
 * un AUTRE serveur du bot.
 *
 * Règles de confidentialité :
 *  - Le partage est scopé à la même instance white-label (`Guild.instanceId`). Deux
 *    opérateurs de bot différents ne voient jamais les données l'un de l'autre.
 *  - Réciprocité : un serveur dont `crossServerSanctionsEnabled` est désactivé ne partage
 *    plus ses sanctions ET ne voit plus celles des autres.
 *  - On n'expose pas le modérateur des sanctions étrangères (seulement type, durée,
 *    raison, date, statut et le nom du serveur source).
 *
 * Performance : le résultat est mémoïsé (cache L1 mémoire + L2 Redis) avec un TTL court,
 * la clé dépendant du serveur courant et de l'ensemble trié des comptes liés. On évite
 * ainsi de recalculer à chaque ouverture / clic dans le casier.
 */

const CACHE_TTL_SECONDS = 90;
const RECENT_LIMIT = 8;
const MAX_SIBLING_GUILDS = 200;

export type CrossServerSanctionEntry = {
  type: SanctionType;
  status: SanctionStatus;
  durationSeconds: number | null;
  reason: string;
  createdAt: string;
  guildId: string;
  guildName: string;
};

const MAX_REASON_LENGTH = 280;

export type CrossServerSanctionSummary = {
  /** true si le serveur courant participe au partage cross-serveur. */
  enabled: boolean;
  /** Nombre de serveurs distincts (autres que le courant) ayant au moins une sanction. */
  serverCount: number;
  /** Nombre total de sanctions cumulées sur les autres serveurs. */
  total: number;
  /** Décompte par type de sanction. */
  breakdown: Record<SanctionType, number>;
  /** Les sanctions les plus récentes (limitées), pour affichage détaillé. */
  recent: CrossServerSanctionEntry[];
};

function emptyBreakdown(): Record<SanctionType, number> {
  return { WARN: 0, KICK: 0, TIMEOUT: 0, TEMP_BAN: 0, BAN: 0, SOFTBAN: 0 };
}

function disabledSummary(): CrossServerSanctionSummary {
  return { enabled: false, serverCount: 0, total: 0, breakdown: emptyBreakdown(), recent: [] };
}

function buildCacheKey(guildId: string, userIds: string[]): string {
  const sorted = [...new Set(userIds)].sort().join(',');
  return `xsanc:${guildId}:${sorted}`;
}

/**
 * Calcule le résumé des sanctions du membre (et de ses comptes liés) sur les autres
 * serveurs de la même instance. Résultat mémoïsé.
 *
 * @param linkedUserIds Ensemble des IDs à considérer (l'utilisateur + ses DC). Doit déjà
 *   inclure l'utilisateur lui-même.
 */
export async function getCrossServerSanctionSummary(
  client: Client,
  guildId: string,
  userIds: string[],
): Promise<CrossServerSanctionSummary> {
  const targetIds = [...new Set(userIds)].filter((id) => /^\d{15,25}$/.test(id));
  if (targetIds.length === 0) return disabledSummary();

  const cacheKey = buildCacheKey(guildId, targetIds);
  const cached = await cache.get<CrossServerSanctionSummary>(cacheKey).catch(() => null);
  if (cached) return cached;

  try {
    const summary = await computeSummary(client, guildId, targetIds);
    await cache.set(cacheKey, summary, CACHE_TTL_SECONDS).catch(() => {});
    return summary;
  } catch (err) {
    logger.error('CrossServerSanctions', `Erreur calcul résumé pour ${guildId}: ${String(err)}`);
    return disabledSummary();
  }
}

/**
 * Serveurs avec lesquels `guildId` partage ses donnees de moderation.
 *
 * Meme instance white-label, partage active des deux cotes, serveur courant exclu.
 * Retourne `null` si le serveur courant ne participe pas au partage : la
 * reciprocite veut qu'il ne voie alors rien non plus. Un tableau vide signifie
 * qu'il participe mais n'a aucun serveur frere.
 *
 * Partage par le casier cross-serveur et par la detection de double comptes, qui
 * doivent obeir exactement aux memes regles de confidentialite.
 */
export async function getSharingSiblingGuildIds(guildId: string): Promise<string[] | null> {
  const self = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { instanceId: true, crossServerSanctionsEnabled: true },
  });

  // Le serveur courant doit exister et participer au partage.
  if (!self || !self.crossServerSanctionsEnabled) return null;

  const siblings = await prisma.guild.findMany({
    where: {
      instanceId: self.instanceId ?? null,
      crossServerSanctionsEnabled: true,
      id: { not: guildId },
    },
    select: { id: true },
    take: MAX_SIBLING_GUILDS,
  });

  return siblings.map((g) => g.id);
}

async function computeSummary(
  client: Client,
  guildId: string,
  targetIds: string[],
): Promise<CrossServerSanctionSummary> {
  const siblingIds = await getSharingSiblingGuildIds(guildId);

  if (siblingIds === null) {
    return disabledSummary();
  }

  if (siblingIds.length === 0) {
    return { ...disabledSummary(), enabled: true };
  }

  const where = {
    guildId: { in: siblingIds },
    targetUserId: { in: targetIds },
  } as const;

  // Un seul groupBy (guildId, type) fournit à la fois le total, le décompte par type
  // et le nombre exact de serveurs distincts - inutile d'une requête `distinct` séparée.
  const [grouped, recentRows] = await Promise.all([
    prisma.sanction.groupBy({
      by: ['guildId', 'type'],
      where,
      _count: { _all: true },
    }),
    prisma.sanction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: RECENT_LIMIT,
      select: { type: true, status: true, durationSeconds: true, reason: true, createdAt: true, guildId: true },
    }),
  ]);

  const breakdown = emptyBreakdown();
  const guildsWithSanctions = new Set<string>();
  let total = 0;
  for (const row of grouped) {
    const count = row._count._all;
    breakdown[row.type] += count;
    total += count;
    guildsWithSanctions.add(row.guildId);
  }

  if (total === 0) {
    return { ...disabledSummary(), enabled: true };
  }

  const resolveGuildName = (id: string): string =>
    client.guilds.cache.get(id)?.name ?? 'Serveur inconnu';

  const recent: CrossServerSanctionEntry[] = recentRows.map((row) => ({
    type: row.type,
    status: row.status,
    durationSeconds: row.durationSeconds,
    reason: row.reason.length > MAX_REASON_LENGTH ? `${row.reason.slice(0, MAX_REASON_LENGTH)}…` : row.reason,
    createdAt: row.createdAt.toISOString(),
    guildId: row.guildId,
    guildName: resolveGuildName(row.guildId),
  }));

  return {
    enabled: true,
    serverCount: guildsWithSanctions.size,
    total,
    breakdown,
    recent,
  };
}
