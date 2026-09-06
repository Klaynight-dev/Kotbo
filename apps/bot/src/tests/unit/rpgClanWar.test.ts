import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';

/**
 * Front RPG de la guerre des équipes.
 *
 * Deux garde-fous à tenir : ne compter que ce que le RPG a rapporté (les points
 * d'un pari ou d'un message n'ont rien à faire dans un tableau de guerre), et
 * fermer le front plutôt que d'afficher un classement mort quand le serveur a
 * coupé les clans ou le pont qui les alimente.
 */

type GuildRow = { clansEnabled: boolean; clanPointsFromRpg: boolean; currentClanSeason: number } | null;
type EconomyRow = { raidTeamMode: string; guildsEnabled: boolean };

let guildRow: GuildRow = { clansEnabled: true, clanPointsFromRpg: true, currentClanSeason: 3 };
let economyRow: EconomyRow = { raidTeamMode: 'CLAN', guildsEnabled: true };
let clanRows: { id: string; name: string; roleId: string }[] = [];
let eventTotals: { clanId: string; _sum: { amount: number } }[] = [];
let contributorTotals: { userId: string; _sum: { amount: number } }[] = [];

/** Dernier filtre reçu par `groupBy`, pour vérifier ce qui est réellement compté. */
let lastGroupByArgs: { by: string[]; where: Record<string, unknown> } | null = null;

const groupBy = mock((args: { by: string[]; where: Record<string, unknown> }) => {
  lastGroupByArgs = args;
  return Promise.resolve(args.by[0] === 'clanId' ? eventTotals : contributorTotals);
});

const mockDb = {
  guild: { findUnique: mock(() => Promise.resolve(guildRow)) },
  clan: { findMany: mock(() => Promise.resolve(clanRows)) },
  clanContributionEvent: { groupBy },
  rpgGuild: { findMany: mock(() => Promise.resolve([])) },
  rpgProfile: { findUnique: mock(() => Promise.resolve(null)), findMany: mock(() => Promise.resolve([])) },
};

const dbPath = path.resolve(import.meta.dir, '../../utils/db.ts');
const dbJsPath = path.resolve(import.meta.dir, '../../utils/db.js');
mock.module(dbPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
mock.module(dbJsPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));

const economyPath = path.resolve(import.meta.dir, '../../services/features/economyService.ts');
const economyJsPath = path.resolve(import.meta.dir, '../../services/features/economyService.js');
const economyStub = () => ({ getOrCreateEconomyConfig: () => Promise.resolve(economyRow) });
mock.module(economyPath, economyStub);
mock.module(economyJsPath, economyStub);

const { asClanWarScope, getClanWarState, RPG_CLAN_WAR_SOURCES } =
  await import('../../services/features/rpg/rpgClanWarService');

/** Membre Discord minimal : seul le porteur de rôles est lu en mode clan. */
function fakeMember(id: string, roleIds: string[]) {
  return {
    id,
    roles: { cache: { has: (roleId: string) => roleIds.includes(roleId) } },
    guild: { roles: { cache: { get: () => ({ members: { size: 4 } }) } } },
  } as unknown as import('discord.js').GuildMember;
}

beforeEach(() => {
  guildRow = { clansEnabled: true, clanPointsFromRpg: true, currentClanSeason: 3 };
  economyRow = { raidTeamMode: 'CLAN', guildsEnabled: true };
  clanRows = [
    { id: 'clan-a', name: 'Aurore', roleId: 'role-a' },
    { id: 'clan-b', name: 'Boréale', roleId: 'role-b' },
  ];
  eventTotals = [
    { clanId: 'clan-b', _sum: { amount: 320 } },
    { clanId: 'clan-a', _sum: { amount: 120 } },
  ];
  contributorTotals = [
    { userId: 'joueur', _sum: { amount: 45 } },
    { userId: 'autre', _sum: { amount: 75 } },
  ];
  lastGroupByArgs = null;
  groupBy.mockClear();
});

describe('asClanWarScope', () => {
  test('ne retient que la semaine, tout le reste étant la saison', () => {
    expect(asClanWarScope('week')).toBe('week');
    expect(asClanWarScope('season')).toBe('season');
    // La portée vient d'un `customId`, donc du client : une valeur inventée ne
    // doit pas produire de fenêtre vide.
    expect(asClanWarScope('trimestre')).toBe('season');
    expect(asClanWarScope(undefined)).toBe('season');
  });
});

describe('getClanWarState - mode clan', () => {
  test('classe les clans sur la seule part RPG de la saison en cours', async () => {
    const state = await getClanWarState({
      guildId: 'g1',
      userId: 'joueur',
      member: fakeMember('joueur', ['role-a']),
    });

    expect(state.closure).toBeNull();
    expect(state.season).toBe(3);
    expect(state.standings.map((team) => team.name)).toEqual(['Boréale', 'Aurore']);

    const where = lastGroupByArgs?.where as { source: { in: string[] }; season: number };
    expect(where.season).toBe(3);
    expect(where.source.in).toEqual([...RPG_CLAN_WAR_SOURCES]);
  });

  test('situe le joueur dans son clan et compte sa seule part', async () => {
    const state = await getClanWarState({
      guildId: 'g1',
      userId: 'joueur',
      member: fakeMember('joueur', ['role-a']),
    });

    expect(state.viewer.teamName).toBe('Aurore');
    expect(state.viewer.rank).toBe(2);
    expect(state.viewer.points).toBe(45);
    // Les meilleurs pourvoyeurs sont triés, pas rendus dans l'ordre de la base.
    expect(state.topContributors.map((entry) => entry.userId)).toEqual(['autre', 'joueur']);
  });

  test('garde un clan sans prise au tableau plutôt que de le faire disparaître', async () => {
    eventTotals = [{ clanId: 'clan-b', _sum: { amount: 10 } }];

    const state = await getClanWarState({ guildId: 'g1', userId: 'joueur', member: null });

    expect(state.standings.map((team) => [team.name, team.points])).toEqual([
      ['Boréale', 10],
      ['Aurore', 0],
    ]);
    // Sans membre, l'appartenance est illisible : le tableau reste consultable.
    expect(state.viewer.teamKey).toBeNull();
    expect(state.topContributors).toEqual([]);
  });

  test('restreint le décompte à la semaine quand la portée le demande', async () => {
    await getClanWarState({
      guildId: 'g1',
      userId: 'joueur',
      member: fakeMember('joueur', ['role-a']),
      scope: 'week',
    });

    const where = lastGroupByArgs?.where as { createdAt?: { gte: Date } };
    expect(where.createdAt?.gte).toBeInstanceOf(Date);
    expect(where.createdAt!.gte.getDay()).toBe(1);
    expect(where.createdAt!.gte.getHours()).toBe(0);
  });

  test('ferme le front quand le module Clans est éteint', async () => {
    guildRow = { clansEnabled: false, clanPointsFromRpg: true, currentClanSeason: 3 };

    const state = await getClanWarState({ guildId: 'g1', userId: 'joueur', member: null });

    expect(state.closure).toBe('CLANS_OFF');
    expect(state.standings).toEqual([]);
    expect(groupBy).not.toHaveBeenCalled();
  });

  test('ferme le front quand le pont RPG → Clans est coupé', async () => {
    guildRow = { clansEnabled: true, clanPointsFromRpg: false, currentClanSeason: 3 };

    const state = await getClanWarState({ guildId: 'g1', userId: 'joueur', member: null });

    expect(state.closure).toBe('BRIDGE_OFF');
    expect(groupBy).not.toHaveBeenCalled();
  });
});

describe('getClanWarState - mode guilde RPG', () => {
  test('ferme le front quand les guildes sont désactivées', async () => {
    economyRow = { raidTeamMode: 'RPG_GUILD', guildsEnabled: false };

    const state = await getClanWarState({ guildId: 'g1', userId: 'joueur', member: null });

    expect(state.closure).toBe('GUILDS_OFF');
    expect(state.mode).toBe('RPG_GUILD');
  });

  test('classe les guildes par niveau avant progression en cours', async () => {
    economyRow = { raidTeamMode: 'RPG_GUILD', guildsEnabled: true };
    mockDb.rpgGuild.findMany = mock(() => Promise.resolve([
      { id: 'g-petite', name: 'Petite', level: 2, xp: 900, _count: { members: 3 } },
      { id: 'g-grande', name: 'Grande', level: 5, xp: 10, _count: { members: 8 } },
    ])) as typeof mockDb.rpgGuild.findMany;

    const state = await getClanWarState({ guildId: 'g1', userId: 'joueur', member: null });

    // Une guilde de niveau 5 en début de barre passe devant une niveau 2 presque
    // pleine : sans quoi le classement se jouerait sur la barre, pas le niveau.
    expect(state.standings.map((team) => team.name)).toEqual(['Grande', 'Petite']);
    expect(state.standings[0].level).toBe(5);
    expect(state.standings[0].members).toBe(8);
  });
});
