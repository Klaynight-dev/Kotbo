/**
 * Front RPG de la guerre des équipes.
 *
 * Le RPG verse déjà des points d'équipe - un monstre abattu, un boss tombé, une
 * quête rendue, un raid mené à terme - mais ces points disparaissaient dans le
 * classement général des clans : rien, dans le jeu, ne disait à un joueur ce que
 * son clan ou sa guilde avait gagné grâce à lui. Ce module isole la part du
 * classement produite par le RPG, pour que le hub puisse en faire un tableau de
 * guerre lisible depuis `/rpg`.
 *
 * Deux modes, ceux du reste du module : les points vont aux clans du serveur
 * (rôles Discord) ou aux guildes RPG, selon `EconomyConfig.raidTeamMode`.
 */

import type { GuildMember } from 'discord.js';
import prisma from '../../../utils/db.js';
import { getOrCreateEconomyConfig } from '../economyService.js';
import { asRpgTeamMode, resolveRpgTeam, type RpgTeamMode } from './rpgTeamResolver.js';

/**
 * Origines de points produites par le RPG.
 *
 * Le tableau de guerre ne compte que celles-ci : mélanger l'XP de messagerie ou
 * les paris aux prises de guerre ferait gagner la guerre à qui parle le plus.
 */
export const RPG_CLAN_WAR_SOURCES = ['RPG_MOB', 'RPG_BOSS', 'RPG_ITEM', 'RPG_QUEST', 'RPG_RAID'] as const;

/** Fenêtre observée. La semaine sert de front courant, la saison de bilan. */
export const CLAN_WAR_SCOPES = ['season', 'week'] as const;
export type ClanWarScope = (typeof CLAN_WAR_SCOPES)[number];

export function asClanWarScope(value: unknown): ClanWarScope {
  return value === 'week' ? 'week' : 'season';
}

/** Raison pour laquelle aucun front n'est ouvert, à afficher telle quelle. */
export type ClanWarClosure = 'CLANS_OFF' | 'BRIDGE_OFF' | 'GUILDS_OFF';

export interface ClanWarTeam {
  key: string;
  name: string;
  points: number;
  /** Niveau de guilde RPG. Absent en mode clan, qui n'en a pas. */
  level?: number;
  members: number;
}

export interface ClanWarContributor {
  userId: string;
  points: number;
}

export interface ClanWarState {
  mode: RpgTeamMode;
  scope: ClanWarScope;
  season: number;
  /** Nul quand le front est ouvert ; sinon, dit pourquoi il ne l'est pas. */
  closure: ClanWarClosure | null;
  standings: ClanWarTeam[];
  viewer: {
    teamKey: string | null;
    teamName: string | null;
    /** Rang dans `standings`, 1-indexé. Nul si le joueur n'a pas d'équipe. */
    rank: number | null;
    /** Ce que le joueur a lui-même rapporté sur la fenêtre observée. */
    points: number;
  };
  /** Meilleurs pourvoyeurs de l'équipe du joueur, du plus gros au plus petit. */
  topContributors: ClanWarContributor[];
}

/** Début de la semaine courante (lundi 00:00, fuseau du processus). */
function startOfWeek(now = new Date()): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  // getDay() : 0 = dimanche. La semaine de jeu commence le lundi, comme le raid.
  const offset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - offset);
  return start;
}

const TOP_CONTRIBUTORS = 5;
const STANDINGS_LIMIT = 10;

type WarBoard = Omit<ClanWarState, 'mode' | 'scope' | 'season' | 'closure'>;

const EMPTY_BOARD: WarBoard = {
  standings: [],
  viewer: { teamKey: null, teamName: null, rank: null, points: 0 },
  topContributors: [],
};

/**
 * Classement des clans sur la part RPG du score, et place du joueur dedans.
 *
 * Le total d'un clan se lit sur le journal des gains plutôt que sur la colonne
 * agrégée `ClanMemberContribution.xp` : celle-ci mélange toutes les origines, et
 * rien ne permet d'en extraire ce que le RPG a rapporté.
 */
async function buildClanStandings(
  guildId: string,
  season: number,
  scope: ClanWarScope,
  member: GuildMember | null,
): Promise<WarBoard> {
  const where = {
    guildId,
    season,
    source: { in: [...RPG_CLAN_WAR_SOURCES] },
    ...(scope === 'week' ? { createdAt: { gte: startOfWeek() } } : {}),
  };

  const [clans, totals] = await Promise.all([
    prisma.clan.findMany({ where: { guildId }, select: { id: true, name: true, roleId: true } }),
    prisma.clanContributionEvent.groupBy({ by: ['clanId'], where, _sum: { amount: true } }),
  ]);

  const pointsByClan = new Map(totals.map((row) => [row.clanId, row._sum.amount ?? 0]));
  const viewerClan = member ? clans.find((clan) => member.roles.cache.has(clan.roleId)) ?? null : null;

  // Un clan sans prise de guerre reste au tableau à zéro : le faire disparaître
  // laisserait croire qu'il n'existe pas, alors qu'il est seulement en retard.
  const standings: ClanWarTeam[] = clans
    .map((clan) => ({
      key: clan.id,
      name: clan.name,
      points: pointsByClan.get(clan.id) ?? 0,
      members: member?.guild.roles.cache.get(clan.roleId)?.members.size ?? 0,
    }))
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name))
    .slice(0, STANDINGS_LIMIT);

  if (!viewerClan || !member) {
    return { ...EMPTY_BOARD, standings };
  }

  const contributors = await prisma.clanContributionEvent.groupBy({
    by: ['userId'],
    where: { ...where, clanId: viewerClan.id },
    _sum: { amount: true },
  });

  const ranked = contributors
    .map((row) => ({ userId: row.userId, points: row._sum.amount ?? 0 }))
    .filter((row) => row.points > 0)
    .sort((a, b) => b.points - a.points);

  const rankIndex = standings.findIndex((team) => team.key === viewerClan.id);

  return {
    standings,
    viewer: {
      teamKey: viewerClan.id,
      teamName: viewerClan.name,
      rank: rankIndex >= 0 ? rankIndex + 1 : null,
      points: ranked.find((row) => row.userId === member.id)?.points ?? 0,
    },
    topContributors: ranked.slice(0, TOP_CONTRIBUTORS),
  };
}

/**
 * Classement des guildes RPG.
 *
 * Les guildes n'ont pas de journal de gains : leur score de guerre est la
 * progression accumulée, qui ne vient que du jeu. La fenêtre hebdomadaire n'a
 * donc rien à filtrer, et le tableau dit la même chose dans les deux portées.
 */
async function buildRpgGuildStandings(guildId: string, userId: string): Promise<WarBoard> {
  const guilds = await prisma.rpgGuild.findMany({
    where: { guildId },
    select: { id: true, name: true, level: true, xp: true, _count: { select: { members: true } } },
  });

  const scored = guilds
    .map((entry) => ({
      key: entry.id,
      name: entry.name,
      // Le niveau prime sur l'XP en cours : deux guildes de niveaux différents ne
      // se départagent pas sur la barre de progression de la plus haute.
      points: entry.level * 1_000_000 + entry.xp,
      level: entry.level,
      members: entry._count.members,
    }))
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));

  const profile = await prisma.rpgProfile.findUnique({
    where: { guildId_userId: { guildId, userId } },
    select: { rpgGuildId: true, level: true },
  });

  const standings = scored.slice(0, STANDINGS_LIMIT);
  const viewerGuild = profile?.rpgGuildId
    ? scored.find((entry) => entry.key === profile.rpgGuildId) ?? null
    : null;

  if (!viewerGuild) {
    return { ...EMPTY_BOARD, standings };
  }

  const members = await prisma.rpgProfile.findMany({
    where: { guildId, rpgGuildId: viewerGuild.key },
    select: { userId: true, level: true },
    orderBy: { level: 'desc' },
    take: TOP_CONTRIBUTORS,
  });

  const rankIndex = standings.findIndex((team) => team.key === viewerGuild.key);

  return {
    standings,
    viewer: {
      teamKey: viewerGuild.key,
      teamName: viewerGuild.name,
      rank: rankIndex >= 0 ? rankIndex + 1 : null,
      points: profile?.level ?? 0,
    },
    topContributors: members.map((entry) => ({ userId: entry.userId, points: entry.level })),
  };
}

/**
 * État complet du front, prêt à afficher.
 *
 * Le `member` n'est requis qu'en mode clan, où l'appartenance se lit sur les
 * rôles Discord. Sans lui, le tableau reste consultable : seule la ligne du
 * joueur manque.
 */
export async function getClanWarState(params: {
  guildId: string;
  userId: string;
  member: GuildMember | null;
  scope?: ClanWarScope;
}): Promise<ClanWarState> {
  const scope = asClanWarScope(params.scope);
  const config = await getOrCreateEconomyConfig(params.guildId);
  const mode = asRpgTeamMode(config.raidTeamMode);

  if (mode === 'RPG_GUILD') {
    if (!config.guildsEnabled) {
      return { mode, scope, season: 0, closure: 'GUILDS_OFF', ...EMPTY_BOARD };
    }
    const board = await buildRpgGuildStandings(params.guildId, params.userId);
    return { mode, scope, season: 0, closure: null, ...board };
  }

  const guild = await prisma.guild.findUnique({
    where: { id: params.guildId },
    select: { clansEnabled: true, clanPointsFromRpg: true, currentClanSeason: true },
  });

  const season = guild?.currentClanSeason ?? 1;
  if (!guild?.clansEnabled) {
    return { mode, scope, season, closure: 'CLANS_OFF', ...EMPTY_BOARD };
  }
  // Pont RPG → Clans coupé, le tableau resterait figé sur d'anciennes prises :
  // mieux vaut annoncer un front fermé qu'afficher un classement mort.
  if (!guild.clanPointsFromRpg) {
    return { mode, scope, season, closure: 'BRIDGE_OFF', ...EMPTY_BOARD };
  }

  const board = await buildClanStandings(params.guildId, season, scope, params.member);
  return { mode, scope, season, closure: null, ...board };
}

/**
 * Équipe du joueur, en une ligne, pour l'écran de guilde.
 *
 * La fiche de guilde RPG ne disait rien du clan auquel le joueur appartient :
 * les deux appartenances coexistent, et c'est le mode d'équipe du serveur qui
 * décide laquelle encaisse le jeu.
 */
export async function getViewerWarTeam(
  guildId: string,
  userId: string,
  member: GuildMember | null,
): Promise<{ mode: RpgTeamMode; name: string | null }> {
  const config = await getOrCreateEconomyConfig(guildId);
  const mode = asRpgTeamMode(config.raidTeamMode);
  const team = await resolveRpgTeam(guildId, userId, mode, member);
  return { mode, name: team?.name ?? null };
}
