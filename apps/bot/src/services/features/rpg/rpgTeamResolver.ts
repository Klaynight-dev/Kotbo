/**
 * Équipe d'un joueur, pour tout ce qui se joue collectivement dans le RPG.
 *
 * Deux systèmes s'y appuient - le raid hebdomadaire et les quêtes d'équipe - et ils doivent
 * répondre la même chose : un membre qui frappe un boss de raid et un membre qui pousse le
 * compteur d'une quête appartiennent au même clan, ou à aucun.
 *
 * En mode clan, l'appartenance se lit sur les rôles Discord, comme partout ailleurs dans le
 * module Clans. En mode guilde RPG, elle se lit sur le profil de jeu.
 */

import type { Client, GuildMember } from 'discord.js';
import prisma from '../../../utils/db.js';

export const RPG_TEAM_MODES = ['CLAN', 'RPG_GUILD'] as const;
export type RpgTeamMode = (typeof RPG_TEAM_MODES)[number];

export function isRpgTeamMode(value: unknown): value is RpgTeamMode {
  return typeof value === 'string' && (RPG_TEAM_MODES as readonly string[]).includes(value);
}

export function asRpgTeamMode(value: unknown): RpgTeamMode {
  return isRpgTeamMode(value) ? value : 'CLAN';
}

export interface RpgTeamIdentity {
  key: string;
  name: string;
  /**
   * Effectif de l'équipe, compté seulement quand on en a besoin.
   *
   * Le compte est paresseux parce qu'il coûte cher : en mode clan, il faut peupler le cache
   * des membres du serveur entier, et le payer à chaque action de jeu serait absurde.
   */
  countMembers: () => Promise<number>;
}

export async function resolveRpgTeam(
  guildId: string,
  userId: string,
  mode: RpgTeamMode,
  member: GuildMember | null,
): Promise<RpgTeamIdentity | null> {
  if (mode === 'CLAN') {
    if (!member) return null;
    const clans = await prisma.clan.findMany({ where: { guildId }, select: { id: true, name: true, roleId: true } });
    const clan = clans.find((entry) => member.roles.cache.has(entry.roleId));
    if (!clan) return null;

    return {
      key: clan.id,
      name: clan.name,
      countMembers: async () => {
        // Sans `members.fetch()`, l'effectif d'un rôle est celui des membres déjà vus, et
        // une équipe entière peut compter pour une seule personne.
        await member.guild.members.fetch().catch(() => null);
        return Math.max(1, member.guild.roles.cache.get(clan.roleId)?.members.size ?? 1);
      },
    };
  }

  const profile = await prisma.rpgProfile.findUnique({
    where: { guildId_userId: { guildId, userId } },
    select: { rpgGuild: { select: { id: true, name: true } } },
  });
  if (!profile?.rpgGuild) return null;

  const rpgGuildId = profile.rpgGuild.id;
  return {
    key: rpgGuildId,
    name: profile.rpgGuild.name,
    countMembers: async () => Math.max(1, await prisma.rpgProfile.count({ where: { guildId, rpgGuildId } })),
  };
}

/**
 * Même chose depuis un client plutôt qu'un membre déjà chargé.
 *
 * Les actions de jeu qui alimentent les quêtes - un monstre vaincu, un poisson pêché - ne
 * portent pas le membre Discord jusqu'au service : seul le client est à portée. La lecture
 * du cache évite un aller-retour dans l'immense majorité des cas.
 */
export async function resolveRpgTeamForUser(
  guildId: string,
  userId: string,
  mode: RpgTeamMode,
  client: Client,
): Promise<RpgTeamIdentity | null> {
  if (mode !== 'CLAN') return resolveRpgTeam(guildId, userId, mode, null);

  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return null;

  const member = guild.members.cache.get(userId) ?? await guild.members.fetch(userId).catch(() => null);
  return resolveRpgTeam(guildId, userId, mode, member ?? null);
}
