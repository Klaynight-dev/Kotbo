import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_LEVEL_CURVE,
  LEVEL_CURVE_HARD_CAP,
  LEVEL_CURVE_LIMITS,
  MAX_XP,
  clampXp,
  grantedWithinDailyCap,
  levelCurvePreview,
  levelFromXp,
  normalizeLevelCurve,
  xpForLevel,
} from '@kotbo/shared';

describe('xpForLevel', () => {
  test('reproduit la formule historique avec la courbe par defaut', () => {
    for (const level of [0, 1, 5, 12, 40]) {
      expect(xpForLevel(level)).toBe(100 * level * level + 200 * level);
    }
  });

  test('renvoie 0 pour un niveau negatif ou invalide', () => {
    expect(xpForLevel(-1)).toBe(0);
    expect(xpForLevel(Number.NaN)).toBe(0);
  });

  test('est strictement croissante quelle que soit la courbe normalisee', () => {
    const curves = [
      { baseXp: 1, linearXp: 0, exponent: 1 },
      { baseXp: 10_000, linearXp: 10_000, exponent: 4 },
      { baseXp: 50, linearXp: 5, exponent: 1.3 },
    ];
    for (const raw of curves) {
      const curve = normalizeLevelCurve(raw);
      for (let level = 1; level <= 60; level++) {
        expect(xpForLevel(level, curve)).toBeGreaterThan(xpForLevel(level - 1, curve));
      }
    }
  });

  test('plafonne l XP requise au niveau maximum', () => {
    const curve = normalizeLevelCurve({ maxLevel: 10 });
    expect(xpForLevel(15, curve)).toBe(xpForLevel(10, curve));
  });
});

describe('levelFromXp', () => {
  test('est la reciproque de xpForLevel', () => {
    const curve = normalizeLevelCurve({ baseXp: 80, linearXp: 120, exponent: 1.8 });
    for (let level = 1; level <= 30; level++) {
      expect(levelFromXp(xpForLevel(level, curve), curve)).toBe(level + 1);
      expect(levelFromXp(xpForLevel(level, curve) - 1, curve)).toBe(level);
    }
  });

  test('ne depasse jamais le niveau maximum', () => {
    const curve = normalizeLevelCurve({ maxLevel: 5 });
    expect(levelFromXp(10_000_000, curve)).toBe(5);
  });

  test('reste borne sans plafond de niveau', () => {
    expect(levelFromXp(Number.MAX_SAFE_INTEGER)).toBe(LEVEL_CURVE_HARD_CAP);
  });

  test('renvoie 0 pour une XP negative', () => {
    expect(levelFromXp(-50)).toBe(0);
  });
});

describe('normalizeLevelCurve', () => {
  test('retombe sur le defaut pour toute entree non exploitable', () => {
    for (const raw of [null, undefined, 42, 'default', true]) {
      expect(normalizeLevelCurve(raw)).toEqual(DEFAULT_LEVEL_CURVE);
    }
  });

  test('borne les valeurs hors limites au lieu de les rejeter', () => {
    const curve = normalizeLevelCurve({ baseXp: -10, linearXp: 999_999, exponent: 12, maxLevel: -3 });
    expect(curve.baseXp).toBe(LEVEL_CURVE_LIMITS.baseXp.min);
    expect(curve.linearXp).toBe(LEVEL_CURVE_LIMITS.linearXp.max);
    expect(curve.exponent).toBe(LEVEL_CURVE_LIMITS.exponent.max);
    expect(curve.maxLevel).toBe(LEVEL_CURVE_LIMITS.maxLevel.min);
  });

  test('arrondit les coefficients entiers', () => {
    expect(normalizeLevelCurve({ baseXp: 12.7, linearXp: 3.2, maxLevel: 9.6 })).toMatchObject({
      baseXp: 13,
      linearXp: 3,
      maxLevel: 10,
    });
  });
});

describe('levelCurvePreview', () => {
  test('donne le cout de chaque niveau, pas le cumul', () => {
    const curve = DEFAULT_LEVEL_CURVE;
    const points = levelCurvePreview(curve, 3);
    expect(points).toHaveLength(3);
    expect(points[0]).toEqual({ level: 1, totalXp: 300, deltaXp: 300 });
    expect(points[1].deltaXp).toBe(xpForLevel(2, curve) - xpForLevel(1, curve));
  });

  test('borne le nombre de points demandes', () => {
    expect(levelCurvePreview(DEFAULT_LEVEL_CURVE, 0)).toHaveLength(1);
    expect(levelCurvePreview(DEFAULT_LEVEL_CURVE, 5_000)).toHaveLength(100);
  });

  test('s arrete au niveau maximum', () => {
    expect(levelCurvePreview(normalizeLevelCurve({ maxLevel: 8 }), 30)).toHaveLength(8);
  });
});

describe('grantedWithinDailyCap', () => {
  test('accorde tout tant que le plafond est desactive', () => {
    expect(grantedWithinDailyCap(999_999, 25, 0)).toBe(25);
    expect(grantedWithinDailyCap(999_999, 25, -1)).toBe(25);
  });

  test('accorde tout tant que le compteur reste sous le plafond', () => {
    expect(grantedWithinDailyCap(400, 25, 500)).toBe(25);
    expect(grantedWithinDailyCap(500, 25, 500)).toBe(25);
  });

  test('ne rend que la part qui tient sous le plafond', () => {
    expect(grantedWithinDailyCap(510, 25, 500)).toBe(15);
  });

  test('n accorde plus rien une fois le plafond depasse', () => {
    expect(grantedWithinDailyCap(600, 25, 500)).toBe(0);
  });

  test('deux gains concurrents ne franchissent pas le plafond ensemble', () => {
    const cap = 100;
    // Les deux increments sont partis d un compteur a 90 : le premier arrive a
    // 110, le second a 130. Ensemble ils ne doivent pas accorder plus que les
    // 10 XP restants.
    const first = grantedWithinDailyCap(110, 20, cap);
    const second = grantedWithinDailyCap(130, 20, cap);
    expect(first + second).toBe(10);
  });

  test('ignore les montants nuls ou invalides', () => {
    expect(grantedWithinDailyCap(0, 0, 500)).toBe(0);
    expect(grantedWithinDailyCap(0, Number.NaN, 500)).toBe(0);
  });
});

describe('clampXp', () => {
  test('ramene une XP demesuree sous la borne de la colonne', () => {
    // `MemberLevel.xp` est un Int Postgres : au-dela de 2 147 483 647 l'ecriture
    // echoue et l'admin recoit l'erreur brute au lieu de son reglage.
    expect(clampXp(2_469_297_959_900)).toBe(MAX_XP);
    expect(MAX_XP).toBeLessThan(2_147_483_647);
  });

  test('plancher a zero et valeurs entieres', () => {
    expect(clampXp(-1)).toBe(0);
    expect(clampXp(12.9)).toBe(12);
  });

  test('absorbe les valeurs non finies', () => {
    // Une courbe extreme peut renvoyer Infinity, un fichier importe un NaN.
    expect(clampXp(Number.POSITIVE_INFINITY)).toBe(MAX_XP);
    expect(clampXp(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(clampXp(Number.NaN)).toBe(0);
  });

  test('laisse passer une valeur normale', () => {
    expect(clampXp(15_000)).toBe(15_000);
  });
});
