/**
 * Catalogue d'enchantements.
 *
 * Même parti pris que `rpgClasses.ts` : tout est déclaratif. Le moteur de combat et le
 * calcul de statistiques ne connaissent aucun enchantement en particulier, ils lisent des
 * effets. Ajouter un enchantement, un palier ou un emplacement ne demande donc aucune
 * modification du combat, de la forge ou du panneau - seulement une entrée ici et un
 * parchemin dans `rpgContent.ts`.
 *
 * Un enchantement se pose sur une INSTANCE d'objet (`RpgItemInstance`), pas sur un
 * emplacement : il survit au déséquipement et suit l'objet, contrairement au niveau de
 * forge d'origine qui appartenait au slot.
 */

import type { Rarity } from './rpgContent.js';

/** Emplacements enchantables. Élargir cette union suffit à ouvrir un nouvel emplacement. */
export type EnchantSlot = 'weapon' | 'armor' | 'accessory';

/**
 * Effet d'un enchantement AU PALIER 1. Les paliers supérieurs multiplient chaque valeur
 * par le palier : c'est ce qui rend la progression lisible (« Rempart III = +18 % de
 * défense ») sans table de valeurs à maintenir.
 *
 * Les champs `*Flat` s'ajoutent au total ; les champs `*Percent` s'appliquent au total
 * final (base + classe + équipement), pour que la description affichée corresponde
 * exactement à ce que le joueur constate sur sa fiche.
 */
export type EnchantEffect = {
  attackFlat?: number;
  defenseFlat?: number;
  speedFlat?: number;
  maxHealthFlat?: number;
  attackPercent?: number;
  defensePercent?: number;
  speedPercent?: number;
  maxHealthPercent?: number;
  /** Chance de coup critique additionnelle, de 0 à 1. */
  critChance?: number;
  /** Part de la défense adverse ignorée, de 0 à 1. */
  armorPiercing?: number;
  /** Part des dégâts subis annulée, de 0 à 1. */
  damageReduction?: number;
  /** Part des dégâts infligés rendue en PV, de 0 à 1. */
  lifesteal?: number;
  /** Part des dégâts subis renvoyée à l'attaquant, de 0 à 1. */
  thorns?: number;
};

export type RpgEnchantment = {
  id: string;
  name: string;
  emoji: string;
  /** Description au palier 1, les paliers suivants étant proportionnels. */
  description: string;
  /** Emplacements acceptant cet enchantement. */
  slots: EnchantSlot[];
  maxTier: number;
  /** Rareté indicative, utilisée pour l'affichage et le coût de pose. */
  rarity: Rarity;
  /** Effet accordé par palier. */
  perTier: EnchantEffect;
};

/** Enchantement effectivement posé sur une instance d'objet. */
export type EnchantStack = {
  id: string;
  tier: number;
};

export const RPG_ENCHANTMENTS: RpgEnchantment[] = [
  // ─── Armes ───
  {
    id: 'flame',
    name: 'Embrasement',
    emoji: '🔥',
    description: '+6 % de dégâts par palier.',
    slots: ['weapon'],
    maxTier: 3,
    rarity: 'UNCOMMON',
    perTier: { attackPercent: 0.06 },
  },
  {
    id: 'keen',
    name: 'Tranchant',
    emoji: '🗡️',
    description: '+4 % de chances de coup critique par palier.',
    slots: ['weapon', 'accessory'],
    maxTier: 3,
    rarity: 'UNCOMMON',
    perTier: { critChance: 0.04 },
  },
  {
    id: 'sunder',
    name: 'Brise-Armure',
    emoji: '🪓',
    description: 'Ignore 7 % de la défense adverse par palier.',
    slots: ['weapon'],
    maxTier: 3,
    rarity: 'RARE',
    perTier: { armorPiercing: 0.07 },
  },
  {
    id: 'vampiric',
    name: 'Vampirisme',
    emoji: '🩸',
    description: 'Rend 5 % des dégâts infligés en PV par palier.',
    slots: ['weapon'],
    maxTier: 3,
    rarity: 'EPIC',
    perTier: { lifesteal: 0.05 },
  },

  // ─── Armures ───
  {
    id: 'bulwark',
    name: 'Rempart',
    emoji: '🛡️',
    description: '+6 % de défense par palier.',
    slots: ['armor'],
    maxTier: 3,
    rarity: 'UNCOMMON',
    perTier: { defensePercent: 0.06 },
  },
  {
    id: 'vitality',
    name: 'Vitalité',
    emoji: '❤️',
    description: '+5 % de PV maximum par palier.',
    slots: ['armor', 'accessory'],
    maxTier: 3,
    rarity: 'UNCOMMON',
    perTier: { maxHealthPercent: 0.05 },
  },
  {
    id: 'thorns',
    name: 'Épines',
    emoji: '🌵',
    description: "Renvoie 8 % des dégâts subis à l'attaquant par palier.",
    slots: ['armor'],
    maxTier: 3,
    rarity: 'RARE',
    perTier: { thorns: 0.08 },
  },
  {
    id: 'warding',
    name: 'Sauvegarde',
    emoji: '✨',
    description: 'Annule 3 % des dégâts subis par palier.',
    slots: ['armor'],
    maxTier: 3,
    rarity: 'EPIC',
    perTier: { damageReduction: 0.03 },
  },

  // ─── Accessoires : l'emplacement est déjà servi par le système ───
  {
    id: 'swiftness',
    name: 'Célérité',
    emoji: '🌪️',
    description: '+4 % de vitesse par palier.',
    slots: ['accessory', 'weapon'],
    maxTier: 3,
    rarity: 'COMMON',
    perTier: { speedPercent: 0.04 },
  },
];

const BY_ID = new Map(RPG_ENCHANTMENTS.map((enchant) => [enchant.id, enchant]));

export function getEnchantment(id: string): RpgEnchantment | null {
  return BY_ID.get(id) ?? null;
}

/** Enchantements posables sur un emplacement donné. */
export function enchantmentsForSlot(slot: EnchantSlot): RpgEnchantment[] {
  return RPG_ENCHANTMENTS.filter((enchant) => enchant.slots.includes(slot));
}

/**
 * Nombre d'emplacements d'enchantement d'un objet, dicté par sa rareté.
 * Un objet légendaire vaut donc la peine d'être conservé et enrichi plutôt que remplacé.
 */
export const ENCHANT_SLOTS_BY_RARITY: Record<string, number> = {
  COMMON: 1,
  UNCOMMON: 1,
  RARE: 2,
  EPIC: 2,
  LEGENDARY: 3,
};

export function enchantCapacity(rarity: string): number {
  return ENCHANT_SLOTS_BY_RARITY[rarity] ?? 1;
}

/**
 * Plafonds des effets cumulés, tous enchantements et passifs de classe confondus.
 * Sans eux, empiler trois pièces légendaires rendrait un personnage littéralement
 * invulnérable ou capable de se soigner plus vite qu'il ne prend de dégâts.
 */
export const EFFECT_CAPS = {
  critChance: 0.75,
  armorPiercing: 1,
  damageReduction: 0.9,
  lifesteal: 0.5,
  thorns: 0.5,
} as const;

/**
 * Valide et normalise la valeur JSON `enchants` d'une instance d'objet.
 *
 * La colonne est du JSON libre : elle peut contenir n'importe quoi après une migration,
 * une écriture manuelle ou le retrait d'un enchantement du catalogue. Tout ce qui n'est
 * pas reconnu est écarté silencieusement plutôt que de faire planter une fiche.
 */
export function parseEnchants(raw: unknown): EnchantStack[] {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const parsed: EnchantStack[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, tier } = entry as { id?: unknown; tier?: unknown };
    if (typeof id !== 'string' || seen.has(id)) continue;

    const enchant = BY_ID.get(id);
    if (!enchant) continue;

    const level = typeof tier === 'number' && Number.isFinite(tier) ? Math.floor(tier) : 0;
    if (level < 1) continue;

    seen.add(id);
    parsed.push({ id, tier: Math.min(enchant.maxTier, level) });
  }

  return parsed;
}

/** Somme des effets d'une liste d'enchantements posés, paliers compris. */
export function aggregateEnchantEffects(stacks: EnchantStack[]): Required<EnchantEffect> {
  const total: Required<EnchantEffect> = {
    attackFlat: 0, defenseFlat: 0, speedFlat: 0, maxHealthFlat: 0,
    attackPercent: 0, defensePercent: 0, speedPercent: 0, maxHealthPercent: 0,
    critChance: 0, armorPiercing: 0, damageReduction: 0, lifesteal: 0, thorns: 0,
  };

  for (const stack of stacks) {
    const enchant = BY_ID.get(stack.id);
    if (!enchant) continue;
    const tier = Math.min(enchant.maxTier, Math.max(1, stack.tier));

    for (const key of Object.keys(total) as (keyof EnchantEffect)[]) {
      total[key] += (enchant.perTier[key] ?? 0) * tier;
    }
  }

  return total;
}

/** Libellé court d'un enchantement posé, pour les embeds. */
export function formatEnchant(stack: EnchantStack): string {
  const enchant = BY_ID.get(stack.id);
  if (!enchant) return '';
  return `${enchant.emoji} ${enchant.name} ${'I'.repeat(Math.max(1, Math.min(3, stack.tier)))}`;
}
