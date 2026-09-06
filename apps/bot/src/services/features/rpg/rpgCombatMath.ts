/**
 * Formule de dégâts partagée par les deux moteurs de combat (combat interactif du hub et
 * simulation de boss). Les avoir en double avait déjà provoqué une divergence : elle est
 * désormais définie une seule fois ici.
 */

export type AttackInput = {
  attack: number;
  /** Défense de la cible, avant réduction de pénétration. */
  targetDefense: number;
  /** Vitesse de l'attaquant : élargit la fourchette de dégâts. */
  speed: number;
  /** Chance de coup critique, de 0 à 1. */
  critChance: number;
  /** Part de la défense adverse ignorée, de 0 à 1. */
  armorPiercing?: number;
  /** Multiplicateur de la compétence employée (1 = attaque normale). */
  skillMultiplier?: number;
  /** Multiplicateur défensif actif sur la cible (2 = posture de défense). */
  targetDefenseMultiplier?: number;
  /** Part des dégâts annulée par le passif de la cible, de 0 à 1. */
  targetDamageReduction?: number;
  /** Part des dégâts infligés rendue en PV à l'attaquant, de 0 à 1. */
  lifesteal?: number;
  /** Part des dégâts subis que la cible renvoie à l'attaquant, de 0 à 1. */
  targetThorns?: number;
  /** Générateur aléatoire injectable, pour rendre les tests déterministes. */
  random?: () => number;
};

export type AttackResult = {
  damage: number;
  critical: boolean;
  /** PV rendus à l'attaquant par le vol de vie. Zéro sans enchantement adéquat. */
  healed: number;
  /** Dégâts renvoyés à l'attaquant par les épines de la cible. Zéro par défaut. */
  reflected: number;
};

export const CRIT_MULTIPLIER = 1.6;

/**
 * Dégâts = (attaque − défense effective / 2) × compétence × critique, moins la réduction
 * du passif adverse. Le résultat est toujours d'au moins 1 : aucun combat ne doit pouvoir
 * se bloquer parce que les deux camps infligent zéro.
 *
 * Le vol de vie et les épines sont dérivés ici plutôt que dans chaque moteur de combat :
 * ils se calculent sur les dégâts RÉELLEMENT infligés, et les recalculer en trois endroits
 * était la garantie de les voir diverger, comme la formule de dégâts elle-même avant elle.
 * Appliquer les PV rendus et renvoyés reste à la charge de l'appelant, seul à connaître
 * l'état de son combat.
 */
export function computeAttack(input: AttackInput): AttackResult {
  const random = input.random ?? Math.random;

  const pierced = input.targetDefense * (1 - Math.min(1, Math.max(0, input.armorPiercing ?? 0)));
  const effectiveDefense = pierced * (input.targetDefenseMultiplier ?? 1);

  const variance = Math.floor(random() * Math.max(1, Math.floor(input.speed / 3)));
  const raw = Math.max(1, input.attack - Math.floor(effectiveDefense / 2)) + variance;

  const withSkill = raw * (input.skillMultiplier ?? 1);
  const critical = random() < input.critChance;
  const withCrit = critical ? withSkill * CRIT_MULTIPLIER : withSkill;

  const reduced = withCrit * (1 - Math.min(0.9, Math.max(0, input.targetDamageReduction ?? 0)));
  const damage = Math.max(1, Math.floor(reduced));

  const lifesteal = Math.min(1, Math.max(0, input.lifesteal ?? 0));
  const thorns = Math.min(1, Math.max(0, input.targetThorns ?? 0));

  return {
    damage,
    critical,
    healed: Math.floor(damage * lifesteal),
    reflected: Math.floor(damage * thorns),
  };
}
