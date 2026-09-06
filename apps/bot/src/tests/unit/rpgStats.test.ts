import { describe, expect, test } from 'bun:test';
import {
  BASE_CRIT_CHANCE,
  MAX_UPGRADE_LEVEL,
  getEffectiveStats,
  upgradeBonus,
  upgradeCost,
  upgradeSuccessChance,
  type Equipment,
  type EquippedPiece,
  type StatProfile,
} from '../../services/features/rpg/rpgStats.js';
import { computeAttack } from '../../services/features/rpg/rpgCombatMath.js';

function profile(overrides: Partial<StatProfile> = {}): StatProfile {
  return {
    level: 10,
    attack: 20,
    defense: 20,
    speed: 20,
    maxHealth: 150,
    className: null,
    ...overrides,
  };
}

/**
 * Objet porté, avec la progression de l'exemplaire possédé. Forge et enchantements vivent
 * désormais sur l'instance : ils se déclarent ici, plus sur le profil.
 */
function item(overrides: Partial<EquippedPiece> = {}): EquippedPiece {
  return { atkBonus: 0, defBonus: 0, spdBonus: 0, hpBonus: 0, rarity: 'COMMON', upgrade: 0, enchants: [], ...overrides };
}

const NO_GEAR: Equipment = { weapon: null, armor: null, accessory: null };

describe('getEffectiveStats', () => {
  test('sans équipement ni classe, les stats effectives valent les stats de base', () => {
    const stats = getEffectiveStats(profile(), NO_GEAR);

    expect(stats.attack).toBe(20);
    expect(stats.defense).toBe(20);
    expect(stats.speed).toBe(20);
    expect(stats.maxHealth).toBe(150);
    expect(stats.critChance).toBeCloseTo(BASE_CRIT_CHANCE, 5);
  });

  test("un objet supprimé n'accorde plus rien, forge et enchantements compris", () => {
    // Un emplacement peut pointer vers un objet supprimé de la boutique. La contribution
    // doit tomber a zero, sinon le joueur conserverait les statistiques d'un objet disparu
    // de son inventaire (issue #66). La progression vivant sur l'instance, elle disparaît
    // avec elle : il n'y a plus de niveau de forge résiduel possible sur le profil.
    const stats = getEffectiveStats(profile(), NO_GEAR);

    expect(stats.attack).toBe(20);
    expect(stats.defense).toBe(20);
    expect(stats.speed).toBe(20);
    expect(stats.maxHealth).toBe(150);
    // La rareté du critique se lit sur l'arme : sans arme, on reste au socle.
    expect(stats.critChance).toBeCloseTo(BASE_CRIT_CHANCE, 5);
  });

  test('les bonus des trois emplacements se cumulent une seule fois', () => {
    const stats = getEffectiveStats(profile(), {
      weapon: item({ atkBonus: 10 }),
      armor: item({ defBonus: 8, hpBonus: 30 }),
      accessory: item({ spdBonus: 5, atkBonus: 3 }),
    });

    expect(stats.attack).toBe(33); // 20 base + 10 arme + 3 accessoire
    expect(stats.defense).toBe(28);
    expect(stats.speed).toBe(25);
    expect(stats.maxHealth).toBe(180);
  });

  test('la classe multiplie les stats de base sans toucher aux bonus d équipement', () => {
    // Mage : ATQ x1.35. 20 x 1.35 = 27, plus 10 bruts de l'arme = 37.
    // Multiplier aussi le bonus de l'arme donnerait 40 : c'est ce qu'on veut éviter.
    const stats = getEffectiveStats(profile({ className: 'MAGE' }), {
      weapon: item({ atkBonus: 10 }),
      armor: null,
      accessory: null,
    });

    expect(stats.attack).toBe(37);
    expect(stats.armorPiercing).toBeCloseTo(0.3, 5);
  });

  test('le passif de classe alimente réduction de dégâts et critique', () => {
    expect(getEffectiveStats(profile({ className: 'WARRIOR' }), NO_GEAR).damageReduction).toBeCloseTo(0.15, 5);

    const ranger = getEffectiveStats(profile({ className: 'RANGER' }), NO_GEAR);
    expect(ranger.critChance).toBeCloseTo(BASE_CRIT_CHANCE + 0.12, 5);
  });

  test('la rareté de l arme augmente la chance de critique', () => {
    const common = getEffectiveStats(profile(), { ...NO_GEAR, weapon: item({ rarity: 'COMMON' }) });
    const legendary = getEffectiveStats(profile(), { ...NO_GEAR, weapon: item({ rarity: 'LEGENDARY' }) });

    expect(legendary.critChance).toBeGreaterThan(common.critChance);
    expect(legendary.critChance).toBeCloseTo(BASE_CRIT_CHANCE + 0.12, 5);
  });

  test('la forge augmente les stats de l objet amélioré', () => {
    const plain = getEffectiveStats(profile(), { ...NO_GEAR, weapon: item({ atkBonus: 20 }) });
    const upgraded = getEffectiveStats(profile(), { ...NO_GEAR, weapon: item({ atkBonus: 20, upgrade: 5 }) });

    expect(upgraded.attack).toBeGreaterThan(plain.attack);
    expect(upgraded.attack).toBe(plain.attack + upgradeBonus(20, 5));
  });

  test('une amélioration ne fait rien gagner sur une statistique absente de l objet', () => {
    // Un accessoire purement défensif ne doit pas gagner d'attaque en montant à +10.
    expect(upgradeBonus(0, 10)).toBe(0);
  });
});

describe('économie de la forge', () => {
  test('le coût croît strictement avec le niveau', () => {
    const costs = Array.from({ length: MAX_UPGRADE_LEVEL }, (_, level) => upgradeCost(1000, level));
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i]).toBeGreaterThan(costs[i - 1]);
    }
  });

  test('les trois premiers niveaux sont garantis, puis le risque monte', () => {
    expect(upgradeSuccessChance(0)).toBe(1);
    expect(upgradeSuccessChance(2)).toBe(1);
    expect(upgradeSuccessChance(3)).toBeLessThan(1);
    expect(upgradeSuccessChance(MAX_UPGRADE_LEVEL - 1)).toBeGreaterThanOrEqual(0.25);
  });
});

describe('computeAttack', () => {
  /** Générateur figé : premier tirage pour la variance, second pour le critique. */
  const fixed = (values: number[]) => {
    let i = 0;
    return () => values[Math.min(i++, values.length - 1)];
  };

  test('inflige toujours au moins 1 dégât, même face à une défense écrasante', () => {
    const result = computeAttack({
      attack: 5,
      targetDefense: 500,
      speed: 1,
      critChance: 0,
      random: fixed([0, 0.99]),
    });

    expect(result.damage).toBeGreaterThanOrEqual(1);
    expect(result.critical).toBe(false);
  });

  test('la pénétration d armure augmente les dégâts', () => {
    const base = { attack: 50, targetDefense: 40, speed: 3, critChance: 0, random: () => 0 };

    const withoutPierce = computeAttack(base);
    const withPierce = computeAttack({ ...base, armorPiercing: 1 });

    expect(withPierce.damage).toBeGreaterThan(withoutPierce.damage);
  });

  test('la posture de défense de la cible réduit les dégâts reçus', () => {
    const base = { attack: 50, targetDefense: 30, speed: 3, critChance: 0, random: () => 0 };

    const normal = computeAttack(base);
    const guarded = computeAttack({ ...base, targetDefenseMultiplier: 2 });

    expect(guarded.damage).toBeLessThan(normal.damage);
  });

  test('la réduction de dégâts du passif s applique après le critique', () => {
    const base = { attack: 100, targetDefense: 0, speed: 3, critChance: 1, random: () => 0 };

    const raw = computeAttack(base);
    const mitigated = computeAttack({ ...base, targetDamageReduction: 0.5 });

    expect(raw.critical).toBe(true);
    expect(mitigated.damage).toBeLessThan(raw.damage);
    expect(mitigated.damage).toBe(Math.max(1, Math.floor(raw.damage * 0.5)));
  });

  test('le multiplicateur de compétence amplifie les dégâts', () => {
    const base = { attack: 60, targetDefense: 20, speed: 3, critChance: 0, random: () => 0 };

    const normal = computeAttack(base);
    const skill = computeAttack({ ...base, skillMultiplier: 2 });

    expect(skill.damage).toBe(normal.damage * 2);
  });
});
