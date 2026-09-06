/**
 * Paliers de difficulté du bestiaire et de la boutique.
 *
 * Un palier n'est pas un mode de jeu : c'est un jeu de multiplicateurs appliqué une fois
 * pour toutes aux fiches. Aucun combat ne relit ces valeurs, et une fiche reste modifiable
 * à la main juste après - le palier ne fait que poser un point de départ.
 *
 * Trois réglages indépendants : les boss, les monstres ordinaires, et le prix des objets.
 * Un serveur peut vouloir des boss redoutables sur un bestiaire courant inoffensif.
 *
 * Aucun palier ne touche à ce qui alimente un module voisin - points de clan versés à la
 * victoire, butins qui donnent de l'XP de niveau ou des points de clan, prix des objets qui
 * en vendent. Ces chiffres sont l'équilibrage d'un autre classement que le RPG : les
 * pondérer ici fausserait la comparaison entre serveurs et entre clans.
 */

import { HEALTH_RANGE, REWARD_RANGE, RESPAWN_HOURS_RANGE, STAT_RANGE } from './rpgBestiaryPolicy.js';

export const DIFFICULTIES = ['EASY', 'NORMAL', 'HARD'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** `NORMAL` est le catalogue livré tel quel : tous ses multiplicateurs valent 1. */
export const DEFAULT_DIFFICULTY: Difficulty = 'NORMAL';

export interface ScalableStats {
  health: number;
  attack: number;
  defense: number;
  speed: number;
  xpReward: number;
  coinReward: number;
}

export interface DifficultyFactors extends ScalableStats {
  /** Chance de butin. Un serveur difficile raréfie ce qui se ramasse. */
  dropChance: number;
  /** Délai de réapparition d'un boss. */
  bossRespawnHours: number;
  /** Prix d'achat en boutique. */
  itemPrice: number;
}

/**
 * Multiplicateurs de chaque palier, relatifs à `NORMAL`.
 *
 * La vitesse bouge peu : elle n'élargit que la fourchette de dégâts et n'a pas le poids des
 * trois autres statistiques. Les récompenses suivent la difficulté sans la rattraper, sinon
 * le palier facile deviendrait la façon la plus rentable de monter. Le butin va dans l'autre
 * sens que les gains : un serveur difficile paie mieux au combat mais lâche moins d'objets,
 * faute de quoi il inonderait la boutique de matériaux rares.
 */
export const DIFFICULTY_SCALING: Record<Difficulty, DifficultyFactors> = {
  EASY: {
    health: 0.65,
    attack: 0.7,
    defense: 0.6,
    speed: 0.9,
    xpReward: 0.9,
    coinReward: 0.9,
    dropChance: 1.25,
    bossRespawnHours: 0.7,
    itemPrice: 0.8,
  },
  NORMAL: {
    health: 1,
    attack: 1,
    defense: 1,
    speed: 1,
    xpReward: 1,
    coinReward: 1,
    dropChance: 1,
    bossRespawnHours: 1,
    itemPrice: 1,
  },
  HARD: {
    health: 1.6,
    attack: 1.35,
    defense: 1.5,
    speed: 1.1,
    xpReward: 1.4,
    coinReward: 1.35,
    dropChance: 0.8,
    bossRespawnHours: 1.5,
    itemPrice: 1.25,
  },
};

const STAT_BOUNDS: Record<keyof ScalableStats, { min: number; max: number }> = {
  health: HEALTH_RANGE,
  attack: STAT_RANGE,
  defense: STAT_RANGE,
  speed: STAT_RANGE,
  xpReward: REWARD_RANGE,
  coinReward: REWARD_RANGE,
};

/** Part du palier réellement appliquée à une créature de premier niveau. */
export const LEVEL_WEIGHT_FLOOR = 0.45;
/** Niveau à partir duquel le palier s'applique en entier. */
export const LEVEL_WEIGHT_FULL_AT = 20;

/**
 * Atténuation du palier sur les créatures de bas niveau.
 *
 * Un multiplicateur plat durcit le Slime autant que le Dragon Ancien, et c'est le Slime que
 * rencontre un joueur qui vient de commencer. La courbe protège l'entrée de jeu tout en
 * laissant le haut du bestiaire encaisser le palier complet.
 */
export function levelWeight(level: number): number {
  const progress = (Number(level) - 1) / (LEVEL_WEIGHT_FULL_AT - 1);
  const clamped = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  return LEVEL_WEIGHT_FLOOR + (1 - LEVEL_WEIGHT_FLOOR) * clamped;
}

/** Multiplicateur ramené au niveau de la créature. Vaut toujours 1 au palier moyen. */
export function effectiveFactor(factor: number, level: number): number {
  return 1 + (factor - 1) * levelWeight(level);
}

function clamp(value: number, bounds: { min: number; max: number }): number {
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

/**
 * Rejoue une valeur écrite au palier `from` comme si elle l'avait été au palier `to`.
 *
 * Le passage par le rapport des deux multiplicateurs, et non par une multiplication directe,
 * est ce qui rend l'opération répétable : sans lui, deux clics sur « Difficile » doubleraient
 * les points de vie une seconde fois. C'est aussi ce qui préserve les retouches faites à la
 * main, qui ne sont réévaluées que proportionnellement.
 *
 * L'arrondi à l'entier peut décaler une valeur d'une unité à l'aller-retour entre deux
 * paliers : sans conséquence en jeu, et préférable à des points de vie à virgule. Changer le
 * niveau d'une créature entre deux applications décale de la même façon, l'atténuation
 * n'étant plus la même qu'à l'aller.
 */
export function factorRatio(key: keyof DifficultyFactors, from: Difficulty, to: Difficulty, level: number): number {
  return effectiveFactor(DIFFICULTY_SCALING[to][key], level)
    / effectiveFactor(DIFFICULTY_SCALING[from][key], level);
}

export function rescaleStats<T extends ScalableStats>(
  stats: T,
  from: Difficulty,
  to: Difficulty,
  level: number,
): ScalableStats {
  const keys = Object.keys(STAT_BOUNDS) as Array<keyof ScalableStats>;
  return keys.reduce((acc, key) => {
    acc[key] = clamp(Math.round((Number(stats[key]) || 0) * factorRatio(key, from, to, level)), STAT_BOUNDS[key]);
    return acc;
  }, {} as ScalableStats);
}

/**
 * Le plancher évite qu'un enchaînement de paliers difficiles ne rende un objet strictement
 * introuvable, ce qui reviendrait à le retirer du jeu sans le dire.
 */
export const DROP_CHANCE_FLOOR = 0.01;

/**
 * Plafond d'une chance que le palier fait monter.
 *
 * Une victoire ne tire qu'un seul butin, en parcourant la liste dans l'ordre et en s'arrêtant
 * au premier tirage réussi. Une chance poussée à 1 rendrait donc tous les butins suivants
 * inatteignables : le boss « Reine Araignée », dont la soie est à 0,8, ferait disparaître son
 * œil de basilic au premier passage en facile. Une certitude écrite à la main est en revanche
 * respectée telle quelle - c'est un choix, pas un effet de bord.
 */
export const DROP_CHANCE_CEILING = 0.95;

/** Chance de butin, en fraction de 0 à 1. */
export function rescaleDropChance(chance: number, from: Difficulty, to: Difficulty, level: number): number {
  const source = Number(chance) || 0;
  const scaled = Math.round(source * factorRatio('dropChance', from, to, level) * 1000) / 1000;
  const ceiling = source >= 1 ? 1 : DROP_CHANCE_CEILING;
  return Math.min(ceiling, Math.max(DROP_CHANCE_FLOOR, scaled));
}

export function rescaleRespawnHours(hours: number, from: Difficulty, to: Difficulty, level: number): number {
  const scaled = Math.round((Number(hours) || 0) * factorRatio('bossRespawnHours', from, to, level));
  return clamp(scaled, RESPAWN_HOURS_RANGE);
}

/** Le niveau requis par l'objet joue le rôle du niveau de la créature : une potion de départ bouge peu. */
export function rescaleItemPrice(price: number, from: Difficulty, to: Difficulty, levelRequired: number): number {
  const scaled = Math.round((Number(price) || 0) * factorRatio('itemPrice', from, to, levelRequired));
  return clamp(scaled, REWARD_RANGE);
}

export function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === 'string' && (DIFFICULTIES as readonly string[]).includes(value);
}

/** Lit un palier venu de la base ou d'une requête, en retombant sur `NORMAL`. */
export function asDifficulty(value: unknown): Difficulty {
  return isDifficulty(value) ? value : DEFAULT_DIFFICULTY;
}

/** Vrai si aucune des six statistiques ne changerait. */
export function sameStats(before: ScalableStats, after: ScalableStats): boolean {
  return (Object.keys(STAT_BOUNDS) as Array<keyof ScalableStats>).every((key) => before[key] === after[key]);
}

/**
 * Tolérance de la comparaison « cette fiche est-elle encore à son palier ? ».
 *
 * Enchaîner deux paliers ne donne pas exactement le même entier que de partir du catalogue :
 * chaque passage arrondit une fois. Sans tolérance, un serveur passé par difficile avant de
 * revenir en facile verrait des fiches signalées comme retouchées à la main alors que personne
 * n'y a touché - et rien ne pourrait plus lever ce signalement. Trois pour cent absorbent ces
 * arrondis tout en laissant voir la moindre retouche volontaire, qui se compte en dizaines de
 * points de vie et non en unités.
 */
export const STATS_MATCH_TOLERANCE = 0.03;

export function statsMatch(actual: ScalableStats, expected: ScalableStats): boolean {
  return (Object.keys(STAT_BOUNDS) as Array<keyof ScalableStats>).every((key) => {
    const margin = Math.max(1, Math.round(expected[key] * STATS_MATCH_TOLERANCE));
    return Math.abs(actual[key] - expected[key]) <= margin;
  });
}

/** En dessous, le taux de victoire n'est qu'une série de coups de chance. */
export const RECOMMENDATION_MIN_BATTLES = 10;
export const RECOMMENDATION_HARD_ABOVE = 0.85;
export const RECOMMENDATION_EASY_BELOW = 0.45;

/**
 * Palier que suggèrent les combats déjà livrés, ou `null` faute de matière.
 *
 * Un serveur où l'on gagne neuf fois sur dix n'a plus de bestiaire, il a un décor ; un
 * serveur où l'on perd plus d'une fois sur deux décourage avant la première récompense.
 */
export function recommendDifficulty(sample: { battles: number; wins: number }): Difficulty | null {
  if (!Number.isFinite(sample.battles) || sample.battles < RECOMMENDATION_MIN_BATTLES) return null;

  const winRate = sample.wins / sample.battles;
  if (winRate >= RECOMMENDATION_HARD_ABOVE) return 'HARD';
  if (winRate <= RECOMMENDATION_EASY_BELOW) return 'EASY';
  return 'NORMAL';
}
