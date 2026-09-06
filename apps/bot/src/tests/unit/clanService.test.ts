import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';

// Mock the database dependency
const mockDb = {
  guild: {
    findUnique: mock((): Promise<unknown> => Promise.resolve({ clansEnabled: true })),
  },
  linkedAccount: {
    findFirst: mock((): Promise<unknown> => Promise.resolve(null)),
  },
  clan: {
    findMany: mock((): Promise<unknown[]> => Promise.resolve([])),
  },
  memberLevel: {
    findUnique: mock((_options?: unknown): Promise<unknown> => Promise.resolve(null)),
  },
  clanMemberContribution: {
    findMany: mock((): Promise<unknown[]> => Promise.resolve([])),
    findUnique: mock((): Promise<unknown> => Promise.resolve(null)),
    upsert: mock((): Promise<unknown> => Promise.resolve({ xp: 0 })),
    update: mock((): Promise<unknown> => Promise.resolve({})),
    delete: mock((): Promise<unknown> => Promise.resolve({})),
  },
  clanPointDebt: {
    findUnique: mock((): Promise<unknown> => Promise.resolve(null)),
    update: mock((): Promise<unknown> => Promise.resolve({})),
    delete: mock((): Promise<unknown> => Promise.resolve({})),
  },
  // Exécute la callback avec le mock lui-même en guise de client transactionnel
  $transaction: mock((fn: (tx: typeof mockDb) => unknown) => Promise.resolve(fn(mockDb))),
};

const dbPath = path.resolve(import.meta.dir, '../../utils/db.ts');
const dbJsPath = path.resolve(import.meta.dir, '../../utils/db.js');

mock.module(dbPath, () => ({
  default: mockDb,
  prisma: mockDb,
  prismaRead: mockDb,
}));

mock.module(dbJsPath, () => ({
  default: mockDb,
  prisma: mockDb,
  prismaRead: mockDb,
}));

// Mock Discord Client & getClient helper
const mockDiscordMember1 = {
  user: { tag: 'User1#0001' },
  roles: {
    cache: {
      has: mock((roleId: string): boolean => roleId === 'role-clan-1'),
    },
    add: mock(() => Promise.resolve({})),
    remove: mock(() => Promise.resolve({})),
  },
};

const mockDiscordMember2 = {
  user: { tag: 'User2#0002' },
  roles: {
    cache: {
      has: mock((roleId: string): boolean => roleId === 'role-clan-2'),
    },
    add: mock(() => Promise.resolve({})),
    remove: mock(() => Promise.resolve({})),
  },
};

const mockDiscordGuild = {
  members: {
    cache: {
      get: mock((userId: string) => {
        if (userId === 'user-1') return mockDiscordMember1;
        if (userId === 'user-2') return mockDiscordMember2;
        return null;
      }),
    },
    fetch: mock((userId: string) => {
      if (userId === 'user-1') return Promise.resolve(mockDiscordMember1);
      if (userId === 'user-2') return Promise.resolve(mockDiscordMember2);
      return Promise.resolve(null);
    }),
  },
};

const mockClient = {
  guilds: {
    cache: {
      get: mock(() => mockDiscordGuild),
    },
    fetch: mock(() => Promise.resolve(mockDiscordGuild)),
  },
};

const clientPath = path.resolve(import.meta.dir, '../../utils/client.ts');
const clientJsPath = path.resolve(import.meta.dir, '../../utils/client.js');

mock.module(clientPath, () => ({
  getClient: () => mockClient,
}));

mock.module(clientJsPath, () => ({
  getClient: () => mockClient,
}));

// Now import the service we want to test
import { syncMemberClanFromDcLink, buildCategoryName, stripTrophyTag, creditClanContribution } from '../../services/community/clanService.js';
import { MAX_CLAN_SEASON_POINTS } from '@kotbo/shared';

describe('balise de champion sur les QG', () => {
  test('retire la balise où qu\'elle se trouve dans le nom', () => {
    expect(stripTrophyTag('QG Alpha [🏆 CHAMPION]')).toBe('QG Alpha');
    expect(stripTrophyTag('[🏆 CHAMPION] QG Alpha')).toBe('QG Alpha');
    expect(stripTrophyTag('QG [🏆 CHAMPION · +20% XP] Alpha')).toBe('QG Alpha');
    expect(stripTrophyTag('QG Alpha')).toBe('QG Alpha');
  });

  test('un perdant repart du nom nettoyé', () => {
    expect(buildCategoryName('QG Alpha [🏆 CHAMPION]', false)).toBe('QG Alpha');
    expect(buildCategoryName('QG Alpha', false)).toBe('QG Alpha');
  });

  test('un gagnant est marqué une seule fois, bonus compris', () => {
    expect(buildCategoryName('QG Alpha', true)).toBe('QG Alpha [🏆 CHAMPION]');
    expect(buildCategoryName('QG Alpha', true, ['+20% XP', 'GIVEAWAY BOOST']))
      .toBe('QG Alpha [🏆 CHAMPION · +20% XP + GIVEAWAY BOOST]');
    // Deux clôtures d'affilée ne doivent pas empiler les balises.
    const once = buildCategoryName('QG Alpha', true);
    expect(buildCategoryName(once, true)).toBe(once);
  });
});

describe('ajustement manuel des points de clan', () => {
  const params = { guildId: 'guild-123', clanId: 'clan-1', userId: 'user-1', season: 1 };

  beforeEach(() => {
    mockDb.clanMemberContribution.findUnique.mockClear();
    mockDb.clanMemberContribution.upsert.mockClear();
    mockDb.clanMemberContribution.update.mockClear();
    mockDb.clanMemberContribution.findUnique.mockResolvedValue({ xp: 500 });
    mockDb.clanPointDebt.findUnique.mockClear();
    mockDb.clanPointDebt.update.mockClear();
    mockDb.clanPointDebt.delete.mockClear();
    mockDb.clanPointDebt.findUnique.mockResolvedValue(null);
  });

  test('un retrait qui laisse un total positif est inscrit tel quel', async () => {
    mockDb.clanMemberContribution.upsert.mockResolvedValue({ xp: 400 });

    const { granted } = await creditClanContribution({ ...params, amount: -100 });

    expect(granted).toBe(-100);
    expect(mockDb.clanMemberContribution.update).not.toHaveBeenCalled();
  });

  test('un retrait plus grand que le total ramène à zéro sans passer négatif', async () => {
    mockDb.clanMemberContribution.findUnique.mockResolvedValue({ xp: 70 });
    mockDb.clanMemberContribution.upsert.mockResolvedValue({ xp: -30 });
    mockDb.clanMemberContribution.update.mockResolvedValue({ xp: 0 });

    const { granted, contribution } = await creditClanContribution({ ...params, amount: -100 });

    expect(granted).toBe(-70);
    expect(contribution?.xp).toBe(0);
    expect(mockDb.clanMemberContribution.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { xp: 0 } }),
    );
  });

  test('un retrait sur une ligne inexistante ne crée rien', async () => {
    mockDb.clanMemberContribution.findUnique.mockResolvedValue(null);

    const { granted } = await creditClanContribution({ ...params, amount: -100 });

    expect(granted).toBe(0);
    expect(mockDb.clanMemberContribution.upsert).not.toHaveBeenCalled();
  });

  test('le pseudo-membre des points de clan peut porter un solde négatif', async () => {
    mockDb.clanMemberContribution.findUnique.mockResolvedValue(null);
    mockDb.clanMemberContribution.upsert.mockResolvedValue({ xp: -500 });

    const { granted } = await creditClanContribution({
      ...params,
      userId: 'system_manual_points',
      amount: -500,
      allowNegativeBalance: true,
    });

    expect(granted).toBe(-500);
    expect(mockDb.clanMemberContribution.update).not.toHaveBeenCalled();
  });

  test('un solde négatif reste borné à l\'opposé du plafond de saison', async () => {
    mockDb.clanMemberContribution.findUnique.mockResolvedValue({ xp: -MAX_CLAN_SEASON_POINTS });
    mockDb.clanMemberContribution.upsert.mockResolvedValue({ xp: -MAX_CLAN_SEASON_POINTS - 40 });
    mockDb.clanMemberContribution.update.mockResolvedValue({ xp: -MAX_CLAN_SEASON_POINTS });

    const { granted } = await creditClanContribution({
      ...params,
      userId: 'system_manual_points',
      amount: -100,
      allowNegativeBalance: true,
    });

    expect(granted).toBe(-60);
    expect(mockDb.clanMemberContribution.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { xp: -MAX_CLAN_SEASON_POINTS } }),
    );
  });

  test('un ajout au-delà du plafond de saison est rogné', async () => {
    mockDb.clanMemberContribution.upsert.mockResolvedValue({ xp: MAX_CLAN_SEASON_POINTS + 40 });
    mockDb.clanMemberContribution.update.mockResolvedValue({ xp: MAX_CLAN_SEASON_POINTS });

    const { granted } = await creditClanContribution({ ...params, amount: 100 });

    expect(granted).toBe(60);
  });

  test('un montant nul ne touche pas la base', async () => {
    const { granted } = await creditClanContribution({ ...params, amount: 0 });

    expect(granted).toBe(0);
    expect(mockDb.clanMemberContribution.upsert).not.toHaveBeenCalled();
  });
});

describe('clan service DC sync tests', () => {
  beforeEach(() => {
    mockDb.guild.findUnique.mockClear();
    mockDb.linkedAccount.findFirst.mockClear();
    mockDb.clan.findMany.mockClear();
    mockDb.memberLevel.findUnique.mockClear();
    mockDb.clanMemberContribution.findMany.mockClear();
    mockDb.clanMemberContribution.findUnique.mockClear();
    mockDb.clanMemberContribution.update.mockClear();
    mockDb.clanMemberContribution.delete.mockClear();

    mockDiscordMember1.roles.add.mockClear();
    mockDiscordMember1.roles.remove.mockClear();
    mockDiscordMember2.roles.add.mockClear();
    mockDiscordMember2.roles.remove.mockClear();

    // Reset default mock behaviors
    mockDb.guild.findUnique.mockResolvedValue({ clansEnabled: true });
    mockDb.clan.findMany.mockResolvedValue([
      { id: 'clan-1', name: 'Clan One', roleId: 'role-clan-1' },
      { id: 'clan-2', name: 'Clan Two', roleId: 'role-clan-2' },
    ]);
  });

  test('should return early if clans are not enabled', async () => {
    mockDb.guild.findUnique.mockResolvedValue({ clansEnabled: false });

    await syncMemberClanFromDcLink('guild-123', 'user-1', 'user-2');

    expect(mockDb.clan.findMany).not.toHaveBeenCalled();
  });

  test('should assign clan to member who does not have one', async () => {
    // Member 1 has clan-1, Member 2 has no clan
    mockDiscordMember1.roles.cache.has.mockImplementation((roleId) => roleId === 'role-clan-1');
    mockDiscordMember2.roles.cache.has.mockImplementation(() => false);

    await syncMemberClanFromDcLink('guild-123', 'user-1', 'user-2');

    expect(mockDiscordMember2.roles.add).toHaveBeenCalledWith('role-clan-1', expect.any(String));
    expect(mockDiscordMember1.roles.add).not.toHaveBeenCalled();
  });

  test('should align double accounts with different clans to the one with highest MemberLevel XP', async () => {
    // Member 1 has clan-1, Member 2 has clan-2
    mockDiscordMember1.roles.cache.has.mockImplementation((roleId) => roleId === 'role-clan-1');
    mockDiscordMember2.roles.cache.has.mockImplementation((roleId) => roleId === 'role-clan-2');

    // Member 1 has 500 XP, Member 2 has 100 XP
    mockDb.memberLevel.findUnique.mockImplementation(async (options: any) => {
      if (options.where.guildId_userId.userId === 'user-1') return { xp: 500 };
      if (options.where.guildId_userId.userId === 'user-2') return { xp: 100 };
      return null;
    });

    // Mock contributions migration: Member 2 has a contribution in clan-2 for season 1
    mockDb.clanMemberContribution.findMany.mockResolvedValue([
      { id: 'contrib-alt', guildId: 'guild-123', clanId: 'clan-2', userId: 'user-2', xp: 50, season: 1 },
    ]);
    // Member 2 already has a contribution in target clan-1 (to test fusion)
    mockDb.clanMemberContribution.findUnique.mockResolvedValue({
      id: 'contrib-main', guildId: 'guild-123', clanId: 'clan-1', userId: 'user-2', xp: 100, season: 1
    });

    await syncMemberClanFromDcLink('guild-123', 'user-1', 'user-2');

    // Member 2 should be moved to clan-1 (role-clan-1)
    expect(mockDiscordMember2.roles.remove).toHaveBeenCalledWith('role-clan-2', expect.any(String));
    expect(mockDiscordMember2.roles.add).toHaveBeenCalledWith('role-clan-1', expect.any(String));

    // Contributions should be fused (increment atomique : 100 + 50 = 150)
    expect(mockDb.clanMemberContribution.update).toHaveBeenCalledWith({
      where: { id: 'contrib-main' },
      data: { xp: { increment: 50 } },
    });
    expect(mockDb.clanMemberContribution.delete).toHaveBeenCalledWith({
      where: { id: 'contrib-alt' },
    });
  });
});
