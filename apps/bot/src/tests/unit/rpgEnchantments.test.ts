import { describe, expect, test } from 'bun:test';
import {
  EFFECT_CAPS,
  aggregateEnchantEffects,
  enchantCapacity,
  enchantmentsForSlot,
  getEnchantment,
  parseEnchants,
} from '../../services/features/rpg/rpgEnchantments.js';
import {
  BASE_CRIT_CHANCE,
  getEffectiveStats,
  type Equipment,
  type EquippedPiece,
  type StatProfile,
} from '../../services/features/rpg/rpgStats.js';
import { computeAttack } from '../../services/features/rpg/rpgCombatMath.js';
import { enchantCost, enchantSuccessChance } from '../../services/features/rpg/rpgEnchantService.js';

function profile(overrides: Partial<StatProfile> = {}): StatProfile {
  return { level: 10, attack: 20, defense: 20, speed: 20, maxHealth: 150, className: null, ...overrides };
}

function item(overrides: Partial<EquippedPiece> = {}): EquippedPiece {
  return { atkBonus: 0, defBonus: 0, spdBonus: 0, hpBonus: 0, rarity: 'COMMON', upgrade: 0, enchants: [], ...overrides };
}

const NO_GEAR: Equipment = { weapon: null, armor: null, accessory: null };

describe('parseEnchants', () => {
  test('écarte tout ce qui n est pas un enchantement connu et valide', () => {
    // La colonne est du JSON libre : elle doit pouvoir contenir n'importe quoi sans faire
    // planter une fiche de personnage.
    const parsed = parseEnchants([
      { id: 'flame', tier: 2 },
      { id: 'inexistant', tier: 3 },
      { id: 'keen', tier: 0 },
      { id: 'keen' },
      'pas un objet',
      null,
      42,
    ]);

    expect(parsed).toEqual([{ id: 'flame', tier: 2 }]);
  });

  test('ne garde qu une occurrence par enchantement', () => {
    // Deux fois le même enchantement doublerait silencieusement son effet.
    expect(parseEnchants([{ id: 'flame', tier: 1 }, { id: 'flame', tier: 3 }]))
      .toEqual([{ id: 'flame', tier: 1 }]);
  });

  test('plafonne un palier au maximum de l enchantement', () => {
    const [stack] = parseEnchants([{ id: 'flame', tier: 99 }]);
    expect(stack.tier).toBe(getEnchantment('flame')!.maxTier);
  });

  test('une valeur non tabulaire donne une liste vide', () => {
    expect(parseEnchants(null)).toEqual([]);
    expect(parseEnchants('[]')).toEqual([]);
    expect(parseEnchants(undefined)).toEqual([]);
  });
});

describe('aggregateEnchantEffects', () => {
  test('le palier multiplie l effet de base', () => {
    const one = aggregateEnchantEffects([{ id: 'flame', tier: 1 }]);
    const three = aggregateEnchantEffects([{ id: 'flame', tier: 3 }]);

    expect(three.attackPercent).toBeCloseTo(one.attackPercent * 3, 5);
  });

  test('deux enchantements distincts s additionnent', () => {
    const total = aggregateEnchantEffects([
      { id: 'keen', tier: 2 },
      { id: 'swiftness', tier: 1 },
    ]);

    expect(total.critChance).toBeCloseTo(0.08, 5);
    expect(total.speedPercent).toBeCloseTo(0.04, 5);
  });
});

describe('getEffectiveStats avec enchantements', () => {
  test('un pourcentage porte sur le total, équipement compris', () => {
    const plain = getEffectiveStats(profile(), { ...NO_GEAR, weapon: item({ atkBonus: 10 }) });
    const enchanted = getEffectiveStats(profile(), {
      ...NO_GEAR,
      weapon: item({ atkBonus: 10, enchants: [{ id: 'flame', tier: 1 }] }),
    });

    // 30 d'attaque totale, +6 % = 31.8 arrondi à 32.
    expect(plain.attack).toBe(30);
    expect(enchanted.attack).toBe(32);
  });

  test('les enchantements des trois pièces se cumulent', () => {
    const stats = getEffectiveStats(profile(), {
      weapon: item({ enchants: [{ id: 'keen', tier: 1 }] }),
      armor: item({ enchants: [{ id: 'vitality', tier: 2 }] }),
      accessory: item({ enchants: [{ id: 'keen', tier: 2 }] }),
    });

    // Tranchant I sur l'arme + Tranchant II sur l'accessoire = +12 % de critique.
    expect(stats.critChance).toBeCloseTo(BASE_CRIT_CHANCE + 0.12, 5);
    // Vitalité II = +10 % de 150 PV.
    expect(stats.maxHealth).toBe(165);
  });

  test('un enchantement suit l objet, pas l emplacement', () => {
    // Deux armes identiques, l'une enchantée : c'est l'exemplaire porté qui décide.
    const enchanted = getEffectiveStats(profile(), {
      ...NO_GEAR,
      weapon: item({ atkBonus: 10, enchants: [{ id: 'flame', tier: 3 }] }),
    });
    const swapped = getEffectiveStats(profile(), { ...NO_GEAR, weapon: item({ atkBonus: 10 }) });

    expect(enchanted.attack).toBeGreaterThan(swapped.attack);
    expect(swapped.attack).toBe(30);
  });

  test('les effets de combat restent sous leurs plafonds', () => {
    // Un Rôdeur (+12 % de critique) avec une arme légendaire (+12 %) et deux Tranchant III
    // dépasserait le plafond sans la borne.
    const stats = getEffectiveStats(profile({ className: 'RANGER' }), {
      weapon: item({ rarity: 'LEGENDARY', enchants: [{ id: 'keen', tier: 3 }, { id: 'vampiric', tier: 3 }] }),
      armor: item({ enchants: [{ id: 'warding', tier: 3 }, { id: 'thorns', tier: 3 }] }),
      accessory: item({ enchants: [{ id: 'keen', tier: 3 }] }),
    });

    expect(stats.critChance).toBeLessThanOrEqual(EFFECT_CAPS.critChance);
    expect(stats.lifesteal).toBeLessThanOrEqual(EFFECT_CAPS.lifesteal);
    expect(stats.thorns).toBeLessThanOrEqual(EFFECT_CAPS.thorns);
    expect(stats.damageReduction).toBeLessThanOrEqual(EFFECT_CAPS.damageReduction);
  });

  test('sans enchantement, vol de vie et épines sont nuls', () => {
    const stats = getEffectiveStats(profile(), NO_GEAR);
    expect(stats.lifesteal).toBe(0);
    expect(stats.thorns).toBe(0);
  });
});

describe('computeAttack : vol de vie et épines', () => {
  test('les PV rendus et renvoyés se calculent sur les dégâts réellement infligés', () => {
    const result = computeAttack({
      attack: 100,
      targetDefense: 0,
      speed: 3,
      critChance: 0,
      lifesteal: 0.25,
      targetThorns: 0.1,
      random: () => 0,
    });

    expect(result.healed).toBe(Math.floor(result.damage * 0.25));
    expect(result.reflected).toBe(Math.floor(result.damage * 0.1));
  });

  test('sans enchantement, aucun soin ni renvoi', () => {
    const result = computeAttack({ attack: 50, targetDefense: 10, speed: 3, critChance: 0, random: () => 0 });

    expect(result.healed).toBe(0);
    expect(result.reflected).toBe(0);
  });
});

describe('règles de l autel', () => {
  test('la capacité d enchantement croît avec la rareté', () => {
    expect(enchantCapacity('COMMON')).toBe(1);
    expect(enchantCapacity('LEGENDARY')).toBe(3);
    // Une rareté inconnue ne doit pas rendre l'objet inenchantable.
    expect(enchantCapacity('INCONNUE')).toBe(1);
  });

  test('chaque emplacement dispose d au moins un enchantement', () => {
    expect(enchantmentsForSlot('weapon').length).toBeGreaterThan(0);
    expect(enchantmentsForSlot('armor').length).toBeGreaterThan(0);
    expect(enchantmentsForSlot('accessory').length).toBeGreaterThan(0);
  });

  test('le premier palier est garanti, les suivants ne le sont pas', () => {
    expect(enchantSuccessChance(1)).toBe(1);
    expect(enchantSuccessChance(2)).toBeLessThan(1);
    expect(enchantSuccessChance(3)).toBeLessThan(enchantSuccessChance(2));
    // Le palier maximal reste atteignable : une chance nulle bloquerait la progression.
    expect(enchantSuccessChance(3)).toBeGreaterThan(0);
  });

  test('le coût croît avec le palier et avec la rareté', () => {
    const flame = getEnchantment('flame')!;
    const vampiric = getEnchantment('vampiric')!;

    expect(enchantCost(flame, 2)).toBeGreaterThan(enchantCost(flame, 1));
    expect(enchantCost(vampiric, 1)).toBeGreaterThan(enchantCost(flame, 1));
  });
});
