import { describe, expect, test } from 'bun:test';
import {
  normalizeRecipeInput,
  parseRecipeIngredients,
  preferGuildRecipes,
  RECIPE_INGREDIENTS_MAX,
  RECIPE_LEVEL_RANGE,
  RECIPE_QUANTITY_RANGE,
} from '../../services/features/rpg/rpgRecipePolicy.js';

const VALID = {
  resultItemId: 'epee-longue',
  ingredients: [{ itemName: 'Minerai de fer', quantity: 3 }],
  coinCost: 250,
  levelRequired: 5,
};

describe('fiche de recette', () => {
  test('accepte une recette complète', () => {
    const result = normalizeRecipeInput(VALID);
    if (!result.ok) throw new Error(result.error);

    expect(result.value.resultItemId).toBe('epee-longue');
    expect(result.value.ingredients).toEqual([{ itemName: 'Minerai de fer', quantity: 3 }]);
    expect(result.value.coinCost).toBe(250);
  });

  // Une recette sans matériau se fabriquerait à partir de rien : c'est une machine à
  // objets, pas une recette.
  test('refuse une recette sans matériau', () => {
    expect(normalizeRecipeInput({ ...VALID, ingredients: [] }).ok).toBe(false);
    expect(normalizeRecipeInput({ ...VALID, ingredients: undefined }).ok).toBe(false);
  });

  test('refuse un objet fabriqué absent', () => {
    expect(normalizeRecipeInput({ ...VALID, resultItemId: '   ' }).ok).toBe(false);
  });

  test('refuse une liste trop longue ou mal formée', () => {
    const many = Array.from({ length: RECIPE_INGREDIENTS_MAX + 1 }, (_, i) => ({ itemName: `mat-${i}`, quantity: 1 }));
    expect(normalizeRecipeInput({ ...VALID, ingredients: many }).ok).toBe(false);
    expect(normalizeRecipeInput({ ...VALID, ingredients: 'du texte' }).ok).toBe(false);
    expect(normalizeRecipeInput({ ...VALID, ingredients: [{ quantity: 2 }] }).ok).toBe(false);
  });

  // Les matériaux sont désignés par leur nom : deux lignes pour le même objet se
  // recouvriraient à la consommation, seule la dernière comptant.
  test('refuse deux fois le même matériau', () => {
    const result = normalizeRecipeInput({
      ...VALID,
      ingredients: [{ itemName: 'Bois', quantity: 1 }, { itemName: 'Bois', quantity: 2 }],
    });
    expect(result.ok).toBe(false);
  });

  test('ramène les valeurs aberrantes dans leurs bornes', () => {
    const result = normalizeRecipeInput({
      ...VALID,
      ingredients: [{ itemName: 'Bois', quantity: -4 }],
      coinCost: -100,
      levelRequired: 9999,
    });
    if (!result.ok) throw new Error(result.error);

    expect(result.value.ingredients[0].quantity).toBe(RECIPE_QUANTITY_RANGE.min);
    expect(result.value.coinCost).toBe(0);
    expect(result.value.levelRequired).toBe(RECIPE_LEVEL_RANGE.max);
  });
});

describe('relecture des matériaux', () => {
  // Les premiers seeds ont écrit une chaîne JSON là où les suivants stockent un tableau :
  // les deux formes cohabitent en base.
  test('lit aussi bien un tableau qu’une chaîne', () => {
    const expected = [{ itemName: 'Cuir', quantity: 2 }];
    expect(parseRecipeIngredients(expected)).toEqual(expected);
    expect(parseRecipeIngredients(JSON.stringify(expected))).toEqual(expected);
  });

  test('une colonne illisible ne fait pas tomber la lecture', () => {
    expect(parseRecipeIngredients('{pas du json')).toEqual([]);
    expect(parseRecipeIngredients(null)).toEqual([]);
    expect(parseRecipeIngredients(42)).toEqual([]);
  });

  test('écarte les lignes sans objet et borne les quantités', () => {
    expect(parseRecipeIngredients([{ itemName: '', quantity: 3 }, { itemName: 'Fer', quantity: 0 }]))
      .toEqual([{ itemName: 'Fer', quantity: RECIPE_QUANTITY_RANGE.min }]);
  });
});

describe('recette du serveur contre recette livrée', () => {
  const shipped = { guildId: null, resultItemId: 'epee' };
  const own = { guildId: 'serveur-a', resultItemId: 'epee' };
  const other = { guildId: null, resultItemId: 'bouclier' };

  // Sans ce départage, l'atelier affichait deux entrées pour la même arme, à des coûts
  // différents et sans rien pour dire laquelle compte.
  test('celle du serveur remplace la livrée pour le même objet', () => {
    expect(preferGuildRecipes([shipped, own, other])).toEqual([own, other]);
  });

  test('une recette livrée sans équivalent reste', () => {
    expect(preferGuildRecipes([shipped, other])).toEqual([shipped, other]);
  });

  test('deux recettes de serveur pour des objets différents cohabitent', () => {
    const second = { guildId: 'serveur-a', resultItemId: 'bouclier' };
    expect(preferGuildRecipes([own, second])).toEqual([own, second]);
  });
});
