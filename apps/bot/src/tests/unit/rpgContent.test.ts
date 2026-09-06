import { describe, expect, test } from 'bun:test';
import {
  RPG_ADVENTURE_EVENTS,
  RPG_ITEMS,
  RPG_MONSTERS,
  RPG_RECIPES,
} from '../../services/features/rpg/rpgContent.js';
import { RPG_CLASS_LIST } from '../../services/features/rpg/rpgClasses.js';
import { RPG_ENCHANTMENTS, getEnchantment } from '../../services/features/rpg/rpgEnchantments.js';

const itemNames = new Set(RPG_ITEMS.map((item) => item.name));

describe('catalogue RPG par défaut', () => {
  test('les noms d objets sont uniques', () => {
    // La contrainte `@@unique([guildId, name])` et la résolution des drops/recettes par nom
    // rendent tout doublon fatal au seed.
    const duplicates = RPG_ITEMS
      .map((item) => item.name)
      .filter((name, index, all) => all.indexOf(name) !== index);

    expect(duplicates).toEqual([]);
  });

  test('les noms de monstres sont uniques', () => {
    const duplicates = RPG_MONSTERS
      .map((monster) => monster.name)
      .filter((name, index, all) => all.indexOf(name) !== index);

    expect(duplicates).toEqual([]);
  });

  test('chaque butin de monstre correspond à un objet existant', () => {
    const unknown = RPG_MONSTERS.flatMap((monster) =>
      monster.drops
        .filter((drop) => !itemNames.has(drop.itemName))
        .map((drop) => `${monster.name} → ${drop.itemName}`),
    );

    expect(unknown).toEqual([]);
  });

  test('chaque recette produit un objet existant à partir de matériaux existants', () => {
    const unknownResults = RPG_RECIPES
      .filter((recipe) => !itemNames.has(recipe.resultItemName))
      .map((recipe) => recipe.resultItemName);
    expect(unknownResults).toEqual([]);

    const unknownIngredients = RPG_RECIPES.flatMap((recipe) =>
      recipe.ingredients
        .filter((ingredient) => !itemNames.has(ingredient.itemName))
        .map((ingredient) => `${recipe.resultItemName} ← ${ingredient.itemName}`),
    );
    expect(unknownIngredients).toEqual([]);
  });

  test('chaque matériau de recette est réellement obtenable en combat', () => {
    // Une recette dont un ingrédient ne tombe d'aucun monstre serait définitivement
    // infaisable : c'est une impasse invisible pour le joueur.
    const droppable = new Set(RPG_MONSTERS.flatMap((monster) => monster.drops.map((drop) => drop.itemName)));
    const materialNames = new Set(RPG_ITEMS.filter((item) => item.type === 'MATERIAL').map((item) => item.name));

    const unobtainable = RPG_RECIPES.flatMap((recipe) =>
      recipe.ingredients
        .filter((ingredient) => materialNames.has(ingredient.itemName) && !droppable.has(ingredient.itemName))
        .map((ingredient) => `${recipe.resultItemName} ← ${ingredient.itemName}`),
    );

    expect(unobtainable).toEqual([]);
  });

  test('les objets fabriqués ne sont pas aussi vendus en boutique', () => {
    // Sinon l'artisanat n'a aucun intérêt : autant acheter directement le résultat.
    const craftedNames = new Set(RPG_RECIPES.map((recipe) => recipe.resultItemName));
    const alsoPurchasable = RPG_ITEMS
      .filter((item) => craftedNames.has(item.name) && item.purchasable)
      .map((item) => item.name);

    expect(alsoPurchasable).toEqual([]);
  });

  test('les matériaux ne sont jamais achetables', () => {
    const buyableMaterials = RPG_ITEMS
      .filter((item) => item.type === 'MATERIAL' && item.purchasable)
      .map((item) => item.name);

    expect(buyableMaterials).toEqual([]);
  });

  test('chaque événement d aventure propose au moins un choix accessible au niveau 1', () => {
    const blocked = RPG_ADVENTURE_EVENTS
      .filter((event) => !event.choices.some((choice) => choice.minLevel <= 1))
      .map((event) => event.title);

    expect(blocked).toEqual([]);
  });

  test('le catalogue couvre les trois emplacements et tous les paliers de rareté', () => {
    const types = new Set(RPG_ITEMS.map((item) => item.type));
    expect(types).toContain('WEAPON');
    expect(types).toContain('ARMOR');
    expect(types).toContain('ACCESSORY');
    expect(types).toContain('POTION');
    expect(types).toContain('MATERIAL');

    for (const rarity of ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY']) {
      expect(RPG_ITEMS.some((item) => item.rarity === rarity)).toBe(true);
    }
  });

  test('au moins un monstre est disponible pour chaque tranche de niveau jouable', () => {
    // `findRandomMonster` cherche dans [niveau-3, niveau+2] : un trou dans cette plage
    // renverrait le joueur sur le repli générique, ce qui casse la courbe de difficulté.
    const regular = RPG_MONSTERS.filter((monster) => !monster.isBoss);

    for (let level = 1; level <= 26; level++) {
      const inRange = regular.filter((monster) => monster.level >= level - 3 && monster.level <= level + 2);
      expect({ level, count: inRange.length }).toEqual({ level, count: inRange.length });
      expect(inRange.length).toBeGreaterThan(0);
    }
  });
});

describe('classes', () => {
  test('chaque classe débloque une compétence dès le niveau de déblocage', () => {
    for (const rpgClass of RPG_CLASS_LIST) {
      expect(rpgClass.skills.some((skill) => skill.levelRequired <= 5)).toBe(true);
    }
  });

  test('les identifiants de compétences sont uniques toutes classes confondues', () => {
    const ids = RPG_CLASS_LIST.flatMap((rpgClass) => rpgClass.skills.map((skill) => skill.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('parchemins d enchantement', () => {
  const scrolls = RPG_ITEMS.filter((item) => item.type === 'SCROLL');

  test('chaque parchemin désigne un enchantement du catalogue', () => {
    // Un parchemin dont l'identifiant ne résout pas est invisible à l'autel : il occupe une
    // place dans l'inventaire sans jamais rien pouvoir poser.
    const orphans = scrolls.filter((scroll) => !scroll.enchantId || !getEnchantment(scroll.enchantId));
    expect(orphans.map((scroll) => scroll.name)).toEqual([]);
  });

  test('aucun parchemin ne dépasse le palier maximum de son enchantement', () => {
    const tooHigh = scrolls.filter((scroll) => {
      const enchant = getEnchantment(scroll.enchantId ?? '');
      return enchant !== null && (scroll.enchantTier ?? 1) > enchant.maxTier;
    });

    expect(tooHigh.map((scroll) => scroll.name)).toEqual([]);
  });

  test('les parchemins ne sont pas achetables en boutique', () => {
    // Ils s'obtiennent par l'artisanat : les vendre au comptoir viderait le butin de son sens.
    expect(scrolls.filter((scroll) => scroll.purchasable)).toEqual([]);
  });

  test('chaque parchemin est fabricable', () => {
    // Sans recette, un parchemin ne peut entrer dans aucun inventaire.
    const craftable = new Set(RPG_RECIPES.map((recipe) => recipe.resultItemName));
    const unreachable = scrolls.filter((scroll) => !craftable.has(scroll.name));

    expect(unreachable.map((scroll) => scroll.name)).toEqual([]);
  });

  test('chaque enchantement du catalogue dispose d au moins un parchemin', () => {
    const posable = new Set(scrolls.map((scroll) => scroll.enchantId));
    const unreachable = RPG_ENCHANTMENTS.filter((enchant) => !posable.has(enchant.id));

    expect(unreachable.map((enchant) => enchant.id)).toEqual([]);
  });

  test('les identifiants d enchantement sont uniques', () => {
    const ids = RPG_ENCHANTMENTS.map((enchant) => enchant.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('chaque enchantement s applique à au moins un emplacement et a un effet', () => {
    for (const enchant of RPG_ENCHANTMENTS) {
      expect(enchant.slots.length).toBeGreaterThan(0);
      expect(enchant.maxTier).toBeGreaterThanOrEqual(1);
      // Un enchantement sans aucune valeur non nulle ne ferait strictement rien.
      expect(Object.values(enchant.perTier).some((value) => value !== 0)).toBe(true);
    }
  });
});
