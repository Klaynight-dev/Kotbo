/**
 * Autel d'enchantement : pose et retrait d'enchantements sur l'équipement porté.
 *
 * Même discipline que la forge : on n'écrit jamais de statistique, uniquement la liste
 * d'enchantements de l'instance d'objet. Le calcul final reste la responsabilité exclusive
 * de `getEffectiveStats`, et le catalogue (`rpgEnchantments.ts`) reste la seule source de
 * vérité sur ce que fait un enchantement.
 *
 * Coût d'une pose : un parchemin (objet de type `SCROLL`, obtenu en butin ou fabriqué) et
 * des pièces. Le parchemin est consommé même en cas d'échec, comme les pièces à la forge :
 * sans risque, l'autel ne serait qu'un bouton à cliquer jusqu'à la réussite.
 */

import prisma from '../../../utils/db.js';
import {
  enchantCapacity,
  formatEnchant,
  getEnchantment,
  type EnchantSlot,
  type EnchantStack,
  type RpgEnchantment,
} from './rpgEnchantments.js';
import { ensureItemInstance, getItemInstance, getItemInstances } from './rpgItemInstanceService.js';
import { SLOT_ITEM_FIELD, slotForItemType, type EquipmentSlot } from './rpgProgressionService.js';

/** Type d'objet des parchemins d'enchantement. */
export const SCROLL_ITEM_TYPE = 'SCROLL';

/**
 * Coût en pièces d'une pose, par rareté du parchemin et par palier visé.
 * Le parchemin est la ressource rare ; les pièces empêchent seulement d'enchanter à
 * l'aveugle tout ce qui traîne dans le sac.
 */
const BASE_COST_BY_RARITY: Record<string, number> = {
  COMMON: 250,
  UNCOMMON: 500,
  RARE: 1_000,
  EPIC: 2_000,
  LEGENDARY: 3_500,
};

/** Coût en pièces du retrait d'un enchantement, pour libérer un emplacement. */
export const DISENCHANT_COST = 750;

export function enchantCost(enchant: RpgEnchantment, tier: number): number {
  const base = BASE_COST_BY_RARITY[enchant.rarity] ?? 500;
  return Math.round(base * tier);
}

/**
 * Probabilité de réussite d'une pose. Le palier 1 est garanti ; au-delà, la difficulté
 * monte, sur le même principe que la forge.
 */
export function enchantSuccessChance(tier: number): number {
  if (tier <= 1) return 1;
  return Math.max(0.35, 1 - (tier - 1) * 0.2);
}

// ════════════════════════════════════════════════════════════════════════════
// LECTURE
// ════════════════════════════════════════════════════════════════════════════

export type EnchantedSlotView = {
  slot: EquipmentSlot;
  itemId: string;
  itemName: string;
  itemEmoji: string;
  rarity: string;
  enchants: (EnchantStack & { label: string })[];
  /** Emplacements d'enchantement offerts par la rareté de l'objet. */
  capacity: number;
  freeSlots: number;
};

export type ScrollView = {
  itemId: string;
  itemName: string;
  itemEmoji: string;
  quantity: number;
  enchantId: string;
  enchantName: string;
  enchantEmoji: string;
  enchantDescription: string;
  tier: number;
  /** Emplacements acceptant ce parchemin. */
  slots: EnchantSlot[];
  coinCost: number;
  successChance: number;
};

export type EnchantAltarState = {
  balance: number;
  pieces: EnchantedSlotView[];
  scrolls: ScrollView[];
};

/** État complet de l'autel : équipement porté, enchantements posés, parchemins détenus. */
export async function getEnchantAltarState(guildId: string, userId: string): Promise<EnchantAltarState> {
  const profile = await prisma.rpgProfile.findUnique({
    where: { guildId_userId: { guildId, userId } },
  });
  if (!profile) return { balance: 0, pieces: [], scrolls: [] };

  const equippedIds = [profile.weaponId, profile.armorId, profile.accessoryId]
    .filter((id): id is string => Boolean(id));

  const [items, instances, scrollEntries] = await Promise.all([
    equippedIds.length > 0
      ? prisma.rpgItem.findMany({ where: { id: { in: equippedIds } } })
      : Promise.resolve([]),
    getItemInstances(profile.id, equippedIds),
    prisma.rpgInventoryItem.findMany({
      where: {
        rpgProfileId: profile.id,
        quantity: { gte: 1 },
        item: { type: SCROLL_ITEM_TYPE, enchantId: { not: null } },
      },
      include: { item: true },
    }),
  ]);

  const itemById = new Map(items.map((item) => [item.id, item]));

  const pieces: EnchantedSlotView[] = [];
  for (const slot of ['weapon', 'armor', 'accessory'] as EquipmentSlot[]) {
    const itemId = profile[SLOT_ITEM_FIELD[slot]];
    if (!itemId) continue;
    const item = itemById.get(itemId);
    if (!item) continue;

    const enchants = instances.get(itemId)?.enchants ?? [];
    const capacity = enchantCapacity(item.rarity);

    pieces.push({
      slot,
      itemId,
      itemName: item.name,
      itemEmoji: item.emoji,
      rarity: item.rarity,
      enchants: enchants.map((stack) => ({ ...stack, label: formatEnchant(stack) })),
      capacity,
      freeSlots: Math.max(0, capacity - enchants.length),
    });
  }

  const scrolls: ScrollView[] = [];
  for (const entry of scrollEntries) {
    // Un parchemin dont l'enchantement a disparu du catalogue reste dans le sac mais ne
    // s'affiche plus : il n'y a rien à poser, et l'annoncer serait promettre un échec.
    const enchant = entry.item.enchantId ? getEnchantment(entry.item.enchantId) : null;
    if (!enchant) continue;

    const tier = Math.min(enchant.maxTier, Math.max(1, entry.item.enchantTier));
    scrolls.push({
      itemId: entry.item.id,
      itemName: entry.item.name,
      itemEmoji: entry.item.emoji,
      quantity: entry.quantity,
      enchantId: enchant.id,
      enchantName: enchant.name,
      enchantEmoji: enchant.emoji,
      enchantDescription: enchant.description,
      tier,
      slots: enchant.slots,
      coinCost: enchantCost(enchant, tier),
      successChance: enchantSuccessChance(tier),
    });
  }

  return { balance: profile.balance, pieces, scrolls };
}

// ════════════════════════════════════════════════════════════════════════════
// ÉCRITURE
// ════════════════════════════════════════════════════════════════════════════

export type ApplyEnchantResult = {
  success: boolean;
  slot: EquipmentSlot;
  itemName: string;
  itemEmoji: string;
  enchantName: string;
  enchantEmoji: string;
  tier: number;
  /** Palier précédent du même enchantement, 0 s'il s'agit d'une première pose. */
  previousTier: number;
  coinCost: number;
  successChance: number;
  scrollName: string;
};

/**
 * Pose un parchemin sur l'objet porté dans un emplacement.
 *
 * Trois règles portent tout l'équilibre :
 *  - un enchantement déjà posé ne peut être que RENFORCÉ, jamais dupliqué ni rétrogradé ;
 *  - un objet n'accepte pas plus d'enchantements distincts que sa rareté n'en offre ;
 *  - un échec consomme le parchemin et les pièces sans rien retirer de ce qui est posé.
 */
export async function applyEnchantScroll(
  guildId: string,
  userId: string,
  slot: EquipmentSlot,
  scrollItemId: string,
): Promise<ApplyEnchantResult> {
  const profile = await prisma.rpgProfile.findUnique({
    where: { guildId_userId: { guildId, userId } },
  });
  if (!profile) throw new Error('Profil RPG introuvable.');

  const itemId = profile[SLOT_ITEM_FIELD[slot]];
  if (!itemId) throw new Error("Aucun objet équipé dans cet emplacement.");

  const [item, scrollEntry] = await Promise.all([
    prisma.rpgItem.findUnique({ where: { id: itemId } }),
    prisma.rpgInventoryItem.findUnique({
      where: { rpgProfileId_itemId: { rpgProfileId: profile.id, itemId: scrollItemId } },
      include: { item: true },
    }),
  ]);

  if (!item) throw new Error('Objet équipé introuvable.');
  if (!scrollEntry || scrollEntry.quantity <= 0) throw new Error('Vous ne possédez pas ce parchemin.');

  const scroll = scrollEntry.item;
  if (scroll.type !== SCROLL_ITEM_TYPE || !scroll.enchantId) {
    throw new Error("Cet objet n'est pas un parchemin d'enchantement.");
  }

  const enchant = getEnchantment(scroll.enchantId);
  if (!enchant) throw new Error("Cet enchantement n'existe plus.");

  // L'emplacement de l'objet doit figurer dans ceux acceptés par l'enchantement : c'est la
  // seule barrière qui empêche de poser « Rempart » sur une épée.
  const itemSlot = slotForItemType(item.type);
  if (!itemSlot || !enchant.slots.includes(itemSlot)) {
    throw new Error(`${enchant.name} ne peut pas être posé sur ${item.name}.`);
  }

  const instance = await ensureItemInstance(profile.id, itemId);
  const existing = instance.enchants.find((stack) => stack.id === enchant.id) ?? null;
  const previousTier = existing?.tier ?? 0;
  const tier = Math.min(enchant.maxTier, Math.max(1, scroll.enchantTier));

  if (existing && tier <= previousTier) {
    throw new Error(`${item.name} porte déjà ${enchant.name} à un palier au moins égal.`);
  }

  const capacity = enchantCapacity(item.rarity);
  if (!existing && instance.enchants.length >= capacity) {
    throw new Error(
      `${item.name} n'a plus d'emplacement libre (${capacity}). Retirez un enchantement pour en poser un autre.`,
    );
  }

  const coinCost = enchantCost(enchant, tier);
  if (profile.balance < coinCost) {
    throw new Error(`Cette pose coûte ${coinCost} pièces, vous en avez ${profile.balance}.`);
  }

  // Paiement atomique : solde suffisant, parchemin encore en stock et objet toujours porté.
  // Transaction interactive plutôt que séquence d'écritures : les deux gardes portent sur
  // des lignes différentes, et seule une exception peut annuler le débit quand le parchemin
  // vient de partir - ou rendre le parchemin quand le solde vient d'être dépensé ailleurs.
  await prisma.$transaction(async (tx) => {
    const paid = await tx.rpgProfile.updateMany({
      where: { id: profile.id, balance: { gte: coinCost }, [SLOT_ITEM_FIELD[slot]]: itemId },
      data: { balance: { decrement: coinCost } },
    });
    if (paid.count === 0) throw new Error("L'enchantement a échoué, réessayez.");

    const consumed = await tx.rpgInventoryItem.updateMany({
      where: { id: scrollEntry.id, quantity: { gte: 1 } },
      data: { quantity: { decrement: 1 } },
    });
    if (consumed.count === 0) throw new Error("L'enchantement a échoué, réessayez.");

    await tx.rpgInventoryItem.deleteMany({ where: { id: scrollEntry.id, quantity: { lte: 0 } } });
  });

  const successChance = enchantSuccessChance(tier);
  const success = Math.random() < successChance;

  if (success) {
    const next: EnchantStack[] = existing
      ? instance.enchants.map((stack) => (stack.id === enchant.id ? { ...stack, tier } : stack))
      : [...instance.enchants, { id: enchant.id, tier }];

    await prisma.rpgItemInstance.update({
      where: { id: instance.id },
      data: { enchants: next },
    });
  }

  return {
    success,
    slot,
    itemName: item.name,
    itemEmoji: item.emoji,
    enchantName: enchant.name,
    enchantEmoji: enchant.emoji,
    tier,
    previousTier,
    coinCost,
    successChance,
    scrollName: scroll.name,
  };
}

/**
 * Retire un enchantement pour libérer un emplacement. Le parchemin n'est pas rendu :
 * c'est un renoncement payant, pas une reprise.
 */
export async function removeEnchant(
  guildId: string,
  userId: string,
  slot: EquipmentSlot,
  enchantId: string,
): Promise<{ itemName: string; itemEmoji: string; enchantName: string; coinCost: number }> {
  const profile = await prisma.rpgProfile.findUnique({
    where: { guildId_userId: { guildId, userId } },
  });
  if (!profile) throw new Error('Profil RPG introuvable.');

  const itemId = profile[SLOT_ITEM_FIELD[slot]];
  if (!itemId) throw new Error("Aucun objet équipé dans cet emplacement.");

  const [item, current] = await Promise.all([
    prisma.rpgItem.findUnique({ where: { id: itemId } }),
    getItemInstance(profile.id, itemId),
  ]);

  if (!item) throw new Error('Objet équipé introuvable.');

  const enchant = getEnchantment(enchantId);
  if (!enchant) throw new Error("Cet enchantement n'existe plus.");

  if (!current || !current.enchants.some((stack) => stack.id === enchantId)) {
    throw new Error(`${item.name} ne porte pas ${enchant.name}.`);
  }

  if (profile.balance < DISENCHANT_COST) {
    throw new Error(`Ce retrait coûte ${DISENCHANT_COST} pièces, vous en avez ${profile.balance}.`);
  }

  const paid = await prisma.rpgProfile.updateMany({
    where: { id: profile.id, balance: { gte: DISENCHANT_COST } },
    data: { balance: { decrement: DISENCHANT_COST } },
  });

  if (paid.count === 0) {
    throw new Error('Le retrait a échoué, réessayez.');
  }

  await prisma.rpgItemInstance.update({
    where: { id: current.id },
    data: { enchants: current.enchants.filter((stack) => stack.id !== enchantId) },
  });

  return {
    itemName: item.name,
    itemEmoji: item.emoji,
    enchantName: enchant.name,
    coinCost: DISENCHANT_COST,
  };
}
