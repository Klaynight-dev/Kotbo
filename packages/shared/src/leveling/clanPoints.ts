import { xpForLevel, type LevelCurve } from './curve.js';

export type ClanLevelUpReward = {
  /** Forfait de référence, versé tel quel au niveau `referenceLevel`. */
  flatPerLevelUp: number;
  proportional: boolean;
  /**
   * Niveau auquel le forfait reste exact. En dessous on verse moins, au-dessus
   * davantage, en suivant l'XP réellement franchie.
   */
  referenceLevel: number;
};

/**
 * Le versement est stocké dans une colonne `Int` et s'additionne sur une saison
 * entière. Une courbe très raide (exposant 4, coefficient élevé) produirait des
 * montants qui débordent l'entier 32 bits de Postgres dès un seul passage de
 * niveau : le résultat est donc borné, quitte à s'écarter de la proportion
 * exacte dans une configuration de toute façon extrême.
 */
export const MAX_CLAN_POINTS_PER_LEVEL_UP = 1_000_000;

/**
 * Plafond du total accumulé sur une saison, sous les 2 147 483 647 d'un entier
 * 32 bits avec de la marge. Sans lui, un barème mal calibré finit par faire
 * rejeter l'écriture par Postgres en pleine montée de niveau, et le gain part
 * en silence dans le `catch` qui entoure l'attribution.
 */
export const MAX_CLAN_SEASON_POINTS = 2_000_000_000;

/** Le niveau 1 n'a pas de palier précédent : la référence commence à 2. */
export const MIN_CLAN_REFERENCE_LEVEL = 2;

/** XP franchie en arrivant au niveau `level` depuis le précédent. */
function crossedXpForLevel(level: number, curve: LevelCurve): number {
  return xpForLevel(level - 1, curve) - xpForLevel(level - 2, curve);
}

/**
 * Points de clan dus pour une montée de niveau.
 *
 * Le forfait historique est injuste dès que la courbe n'est pas linéaire :
 * chaque niveau coûtant de plus en plus d'XP, un vétéran doit fournir plusieurs
 * fois l'effort d'un débutant pour le même versement. Avec la courbe par
 * défaut, l'écart de rendement atteint 40 entre le niveau 2 et le niveau 100.
 *
 * Le mode proportionnel verse sur l'XP réellement franchie, ce qui rend la
 * contribution indépendante du niveau. Il reste calé sur le forfait configuré,
 * qui garde sa valeur exacte au niveau de référence : changer le forfait fait
 * donc bouger toute l'échelle, sans autre réglage à reprendre.
 *
 * La différence entre les deux niveaux couvre au passage les sauts de plusieurs
 * niveaux d'un coup, qu'un versement par événement compterait pour un seul.
 */
export function computeClanLevelUpPoints(
  previousLevel: number,
  newLevel: number,
  reward: ClanLevelUpReward,
  curve: LevelCurve,
): number {
  if (!Number.isFinite(previousLevel) || !Number.isFinite(newLevel)) return 0;
  if (newLevel <= previousLevel) return 0;

  const base = Number.isFinite(reward.flatPerLevelUp) ? Math.floor(reward.flatPerLevelUp) : 0;
  if (base <= 0) return 0;

  const flat = Math.min(base, MAX_CLAN_POINTS_PER_LEVEL_UP);

  // Un membre de niveau L a franchi le seuil `xpForLevel(L - 1)` : l'XP
  // parcourue entre deux niveaux se mesure donc entre ces seuils-là.
  const crossedXp = xpForLevel(newLevel - 1, curve) - xpForLevel(Math.max(0, previousLevel) - 1, curve);

  // Un passage qui n'a coûté aucun XP n'est payé par aucun des deux modes.
  //
  // Le seuil du niveau 1 vaut 0 quelle que soit la courbe : les deux termes de
  // `xpForLevel` sont multipliés par le niveau, donc ils s'annulent à zéro.
  // Comme la colonne `level` d'un membre démarre à 0 - un niveau que la courbe
  // ne produit jamais - le tout premier gain d'XP déclenche un passage 0 → 1 qui
  // ne franchit rien. Le forfait le payait plein tarif, ce qui revenait à offrir
  // des points de clan à chaque arrivée sur le serveur.
  if (crossedXp <= 0) return 0;

  if (!reward.proportional) return flat;

  const reference = Math.max(
    MIN_CLAN_REFERENCE_LEVEL,
    Number.isFinite(reward.referenceLevel) ? Math.floor(reward.referenceLevel) : MIN_CLAN_REFERENCE_LEVEL,
  );
  const referenceXp = crossedXpForLevel(reference, curve);
  if (referenceXp <= 0) return flat;

  const points = (base * crossedXp) / referenceXp;
  if (!Number.isFinite(points)) return MAX_CLAN_POINTS_PER_LEVEL_UP;

  return Math.min(MAX_CLAN_POINTS_PER_LEVEL_UP, Math.max(0, Math.round(points)));
}
