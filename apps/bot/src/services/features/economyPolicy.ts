type ShopItemAvailability = {
  purchasable: boolean;
  guildId: string | null;
  levelXpReward?: number;
  clanPointsReward?: number;
  raidAssaultBonus?: number;
  blackMarketEligible?: boolean;
};

/**
 * État des modules dont la boutique peut vendre les récompenses.
 *
 * `clanPointsEnabled` reprend la condition du pont RPG → clans : les clans doivent tourner
 * *et* le pont être ouvert, sinon l'achat promettrait des points que rien ne verserait.
 */
export type ShopModuleState = {
  levelingEnabled: boolean;
  clanPointsEnabled: boolean;
  raidEnabled: boolean;
};

/** Bornes des récompenses vendues, alignées sur celles des primes du bestiaire. */
export const LEVEL_XP_REWARD_RANGE = { min: 0, max: 1_000_000 } as const;
export const CLAN_POINTS_REWARD_RANGE = { min: 0, max: 100_000 } as const;
/** Une potion rend au plus quelques assauts : le plafond du serveur tranchera de toute façon. */
export const RAID_ASSAULT_BONUS_RANGE = { min: 0, max: 20 } as const;

/**
 * Un objet dont la récompense dépend d'un module éteint n'est pas vendable.
 *
 * On le retire de la vente plutôt que de le vendre inerte : le joueur paierait pour une
 * récompense qui ne serait jamais versée.
 */
export function isShopItemUnlocked(
  item: Pick<ShopItemAvailability, 'levelXpReward' | 'clanPointsReward' | 'raidAssaultBonus'>,
  modules: ShopModuleState,
): boolean {
  if ((item.levelXpReward ?? 0) > 0 && !modules.levelingEnabled) return false;
  if ((item.clanPointsReward ?? 0) > 0 && !modules.clanPointsEnabled) return false;
  // Une potion d'assaut sur un serveur sans raid ne rendrait jamais rien : elle sort de la
  // vente au même titre qu'un objet dont le module de récompense est éteint.
  if ((item.raidAssaultBonus ?? 0) > 0 && !modules.raidEnabled) return false;
  return true;
}

export function isShopItemAvailable<T extends ShopItemAvailability>(
  item: T | null,
  guildId: string,
  modules: ShopModuleState,
): item is T {
  if (!item?.purchasable) return false;
  if (item.guildId !== null && item.guildId !== guildId) return false;
  return isShopItemUnlocked(item, modules);
}

/** Un objet porte-t-il une récompense versée par un module voisin ? */
export function hasModuleReward(
  item: Pick<ShopItemAvailability, 'levelXpReward' | 'clanPointsReward' | 'raidAssaultBonus'>,
): boolean {
  return (item.levelXpReward ?? 0) > 0
    || (item.clanPointsReward ?? 0) > 0
    || (item.raidAssaultBonus ?? 0) > 0;
}

/**
 * Un objet peut-il être tiré au marché noir ?
 *
 * Le tirage brade de 20 à 50 %. L'exclusion se règle par objet via `blackMarketEligible`,
 * dont la valeur est posée à l'enregistrement : fausse par défaut pour ceux qui vendent une
 * récompense de module, leur prix étant justement l'équilibrage.
 */
export function isBlackMarketEligible(
  item: Pick<ShopItemAvailability, 'levelXpReward' | 'clanPointsReward' | 'raidAssaultBonus' | 'blackMarketEligible'>,
  modules: ShopModuleState,
): boolean {
  if (item.blackMarketEligible === false) return false;
  return isShopItemUnlocked(item, modules);
}

/** XP à franchir pour passer le niveau suivant, une guilde RPG ne connaissant pas de courbe. */
export function rpgGuildXpNeeded(level: number): number {
  return Math.max(1, Math.trunc(level) || 1) * 1000;
}

/**
 * Convertit en niveaux l'XP qu'une guilde a accumulée au-delà de son palier.
 *
 * La boucle relit le palier à chaque tour : un raid abattu verse d'un coup de quoi passer
 * plusieurs niveaux, là où un seul palier retiré laisserait l'excédent dormir en base sans
 * jamais servir.
 */
export function normalizeRpgGuildLevel(current: { level: number; xp: number }): { level: number; xp: number } {
  let level = Math.max(1, Math.trunc(current.level) || 1);
  let xp = Math.max(0, Math.trunc(current.xp) || 0);

  while (xp >= rpgGuildXpNeeded(level)) {
    xp -= rpgGuildXpNeeded(level);
    level += 1;
  }

  return { level, xp };
}
