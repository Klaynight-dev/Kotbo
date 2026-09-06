/**
 * Paliers de difficulte du bestiaire et de la boutique, cote dashboard.
 *
 * Les multiplicateurs sont ceux du bot (`rpgDifficultyPolicy.ts`), qui reste seul a les
 * appliquer : ils ne servent ici qu'a annoncer l'effet d'un bouton avant le clic et a proposer
 * des statistiques coherentes sur une nouvelle fiche. Les deux tables doivent bouger ensemble.
 */

export const BESTIARY_DIFFICULTIES = ['EASY', 'NORMAL', 'HARD'] as const;
export type BestiaryDifficulty = (typeof BESTIARY_DIFFICULTIES)[number];
export type BestiaryScope = 'boss' | 'monster';

export const DEFAULT_BESTIARY_DIFFICULTY: BestiaryDifficulty = 'NORMAL';

export type ScalableStats = {
  health: number;
  attack: number;
  defense: number;
  speed: number;
  xpReward: number;
  coinReward: number;
};

export type DifficultyFactors = ScalableStats & {
  dropChance: number;
  bossRespawnHours: number;
  itemPrice: number;
};

export const BESTIARY_DIFFICULTY_SCALING: Record<BestiaryDifficulty, DifficultyFactors> = {
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

/**
 * Icones Papicons, et non des emoji : le dashboard n'affiche d'emoji que la ou c'est une
 * donnee saisie par l'administrateur. `Flame` n'existant pas au catalogue Papicons, il
 * retombait sur Lucide.
 */
export const BESTIARY_DIFFICULTY_ICONS: Record<BestiaryDifficulty, string> = {
  EASY: 'Shield',
  NORMAL: 'Star',
  HARD: 'Alert',
};

/** Part du palier appliquee a une creature de premier niveau, cf. `levelWeight` cote bot. */
export const LEVEL_WEIGHT_FLOOR = 0.45;
export const LEVEL_WEIGHT_FULL_AT = 20;

export function levelWeight(level: number): number {
  const progress = (Number(level) - 1) / (LEVEL_WEIGHT_FULL_AT - 1);
  const clamped = Math.min(1, Math.max(0, Number.isFinite(progress) ? progress : 0));
  return LEVEL_WEIGHT_FLOOR + (1 - LEVEL_WEIGHT_FLOOR) * clamped;
}

export function effectiveFactor(factor: number, level: number): number {
  return 1 + (factor - 1) * levelWeight(level);
}

export function asBestiaryDifficulty(value: unknown): BestiaryDifficulty {
  return BESTIARY_DIFFICULTIES.includes(value as BestiaryDifficulty)
    ? (value as BestiaryDifficulty)
    : DEFAULT_BESTIARY_DIFFICULTY;
}

/**
 * Ecart au palier moyen, en pourcentage signe.
 *
 * C'est l'ecart *maximal* : une creature de bas niveau en recoit moins, la carte le dit sous
 * les vignettes.
 */
export function difficultyDelta(difficulty: BestiaryDifficulty, stat: keyof DifficultyFactors): number {
  return Math.round((BESTIARY_DIFFICULTY_SCALING[difficulty][stat] - 1) * 100);
}

export function formatDifficultyDelta(difficulty: BestiaryDifficulty, stat: keyof DifficultyFactors): string {
  const delta = difficultyDelta(difficulty, stat);
  if (delta === 0) return '=';
  return `${delta > 0 ? '+' : ''}${delta} %`;
}

/**
 * Un palier ne retouche-t-il rien de ce qu'on s'apprête à lui montrer ?
 *
 * Le palier de référence affichait une rangée de « = », c'est-à-dire de la place occupée
 * pour ne rien dire. La question se pose sur les valeurs et non sur le nom du palier :
 * retoucher le tableau d'échelles ne doit pas laisser une carte mentir.
 */
export function isDifficultyNeutral(
  difficulty: BestiaryDifficulty,
  stats: (keyof DifficultyFactors)[],
): boolean {
  return stats.every((stat) => difficultyDelta(difficulty, stat) === 0);
}

/**
 * Statistiques d'une nouvelle fiche, mises au palier du serveur.
 *
 * Une creature creee apres coup au palier normal detonnerait au milieu d'un bestiaire deja
 * reecrit. L'attenuation par niveau s'applique comme cote bot.
 */
export function scaleToDifficulty(
  base: ScalableStats,
  difficulty: BestiaryDifficulty,
  level: number,
): ScalableStats {
  const factors = BESTIARY_DIFFICULTY_SCALING[difficulty];
  const at = (key: keyof ScalableStats, floor: number) =>
    Math.max(floor, Math.round(base[key] * effectiveFactor(factors[key], level)));

  return {
    health: at('health', 1),
    attack: at('attack', 0),
    defense: at('defense', 0),
    speed: at('speed', 0),
    xpReward: at('xpReward', 0),
    coinReward: at('coinReward', 0),
  };
}

export type BattleSample = { battles: number; wins: number };

export function winRate(sample: BattleSample | null | undefined): number | null {
  if (!sample || sample.battles <= 0) return null;
  return Math.round((sample.wins / sample.battles) * 100);
}
