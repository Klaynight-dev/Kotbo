import { Client, GuildMember } from 'discord.js';
import { createCanvas, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import type { LevelConfig } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { cache } from '../../utils/cache.js';

// Cooldown map: key is "guildId:userId", value is timestamp when cooldown expires
const xpCooldowns = new Map<string, number>();

/**
 * Calcul l'XP nécessaire pour atteindre un niveau donné.
 * Formule standard : 100 * (level^2) + 200 * level
 */
export function getXpForLevel(level: number): number {
  if (level < 0) return 0;
  return 100 * Math.pow(level, 2) + 200 * level;
}

/**
 * Dérive le niveau à partir de l'XP totale.
 * L'XP est la source de vérité : le niveau en est toujours déduit, ce qui
 * permet d'auto-réparer les lignes incohérentes (ex. données importées d'un
 * autre bot avec une courbe différente).
 */
export function getLevelFromXp(xp: number): number {
  if (xp < 0) return 0;
  let level = 0;
  while (xp >= getXpForLevel(level)) {
    level++;
  }
  return level;
}

export async function getOrCreateLevelConfig(guildId: string) {
  const cacheKey = `guild:${guildId}:level_config`;
  let config = await cache.get<LevelConfig>(cacheKey);

  if (config) return config;

  config = await prisma.levelConfig.findUnique({
    where: { guildId },
  });

  if (!config) {
    // Ensure the Guild row exists before creating the FK-dependent LevelConfig
    await prisma.guild.upsert({
      where: { id: guildId },
      update: {},
      create: { id: guildId },
    });

    config = await prisma.levelConfig.create({
      data: {
        guildId,
        enabled: false,
        xpMin: 15,
        xpMax: 25,
        cooldownSeconds: 60,
        vocalXpPerMin: 5,
        levelUpMessage: "Félicitations {user} ! Tu passes au niveau **{level}** ! 🎉",
        stackRewards: false,
        ignoredChannels: [],
        ignoredRoles: [],
        xpMultipliers: {},
        lengthBonusEnabled: false,
        lengthBonusThreshold: 200,
        lengthBonusMaxMultiplier: 2.0,
      },
    });
  }

  await cache.set(cacheKey, config, 60);
  return config;
}

/**
 * Calcule le facteur multiplicateur d'XP en fonction de la longueur du message.
 * Progression linéaire de 1.0 (message vide/court) jusqu'à `maxMultiplier`
 * atteint à `threshold` caractères, puis plafonné.
 */
export function computeLengthBonusFactor(
  messageLength: number,
  enabled: boolean,
  threshold: number,
  maxMultiplier: number,
): number {
  if (!enabled) return 1;
  if (!threshold || threshold <= 0) return 1;
  if (!maxMultiplier || maxMultiplier <= 1) return 1;
  const ratio = Math.min(1, Math.max(0, messageLength / threshold));
  return 1 + ratio * (maxMultiplier - 1);
}

/**
 * Ajoute de l'XP à un utilisateur (Textuel)
 */
export async function handleTextXp(guildId: string, userId: string, client: Client, channelId: string, messageLength = 0) {
  try {
    const config = await getOrCreateLevelConfig(guildId);
    if (!config.enabled) return;

    // Vérifier si le salon est exclu
    if (config.ignoredChannels && config.ignoredChannels.includes(channelId)) {
      return;
    }

    // Récupérer le membre Discord pour valider ses rôles
    const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!discordGuild) return;
    const member = await discordGuild.members.fetch(userId).catch(() => null);
    if (!member) return;

    // Vérifier si le membre possède un rôle exclu
    if (config.ignoredRoles && (config.ignoredRoles as string[]).some(roleId => member.roles.cache.has(roleId))) {
      return;
    }

    const cooldownKey = `${guildId}:${userId}`;
    const now = Date.now();
    const cooldownEnd = xpCooldowns.get(cooldownKey) || 0;

    if (now < cooldownEnd) {
      return; // Toujours sous cooldown
    }

    // Définir le nouveau cooldown
    xpCooldowns.set(cooldownKey, now + (config.cooldownSeconds * 1000));

    // Calculer le multiplicateur d'XP par rôle
    let multiplier = 1.0;
    if (config.xpMultipliers && typeof config.xpMultipliers === 'object') {
      const multipliers = config.xpMultipliers as Record<string, number>;
      for (const [roleId, multValue] of Object.entries(multipliers)) {
        if (member.roles.cache.has(roleId)) {
          if (multValue > multiplier) {
            multiplier = multValue;
          }
        }
      }
    }

    // Bonus selon la longueur du message (plus le message est long, plus le gain est élevé)
    const lengthFactor = computeLengthBonusFactor(
      messageLength,
      Boolean(config.lengthBonusEnabled),
      Number(config.lengthBonusThreshold ?? 0),
      Number(config.lengthBonusMaxMultiplier ?? 1),
    );

    // Assigner l'XP en appliquant le multiplicateur de rôle puis le bonus de longueur
    const baseGain = Math.floor(Math.random() * (config.xpMax - config.xpMin + 1)) + config.xpMin;
    const xpGain = Math.floor(baseGain * multiplier * lengthFactor);

    if (xpGain > 0) {
      await addXp(guildId, userId, xpGain, client, channelId);
    }
  } catch (err) {
    logger.error('LevelingService', `Erreur lors de l'ajout d'XP texte pour ${userId} sur ${guildId}:`, err);
  }
}

/**
 * Ajoute de l'XP brute à un utilisateur et gère le passage de niveau
 */
export async function addXp(guildId: string, userId: string, amount: number, client: Client, channelId?: string) {
  if (amount <= 0) return;

  let finalAmount = amount;
  try {
    const guildSettings = await prisma.guild.findUnique({
      where: { id: guildId },
      select: {
        clanRewardXpBoost: true,
        clanRewardXpBoostRate: true,
        lastWinningClanId: true,
      },
    });

    if (guildSettings?.clanRewardXpBoost && guildSettings.lastWinningClanId) {
      const winningClan = await prisma.clan.findUnique({
        where: { id: guildSettings.lastWinningClanId },
        select: { roleId: true },
      });

      if (winningClan) {
        const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        if (discordGuild) {
          const member = discordGuild.members.cache.get(userId) || await discordGuild.members.fetch(userId).catch(() => null);
          if (member && member.roles.cache.has(winningClan.roleId)) {
            finalAmount = Math.round(amount * guildSettings.clanRewardXpBoostRate);
          }
        }
      }
    }
  } catch (err) {
    logger.error('LevelingService', `Erreur lors de l'application du multiplicateur d'XP de clan pour ${userId}:`, err);
  }

  const memberLevel = await prisma.memberLevel.upsert({
    where: { guildId_userId: { guildId, userId } },
    update: {
      xp: { increment: finalAmount },
      lastXpGain: new Date(),
    },
    create: {
      guildId,
      userId,
      xp: finalAmount,
      level: 0,
    },
  });



  const previousLevel = memberLevel.level;
  // Le niveau est toujours recalculé depuis l'XP totale : ça gère les montées
  // de niveau et auto-répare les lignes dont le niveau était incohérent.
  const newLevel = getLevelFromXp(memberLevel.xp);

  if (newLevel !== previousLevel) {
    if (newLevel > previousLevel) {
      // Le niveau et la récompense en KotboCoins doivent être commis ensemble : sinon un
      // échec du crédit (module économie momentanément indisponible, etc.) laisserait le
      // niveau monté sans aucune compensation.
      const coinReward = await getLevelUpCoinReward(guildId, newLevel);
      await prisma.$transaction(async (tx) => {
        await tx.memberLevel.update({
          where: { guildId_userId: { guildId, userId } },
          data: { level: newLevel },
        });
        if (coinReward) {
          await tx.rpgProfile.upsert({
            where: { guildId_userId: { guildId, userId } },
            update: { balance: { increment: coinReward.amount } },
            create: {
              guildId,
              userId,
              balance: coinReward.amount,
              level: 1,
              xp: 0,
              health: 100,
              maxHealth: 100,
              energy: 100,
              attack: 10,
              defense: 10,
              speed: 10,
            },
          });
        }
      });

      // Notification + récompenses annexes (rôles, points de clan) : best-effort, le
      // niveau et les pièces sont déjà garantis commis à ce stade.
      await processLevelUp(guildId, userId, newLevel, client, channelId, coinReward);
    } else {
      await prisma.memberLevel.update({
        where: { guildId_userId: { guildId, userId } },
        data: { level: newLevel },
      });
      // Correction vers le bas : on retire les rôles attribués en trop, sans message
      await updateMemberLevelRoles(guildId, userId, newLevel, client).catch(() => null);
    }
  }
}

/**
 * Calcule (sans l'appliquer) la récompense en KotboCoins due pour une montée de niveau.
 */
async function getLevelUpCoinReward(guildId: string, newLevel: number): Promise<{ amount: number; currencyEmoji: string; currencyName: string } | null> {
  try {
    const { getOrCreateEconomyConfig } = await import('../features/economyService.js');
    const econConfig = await getOrCreateEconomyConfig(guildId).catch(() => null);
    if (!econConfig || !econConfig.enabled) return null;
    return {
      amount: newLevel * 20,
      currencyEmoji: econConfig.currencyEmoji,
      currencyName: econConfig.currencyName,
    };
  } catch (err) {
    logger.error('LevelingService', "Erreur lors du calcul du bonus d'économie pour le level up :", err);
    return null;
  }
}

/**
 * Fixe l'XP totale d'un utilisateur à une valeur donnée (au lieu de l'incrémenter)
 * et gère le passage/la perte de niveau qui en découle.
 */
export async function setXp(guildId: string, userId: string, newXp: number, client: Client, channelId?: string) {
  const clampedXp = Math.max(0, Math.floor(newXp));

  const memberLevel = await prisma.memberLevel.upsert({
    where: { guildId_userId: { guildId, userId } },
    update: { xp: clampedXp },
    create: {
      guildId,
      userId,
      xp: clampedXp,
      level: 0,
    },
  });

  const previousLevel = memberLevel.level;
  const newLevel = getLevelFromXp(clampedXp);

  if (newLevel !== previousLevel) {
    if (newLevel > previousLevel) {
      // Voir addXp() : niveau et récompense en KotboCoins doivent être commis ensemble.
      const coinReward = await getLevelUpCoinReward(guildId, newLevel);
      await prisma.$transaction(async (tx) => {
        await tx.memberLevel.update({
          where: { guildId_userId: { guildId, userId } },
          data: { level: newLevel },
        });
        if (coinReward) {
          await tx.rpgProfile.upsert({
            where: { guildId_userId: { guildId, userId } },
            update: { balance: { increment: coinReward.amount } },
            create: {
              guildId,
              userId,
              balance: coinReward.amount,
              level: 1,
              xp: 0,
              health: 100,
              maxHealth: 100,
              energy: 100,
              attack: 10,
              defense: 10,
              speed: 10,
            },
          });
        }
      });
      await processLevelUp(guildId, userId, newLevel, client, channelId, coinReward);
    } else {
      await prisma.memberLevel.update({
        where: { guildId_userId: { guildId, userId } },
        data: { level: newLevel },
      });
      await updateMemberLevelRoles(guildId, userId, newLevel, client).catch(() => null);
    }
  }

  return { xp: clampedXp, level: newLevel };
}

/**
 * Gère les notifications de level up et l'attribution des rôles récompenses
 */
async function processLevelUp(guildId: string, userId: string, newLevel: number, client: Client, fallbackChannelId?: string, coinReward?: { amount: number; currencyEmoji: string; currencyName: string } | null) {
  try {
    const config = await getOrCreateLevelConfig(guildId);
    const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!discordGuild) return;

    const member = await discordGuild.members.fetch(userId).catch(() => null);
    if (!member) return;

    // 0. Attribution des points de clan pour la montée de niveau si activé
    try {
      const guildConfig = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { clansEnabled: true, currentClanSeason: true, clanXpFromLevelUp: true, clanXpPerLevelUp: true }
      });
      if (guildConfig?.clansEnabled && guildConfig?.clanXpFromLevelUp && guildConfig?.clanXpPerLevelUp > 0) {
        const clans = await prisma.clan.findMany({
          where: { guildId },
          select: { id: true, roleId: true }
        });
        if (clans.length > 0) {
          const clanRoleIds = clans.map(c => c.roleId);
          const memberClanRole = member.roles.cache.find(r => clanRoleIds.includes(r.id));
          if (memberClanRole) {
            const clan = clans.find(c => c.roleId === memberClanRole.id);
            if (clan) {
              const { getAllLinkedUserIds } = await import('../moderation/altAccountService.js');
              const linkedIds = await getAllLinkedUserIds(guildId, userId).catch(() => [userId]);
              const canonicalUserId = linkedIds.sort()[0];

              await prisma.clanMemberContribution.upsert({
                where: {
                  guildId_clanId_userId_season: {
                    guildId,
                    clanId: clan.id,
                    userId: canonicalUserId,
                    season: guildConfig.currentClanSeason
                  }
                },
                update: {
                  xp: { increment: guildConfig.clanXpPerLevelUp }
                },
                create: {
                  guildId,
                  clanId: clan.id,
                  userId: canonicalUserId,
                  season: guildConfig.currentClanSeason,
                  xp: guildConfig.clanXpPerLevelUp
                }
              });

              // Journaliser le gain pour le flux public « derniers scores »
              const { logClanContribution } = await import('../community/clanService.js');
              await logClanContribution(guildId, clan.id, canonicalUserId, guildConfig.clanXpPerLevelUp, 'XP', guildConfig.currentClanSeason);

              logger.info('LevelingService', `Points de clan (${guildConfig.clanXpPerLevelUp} XP) attribués à ${member.user.tag} pour son passage au niveau ${newLevel} dans le clan "${clan.id}"`);
            }
          }
        }
      }
    } catch (clanErr) {
      logger.error('LevelingService', `Erreur lors de l'attribution des points de clan pour le level up de ${userId}:`, clanErr);
    }

    // 1. Attribution des rôles de récompense
    const rewards = await prisma.levelRoleReward.findMany({
      where: { guildId },
      orderBy: { level: 'asc' },
    });

    if (rewards.length > 0) {
      const rolesToAdd: string[] = [];
      const rolesToRemove: string[] = [];

      for (const reward of rewards) {
        if (newLevel >= reward.level) {
          if (!member.roles.cache.has(reward.roleId)) {
            rolesToAdd.push(reward.roleId);
          }
        } else {
          // Si configuration de cumul de rôles désactivée, on pourrait enlever les rôles supérieurs.
          // Mais dans tous les cas, si le membre a perdu des niveaux, on retire.
          if (member.roles.cache.has(reward.roleId)) {
            rolesToRemove.push(reward.roleId);
          }
        }
      }

      // Optionnel: Garder uniquement la récompense la plus élevée si le cumul est désactivé
      if (!config.stackRewards) {
        const eligibleRewards = rewards.filter(r => newLevel >= r.level);
        if (eligibleRewards.length > 1) {
          const _highestReward = eligibleRewards[eligibleRewards.length - 1];
          // Retirer tous les autres rôles récompenses plus bas
          for (const prevReward of eligibleRewards.slice(0, -1)) {
            if (member.roles.cache.has(prevReward.roleId) && !rolesToRemove.includes(prevReward.roleId)) {
              rolesToRemove.push(prevReward.roleId);
            }
            const addIdx = rolesToAdd.indexOf(prevReward.roleId);
            if (addIdx !== -1) rolesToAdd.splice(addIdx, 1);
          }
        }
      }

      // Appliquer les changements de rôles
      if (rolesToRemove.length > 0) {
        await member.roles.remove(rolesToRemove).catch(e => logger.warn('LevelingService', `Impossible de retirer les rôles récompenses à ${userId}:`, e));
      }
      if (rolesToAdd.length > 0) {
        await member.roles.add(rolesToAdd).catch(e => logger.warn('LevelingService', `Impossible d'ajouter les rôles récompenses à ${userId}:`, e));
      }
    }

    // 1.5. Le crédit des KotboCoins a déjà été commis atomiquement avec le niveau (voir
    // addXp/setXp) ; on ne fait ici que construire le texte de notification.
    const coinRewardText = coinReward
      ? ` Tu as également gagné **${coinReward.amount}** ${coinReward.currencyEmoji} **${coinReward.currencyName}** !`
      : '';

    // 2. Envoi du message de félicitations
    const msgTemplate = config.levelUpMessage;
    const msg = msgTemplate
      .replace(/{user}/g, `<@${userId}>`)
      .replace(/{username}/g, member.user.username)
      .replace(/{level}/g, String(newLevel)) + coinRewardText;

    if (config.levelUpChannelId === 'DM') {
      const dmChannel = await member.createDM().catch(() => null);
      if (dmChannel) {
        await dmChannel.send(msg).catch(() => null);
      }
    } else if (config.levelUpChannelId && config.levelUpChannelId !== 'current') {
      const targetChannel = discordGuild.channels.cache.get(config.levelUpChannelId);
      if (targetChannel?.isTextBased()) {
        await targetChannel.send(msg).catch(() => null);
      }
    } else if (fallbackChannelId) {
      const currentChannel = discordGuild.channels.cache.get(fallbackChannelId);
      if (currentChannel?.isTextBased()) {
        await currentChannel.send(msg).catch(() => null);
      }
    }
  } catch (err) {
    logger.error('LevelingService', `Erreur lors de la gestion du level up pour ${userId}:`, err);
  }
}

/**
 * Récupère le rang, l'XP et le niveau d'un membre
 */
export async function getMemberRankData(guildId: string, userId: string) {
  const levels = await prisma.memberLevel.findMany({
    where: { guildId },
    orderBy: { xp: 'desc' },
  });

  const rankIndex = levels.findIndex(l => l.userId === userId);
  const rank = rankIndex === -1 ? levels.length + 1 : rankIndex + 1;

  let memberLevel = levels.find(l => l.userId === userId);
  if (!memberLevel) {
    memberLevel = {
      id: '',
      guildId,
      userId,
      xp: 0,
      level: 0,
      lastXpGain: new Date(),
    };
  }

  // L'XP est la source de vérité : on recalcule le niveau et on auto-répare la
  // ligne si elle est incohérente (ex. niveau importé d'un autre bot).
  const correctLevel = getLevelFromXp(memberLevel.xp);
  if (memberLevel.id && correctLevel !== memberLevel.level) {
    memberLevel.level = correctLevel;
    prisma.memberLevel
      .update({
        where: { guildId_userId: { guildId, userId } },
        data: { level: correctLevel },
      })
      .catch(err => logger.error('LevelingService', `Auto-réparation du niveau échouée pour ${userId}:`, err));
  }

  const currentLevelXp = getXpForLevel(memberLevel.level - 1);
  const nextLevelXp = getXpForLevel(memberLevel.level);
  
  const xpInCurrentLevel = memberLevel.xp - currentLevelXp;
  const xpRequiredForNextLevel = nextLevelXp - currentLevelXp;

  return {
    level: memberLevel.level,
    xp: memberLevel.xp,
    xpInCurrentLevel: Math.max(0, xpInCurrentLevel),
    xpRequiredForNextLevel,
    rank,
    totalXp: memberLevel.xp,
  };
}

export async function generateRankCard(member: GuildMember, level: number, xp: number, rank: number): Promise<Buffer> {
  const W = 934, H = 282;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0a0d13');
  bg.addColorStop(0.5, '#0f1219');
  bg.addColorStop(1, '#0a0d13');
  roundRect(ctx, 0, 0, W, H, 22, bg);

  // Accent bar (top)
  const topBar = ctx.createLinearGradient(0, 0, W, 0);
  topBar.addColorStop(0, '#5865f2');
  topBar.addColorStop(0.5, '#7b68ee');
  topBar.addColorStop(1, '#57f287');
  ctx.fillStyle = topBar;
  ctx.fillRect(0, 0, W, 3);

  // Glows
  const glow1 = ctx.createRadialGradient(W * 0.75, H * 0.4, 0, W * 0.75, H * 0.4, 300);
  glow1.addColorStop(0, 'rgba(88, 101, 242, 0.1)');
  glow1.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow1;
  ctx.fillRect(0, 0, W, H);

  const glow2 = ctx.createRadialGradient(150, 140, 0, 150, 140, 200);
  glow2.addColorStop(0, 'rgba(87, 242, 135, 0.06)');
  glow2.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, W, H);

  // Avatar
  const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 256 });
  const avatarCX = 115, avatarCY = 130, avatarR = 62;

  // Avatar ring
  const ringGrad = ctx.createLinearGradient(avatarCX - avatarR, avatarCY - avatarR, avatarCX + avatarR, avatarCY + avatarR);
  ringGrad.addColorStop(0, '#5865f2');
  ringGrad.addColorStop(1, '#57f287');
  ctx.beginPath();
  ctx.arc(avatarCX, avatarCY, avatarR + 4, 0, Math.PI * 2);
  ctx.fillStyle = ringGrad;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(avatarCX, avatarCY, avatarR + 1, 0, Math.PI * 2);
  ctx.fillStyle = '#0a0d13';
  ctx.fill();

  try {
    const avatarImg = await loadImage(avatarUrl);
    ctx.save();
    ctx.beginPath();
    ctx.arc(avatarCX, avatarCY, avatarR, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(avatarImg, avatarCX - avatarR, avatarCY - avatarR, avatarR * 2, avatarR * 2);
    ctx.restore();
  } catch {
    ctx.fillStyle = '#5865f2';
    ctx.beginPath();
    ctx.arc(avatarCX, avatarCY, avatarR, 0, Math.PI * 2);
    ctx.fill();
  }

  // Status indicator
  const status = member.presence?.status || 'offline';
  const statusColor = status === 'online' ? '#3ba55d' : status === 'idle' ? '#faa81a' : status === 'dnd' ? '#ed4245' : '#747f8d';
  ctx.beginPath();
  ctx.arc(avatarCX + 45, avatarCY + 45, 14, 0, Math.PI * 2);
  ctx.fillStyle = '#0a0d13';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(avatarCX + 45, avatarCY + 45, 10, 0, Math.PI * 2);
  ctx.fillStyle = statusColor;
  ctx.fill();

  // Name & tag
  const nameX = 210;
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 30px sans-serif';
  const truncatedName = member.displayName.length > 18 ? member.displayName.slice(0, 15) + '…' : member.displayName;
  ctx.fillText(truncatedName, nameX, 80);

  const tagText = member.user.discriminator !== '0' ? `#${member.user.discriminator}` : `@${member.user.username}`;
  ctx.fillStyle = '#6e7681';
  ctx.font = '17px sans-serif';
  ctx.fillText(tagText, nameX, 106);

  // Rank & Level (right side)
  ctx.textAlign = 'right';

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 38px sans-serif';
  const rankVal = `#${rank}`;
  ctx.fillText(rankVal, W - 45, 72);
  const rankValW = ctx.measureText(rankVal).width;

  ctx.fillStyle = '#5865f2';
  ctx.font = 'bold 14px sans-serif';
  ctx.fillText('RANG ', W - 45 - rankValW, 72);
  const rankLabelW = ctx.measureText('RANG ').width;

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 38px sans-serif';
  const levelVal = `${level}`;
  const levelX = W - 45 - rankValW - rankLabelW - 28;
  ctx.fillText(levelVal, levelX, 72);
  const levelValW = ctx.measureText(levelVal).width;

  ctx.fillStyle = '#57f287';
  ctx.font = 'bold 14px sans-serif';
  ctx.fillText('NIVEAU ', levelX - levelValW, 72);

  ctx.textAlign = 'left';

  // XP text
  const safeLevel = getLevelFromXp(xp);
  const prevXpNeeded = getXpForLevel(safeLevel - 1);
  const nextXpNeeded = getXpForLevel(safeLevel);
  const xpInCurrentLevel = Math.max(0, xp - prevXpNeeded);
  const xpRequiredForNextLevel = Math.max(1, nextXpNeeded - prevXpNeeded);
  const progressPercent = Math.min(1, Math.max(0, xpInCurrentLevel / xpRequiredForNextLevel));

  ctx.fillStyle = '#6e7681';
  ctx.font = '14px sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(`${xpInCurrentLevel.toLocaleString('fr-FR')} / ${xpRequiredForNextLevel.toLocaleString('fr-FR')} XP`, W - 45, 155);
  ctx.textAlign = 'left';

  // Progress bar
  const barX = nameX, barY = 175, barW = W - nameX - 45, barH = 22, barR = 11;
  roundRect(ctx, barX, barY, barW, barH, barR, 'rgba(255,255,255,0.06)');

  if (progressPercent > 0) {
    const filledW = Math.max(barH, barW * progressPercent);
    const grad = ctx.createLinearGradient(barX, 0, barX + filledW, 0);
    grad.addColorStop(0, '#5865f2');
    grad.addColorStop(1, '#57f287');
    roundRect(ctx, barX, barY, filledW, barH, barR, grad);
  }

  // Bottom text
  ctx.fillStyle = '#3b4048';
  ctx.font = '11px sans-serif';
  ctx.fillText('Kotbo · Progression', nameX, barY + barH + 28);

  ctx.textAlign = 'right';
  const totalXpText = `${xp.toLocaleString('fr-FR')} XP total`;
  ctx.fillText(totalXpText, W - 45, barY + barH + 28);
  ctx.textAlign = 'left';

  // Bottom accent bar
  const bottomBar = ctx.createLinearGradient(0, 0, W, 0);
  bottomBar.addColorStop(0, 'rgba(88, 101, 242, 0)');
  bottomBar.addColorStop(0.3, 'rgba(88, 101, 242, 0.3)');
  bottomBar.addColorStop(0.7, 'rgba(87, 242, 135, 0.3)');
  bottomBar.addColorStop(1, 'rgba(87, 242, 135, 0)');
  ctx.fillStyle = bottomBar;
  ctx.fillRect(0, H - 2, W, 2);

  return canvas.toBuffer('image/png');
}

// Helper pour dessiner des rectangles arrondis
function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number, fill: string | CanvasGradient) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

/**
 * Met à jour les rôles de récompense pour un utilisateur en fonction de son niveau,
 * sans envoyer de message dans le chat (utile pour les imports).
 */
export async function updateMemberLevelRoles(guildId: string, userId: string, level: number, client: Client) {
  try {
    const config = await getOrCreateLevelConfig(guildId);
    const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!discordGuild) return;

    const member = await discordGuild.members.fetch(userId).catch(() => null);
    if (!member) return;

    const rewards = await prisma.levelRoleReward.findMany({
      where: { guildId },
      orderBy: { level: 'asc' },
    });

    if (rewards.length > 0) {
      const rolesToAdd: string[] = [];
      const rolesToRemove: string[] = [];

      for (const reward of rewards) {
        if (level >= reward.level) {
          if (!member.roles.cache.has(reward.roleId)) {
            rolesToAdd.push(reward.roleId);
          }
        } else {
          if (member.roles.cache.has(reward.roleId)) {
            rolesToRemove.push(reward.roleId);
          }
        }
      }

      if (!config.stackRewards) {
        const eligibleRewards = rewards.filter(r => level >= r.level);
        if (eligibleRewards.length > 1) {
          const _highestReward = eligibleRewards[eligibleRewards.length - 1];
          for (const prevReward of eligibleRewards.slice(0, -1)) {
            if (member.roles.cache.has(prevReward.roleId) && !rolesToRemove.includes(prevReward.roleId)) {
              rolesToRemove.push(prevReward.roleId);
            }
            const addIdx = rolesToAdd.indexOf(prevReward.roleId);
            if (addIdx !== -1) rolesToAdd.splice(addIdx, 1);
          }
        }
      }

      if (rolesToRemove.length > 0) {
        await member.roles.remove(rolesToRemove).catch(e => logger.warn('LevelingService', `Impossible de retirer les rôles récompenses à ${userId}:`, e));
      }
      if (rolesToAdd.length > 0) {
        await member.roles.add(rolesToAdd).catch(e => logger.warn('LevelingService', `Impossible d'ajouter les rôles récompenses à ${userId}:`, e));
      }
    }
  } catch (err) {
    logger.error('LevelingService', `Erreur lors de la mise à jour des rôles de niveau pour ${userId}:`, err);
  }
}

