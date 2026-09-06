/**
 * Application d'un palier de difficulté au bestiaire et à la boutique.
 *
 * Le palier réécrit les fiches, il ne se relit pas en jeu. Le palier retenu est mémorisé sur
 * la configuration économique pour une seule raison : savoir de quel point de départ recalculer
 * la fois suivante. Sans lui, deux clics sur « Difficile » multiplieraient deux fois.
 *
 * Ce module ne touche jamais aux chiffres qui alimentent un module voisin : points de clan
 * versés à la victoire, butins dont l'objet donne de l'XP de niveau ou des points de clan,
 * prix des objets qui en vendent. Ces valeurs sont l'équilibrage du classement des clans et
 * des niveaux, pas celui du RPG.
 */

import prisma from '../../../utils/db.js';
import { parseMonsterDrops, type NormalizedDrop } from './rpgBestiaryPolicy.js';
import { hasModuleReward } from '../economyPolicy.js';
import { listGuildMonsters, type ResolvedMonster } from './rpgBestiaryService.js';
import {
  DEFAULT_DIFFICULTY,
  factorRatio,
  rescaleDropChance,
  rescaleItemPrice,
  rescaleRespawnHours,
  rescaleStats,
  sameStats,
  statsMatch,
  type Difficulty,
  type ScalableStats,
} from './rpgDifficultyPolicy.js';

export interface DifficultyPreviewRow {
  name: string;
  level: number;
  before: ScalableStats;
  after: ScalableStats;
}

export interface ApplyDifficultyResult {
  /** Fiches que le palier change réellement. */
  updated: number;
  /** Avant / après de chaque fiche touchée, pour annoncer l'effet avant de l'appliquer. */
  preview: DifficultyPreviewRow[];
  /** Butins laissés intacts parce qu'ils versent de l'XP de niveau ou des points de clan. */
  protectedDrops: number;
}

export interface PricePreviewRow {
  name: string;
  emoji: string;
  before: number;
  after: number;
}

export interface ApplyPriceDifficultyResult {
  updated: number;
  preview: PricePreviewRow[];
  /** Objets laissés intacts parce qu'ils vendent une récompense de module. */
  protectedItems: number;
}

/**
 * Noms des objets dont le prix ou la chance de butin ne doivent pas bouger.
 *
 * Un butin désigne son objet par son nom, jamais par son identifiant : c'est donc par nom que
 * la protection se fait. Un objet protégé côté catalogue global l'est aussi localement, la
 * règle étant volontairement prudente.
 */
async function loadModuleRewardItemNames(guildId: string): Promise<Set<string>> {
  const items = await prisma.rpgItem.findMany({
    where: {
      OR: [{ guildId: null }, { guildId }],
      AND: { OR: [{ levelXpReward: { gt: 0 } }, { clanPointsReward: { gt: 0 } }] },
    },
    select: { name: true },
  });

  return new Set(items.map((item) => item.name));
}

function statsOf(source: ScalableStats): ScalableStats {
  return {
    health: source.health,
    attack: source.attack,
    defense: source.defense,
    speed: source.speed,
    xpReward: source.xpReward,
    coinReward: source.coinReward,
  };
}

function rescaleDrops(
  drops: NormalizedDrop[],
  protectedNames: Set<string>,
  from: Difficulty,
  to: Difficulty,
  level: number,
): { drops: NormalizedDrop[]; protectedCount: number; changed: boolean } {
  const coinRatio = factorRatio('coinReward', from, to, level);
  let protectedCount = 0;
  let changed = false;

  const next = drops.map((drop) => {
    if (protectedNames.has(drop.itemName)) {
      protectedCount += 1;
      return drop;
    }

    const rescaled: NormalizedDrop = {
      ...drop,
      chance: rescaleDropChance(drop.chance, from, to, level),
      coinBonus: Math.max(0, Math.round(drop.coinBonus * coinRatio)),
    };
    if (rescaled.chance !== drop.chance || rescaled.coinBonus !== drop.coinBonus) changed = true;
    return rescaled;
  });

  return { drops: next, protectedCount, changed };
}

/**
 * Applique un palier à toutes les créatures d'une catégorie.
 *
 * Un monstre global n'est jamais réécrit : comme partout ailleurs dans le bestiaire, il en est
 * déposé une copie locale, ce qui laisse le catalogue partagé intact et permet de revenir en
 * arrière fiche par fiche. Ses statistiques sont celles du catalogue, donc toujours au palier
 * `NORMAL` : un monstre ajouté au catalogue après coup ne doit pas être recalculé comme les
 * autres.
 *
 * Le palier retenu s'écrit dans la même transaction que les fiches. Séparés, un échec entre les
 * deux laisserait les créatures à un palier et la configuration à un autre.
 */
export async function applyBestiaryDifficulty(
  guildId: string,
  options: { isBoss: boolean; from: Difficulty; to: Difficulty; dryRun?: boolean },
): Promise<ApplyDifficultyResult> {
  const [monsters, protectedNames] = await Promise.all([
    listGuildMonsters(guildId, { isBoss: options.isBoss, includeDisabled: true }),
    loadModuleRewardItemNames(guildId),
  ]);

  const preview: DifficultyPreviewRow[] = [];
  let protectedDrops = 0;
  const writes = monsters.flatMap((monster) => {
    const from = monster.scope === 'GLOBAL' ? DEFAULT_DIFFICULTY : options.from;
    const stats = rescaleStats(monster, from, options.to, monster.level);
    const drops = rescaleDrops(parseMonsterDrops(monster.drops), protectedNames, from, options.to, monster.level);
    const bossRespawnHours = monster.isBoss && monster.bossRespawnHours !== null
      ? rescaleRespawnHours(monster.bossRespawnHours, from, options.to, monster.level)
      : monster.bossRespawnHours;

    protectedDrops += drops.protectedCount;

    const untouched = sameStats(monster, stats)
      && !drops.changed
      && bossRespawnHours === monster.bossRespawnHours;
    if (untouched) return [];

    preview.push({ name: monster.name, level: monster.level, before: statsOf(monster), after: stats });
    if (options.dryRun) return [];

    const payload = { ...stats, drops: drops.drops, bossRespawnHours };

    if (monster.guildId !== null) {
      return [prisma.rpgMonster.update({ where: { id: monster.id }, data: payload })];
    }

    return [prisma.rpgMonster.upsert({
      where: { guildId_name: { guildId, name: monster.name } },
      create: {
        guildId,
        name: monster.name,
        description: monster.description,
        emoji: monster.emoji,
        level: monster.level,
        isBoss: monster.isBoss,
        clanPoints: monster.clanPoints,
        enabled: monster.enabled,
        ...payload,
      },
      update: payload,
    })];
  });

  if (options.dryRun) return { updated: preview.length, preview, protectedDrops };

  await prisma.$transaction([
    ...writes,
    prisma.economyConfig.update({
      where: { guildId },
      data: options.isBoss ? { bossDifficulty: options.to } : { monsterDifficulty: options.to },
    }),
  ]);

  return { updated: writes.length, preview, protectedDrops };
}

/**
 * Applique un palier au prix des objets de la boutique.
 *
 * Seuls les objets créés par le serveur sont concernés : contrairement au bestiaire, le
 * catalogue d'objets livré de base n'a pas de mécanisme de copie locale - les inventaires, les
 * recettes et les offres du marché noir désignent un objet par son identifiant, qu'une copie
 * ferait diverger. Les objets qui vendent de l'XP de niveau ou des points de clan gardent
 * aussi leur prix, exactement comme ils sortent du marché noir : ce prix est l'équilibrage.
 */
export async function applyShopDifficulty(
  guildId: string,
  options: { from: Difficulty; to: Difficulty; dryRun?: boolean },
): Promise<ApplyPriceDifficultyResult> {
  const items = await prisma.rpgItem.findMany({
    where: { guildId },
    select: { id: true, name: true, emoji: true, price: true, levelRequired: true, levelXpReward: true, clanPointsReward: true },
    orderBy: [{ price: 'asc' }, { name: 'asc' }],
  });

  const preview: PricePreviewRow[] = [];
  let protectedItems = 0;

  const writes = items.flatMap((item) => {
    if (hasModuleReward(item)) {
      protectedItems += 1;
      return [];
    }

    const price = rescaleItemPrice(item.price, options.from, options.to, item.levelRequired);
    if (price === item.price) return [];

    preview.push({ name: item.name, emoji: item.emoji, before: item.price, after: price });
    if (options.dryRun) return [];

    return [prisma.rpgItem.update({ where: { id: item.id }, data: { price } })];
  });

  if (options.dryRun) return { updated: preview.length, preview, protectedItems };

  await prisma.$transaction([
    ...writes,
    prisma.economyConfig.update({ where: { guildId }, data: { shopDifficulty: options.to } }),
  ]);

  return { updated: writes.length, preview, protectedItems };
}

export interface BattleSample {
  battles: number;
  wins: number;
}

/**
 * Combats livrés par créature sur les derniers jours, victoires comprises.
 *
 * L'agrégation se fait par *nom* et non par identifiant : personnaliser un monstre du
 * catalogue en crée une copie avec un nouvel identifiant, et l'historique des combats livrés
 * contre l'original serait perdu à chaque personnalisation.
 */
export async function getBestiaryBattleStats(
  guildId: string,
  days = 30,
): Promise<Record<string, BattleSample>> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await prisma.rpgBattle.groupBy({
    by: ['monsterName', 'won'],
    where: { guildId, createdAt: { gte: since } },
    _count: { _all: true },
  });

  const byName: Record<string, BattleSample> = {};
  for (const row of rows) {
    const sample = byName[row.monsterName] ?? { battles: 0, wins: 0 };
    sample.battles += row._count._all;
    if (row.won) sample.wins += row._count._all;
    byName[row.monsterName] = sample;
  }

  return byName;
}

/** Totalise les combats d'une catégorie, pour en déduire le palier à conseiller. */
export function summarizeBattles(
  monsters: Array<{ name: string }>,
  byName: Record<string, BattleSample>,
): BattleSample {
  return monsters.reduce<BattleSample>((acc, monster) => {
    const sample = byName[monster.name];
    if (sample) {
      acc.battles += sample.battles;
      acc.wins += sample.wins;
    }
    return acc;
  }, { battles: 0, wins: 0 });
}

/**
 * Marque les fiches dont les statistiques ne sont plus celles du palier annoncé.
 *
 * Sans ce repère, rien ne distingue une créature réglée à la main d'une créature posée par le
 * palier : appliquer un palier fait de tout le bestiaire des copies locales, si bien que le
 * badge « personnalisé » ne veut plus rien dire une fois le premier palier appliqué.
 *
 * Deux cas valent `null`, faute de point de comparaison : une créature créée sur le serveur,
 * qui n'a pas d'original, et une créature encore servie par le catalogue global, que le palier
 * n'a pas touchée parce qu'elle est arrivée après - la signaler reviendrait à reprocher à
 * l'administrateur une fiche qu'il n'a jamais ouverte.
 */
export async function findDifficultyDrift(
  monsters: ResolvedMonster[],
  difficulty: { boss: Difficulty; monster: Difficulty },
): Promise<Record<string, boolean | null>> {
  const globals = await prisma.rpgMonster.findMany({
    where: { guildId: null },
    select: { name: true, level: true, health: true, attack: true, defense: true, speed: true, xpReward: true, coinReward: true },
  });
  const baselines = new Map(globals.map((row) => [row.name, row]));

  const drift: Record<string, boolean | null> = {};
  for (const monster of monsters) {
    const baseline = baselines.get(monster.name);
    if (!baseline || monster.scope === 'GLOBAL') {
      drift[monster.id] = null;
      continue;
    }

    const target = monster.isBoss ? difficulty.boss : difficulty.monster;
    const expected = rescaleStats(baseline, DEFAULT_DIFFICULTY, target, baseline.level);
    drift[monster.id] = !statsMatch(monster, expected);
  }

  return drift;
}
