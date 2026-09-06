/**
 * Bornes et normalisation d'une fiche de monstre saisie au dashboard.
 *
 * Aucun accès base : ces règles décident de l'équilibrage (un boss à 10 millions de PV ou
 * un butin garanti à 100 % ruinent la progression) et doivent rester vérifiables en test.
 */

export const MONSTER_NAME_MAX = 60;
export const MONSTER_DESCRIPTION_MAX = 400;
export const MONSTER_DROPS_MAX = 8;

export const LEVEL_RANGE = { min: 1, max: 100 } as const;
export const HEALTH_RANGE = { min: 1, max: 100_000 } as const;
export const STAT_RANGE = { min: 0, max: 10_000 } as const;
export const REWARD_RANGE = { min: 0, max: 1_000_000 } as const;
export const RESPAWN_HOURS_RANGE = { min: 1, max: 720 } as const;
export const CLAN_POINTS_RANGE = { min: 0, max: 100_000 } as const;
export const COIN_BONUS_RANGE = { min: 0, max: 1_000_000 } as const;

export interface MonsterDropInput {
  itemName?: unknown;
  emoji?: unknown;
  chance?: unknown;
  coinBonus?: unknown;
}

export interface MonsterInput {
  name?: unknown;
  description?: unknown;
  emoji?: unknown;
  level?: unknown;
  health?: unknown;
  attack?: unknown;
  defense?: unknown;
  speed?: unknown;
  xpReward?: unknown;
  coinReward?: unknown;
  drops?: unknown;
  isBoss?: unknown;
  bossRespawnHours?: unknown;
  clanPoints?: unknown;
  enabled?: unknown;
}

/** Alias de type et non interface : Prisma refuse une interface en colonne `Json`. */
export type NormalizedDrop = {
  itemName: string;
  emoji: string;
  chance: number;
  coinBonus: number;
};

export interface NormalizedMonster {
  name: string;
  description: string;
  emoji: string;
  level: number;
  health: number;
  attack: number;
  defense: number;
  speed: number;
  xpReward: number;
  coinReward: number;
  drops: NormalizedDrop[];
  isBoss: boolean;
  bossRespawnHours: number | null;
  clanPoints: number;
  enabled: boolean;
}

export type NormalizeResult =
  | { ok: true; value: NormalizedMonster }
  | { ok: false; error: string };

function clampInt(value: unknown, range: { min: number; max: number }, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.trunc(parsed)));
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** La chance est stockée en fraction (0-1) mais saisie en pourcentage : les deux sont acceptées. */
function normalizeChance(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const fraction = parsed > 1 ? parsed / 100 : parsed;
  if (fraction <= 0) return null;
  return Math.min(1, Math.round(fraction * 1000) / 1000);
}

export function normalizeMonsterInput(input: MonsterInput): NormalizeResult {
  const name = text(input.name);
  if (!name) return { ok: false, error: 'Le nom du monstre est obligatoire.' };
  if (name.length > MONSTER_NAME_MAX) {
    return { ok: false, error: `Le nom du monstre ne peut pas dépasser ${MONSTER_NAME_MAX} caractères.` };
  }

  const description = text(input.description).slice(0, MONSTER_DESCRIPTION_MAX);
  if (!description) return { ok: false, error: 'La description du monstre est obligatoire.' };

  const rawDrops = input.drops === undefined ? [] : input.drops;
  if (!Array.isArray(rawDrops)) return { ok: false, error: 'Le butin doit être une liste.' };
  if (rawDrops.length > MONSTER_DROPS_MAX) {
    return { ok: false, error: `Un monstre ne peut pas avoir plus de ${MONSTER_DROPS_MAX} butins.` };
  }

  const drops: NormalizedDrop[] = [];
  const seen = new Set<string>();
  for (const raw of rawDrops as MonsterDropInput[]) {
    const itemName = text(raw?.itemName);
    if (!itemName) return { ok: false, error: 'Chaque butin doit désigner un objet.' };
    if (seen.has(itemName)) return { ok: false, error: `L'objet « ${itemName} » est présent deux fois dans le butin.` };
    seen.add(itemName);

    const chance = normalizeChance(raw?.chance);
    if (chance === null) return { ok: false, error: `Chance de drop invalide pour « ${itemName} ».` };

    drops.push({
      itemName,
      emoji: text(raw?.emoji) || '📦',
      chance,
      coinBonus: clampInt(raw?.coinBonus, COIN_BONUS_RANGE, 0),
    });
  }

  const isBoss = input.isBoss === true;
  // Un boss sans délai de réapparition se farme en boucle : le respawn n'est donc
  // optionnel que pour les monstres ordinaires, qui n'ont pas de cooldown dédié.
  const bossRespawnHours = isBoss
    ? clampInt(input.bossRespawnHours, RESPAWN_HOURS_RANGE, RESPAWN_HOURS_RANGE.min)
    : null;

  return {
    ok: true,
    value: {
      name,
      description,
      emoji: text(input.emoji) || '👹',
      level: clampInt(input.level, LEVEL_RANGE, 1),
      health: clampInt(input.health, HEALTH_RANGE, 50),
      attack: clampInt(input.attack, STAT_RANGE, 8),
      defense: clampInt(input.defense, STAT_RANGE, 5),
      speed: clampInt(input.speed, STAT_RANGE, 5),
      xpReward: clampInt(input.xpReward, REWARD_RANGE, 20),
      coinReward: clampInt(input.coinReward, REWARD_RANGE, 10),
      drops,
      isBoss,
      bossRespawnHours,
      clanPoints: clampInt(input.clanPoints, CLAN_POINTS_RANGE, 0),
      enabled: input.enabled !== false,
    },
  };
}

/**
 * Relit la colonne `drops` d'un monstre.
 *
 * Les premiers seeds y ont écrit une *chaîne* JSON là où les suivants stockent un tableau
 * natif : les deux formes cohabitent en base et doivent être lues indifféremment.
 */
export function parseMonsterDrops(value: unknown): NormalizedDrop[] {
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
    const drop = entry as MonsterDropInput;
    const itemName = text(drop?.itemName);
    const chance = normalizeChance(drop?.chance);
    if (!itemName || chance === null) return [];
    return [{
      itemName,
      emoji: text(drop?.emoji) || '📦',
      chance,
      coinBonus: clampInt(drop?.coinBonus, COIN_BONUS_RANGE, 0),
    }];
  });
}

/**
 * Décide si une victoire doit verser des points de clan.
 *
 * Les trois conditions sont indépendantes et toutes nécessaires : un serveur peut avoir
 * réglé des primes sur son bestiaire puis éteint les clans, ou ouvert le pont puis éteint
 * les clans. Dans ces cas la prime reste en base, dormante, et rien ne doit être versé -
 * ni tenté.
 */
export function shouldAwardClanPoints(
  guild: { clansEnabled: boolean; clanPointsFromRpg: boolean } | null,
  clanPoints: number,
): boolean {
  if (!guild?.clansEnabled || !guild.clanPointsFromRpg) return false;
  return Number.isFinite(clanPoints) && clanPoints > 0;
}
