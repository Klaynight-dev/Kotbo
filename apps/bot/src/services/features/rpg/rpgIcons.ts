/**
 * Pictogrammes du module RPG.
 *
 * Le hub s'écrivait entièrement en emojis Unicode. Rendu différent sur chaque
 * plateforme, aucune parenté visuelle d'un écran à l'autre, et des glyphes qui
 * ne disaient rien du jeu (🦺 pour une armure, 🧬 pour une fiche de
 * personnage). Le module partage désormais le jeu d'icônes Lucide déjà utilisé
 * par le reste du bot : un seul trait, une seule palette, et chaque écran se
 * lit comme une partie du même client de jeu.
 *
 * Tout passe par `icon()` : `E` renvoie une chaîne vide pour une clé inconnue,
 * et `setEmoji('')` fait rejeter le message entier par Discord. Un repli
 * Unicode explicite vaut mieux qu'un panneau qui ne s'affiche pas.
 */

import { E, UNICODE_FALLBACKS } from '../../../utils/emojis.js';

/** Repli de dernier recours : ni emoji d'application, ni fallback déclaré. */
const LAST_RESORT = '•';

export function icon(key: string): string {
  return E[key] || UNICODE_FALLBACKS[key] || LAST_RESORT;
}

/** Icône de rareté d'un objet. Une teinte par rang, un seul glyphe. */
export function rarityIcon(rarity: string | null | undefined): string {
  switch (rarity) {
    case 'UNCOMMON': return icon('rarUncommon');
    case 'RARE': return icon('rarRare');
    case 'EPIC': return icon('rarEpic');
    case 'LEGENDARY': return icon('rarLegendary');
    case 'COMMON': return icon('rarCommon');
    default: return '';
  }
}

/** Icône de catégorie d'objet, alignée sur les types de `RpgItem.type`. */
export function itemTypeIcon(type: string | null | undefined): string {
  switch (type) {
    case 'WEAPON': return icon('rpgSword');
    case 'ARMOR': return icon('rpgArmor');
    case 'ACCESSORY': return icon('rpgAccessory');
    case 'POTION': return icon('rpgPotion');
    case 'QUEST': return icon('rpgKey');
    default: return icon('rpgBag');
  }
}

/**
 * Couleurs d'accent du module.
 *
 * Tous les écrans du RPG portaient le blurple générique du bot : le jeu avait
 * exactement la même allure qu'un panneau de modération. Une teinte par
 * territoire donne au module une direction artistique à lui, et permet de
 * reconnaître un écran à sa tranche avant même de l'avoir lu.
 *
 * Les valeurs sont des entiers : `ContainerBuilder.setAccentColor` n'accepte
 * pas les `ColorResolvable` de `COLORS`.
 */
export const RPG_COLORS = {
  /** Fiche, inventaire, personnage : l'améthyste est la signature du module. */
  hub: 0x8b5cf6,
  /** Boutique, marché noir, paiements : tout ce qui se monnaie. */
  trade: 0xd9a441,
  /** Combat, boss, raid : tout ce qui saigne. */
  combat: 0xd64545,
  /** Guilde, clans, guerre : tout ce qui se joue à plusieurs. */
  team: 0x3f8ecc,
  /** Craft, forge, enchantement : l'établi. */
  craft: 0xa1663a,
  /** Voyage, bestiaire : le dehors. */
  wild: 0x3fa66a,
} as const;

/** Ressource représentée par une jauge, et la teinte de ses segments. */
export type RpgGauge = 'hp' | 'en' | 'xp';

const GAUGE_SEGMENTS: Record<RpgGauge, [string, string, string]> = {
  hp: ['rpgBarHpL', 'rpgBarHpM', 'rpgBarHpR'],
  en: ['rpgBarEnL', 'rpgBarEnM', 'rpgBarEnR'],
  xp: ['rpgBarXpL', 'rpgBarXpM', 'rpgBarXpR'],
};

const EMPTY_SEGMENTS: [string, string, string] = ['barEmptyL', 'barEmptyM', 'barEmptyR'];

/**
 * Jauge d'une ressource, en segments.
 *
 * Les barres s'écrivaient en carrés Unicode répétés : dix ❤️ côte à côte
 * donnent une frise hachée, pas une jauge, et le rendu changeait d'un client à
 * l'autre. Trois segments - extrémité gauche, corps, extrémité droite -
 * composent une capsule continue, exactement comme `buildProgressBar` le fait
 * déjà ailleurs dans le bot, mais dans la teinte de la ressource.
 */
function gaugeRatio(current: number, max: number): number {
  return Math.max(0, Math.min(1, current / Math.max(1, max)));
}

/** Les segments seuls, sans chiffres : la brique commune aux deux jauges. */
function gaugeSegments(ratio: number, gauge: RpgGauge, size: number): string {
  // `round` afficherait une jauge pleine à 96 % et un segment allumé à 4 % :
  // sur dix segments, seul l'arrondi vers le bas ne ment jamais sur l'état.
  const filled = Math.floor(ratio * size);

  let bar = '';
  for (let index = 0; index < size; index += 1) {
    const position = index === 0 ? 0 : index === size - 1 ? 2 : 1;
    const keys = index < filled ? GAUGE_SEGMENTS[gauge] : EMPTY_SEGMENTS;
    bar += icon(keys[position]);
  }
  return bar;
}

export function gaugeBar(current: number, max: number, gauge: RpgGauge, size = 10): string {
  const ratio = gaugeRatio(current, max);
  return `${gaugeSegments(ratio, gauge, size)} (${Math.round(ratio * 100)}%)`;
}

/**
 * Jauge de combat : mêmes segments, mais les points de vie chiffrés plutôt
 * qu'un pourcentage - en combat, ce qui compte est ce qu'il reste à entamer.
 *
 * Le combat affichait `[🟩🟩🟥🟥🟥]` : un rouge vif pour la part perdue, qui se
 * lisait comme des dégâts en cours plutôt que comme du vide.
 */
export function combatHpBar(current: number, max: number, label = 'PV'): string {
  const shown = Math.max(0, current);
  return `${gaugeSegments(gaugeRatio(shown, max), 'hp', 10)} \`${shown}/${max} ${label}\``;
}
