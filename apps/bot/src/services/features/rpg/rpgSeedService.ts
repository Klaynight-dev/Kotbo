/**
 * Injection du catalogue par défaut (`rpgContent.ts`) en base.
 *
 * Le seed est *idempotent* et *incrémental* : chaque objet, monstre, événement et recette
 * est inséré uniquement s'il manque. C'est ce qui permet d'enrichir le contenu livré au fil
 * des versions sans écraser ce qu'un serveur a personnalisé, et sans dupliquer l'existant.
 *
 * Le tout est mémoïsé : ce contenu est global (`guildId: null`), une passe par process suffit.
 */

import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import {
  RPG_ADVENTURE_EVENTS,
  RPG_ITEMS,
  RPG_MONSTERS,
  RPG_RECIPES,
} from './rpgContent.js';

let seedPromise: Promise<void> | null = null;

/** Injecte le contenu par défaut manquant. Une seule exécution réelle par process. */
export function seedRpgContent(): Promise<void> {
  seedPromise ??= runSeed().catch((err) => {
    // On libère la mémoïsation pour laisser une chance au prochain appel après un incident.
    seedPromise = null;
    throw err;
  });
  return seedPromise;
}

/** Réservé aux tests : force la prochaine invocation à réexécuter le seed. */
export function resetRpgSeedCache(): void {
  seedPromise = null;
}

async function seedItems(): Promise<void> {
  const existing = await prisma.rpgItem.findMany({
    where: { guildId: null },
    select: { name: true },
  });
  const known = new Set(existing.map((item) => item.name));
  const missing = RPG_ITEMS.filter((item) => !known.has(item.name));
  if (missing.length === 0) return;

  await prisma.rpgItem.createMany({
    data: missing.map((item) => ({
      name: item.name,
      description: item.description,
      emoji: item.emoji,
      type: item.type,
      rarity: item.rarity,
      levelRequired: item.levelRequired ?? 0,
      atkBonus: item.atkBonus ?? 0,
      defBonus: item.defBonus ?? 0,
      spdBonus: item.spdBonus ?? 0,
      hpBonus: item.hpBonus ?? 0,
      hpRestore: item.hpRestore ?? 0,
      energyRestore: item.energyRestore ?? 0,
      enchantId: item.enchantId ?? null,
      enchantTier: item.enchantTier ?? 1,
      price: item.price,
      purchasable: item.purchasable,
    })),
    skipDuplicates: true,
  });

  logger.info('RpgSeed', `${missing.length} objet(s) RPG ajouté(s) au catalogue global.`);
}

async function seedMonsters(): Promise<void> {
  const existing = await prisma.rpgMonster.findMany({
    where: { guildId: null },
    select: { name: true },
  });
  const known = new Set(existing.map((monster) => monster.name));
  const missing = RPG_MONSTERS.filter((monster) => !known.has(monster.name));
  if (missing.length === 0) return;

  await prisma.rpgMonster.createMany({
    data: missing.map((monster) => ({
      name: monster.name,
      description: monster.description,
      emoji: monster.emoji,
      level: monster.level,
      health: monster.health,
      attack: monster.attack,
      defense: monster.defense,
      speed: monster.speed,
      xpReward: monster.xpReward,
      coinReward: monster.coinReward,
      // Stocké en tableau JSON natif (et non en chaîne) pour rester lisible et requêtable.
      drops: monster.drops,
      isBoss: monster.isBoss ?? false,
      bossRespawnHours: monster.bossRespawnHours ?? null,
    })),
    skipDuplicates: true,
  });

  logger.info('RpgSeed', `${missing.length} monstre(s) ajouté(s) au bestiaire global.`);
}

async function seedAdventureEvents(): Promise<void> {
  const existing = await prisma.rpgAdventureEvent.findMany({
    where: { guildId: null },
    select: { title: true },
  });
  const known = new Set(existing.map((event) => event.title));
  const missing = RPG_ADVENTURE_EVENTS.filter((event) => !known.has(event.title));
  if (missing.length === 0) return;

  await prisma.rpgAdventureEvent.createMany({
    data: missing.map((event) => ({
      title: event.title,
      description: event.description,
      emoji: event.emoji,
      choices: event.choices,
    })),
    skipDuplicates: true,
  });

  logger.info('RpgSeed', `${missing.length} événement(s) d'aventure ajouté(s).`);
}

async function seedRecipes(): Promise<void> {
  const globalItems = await prisma.rpgItem.findMany({
    where: { guildId: null },
    select: { id: true, name: true },
  });
  const itemIdByName = new Map(globalItems.map((item) => [item.name, item.id]));

  const existing = await prisma.rpgRecipe.findMany({
    where: { guildId: null },
    select: { resultItemId: true },
  });
  const known = new Set(existing.map((recipe) => recipe.resultItemId));

  const toCreate = RPG_RECIPES.flatMap((recipe) => {
    const resultItemId = itemIdByName.get(recipe.resultItemName);
    // Une recette dont le résultat n'existe pas est ignorée plutôt que de faire échouer
    // tout le seed : le test de cohérence du catalogue couvre déjà ce cas en amont.
    if (!resultItemId || known.has(resultItemId)) return [];
    return [{
      resultItemId,
      ingredients: recipe.ingredients,
      coinCost: recipe.coinCost,
      levelRequired: recipe.levelRequired,
    }];
  });

  if (toCreate.length === 0) return;

  await prisma.rpgRecipe.createMany({ data: toCreate, skipDuplicates: true });
  logger.info('RpgSeed', `${toCreate.length} recette(s) d'artisanat ajoutée(s).`);
}

async function runSeed(): Promise<void> {
  try {
    await seedItems();
    await seedMonsters();
    await seedAdventureEvents();
    // Les recettes référencent les objets : elles passent obligatoirement en dernier.
    await seedRecipes();
  } catch (err) {
    logger.error('RpgSeed', 'Échec du seed du contenu RPG par défaut:', err);
    throw err;
  }
}
