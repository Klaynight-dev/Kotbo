/**
 * Recettes d'artisanat propres à un serveur.
 *
 * Le modèle prévoyait des recettes par serveur depuis le début - `guildId` nul valant
 * « fournie de base » - mais rien ne permettait d'en écrire : un serveur pouvait créer une
 * arme dans sa boutique sans aucun moyen de la rendre fabricable.
 *
 * Les matériaux sont désignés par leur nom et non par leur identifiant, comme le butin des
 * monstres. C'est ce qui permet à un joueur de fabriquer avec des exemplaires venus de
 * n'importe où, mais ça impose de suivre les renommages : voir `syncRecipeReferences`.
 */

import prisma from '../../../utils/db.js';
import {
  normalizeRecipeInput,
  parseRecipeIngredients,
  preferGuildRecipes,
  type RecipeInput,
} from './rpgRecipePolicy.js';

export class RecipeError extends Error {
  constructor(message: string, readonly status: number = 400) {
    super(message);
    this.name = 'RecipeError';
  }
}

/** Objets utilisables par ce serveur : son catalogue propre et celui livré de base. */
async function guildItems(guildId: string) {
  return prisma.rpgItem.findMany({
    where: { OR: [{ guildId: null }, { guildId }] },
    select: { id: true, name: true, emoji: true, guildId: true },
  });
}

/**
 * Recettes visibles d'un serveur, les siennes et celles fournies de base.
 *
 * Les recettes globales sont renvoyées en lecture seule : elles sont partagées par tous les
 * serveurs, et les laisser modifier depuis un dashboard reviendrait à réécrire le jeu de
 * tout le monde. C'est déjà la règle pour les objets et les monstres livrés.
 */
export async function listGuildRecipes(guildId: string) {
  const recipes = await prisma.rpgRecipe.findMany({
    where: { OR: [{ guildId: null }, { guildId }] },
    include: { resultItem: { select: { id: true, name: true, emoji: true, rarity: true, type: true } } },
    orderBy: [{ levelRequired: 'asc' }],
  });

  // La page montre ce que le joueur verra : une recette du serveur remplace la livrée qui
  // fabriquait le même objet, plutôt que de s'afficher à côté d'elle.
  return preferGuildRecipes(recipes).map((recipe) => ({
    id: recipe.id,
    resultItemId: recipe.resultItemId,
    resultItem: recipe.resultItem,
    ingredients: parseRecipeIngredients(recipe.ingredients),
    coinCost: recipe.coinCost,
    levelRequired: recipe.levelRequired,
    /** Faux pour une recette livrée de base : la page l'affiche sans permettre de l'éditer. */
    editable: recipe.guildId === guildId,
  }));
}

export async function saveGuildRecipe(guildId: string, input: RecipeInput, recipeId?: string) {
  const normalized = normalizeRecipeInput(input);
  if (!normalized.ok) throw new RecipeError(normalized.error, 400);
  const data = normalized.value;

  const items = await guildItems(guildId);
  const result = items.find((item) => item.id === data.resultItemId);
  if (!result) throw new RecipeError("L'objet fabriqué n'existe pas sur ce serveur.", 400);

  // Les matériaux sont des noms : ils doivent désigner un objet que ce serveur connaît,
  // sinon la recette s'affiche au joueur avec un matériau qu'il ne pourra jamais trouver.
  const known = new Set(items.map((item) => item.name));
  for (const ingredient of data.ingredients) {
    if (!known.has(ingredient.itemName)) {
      throw new RecipeError(`Le matériau « ${ingredient.itemName} » n'existe pas sur ce serveur.`, 400);
    }
    // Fabriquer un objet à partir de lui-même transforme la recette en multiplicateur.
    if (ingredient.itemName === result.name) {
      throw new RecipeError("Un objet ne peut pas être son propre matériau.", 400);
    }
  }

  // Une seule recette par objet fabriqué : deux recettes pour la même arme s'affichent
  // l'une sous l'autre dans l'atelier, sans que rien ne les distingue.
  const twin = await prisma.rpgRecipe.findFirst({
    where: { guildId, resultItemId: data.resultItemId, ...(recipeId ? { NOT: { id: recipeId } } : {}) },
    select: { id: true },
  });
  if (twin) throw new RecipeError(`« ${result.name} » a déjà une recette sur ce serveur.`, 409);

  const payload = {
    resultItemId: data.resultItemId,
    ingredients: data.ingredients,
    coinCost: data.coinCost,
    levelRequired: data.levelRequired,
  };

  if (!recipeId) {
    return { recipe: await prisma.rpgRecipe.create({ data: { guildId, ...payload } }), created: true };
  }

  const existing = await prisma.rpgRecipe.findUnique({ where: { id: recipeId }, select: { guildId: true } });
  if (!existing) throw new RecipeError('Recette introuvable.', 404);
  if (existing.guildId === null) {
    throw new RecipeError('Les recettes fournies de base sont partagées par tous les serveurs.', 403);
  }
  if (existing.guildId !== guildId) throw new RecipeError('Cette recette appartient à un autre serveur.', 403);

  return { recipe: await prisma.rpgRecipe.update({ where: { id: recipeId }, data: payload }), created: false };
}

export async function deleteGuildRecipe(guildId: string, recipeId: string) {
  const existing = await prisma.rpgRecipe.findUnique({
    where: { id: recipeId },
    select: { guildId: true, resultItem: { select: { name: true } } },
  });
  if (!existing) throw new RecipeError('Recette introuvable.', 404);
  if (existing.guildId === null) {
    throw new RecipeError('Les recettes fournies de base sont partagées par tous les serveurs.', 403);
  }
  if (existing.guildId !== guildId) throw new RecipeError('Cette recette appartient à un autre serveur.', 403);

  await prisma.rpgRecipe.delete({ where: { id: recipeId } });
  return { name: existing.resultItem.name };
}

/**
 * Suit un objet renommé ou supprimé dans les matériaux des recettes du serveur.
 *
 * Les matériaux sont désignés par leur nom : sans ce rattrapage, renommer un objet laissait
 * des recettes réclamant un matériau qui n'existe plus, infabriquables et sans explication.
 * Seules les recettes du serveur sont touchées, celles livrées de base étant partagées.
 */
export async function syncRecipeReferences(
  guildId: string,
  itemName: string,
  replacement: string | null,
): Promise<number> {
  if (replacement === itemName) return 0;

  const recipes = await prisma.rpgRecipe.findMany({ where: { guildId } });
  let touched = 0;

  for (const recipe of recipes) {
    const ingredients = parseRecipeIngredients(recipe.ingredients);
    if (!ingredients.some((ingredient) => ingredient.itemName === itemName)) continue;

    // Objet supprimé : la ligne part, et une recette qui n'a plus aucun matériau part avec
    // elle - la garder afficherait un objet fabricable à partir de rien.
    if (replacement === null) {
      const left = ingredients.filter((ingredient) => ingredient.itemName !== itemName);
      if (left.length === 0) await prisma.rpgRecipe.delete({ where: { id: recipe.id } });
      else await prisma.rpgRecipe.update({ where: { id: recipe.id }, data: { ingredients: left } });
      touched += 1;
      continue;
    }

    // Le nouveau nom peut déjà figurer dans la recette : les quantités se cumulent plutôt
    // que de laisser deux lignes que la saisie refuserait.
    const merged = new Map<string, number>();
    for (const ingredient of ingredients) {
      const name = ingredient.itemName === itemName ? replacement : ingredient.itemName;
      merged.set(name, (merged.get(name) ?? 0) + ingredient.quantity);
    }

    await prisma.rpgRecipe.update({
      where: { id: recipe.id },
      data: { ingredients: [...merged].map(([name, quantity]) => ({ itemName: name, quantity })) },
    });
    touched += 1;
  }

  return touched;
}
