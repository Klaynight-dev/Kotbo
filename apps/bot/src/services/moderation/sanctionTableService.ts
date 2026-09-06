import { type Client, type Guild, type GuildMember } from 'discord.js';
import { SanctionType } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import {
  registerWarnSanction,
  registerTimeoutSanction,
  registerKickSanction,
  registerBanSanction,
  registerSoftbanSanction,
} from './sanctionService.js';
import { archiveScoreFilter } from './sanctionArchiveService.js';

export type Actor = {
  id: string;
  tag: string;
};

export type Target = {
  id: string;
  tag: string;
};

/**
 * Ensures default progressive sanction tables exist for a guild.
 */
export async function getOrCreateDefaultTables(guildId: string) {
  const existingCount = await prisma.sanctionTable.count({
    where: { guildId },
  });

  if (existingCount > 0) {
    return;
  }

  logger.info('Sanctions', `Initialisation des tables de sanctions par défaut pour le serveur ${guildId}`);

  // Create "Spam" table
  const spamTable = await prisma.sanctionTable.create({
    data: {
      guildId,
      name: 'Spam',
    },
  });

  await prisma.sanctionTier.createMany({
    data: [
      { tableId: spamTable.id, level: 1, action: SanctionType.WARN, customReason: 'Avertissement automatique pour Spam' },
      { tableId: spamTable.id, level: 2, action: SanctionType.TIMEOUT, durationSeconds: 3600, customReason: 'Spam excessif (Timeout 1h)' },
      { tableId: spamTable.id, level: 3, action: SanctionType.TIMEOUT, durationSeconds: 86400, customReason: 'Récidive de Spam (Timeout 24h)' },
      { tableId: spamTable.id, level: 4, action: SanctionType.KICK, customReason: 'Spam persistant après avertissements' },
      { tableId: spamTable.id, level: 5, action: SanctionType.BAN, customReason: 'Bannissement pour Spam' },
    ],
  });

  // Create "Insultes" table
  const insultsTable = await prisma.sanctionTable.create({
    data: {
      guildId,
      name: 'Insultes',
    },
  });

  await prisma.sanctionTier.createMany({
    data: [
      { tableId: insultsTable.id, level: 1, action: SanctionType.WARN, customReason: 'Avertissement pour langage inapproprié / insultes' },
      { tableId: insultsTable.id, level: 2, action: SanctionType.TIMEOUT, durationSeconds: 43200, customReason: 'Insultes / langage agressif (Timeout 12h)' },
      { tableId: insultsTable.id, level: 3, action: SanctionType.TIMEOUT, durationSeconds: 259200, customReason: "Récidive d'insultes (Timeout 3 jours)" },
      { tableId: insultsTable.id, level: 4, action: SanctionType.KICK, customReason: 'Comportement toxique répété' },
      { tableId: insultsTable.id, level: 5, action: SanctionType.BAN, customReason: 'Bannissement définitif pour toxicité extrême' },
    ],
  });
}

/**
 * Gets next tier configuration and details for a member.
 */
export async function getNextTierInfo(params: {
  guildId: string;
  targetUserId: string;
  tableName: string;
  bypassLevel?: number | null;
}) {
  await getOrCreateDefaultTables(params.guildId);

  const table = await prisma.sanctionTable.findFirst({
    where: {
      guildId: params.guildId,
      name: { equals: params.tableName, mode: 'insensitive' },
    },
    include: {
      tiers: {
        orderBy: { level: 'asc' },
      },
    },
  });

  if (!table) {
    throw new Error(`Le tableau de sanction "${params.tableName}" n'existe pas.`);
  }

  let targetLevel = 1;

  if (params.bypassLevel && params.bypassLevel > 0) {
    targetLevel = params.bypassLevel;
  } else {
    // Count how many sanctions under this table the user has already received.
    // Les sanctions archivées ne font plus monter l'escalade, sauf si la guilde
    // a demandé qu'elles restent comptabilisées.
    const count = await prisma.sanction.count({
      where: {
        guildId: params.guildId,
        targetUserId: params.targetUserId,
        sanctionTableId: table.id,
        ...(await archiveScoreFilter(params.guildId)),
      },
    });
    targetLevel = count + 1;
  }

  // Find corresponding tier
  let tier = table.tiers.find((t) => t.level === targetLevel);

  // If level is beyond defined tiers, fetch the highest tier
  if (!tier && table.tiers.length > 0) {
    tier = table.tiers[table.tiers.length - 1];
  }

  return {
    table,
    tier,
    targetLevel,
  };
}

/**
 * Applies a progressive sanction from a specific table to a member.
 */
export async function applyProgressiveSanction(params: {
  guildId: string;
  target: Target;
  moderator: Actor;
  tableName: string;
  bypassLevel?: number | null;
  reason?: string | null;
  guild: Guild;
  member: GuildMember | null;
  client: Client;
}) {
  const { table, tier, targetLevel } = await getNextTierInfo({
    guildId: params.guildId,
    targetUserId: params.target.id,
    tableName: params.tableName,
    bypassLevel: params.bypassLevel,
  });

  const cleanReason = params.reason?.trim();
  const actionReason = cleanReason
    ? `[Tableau: ${table.name} - Tier T${targetLevel}] ${cleanReason}`
    : `[Tableau: ${table.name} - Tier T${targetLevel}]`;
  const customReason = tier?.customReason
    ? (cleanReason ? `${tier.customReason} | ${cleanReason}` : tier.customReason)
    : actionReason;

  if (!tier) {
    // Default fallback if no tiers configured
    const sanction = await registerWarnSanction({
      guildId: params.guildId,
      target: params.target,
      moderator: params.moderator,
      reason: actionReason,
      client: params.client,
    });

    await prisma.sanction.update({
      where: { id: sanction.id },
      data: { sanctionTableId: table.id },
    });

    return { sanction, action: SanctionType.WARN, level: targetLevel, table };
  }

  let sanction;

  switch (tier.action) {
    case SanctionType.WARN: {
      sanction = await registerWarnSanction({
        guildId: params.guildId,
        target: params.target,
        moderator: params.moderator,
        reason: customReason,
        client: params.client,
      });
      break;
    }
    case SanctionType.TIMEOUT: {
      if (!params.member) {
        throw new Error('Le membre doit être présent sur le serveur pour appliquer un timeout.');
      }
      if (!params.member.moderatable) {
        throw new Error('Le bot ne peut pas appliquer de timeout à ce membre (hiérarchie des rôles).');
      }
      const durationMs = (tier.durationSeconds ?? 3600) * 1000;
      sanction = await registerTimeoutSanction({
        guildId: params.guildId,
        target: params.target,
        moderator: params.moderator,
        reason: customReason,
        durationMs,
        member: params.member,
        client: params.client,
      });
      break;
    }
    case SanctionType.KICK: {
      if (!params.member) {
        throw new Error('Le membre doit être présent sur le serveur pour être exclu (kick).');
      }
      if (!params.member.kickable) {
        throw new Error('Le bot ne peut pas exclure ce membre (hiérarchie des rôles).');
      }
      await params.member.kick(`${customReason} | Modérateur: ${params.moderator.tag}`);
      sanction = await registerKickSanction({
        guildId: params.guildId,
        target: params.target,
        moderator: params.moderator,
        reason: customReason,
        client: params.client,
      });
      break;
    }
    case SanctionType.TEMP_BAN: {
      if (params.member && !params.member.bannable) {
        throw new Error('Le bot ne peut pas bannir ce membre (hiérarchie des rôles).');
      }
      const durationMs = (tier.durationSeconds ?? 86400) * 1000;
      await params.guild.members.ban(params.target.id, {
        reason: `${customReason} | Modérateur: ${params.moderator.tag}`,
      });
      sanction = await registerBanSanction({
        guildId: params.guildId,
        target: params.target,
        moderator: params.moderator,
        reason: customReason,
        temporaryDurationMs: durationMs,
        client: params.client,
      });
      break;
    }
    case SanctionType.BAN: {
      if (params.member && !params.member.bannable) {
        throw new Error('Le bot ne peut pas bannir ce membre (hiérarchie des rôles).');
      }
      await params.guild.members.ban(params.target.id, {
        reason: `${customReason} | Modérateur: ${params.moderator.tag}`,
      });
      sanction = await registerBanSanction({
        guildId: params.guildId,
        target: params.target,
        moderator: params.moderator,
        reason: customReason,
        client: params.client,
      });
      break;
    }
    case SanctionType.SOFTBAN: {
      if (params.member && !params.member.bannable) {
        throw new Error('Le bot ne peut pas softban ce membre (hiérarchie des rôles).');
      }
      // Ban for messages deletion
      await params.guild.members.ban(params.target.id, {
        deleteMessageSeconds: 7 * 24 * 60 * 60,
        reason: `${customReason} | Softban par ${params.moderator.tag}`,
      });
      // Unban immediately
      await params.guild.members.unban(params.target.id, `Softban (re-déban automatique) | Modérateur: ${params.moderator.tag}`);
      sanction = await registerSoftbanSanction({
        guildId: params.guildId,
        target: params.target,
        moderator: params.moderator,
        reason: customReason,
        client: params.client,
      });
      break;
    }
    default: {
      throw new Error(`Type de sanction inconnu: ${tier.action}`);
    }
  }

  // Update sanction record with the sanction table link
  await prisma.sanction.update({
    where: { id: sanction.id },
    data: { sanctionTableId: table.id },
  });

  return { sanction, action: tier.action, level: targetLevel, table };
}
