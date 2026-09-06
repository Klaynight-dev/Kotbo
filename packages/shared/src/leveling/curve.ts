/**
 * Courbe d'XP d'une guilde.
 *
 * La formule est `baseXp * niveau^exposant + lineaireXp * niveau`, ce qui
 * reproduit exactement l'ancienne courbe codée en dur (100 / 200 / 2) quand la
 * configuration est laissée à ses valeurs par défaut : une guilde qui ne touche
 * à rien ne voit aucun niveau bouger.
 */

export type LevelCurve = {
  baseXp: number;
  linearXp: number;
  exponent: number;
  /** 0 = pas de plafond. */
  maxLevel: number;
};

export const DEFAULT_LEVEL_CURVE: LevelCurve = {
  baseXp: 100,
  linearXp: 200,
  exponent: 2,
  maxLevel: 0,
};

export const LEVEL_CURVE_LIMITS = {
  baseXp: { min: 1, max: 10_000 },
  linearXp: { min: 0, max: 10_000 },
  exponent: { min: 1, max: 4 },
  maxLevel: { min: 0, max: 1_000 },
} as const;

/**
 * Garde-fou de `levelFromXp` : la courbe est toujours strictement croissante
 * après normalisation, mais une XP importée d'un autre bot peut être énorme et
 * la boucle doit rester bornée même sans `maxLevel`.
 */
export const LEVEL_CURVE_HARD_CAP = LEVEL_CURVE_LIMITS.maxLevel.max;

/**
 * Plafond d'XP stockable pour un membre.
 *
 * `MemberLevel.xp` est un `Int` Postgres, borné à 2 147 483 647 : au-delà,
 * l'écriture échoue (`value out of range for type integer`) et l'appelant se
 * prend l'erreur brute - un `/leveling xp set` démesuré, ou une ligne aberrante
 * dans un classement importé. Le plafond reste volontairement bien en dessous
 * de la borne réelle, pour que les gains qui s'ajoutent ensuite - un membre
 * posé au plafond continue d'écrire - gardent de la marge.
 */
export const MAX_XP = 1_000_000_000;

/** Ramène une XP dans les bornes stockables (`NaN` et `Infinity` compris). */
export function clampXp(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(MAX_XP, Math.max(0, Math.floor(value)));
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

/**
 * Ramène une courbe quelconque (corps de requête, ligne de config) à des
 * paramètres sûrs à itérer. Une courbe décroissante ferait boucler
 * `levelFromXp` sans fin : les bornes ci-dessus la gardent croissante.
 */
export function normalizeLevelCurve(raw: unknown): LevelCurve {
  const candidate = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    baseXp: Math.round(clamp(candidate.baseXp, DEFAULT_LEVEL_CURVE.baseXp, LEVEL_CURVE_LIMITS.baseXp.min, LEVEL_CURVE_LIMITS.baseXp.max)),
    linearXp: Math.round(clamp(candidate.linearXp, DEFAULT_LEVEL_CURVE.linearXp, LEVEL_CURVE_LIMITS.linearXp.min, LEVEL_CURVE_LIMITS.linearXp.max)),
    exponent: clamp(candidate.exponent, DEFAULT_LEVEL_CURVE.exponent, LEVEL_CURVE_LIMITS.exponent.min, LEVEL_CURVE_LIMITS.exponent.max),
    maxLevel: Math.round(clamp(candidate.maxLevel, DEFAULT_LEVEL_CURVE.maxLevel, LEVEL_CURVE_LIMITS.maxLevel.min, LEVEL_CURVE_LIMITS.maxLevel.max)),
  };
}

/** XP totale nécessaire pour atteindre `level`. */
export function xpForLevel(level: number, curve: LevelCurve = DEFAULT_LEVEL_CURVE): number {
  if (!Number.isFinite(level) || level < 0) return 0;
  const capped = curve.maxLevel > 0 ? Math.min(level, curve.maxLevel) : level;
  return Math.round(curve.baseXp * Math.pow(capped, curve.exponent) + curve.linearXp * capped);
}

/**
 * Dérive le niveau à partir de l'XP totale.
 * L'XP est la source de vérité : le niveau en est toujours déduit, ce qui
 * permet d'auto-réparer les lignes incohérentes (ex. données importées d'un
 * autre bot avec une courbe différente).
 */
export function levelFromXp(xp: number, curve: LevelCurve = DEFAULT_LEVEL_CURVE): number {
  if (!Number.isFinite(xp) || xp < 0) return 0;
  const ceiling = curve.maxLevel > 0 ? Math.min(curve.maxLevel, LEVEL_CURVE_HARD_CAP) : LEVEL_CURVE_HARD_CAP;
  let level = 0;
  while (level < ceiling && xp >= xpForLevel(level, curve)) {
    level++;
  }
  return level;
}

/**
 * Points de la courbe pour un aperçu graphique : le dashboard doit pouvoir
 * montrer l'effet d'un réglage avant enregistrement, donc sans appel réseau.
 */
export function levelCurvePreview(curve: LevelCurve, levels: number): Array<{ level: number; totalXp: number; deltaXp: number }> {
  const requested = Math.max(1, Math.min(100, Math.floor(levels)));
  // Au-delà du plafond tous les paliers coûteraient 0 : l'aperçu s'arrête là
  // plutôt que d'aligner des barres vides.
  const count = curve.maxLevel > 0 ? Math.min(requested, curve.maxLevel) : requested;
  const points: Array<{ level: number; totalXp: number; deltaXp: number }> = [];
  for (let level = 1; level <= count; level++) {
    const totalXp = xpForLevel(level, curve);
    points.push({ level, totalXp, deltaXp: totalXp - xpForLevel(level - 1, curve) });
  }
  return points;
}
