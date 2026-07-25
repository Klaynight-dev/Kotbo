import type { RpgItem } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

// Cooldown tracker for in-memory message activity (to prevent spam farming)
const messageActivityCooldown = new Map<string, number>();

/**
 * Gets or creates the global/local economy configuration for a guild.
 */
export async function getOrCreateEconomyConfig(guildId: string) {
  let config = await prisma.economyConfig.findUnique({
    where: { guildId }
  });

  if (!config) {
    config = await prisma.economyConfig.create({
      data: {
        guildId,
        enabled: false,
        rpgEnabled: false,
        guildsEnabled: false,
        shopEnabled: false,
        currencyName: 'KotboCoins',
        currencyEmoji: '🪙',
        currencyIcon: null,
        dailyRewardMin: 50,
        dailyRewardMax: 150,
        dailyCooldownHour: 20,
        adventureCooldownMin: 30,
        maxEnergy: 100,
        energyRecoveryPerHour: 10,
        maxBetAmount: 1000,
        maxDailyBets: 20,
        maxTransferAmount: 5000,
        transferCooldownMin: 15
      }
    });
  }

  return config;
}

/**
 * Seeds default items and adventure events into the database if they do not exist.
 */
export async function seedDefaults() {
  try {
    // 1. Seed Global Items
    const itemCount = await prisma.rpgItem.count({
      where: { guildId: null }
    });

    if (itemCount === 0) {
      logger.info('EconomyService', 'Seeding default RPG items...');
      await prisma.rpgItem.createMany({
        data: [
          // Weapons
          { name: 'Épée en bois', description: 'Une simple épée taillée dans du bois.', emoji: '🪵', type: 'WEAPON', atkBonus: 2, price: 50, purchasable: true },
          { name: 'Dague en fer', description: 'Une lame en fer, aiguisée et maniable.', emoji: '🗡️', type: 'WEAPON', atkBonus: 5, price: 150, purchasable: true },
          { name: 'Excalibur', description: 'Une épée légendaire forgée dans des temps anciens.', emoji: '👑', type: 'WEAPON', atkBonus: 15, price: 500, purchasable: true },
          
          // Armor
          { name: 'Tunique en tissu', description: 'Vêtement de paysan léger et aéré.', emoji: '👕', type: 'ARMOR', defBonus: 1, price: 30, purchasable: true },
          { name: 'Cotte de mailles', description: 'Une armure métallique bruyante mais solide.', emoji: '🛡️', type: 'ARMOR', defBonus: 5, price: 200, purchasable: true },
          { name: "Armure d'Orichalque", description: "Armure légendaire faite d'un métal mythique.", emoji: '✨', type: 'ARMOR', defBonus: 12, price: 600, purchasable: true },
          
          // Potions
          { name: 'Potion de Vie Mineure', description: 'Restaure 20 points de vie.', emoji: '🧪', type: 'POTION', hpRestore: 20, price: 15, purchasable: true },
          { name: "Potion d'Énergie", description: "Restaure 30 points d'énergie.", emoji: '⚡', type: 'POTION', energyRestore: 30, price: 25, purchasable: true },
          { name: 'Élixir Divin', description: 'Restaure 50 PV et 50 Énergie.', emoji: '🍯', type: 'POTION', hpRestore: 50, energyRestore: 50, price: 75, purchasable: true }
        ]
      });
    }

    // 2. Seed Global Adventure Events
    const eventCount = await prisma.rpgAdventureEvent.count({
      where: { guildId: null }
    });

    if (eventCount === 0) {
      logger.info('EconomyService', 'Seeding default RPG adventure events...');
      await prisma.rpgAdventureEvent.createMany({
        data: [
          {
            title: 'Le Gobelin Malicieux',
            description: 'Un petit gobelin ricane sur le bord de la route et essaie de voler votre sac !',
            emoji: '👹',
            choices: [
              { text: "L'attraper par le col (Force)", hpEffect: -15, coinEffect: 40, xpEffect: 30, minLevel: 1 },
              { text: 'Négocier pacifiquement', hpEffect: 0, coinEffect: -20, xpEffect: 15, minLevel: 1 },
              { text: "L'ignorer et continuer", hpEffect: 0, coinEffect: 0, xpEffect: 5, minLevel: 1 }
            ]
          },
          {
            title: 'Le Sphinx Gardien',
            description: 'Un sphinx majestueux vous bloque le passage et vous soumet une énigme difficile.',
            emoji: '🦁',
            choices: [
              { text: "Tenter de résoudre l'énigme", hpEffect: -25, coinEffect: 120, xpEffect: 60, minLevel: 2 },
              { text: 'Fuir lâchement', hpEffect: 0, coinEffect: 0, xpEffect: 5, minLevel: 1 }
            ]
          },
          {
            title: 'La Source de Vie',
            description: "Vous découvrez une magnifique source d'eau chaude thermale cachée dans les bois.",
            emoji: '♨️',
            choices: [
              { text: 'Prendre un bain chaud relaxant', hpEffect: 40, coinEffect: 0, xpEffect: 10, minLevel: 1 },
              { text: "Remplir une fiole d'eau", hpEffect: 0, coinEffect: 15, xpEffect: 15, minLevel: 1 }
            ]
          },
          {
            title: 'Le Coffre Trésor',
            description: "Un coffre en bois renforcé de fer repose au pied d'un arbre séculaire.",
            emoji: '🪙',
            choices: [
              { text: 'Forcer la serrure rouillée', hpEffect: -10, coinEffect: 80, xpEffect: 20, minLevel: 1 },
              { text: 'Utiliser un sortilège simple', hpEffect: 0, coinEffect: 50, xpEffect: 35, minLevel: 1 }
            ]
          }
        ]
      });
    }
  } catch (err) {
    logger.error('EconomyService', 'Failed to seed default database records:', err);
  }
}

/**
 * Gets or creates the RPG and economy profile for a user.
 */
export async function getOrCreateRpgProfile(guildId: string, userId: string) {
  await seedDefaults(); // Make sure defaults are loaded

  let profile = await prisma.rpgProfile.findUnique({
    where: { guildId_userId: { guildId, userId } },
    include: {
      rpgGuild: true,
      inventory: {
        include: { item: true }
      }
    }
  });

  if (!profile) {
    profile = await prisma.rpgProfile.create({
      data: {
        guildId,
        userId,
        balance: 0,
        level: 1,
        xp: 0,
        health: 100,
        maxHealth: 100,
        energy: 100,
        attack: 10,
        defense: 10,
        speed: 10
      },
      include: {
        rpgGuild: true,
        inventory: {
          include: { item: true }
        }
      }
    });
  }

  // Auto recovery of health and energy based on time elapsed since the last energy tick.
  // NB: this uses a dedicated `lastEnergyTick` timestamp rather than `updatedAt`, because
  // `updatedAt` is bumped by any write to the row (pay, gambling, shop...) which would
  // otherwise silently reset the regen window and make energy appear to never recover.
  const now = Date.now();
  const lastTick = (profile.lastEnergyTick ?? profile.updatedAt).getTime();
  const diffHours = (now - lastTick) / (1000 * 60 * 60);

  // Defensive clamp: energy should never be negative (guarded atomically at the source now),
  // but repair any pre-existing corrupted rows so regen math behaves.
  const safeEnergy = Math.max(0, profile.energy);

  if (diffHours >= 0.1) {
    const config = await getOrCreateEconomyConfig(guildId);

    // Recover health (e.g. 5 HP per hour) and energy
    const hpToRecover = Math.floor(diffHours * 5);
    const energyToRecover = Math.floor(diffHours * config.energyRecoveryPerHour);

    if (hpToRecover > 0 || energyToRecover > 0 || safeEnergy !== profile.energy) {
      const newHp = Math.min(profile.maxHealth, profile.health + hpToRecover);
      const newEnergy = Math.min(config.maxEnergy, safeEnergy + energyToRecover);

      profile = await prisma.rpgProfile.update({
        where: { id: profile.id },
        data: {
          health: newHp,
          energy: newEnergy,
          lastEnergyTick: new Date(now)
        },
        include: {
          rpgGuild: true,
          inventory: {
            include: { item: true }
          }
        }
      });
    }
  }

  return profile;
}

/**
 * Handles activity balance and XP rewards on text message or vocal usage.
 */
export async function handleUserActivity(guildId: string, userId: string, type: 'text' | 'voice') {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.enabled) return;

  const key = `${guildId}:${userId}:${type}`;
  const now = Date.now();
  const lastReward = messageActivityCooldown.get(key) || 0;
  
  // Cooldown to avoid spam farming: 1 min for text, 2 min for voice gains
  const cooldownMs = type === 'text' ? 60000 : 120000;
  if (now - lastReward < cooldownMs) return;

  messageActivityCooldown.set(key, now);

  const amount = type === 'text' ? Math.floor(Math.random() * 4) + 1 : Math.floor(Math.random() * 8) + 3; // 1-4 coins for chat, 3-10 for voice
  const xpReward = type === 'text' ? 2 : 5;

  await prisma.rpgProfile.upsert({
    where: { guildId_userId: { guildId, userId } },
    update: {
      balance: { increment: amount },
      xp: { increment: xpReward }
    },
    create: {
      guildId,
      userId,
      balance: amount,
      xp: xpReward
    }
  });

  // Level Up Check
  await checkLevelUp(guildId, userId);
}

/**
 * Checks if a player has leveled up and updates their stats.
 */
export async function checkLevelUp(guildId: string, userId: string) {
  const profile = await prisma.rpgProfile.findUnique({
    where: { guildId_userId: { guildId, userId } }
  });

  if (!profile) return;

  // Formula: XP required for level N = 100 * N
  const xpNeeded = profile.level * 100;
  if (profile.xp >= xpNeeded) {
    const nextLevel = profile.level + 1;
    const statsIncrease = 2; // Increase ATK, DEF, SPD, Max HP on level up

    await prisma.rpgProfile.update({
      where: { id: profile.id },
      data: {
        level: nextLevel,
        xp: profile.xp - xpNeeded,
        maxHealth: profile.maxHealth + 10,
        health: profile.maxHealth + 10, // Full heal on level up
        attack: profile.attack + statsIncrease,
        defense: profile.defense + statsIncrease,
        speed: profile.speed + statsIncrease
      }
    });

    logger.info('EconomyService', `Player ${userId} leveled up to Level ${nextLevel} in Guild ${guildId}`);
    return nextLevel;
  }
  return null;
}

/**
 * Claims the daily KotboCoins reward.
 */
export async function claimDaily(guildId: string, userId: string) {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.enabled) throw new Error("Le module d'économie est désactivé sur ce serveur.");

  const profile = await getOrCreateRpgProfile(guildId, userId);
  const now = new Date();

  if (profile.lastDaily) {
    const cooldownMs = config.dailyCooldownHour * 60 * 60 * 1000;
    const diff = now.getTime() - profile.lastDaily.getTime();

    if (diff < cooldownMs) {
      const remainingMs = cooldownMs - diff;
      const hours = Math.floor(remainingMs / (1000 * 60 * 60));
      const minutes = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
      return {
        success: false,
        cooldown: true,
        remainingHours: hours,
        remainingMinutes: minutes
      };
    }
  }

  const reward = Math.floor(Math.random() * (config.dailyRewardMax - config.dailyRewardMin + 1)) + config.dailyRewardMin;

  await prisma.rpgProfile.update({
    where: { id: profile.id },
    data: {
      balance: { increment: reward },
      lastDaily: now
    }
  });

  return {
    success: true,
    cooldown: false,
    reward,
    newBalance: profile.balance + reward
  };
}

/**
 * Initiates a travel adventure.
 */
export async function startTravel(guildId: string, userId: string, destination: string, durationMin: number) {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.rpgEnabled) throw new Error("Le module RPG d'aventures est désactivé.");

  const profile = await getOrCreateRpgProfile(guildId, userId);
  if (profile.isTraveling) throw new Error('Vous êtes déjà en cours de voyage !');
  if (profile.health <= 0) throw new Error("Vous n'avez plus de PV (0 PV). Prenez des potions ou attendez de vous reposer pour regagner des forces.");
  if (profile.energy < 20) throw new Error("Vous n'avez pas assez d'énergie (requis: 20 énergie). Restez inactif pour regagner de l'énergie.");

  if (profile.lastTravelEndedAt) {
    const cooldownMs = config.adventureCooldownMin * 60 * 1000;
    const diff = Date.now() - profile.lastTravelEndedAt.getTime();
    if (diff < cooldownMs) {
      const remainingMin = Math.ceil((cooldownMs - diff) / (1000 * 60));
      throw new Error(`Vous devez attendre encore ${remainingMin} minute(s) avant de repartir à l'aventure.`);
    }
  }

  // Atomic guard: only decrement energy if the row still has enough at write time,
  // so two near-simultaneous energy-consuming actions can't both pass a stale check
  // and push energy below zero.
  const result = await prisma.rpgProfile.updateMany({
    where: { id: profile.id, energy: { gte: 20 }, isTraveling: false },
    data: {
      isTraveling: true,
      travelDestination: destination,
      travelDurationMin: durationMin,
      travelStartedAt: new Date(),
      energy: { decrement: 20 }
    }
  });

  if (result.count === 0) {
    throw new Error("Vous n'avez pas assez d'énergie ou un voyage est déjà en cours.");
  }

  return {
    destination,
    durationMin
  };
}

/**
 * Resolves a travel event for a user. Returns a random adventure event if travel is complete.
 */
export async function resolveTravel(guildId: string, userId: string) {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.rpgEnabled) throw new Error("Le module RPG d'aventures est désactivé.");

  const profile = await getOrCreateRpgProfile(guildId, userId);
  if (!profile.isTraveling) throw new Error("Vous n'êtes pas en voyage actuellement.");

  const now = Date.now();
  const start = profile.travelStartedAt ? profile.travelStartedAt.getTime() : 0;
  const elapsedMin = (now - start) / (1000 * 60);

  if (elapsedMin < profile.travelDurationMin) {
    const remainingMin = Math.ceil(profile.travelDurationMin - elapsedMin);
    return {
      complete: false,
      remainingMinutes: remainingMin
    };
  }

  // Travel complete! Fetch a random event
  const events = await prisma.rpgAdventureEvent.findMany({
    where: {
      OR: [
        { guildId: null },
        { guildId }
      ]
    }
  });

  if (events.length === 0) {
    // End travel peacefully if no events configured
    await prisma.rpgProfile.update({
      where: { id: profile.id },
      data: {
        isTraveling: false,
        travelDestination: null,
        travelDurationMin: 0,
        travelStartedAt: null,
        lastTravelEndedAt: new Date()
      }
    });

    return {
      complete: true,
      noEvent: true
    };
  }

  const randomEvent = events[Math.floor(Math.random() * events.length)];

  // Save the state in metadata or cache so we know which event is active for choice verification
  await prisma.rpgProfile.update({
    where: { id: profile.id },
    data: {
      lastEventAt: new Date()
    }
  });

  return {
    complete: true,
    noEvent: false,
    event: randomEvent
  };
}

/**
 * Submits a choice for the active travel event and applies consequences.
 */
export async function chooseAdventureOutcome(guildId: string, userId: string, eventId: string, choiceIndex: number) {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.rpgEnabled) throw new Error("Le module RPG d'aventures est désactivé.");

  const profile = await getOrCreateRpgProfile(guildId, userId);
  if (!profile.isTraveling) throw new Error("Vous n'êtes pas en voyage.");

  const event = await prisma.rpgAdventureEvent.findUnique({
    where: { id: eventId }
  });

  if (!event) throw new Error('Événement introuvable.');

  // Colonne JSON : forme des choix proposes par un evenement d'aventure.
  type AdventureChoice = {
    text?: string;
    minLevel?: number;
    hpEffect?: number;
    coinEffect?: number;
    xpEffect?: number;
  };
  const choices = (event.choices ?? []) as AdventureChoice[];
  const choice = choices[choiceIndex];

  if (!choice) throw new Error('Choix invalide.');

  // Validate Level Requirement
  if (choice.minLevel && profile.level < choice.minLevel) {
    throw new Error(`Ce choix requiert le niveau ${choice.minLevel}. Vous êtes niveau ${profile.level}.`);
  }

  // Apply consequences. Add modifiers based on ATK, DEF, SPD depending on event choices
  let finalHpEffect = choice.hpEffect || 0;
  let finalCoinEffect = choice.coinEffect || 0;
  let finalXpEffect = choice.xpEffect || 0;

  // Add RNG scaling: 25% chance of critical success (extra coins/xp) or critical failure (more hp loss)
  const rng = Math.random();
  let criticalMessage = '';
  if (rng < 0.2 && finalHpEffect < 0) {
    finalHpEffect = Math.floor(finalHpEffect * 1.5);
    criticalMessage = "💥 Échec critique ! L'issue a été plus douloureuse que prévu...";
  } else if (rng > 0.8 && (finalCoinEffect > 0 || finalXpEffect > 0)) {
    finalCoinEffect = Math.floor(finalCoinEffect * 1.5);
    finalXpEffect = Math.floor(finalXpEffect * 1.5);
    criticalMessage = '🌟 Réussite critique ! Vous avez tiré le meilleur parti de cette situation !';
  }

  // Update Profile Stats
  const newHp = Math.max(0, Math.min(profile.maxHealth, profile.health + finalHpEffect));
  const newBalance = Math.max(0, profile.balance + finalCoinEffect);
  const newXp = Math.max(0, profile.xp + finalXpEffect);

  await prisma.rpgProfile.update({
    where: { id: profile.id },
    data: {
      health: newHp,
      balance: newBalance,
      xp: newXp,
      isTraveling: false, // End travel on resolution
      travelDestination: null,
      travelDurationMin: 0,
      travelStartedAt: null,
      lastEventAt: null,
      lastTravelEndedAt: new Date()
    }
  });

  const levelUp = await checkLevelUp(guildId, userId);

  return {
    choiceText: choice.text,
    hpEffect: finalHpEffect,
    coinEffect: finalCoinEffect,
    xpEffect: finalXpEffect,
    newHp,
    newBalance,
    newXp,
    criticalMessage,
    levelUp
  };
}

/**
 * Purchases an item from the shop.
 */
export async function buyShopItem(guildId: string, userId: string, itemId: string) {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.shopEnabled) throw new Error('La boutique RPG est désactivée.');

  const profile = await getOrCreateRpgProfile(guildId, userId);
  const item = await prisma.rpgItem.findUnique({
    where: { id: itemId }
  });

  if (!item || (!item.purchasable && item.guildId !== guildId)) {
    throw new Error("Objet introuvable ou indisponible à l'achat.");
  }

  if (profile.balance < item.price) {
    throw new Error(`Vous n'avez pas assez de KotboCoins (requis: ${item.price} 🪙).`);
  }

  // Deduct balance and add to inventory
  await prisma.$transaction([
    prisma.rpgProfile.update({
      where: { id: profile.id },
      data: { balance: { decrement: item.price } }
    }),
    prisma.rpgInventoryItem.upsert({
      where: {
        rpgProfileId_itemId: {
          rpgProfileId: profile.id,
          itemId: item.id
        }
      },
      update: {
        quantity: { increment: 1 }
      },
      create: {
        rpgProfileId: profile.id,
        itemId: item.id,
        quantity: 1
      }
    })
  ]);

  return {
    itemName: item.name,
    price: item.price,
    newBalance: profile.balance - item.price
  };
}

/**
 * Equips a Weapon or Armor from inventory.
 */
export async function equipInventoryItem(guildId: string, userId: string, itemId: string) {
  const profile = await getOrCreateRpgProfile(guildId, userId);

  const inventoryEntry = await prisma.rpgInventoryItem.findUnique({
    where: {
      rpgProfileId_itemId: {
        rpgProfileId: profile.id,
        itemId
      }
    },
    include: { item: true }
  });

  if (!inventoryEntry || inventoryEntry.quantity <= 0) {
    throw new Error('Vous ne possédez pas cet objet dans votre inventaire.');
  }

  const item = inventoryEntry.item;
  const updateData: Record<string, unknown> = {};

  if (item.type === 'WEAPON') {
    updateData.weaponId = item.id;
  } else if (item.type === 'ARMOR') {
    updateData.armorId = item.id;
  } else {
    throw new Error('Seules les armes et les armures peuvent être équipées.');
  }

  // Recalculate stats based on equipment change
  // Deduct old item bonuses, add new ones
  let oldItem: RpgItem | null = null;
  if (item.type === 'WEAPON' && profile.weaponId) {
    oldItem = await prisma.rpgItem.findUnique({ where: { id: profile.weaponId } });
  } else if (item.type === 'ARMOR' && profile.armorId) {
    oldItem = await prisma.rpgItem.findUnique({ where: { id: profile.armorId } });
  }

  const oldAtkBonus = oldItem?.atkBonus || 0;
  const oldDefBonus = oldItem?.defBonus || 0;
  const oldSpdBonus = oldItem?.spdBonus || 0;

  await prisma.rpgProfile.update({
    where: { id: profile.id },
    data: {
      ...updateData,
      attack: { increment: item.atkBonus - oldAtkBonus },
      defense: { increment: item.defBonus - oldDefBonus },
      speed: { increment: item.spdBonus - oldSpdBonus }
    }
  });

  return {
    itemName: item.name,
    type: item.type
  };
}

/**
 * Consumes a Potion from inventory.
 */
export async function consumePotionItem(guildId: string, userId: string, itemId: string) {
  const profile = await getOrCreateRpgProfile(guildId, userId);

  const inventoryEntry = await prisma.rpgInventoryItem.findUnique({
    where: {
      rpgProfileId_itemId: {
        rpgProfileId: profile.id,
        itemId
      }
    },
    include: { item: true }
  });

  if (!inventoryEntry || inventoryEntry.quantity <= 0) {
    throw new Error('Vous ne possédez pas cette potion.');
  }

  const item = inventoryEntry.item;
  if (item.type !== 'POTION') throw new Error("Cet objet n'est pas consommable.");

  const restoredHp = item.hpRestore || 0;
  const restoredEnergy = item.energyRestore || 0;

  const config = await getOrCreateEconomyConfig(guildId);
  const newHp = Math.min(profile.maxHealth, profile.health + restoredHp);
  const newEnergy = Math.min(config.maxEnergy, profile.energy + restoredEnergy);

  // Consume logic: decrease quantity (delete if 0) and restore stats
  await prisma.$transaction([
    inventoryEntry.quantity > 1
      ? prisma.rpgInventoryItem.update({
          where: { id: inventoryEntry.id },
          data: { quantity: { decrement: 1 } }
        })
      : prisma.rpgInventoryItem.delete({
          where: { id: inventoryEntry.id }
        }),
    prisma.rpgProfile.update({
      where: { id: profile.id },
      data: {
        health: newHp,
        energy: newEnergy
      }
    })
  ]);

  return {
    itemName: item.name,
    restoredHp,
    restoredEnergy,
    newHp,
    newEnergy
  };
}

/**
 * Creates an RPG Guild.
 */
export async function createRpgGuild(guildId: string, userId: string, name: string, description?: string) {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.guildsEnabled) throw new Error('Le système de guildes RPG est désactivé.');

  const profile = await getOrCreateRpgProfile(guildId, userId);
  if (profile.rpgGuildId) throw new Error("Vous faites déjà partie d'une guilde !");

  // Creation costs 500 KotboCoins
  if (profile.balance < 500) {
    throw new Error('Créer une guilde requiert 500 KotboCoins.');
  }

  const rpgGuild = await prisma.rpgGuild.create({
    data: {
      guildId,
      name,
      description,
      ownerId: userId
    }
  });

  await prisma.rpgProfile.update({
    where: { id: profile.id },
    data: {
      rpgGuildId: rpgGuild.id,
      balance: { decrement: 500 }
    }
  });

  return rpgGuild;
}

/**
 * Joins an RPG Guild.
 */
export async function joinRpgGuild(guildId: string, userId: string, rpgGuildId: string) {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.guildsEnabled) throw new Error('Le système de guildes RPG est désactivé.');

  const profile = await getOrCreateRpgProfile(guildId, userId);
  if (profile.rpgGuildId) throw new Error("Vous devez d'abord quitter votre guilde actuelle.");

  const targetGuild = await prisma.rpgGuild.findUnique({
    where: { id: rpgGuildId },
    include: { _count: { select: { members: true } } }
  });

  if (!targetGuild || targetGuild.guildId !== guildId) {
    throw new Error('Guilde introuvable.');
  }

  // Guild member limit: 10 members + 2 per guild level
  const maxMembers = 10 + targetGuild.level * 2;
  if (targetGuild._count.members >= maxMembers) {
    throw new Error('Cette guilde est complète !');
  }

  await prisma.rpgProfile.update({
    where: { id: profile.id },
    data: {
      rpgGuildId: targetGuild.id
    }
  });

  return targetGuild;
}

/**
 * Leaves the current RPG Guild.
 */
export async function leaveRpgGuild(guildId: string, userId: string) {
  const profile = await getOrCreateRpgProfile(guildId, userId);
  if (!profile.rpgGuildId) throw new Error("Vous n'êtes dans aucune guilde.");

  const rpgGuild = await prisma.rpgGuild.findUnique({
    where: { id: profile.rpgGuildId },
    include: { members: true }
  });

  if (!rpgGuild) throw new Error('Guilde introuvable.');

  if (rpgGuild.ownerId === userId) {
    // If owner leaves, pick another owner or dissolve
    const otherMembers = rpgGuild.members.filter((m: { userId: string }) => m.userId !== userId);
    if (otherMembers.length > 0) {
      await prisma.rpgGuild.update({
        where: { id: rpgGuild.id },
        data: { ownerId: otherMembers[0].userId }
      });
    } else {
      // Dissolve guild
      await prisma.rpgGuild.delete({
        where: { id: rpgGuild.id }
      });
      
      await prisma.rpgProfile.update({
        where: { id: profile.id },
        data: { rpgGuildId: null }
      });

      return { dissolved: true };
    }
  }

  await prisma.rpgProfile.update({
    where: { id: profile.id },
    data: { rpgGuildId: null }
  });

  return { dissolved: false, guildName: rpgGuild.name };
}

/**
 * Deposits KotboCoins into the RPG Guild treasury.
 */
export async function depositToRpgGuildTreasury(guildId: string, userId: string, amount: number) {
  if (amount <= 0) throw new Error('Montant invalide.');

  const profile = await getOrCreateRpgProfile(guildId, userId);
  if (!profile.rpgGuildId) throw new Error('Vous devez appartenir à une guilde pour donner au trésor.');

  if (profile.balance < amount) {
    throw new Error('Solde de KotboCoins insuffisant.');
  }

  // Guild level up logic based on treasury contributions: 1 XP per coin deposited
  const rpgGuild = await prisma.rpgGuild.findUnique({
    where: { id: profile.rpgGuildId }
  });

  if (!rpgGuild) throw new Error('Guilde introuvable.');

  const newXp = rpgGuild.xp + amount;
  const xpNeeded = rpgGuild.level * 1000;
  let nextLevel = rpgGuild.level;
  let finalXp = newXp;

  if (newXp >= xpNeeded) {
    nextLevel += 1;
    finalXp = newXp - xpNeeded;
  }

  await prisma.$transaction([
    prisma.rpgProfile.update({
      where: { id: profile.id },
      data: { balance: { decrement: amount } }
    }),
    prisma.rpgGuild.update({
      where: { id: rpgGuild.id },
      data: {
        treasury: { increment: amount },
        xp: finalXp,
        level: nextLevel
      }
    })
  ]);

  return {
    amount,
    levelUp: nextLevel > rpgGuild.level ? nextLevel : null
  };
}

/**
 * Revend un objet de l'inventaire à la boutique à 50% de son prix d'achat.
 */
export async function sellShopItem(guildId: string, userId: string, itemId: string) {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.shopEnabled) throw new Error('La boutique RPG est désactivée.');

  const profile = await getOrCreateRpgProfile(guildId, userId);
  const inventoryEntry = await prisma.rpgInventoryItem.findUnique({
    where: {
      rpgProfileId_itemId: {
        rpgProfileId: profile.id,
        itemId
      }
    },
    include: { item: true }
  });

  if (!inventoryEntry || inventoryEntry.quantity <= 0) {
    throw new Error('Vous ne possédez pas cet objet dans votre inventaire.');
  }

  const item = inventoryEntry.item;
  if (profile.weaponId === item.id || profile.armorId === item.id) {
    throw new Error(`Vous ne pouvez pas vendre un objet équipé. Déséquipez d'abord cet objet via \`/rpg-inventory\`.`);
  }

  const sellPrice = Math.floor(item.price * 0.5);

  await prisma.$transaction([
    inventoryEntry.quantity > 1
      ? prisma.rpgInventoryItem.update({
          where: { id: inventoryEntry.id },
          data: { quantity: { decrement: 1 } }
        })
      : prisma.rpgInventoryItem.delete({
          where: { id: inventoryEntry.id }
        }),
    prisma.rpgProfile.update({
      where: { id: profile.id },
      data: { balance: { increment: sellPrice } }
    })
  ]);

  return {
    itemName: item.name,
    sellPrice,
    newBalance: profile.balance + sellPrice
  };
}

/**
 * Réinitialise certains éléments ou toute l'économie RPG pour une guilde.
 */
export async function adminResetGuildEconomy(guildId: string, component: 'all' | 'profiles' | 'items' | 'config' | 'guilds') {
  if (component === 'config' || component === 'all') {
    await prisma.economyConfig.deleteMany({
      where: { guildId }
    });
  }

  if (component === 'items' || component === 'all') {
    await prisma.rpgItem.deleteMany({
      where: { guildId }
    });
  }

  if (component === 'guilds' || component === 'all') {
    await prisma.rpgGuild.deleteMany({
      where: { guildId }
    });
  }

  if (component === 'profiles' || component === 'all') {
    await prisma.rpgInventoryItem.deleteMany({
      where: { profile: { guildId } }
    });
    await prisma.rpgProfile.deleteMany({
      where: { guildId }
    });
  }

  if (component === 'config' || component === 'all') {
    await getOrCreateEconomyConfig(guildId);
  }

  return { success: true };
}

/**
 * Permet aux admins de modifier manuellement les caractéristiques d'un joueur.
 */
export async function adminSetStats(guildId: string, userId: string, stats: {
  balance?: number;
  level?: number;
  xp?: number;
  health?: number;
  energy?: number;
  attack?: number;
  defense?: number;
  speed?: number;
}) {
  const profile = await getOrCreateRpgProfile(guildId, userId);

  const data: Record<string, number> = {};
  if (stats.balance !== undefined) data.balance = stats.balance;
  if (stats.level !== undefined) data.level = stats.level;
  if (stats.xp !== undefined) data.xp = stats.xp;
  if (stats.health !== undefined) data.health = stats.health;
  if (stats.energy !== undefined) data.energy = stats.energy;
  if (stats.attack !== undefined) data.attack = stats.attack;
  if (stats.defense !== undefined) data.defense = stats.defense;
  if (stats.speed !== undefined) data.speed = stats.speed;

  const updated = await prisma.rpgProfile.update({
    where: { id: profile.id },
    data,
    include: {
      rpgGuild: true,
      inventory: { include: { item: true } }
    }
  });

  return updated;
}

/**
 * Travaille pour gagner des pièces et de l'expérience (cooldown d'une heure).
 */
export async function work(guildId: string, userId: string) {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.enabled) throw new Error("Le module d'économie est désactivé sur ce serveur.");

  const profile = await getOrCreateRpgProfile(guildId, userId);
  const now = new Date();

  if (profile.lastWork) {
    const cooldownMs = 60 * 60 * 1000; // 1 heure
    const diff = now.getTime() - profile.lastWork.getTime();

    if (diff < cooldownMs) {
      const remainingMs = cooldownMs - diff;
      const minutes = Math.floor(remainingMs / (1000 * 60));
      const seconds = Math.floor((remainingMs % (1000 * 60)) / 1000);
      return {
        success: false,
        cooldown: true,
        remainingMinutes: minutes,
        remainingSeconds: seconds
      };
    }
  }

  // Salaire de base : 50 pièces + 10 par niveau RPG + random(0, 50)
  const salary = 50 + profile.level * 10 + Math.floor(Math.random() * 50);
  const xpReward = 15;

  await prisma.rpgProfile.update({
    where: { id: profile.id },
    data: {
      balance: { increment: salary },
      xp: { increment: xpReward },
      lastWork: now
    }
  });

  const levelUp = await checkLevelUp(guildId, userId);

  return {
    success: true,
    cooldown: false,
    salary,
    xpReward,
    newBalance: profile.balance + salary,
    levelUp
  };
}

/**
 * Transfère des pièces d'un membre à un autre.
 */
export async function transferCoins(guildId: string, senderId: string, receiverId: string, amount: number) {
  if (amount <= 0) throw new Error("Le montant doit être supérieur à 0.");
  if (senderId === receiverId) throw new Error("Vous ne pouvez pas vous envoyer des pièces à vous-même.");

  const config = await getOrCreateEconomyConfig(guildId);
  if (amount > config.maxTransferAmount) {
    throw new Error(`Le montant maximal autorisé par transfert est de **${config.maxTransferAmount}** ${config.currencyEmoji}.`);
  }

  const senderProfile = await getOrCreateRpgProfile(guildId, senderId);
  if (senderProfile.balance < amount) {
    throw new Error(`Solde insuffisant. Vous possédez actuellement **${senderProfile.balance}** pièces.`);
  }

  if (senderProfile.lastTransferAt) {
    const cooldownMs = config.transferCooldownMin * 60 * 1000;
    const diff = Date.now() - senderProfile.lastTransferAt.getTime();
    if (diff < cooldownMs) {
      const remainingMin = Math.ceil((cooldownMs - diff) / (1000 * 60));
      throw new Error(`Vous devez attendre encore ${remainingMin} minute(s) avant de faire un nouveau transfert.`);
    }
  }

  const receiverProfile = await getOrCreateRpgProfile(guildId, receiverId);

  // Atomic guard on the balance check to avoid a race between two concurrent transfers
  // from the same sender both passing the balance check above against a stale value.
  const now = new Date();
  const debited = await prisma.rpgProfile.updateMany({
    where: { id: senderProfile.id, balance: { gte: amount } },
    data: { balance: { decrement: amount }, lastTransferAt: now }
  });

  if (debited.count === 0) {
    throw new Error(`Solde insuffisant. Vous possédez actuellement **${senderProfile.balance}** pièces.`);
  }

  await prisma.rpgProfile.update({
    where: { id: receiverProfile.id },
    data: { balance: { increment: amount } }
  });

  return {
    senderBalance: senderProfile.balance - amount,
    receiverBalance: receiverProfile.balance + amount
  };
}

/**
 * Enregistre une tentative de mise à un jeu d'argent (dice/roulette/rps) et applique
 * les garde-fous anti-abus : plafond de mise et nombre de parties par jour (fenêtre glissante 24h).
 * Doit être appelé avant de débiter/créditer la mise.
 */
export async function registerGambleAttempt(guildId: string, userId: string, betAmount: number) {
  const config = await getOrCreateEconomyConfig(guildId);

  if (betAmount > config.maxBetAmount) {
    throw new Error(`La mise maximale autorisée est de **${config.maxBetAmount}** ${config.currencyEmoji}.`);
  }

  const profile = await getOrCreateRpgProfile(guildId, userId);
  const now = new Date();
  const windowExpired = !profile.dailyBetWindowStart || (now.getTime() - profile.dailyBetWindowStart.getTime()) >= 24 * 60 * 60 * 1000;
  const currentCount = windowExpired ? 0 : profile.dailyBetCount;

  if (currentCount >= config.maxDailyBets) {
    throw new Error(`Vous avez atteint la limite de **${config.maxDailyBets}** parties de jeux d'argent par jour. Réessayez plus tard.`);
  }

  await prisma.rpgProfile.update({
    where: { id: profile.id },
    data: {
      dailyBetCount: currentCount + 1,
      dailyBetWindowStart: windowExpired ? now : profile.dailyBetWindowStart
    }
  });

  return profile;
}

/**
 * Donne un objet de son inventaire à un autre membre.
 */
export async function giveInventoryItem(guildId: string, senderId: string, receiverId: string, itemId: string, quantity: number) {
  if (quantity <= 0) throw new Error("La quantité doit être supérieure à 0.");
  if (senderId === receiverId) throw new Error("Vous ne pouvez pas vous donner un objet à vous-même.");

  const senderProfile = await getOrCreateRpgProfile(guildId, senderId);
  const receiverProfile = await getOrCreateRpgProfile(guildId, receiverId);

  const senderEntry = senderProfile.inventory.find((e: { itemId: string; quantity: number }) => e.itemId === itemId);
  if (!senderEntry || senderEntry.quantity < quantity) {
    throw new Error("Vous ne possédez pas cet objet en quantité suffisante dans votre inventaire.");
  }

  const item = senderEntry.item;
  const isEquipped = senderProfile.weaponId === itemId || senderProfile.armorId === itemId;
  if (isEquipped && senderEntry.quantity - quantity <= 0) {
    throw new Error(`Cet objet est actuellement équipé. Déséquipez-le via \`/use\` avant de pouvoir le donner.`);
  }

  // Update inventories
  await prisma.$transaction([
    // Deduct from sender
    senderEntry.quantity > quantity
      ? prisma.rpgInventoryItem.update({
          where: { id: senderEntry.id },
          data: { quantity: { decrement: quantity } }
        })
      : prisma.rpgInventoryItem.delete({
          where: { id: senderEntry.id }
        }),
    // Add to receiver
    prisma.rpgInventoryItem.upsert({
      where: {
        rpgProfileId_itemId: {
          rpgProfileId: receiverProfile.id,
          itemId
        }
      },
      update: {
        quantity: { increment: quantity }
      },
      create: {
        rpgProfileId: receiverProfile.id,
        itemId,
        quantity
      }
    })
  ]);

  return {
    itemName: item.name,
    itemEmoji: item.emoji
  };
}

/**
 * Retire des pièces à un membre. (Admin)
 */
export async function adminRemoveCoins(guildId: string, userId: string, amount: number) {
  if (amount <= 0) throw new Error("Le montant doit être supérieur à 0.");

  const profile = await getOrCreateRpgProfile(guildId, userId);
  const newBalance = Math.max(0, profile.balance - amount);

  await prisma.rpgProfile.update({
    where: { id: profile.id },
    data: { balance: newBalance }
  });

  return {
    newBalance
  };
}

/**
 * Supprime un objet de la boutique (Admin) en retirant au préalable son équipement et ses
 * bonus de statistiques de tous les profils qui l'ont actuellement équipé.
 *
 * `weaponId`/`armorId` sont de simples champs texte (pas de relation Prisma), donc la
 * suppression de l'objet ne les nettoie jamais automatiquement : sans ce traitement, un
 * joueur garde indéfiniment les bonus ATK/DEF/SPD d'un objet qui n'existe plus.
 */
export async function adminDeleteShopItem(guildId: string, itemId: string) {
  const item = await prisma.rpgItem.findUnique({ where: { id: itemId } });
  if (!item) throw new Error('Objet introuvable.');
  if (item.guildId !== guildId) {
    throw new Error('Vous ne pouvez supprimer que les objets spécifiques à votre serveur.');
  }

  const equippedProfiles = await prisma.rpgProfile.findMany({
    where: { OR: [{ weaponId: itemId }, { armorId: itemId }] }
  });

  await prisma.$transaction([
    ...equippedProfiles.map(p => prisma.rpgProfile.update({
      where: { id: p.id },
      data: {
        weaponId: p.weaponId === itemId ? null : undefined,
        armorId: p.armorId === itemId ? null : undefined,
        attack: { decrement: item.atkBonus },
        defense: { decrement: item.defBonus },
        speed: { decrement: item.spdBonus }
      }
    })),
    prisma.rpgItem.delete({ where: { id: itemId } })
  ]);

  return { item, unequippedCount: equippedProfiles.length };
}

/**
 * Fait apparaître un objet dans l'inventaire d'un joueur. (Admin)
 */
export async function adminSpawnItem(guildId: string, userId: string, itemId: string, quantity: number) {
  if (quantity <= 0) throw new Error("La quantité doit être supérieure à 0.");

  const profile = await getOrCreateRpgProfile(guildId, userId);
  const item = await prisma.rpgItem.findUnique({
    where: { id: itemId }
  });

  if (!item) throw new Error("Objet introuvable.");

  await prisma.rpgInventoryItem.upsert({
    where: {
      rpgProfileId_itemId: {
        rpgProfileId: profile.id,
        itemId
      }
    },
    update: {
      quantity: { increment: quantity }
    },
    create: {
      rpgProfileId: profile.id,
      itemId,
      quantity
    }
  });

  return {
    itemName: item.name,
    itemEmoji: item.emoji
  };
}

/**
 * Retire un objet de l'inventaire d'un joueur. (Admin)
 */
export async function adminRemoveItem(guildId: string, userId: string, itemId: string, quantity: number) {
  if (quantity <= 0) throw new Error("La quantité doit être supérieure à 0.");

  const profile = await getOrCreateRpgProfile(guildId, userId);
  const inventoryEntry = await prisma.rpgInventoryItem.findUnique({
    where: {
      rpgProfileId_itemId: {
        rpgProfileId: profile.id,
        itemId
      }
    },
    include: { item: true }
  });

  if (!inventoryEntry || inventoryEntry.quantity <= 0) {
    throw new Error("Ce joueur ne possède pas cet objet.");
  }

  const actualRemoveQty = Math.min(inventoryEntry.quantity, quantity);
  const remainingQty = inventoryEntry.quantity - actualRemoveQty;

  const item = inventoryEntry.item;
  const isEquipped = profile.weaponId === itemId || profile.armorId === itemId;

  const updates: unknown[] = [];

  if (remainingQty > 0) {
    updates.push(
      prisma.rpgInventoryItem.update({
        where: { id: inventoryEntry.id },
        data: { quantity: remainingQty }
      })
    );
  } else {
    updates.push(
      prisma.rpgInventoryItem.delete({
        where: { id: inventoryEntry.id }
      })
    );

    // Unequip if it was equipped and is now completely removed.
    // Stat bonuses (ATK/DEF/SPD) are all applied together on equip regardless of slot
    // (see equipInventoryItem), so all three must be reverted together here too.
    if (isEquipped) {
      const updateData: Record<string, unknown> = {
        attack: { increment: -item.atkBonus },
        defense: { increment: -item.defBonus },
        speed: { increment: -item.spdBonus }
      };
      if (profile.weaponId === itemId) {
        updateData.weaponId = null;
      } else if (profile.armorId === itemId) {
        updateData.armorId = null;
      }
      updates.push(
        prisma.rpgProfile.update({
          where: { id: profile.id },
          data: updateData
        })
      );
    }
  }

  await prisma.$transaction(updates);

  return {
    itemName: item.name,
    itemEmoji: item.emoji,
    removedQuantity: actualRemoveQty,
    remainingQuantity: remainingQty
  };
}

/**
 * Obtient les joueurs les plus riches du serveur.
 */
export async function getRichestPlayers(guildId: string, limit = 10) {
  const richest = await prisma.rpgProfile.findMany({
    where: { guildId },
    orderBy: { balance: 'desc' },
    take: limit
  });
  return richest;
}

// ============================================================================
// PÊCHE
// ============================================================================

type FishEntry = {
  name: string;
  emoji: string;
  rarity: string;
  value: number;
  xp: number;
};

const FISH_TABLE: { weight: number; rarity: string; fish: Omit<FishEntry, 'rarity'>[] }[] = [
  { weight: 60, rarity: 'COMMON', fish: [
    { name: 'Sardine', emoji: '🐟', value: 5, xp: 5 },
    { name: 'Truite', emoji: '🐟', value: 8, xp: 5 },
    { name: 'Maquereau', emoji: '🐟', value: 6, xp: 5 },
    { name: 'Perche', emoji: '🐟', value: 7, xp: 5 },
  ]},
  { weight: 25, rarity: 'UNCOMMON', fish: [
    { name: 'Saumon', emoji: '🐠', value: 15, xp: 8 },
    { name: 'Thon', emoji: '🐠', value: 20, xp: 8 },
    { name: 'Espadon', emoji: '🐠', value: 18, xp: 10 },
  ]},
  { weight: 10, rarity: 'RARE', fish: [
    { name: 'Poisson-Lune', emoji: '🌙', value: 40, xp: 15 },
    { name: 'Barracuda', emoji: '🦈', value: 50, xp: 15 },
  ]},
  { weight: 4, rarity: 'EPIC', fish: [
    { name: 'Coelacanthe', emoji: '🐡', value: 100, xp: 25 },
    { name: 'Poisson d\'Or', emoji: '✨', value: 120, xp: 30 },
  ]},
  { weight: 1, rarity: 'LEGENDARY', fish: [
    { name: 'Léviathan Miniature', emoji: '🐋', value: 300, xp: 60 },
    { name: 'Kraken Bébé', emoji: '🦑', value: 500, xp: 80 },
  ]},
];

const RARITY_COLORS: Record<string, string> = {
  COMMON: '⬜', UNCOMMON: '🟩', RARE: '🟦', EPIC: '🟪', LEGENDARY: '🟨'
};

function rollFish(): FishEntry {
  const totalWeight = FISH_TABLE.reduce((s, t) => s + t.weight, 0);
  let roll = Math.random() * totalWeight;
  for (const tier of FISH_TABLE) {
    roll -= tier.weight;
    if (roll <= 0) {
      const picked = tier.fish[Math.floor(Math.random() * tier.fish.length)];
      return { ...picked, rarity: tier.rarity };
    }
  }
  const fallback = FISH_TABLE[0].fish[0];
  return { ...fallback, rarity: 'COMMON' };
}

export { RARITY_COLORS };

export async function fish(guildId: string, userId: string) {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.enabled) throw new Error("Le module d'économie est désactivé sur ce serveur.");

  const profile = await getOrCreateRpgProfile(guildId, userId);

  // Cooldown 5 minutes
  if (profile.lastFish) {
    const diff = Date.now() - profile.lastFish.getTime();
    if (diff < 5 * 60 * 1000) {
      const remaining = Math.ceil((5 * 60 * 1000 - diff) / 1000);
      const mins = Math.floor(remaining / 60);
      const secs = remaining % 60;
      return { success: false as const, cooldown: true, remainingMin: mins, remainingSec: secs };
    }
  }

  // Coûte 5 énergie
  if (profile.energy < 5) {
    return { success: false as const, cooldown: false, noEnergy: true };
  }

  const caught = rollFish();

  // Atomic guard: only spend energy if the row still has enough at write time.
  const spent = await prisma.rpgProfile.updateMany({
    where: { id: profile.id, energy: { gte: 5 } },
    data: {
      balance: { increment: caught.value },
      xp: { increment: caught.xp },
      energy: { decrement: 5 },
      totalFishCaught: { increment: 1 },
      lastFish: new Date()
    }
  });

  if (spent.count === 0) {
    return { success: false as const, cooldown: false, noEnergy: true };
  }

  await prisma.rpgFishCatch.create({
    data: {
      guildId,
      userId,
      fishName: caught.name,
      fishEmoji: caught.emoji,
      rarity: caught.rarity,
      value: caught.value
    }
  });

  await checkLevelUp(guildId, userId);

  const updatedProfile = await prisma.rpgProfile.findUnique({
    where: { guildId_userId: { guildId, userId } }
  });

  return {
    success: true as const,
    fish: caught,
    rarityIcon: RARITY_COLORS[caught.rarity] || '⬜',
    newBalance: updatedProfile?.balance ?? profile.balance + caught.value,
    totalFishCaught: updatedProfile?.totalFishCaught ?? profile.totalFishCaught + 1
  };
}

// ============================================================================
// LEADERBOARDS RPG
// ============================================================================

export async function getTopByLevel(guildId: string, limit = 10) {
  return prisma.rpgProfile.findMany({
    where: { guildId },
    orderBy: [{ level: 'desc' }, { xp: 'desc' }],
    take: limit
  });
}

export async function getTopByMonstersKilled(guildId: string, limit = 10) {
  return prisma.rpgProfile.findMany({
    where: { guildId, totalMonstersKilled: { gt: 0 } },
    orderBy: { totalMonstersKilled: 'desc' },
    take: limit
  });
}

export async function getTopByFishCaught(guildId: string, limit = 10) {
  return prisma.rpgProfile.findMany({
    where: { guildId, totalFishCaught: { gt: 0 } },
    orderBy: { totalFishCaught: 'desc' },
    take: limit
  });
}

export async function getTopByItems(guildId: string, limit = 10) {
  const profiles = await prisma.rpgProfile.findMany({
    where: { guildId },
    include: {
      inventory: true
    }
  });

  return profiles
    .map(p => ({
      userId: p.userId,
      level: p.level,
      totalItems: p.inventory.reduce((sum, inv) => sum + inv.quantity, 0)
    }))
    .filter(p => p.totalItems > 0)
    .sort((a, b) => b.totalItems - a.totalItems)
    .slice(0, limit);
}
