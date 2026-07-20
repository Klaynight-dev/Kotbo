import { Client, EmbedBuilder, ChannelType, CategoryChannel } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { pushAudit, broadcastDashboardStateChange } from '../../api/shared.js';
import { getClient } from '../../utils/client.js';

export const clanTasks = new Map<string, { type: 'distribute' | 'clear'; processed: number; total: number }>();

export async function runDistribution(guildId: string, client: Client, initiatorName: string): Promise<string> {
  if (clanTasks.has(guildId)) {
    throw new Error('Une opération de masse est déjà en cours sur ce serveur.');
  }

  const clans = await prisma.clan.findMany({ where: { guildId } });
  if (clans.length === 0) {
    throw new Error('Veuillez configurer au moins un clan avant de lancer la distribution.');
  }

  const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) {
    throw new Error('Serveur introuvable sur Discord.');
  }

  // Récupérer tous les membres
  const allMembers = await discordGuild.members.fetch().catch(() => null);
  if (!allMembers) {
    throw new Error('Impossible de récupérer la liste des membres Discord.');
  }

  const clanRoleIds = clans.map((c) => c.roleId);
  
  // Filtrer les humains qui n'ont pas encore de rôle de clan
  const membersWithoutClan = allMembers.filter((member) => {
    if (member.user.bot) return false;
    return !member.roles.cache.some((r) => clanRoleIds.includes(r.id));
  });

  if (membersWithoutClan.size === 0) {
    return 'Tous les membres ont déjà un clan.';
  }

  const targetList = [...membersWithoutClan.values()];
  
  // Démarrer la tâche asynchrone bridée
  clanTasks.set(guildId, { type: 'distribute', processed: 0, total: targetList.length });
  broadcastDashboardStateChange(guildId, 'clans_updated');

  // Lancement asynchrone non-bloquant
  (async () => {
    logger.info('ClanService', `Lancement de la distribution équilibrée pour ${targetList.length} membres dans "${discordGuild.name}" par ${initiatorName}`);
    
    // Récupérer le nombre initial de membres sur Discord pour chaque clan
    const clanCounts = clans.map((c) => {
      const count = discordGuild.roles.cache.get(c.roleId)?.members.size ?? 0;
      return { roleId: c.roleId, count };
    });

    // Mélanger la liste pour préserver le côté aléatoire
    const shuffledList = [...targetList].sort(() => Math.random() - 0.5);

    for (let i = 0; i < shuffledList.length; i++) {
      const currentTask = clanTasks.get(guildId);
      if (!currentTask || currentTask.type !== 'distribute') break;

      const member = shuffledList[i];
      
      // Trouver le clan qui a actuellement le moins de membres
      clanCounts.sort((a, b) => a.count - b.count);
      const targetClan = clanCounts[0];

      try {
        await member.roles.add(targetClan.roleId, 'Distribution globale et équilibrée des clans');
        targetClan.count++; // Incrémenter pour la répartition suivante
      } catch (e) {
        logger.warn('ClanService', `Impossible d'attribuer le clan à ${member.user.tag}:`, e);
      }

      clanTasks.set(guildId, {
        type: 'distribute',
        processed: i + 1,
        total: shuffledList.length,
      });
      broadcastDashboardStateChange(guildId, 'clans_updated');

      await new Promise((resolve) => setTimeout(resolve, 450));
    }

    logger.info('ClanService', `Distribution équilibrée terminée pour "${discordGuild.name}"`);
    clanTasks.delete(guildId);
    broadcastDashboardStateChange(guildId, 'clans_updated');
  })().catch((e) => logger.error('ClanService', 'Erreur critique dans le thread de distribution:', e));

  await pushAudit(guildId, {
    user: initiatorName,
    action: 'Lancement distribution de clans',
    context: discordGuild.name,
    module: 'Clans',
    eventType: 'Manuel',
    details: `Distribution aléatoire lancée pour ${targetList.length} membres.`,
    channelId: null,
  }).catch(() => null);

  return `La distribution aléatoire des clans à ${targetList.length} membres a commencé en arrière-plan. Cette opération s'effectue progressivement pour respecter les limites de requêtes de Discord et peut prendre plusieurs minutes. Vous pouvez suivre l'avancement sur le Dashboard.`;
}

export async function runClear(guildId: string, client: Client, initiatorName: string): Promise<string> {
  if (clanTasks.has(guildId)) {
    throw new Error('Une opération de masse est déjà en cours sur ce serveur.');
  }

  const clans = await prisma.clan.findMany({ where: { guildId } });
  if (clans.length === 0) {
    throw new Error('Aucun clan n\'est configuré sur ce serveur.');
  }

  const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) {
    throw new Error('Serveur introuvable sur Discord.');
  }

  const clanRoleIds = clans.map((c) => c.roleId);

  // Récupérer les membres
  const allMembers = await discordGuild.members.fetch().catch(() => null);
  if (!allMembers) {
    throw new Error('Impossible de récupérer la liste des membres.');
  }

  // Filtrer les membres qui ont au moins un rôle de clan
  const membersWithClan = allMembers.filter((member) => {
    return member.roles.cache.some((r) => clanRoleIds.includes(r.id));
  });

  if (membersWithClan.size === 0) {
    return 'Aucun membre ne possède de rôle de clan.';
  }

  const targetList = [...membersWithClan.values()];

  // Démarrer la tâche
  clanTasks.set(guildId, { type: 'clear', processed: 0, total: targetList.length });
  broadcastDashboardStateChange(guildId, 'clans_updated');

  // Lancement asynchrone
  (async () => {
    logger.info('ClanService', `Lancement du retrait de tous les clans pour ${targetList.length} membres dans "${discordGuild.name}" par ${initiatorName}`);

    for (let i = 0; i < targetList.length; i++) {
      const currentTask = clanTasks.get(guildId);
      if (!currentTask || currentTask.type !== 'clear') break;

      const member = targetList[i];
      const rolesToRemove = member.roles.cache.filter((r) => clanRoleIds.includes(r.id)).map((r) => r.id);

      try {
        await member.roles.remove(rolesToRemove, 'Retrait global de tous les rôles de clan');
      } catch (e) {
        logger.warn('ClanService', `Impossible de retirer les clans de ${member.user.tag}:`, e);
      }

      clanTasks.set(guildId, {
        type: 'clear',
        processed: i + 1,
        total: targetList.length,
      });
      broadcastDashboardStateChange(guildId, 'clans_updated');

      await new Promise((resolve) => setTimeout(resolve, 450));
    }

    logger.info('ClanService', `Retrait de tous les clans terminé pour "${discordGuild.name}"`);
    clanTasks.delete(guildId);
    broadcastDashboardStateChange(guildId, 'clans_updated');
  })().catch((e) => logger.error('ClanService', 'Erreur critique dans le thread de retrait:', e));

  await pushAudit(guildId, {
    user: initiatorName,
    action: 'Lancement retrait de clans',
    context: discordGuild.name,
    module: 'Clans',
    eventType: 'Manuel',
    details: `Retrait des clans lancé pour ${targetList.length} membres.`,
    channelId: null,
  }).catch(() => null);

  return `Le retrait de tous les clans pour ${targetList.length} membres a commencé en arrière-plan. Cette opération s'effectue progressivement pour respecter les limites de requêtes de Discord et peut prendre plusieurs minutes. Vous pouvez suivre l'avancement sur le Dashboard.`;
}

/**
 * Synchronise les clans pour les comptes reliés (doubles comptes).
 * Si un utilisateur (ou les deux) possède déjà un clan, on harmonise.
 */
export async function syncMemberClanFromDcLink(
  guildId: string,
  userId: string,
  otherUserId: string | null
): Promise<void> {
  try {
    const client = getClient();
    // 1. Vérifier si les clans sont activés
    const guildSettings = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { clansEnabled: true },
    });
    if (!guildSettings?.clansEnabled) return;

    // 2. Si otherUserId n'est pas fourni, on cherche les liens validés pour userId
    let u1 = userId;
    let u2 = otherUserId;
    if (!u2) {
      const link = await prisma.linkedAccount.findFirst({
        where: {
          guildId,
          status: 'VALIDATED',
          OR: [
            { user1Id: userId },
            { user2Id: userId },
          ],
        },
      });
      if (!link) return;
      u1 = link.user1Id;
      u2 = link.user2Id;
    }

    // 3. Récupérer la guilde Discord
    const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!discordGuild) return;

    // 4. Récupérer les membres Discord
    const member1 = discordGuild.members.cache.get(u1) || await discordGuild.members.fetch(u1).catch(() => null);
    const member2 = discordGuild.members.cache.get(u2) || await discordGuild.members.fetch(u2).catch(() => null);

    if (!member1 || !member2) return;

    // 5. Récupérer les clans configurés
    const clans = await prisma.clan.findMany({ where: { guildId } });
    if (clans.length === 0) return;

    // 6. Identifier le clan de chaque membre
    const clan1 = clans.find(c => member1.roles.cache.has(c.roleId));
    const clan2 = clans.find(c => member2.roles.cache.has(c.roleId));

    // Si aucun des deux n'a de clan, rien à faire
    if (!clan1 && !clan2) return;

    let targetClan = clan1 || clan2;
    if (!targetClan) return;

    // Si les deux ont un clan différent, on choisit celui qui a le plus d'XP/niveau
    if (clan1 && clan2 && clan1.id !== clan2.id) {
      const [lvl1, lvl2] = await Promise.all([
        prisma.memberLevel.findUnique({ where: { guildId_userId: { guildId, userId: u1 } } }),
        prisma.memberLevel.findUnique({ where: { guildId_userId: { guildId, userId: u2 } } }),
      ]);
      const xp1 = lvl1?.xp ?? 0;
      const xp2 = lvl2?.xp ?? 0;

      if (xp1 >= xp2) {
        targetClan = clan1;
        logger.info('ClanService', `Synchro DC : Alignement de ${member2.user.tag} vers le clan de ${member1.user.tag} ("${clan1.name}" avec ${xp1} XP vs ${xp2} XP)`);
        
        // Retirer le rôle du clan 2 à member2 et ajouter le rôle du clan 1
        await member2.roles.remove(clan2.roleId, `Double compte aligné sur ${member1.user.tag} (synchro auto)`).catch(() => null);
        await member2.roles.add(clan1.roleId, `Double compte aligné sur ${member1.user.tag} (synchro auto)`).catch(() => null);

        // Migrer les contributions de member2 du clan2 vers clan1
        await migrateContributions(guildId, u2, clan2.id, clan1.id);
      } else {
        targetClan = clan2;
        logger.info('ClanService', `Synchro DC : Alignement de ${member1.user.tag} vers le clan de ${member2.user.tag} ("${clan2.name}" avec ${xp2} XP vs ${xp1} XP)`);
        
        // Retirer le rôle du clan 1 à member1 et ajouter le rôle du clan 2
        await member1.roles.remove(clan1.roleId, `Double compte aligné sur ${member2.user.tag} (synchro auto)`).catch(() => null);
        await member1.roles.add(clan2.roleId, `Double compte aligné sur ${member2.user.tag} (synchro auto)`).catch(() => null);

        // Migrer les contributions de member1 du clan1 vers clan2
        await migrateContributions(guildId, u1, clan1.id, clan2.id);
      }
    } else {
      // Attribuer le clan à celui qui ne l'a pas
      if (!clan1 && targetClan) {
        logger.info('ClanService', `Synchro DC : Attribution du clan "${targetClan.name}" à ${member1.user.tag} (lié à ${member2.user.tag})`);
        await member1.roles.add(targetClan.roleId, `Double compte de ${member2.user.tag} (synchro auto)`).catch(() => null);
      }
      if (!clan2 && targetClan) {
        logger.info('ClanService', `Synchro DC : Attribution du clan "${targetClan.name}" à ${member2.user.tag} (lié à ${member1.user.tag})`);
        await member2.roles.add(targetClan.roleId, `Double compte de ${member1.user.tag} (synchro auto)`).catch(() => null);
      }
    }
  } catch (err) {
    logger.error('ClanService', `Erreur synchro clan DC pour ${userId}:`, err);
  }
}

/**
 * Migre les contributions d'un utilisateur d'un clan vers un autre,
 * en fusionnant l'XP s'il existe déjà une contribution pour la même saison.
 */
async function migrateContributions(
  guildId: string,
  userId: string,
  sourceClanId: string,
  targetClanId: string
): Promise<void> {
  try {
    const sourceContribs = await prisma.clanMemberContribution.findMany({
      where: { guildId, clanId: sourceClanId, userId },
    });

    // Utiliser une transaction pour garantir l'intégrité de la migration
    await prisma.$transaction(async (tx) => {
      for (const contrib of sourceContribs) {
        const targetContrib = await tx.clanMemberContribution.findUnique({
          where: {
            guildId_clanId_userId_season: {
              guildId,
              clanId: targetClanId,
              userId,
              season: contrib.season,
            },
          },
        });

        if (targetContrib) {
          // Fusionner l'XP (utilisation d'increment atomique pour éviter les race conditions)
          await tx.clanMemberContribution.update({
            where: { id: targetContrib.id },
            data: { xp: { increment: contrib.xp } },
          });
          // Supprimer l'ancienne contribution source
          await tx.clanMemberContribution.delete({
            where: { id: contrib.id },
          });
        } else {
          // Simplement changer le clanId
          await tx.clanMemberContribution.update({
            where: { id: contrib.id },
            data: { clanId: targetClanId },
          });
        }
      }
    });
    logger.info('ClanService', `Contributions de l'utilisateur ${userId} migrées avec succès de ${sourceClanId} vers ${targetClanId}`);
  } catch (err) {
    logger.error('ClanService', `Erreur lors de la migration des contributions pour ${userId} de ${sourceClanId} vers ${targetClanId}:`, err);
  }
}

/**
 * Gère le sacre et l'attribution des bonus de fin de saison.
 */
export async function handleEndSeason(
  guildId: string,
  client: Client,
  initiatorName: string,
  currentSeason: number,
  nextSeason: number
): Promise<void> {
  try {
    const guildSettings = await prisma.guild.findUnique({
      where: { id: guildId },
      select: {
        clanAnnouncementChannelId: true,
        clanRewardGiveaway: true,
        clanRewardXpBoost: true,
        clanRewardXpBoostRate: true,
        clanRewardLeaderRole: true,
      },
    });

    if (!guildSettings) return;

    // 1. Récupérer les clans
    const clans = await prisma.clan.findMany({ where: { guildId } });
    if (clans.length === 0) return;

    // 2. Calculer les totaux d'XP par clan pour la saison
    let winningClan = null;
    let maxClanXp = -1;

    const clansWithXp = await Promise.all(
      clans.map(async (clan) => {
        const aggregate = await prisma.clanMemberContribution.aggregate({
          where: { guildId, clanId: clan.id, season: currentSeason },
          _sum: { xp: true },
        });
        const totalXp = aggregate._sum.xp ?? 0;
        return { clan, totalXp };
      })
    );

    for (const item of clansWithXp) {
      if (item.totalXp > maxClanXp && item.totalXp > 0) {
        maxClanXp = item.totalXp;
        winningClan = item.clan;
      }
    }

    // Récupérer le serveur Discord
    const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!discordGuild) return;

    // Nettoyer les anciens rôles de chefs de clan de tous les clans
    if (guildSettings.clanRewardLeaderRole) {
      for (const clan of clans) {
        if (!clan.leaderRoleId) continue;
        try {
          const role = discordGuild.roles.cache.get(clan.leaderRoleId)
            || await discordGuild.roles.fetch(clan.leaderRoleId).catch(() => null);
          if (role) {
            const membersWithRole = Array.from(role.members.values());
            for (const m of membersWithRole) {
              await m.roles.remove(clan.leaderRoleId, `Clôture de la Saison ${currentSeason} - Réinitialisation des chefs`).catch(() => null);
            }
          }
        } catch (err) {
          logger.warn('ClanService', `Erreur lors du nettoyage du rôle de chef ${clan.leaderRoleId}:`, err);
        }
      }
    }

    let leaderUserId: string | null = null;
    let leaderXp = 0;

    // 3. Traiter le vainqueur s'il y en a un
    if (winningClan) {
      // Enregistrer le vainqueur
      await prisma.guild.update({
        where: { id: guildId },
        data: { lastWinningClanId: winningClan.id },
      });

      // Trouver le chef du clan gagnant pour l'annonce
      const topWinnerContributor = await prisma.clanMemberContribution.findFirst({
        where: { guildId, clanId: winningClan.id, season: currentSeason, userId: { not: 'system_manual_points' } },
        orderBy: { xp: 'desc' },
      });

      if (topWinnerContributor && topWinnerContributor.xp > 0) {
        leaderUserId = topWinnerContributor.userId;
        leaderXp = topWinnerContributor.xp;
      }
    } else {
      // Pas de vainqueur cette saison, reset lastWinningClanId
      await prisma.guild.update({
        where: { id: guildId },
        data: { lastWinningClanId: null },
      });
    }

    // 4. Attribuer le rôle de chef de clan pour chaque clan si activé
    if (guildSettings.clanRewardLeaderRole) {
      for (const clan of clans) {
        if (!clan.leaderRoleId) continue;

        // Trouver le meilleur contributeur de ce clan pour la saison
        const topContributor = await prisma.clanMemberContribution.findFirst({
          where: { guildId, clanId: clan.id, season: currentSeason, userId: { not: 'system_manual_points' } },
          orderBy: { xp: 'desc' },
        });

        if (topContributor && topContributor.xp > 0) {
          const member = discordGuild.members.cache.get(topContributor.userId) 
            || await discordGuild.members.fetch(topContributor.userId).catch(() => null);
          if (member) {
            await member.roles.add(clan.leaderRoleId, `Chef du clan ${clan.name} - Fin de la Saison ${currentSeason}`).catch((err) => {
              logger.warn('ClanService', `Impossible d'attribuer le rôle de chef du clan ${clan.name} à ${member.user.tag}:`, err);
            });
          }
        }
      }
    }

    // 4. Renommage des catégories QG de clan (avec gestion d'erreur robuste)
    for (const clan of clans) {
      if (!clan.generalChannelId) continue;
      
      const channel = discordGuild.channels.cache.get(clan.generalChannelId)
        || await discordGuild.channels.fetch(clan.generalChannelId).catch(() => null);
        
      if (channel && channel.parent && channel.parent.type === ChannelType.GuildCategory) {
        const category = channel.parent as CategoryChannel;
        const isWinner = winningClan && clan.id === winningClan.id;
        
        let targetName = category.name;
        // Retirer uniquement la balise [🏆 ...] de fin si elle existe
        const trophyIndex = targetName.indexOf('[🏆');
        if (trophyIndex !== -1) {
          targetName = targetName.substring(0, trophyIndex).trim();
        }
        
        if (isWinner) {
          const activeRewards: string[] = [];
          if (guildSettings.clanRewardXpBoost) {
            activeRewards.push(`+${Math.round((guildSettings.clanRewardXpBoostRate - 1) * 100)}% XP`);
          }
          if (guildSettings.clanRewardGiveaway) {
            activeRewards.push('GIVEAWAY BOOST');
          }
          
          if (activeRewards.length > 0) {
            targetName = `${targetName} [🏆 ${activeRewards.join(' + ')}]`;
          }
        }
        
        if (category.name !== targetName) {
          logger.info('ClanService', `Renommage du QG du clan "${clan.name}" en "${targetName}"`);
          await category.setName(targetName, `Mise à jour QG - Fin de la Saison ${currentSeason}`).catch((err) => {
            logger.warn('ClanService', `Permission insuffisante pour renommer la catégorie ${category.name}:`, err);
          });
        }
      }
    }

    // 5. Envoyer l'annonce globale de fin de saison
    if (guildSettings.clanAnnouncementChannelId) {
      const announcementChannel = discordGuild.channels.cache.get(guildSettings.clanAnnouncementChannelId)
        || await discordGuild.channels.fetch(guildSettings.clanAnnouncementChannelId).catch(() => null);
        
      if (announcementChannel && announcementChannel.isTextBased()) {
        const globalEmbed = new EmbedBuilder()
          .setTitle(`🏁 Fin de la Saison de Clans ${currentSeason} !`)
          .setColor(0xF59E0B) // Amber
          .setTimestamp();

        if (winningClan) {
          let winnerText = `Le clan **${winningClan.name}** remporte la victoire pour cette saison avec un total de **${maxClanXp.toLocaleString('fr-FR')} XP** ! 🎉\n\n`;
          winnerText += `Ses membres bénéficient d'avantages exclusifs pour la **Saison ${nextSeason}** :\n`;
          if (guildSettings.clanRewardXpBoost) {
            winnerText += `- **Boost d'XP** : +${Math.round((guildSettings.clanRewardXpBoostRate - 1) * 100)}% d'XP sur tout le serveur !\n`;
          }
          if (guildSettings.clanRewardGiveaway) {
            winnerText += `- **Giveaways** : Plus de chances de remporter les tirages au sort !\n`;
          }
          
          if (leaderUserId) {
            winnerText += `\nFélicitations à <@${leaderUserId}>, couronné **Chef de Coalition** du clan avec une contribution record de **${leaderXp.toLocaleString('fr-FR')} XP** ! 👑`;
          }

          globalEmbed.setDescription(winnerText);
        } else {
          globalEmbed.setDescription(`La saison de clans ${currentSeason} se termine. Aucun clan n'a accumulé d'XP cette saison.`);
        }

        await announcementChannel.send({ embeds: [globalEmbed] }).catch((err) => {
          logger.warn('ClanService', 'Impossible d\'envoyer l\'annonce globale de fin de saison:', err);
        });
      }
    }

    // 6. Envoyer l'annonce interne dans le QG du clan vainqueur
    if (winningClan && winningClan.generalChannelId) {
      const qgChannel = discordGuild.channels.cache.get(winningClan.generalChannelId)
        || await discordGuild.channels.fetch(winningClan.generalChannelId).catch(() => null);
        
      if (qgChannel && qgChannel.isTextBased()) {
        const localEmbed = new EmbedBuilder()
          .setTitle(`🏆 Victoire du Clan ${winningClan.name} !`)
          .setDescription(
            `Félicitations à tous les membres ! Grâce à votre investissement, notre clan remporte la **Saison ${currentSeason}** ! 🎉\n\n` +
            `Nos bonus sont maintenant actifs dans toute notre catégorie QG. ` +
            (leaderUserId ? `Un salut spécial à notre **Chef de Coalition** <@${leaderUserId}> pour son score impressionnant de **${leaderXp.toLocaleString('fr-FR')} XP** ! 👑` : '')
          )
          .setColor(0x10B981) // Green
          .setTimestamp();

        await qgChannel.send({ embeds: [localEmbed] }).catch((err) => {
          logger.warn('ClanService', `Impossible d'envoyer l'annonce locale de victoire dans le QG de ${winningClan.name}:`, err);
        });
      }
    }
  } catch (err) {
    logger.error('ClanService', `Erreur critique lors de la fin de saison de clans pour le serveur ${guildId}:`, err);
  }
}

/**
 * Vérifie si la saison de clans active a atteint sa date de fin et procède
 * au reset et à l'application des récompenses.
 */
export async function checkAndProgressClanSeasons(client: Client): Promise<void> {
  try {
    const now = new Date();

    // Trouver tous les serveurs avec les clans activés et une date de fin de saison dépassée
    const guildsToReset = await prisma.guild.findMany({
      where: {
        clansEnabled: true,
        clanSeasonEndsAt: {
          not: null,
          lte: now,
        },
      },
      select: {
        id: true,
        currentClanSeason: true,
        clanSeasonStartsAt: true,
        clanSeasonEndsAt: true,
      },
    });

    for (const guild of guildsToReset) {
      logger.info('ClanService', `Déclenchement automatique de la fin de saison de clans pour le serveur ${guild.id}`);

      const nextSeason = guild.currentClanSeason + 1;

      // Déterminer la nouvelle plage de dates si la saison précédente avait une durée planifiée
      let nextStartsAt: Date | null = null;
      let nextEndsAt: Date | null = null;

      if (guild.clanSeasonStartsAt && guild.clanSeasonEndsAt) {
        const durationMs = guild.clanSeasonEndsAt.getTime() - guild.clanSeasonStartsAt.getTime();
        nextStartsAt = now;
        nextEndsAt = new Date(now.getTime() + durationMs);
      }

      // 1. Décerner les bonus, renommer les QG et publier les annonces
      await handleEndSeason(guild.id, client, 'Système (Planifié)', guild.currentClanSeason, nextSeason);

      // 2. Mettre à jour la saison et les dates en BDD
      await prisma.guild.update({
        where: { id: guild.id },
        data: {
          currentClanSeason: nextSeason,
          clanSeasonStartsAt: nextStartsAt,
          clanSeasonEndsAt: nextEndsAt,
        },
      });

      logger.info('ClanService', `Saison de clans réinitialisée automatiquement. Nouvelle saison: ${nextSeason} (Fin: ${nextEndsAt})`);
    }
  } catch (err) {
    logger.error('ClanService', 'Erreur lors de la vérification planifiée des saisons de clans:', err);
  }
}
