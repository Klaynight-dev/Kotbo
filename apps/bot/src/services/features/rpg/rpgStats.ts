/**
 * Calcul des statistiques effectives d'un personnage.
 *
 * SOURCE DE VÉRITÉ UNIQUE : les colonnes `attack`/`defense`/`speed`/`maxHealth` du profil
 * contiennent les stats de BASE (niveaux + points investis). Tous les bonus - équipement,
 * améliorations de forge, enchantements, classe - sont recalculés ici à chaque lecture.
 *
 * Ce choix remplace l'ancien modèle où les bonus étaient additionnés dans les colonnes à
 * l'équipement : chaque source de bonus supplémentaire y multipliait les risques de dérive
 * permanente (objet supprimé, reset partiel, double comptage en combat).
 *
 * Le niveau de forge et les enchantements sont lus sur l'INSTANCE d'objet portée, pas sur
 * le profil : la progression appartient à l'objet possédé, et non à l'emplacement.
 */

import { getRpgClass } from './rpgClasses.js';
import {
  EFFECT_CAPS,
  aggregateEnchantEffects,
  type EnchantStack,
} from './rpgEnchantments.js';

/** Sous-ensemble de `RpgItem` nécessaire au calcul. */
export type StatItem = {
  atkBonus: number;
  defBonus: number;
  spdBonus: number;
  hpBonus: number;
  rarity: string;
};

/** Objet porté, accompagné de la progression de l'exemplaire réellement possédé. */
export type EquippedPiece = StatItem & {
  /** Niveau de forge de l'instance, de 0 à `MAX_UPGRADE_LEVEL`. */
  upgrade: number;
  /** Enchantements posés sur l'instance, déjà validés par `parseEnchants`. */
  enchants: EnchantStack[];
};

export type StatProfile = {
  level: number;
  attack: number;
  defense: number;
  speed: number;
  maxHealth: number;
  className: string | null;
};

export type Equipment = {
  weapon: EquippedPiece | null;
  armor: EquippedPiece | null;
  accessory: EquippedPiece | null;
};

export type EffectiveStats = {
  attack: number;
  defense: number;
  speed: number;
  maxHealth: number;
  /** Chance de coup critique totale, de 0 à 1. */
  critChance: number;
  /** Part de la défense adverse ignorée, de 0 à 1. */
  armorPiercing: number;
  /** Part des dégâts subis annulée par le passif de classe et les enchantements, de 0 à 1. */
  damageReduction: number;
  /** Part des dégâts infligés rendue en PV, de 0 à 1. */
  lifesteal: number;
  /** Part des dégâts subis renvoyée à l'attaquant, de 0 à 1. */
  thorns: number;
};

export const MAX_UPGRADE_LEVEL = 10;
export const BASE_CRIT_CHANCE = 0.1;

/** Chance de critique accordée par la rareté de l'arme équipée. */
const RARITY_CRIT_BONUS: Record<string, number> = {
  COMMON: 0,
  UNCOMMON: 0.02,
  RARE: 0.04,
  EPIC: 0.07,
  LEGENDARY: 0.12,
};

/**
 * Bonus apporté par l'amélioration d'un objet : +12 % de ses stats de base par niveau,
 * avec un minimum de +1 par niveau pour qu'améliorer un objet faible reste utile.
 */
export function upgradeBonus(baseValue: number, upgradeLevel: number): number {
  if (baseValue <= 0 || upgradeLevel <= 0) return 0;
  return Math.max(upgradeLevel, Math.round(baseValue * 0.12 * upgradeLevel));
}

function itemContribution(piece: EquippedPiece | null) {
  if (!piece) return { atk: 0, def: 0, spd: 0, hp: 0 };
  const upgrade = piece.upgrade;
  return {
    atk: piece.atkBonus + upgradeBonus(piece.atkBonus, upgrade),
    def: piece.defBonus + upgradeBonus(piece.defBonus, upgrade),
    spd: piece.spdBonus + upgradeBonus(piece.spdBonus, upgrade),
    hp: piece.hpBonus + upgradeBonus(piece.hpBonus, upgrade),
  };
}

/** Enchantements des trois pièces portées, mis bout à bout. */
function equippedEnchants(equipment: Equipment): EnchantStack[] {
  return [
    ...(equipment.weapon?.enchants ?? []),
    ...(equipment.armor?.enchants ?? []),
    ...(equipment.accessory?.enchants ?? []),
  ];
}

export function getEffectiveStats(profile: StatProfile, equipment: Equipment): EffectiveStats {
  const weapon = itemContribution(equipment.weapon);
  const armor = itemContribution(equipment.armor);
  const accessory = itemContribution(equipment.accessory);

  const rpgClass = getRpgClass(profile.className);
  const mods = rpgClass?.modifiers ?? { attack: 1, defense: 1, speed: 1, maxHealth: 1 };

  // Les enchantements des trois pièces se cumulent : un même effet posé sur l'arme et
  // sur l'armure s'additionne, dans la limite des plafonds définis par le catalogue.
  const enchant = aggregateEnchantEffects(equippedEnchants(equipment));

  // Les multiplicateurs de classe portent sur les stats de base uniquement : un Mage ne
  // doit pas voir le bonus brut de son bâton multiplié une seconde fois par 1.35.
  const attack = Math.round(profile.attack * mods.attack) + weapon.atk + armor.atk + accessory.atk + enchant.attackFlat;
  const defense = Math.round(profile.defense * mods.defense) + weapon.def + armor.def + accessory.def + enchant.defenseFlat;
  const speed = Math.round(profile.speed * mods.speed) + weapon.spd + armor.spd + accessory.spd + enchant.speedFlat;
  const maxHealth = Math.round(profile.maxHealth * mods.maxHealth) + weapon.hp + armor.hp + accessory.hp + enchant.maxHealthFlat;

  // Les pourcentages d'enchantement s'appliquent au total (base + classe + équipement) :
  // c'est ce que décrit le libellé affiché au joueur (« +12 % de défense »), et la seule
  // lecture qui reste vraie quand il change d'arme sans changer d'enchantement.
  const withPercent = (value: number, percent: number) => Math.round(value * (1 + percent));

  const critChance = Math.min(
    EFFECT_CAPS.critChance,
    BASE_CRIT_CHANCE
      + (RARITY_CRIT_BONUS[equipment.weapon?.rarity ?? 'COMMON'] ?? 0)
      + (rpgClass?.passive.bonusCritChance ?? 0)
      + enchant.critChance,
  );

  return {
    attack: Math.max(1, withPercent(attack, enchant.attackPercent)),
    defense: Math.max(0, withPercent(defense, enchant.defensePercent)),
    speed: Math.max(1, withPercent(speed, enchant.speedPercent)),
    maxHealth: Math.max(1, withPercent(maxHealth, enchant.maxHealthPercent)),
    critChance,
    armorPiercing: Math.min(EFFECT_CAPS.armorPiercing, (rpgClass?.passive.armorPiercing ?? 0) + enchant.armorPiercing),
    damageReduction: Math.min(EFFECT_CAPS.damageReduction, (rpgClass?.passive.damageReduction ?? 0) + enchant.damageReduction),
    lifesteal: Math.min(EFFECT_CAPS.lifesteal, enchant.lifesteal),
    thorns: Math.min(EFFECT_CAPS.thorns, enchant.thorns),
  };
}

/**
 * Coût en pièces pour passer un objet du niveau d'amélioration `current` au suivant.
 * La courbe est volontairement exponentielle : c'est le principal puits à pièces du jeu.
 */
export function upgradeCost(itemPrice: number, current: number): number {
  const base = Math.max(50, Math.round(itemPrice * 0.3));
  return Math.round(base * Math.pow(1.55, current));
}

/**
 * Probabilité de réussite d'une amélioration. Garantie jusqu'à +3, puis décroissante.
 * Un échec ne détruit ni ne rétrograde l'objet : seules les pièces sont perdues.
 */
export function upgradeSuccessChance(current: number): number {
  if (current < 3) return 1;
  return Math.max(0.25, 1 - (current - 2) * 0.09);
}
