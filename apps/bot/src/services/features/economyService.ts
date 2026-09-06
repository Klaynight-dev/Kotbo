import type { Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { isShopItemAvailable, normalizeRpgGuildLevel, type ShopModuleState } from './economyPolicy.js';
import { seedRpgContent } from './rpg/rpgSeedService.js';
import { STAT_POINTS_PER_LEVEL, slotForItemType } from './rpg/rpgProgressionService.js';
import { deleteItemInstanceWrite, ensureItemInstance } from './rpg/rpgItemInstanceService.js';

// Cooldown tracker for in-memory message activity (to prevent spam farming)
const messageActivityCooldown = new Map<string, number>();
const MAX_ACTIVITY_COOLDOWNS = 100_000;
let activityCooldownChecks = 0;

function maintainActivityCooldowns(now: number): void {
  activityCooldownChecks++;
  if (activityCooldownChecks % 2_048 !== 0 && messageActivityCooldown.size < MAX_ACTIVITY_COOLDOWNS) return;

  // Le cooldown vocal (2 min) est le plus long : toute entrée plus ancienne
  // est définitivement inutile.
  for (const [key, lastReward] of messageActivityCooldown) {
    if (now - lastReward >= 120_000) messageActivityCooldown.delete(key);
  }
  while (messageActivityCooldown.size >= MAX_ACTIVITY_COOLDOWNS) {
    const oldest = messageActivityCooldown.keys().next().value as string | undefined;
    if (!oldest) break;
    messageActivityCooldown.delete(oldest);
  }
}

/**
 * Gets or creates the global/local economy configuration for a guild.
 */
export async function getOrCreateEconomyConfig(guildId: string) {
  const config = await prisma.economyConfig.findUnique({
    where: { guildId }
  });

  if (config) return config;

  // `upsert` plutôt que `create` : deux interactions simultanées du même serveur
  // (deux membres qui ouvrent `/rpg` en même temps) passaient toutes les deux le
  // `findUnique` ci-dessus et la seconde plantait sur la contrainte d'unicité.
  return prisma.economyConfig.upsert({
    where: { guildId },
    update: {},
    create: {
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

/**
 * Injecte le catalogue RPG par défaut (objets, monstres, événements, recettes).
 * Conservé sous ce nom pour les appelants historiques ; le contenu vit désormais dans
 * `rpg/rpgContent.ts` et le seed incrémental dans `rpg/rpgSeedService.ts`.
 */
export function seedDefaults(): Promise<void> {
  return seedRpgContent();
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
  const key = `${guildId}:${userId}:${type}`;
  const now = Date.now();
  maintainActivityCooldowns(now);
  const lastReward = messageActivityCooldown.get(key) || 0;
  
  // Cooldown to avoid spam farming: 1 min for text, 2 min for voice gains
  const cooldownMs = type === 'text' ? 60000 : 120000;
  if (now - lastReward < cooldownMs) return;

  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.enabled) return;

  messageActivityCooldown.delete(key);
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

/** XP nécessaire pour passer du niveau `level` au suivant. */
export function xpRequiredForLevel(level: number): number {
  return level * 100;
}

/** Vrai si l'objet occupe l'un des trois emplacements d'équipement du profil. */
export function isItemEquipped(
  profile: { weaponId: string | null; armorId: string | null; accessoryId: string | null },
  itemId: string,
): boolean {
  return profile.weaponId === itemId || profile.armorId === itemId || profile.accessoryId === itemId;
}

/**
 * Checks if a player has leveled up and updates their stats.
 *
 * Boucle sur les paliers : un gain d'XP important (boss, drop admin) peut couvrir
 * plusieurs niveaux d'un coup, et l'ancienne version n'en accordait qu'un seul en
 * laissant le surplus bloqué jusqu'au prochain gain d'XP.
 */
export async function checkLevelUp(guildId: string, userId: string) {
  const profile = await prisma.rpgProfile.findUnique({
    where: { guildId_userId: { guildId, userId } }
  });

  if (!profile) return null;

  // Croissance automatique volontairement faible (+1 par stat) : l'essentiel de la
  // progression passe désormais par les points à répartir, qui rendent chaque personnage
  // différent au lieu de faire monter tout le monde sur la même courbe.
  const AUTO_STATS_INCREASE = 1;
  const MAX_HEALTH_INCREASE = 8;
  const MAX_LEVELS_PER_CALL = 100; // garde-fou contre une boucle infinie sur données corrompues

  let level = profile.level;
  let xp = profile.xp;
  let gained = 0;

  while (xp >= xpRequiredForLevel(level) && gained < MAX_LEVELS_PER_CALL) {
    xp -= xpRequiredForLevel(level);
    level += 1;
    gained += 1;
  }

  if (gained === 0) return null;

  const newMaxHealth = profile.maxHealth + MAX_HEALTH_INCREASE * gained;

  await prisma.rpgProfile.update({
    where: { id: profile.id },
    data: {
      level,
      xp,
      maxHealth: newMaxHealth,
      health: newMaxHealth, // Full heal on level up
      attack: profile.attack + AUTO_STATS_INCREASE * gained,
      defense: profile.defense + AUTO_STATS_INCREASE * gained,
      speed: profile.speed + AUTO_STATS_INCREASE * gained,
      statPoints: { increment: STAT_POINTS_PER_LEVEL * gained }
    }
  });

  logger.info('EconomyService', `Player ${userId} leveled up to Level ${level} in Guild ${guildId}`);
  return level;
}

/**
 * Claims the daily KotboCoins reward.
 */
export async function claimDaily(guildId: string, userId: string) {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.enabled) throw new Error("Le module d'économie est désactivé sur ce serveur.");

  const profile = await getOrCreateRpgProfile(guildId, userId);
  const now = new Date();
  const cooldownMs = config.dailyCooldownHour * 60 * 60 * 1000;

  if (profile.lastDaily) {
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

  const claimed = await prisma.rpgProfile.updateMany({
    where: {
      id: profile.id,
      OR: [
        { lastDaily: null },
        { lastDaily: { lte: new Date(now.getTime() - cooldownMs) } },
      ],
    },
    data: {
      balance: { increment: reward },
      lastDaily: now
    }
  });

  if (claimed.count === 0) {
    const current = await prisma.rpgProfile.findUnique({
      where: { id: profile.id },
      select: { lastDaily: true },
    });
    const lastDaily = current?.lastDaily ?? now;
    const remainingMs = Math.max(0, cooldownMs - (now.getTime() - lastDaily.getTime()));
    return {
      success: false,
      cooldown: true,
      remainingHours: Math.floor(remainingMs / (1000 * 60 * 60)),
      remainingMinutes: Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60))
    };
  }

  const updated = await prisma.rpgProfile.findUnique({
    where: { id: profile.id },
    select: { balance: true },
  });

  return {
    success: true,
    cooldown: false,
    reward,
    newBalance: updated?.balance ?? profile.balance + reward
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
 * Hash déterministe (FNV-1a 32 bits) utilisé pour tirer l'événement d'un voyage.
 */
function hashString(value: string): number {
  let hash = 2_166_136_261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

/**
 * Sélectionne l'événement d'aventure d'un voyage donné.
 *
 * Le tirage est *déterministe* (dérivé du profil + de l'heure de départ) et non
 * aléatoire : sinon il suffisait de fermer puis rouvrir la vue Voyage pour retirer
 * un nouvel événement jusqu'à tomber sur le plus rentable.
 */
function pickTravelEvent<T extends { id: string }>(events: T[], profileId: string, travelStartedAt: Date | null): T {
  const ordered = [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seed = `${profileId}:${travelStartedAt?.getTime() ?? 0}`;
  return ordered[hashString(seed) % ordered.length];
}

/**
 * Resolves a travel event for a user. Returns the adventure event if travel is complete.
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

  const event = pickTravelEvent(events, profile.id, profile.travelStartedAt);

  await prisma.rpgProfile.update({
    where: { id: profile.id },
    data: {
      lastEventAt: new Date()
    }
  });

  return {
    complete: true,
    noEvent: false,
    event
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

  // Le voyage doit réellement être arrivé à son terme : sans ce contrôle, un bouton
  // encore affiché dans un ancien message permettait de résoudre instantanément un
  // nouveau voyage sans en attendre la durée.
  const elapsedMin = (Date.now() - (profile.travelStartedAt?.getTime() ?? 0)) / (1000 * 60);
  if (elapsedMin < profile.travelDurationMin) {
    throw new Error(`Votre voyage n'est pas terminé (encore ${Math.ceil(profile.travelDurationMin - elapsedMin)} minute(s)).`);
  }

  const event = await prisma.rpgAdventureEvent.findUnique({
    where: { id: eventId }
  });

  if (!event) throw new Error('Événement introuvable.');

  // …et il doit s'agir de l'événement réellement tiré pour CE voyage, sinon un bouton
  // d'un voyage précédent permettait de choisir l'événement le plus rentable.
  const availableEvents = await prisma.rpgAdventureEvent.findMany({
    where: { OR: [{ guildId: null }, { guildId }] },
    select: { id: true }
  });
  const expectedEvent = availableEvents.length > 0
    ? pickTravelEvent(availableEvents, profile.id, profile.travelStartedAt)
    : null;
  if (!expectedEvent || expectedEvent.id !== eventId) {
    throw new Error("Cet événement ne correspond pas à votre voyage en cours. Rouvrez l'onglet Voyage.");
  }

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

  // Garde atomique sur `isTraveling` : un double-clic rapide sur le même bouton de
  // choix ne peut plus encaisser deux fois les récompenses du même événement.
  const resolved = await prisma.rpgProfile.updateMany({
    where: { id: profile.id, isTraveling: true },
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

  if (resolved.count === 0) {
    throw new Error('Cette aventure a déjà été résolue.');
  }

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
 * État des modules dont la boutique vend les récompenses.
 *
 * Lu à chaque affichage et à chaque achat : un module éteint entre-temps doit retirer ses
 * objets de la vente sans qu'on ait à toucher au catalogue.
 */
export async function getShopModuleState(guildId: string): Promise<ShopModuleState> {
  const [levelConfig, guild, economy] = await Promise.all([
    prisma.levelConfig.findUnique({ where: { guildId }, select: { enabled: true } }),
    prisma.guild.findUnique({ where: { id: guildId }, select: { clansEnabled: true, clanPointsFromRpg: true } }),
    prisma.economyConfig.findUnique({ where: { guildId }, select: { enabled: true, raidEnabled: true } }),
  ]);

  return {
    levelingEnabled: levelConfig?.enabled ?? false,
    clanPointsEnabled: Boolean(guild?.clansEnabled && guild.clanPointsFromRpg),
    raidEnabled: Boolean(economy?.enabled && economy.raidEnabled),
  };
}

/**
 * Purchases an item from the shop.
 */
/** Achat le plus gros que la boutique accepte en une fois. */
export const MAX_SHOP_BUY_QUANTITY = 25;

/**
 * Achete un objet de la boutique, en un ou plusieurs exemplaires.
 *
 * La quantite est bornee ici et pas seulement dans les boutons : le `customId`
 * qui la porte vient du client et ne prouve rien.
 */
export async function buyShopItem(guildId: string, userId: string, itemId: string, quantity = 1) {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.shopEnabled) throw new Error('La boutique RPG est désactivée.');

  const qty = Math.min(Math.max(Math.floor(quantity) || 1, 1), MAX_SHOP_BUY_QUANTITY);

  const profile = await getOrCreateRpgProfile(guildId, userId);
  const [item, modules] = await Promise.all([
    prisma.rpgItem.findUnique({ where: { id: itemId } }),
    getShopModuleState(guildId),
  ]);

  if (!isShopItemAvailable(item, guildId, modules)) {
    throw new Error("Objet introuvable ou indisponible à l'achat.");
  }

  const total = item.price * qty;
  if (profile.balance < total) {
    throw new Error(`Vous n'avez pas assez de KotboCoins (requis: ${total} 🪙).`);
  }

  // Deduct balance and add to inventory
  await prisma.$transaction([
    prisma.rpgProfile.update({
      where: { id: profile.id },
      data: { balance: { decrement: total } }
    }),
    prisma.rpgInventoryItem.upsert({
      where: {
        rpgProfileId_itemId: {
          rpgProfileId: profile.id,
          itemId: item.id
        }
      },
      update: {
        quantity: { increment: qty }
      },
      create: {
        rpgProfileId: profile.id,
        itemId: item.id,
        quantity: qty
      }
    })
  ]);

  return {
    itemName: item.name,
    quantity: qty,
    price: total,
    unitPrice: item.price,
    newBalance: profile.balance - total
  };
}

/**
 * Équipe - ou déséquipe si l'objet est déjà porté - une arme, une armure ou un accessoire.
 *
 * INVARIANT : cette fonction n'écrit QUE la référence d'équipement et son niveau de forge.
 * Les statistiques du profil restent les stats de base ; les bonus sont recalculés à la
 * lecture par `getEffectiveStats`. Aucune dérive de statistiques n'est donc possible.
 *
 * Le basculement équiper/déséquiper est indispensable : sans lui, un objet équipé ne pouvait
 * plus jamais être vendu ni donné, `sellShopItem` refusant tout objet porté.
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
  const slot = slotForItemType(item.type);
  if (!slot) {
    throw new Error('Seuls les armes, armures et accessoires peuvent être équipés.');
  }

  if (item.levelRequired > 0 && profile.level < item.levelRequired) {
    throw new Error(`Cet objet requiert le niveau ${item.levelRequired}. Vous êtes niveau ${profile.level}.`);
  }

  const slotField = `${slot}Id` as 'weaponId' | 'armorId' | 'accessoryId';
  const currentlyEquippedId = profile[slotField];

  if (currentlyEquippedId === item.id) {
    await prisma.rpgProfile.update({
      where: { id: profile.id },
      data: { [slotField]: null }
    });

    return { itemName: item.name, type: item.type, slot, equipped: false };
  }

  // Le niveau de forge et les enchantements appartiennent à l'objet, pas à l'emplacement :
  // ils vivent sur l'instance et ne sont donc ni remis à zéro au déséquipement, ni hérités
  // par l'objet suivant. On matérialise l'instance dès l'équipement pour que la forge et
  // l'autel aient toujours une ligne sur laquelle écrire.
  await prisma.rpgProfile.update({
    where: { id: profile.id },
    data: { [slotField]: item.id }
  });
  await ensureItemInstance(profile.id, item.id);

  return { itemName: item.name, type: item.type, slot, equipped: true };
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

  // Les récompenses des modules voisins (XP de niveaux, points de clan) ne sont pas versées
  // ici : elles demandent le client Discord. Elles remontent à l'appelant, qui l'a.
  return {
    itemName: item.name,
    restoredHp,
    restoredEnergy,
    newHp,
    newEnergy,
    levelXpReward: item.levelXpReward,
    clanPointsReward: item.clanPointsReward,
    raidAssaultBonus: item.raidAssaultBonus
  };
}

export const RPG_GUILD_NAME_MIN = 3;
export const RPG_GUILD_NAME_MAX = 32;

/** Guilde RPG d'un serveur retrouvée par son nom, insensible à la casse. */
export async function findRpgGuildByName(guildId: string, name: string) {
  return prisma.rpgGuild.findFirst({
    where: { guildId, name: { equals: name.trim(), mode: 'insensitive' } },
  });
}

/**
 * Fait passer à une guilde les paliers que son XP accumulée lui ouvre.
 *
 * L'écriture est conditionnée à l'état exact qui a servi au calcul : deux versements
 * simultanés ne peuvent donc pas se recouvrir. Le perdant ne fait rien, et ce n'est pas
 * grave - l'XP, elle, est bien en base, et le versement suivant la convertira.
 */
async function levelUpRpgGuild(rpgGuildId: string, current: { level: number; xp: number }) {
  const next = normalizeRpgGuildLevel(current);
  if (next.level === current.level) return { level: current.level, levelUp: null };

  const applied = await prisma.rpgGuild.updateMany({
    where: { id: rpgGuildId, level: current.level, xp: current.xp },
    data: { level: next.level, xp: next.xp },
  });
  if (applied.count === 0) return { level: current.level, levelUp: null };

  return { level: next.level, levelUp: next.level };
}

/**
 * Crédite une guilde RPG de l'XP gagnée collectivement, et rend le niveau atteint.
 *
 * C'est le pendant des points de clan pour les serveurs qui jouent en équipes du jeu : sans
 * ça, abattre le boss du raid ne rapportait rien à la guilde elle-même, qui ne montait qu'à
 * coups de dépôts au trésor.
 *
 * Le gain est ajouté par incrément et non réécrit à partir d'une lecture : un raid et une
 * quête qui se terminent dans la même seconde créditeraient sinon la même guilde à partir
 * du même état, et l'un des deux gains disparaîtrait.
 */
export async function awardRpgGuildXp(rpgGuildId: string, amount: number): Promise<{ level: number; levelUp: number | null } | null> {
  const gain = Math.max(0, Math.trunc(Number(amount) || 0));
  if (gain === 0) return null;

  // Une guilde dissoute entre le dernier assaut et le versement ne doit pas faire échouer
  // la distribution du reste des récompenses.
  const bumped = await prisma.rpgGuild.updateMany({
    where: { id: rpgGuildId },
    data: { xp: { increment: gain } },
  });
  if (bumped.count === 0) return null;

  const rpgGuild = await prisma.rpgGuild.findUnique({ where: { id: rpgGuildId }, select: { level: true, xp: true } });
  if (!rpgGuild) return null;

  return levelUpRpgGuild(rpgGuildId, rpgGuild);
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

  const cleanName = name.trim();
  if (cleanName.length < RPG_GUILD_NAME_MIN || cleanName.length > RPG_GUILD_NAME_MAX) {
    throw new Error(`Le nom de la guilde doit faire entre ${RPG_GUILD_NAME_MIN} et ${RPG_GUILD_NAME_MAX} caractères.`);
  }

  // L'unicité en base est sensible à la casse, la recherche par nom ne l'est pas : sans ce
  // contrôle, « Les Loups » et « les loups » coexistaient et rejoindre l'une revenait à
  // tomber sur l'autre. Les doublons exacts, eux, remontaient l'erreur Prisma brute.
  const twin = await findRpgGuildByName(guildId, cleanName);
  if (twin) throw new Error(`Une guilde se nomme déjà « ${twin.name} ».`);

  const rpgGuild = await prisma.rpgGuild.create({
    data: {
      guildId,
      name: cleanName,
      description: description?.trim() || null,
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

  // Trésor et XP montent par incrément, les paliers se règlent après : deux dons versés
  // dans la même seconde partiraient sinon du même état lu, et l'un des deux serait perdu.
  const [, credited] = await prisma.$transaction([
    prisma.rpgProfile.update({
      where: { id: profile.id },
      data: { balance: { decrement: amount } }
    }),
    prisma.rpgGuild.update({
      where: { id: rpgGuild.id },
      data: {
        treasury: { increment: amount },
        xp: { increment: amount }
      },
      select: { level: true, xp: true }
    })
  ]);

  const { levelUp } = await levelUpRpgGuild(rpgGuild.id, credited);

  return { amount, levelUp };
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
  if (isItemEquipped(profile, item.id)) {
    throw new Error("Vous ne pouvez pas vendre un objet équipé. Déséquipez-le d'abord depuis l'onglet Inventaire de `/rpg`.");
  }

  const sellPrice = Math.floor(item.price * 0.5);
  const lastCopy = inventoryEntry.quantity <= 1;

  await prisma.$transaction([
    lastCopy
      ? prisma.rpgInventoryItem.delete({
          where: { id: inventoryEntry.id }
        })
      : prisma.rpgInventoryItem.update({
          where: { id: inventoryEntry.id },
          data: { quantity: { decrement: 1 } }
        }),
    // Vendre son dernier exemplaire emporte sa progression : garder l'instance ferait
    // réapparaître le +7 et les enchantements sur un objet racheté plus tard pour trois fois
    // rien, transformant la revente en sauvegarde gratuite.
    ...(lastCopy ? [deleteItemInstanceWrite(profile.id, item.id)] : []),
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

export type RestoredLevelUpCoins = { players: number; coins: number };

/**
 * Recrée les profils RPG des membres ayant au moins un niveau, avec pour seul acquis les
 * KotboCoins gagnés à leurs montées de niveau.
 *
 * Ces pièces récompensent l'activité sur le serveur et sont créditées par le module de
 * niveaux, pas par le RPG : les effacer avec les profils ferait payer aux membres une remise
 * à zéro qui ne concerne pas la progression qui les leur a values.
 */
async function restoreLevelUpCoins(guildId: string): Promise<RestoredLevelUpCoins> {
  const { totalLevelUpCoins } = await import('../progression/levelingService.js');

  const leveled = await prisma.memberLevel.findMany({
    where: { guildId, level: { gt: 0 } },
    select: { userId: true, level: true }
  });
  if (leveled.length === 0) return { players: 0, coins: 0 };

  const profiles = leveled.map(({ userId, level }) => ({
    guildId,
    userId,
    balance: totalLevelUpCoins(level)
  }));

  // `skipDuplicates` : un joueur peut recréer son profil entre la suppression et cet insert.
  const created = await prisma.rpgProfile.createMany({ data: profiles, skipDuplicates: true });
  const coins = profiles.reduce((total, profile) => total + profile.balance, 0);

  logger.info('EconomyService', `Restitution de ${coins} KotboCoins de niveau a ${created.count} profil(s) sur la guilde ${guildId}`);
  return { players: created.count, coins };
}

/**
 * Réinitialise certains éléments ou toute l'économie RPG pour une guilde.
 */
export async function adminResetGuildEconomy(guildId: string, component: 'all' | 'profiles' | 'items' | 'config' | 'guilds' | 'bestiary') {
  let restored: RestoredLevelUpCoins = { players: 0, coins: 0 };

  // Les paliers de difficulté décrivent le bestiaire et la boutique, pas le rythme de
  // l'économie : les oublier en réinitialisant la seule configuration laisserait des fiches
  // déjà réécrites face à un palier revenu à « moyen », et le clic suivant les multiplierait
  // une seconde fois. « Tout réinitialiser » vide aussi les créatures et les objets : là, les
  // paliers n'ont plus rien à décrire et repartent de zéro avec le reste.
  const keptDifficulty = component === 'config'
    ? await prisma.economyConfig.findUnique({
      where: { guildId },
      select: { bossDifficulty: true, monsterDifficulty: true, shopDifficulty: true }
    })
    : null;

  if (component === 'config' || component === 'all') {
    await prisma.economyConfig.deleteMany({
      where: { guildId }
    });
  }

  if (component === 'items' || component === 'all') {
    // Les statistiques étant dérivées, il suffit de libérer les emplacements : aucun bonus
    // n'a été incorporé aux colonnes, donc il n'y a rien à recalculer.
    const guildItems = await prisma.rpgItem.findMany({
      where: { guildId },
      select: { id: true, name: true }
    });
    const itemIds = guildItems.map((item) => item.id);

    if (itemIds.length > 0) {
      await prisma.rpgProfile.updateMany({
        where: { guildId, weaponId: { in: itemIds } },
        data: { weaponId: null }
      });
      await prisma.rpgProfile.updateMany({
        where: { guildId, armorId: { in: itemIds } },
        data: { armorId: null }
      });
      await prisma.rpgProfile.updateMany({
        where: { guildId, accessoryId: { in: itemIds } },
        data: { accessoryId: null }
      });
    }

    await prisma.rpgItem.deleteMany({
      where: { guildId }
    });

    // Les butins désignent leur objet par son nom. Inutile pour « tout réinitialiser », qui
    // supprime le bestiaire du serveur juste après.
    if (component === 'items') {
      const { syncDropReferences } = await import('./rpg/rpgBestiaryService.js');
      const { syncRecipeReferences } = await import('./rpg/rpgRecipeService.js');
      for (const item of guildItems) {
        await syncDropReferences(guildId, item.name, null);
        await syncRecipeReferences(guildId, item.name, null);
      }

      // Le palier de prix ne portait que sur ces objets : plus aucun ne le porte.
      await prisma.economyConfig.updateMany({
        where: { guildId },
        data: { shopDifficulty: 'NORMAL' }
      });
    }
  }

  if (component === 'guilds' || component === 'all') {
    await prisma.rpgGuild.deleteMany({
      where: { guildId }
    });
  }

  if (component === 'all') {
    // Les raids passés désignent leur boss par une relation mise à null : supprimer les
    // fiches ne suffirait pas à effacer l'historique, il faut le retirer explicitement.
    await prisma.rpgRaid.deleteMany({ where: { guildId } });
    await prisma.rpgRaidBoss.deleteMany({ where: { guildId } });
    // Les progressions suivent leur quête en cascade.
    await prisma.rpgQuest.deleteMany({ where: { guildId } });
  }

  if (component === 'bestiary' || component === 'all') {
    // Créatures propres au serveur et copies personnalisées du bestiaire livré de base.
    // Les monstres globaux (guildId null) sont partagés : ils ne sont jamais touchés, et
    // supprimer les copies suffit à faire réapparaître les originaux.
    await prisma.rpgMonster.deleteMany({
      where: { guildId }
    });

    // Le bestiaire redevenant celui du catalogue, les paliers de difficulté qui
    // l'avaient réécrit ne décrivent plus rien : les laisser ferait repartir le
    // prochain réglage d'un palier que plus aucune fiche ne porte.
    // Inutile pour « tout réinitialiser », qui supprime la configuration.
    if (component === 'bestiary') {
      await prisma.economyConfig.updateMany({
        where: { guildId },
        data: { bossDifficulty: 'NORMAL', monsterDifficulty: 'NORMAL' }
      });
    }
  }

  if (component === 'profiles' || component === 'all') {
    await prisma.rpgInventoryItem.deleteMany({
      where: { profile: { guildId } }
    });
    await prisma.rpgProfile.deleteMany({
      where: { guildId }
    });
    restored = await restoreLevelUpCoins(guildId);
  }

  if (component === 'config' || component === 'all') {
    await getOrCreateEconomyConfig(guildId);
    if (keptDifficulty) {
      await prisma.economyConfig.update({ where: { guildId }, data: keptDifficulty });
    }
  }

  return { success: true, restored };
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
  const cooldownMs = 60 * 60 * 1000; // 1 heure

  if (profile.lastWork) {
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

  const worked = await prisma.rpgProfile.updateMany({
    where: {
      id: profile.id,
      OR: [
        { lastWork: null },
        { lastWork: { lte: new Date(now.getTime() - cooldownMs) } },
      ],
    },
    data: {
      balance: { increment: salary },
      xp: { increment: xpReward },
      lastWork: now
    }
  });

  if (worked.count === 0) {
    const current = await prisma.rpgProfile.findUnique({
      where: { id: profile.id },
      select: { lastWork: true },
    });
    const lastWork = current?.lastWork ?? now;
    const remainingMs = Math.max(0, cooldownMs - (now.getTime() - lastWork.getTime()));
    return {
      success: false,
      cooldown: true,
      remainingMinutes: Math.floor(remainingMs / (1000 * 60)),
      remainingSeconds: Math.floor((remainingMs % (1000 * 60)) / 1000)
    };
  }

  const levelUp = await checkLevelUp(guildId, userId);
  const updated = await prisma.rpgProfile.findUnique({
    where: { id: profile.id },
    select: { balance: true },
  });

  return {
    success: true,
    cooldown: false,
    salary,
    xpReward,
    newBalance: updated?.balance ?? profile.balance + salary,
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
  const windowStartCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const resetWindow = await prisma.rpgProfile.updateMany({
    where: {
      id: profile.id,
      OR: [
        { dailyBetWindowStart: null },
        { dailyBetWindowStart: { lte: windowStartCutoff } },
      ],
    },
    data: {
      dailyBetCount: 1,
      dailyBetWindowStart: now,
    }
  });

  if (resetWindow.count === 0) {
    const incremented = await prisma.rpgProfile.updateMany({
      where: {
        id: profile.id,
        dailyBetWindowStart: { gt: windowStartCutoff },
        dailyBetCount: { lt: config.maxDailyBets },
      },
      data: {
        dailyBetCount: { increment: 1 },
      },
    });

    if (incremented.count === 0) {
      throw new Error(`Vous avez atteint la limite de **${config.maxDailyBets}** parties de jeux d'argent par jour. Réessayez plus tard.`);
    }
  }

  return prisma.rpgProfile.findUnique({
    where: { id: profile.id },
  });
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
  const isEquipped = isItemEquipped(senderProfile, itemId);
  if (isEquipped && senderEntry.quantity - quantity <= 0) {
    throw new Error("Cet objet est actuellement équipé. Déséquipez-le depuis l'onglet Inventaire de `/rpg` avant de pouvoir le donner.");
  }

  const givesLastCopy = senderEntry.quantity <= quantity;

  // Update inventories
  await prisma.$transaction([
    // Deduct from sender
    givesLastCopy
      ? prisma.rpgInventoryItem.delete({
          where: { id: senderEntry.id }
        })
      : prisma.rpgInventoryItem.update({
          where: { id: senderEntry.id },
          data: { quantity: { decrement: quantity } }
        }),
    // La progression n'est pas transmissible : le donneur perd la sienne avec son dernier
    // exemplaire, le receveur reçoit un objet nu. Sinon un objet enchanté ferait le tour
    // du serveur et chacun profiterait d'une forge payée une seule fois.
    ...(givesLastCopy ? [deleteItemInstanceWrite(senderProfile.id, itemId)] : []),
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
 * Supprime un objet de la boutique (Admin) en libérant au préalable les emplacements des
 * joueurs qui le portaient.
 *
 * `weaponId`/`armorId`/`accessoryId` sont de simples champs texte (pas de relation Prisma) :
 * la suppression de l'objet ne les nettoie jamais automatiquement, et un emplacement qui
 * pointe vers un objet inexistant fausserait ensuite l'affichage et la forge.
 */
export async function adminDeleteShopItem(guildId: string, itemId: string) {
  const item = await prisma.rpgItem.findUnique({ where: { id: itemId } });
  if (!item) throw new Error('Objet introuvable.');
  if (item.guildId !== guildId) {
    throw new Error('Vous ne pouvez supprimer que les objets spécifiques à votre serveur.');
  }

  const equippedProfiles = await prisma.rpgProfile.findMany({
    where: { OR: [{ weaponId: itemId }, { armorId: itemId }, { accessoryId: itemId }] },
    select: { id: true }
  });

  await prisma.$transaction([
    prisma.rpgProfile.updateMany({ where: { weaponId: itemId }, data: { weaponId: null } }),
    prisma.rpgProfile.updateMany({ where: { armorId: itemId }, data: { armorId: null } }),
    prisma.rpgProfile.updateMany({ where: { accessoryId: itemId }, data: { accessoryId: null } }),
    prisma.rpgItem.delete({ where: { id: itemId } })
  ]);

  // Un butin désigne son objet par son nom : sans ce nettoyage, les monstres du serveur
  // continueraient d'annoncer un butin que plus rien ne peut verser. L'objet est deja
  // supprimé : un incident ici est journalisé, il ne rend pas la suppression fautive.
  const { syncDropReferences } = await import('./rpg/rpgBestiaryService.js');
  const cleanedMonsters = await syncDropReferences(guildId, item.name, null).catch((err) => {
    logger.error('EconomyService', `Butins non nettoyés après la suppression de ${item.name}:`, err);
    return 0;
  });

  // Même raison pour les recettes : un matériau supprimé les rendrait infabriquables sans
  // que rien ne l'explique au joueur.
  const { syncRecipeReferences } = await import('./rpg/rpgRecipeService.js');
  const cleanedRecipes = await syncRecipeReferences(guildId, item.name, null).catch((err) => {
    logger.error('EconomyService', `Recettes non nettoyées après la suppression de ${item.name}:`, err);
    return 0;
  });

  return { item, unequippedCount: equippedProfiles.length, cleanedMonsters, cleanedRecipes };
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

  const updates: Prisma.PrismaPromise<unknown>[] = [];

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

    // L'objet quitte l'inventaire : sa progression part avec lui, sinon la rendre au
    // joueur plus tard lui restituerait gratuitement forge et enchantements.
    updates.push(deleteItemInstanceWrite(profile.id, itemId));

    // On libère aussi l'emplacement s'il y était porté. Les stats étant dérivées, il n'y a
    // aucun bonus à défaire - seulement la référence.
    const updateData: Prisma.RpgProfileUpdateInput = {};
    if (profile.weaponId === itemId) { updateData.weaponId = null; }
    else if (profile.armorId === itemId) { updateData.armorId = null; }
    else if (profile.accessoryId === itemId) { updateData.accessoryId = null; }

    if (Object.keys(updateData).length > 0) {
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
