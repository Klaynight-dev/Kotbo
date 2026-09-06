// ============================================================================
// ARCHIVAGE, VERROU D'APPEL ET SUPPRESSION DES SANCTIONS
//
// Trois gestes distincts, volontairement séparés :
//   - archiver   : la sanction est désactivée mais conservée. Elle quitte le
//                  casier actif et (sauf `countArchivedInWarnScore`) cesse de
//                  peser dans le score de warns et l'escalade automatique.
//   - verrouiller: la sanction reste au casier mais n'est plus contestable.
//   - supprimer  : la ligne disparaît. Irréversible.
//
// Le module Appels et la page Sanctions du dashboard passent tous les deux par
// ici : le verdict d'un appel et l'action manuelle du staff doivent produire
// exactement le même effet.
// ============================================================================

import { Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

/** Filtre Prisma des sanctions « vivantes » (non archivées). */
export const NOT_ARCHIVED: Prisma.SanctionWhereInput = { archivedAt: null };

/**
 * Le score de warns doit-il inclure les sanctions archivées ?
 * Par défaut non : archiver, c'est désactiver.
 */
export async function countsArchivedInScore(guildId: string): Promise<boolean> {
  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { countArchivedInWarnScore: true },
  });
  return guild?.countArchivedInWarnScore ?? false;
}

/**
 * Fragment `where` à fusionner dans les requêtes de score/escalade : vide si la
 * guilde compte les archives, sinon `archivedAt: null`.
 */
export async function archiveScoreFilter(guildId: string): Promise<Prisma.SanctionWhereInput> {
  return (await countsArchivedInScore(guildId)) ? {} : NOT_ARCHIVED;
}

export type ArchiveActor = { userId: string; tag?: string | null };

export type BulkSanctionResult = {
  /** Nombre de lignes réellement modifiées (les ids inconnus sont ignorés). */
  count: number;
  /** Ids retenus après filtrage sur la guilde. */
  ids: string[];
};

/** Ne garde que les ids de sanctions appartenant réellement à la guilde. */
async function scopeToGuild(guildId: string, sanctionIds: string[]): Promise<string[]> {
  const unique = [...new Set(sanctionIds.filter(id => typeof id === 'string' && id.length > 0))];
  if (unique.length === 0) return [];
  const rows = await prisma.sanction.findMany({
    where: { guildId, id: { in: unique } },
    select: { id: true },
  });
  return rows.map(r => r.id);
}

/**
 * Archive une ou plusieurs sanctions (désactivées mais conservées).
 * Les sanctions déjà archivées sont laissées telles quelles pour ne pas écraser
 * l'auteur et la date d'archivage d'origine.
 */
export async function archiveSanctions(
  guildId: string,
  sanctionIds: string[],
  actor: ArchiveActor,
  reason?: string | null
): Promise<BulkSanctionResult> {
  const ids = await scopeToGuild(guildId, sanctionIds);
  if (ids.length === 0) return { count: 0, ids: [] };

  const result = await prisma.sanction.updateMany({
    where: { guildId, id: { in: ids }, archivedAt: null },
    data: {
      archivedAt: new Date(),
      archivedByUserId: actor.userId,
      archiveReason: reason?.trim() ? reason.trim().slice(0, 500) : null,
    },
  });

  logger.info('SanctionArchive', `${result.count} sanction(s) archivée(s) sur ${guildId} par ${actor.tag || actor.userId}`);
  return { count: result.count, ids };
}

/** Remet des sanctions archivées dans le casier actif. */
export async function unarchiveSanctions(
  guildId: string,
  sanctionIds: string[],
  actor: ArchiveActor
): Promise<BulkSanctionResult> {
  const ids = await scopeToGuild(guildId, sanctionIds);
  if (ids.length === 0) return { count: 0, ids: [] };

  const result = await prisma.sanction.updateMany({
    where: { guildId, id: { in: ids }, archivedAt: { not: null } },
    data: { archivedAt: null, archivedByUserId: null, archiveReason: null },
  });

  logger.info('SanctionArchive', `${result.count} sanction(s) désarchivée(s) sur ${guildId} par ${actor.tag || actor.userId}`);
  return { count: result.count, ids };
}

/**
 * Verrouille (ou déverrouille) la contestation d'une ou plusieurs sanctions.
 * Verrouillée = le membre ne peut plus jamais la contester, même après cooldown.
 */
export async function setSanctionAppealLock(
  guildId: string,
  sanctionIds: string[],
  locked: boolean,
  actor: ArchiveActor,
  reason?: string | null
): Promise<BulkSanctionResult> {
  const ids = await scopeToGuild(guildId, sanctionIds);
  if (ids.length === 0) return { count: 0, ids: [] };

  const result = await prisma.sanction.updateMany({
    where: { guildId, id: { in: ids } },
    data: locked
      ? {
          appealable: false,
          appealLockedAt: new Date(),
          appealLockedByUserId: actor.userId,
          appealLockReason: reason?.trim() ? reason.trim().slice(0, 500) : null,
        }
      : {
          appealable: true,
          appealLockedAt: null,
          appealLockedByUserId: null,
          appealLockReason: null,
        },
  });

  return { count: result.count, ids };
}

/**
 * Supprime définitivement des sanctions.
 *
 * Les lignes `BanAppealSanction` qui les référencent passent à `sanctionId:
 * null` (onDelete: SetNull) et conservent la photo du type/raison/date : un
 * appel tranché par une suppression reste lisible.
 */
export async function deleteSanctions(
  guildId: string,
  sanctionIds: string[],
  actor: ArchiveActor
): Promise<BulkSanctionResult> {
  const ids = await scopeToGuild(guildId, sanctionIds);
  if (ids.length === 0) return { count: 0, ids: [] };

  const result = await prisma.sanction.deleteMany({ where: { guildId, id: { in: ids } } });
  logger.info('SanctionArchive', `${result.count} sanction(s) supprimée(s) sur ${guildId} par ${actor.tag || actor.userId}`);
  return { count: result.count, ids };
}

// ============================================================================
// EXPIRATION AUTOMATIQUE DES WARNS
// ============================================================================

const AUTO_ARCHIVE_ACTOR: ArchiveActor = { userId: 'system', tag: 'Kotbo' };
const AUTO_ARCHIVE_BATCH = 500;

/**
 * Archive les warns dépassant `warnAutoArchiveDays` sur les guildes qui ont
 * activé l'expiration automatique. Un warn expiré n'est pas effacé : il rejoint
 * les archives, exactement comme s'il avait été archivé à la main.
 */
export async function runWarnAutoArchive(): Promise<number> {
  const guilds = await prisma.guild.findMany({
    where: { warnAutoArchiveDays: { not: null, gt: 0 } },
    select: { id: true, warnAutoArchiveDays: true },
  });
  if (guilds.length === 0) return 0;

  let total = 0;

  for (const guild of guilds) {
    const days = guild.warnAutoArchiveDays;
    if (!days || days <= 0) continue;

    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const expired = await prisma.sanction.findMany({
      where: { guildId: guild.id, type: 'WARN', archivedAt: null, createdAt: { lt: cutoff } },
      select: { id: true },
      take: AUTO_ARCHIVE_BATCH,
    });
    if (expired.length === 0) continue;

    const result = await prisma.sanction.updateMany({
      where: { id: { in: expired.map(s => s.id) } },
      data: {
        archivedAt: new Date(),
        archivedByUserId: AUTO_ARCHIVE_ACTOR.userId,
        archiveReason: `Expiration automatique après ${days} jours`,
      },
    });

    total += result.count;
    if (result.count > 0) {
      logger.info('SanctionArchive', `${result.count} warn(s) archivé(s) automatiquement sur ${guild.id} (> ${days} jours)`);
    }
  }

  return total;
}
