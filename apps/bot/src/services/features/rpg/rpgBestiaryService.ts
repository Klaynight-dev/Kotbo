/**
 * Lecture du bestiaire effectif d'un serveur.
 *
 * Le catalogue livré de base est global (`guildId: null`) et partagé par tous les serveurs :
 * personne ne peut donc l'écrire. Un serveur qui personnalise un monstre global en crée une
 * copie locale portant le *même nom*, et c'est cette copie qui fait foi ici. Le nom est la
 * clé du masquage (`@@unique([guildId, name])`), ce qui permet aussi de revenir au monstre
 * d'origine en supprimant simplement la copie.
 *
 * Toute lecture du bestiaire côté jeu doit passer par ce module : interroger directement
 * `prisma.rpgMonster` avec `OR: [{ guildId: null }, { guildId }]` ferait réapparaître les
 * monstres masqués et ignorerait les désactivations.
 */

import type { RpgMonster } from '@prisma/client';
import prisma from '../../../utils/db.js';
import {
  normalizeMonsterInput,
  parseMonsterDrops,
  type MonsterInput,
  type NormalizedDrop,
} from './rpgBestiaryPolicy.js';

export type MonsterScope = 'GLOBAL' | 'GUILD';

export interface ResolvedMonster extends RpgMonster {
  /** `GUILD` dès que la ligne appartient au serveur, qu'elle soit une copie ou une création. */
  scope: MonsterScope;
  /** Vrai pour une copie locale qui masque un monstre global du même nom. */
  overridesGlobal: boolean;
}

interface ListOptions {
  isBoss?: boolean;
  /** Inclut les monstres qu'un serveur a désactivés. Réservé au dashboard. */
  includeDisabled?: boolean;
}

function resolve(rows: RpgMonster[]): ResolvedMonster[] {
  const globalNames = new Set(rows.filter((row) => row.guildId === null).map((row) => row.name));
  const overriddenNames = new Set(
    rows.filter((row) => row.guildId !== null && globalNames.has(row.name)).map((row) => row.name),
  );

  return rows
    .filter((row) => !(row.guildId === null && overriddenNames.has(row.name)))
    .map((row) => ({
      ...row,
      scope: row.guildId === null ? ('GLOBAL' as const) : ('GUILD' as const),
      overridesGlobal: row.guildId !== null && globalNames.has(row.name),
    }));
}

/** Bestiaire effectif du serveur, monstres globaux masqués et désactivés retirés. */
export async function listGuildMonsters(guildId: string, options: ListOptions = {}): Promise<ResolvedMonster[]> {
  // Le tri boss / monstre se fait après résolution : filtré en SQL, un monstre global promu
  // boss par une copie locale laisserait l'original visible en face, sous le même nom.
  const rows = await prisma.rpgMonster.findMany({
    where: { OR: [{ guildId: null }, { guildId }] },
    orderBy: [{ level: 'asc' }, { name: 'asc' }],
  });

  return resolve(rows).filter((monster) =>
    (options.includeDisabled || monster.enabled)
    && (options.isBoss === undefined || monster.isBoss === options.isBoss));
}

/**
 * Retrouve un monstre jouable par son identifiant.
 *
 * Renvoie `null` si la ligne appartient à un autre serveur, si elle est désactivée, ou si
 * c'est un monstre global que ce serveur a personnalisé : un identifiant collé dans un
 * `customId` Discord peut survivre à la personnalisation.
 */
export async function findGuildMonsterById(guildId: string, monsterId: string): Promise<ResolvedMonster | null> {
  const monster = await prisma.rpgMonster.findUnique({ where: { id: monsterId } });
  if (!monster || (monster.guildId !== null && monster.guildId !== guildId)) return null;
  if (!monster.enabled) return null;

  if (monster.guildId === null) {
    const override = await prisma.rpgMonster.findUnique({
      where: { guildId_name: { guildId, name: monster.name } },
    });
    if (override) return override.enabled ? { ...override, scope: 'GUILD', overridesGlobal: true } : null;
    return { ...monster, scope: 'GLOBAL', overridesGlobal: false };
  }

  const globalTwin = await prisma.rpgMonster.findFirst({
    where: { guildId: null, name: monster.name },
    select: { id: true },
  });
  return { ...monster, scope: 'GUILD', overridesGlobal: globalTwin !== null };
}

export class BestiaryError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'BestiaryError';
  }
}

async function assertDropsAreKnownItems(guildId: string, drops: NormalizedDrop[]): Promise<void> {
  if (drops.length === 0) return;

  const items = await prisma.rpgItem.findMany({
    where: { OR: [{ guildId: null }, { guildId }], name: { in: drops.map((drop) => drop.itemName) } },
    select: { name: true },
  });
  const known = new Set(items.map((item) => item.name));
  const unknown = drops.find((drop) => !known.has(drop.itemName));
  // Un butin dont l'objet n'existe pas est annoncé au joueur puis jamais versé : autant
  // le refuser à la saisie plutôt que de livrer une récompense fantôme.
  if (unknown) {
    throw new BestiaryError(`L'objet « ${unknown.itemName} » n'existe pas dans le catalogue.`, 400);
  }
}

async function assertNameIsFree(guildId: string, name: string, exceptId?: string): Promise<void> {
  const twin = await prisma.rpgMonster.findFirst({
    where: {
      OR: [{ guildId: null }, { guildId }],
      name,
      ...(exceptId ? { NOT: { id: exceptId } } : {}),
    },
    select: { guildId: true },
  });
  if (!twin) return;

  throw new BestiaryError(
    twin.guildId === null
      ? `Un monstre livré de base se nomme déjà « ${name} » : personnalisez-le au lieu d'en créer un second.`
      : `Un monstre de ce serveur se nomme déjà « ${name} ».`,
    409,
  );
}

/**
 * Crée ou met à jour un monstre du serveur.
 *
 * Modifier un monstre global n'écrit jamais la ligne globale : on en dépose une copie
 * locale de même nom, qui le masque. Le nom d'une telle copie est verrouillé, puisque c'est
 * lui qui porte le masquage.
 */
export async function saveGuildMonster(
  guildId: string,
  input: MonsterInput,
  monsterId?: string,
): Promise<{ monster: RpgMonster; created: boolean; overrode: boolean }> {
  const normalized = normalizeMonsterInput(input);
  if (!normalized.ok) throw new BestiaryError(normalized.error, 400);
  const data = normalized.value;

  await assertDropsAreKnownItems(guildId, data.drops);

  const payload = {
    name: data.name,
    description: data.description,
    emoji: data.emoji,
    level: data.level,
    health: data.health,
    attack: data.attack,
    defense: data.defense,
    speed: data.speed,
    xpReward: data.xpReward,
    coinReward: data.coinReward,
    drops: data.drops,
    isBoss: data.isBoss,
    bossRespawnHours: data.bossRespawnHours,
    clanPoints: data.clanPoints,
    enabled: data.enabled,
  };

  if (!monsterId) {
    await assertNameIsFree(guildId, data.name);

    const monster = await prisma.rpgMonster.create({ data: { guildId, ...payload } });
    return { monster, created: true, overrode: false };
  }

  const existing = await prisma.rpgMonster.findUnique({ where: { id: monsterId } });
  if (!existing) throw new BestiaryError('Monstre introuvable.', 404);
  if (existing.guildId !== null && existing.guildId !== guildId) {
    throw new BestiaryError('Ce monstre appartient à un autre serveur.', 403);
  }

  const globalTwin = existing.guildId === null
    ? existing
    : await prisma.rpgMonster.findFirst({ where: { guildId: null, name: existing.name }, select: { id: true } });

  if (data.name !== existing.name) {
    if (globalTwin) {
      throw new BestiaryError(
        "Le nom d'un monstre livré de base ne peut pas être changé : il sert à retrouver l'original.",
        400,
      );
    }
    await assertNameIsFree(guildId, data.name, existing.id);
  }

  if (existing.guildId === null) {
    const monster = await prisma.rpgMonster.upsert({
      where: { guildId_name: { guildId, name: existing.name } },
      create: { guildId, ...payload },
      update: payload,
    });
    return { monster, created: false, overrode: true };
  }

  const monster = await prisma.rpgMonster.update({ where: { id: existing.id }, data: payload });
  return { monster, created: false, overrode: globalTwin !== null };
}

/** Active ou désactive un monstre, en passant par une copie locale s'il est global. */
export async function setGuildMonsterEnabled(
  guildId: string,
  monsterId: string,
  enabled: boolean,
): Promise<RpgMonster> {
  const existing = await prisma.rpgMonster.findUnique({ where: { id: monsterId } });
  if (!existing) throw new BestiaryError('Monstre introuvable.', 404);
  if (existing.guildId !== null && existing.guildId !== guildId) {
    throw new BestiaryError('Ce monstre appartient à un autre serveur.', 403);
  }

  if (existing.guildId !== null) {
    return prisma.rpgMonster.update({ where: { id: existing.id }, data: { enabled } });
  }

  return prisma.rpgMonster.upsert({
    where: { guildId_name: { guildId, name: existing.name } },
    create: {
      guildId,
      name: existing.name,
      description: existing.description,
      emoji: existing.emoji,
      level: existing.level,
      health: existing.health,
      attack: existing.attack,
      defense: existing.defense,
      speed: existing.speed,
      xpReward: existing.xpReward,
      coinReward: existing.coinReward,
      drops: parseMonsterDrops(existing.drops),
      isBoss: existing.isBoss,
      bossRespawnHours: existing.bossRespawnHours,
      clanPoints: existing.clanPoints,
      enabled,
    },
    update: { enabled },
  });
}

/**
 * Supprime un monstre du serveur.
 *
 * Sur une copie locale, cela rend au serveur le monstre global d'origine. Les combats
 * livrés contre la copie disparaissent avec elle (cascade), ce qui remet aussi à zéro le
 * délai de réapparition des boss.
 */
export async function deleteGuildMonster(
  guildId: string,
  monsterId: string,
): Promise<{ monster: RpgMonster; restoredGlobal: boolean }> {
  const existing = await prisma.rpgMonster.findUnique({ where: { id: monsterId } });
  if (!existing) throw new BestiaryError('Monstre introuvable.', 404);
  if (existing.guildId === null) {
    throw new BestiaryError(
      "Un monstre livré de base ne peut pas être supprimé : désactivez-le pour le retirer de ce serveur.",
      403,
    );
  }
  if (existing.guildId !== guildId) {
    throw new BestiaryError('Ce monstre appartient à un autre serveur.', 403);
  }

  const globalTwin = await prisma.rpgMonster.findFirst({
    where: { guildId: null, name: existing.name },
    select: { id: true },
  });

  await prisma.rpgMonster.delete({ where: { id: existing.id } });
  return { monster: existing, restoredGlobal: globalTwin !== null };
}

/**
 * Répercute sur le bestiaire du serveur le renommage ou la suppression d'un objet.
 *
 * Un butin désigne son objet **par son nom** : renommer ou supprimer l'objet sans toucher
 * aux monstres laisse un butin fantôme, annoncé au joueur puis jamais versé - exactement ce
 * que la validation refuse à la saisie. Les monstres globaux ne sont pas modifiés : ils sont
 * partagés par tous les serveurs, et leurs butins désignent des objets globaux.
 *
 * @param replacement Nouveau nom, ou `null` pour retirer le butin.
 * @returns Nombre de monstres réécrits.
 */
export async function syncDropReferences(
  guildId: string,
  itemName: string,
  replacement: string | null,
): Promise<number> {
  if (replacement === itemName) return 0;

  const monsters = await prisma.rpgMonster.findMany({ where: { guildId } });
  let touched = 0;

  for (const monster of monsters) {
    const drops = parseMonsterDrops(monster.drops);
    if (!drops.some((drop) => drop.itemName === itemName)) continue;

    const next = replacement === null
      ? drops.filter((drop) => drop.itemName !== itemName)
      // Le nouveau nom peut déjà figurer dans le butin : on ne garde qu'une entrée, la
      // meilleure chance, plutôt que de créer un doublon que la saisie refuserait.
      : dedupeDrops(drops.map((drop) => (drop.itemName === itemName ? { ...drop, itemName: replacement } : drop)));

    await prisma.rpgMonster.update({ where: { id: monster.id }, data: { drops: next } });
    touched += 1;
  }

  return touched;
}

function dedupeDrops(drops: NormalizedDrop[]): NormalizedDrop[] {
  const byName = new Map<string, NormalizedDrop>();
  for (const drop of drops) {
    const known = byName.get(drop.itemName);
    if (!known || drop.chance > known.chance) byName.set(drop.itemName, drop);
  }
  return [...byName.values()];
}
