import { describe, expect, test } from 'bun:test';
import {
  computeClanLevelUpPoints,
  normalizeLevelCurve,
  xpForLevel,
  DEFAULT_LEVEL_CURVE,
  MAX_CLAN_POINTS_PER_LEVEL_UP,
  MAX_CLAN_SEASON_POINTS,
  MIN_CLAN_REFERENCE_LEVEL,
} from '@kotbo/shared';

const FLAT = { flatPerLevelUp: 50, proportional: false, referenceLevel: 25 };
const PROP = { flatPerLevelUp: 50, proportional: true, referenceLevel: 25 };

describe('mode forfaitaire', () => {
  test('verse le meme montant a tous les niveaux', () => {
    for (const level of [2, 25, 100]) {
      expect(computeClanLevelUpPoints(level - 1, level, FLAT, DEFAULT_LEVEL_CURVE)).toBe(50);
    }
  });

  test('ne verse rien sans montee de niveau', () => {
    expect(computeClanLevelUpPoints(10, 10, FLAT, DEFAULT_LEVEL_CURVE)).toBe(0);
    expect(computeClanLevelUpPoints(10, 9, FLAT, DEFAULT_LEVEL_CURVE)).toBe(0);
  });
});

describe('passage sans XP franchie', () => {
  // Le seuil du niveau 1 vaut 0 quelle que soit la courbe : les deux termes de
  // `xpForLevel` sont multiplies par le niveau. Le passage 0 -> 1, declenche par
  // le tout premier gain d'XP d'un membre, ne franchit donc rien.
  test('le niveau 1 n est paye par aucun des deux modes', () => {
    expect(computeClanLevelUpPoints(0, 1, FLAT, DEFAULT_LEVEL_CURVE)).toBe(0);
    expect(computeClanLevelUpPoints(0, 1, PROP, DEFAULT_LEVEL_CURVE)).toBe(0);
  });

  test('aucune courbe ne rend le niveau 1 payant', () => {
    const courbes = [
      normalizeLevelCurve({ baseXp: 10_000, linearXp: 10_000, exponent: 4 }),
      normalizeLevelCurve({ baseXp: 1, linearXp: 0, exponent: 1 }),
      normalizeLevelCurve({ baseXp: 5_000, linearXp: 0, exponent: 3 }),
    ];
    for (const curve of courbes) {
      expect(xpForLevel(0, curve)).toBe(0);
      expect(computeClanLevelUpPoints(0, 1, FLAT, curve)).toBe(0);
      expect(computeClanLevelUpPoints(0, 1, PROP, curve)).toBe(0);
    }
  });

  test('le premier vrai palier reste paye', () => {
    expect(computeClanLevelUpPoints(1, 2, FLAT, DEFAULT_LEVEL_CURVE)).toBe(50);
    expect(computeClanLevelUpPoints(1, 2, PROP, DEFAULT_LEVEL_CURVE)).toBeGreaterThan(0);
  });

  test('un saut qui part de zero paye les paliers reellement franchis', () => {
    // 0 -> 3 franchit les seuils des niveaux 2 et 3, pas celui du niveau 1.
    expect(computeClanLevelUpPoints(0, 3, PROP, DEFAULT_LEVEL_CURVE))
      .toBe(computeClanLevelUpPoints(1, 3, PROP, DEFAULT_LEVEL_CURVE));
  });
});

describe('mode proportionnel', () => {
  test('verse exactement le forfait au niveau de reference', () => {
    expect(computeClanLevelUpPoints(24, 25, PROP, DEFAULT_LEVEL_CURVE)).toBe(50);
  });

  test('suit le forfait quand il change', () => {
    const doubled = { ...PROP, flatPerLevelUp: 100 };
    expect(computeClanLevelUpPoints(24, 25, doubled, DEFAULT_LEVEL_CURVE)).toBe(100);
    expect(computeClanLevelUpPoints(99, 100, doubled, DEFAULT_LEVEL_CURVE))
      .toBe(2 * computeClanLevelUpPoints(99, 100, PROP, DEFAULT_LEVEL_CURVE));
  });

  test('verse moins sous la reference et plus au-dessus', () => {
    const bas = computeClanLevelUpPoints(1, 2, PROP, DEFAULT_LEVEL_CURVE);
    const ref = computeClanLevelUpPoints(24, 25, PROP, DEFAULT_LEVEL_CURVE);
    const haut = computeClanLevelUpPoints(99, 100, PROP, DEFAULT_LEVEL_CURVE);
    expect(bas).toBeLessThan(ref);
    expect(haut).toBeGreaterThan(ref);
  });

  test('rend le rendement par XP identique a tous les niveaux', () => {
    // Le coeur de la correction : a XP egale gagnee, la contribution doit etre
    // la meme quel que soit le niveau. On mesure donc les points rapportes par
    // point d'XP franchi, qui doit rester constant.
    const curve = DEFAULT_LEVEL_CURVE;
    const rendement = (from: number, to: number) =>
      computeClanLevelUpPoints(from, to, PROP, curve)
        / (xpForLevel(to - 1, curve) - xpForLevel(from - 1, curve));

    const reference = rendement(24, 25);
    for (const [from, to] of [[9, 10], [49, 50], [99, 100]] as const) {
      expect(Math.abs(rendement(from, to) - reference) / reference).toBeLessThan(0.05);
    }
  });

  test('le forfait, lui, ecrase les vaillants', () => {
    // Meme mesure en mode forfaitaire : le rendement s'effondre avec le niveau,
    // ce qui est exactement la plainte a l'origine du mode proportionnel.
    const curve = DEFAULT_LEVEL_CURVE;
    const rendement = (from: number, to: number) =>
      computeClanLevelUpPoints(from, to, FLAT, curve)
        / (xpForLevel(to - 1, curve) - xpForLevel(from - 1, curve));

    expect(rendement(1, 2) / rendement(99, 100)).toBeGreaterThan(30);
  });

  test('compte les sauts de plusieurs niveaux en une fois', () => {
    const direct = computeClanLevelUpPoints(10, 13, PROP, DEFAULT_LEVEL_CURVE);
    const cumul = computeClanLevelUpPoints(10, 11, PROP, DEFAULT_LEVEL_CURVE)
      + computeClanLevelUpPoints(11, 12, PROP, DEFAULT_LEVEL_CURVE)
      + computeClanLevelUpPoints(12, 13, PROP, DEFAULT_LEVEL_CURVE);
    expect(Math.abs(direct - cumul)).toBeLessThanOrEqual(2);
  });

  test('suit la courbe de la guilde et non une formule figee', () => {
    const plate = normalizeLevelCurve({ baseXp: 1, linearXp: 100, exponent: 1 });
    // Courbe lineaire : chaque niveau coute pareil, donc le forfait redevient
    // le bon barreme a tous les niveaux.
    expect(computeClanLevelUpPoints(1, 2, PROP, plate)).toBe(computeClanLevelUpPoints(80, 81, PROP, plate));
  });
});

describe('garde-fous', () => {
  test('borne le versement pour ne pas deborder un entier 32 bits', () => {
    const raide = normalizeLevelCurve({ baseXp: 10_000, exponent: 4, linearXp: 10_000 });
    const points = computeClanLevelUpPoints(998, 999, { ...PROP, referenceLevel: 2 }, raide);
    expect(points).toBe(MAX_CLAN_POINTS_PER_LEVEL_UP);
    expect(points).toBeLessThan(2_147_483_647);
  });

  test('borne aussi le forfait, qui multiplie tout le bareme', () => {
    const enorme = { flatPerLevelUp: 5_000_000_000, proportional: false, referenceLevel: 25 };
    expect(computeClanLevelUpPoints(1, 2, enorme, DEFAULT_LEVEL_CURVE)).toBe(MAX_CLAN_POINTS_PER_LEVEL_UP);
  });

  test('ne divise jamais par zero avec une reference trop basse', () => {
    for (const referenceLevel of [0, 1, -5, Number.NaN]) {
      const points = computeClanLevelUpPoints(24, 25, { ...PROP, referenceLevel }, DEFAULT_LEVEL_CURVE);
      expect(Number.isFinite(points)).toBe(true);
      expect(points).toBeGreaterThan(0);
    }
    expect(MIN_CLAN_REFERENCE_LEVEL).toBe(2);
  });

  test('le total de saison reste sous l entier 32 bits', () => {
    // `creditClanContribution` ramene le cumul a ce plafond : il doit laisser
    // de la marge sous la limite de la colonne, meme apres un dernier gain
    // arrive au maximum autorise par montee de niveau.
    expect(MAX_CLAN_SEASON_POINTS + MAX_CLAN_POINTS_PER_LEVEL_UP).toBeLessThan(2_147_483_647);
  });

  test('ne verse rien avec un forfait nul ou negatif', () => {
    expect(computeClanLevelUpPoints(1, 2, { ...PROP, flatPerLevelUp: 0 }, DEFAULT_LEVEL_CURVE)).toBe(0);
    expect(computeClanLevelUpPoints(1, 2, { ...PROP, flatPerLevelUp: -50 }, DEFAULT_LEVEL_CURVE)).toBe(0);
  });
});
