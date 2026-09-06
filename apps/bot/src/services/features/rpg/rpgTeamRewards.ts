/**
 * Qui encaisse les points gagnés par un joueur, selon les équipes du serveur.
 *
 * Le module vit à part du résolveur d'équipe : celui-ci est tiré par les règles pures des
 * quêtes, qui n'ont aucune raison de charger le service économique avec lui.
 */

import type { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { awardRpgGuildXp, getOrCreateEconomyConfig } from '../economyService.js';
import { shouldAwardClanPoints } from './rpgBestiaryPolicy.js';
import { asRpgTeamMode } from './rpgTeamResolver.js';

/**
 * Verse à un joueur les points d'équipe gagnés par une action personnelle.
 *
 * Un monstre abattu, une quête personnelle terminée : ce que dit la fiche est un montant,
 * et qui l'encaisse dépend de ce dont sont faites les équipes du serveur. Le point d'entrée
 * est commun aux deux, sans quoi une même prime irait au clan depuis la quête et à la
 * guilde depuis le bestiaire.
 *
 * Les récompenses d'équipe du raid et des quêtes collectives ne passent pas par ici : elles
 * créditent l'équipe qui a fait le travail, et non celle du joueur au moment du versement.
 */
export async function awardRpgTeamPoints(params: {
  client: Client;
  guildId: string;
  userId: string;
  amount: number;
  source: 'RPG_MOB' | 'RPG_BOSS' | 'RPG_QUEST';
  reason: string;
}): Promise<{ amount: number; toGuild: boolean }> {
  const none = { amount: 0, toGuild: false };
  const amount = Math.max(0, Math.trunc(Number(params.amount) || 0));
  if (amount === 0) return none;

  try {
    const config = await getOrCreateEconomyConfig(params.guildId);
    if (asRpgTeamMode(config.raidTeamMode) === 'RPG_GUILD') {
      if (!config.guildsEnabled) return none;

      const profile = await prisma.rpgProfile.findUnique({
        where: { guildId_userId: { guildId: params.guildId, userId: params.userId } },
        select: { rpgGuildId: true },
      });
      if (!profile?.rpgGuildId) return none;

      const awarded = await awardRpgGuildXp(profile.rpgGuildId, amount);
      return awarded ? { amount, toGuild: true } : none;
    }

    // Le pont RPG vers les clans se coupe sans toucher aux primes réglées sur les fiches :
    // un serveur qui l'a fermé ne doit plus rien recevoir du RPG.
    const guild = await prisma.guild.findUnique({
      where: { id: params.guildId },
      select: { clansEnabled: true, clanPointsFromRpg: true },
    });
    if (!shouldAwardClanPoints(guild, amount)) return none;

    const { awardClanPointsToMembers } = await import('../../community/clanService.js');
    const granted = await awardClanPointsToMembers({
      guildId: params.guildId,
      client: params.client,
      source: params.source,
      awards: [{ userId: params.userId, amount }],
      reason: params.reason,
    });
    return { amount: granted.get(params.userId) ?? 0, toGuild: false };
  } catch (error) {
    // L'action est déjà résolue et payée : un incident côté clans ou guilde ne doit pas la
    // faire échouer après coup.
    logger.error('RpgTeam', `Points d'équipe non versés sur ${params.guildId}:`, error);
    return none;
  }
}
