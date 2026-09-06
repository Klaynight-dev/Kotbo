/**
 * Raid hebdomadaire : cycle de vie, assauts et récompenses.
 *
 * Chaque équipe affronte **sa propre instance** du boss, dont la réserve de points de vie
 * suit son effectif. Une réserve unique partagée par tout le serveur laisserait les petites
 * équipes sans rien à frapper, et ferait du raid une course au clic plutôt qu'une épreuve
 * comparable d'une équipe à l'autre.
 *
 * Les instances sont créées au premier assaut d'une équipe et non à l'ouverture : compter
 * l'effectif de chaque clan coûte un `members.fetch()` du serveur, qu'il serait absurde de
 * payer pour des équipes qui ne viendront jamais.
 */

import type { Client, GuildMember } from 'discord.js';
import type { Prisma } from '@prisma/client';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { awardRpgGuildXp, checkLevelUp, getOrCreateEconomyConfig, getOrCreateRpgProfile } from '../economyService.js';
import { loadEffectiveStats } from '../combatService.js';
import { getAvailableSkills } from './rpgClasses.js';
import { resolveGuildTimezone } from '../../../utils/timezone.js';
import { buildSeedBoss, RAID_BOSSES } from './rpgRaidContent.js';
import {
  asRaidTeamMode,
  clampInt,
  computeTeamEnvelope,
  computeTeamHealth,
  normalizeRaidBossInput,
  parseRaidSpells,
  planNextRaidWindow,
  splitRaidRewards,
  RAID_ASSAULTS_RANGE,
  RAID_BOUGHT_ASSAULTS_RANGE,
  RAID_CLAN_POINTS_RANGE,
  RAID_CONSOLATION_RANGE,
  RAID_DURATION_RANGE,
  RAID_ENERGY_RANGE,
  RAID_HEALTH_BOUND_RANGE,
  RAID_HEALTH_PER_MEMBER_RANGE,
  RAID_HOUR_RANGE,
  RAID_REWARD_RANGE,
  RAID_WEEKDAY_RANGE,
  type RaidBossInput,
} from './rpgRaidPolicy.js';
import { runRaidAssault, type RaidAssaultResult } from './rpgRaidCombat.js';
import { resolveRpgTeam, type RpgTeamIdentity } from './rpgTeamResolver.js';
import { shouldAwardClanPoints } from './rpgBestiaryPolicy.js';

type EconomyConfig = Awaited<ReturnType<typeof getOrCreateEconomyConfig>>;

export class RaidError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
    this.name = 'RaidError';
  }
}

// ── Catalogue de boss du serveur ──────────────────────────────────────────

/**
 * Dépose les boss livrés de base qui manquent encore au serveur.
 *
 * Seuls les noms absents sont ajoutés, comme le fait le seed du bestiaire : un serveur qui
 * a supprimé ou réécrit un boss ne doit pas le voir revenir à chaque redémarrage, mais un
 * boss ajouté au catalogue plus tard doit lui parvenir.
 */
export async function seedGuildRaidBosses(guildId: string): Promise<number> {
  const existing = await prisma.rpgRaidBoss.findMany({ where: { guildId }, select: { name: true } });
  const known = new Set(existing.map((boss) => boss.name));
  const missing = RAID_BOSSES.filter((boss) => !known.has(boss.name));
  if (missing.length === 0) return 0;

  await prisma.rpgRaidBoss.createMany({
    data: missing.map((seed) => {
      const boss = buildSeedBoss(seed);
      return {
        guildId,
        name: boss.name,
        description: boss.description,
        emoji: boss.emoji,
        level: boss.level,
        attack: boss.attack,
        defense: boss.defense,
        speed: boss.speed,
        spells: boss.spells as unknown as Prisma.InputJsonValue,
      };
    }),
    skipDuplicates: true,
  });

  return missing.length;
}

export async function listGuildRaidBosses(guildId: string) {
  const bosses = await prisma.rpgRaidBoss.findMany({
    where: { guildId },
    orderBy: [{ level: 'asc' }, { name: 'asc' }],
  });
  return bosses.map((boss) => ({ ...boss, spells: parseRaidSpells(boss.spells) }));
}

export async function saveGuildRaidBoss(guildId: string, input: RaidBossInput, bossId?: string) {
  const normalized = normalizeRaidBossInput(input);
  if (!normalized.ok) throw new RaidError(normalized.error, 400);
  const data = normalized.value;

  const twin = await prisma.rpgRaidBoss.findFirst({
    where: { guildId, name: data.name, ...(bossId ? { NOT: { id: bossId } } : {}) },
    select: { id: true },
  });
  if (twin) throw new RaidError(`Un boss de raid se nomme déjà « ${data.name} ».`, 409);

  const payload = {
    name: data.name,
    description: data.description,
    emoji: data.emoji,
    level: data.level,
    attack: data.attack,
    defense: data.defense,
    speed: data.speed,
    spells: data.spells as unknown as Prisma.InputJsonValue,
    enabled: data.enabled,
  };

  if (!bossId) {
    return { boss: await prisma.rpgRaidBoss.create({ data: { guildId, ...payload } }), created: true };
  }

  const existing = await prisma.rpgRaidBoss.findUnique({ where: { id: bossId }, select: { guildId: true } });
  if (!existing) throw new RaidError('Boss de raid introuvable.', 404);
  if (existing.guildId !== guildId) throw new RaidError('Ce boss appartient à un autre serveur.', 403);

  return { boss: await prisma.rpgRaidBoss.update({ where: { id: bossId }, data: payload }), created: false };
}

export async function deleteGuildRaidBoss(guildId: string, bossId: string) {
  const existing = await prisma.rpgRaidBoss.findUnique({ where: { id: bossId }, select: { guildId: true, name: true } });
  if (!existing) throw new RaidError('Boss de raid introuvable.', 404);
  if (existing.guildId !== guildId) throw new RaidError('Ce boss appartient à un autre serveur.', 403);

  // Les raids passés gardent leur instantané : la relation est mise à null, pas en cascade,
  // pour qu'un palmarès ne disparaisse pas avec la fiche qui l'a produit.
  await prisma.rpgRaidBoss.delete({ where: { id: bossId } });
  return { name: existing.name };
}

// ── Planification ─────────────────────────────────────────────────────────

export async function getOpenRaid(guildId: string) {
  return prisma.rpgRaid.findFirst({
    where: { guildId, status: 'OPEN' },
    orderBy: { opensAt: 'desc' },
  });
}

export async function getScheduledRaid(guildId: string) {
  return prisma.rpgRaid.findFirst({
    where: { guildId, status: 'SCHEDULED' },
    orderBy: { opensAt: 'asc' },
  });
}

/** État du raid tel que le panneau `/rpg` et le dashboard doivent l'afficher. */
export async function getRaidState(guildId: string) {
  const [config, open, scheduled] = await Promise.all([
    getOrCreateEconomyConfig(guildId),
    getOpenRaid(guildId),
    getScheduledRaid(guildId),
  ]);

  return {
    enabled: config.enabled && config.raidEnabled,
    teamMode: asRaidTeamMode(config.raidTeamMode),
    open,
    nextOpensAt: scheduled?.opensAt ?? null,
  };
}

/**
 * Tout ce que l'écran raid du panneau `/rpg` a besoin d'afficher.
 *
 * L'écran existe parce que l'annonce était le seul autre point d'entrée : un membre arrivé
 * après elle, un salon nettoyé, et le raid de la semaine devenait introuvable alors qu'il
 * tournait toujours. La lecture se fait ici et non dans le panneau, comme tout ce qui
 * touche la base.
 */
export async function getRaidPanelState(guildId: string, userId: string, member: GuildMember | null) {
  const [config, open, scheduled] = await Promise.all([
    getOrCreateEconomyConfig(guildId),
    getOpenRaid(guildId),
    getScheduledRaid(guildId),
  ]);

  const enabled = config.enabled && config.raidEnabled;
  const nextOpensAt = scheduled?.opensAt ?? null;
  if (!enabled || !open) {
    return { enabled, raid: null, nextOpensAt, teams: [], viewer: null };
  }

  const mode = asRaidTeamMode(open.teamMode);
  const [teams, identity, assaultsDone, bought] = await Promise.all([
    listRaidTeams(open.id),
    resolveRaidTeam(guildId, userId, mode, member),
    prisma.rpgRaidAssault.count({ where: { userId, team: { raidId: open.id } } }),
    boughtAssaults(open.id, userId),
  ]);

  const personalQuota = open.assaultsPerMember + bought;

  const engaged = identity ? teams.find((team) => team.teamKey === identity.key) ?? null : null;

  return {
    enabled,
    raid: open,
    nextOpensAt,
    teams,
    viewer: {
      mode,
      teamName: identity?.name ?? null,
      engaged,
      assaultsLeft: Math.max(0, personalQuota - assaultsDone),
      // Une équipe qui a mis son boss à terre a fini sa semaine : le bouton n'a plus lieu
      // d'être proposé, `attackRaid` le refuserait de toute façon.
      canAttack: identity !== null
        && assaultsDone < personalQuota
        && (engaged?.remainingHealth ?? 1) > 0,
    },
  };
}

/**
 * Choisit le boss du prochain raid.
 *
 * Un nom fixé qui ne correspond plus à rien - fiche renommée ou supprimée - ne doit pas
 * empêcher le raid d'ouvrir : on retombe alors sur le tirage au sort, faute de quoi le
 * serveur perdrait ses raids sans le moindre signal.
 */
async function pickRaidBoss(guildId: string, config: EconomyConfig) {
  const bosses = await prisma.rpgRaidBoss.findMany({ where: { guildId, enabled: true } });
  if (bosses.length === 0) return null;

  if (config.raidBossName) {
    const chosen = bosses.find((boss) => boss.name === config.raidBossName);
    if (chosen) return chosen;
  }

  return bosses[Math.floor(Math.random() * bosses.length)];
}

/**
 * Planifie le prochain raid si aucun n'est ni ouvert ni en attente.
 *
 * Sans ouverture automatique, rien n'est planifié : le serveur lance son raid quand son
 * équipe est là, et une fenêtre qui l'attendrait déjà en base ouvrirait toute seule le
 * samedi suivant, ce que le réglage dit justement de ne plus faire.
 */
export async function ensureRaidSchedule(guildId: string, config: EconomyConfig): Promise<void> {
  if (!config.raidAutoSchedule) return;

  const [open, scheduled] = await Promise.all([getOpenRaid(guildId), getScheduledRaid(guildId)]);
  if (open || scheduled) return;

  const timezone = await resolveGuildTimezone(guildId);
  const window = planNextRaidWindow(new Date(), {
    weekday: clampInt(config.raidWeekday, RAID_WEEKDAY_RANGE, 6),
    hour: clampInt(config.raidHour, RAID_HOUR_RANGE, 20),
    durationHours: clampInt(config.raidDurationHours, RAID_DURATION_RANGE, 24),
  }, timezone);

  await createRaid(guildId, config, { status: 'SCHEDULED', window });
}

/**
 * Réglages chiffrés d'une fenêtre, relus sur la configuration du serveur.
 *
 * Ils sont recopiés sur le raid à chaque écriture - planification, ouverture, lancement
 * manuel - et non lus en direct pendant la fenêtre : une équipe qui frappe en premier et
 * une qui frappe le lendemain doivent courir la même épreuve, pour les mêmes récompenses.
 */
function raidSettings(config: EconomyConfig) {
  return {
    teamMode: asRaidTeamMode(config.raidTeamMode),
    healthPerMember: clampInt(config.raidHealthPerMember, RAID_HEALTH_PER_MEMBER_RANGE, 1200),
    healthFloor: clampInt(config.raidHealthFloor, RAID_HEALTH_BOUND_RANGE, 2500),
    healthCap: clampInt(config.raidHealthCap, RAID_HEALTH_BOUND_RANGE, 60_000),
    assaultsPerMember: clampInt(config.raidAssaultsPerMember, RAID_ASSAULTS_RANGE, 3),
    boughtAssaultsMax: clampInt(config.raidBoughtAssaultsMax, RAID_BOUGHT_ASSAULTS_RANGE, 3),
    consolationShare: clampInt(config.raidConsolationShare, RAID_CONSOLATION_RANGE, 25),
    energyCost: clampInt(config.raidEnergyCost, RAID_ENERGY_RANGE, 25),
    xpReward: clampInt(config.raidXpReward, RAID_REWARD_RANGE, 60),
    coinReward: clampInt(config.raidCoinReward, RAID_REWARD_RANGE, 45),
    clanPoints: clampInt(config.raidClanPoints, RAID_CLAN_POINTS_RANGE, 6),
    announceChannelId: config.raidChannelId,
  };
}

/**
 * Ouvre un raid sur-le-champ, sans attendre le jour réglé.
 *
 * Une fenêtre déjà en attente est reprise plutôt que doublée : deux raids ouverts en même
 * temps donneraient deux instances à la même équipe, et les récompenses de la semaine
 * seraient versées deux fois.
 */
export async function startRaidNow(guildId: string, config: EconomyConfig): Promise<{ id: string }> {
  if (!config.enabled || !config.raidEnabled) throw new RaidError("Le raid n'est pas activé sur ce serveur.", 403);

  const open = await getOpenRaid(guildId);
  if (open) throw new RaidError('Un raid est déjà en cours.', 409);

  const opensAt = new Date();
  const closesAt = new Date(
    opensAt.getTime() + clampInt(config.raidDurationHours, RAID_DURATION_RANGE, 24) * 60 * 60 * 1000,
  );

  const scheduled = await getScheduledRaid(guildId);
  if (scheduled) {
    // Le boss de la fenêtre en attente est conservé : il a déjà été tiré, et en changer au
    // dernier moment ferait mentir ce que le dashboard annonçait. Les réglages chiffrés,
    // eux, sont relus comme à toute ouverture.
    await prisma.rpgRaid.update({
      where: { id: scheduled.id },
      data: { status: 'OPEN', opensAt, closesAt, ...raidSettings(config) },
    });
    return { id: scheduled.id };
  }

  return createRaid(guildId, config, { status: 'OPEN', window: { opensAt, closesAt } });
}

/** Écrit un raid, avec l'instantané du boss tiré au moment de l'écriture. */
async function createRaid(
  guildId: string,
  config: EconomyConfig,
  options: { status: 'SCHEDULED' | 'OPEN'; window: { opensAt: Date; closesAt: Date } },
): Promise<{ id: string }> {
  await seedGuildRaidBosses(guildId);
  const boss = await pickRaidBoss(guildId, config);
  if (!boss) {
    if (options.status === 'OPEN') {
      throw new RaidError("Aucun boss de raid actif : ajoutez-en un avant de lancer un raid.", 409);
    }
    logger.warn('RpgRaid', `Aucun boss de raid actif pour ${guildId} : planification impossible.`);
    return { id: '' };
  }

  const window = options.window;
  return prisma.rpgRaid.create({
    select: { id: true },
    data: {
      guildId,
      bossId: boss.id,
      status: options.status,
      // Les caractéristiques sont recopiées dès la planification : modifier la fiche ou
      // appliquer un palier de difficulté en pleine fenêtre changerait l'épreuve en cours
      // de route, et les équipes qui ont frappé en premier n'auraient pas couru la même.
      bossName: boss.name,
      bossEmoji: boss.emoji,
      bossLevel: boss.level,
      bossAttack: boss.attack,
      bossDefense: boss.defense,
      bossSpeed: boss.speed,
      bossSpells: parseRaidSpells(boss.spells) as unknown as Prisma.InputJsonValue,
      ...raidSettings(config),
      opensAt: window.opensAt,
      closesAt: window.closesAt,
    },
  });
}

// ── Assauts achetés ───────────────────────────────────────────────────────

/**
 * Assauts qu'un membre s'est offerts sur le raid en cours.
 *
 * Zéro tant qu'il n'a rien bu : la ligne n'est créée qu'au premier octroi, la table ne
 * portant que ceux qui ont dépensé quelque chose.
 */
async function boughtAssaults(raidId: string, userId: string): Promise<number> {
  const bonus = await prisma.rpgRaidBonus.findUnique({
    where: { raidId_userId: { raidId, userId } },
    select: { extraAssaults: true },
  });
  return bonus?.extraAssaults ?? 0;
}

type GrantResolution =
  | { ok: true; raidId: string; grant: number; left: number; max: number }
  | { ok: false; reason: string };

/**
 * Résout un achat d'assauts : le raid visé, et ce qu'on peut réellement créditer.
 *
 * Le contrôle et le versement passent tous deux par ici, pour ne lire le raid qu'une fois
 * et pour que le montant soit assaini au même endroit : un nombre aberrant venu d'une fiche
 * d'objet ne doit pas se retrouver dans une colonne entière.
 */
async function resolveAssaultGrant(guildId: string, userId: string, amount: number): Promise<GrantResolution> {
  const wanted = Math.max(0, Math.trunc(Number(amount)) || 0);
  if (wanted === 0) return { ok: false, reason: "Cette potion ne rend aucun assaut de raid." };

  const raid = await getOpenRaid(guildId);
  if (!raid || raid.closesAt.getTime() <= Date.now()) {
    return { ok: false, reason: "Aucun raid n'est en cours : cette potion ne se boit que pendant une fenêtre ouverte." };
  }

  const max = raid.boughtAssaultsMax;
  if (max === 0) return { ok: false, reason: "Ce serveur n'autorise pas d'assauts supplémentaires." };

  const left = Math.max(0, max - await boughtAssaults(raid.id, userId));
  if (left === 0) {
    return { ok: false, reason: `Vous avez déjà acheté vos ${max} assauts supplémentaires pour ce raid.` };
  }

  return { ok: true, raidId: raid.id, grant: Math.min(wanted, left), left, max };
}

export interface RaidGrantCheck {
  ok: boolean;
  /** Ce qu'il reste d'achetable sur ce raid, une fois le plafond appliqué. */
  left: number;
  reason?: string;
}

/**
 * Un membre peut-il encore s'offrir des assauts sur le raid en cours ?
 *
 * Le contrôle existe pour être posé **avant** de consommer la potion : autrement, boire
 * hors fenêtre ou au-delà du plafond coûterait l'objet sans rien rendre.
 */
export async function checkRaidAssaultGrant(guildId: string, userId: string, amount: number): Promise<RaidGrantCheck> {
  const resolution = await resolveAssaultGrant(guildId, userId, amount);
  return resolution.ok
    ? { ok: true, left: resolution.left }
    : { ok: false, left: 0, reason: resolution.reason };
}

/**
 * Crédite un membre d'assauts supplémentaires sur le raid en cours.
 *
 * Le montant est raboté ici et pas seulement au contrôle, et le total est ramené sous le
 * plafond après coup : la lecture et l'incrément ne sont pas un seul geste, deux potions
 * bues ensemble le franchiraient sinon.
 */
export async function grantRaidAssaults(guildId: string, userId: string, amount: number): Promise<number> {
  const resolution = await resolveAssaultGrant(guildId, userId, amount);
  if (!resolution.ok) return 0;

  const bonus = await prisma.rpgRaidBonus.upsert({
    where: { raidId_userId: { raidId: resolution.raidId, userId } },
    create: { raidId: resolution.raidId, userId, extraAssaults: resolution.grant },
    update: { extraAssaults: { increment: resolution.grant } },
    select: { id: true, extraAssaults: true },
  });
  if (bonus.extraAssaults <= resolution.max) return resolution.grant;

  // Deux potions bues à la même milliseconde franchissent le plafond ensemble, la lecture
  // et l'incrément n'étant pas un seul geste. On ramène le total à ce que le serveur
  // autorise, et on n'annonce que la part qui a tenu.
  await prisma.rpgRaidBonus.update({
    where: { id: bonus.id },
    data: { extraAssaults: resolution.max },
  });

  return Math.max(0, resolution.grant - (bonus.extraAssaults - resolution.max));
}

// ── Équipes ───────────────────────────────────────────────────────────────

/**
 * Équipe d'un membre pour le mode en vigueur, ou `null` s'il n'en a pas.
 *
 * La résolution est commune au raid et aux quêtes d'équipe : les deux doivent répondre la
 * même chose, sans quoi un même membre appartiendrait à un clan pour l'un et à aucun pour
 * l'autre.
 */
export type RaidTeamIdentity = RpgTeamIdentity;
export const resolveRaidTeam = resolveRpgTeam;

async function getOrCreateTeam(raid: { id: string; healthPerMember: number; healthFloor: number; healthCap: number }, identity: RaidTeamIdentity) {
  const existing = await prisma.rpgRaidTeam.findUnique({
    where: { raidId_teamKey: { raidId: raid.id, teamKey: identity.key } },
  });
  if (existing) return existing;

  const memberCount = await identity.countMembers();
  const totalHealth = computeTeamHealth(memberCount, {
    healthPerMember: raid.healthPerMember,
    healthFloor: raid.healthFloor,
    healthCap: raid.healthCap,
  });

  // Deux membres qui frappent en même temps peuvent tenter la création ensemble : l'unicité
  // tranche, et le perdant relit la ligne du gagnant.
  try {
    return await prisma.rpgRaidTeam.create({
      data: {
        raidId: raid.id,
        teamKey: identity.key,
        teamName: identity.name,
        memberCount,
        totalHealth,
        remainingHealth: totalHealth,
      },
    });
  } catch {
    const team = await prisma.rpgRaidTeam.findUnique({
      where: { raidId_teamKey: { raidId: raid.id, teamKey: identity.key } },
    });
    if (!team) throw new RaidError("L'équipe n'a pas pu rejoindre le raid.", 500);
    return team;
  }
}

// ── Assaut ────────────────────────────────────────────────────────────────

export interface RaidAttackOutcome {
  raid: Awaited<ReturnType<typeof getOpenRaid>>;
  team: { name: string; remainingHealth: number; totalHealth: number; memberCount: number };
  result: RaidAssaultResult;
  killingBlow: boolean;
  assaultsLeft: number;
  rewards: { xp: number; coins: number; teamPoints: number } | null;
}

/**
 * Livre un assaut contre l'instance de l'équipe du membre.
 *
 * L'énergie est débitée avant le combat et rendue si celui-ci échoue : sans ce rattrapage,
 * une panne au milieu du calcul volerait l'assaut au joueur.
 */
export async function attackRaid(client: Client, guildId: string, userId: string, member: GuildMember | null): Promise<RaidAttackOutcome> {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.enabled || !config.raidEnabled) throw new RaidError("Le raid n'est pas activé sur ce serveur.", 403);

  const raid = await getOpenRaid(guildId);
  if (!raid) throw new RaidError("Aucun raid n'est en cours.", 404);

  // Le cycle ne referme la fenêtre qu'à la minute suivante : sans ce contrôle, une bonne
  // minute d'assauts passe après l'heure, et ceux qui arrivent une fois les récompenses
  // versées comptent leurs dégâts sans jamais être payés.
  if (raid.closesAt.getTime() <= Date.now()) throw new RaidError('Le raid vient de se terminer.', 409);

  const mode = asRaidTeamMode(raid.teamMode);
  const identity = await resolveRaidTeam(guildId, userId, mode, member);
  if (!identity) {
    throw new RaidError(
      mode === 'CLAN'
        ? "Vous n'appartenez à aucun clan : le raid se livre en équipe."
        : "Vous n'appartenez à aucune guilde RPG : le raid se livre en équipe.",
      403,
    );
  }

  // Le quota personnel se compte sur le raid entier et non sur la seule équipe frappée :
  // en mode guilde RPG, où l'on entre et sort d'une équipe à volonté, le compter par équipe
  // rendait trois assauts neufs à chaque changement, et une part de récompense dans chacune.
  //
  // Deux clics à la même milliseconde peuvent passer ce contrôle ensemble. Le coût en
  // énergie, lui, est atomique et reste le vrai frein : fermer complètement la fenêtre
  // demanderait de défaire un assaut déjà porté sur la réserve, pour un abus qui coûte
  // plus cher à celui qui le tente qu'au raid.
  const [alreadyDone, bought] = await Promise.all([
    prisma.rpgRaidAssault.count({ where: { userId, team: { raidId: raid.id } } }),
    boughtAssaults(raid.id, userId),
  ]);

  const personalQuota = raid.assaultsPerMember + bought;
  if (alreadyDone >= personalQuota) {
    throw new RaidError(
      bought > 0
        ? `Vous avez déjà livré vos ${personalQuota} assauts, potions comprises.`
        : `Vous avez déjà livré vos ${raid.assaultsPerMember} assauts de la semaine.`,
      429,
    );
  }

  // L'instance n'est créée qu'une fois tous les refus passés : un membre à court d'énergie
  // engagerait sinon son équipe dans le raid, avec une réserve pleine affichée à tout le
  // serveur et pas un seul coup porté.
  let team = await prisma.rpgRaidTeam.findUnique({
    where: { raidId_teamKey: { raidId: raid.id, teamKey: identity.key } },
  });

  if (team) {
    if (team.remainingHealth <= 0) throw new RaidError('Votre équipe a déjà abattu son boss.', 409);

    // L'effectif est figé à l'engagement, réserve comprise : sans plafond d'assauts, une
    // équipe engagée à un membre - donc sur la réserve plancher - n'avait qu'à recruter
    // vingt personnes pour livrer soixante assauts sur une épreuve taillée pour une seule.
    //
    // Le plafond d'achat entre dans le compte plutôt que d'être additionné équipe par
    // équipe : c'est déjà le maximum que l'effectif enregistré pourrait livrer, potions
    // comprises, et le quota personnel borne chacun de toute façon.
    const teamAssaults = await prisma.rpgRaidAssault.count({ where: { raidTeamId: team.id } });
    const teamQuota = team.memberCount * (raid.assaultsPerMember + raid.boughtAssaultsMax);
    if (teamAssaults >= teamQuota) {
      throw new RaidError("Votre équipe a épuisé les assauts de son effectif pour ce raid.", 429);
    }
  }

  const spent = await prisma.rpgProfile.updateMany({
    where: { guildId, userId, energy: { gte: raid.energyCost } },
    data: { energy: { decrement: raid.energyCost } },
  });
  if (spent.count === 0) throw new RaidError(`Il vous faut ${raid.energyCost} points d'énergie pour un assaut.`, 409);

  // Une fois l'assaut inscrit, l'énergie est bel et bien dépensée : un incident sur les
  // récompenses ne doit pas la rendre en plus du combat déjà livré. Tout ce qui précède
  // cette inscription reste couvert par le remboursement, l'engagement de l'équipe compris.
  let committed = false;
  try {
    team = team ?? await getOrCreateTeam(raid, identity);
    const profile = await getOrCreateRpgProfile(guildId, userId);
    const stats = await loadEffectiveStats(profile);

    const result = runRaidAssault({
      stats,
      playerHealth: Math.max(1, profile.health),
      playerSkills: getAvailableSkills(profile.className, profile.level),
      boss: {
        attack: raid.bossAttack,
        defense: raid.bossDefense,
        speed: raid.bossSpeed,
        spells: parseRaidSpells(raid.bossSpells),
      },
      remainingHealth: team.remainingHealth,
      totalHealth: team.totalHealth,
    });

    // La réserve est décrémentée en base et non écrasée avec la valeur calculée : deux
    // assauts simultanés doivent se cumuler, pas s'écraser l'un l'autre.
    const damage = Math.min(result.damageDealt, team.remainingHealth);
    const after = await prisma.rpgRaidTeam.update({
      where: { id: team.id },
      data: { remainingHealth: { decrement: damage } },
    });
    if (after.remainingHealth < 0) {
      await prisma.rpgRaidTeam.update({ where: { id: team.id }, data: { remainingHealth: 0 } });
    }

    // Un seul assaut peut porter le coup de grâce, même si deux arrivent ensemble.
    let killingBlow = false;
    if (after.remainingHealth <= 0) {
      const claimed = await prisma.rpgRaidTeam.updateMany({
        where: { id: team.id, defeatedAt: null },
        data: { defeatedAt: new Date() },
      });
      killingBlow = claimed.count === 1;
    }

    await prisma.rpgRaidAssault.create({
      data: {
        raidTeamId: team.id,
        guildId,
        userId,
        damage,
        killingBlow,
        survived: result.survived,
      },
    });
    committed = true;

    // Le joueur ressort du raid dans l'état où il en sort : les points de vie perdus se
    // reportent sur le profil, comme après un combat de boss.
    const remainingHp = Math.max(1, Math.min(profile.maxHealth, profile.health - result.damageTaken));
    await prisma.rpgProfile.update({
      where: { guildId_userId: { guildId, userId } },
      data: { health: remainingHp },
    });

    // Les quêtes se comptent une fois l'assaut inscrit : un raid qui echoue en cours de
    // route ne doit pas avoir fait avancer une quête pour un coup jamais porté.
    const { trackRpgQuest } = await import('./rpgQuestService.js');
    await trackRpgQuest(client, guildId, userId, 'RAID_ASSAULTS');
    if (damage > 0) await trackRpgQuest(client, guildId, userId, 'RAID_DAMAGE', damage);

    const rewards = after.remainingHealth <= 0
      ? await rewardTeam(client, raid, team.id, { victory: true })
      : null;

    return {
      raid,
      team: {
        name: team.teamName,
        remainingHealth: Math.max(0, after.remainingHealth),
        totalHealth: team.totalHealth,
        memberCount: team.memberCount,
      },
      result,
      killingBlow,
      assaultsLeft: Math.max(0, personalQuota - alreadyDone - 1),
      rewards: rewards?.get(userId) ?? null,
    };
  } catch (error) {
    if (!committed) {
      await prisma.rpgProfile.update({
        where: { guildId_userId: { guildId, userId } },
        data: { energy: { increment: raid.energyCost } },
      }).catch(() => null);
    }
    throw error;
  }
}

// ── Récompenses ───────────────────────────────────────────────────────────

type RewardMap = Map<string, { xp: number; coins: number; teamPoints: number }>;

/**
 * Verse les récompenses d'une équipe, une seule fois.
 *
 * Une équipe qui n'a pas abattu son boss touche une consolation proportionnelle aux dégâts
 * portés : trois heures d'assauts pour rien ne ramènent personne la semaine suivante, mais
 * l'échec ne doit pas payer autant que la victoire.
 */
async function rewardTeam(
  client: Client,
  raid: {
    id: string;
    guildId: string;
    teamMode: string;
    xpReward: number;
    coinReward: number;
    clanPoints: number;
    consolationShare: number;
    healthPerMember: number;
    healthFloor: number;
    healthCap: number;
  },
  teamId: string,
  options: { victory: boolean },
): Promise<RewardMap> {
  const rewards: RewardMap = new Map();

  const team = await prisma.rpgRaidTeam.findUnique({
    where: { id: teamId },
    select: { teamKey: true, memberCount: true },
  });
  if (!team) return rewards;

  // Le marquage précède le versement : au pire une équipe n'est pas payée, jamais payée
  // deux fois par deux assauts simultanés ou par une reprise du cycle.
  const claimed = await prisma.rpgRaidTeam.updateMany({
    where: { id: teamId, rewardedAt: null },
    data: { rewardedAt: new Date() },
  });
  if (claimed.count === 0) return rewards;

  const assaults = await prisma.rpgRaidAssault.findMany({
    where: { raidTeamId: teamId },
    select: { userId: true, damage: true },
  });
  if (assaults.length === 0) return rewards;

  // La part est celle figée à l'ouverture : une équipe qui a frappé toute la nuit doit
  // toucher ce que le serveur annonçait, pas ce qu'il a réglé entre-temps.
  const ratio = options.victory ? 1 : clampInt(raid.consolationShare, RAID_CONSOLATION_RANGE, 25) / 100;
  // Les récompenses sont réglées par membre et l'enveloppe suit l'effectif, comme la
  // réserve de points de vie : à enveloppe unique, une équipe d'une personne touchait
  // autant qu'une de vingt pour une épreuve bien moindre, et se scinder en équipes
  // minuscules devenait la seule façon rationnelle de jouer le raid.
  const envelope = (perMember: number) => Math.round(computeTeamEnvelope(perMember, team.memberCount, {
    healthPerMember: raid.healthPerMember,
    healthFloor: raid.healthFloor,
    healthCap: raid.healthCap,
  }) * ratio);

  const xpShares = splitRaidRewards(assaults, envelope(raid.xpReward));
  const coinShares = splitRaidRewards(assaults, envelope(raid.coinReward));
  // Les points d'équipe vont au clan en mode clan, et à la guilde du jeu sinon : la même
  // enveloppe réglée sur le raid sert dans les deux cas, la seule différence étant qui est
  // crédité au bout.
  const pointShares = splitRaidRewards(assaults, envelope(raid.clanPoints));

  for (const [userId, xp] of xpShares) {
    const coins = coinShares.get(userId) ?? 0;
    rewards.set(userId, { xp, coins, teamPoints: pointShares.get(userId) ?? 0 });

    try {
      await prisma.rpgProfile.update({
        where: { guildId_userId: { guildId: raid.guildId, userId } },
        data: { xp: { increment: xp }, balance: { increment: coins } },
      });
      await checkLevelUp(raid.guildId, userId);
    } catch (error) {
      logger.error('RpgRaid', `Récompense non versée à ${userId} sur ${raid.guildId}:`, error);
    }
  }

  const totalPoints = [...pointShares.values()].reduce((sum, amount) => sum + amount, 0);
  if (totalPoints > 0) {
    if (raid.teamMode === 'CLAN') {
      // Les points de clan passent par le point d'entrée commun : c'est lui qui porte le
      // remboursement de dette, la saison en cours, le plafond et les comptes liés.
      const awards = [...pointShares.entries()].map(([userId, amount]) => ({ userId, amount }));
      // Le pont RPG vers les clans se coupe sans toucher aux primes reglees : un serveur qui
      // l'a ferme ne doit plus rien recevoir du RPG, raid compris, comme c'est deja le cas
      // pour un monstre vaincu.
      const guild = await prisma.guild.findUnique({
        where: { id: raid.guildId },
        select: { clansEnabled: true, clanPointsFromRpg: true },
      });
      if (shouldAwardClanPoints(guild, 1)) {
        const { awardClanPointsToMembers } = await import('../../community/clanService.js');
        await awardClanPointsToMembers({
          guildId: raid.guildId,
          client,
          source: 'RPG_RAID',
          awards,
          reason: 'Raid hebdomadaire',
        }).catch((error: unknown) => {
          logger.error('RpgRaid', `Points de clan non versés sur ${raid.guildId}:`, error);
        });
      }
    } else {
      // En mode guilde RPG, l'équipe est la guilde du jeu : c'est elle qui encaisse, en XP
      // de guilde. Sans ça, abattre le boss ne rapportait rien à l'équipe elle-même, qui ne
      // montait qu'à coups de dépôts au trésor.
      await awardRpgGuildXp(team.teamKey, totalPoints).catch((error: unknown) => {
        logger.error('RpgRaid', `XP de guilde non versée sur ${raid.guildId}:`, error);
      });
    }
  }

  return rewards;
}

// ── Cycle ─────────────────────────────────────────────────────────────────

/**
 * Fait avancer les raids de tous les serveurs : planification, ouverture, clôture.
 *
 * L'annonce et le rafraîchissement du message sont délégués au panneau, qui sait construire
 * l'embed ; ce module ne décide que des transitions.
 */
export async function runRaidCycle(client: Client): Promise<void> {
  const configs = await prisma.economyConfig.findMany({ where: { enabled: true, raidEnabled: true } });

  for (const config of configs) {
    try {
      await openDueRaid(config);
      await closeDueRaid(client, config.guildId, config);
      await announceOrRefresh(client, config);
      await ensureRaidSchedule(config.guildId, config);
    } catch (error) {
      logger.error('RpgRaid', `Cycle en échec pour ${config.guildId}:`, error);
    }
  }
}

/**
 * Annonce le raid qui vient d'ouvrir, ou rafraîchit celui qui court.
 *
 * L'affichage est importé à la demande : il tire discord.js, dont la planification et les
 * assauts n'ont pas besoin, et un import statique croisé entre le service et son panneau
 * ferait un cycle.
 */
async function announceOrRefresh(client: Client, config: EconomyConfig): Promise<void> {
  const raid = await getOpenRaid(config.guildId);
  if (!raid) return;

  const panel = await import('./rpgRaidPanel.js');
  if (!raid.announcedAt) {
    await panel.announceOpenRaid(client, raid, config.raidAnnounce, config.raidRoleId);
    return;
  }

  await panel.refreshRaidMessage(client, raid, await listRaidTeams(raid.id));
}

async function openDueRaid(config: EconomyConfig): Promise<void> {
  // Sans ouverture automatique, une fenêtre restée en attente ne s'ouvre pas d'elle-même :
  // c'est le lancement manuel qui la reprendra, à l'heure choisie par le serveur.
  if (!config.raidAutoSchedule) return;

  const scheduled = await getScheduledRaid(config.guildId);
  if (!scheduled || scheduled.opensAt.getTime() > Date.now()) return;

  // Une fenêtre entièrement passée pendant que le bot était éteint n'a plus lieu d'ouvrir :
  // elle est close sur-le-champ, sans équipe ni récompense, et la suivante est planifiée.
  if (scheduled.closesAt.getTime() <= Date.now()) {
    await prisma.rpgRaid.update({
      where: { id: scheduled.id },
      data: { status: 'RESOLVED', resolvedAt: new Date() },
    });
    return;
  }

  // Les réglages sont relus à l'ouverture, comme le fait le lancement manuel : une fenêtre
  // est planifiée jusqu'à une semaine à l'avance, et ouvrir sur les montants ou le mode
  // d'équipe d'il y a une semaine ferait mentir ce que le dashboard affiche depuis.
  await prisma.rpgRaid.updateMany({
    where: { id: scheduled.id, status: 'SCHEDULED' },
    data: { status: 'OPEN', ...raidSettings(config) },
  });
}

/**
 * Paie les équipes engagées, ferme la fenêtre et publie le bilan.
 *
 * Sert à l'heure dite comme à une clôture anticipée : dans les deux cas, chaque équipe
 * touche ce qu'elle a mérité pour ce qu'elle a fait, victoire ou consolation.
 */
async function resolveRaid(
  client: Client,
  raid: NonNullable<Awaited<ReturnType<typeof getOpenRaid>>>,
  announce: string,
  earlyReason: 'SEASON' | null = null,
): Promise<void> {
  const pending = await prisma.rpgRaidTeam.findMany({
    where: { raidId: raid.id, rewardedAt: null },
    select: { id: true, remainingHealth: true },
  });

  for (const team of pending) {
    await rewardTeam(client, raid, team.id, { victory: team.remainingHealth <= 0 })
      .catch((error: unknown) => logger.error('RpgRaid', `Clôture d'équipe en échec sur ${raid.guildId}:`, error));
  }

  // La clôture est actée avant le bilan : un salon devenu injoignable ne doit pas laisser
  // un raid ouvert pour l'éternité, à accepter des assauts après l'heure.
  const closed = await prisma.rpgRaid.updateMany({
    where: { id: raid.id, status: 'OPEN' },
    data: { status: 'RESOLVED', resolvedAt: new Date() },
  });
  if (closed.count === 0 || announce === 'NONE') return;

  const panel = await import('./rpgRaidPanel.js');
  await panel.publishRaidSummary(client, raid, await listRaidTeams(raid.id), earlyReason);
}

/**
 * Solde le raid en cours avant l'heure, à la clôture d'une saison de clans.
 *
 * Les points d'un raid sont versés au moment du versement, donc dans la saison en vigueur
 * à cet instant : une fenêtre qui enjambe la bascule créditerait la saison suivante d'un
 * travail fait dans la précédente, et le clan vainqueur démarrerait avec de l'avance.
 *
 * Le raid n'est pas annulé pour autant : chacun garde ce qu'il a gagné, énergie et potions
 * comprises. Seule la fenêtre est écourtée.
 *
 * Rien n'est fait hors du mode clan : un raid livré en guildes RPG n'a aucun rapport avec
 * les saisons, et le fermer serait un dégât gratuit.
 */
export async function settleRaidForSeasonEnd(client: Client, guildId: string): Promise<boolean> {
  const open = await getOpenRaid(guildId);
  if (!open || asRaidTeamMode(open.teamMode) !== 'CLAN') return false;

  const config = await getOrCreateEconomyConfig(guildId);
  await resolveRaid(client, open, config.raidAnnounce, 'SEASON');
  return true;
}

async function closeDueRaid(client: Client, guildId: string, config: EconomyConfig): Promise<void> {
  const open = await getOpenRaid(guildId);
  if (!open || open.closesAt.getTime() > Date.now()) return;

  await resolveRaid(client, open, config.raidAnnounce);
}

/** Durée pendant laquelle le bilan du dernier raid s'affiche sur la page publique. */
export const RAID_RECAP_PUBLIC_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Bilan du dernier raid clos.
 *
 * Un raid terminé disparaissait sans laisser de trace : le serveur n'avait plus de quoi
 * commenter sa semaine, alors que tout - équipes, dégâts, coups de grâce - est en base.
 *
 * Les deux pages ne le gardent pas aussi longtemps, et c'est voulu. La page publique
 * l'affiche une journée : c'est une nouvelle, elle se périme. Le dashboard le garde jusqu'à
 * l'ouverture du raid suivant, parce qu'il sert à autre chose - regarder ce qu'a donné la
 * dernière fenêtre avant d'ajuster les réglages de la prochaine.
 */
export async function getRaidRecap(guildId: string, maxAgeMs?: number) {
  const raid = await prisma.rpgRaid.findFirst({
    where: {
      guildId,
      status: 'RESOLVED',
      ...(maxAgeMs === undefined ? {} : { resolvedAt: { gte: new Date(Date.now() - maxAgeMs) } }),
    },
    orderBy: { resolvedAt: 'desc' },
  });
  if (!raid) return null;

  const [teams, damage] = await Promise.all([
    listRaidTeams(raid.id),
    prisma.rpgRaidAssault.groupBy({
      by: ['userId'],
      where: { team: { raidId: raid.id } },
      _sum: { damage: true },
      _count: { _all: true },
      orderBy: { _sum: { damage: 'desc' } },
      take: 10,
    }),
  ]);

  return {
    raid,
    teams,
    strikers: damage.map((row) => ({
      userId: row.userId,
      damage: row._sum.damage ?? 0,
      assaults: row._count._all,
    })),
  };
}

/**
 * Raids clos, du plus récent au plus ancien.
 *
 * Le bilan seul ne tient qu'un temps, et l'onglet se retrouvait vide dès qu'il expirait :
 * plus rien ne disait ce qu'avaient donné les semaines passées, alors que chaque fenêtre
 * garde ses équipes et ses dégâts en base. L'historique ne périme pas, lui.
 */
export async function listRaidHistory(guildId: string, limit = 8) {
  const raids = await prisma.rpgRaid.findMany({
    where: { guildId, status: 'RESOLVED' },
    orderBy: { resolvedAt: 'desc' },
    take: limit,
    include: {
      teams: {
        select: { teamName: true, defeatedAt: true, remainingHealth: true, totalHealth: true },
        orderBy: [{ remainingHealth: 'asc' }, { teamName: 'asc' }],
      },
    },
  });

  return raids.map((raid) => ({
    id: raid.id,
    bossName: raid.bossName,
    bossEmoji: raid.bossEmoji,
    bossLevel: raid.bossLevel,
    opensAt: raid.opensAt,
    resolvedAt: raid.resolvedAt,
    teams: raid.teams.map((team) => ({
      teamName: team.teamName,
      totalHealth: team.totalHealth,
      remainingHealth: team.remainingHealth,
      defeated: team.defeatedAt !== null,
    })),
  }));
}

/** Une ligne du palmarès des frappeurs. */
export interface RaidStriker {
  userId: string;
  damage: number;
  assaults: number;
  killingBlows: number;
}

/**
 * Palmarès du raid sur toute l'histoire du serveur.
 *
 * Chaque assaut porte déjà les dégâts et le coup de grâce de son auteur, et rien ne les
 * relisait après le versement des récompenses : le raid ne laissait aucune trace, là où le
 * bestiaire et la pêche ont leur classement depuis toujours.
 *
 * Les équipes se comptent en boss abattus et non en dégâts : une équipe nombreuse en porte
 * mécaniquement plus, alors que mettre son boss à terre est la même épreuve pour toutes.
 */
export async function getRaidLeaderboard(guildId: string, limit = 10): Promise<{
  strikers: RaidStriker[];
  teams: Array<{ teamKey: string; teamName: string; kills: number }>;
}> {
  const [damage, blows, downed] = await Promise.all([
    prisma.rpgRaidAssault.groupBy({
      by: ['userId'],
      where: { guildId },
      _sum: { damage: true },
      _count: { _all: true },
      orderBy: { _sum: { damage: 'desc' } },
      take: limit,
    }),
    // Le coup de grâce demande son propre décompte : `_count` sur un booléen compterait les
    // lignes renseignées, c'est-à-dire toutes.
    prisma.rpgRaidAssault.groupBy({
      by: ['userId'],
      where: { guildId, killingBlow: true },
      _count: { _all: true },
    }),
    // Le nom est un instantané pris à l'engagement : on lit le plus récent, un clan renommé
    // depuis ne devant pas apparaître deux fois sous deux noms.
    prisma.rpgRaidTeam.findMany({
      where: { defeatedAt: { not: null }, raid: { guildId } },
      select: { teamKey: true, teamName: true },
      orderBy: { raid: { opensAt: 'desc' } },
    }),
  ]);

  const blowsByUser = new Map(blows.map((row) => [row.userId, row._count._all]));
  const strikers = damage.map((row) => ({
    userId: row.userId,
    damage: row._sum.damage ?? 0,
    assaults: row._count._all,
    killingBlows: blowsByUser.get(row.userId) ?? 0,
  }));

  const byTeam = new Map<string, { teamKey: string; teamName: string; kills: number }>();
  for (const team of downed) {
    const known = byTeam.get(team.teamKey);
    if (known) known.kills += 1;
    else byTeam.set(team.teamKey, { teamKey: team.teamKey, teamName: team.teamName, kills: 1 });
  }

  const teams = [...byTeam.values()]
    .sort((a, b) => b.kills - a.kills || a.teamName.localeCompare(b.teamName))
    .slice(0, limit);

  return { strikers, teams };
}

/** Classement des équipes d'un raid, la mieux avancée en premier. */
export async function listRaidTeams(raidId: string) {
  const teams = await prisma.rpgRaidTeam.findMany({
    where: { raidId },
    orderBy: [{ remainingHealth: 'asc' }, { teamName: 'asc' }],
    include: { _count: { select: { assaults: true } } },
  });
  return teams;
}
