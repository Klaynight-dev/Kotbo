/**
 * Bornes et normalisation d'une recette d'artisanat saisie au dashboard.
 *
 * Aucun accès base : ces règles décident de ce qu'un serveur peut écrire, et doivent
 * rester vérifiables en test. Une recette sans matériau, ou qui se fabrique à partir
 * d'elle-même, est une faille d'économie plutôt qu'une erreur de saisie.
 */

export const RECIPE_INGREDIENTS_MAX = 6;
export const RECIPE_QUANTITY_RANGE = { min: 1, max: 999 } as const;
export const RECIPE_COIN_COST_RANGE = { min: 0, max: 1_000_000 } as const;
export const RECIPE_LEVEL_RANGE = { min: 1, max: 100 } as const;

export interface RecipeIngredientInput {
  itemName?: unknown;
  quantity?: unknown;
}

export interface RecipeInput {
  resultItemId?: unknown;
  ingredients?: unknown;
  coinCost?: unknown;
  levelRequired?: unknown;
}

/** Alias de type et non interface : Prisma refuse une interface en colonne `Json`. */
export type NormalizedIngredient = {
  itemName: string;
  quantity: number;
};

export interface NormalizedRecipe {
  resultItemId: string;
  ingredients: NormalizedIngredient[];
  coinCost: number;
  levelRequired: number;
}

export type RecipeNormalizeResult =
  | { ok: true; value: NormalizedRecipe }
  | { ok: false; error: string };

function clampInt(value: unknown, range: { min: number; max: number }, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.trunc(parsed)));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeRecipeInput(input: RecipeInput): RecipeNormalizeResult {
  const resultItemId = text(input.resultItemId);
  if (!resultItemId) return { ok: false, error: "Choisissez l'objet fabriqué." };

  const raw = input.ingredients === undefined ? [] : input.ingredients;
  if (!Array.isArray(raw)) return { ok: false, error: 'La liste des matériaux est invalide.' };
  if (raw.length === 0) return { ok: false, error: 'Une recette demande au moins un matériau.' };
  if (raw.length > RECIPE_INGREDIENTS_MAX) {
    return { ok: false, error: `Une recette ne peut pas demander plus de ${RECIPE_INGREDIENTS_MAX} matériaux.` };
  }

  const ingredients: NormalizedIngredient[] = [];
  const seen = new Set<string>();
  for (const entry of raw as RecipeIngredientInput[]) {
    const itemName = text(entry?.itemName);
    if (!itemName) return { ok: false, error: 'Chaque matériau doit désigner un objet.' };
    // Les matériaux sont désignés par leur nom : deux lignes pour le même objet
    // s'annuleraient à la lecture, seule la dernière étant consommée.
    if (seen.has(itemName)) return { ok: false, error: `Le matériau « ${itemName} » est présent deux fois.` };
    seen.add(itemName);

    ingredients.push({ itemName, quantity: clampInt(entry?.quantity, RECIPE_QUANTITY_RANGE, 1) });
  }

  return {
    ok: true,
    value: {
      resultItemId,
      ingredients,
      coinCost: clampInt(input.coinCost, RECIPE_COIN_COST_RANGE, 0),
      levelRequired: clampInt(input.levelRequired, RECIPE_LEVEL_RANGE, 1),
    },
  };
}

/**
 * Relit la colonne `ingredients`.
 *
 * Comme le butin des monstres, les premiers seeds y ont écrit une *chaîne* JSON là où les
 * suivants stockent un tableau natif : les deux formes cohabitent et doivent être lues
 * indifféremment.
 */
export function parseRecipeIngredients(value: unknown): NormalizedIngredient[] {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((entry) => {
    const ingredient = entry as RecipeIngredientInput;
    const itemName = text(ingredient?.itemName);
    if (!itemName) return [];
    return [{ itemName, quantity: clampInt(ingredient?.quantity, RECIPE_QUANTITY_RANGE, 1) }];
  });
}

/**
 * Écarte la recette livrée quand le serveur en a écrit une pour le même objet.
 *
 * Les deux sources se lisent ensemble - fournies de base et propres au serveur - et rien
 * ne les départageait : l'atelier affichait alors deux entrées pour la même arme, avec des
 * coûts différents et rien pour dire laquelle compte. Celle du serveur l'emporte, ce qui en
 * fait un vrai remplacement plutôt qu'un doublon.
 */
export function preferGuildRecipes<T extends { guildId: string | null; resultItemId: string }>(recipes: T[]): T[] {
  const overridden = new Set(
    recipes.filter((recipe) => recipe.guildId !== null).map((recipe) => recipe.resultItemId),
  );

  return recipes.filter((recipe) => recipe.guildId !== null || !overridden.has(recipe.resultItemId));
}
