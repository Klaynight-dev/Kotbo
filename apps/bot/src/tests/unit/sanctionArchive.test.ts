import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

const guildId = '987654321098765432';
const actor = { userId: '111111111111111111', tag: 'Modo#0001' };

type FindManyArgs = { where?: Record<string, unknown>; select?: Record<string, boolean>; take?: number };
type UpdateManyArgs = { where?: Record<string, unknown>; data?: Record<string, unknown> };

const prismaMock = {
  guild: {
    findUnique: mock(async (): Promise<unknown> => ({ countArchivedInWarnScore: false })),
    findMany: mock(async (): Promise<unknown[]> => []),
  },
  sanction: {
    findMany: mock(async (_args?: FindManyArgs): Promise<{ id: string }[]> => []),
    updateMany: mock(async (_args?: UpdateManyArgs): Promise<{ count: number }> => ({ count: 0 })),
    deleteMany: mock(async (_args?: UpdateManyArgs): Promise<{ count: number }> => ({ count: 0 })),
  },
};

const moduleMocks: Array<[string, () => Record<string, unknown>]> = [
  ['../../utils/db', () => ({ default: prismaMock, prisma: prismaMock, prismaRead: prismaMock })],
  ['../../utils/logger', () => ({
    logger: {
      info: mock(() => undefined), warn: mock(() => undefined),
      error: mock(() => undefined), debug: mock(() => undefined), success: mock(() => undefined),
    },
  })],
];

for (const [relativePath, factory] of moduleMocks) {
  mock.module(path.resolve(import.meta.dir, `${relativePath}.ts`), factory);
  mock.module(path.resolve(import.meta.dir, `${relativePath}.js`), factory);
}

const {
  archiveScoreFilter,
  archiveSanctions,
  deleteSanctions,
  runWarnAutoArchive,
  setSanctionAppealLock,
  unarchiveSanctions,
} = await import('../../services/moderation/sanctionArchiveService.js');

/** Les ids retenus sont ceux que la base confirme appartenir à la guilde. */
function guildOwns(ids: string[]) {
  prismaMock.sanction.findMany = mock(async () => ids.map((id) => ({ id })));
}

beforeEach(() => {
  guildOwns([]);
  prismaMock.sanction.updateMany = mock(async () => ({ count: 0 }));
  prismaMock.sanction.deleteMany = mock(async () => ({ count: 0 }));
  prismaMock.guild.findUnique = mock(async () => ({ countArchivedInWarnScore: false }));
  prismaMock.guild.findMany = mock(async () => []);
});

describe('archiveScoreFilter', () => {
  test('écarte les sanctions archivées par défaut', async () => {
    expect(await archiveScoreFilter(guildId)).toEqual({ archivedAt: null });
  });

  test('ne filtre rien quand la guilde compte les archives', async () => {
    prismaMock.guild.findUnique = mock(async () => ({ countArchivedInWarnScore: true }));
    expect(await archiveScoreFilter(guildId)).toEqual({});
  });

  test('retombe sur l\'exclusion si la guilde est introuvable', async () => {
    prismaMock.guild.findUnique = mock(async () => null as unknown as { countArchivedInWarnScore: boolean });
    expect(await archiveScoreFilter(guildId)).toEqual({ archivedAt: null });
  });
});

describe('archiveSanctions', () => {
  test('ignore les ids qui n\'appartiennent pas à la guilde', async () => {
    // La base ne reconnaît qu'un des deux ids : l'autre vient d'ailleurs.
    guildOwns(['a']);
    prismaMock.sanction.updateMany = mock(async () => ({ count: 1 }));

    const result = await archiveSanctions(guildId, ['a', 'intrus'], actor, 'Appel accepté');

    expect(result).toEqual({ count: 1, ids: ['a'] });
    const args = (prismaMock.sanction.updateMany as unknown as { mock: { calls: UpdateManyArgs[][] } }).mock.calls[0][0];
    expect(args.where).toMatchObject({ guildId, id: { in: ['a'] }, archivedAt: null });
    expect(args.data).toMatchObject({ archivedByUserId: actor.userId, archiveReason: 'Appel accepté' });
  });

  test('ne touche pas aux sanctions déjà archivées', async () => {
    guildOwns(['a']);
    await archiveSanctions(guildId, ['a'], actor);
    const args = (prismaMock.sanction.updateMany as unknown as { mock: { calls: UpdateManyArgs[][] } }).mock.calls[0][0];
    expect(args.where).toMatchObject({ archivedAt: null });
  });

  test('ne fait aucune écriture sans id valide', async () => {
    const result = await archiveSanctions(guildId, [], actor);
    expect(result).toEqual({ count: 0, ids: [] });
    expect((prismaMock.sanction.updateMany as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });
});

describe('unarchiveSanctions', () => {
  test('ne remet au casier que ce qui était archivé', async () => {
    guildOwns(['a']);
    prismaMock.sanction.updateMany = mock(async () => ({ count: 1 }));

    await unarchiveSanctions(guildId, ['a'], actor);

    const args = (prismaMock.sanction.updateMany as unknown as { mock: { calls: UpdateManyArgs[][] } }).mock.calls[0][0];
    expect(args.where).toMatchObject({ archivedAt: { not: null } });
    expect(args.data).toEqual({ archivedAt: null, archivedByUserId: null, archiveReason: null });
  });
});

describe('setSanctionAppealLock', () => {
  test('verrouiller retire le droit de contester et trace l\'auteur', async () => {
    guildOwns(['a']);
    await setSanctionAppealLock(guildId, ['a'], true, actor, 'Refus définitif');

    const args = (prismaMock.sanction.updateMany as unknown as { mock: { calls: UpdateManyArgs[][] } }).mock.calls[0][0];
    expect(args.data).toMatchObject({
      appealable: false,
      appealLockedByUserId: actor.userId,
      appealLockReason: 'Refus définitif',
    });
  });

  test('déverrouiller efface toute trace du verrou', async () => {
    guildOwns(['a']);
    await setSanctionAppealLock(guildId, ['a'], false, actor);

    const args = (prismaMock.sanction.updateMany as unknown as { mock: { calls: UpdateManyArgs[][] } }).mock.calls[0][0];
    expect(args.data).toEqual({
      appealable: true,
      appealLockedAt: null,
      appealLockedByUserId: null,
      appealLockReason: null,
    });
  });
});

describe('deleteSanctions', () => {
  test('supprime uniquement dans le périmètre de la guilde', async () => {
    guildOwns(['a', 'b']);
    prismaMock.sanction.deleteMany = mock(async () => ({ count: 2 }));

    const result = await deleteSanctions(guildId, ['a', 'b', 'intrus'], actor);

    expect(result.count).toBe(2);
    const args = (prismaMock.sanction.deleteMany as unknown as { mock: { calls: UpdateManyArgs[][] } }).mock.calls[0][0];
    expect(args.where).toEqual({ guildId, id: { in: ['a', 'b'] } });
  });
});

describe('runWarnAutoArchive', () => {
  test('ne fait rien sans guilde configurée', async () => {
    expect(await runWarnAutoArchive()).toBe(0);
    expect((prismaMock.sanction.findMany as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });

  test('archive les warns au-delà du délai, avec un motif automatique', async () => {
    prismaMock.guild.findMany = mock(async () => [{ id: guildId, warnAutoArchiveDays: 30 }]);
    prismaMock.sanction.findMany = mock(async () => [{ id: 'w1' }, { id: 'w2' }]);
    prismaMock.sanction.updateMany = mock(async () => ({ count: 2 }));

    const archived = await runWarnAutoArchive();

    expect(archived).toBe(2);
    const findArgs = (prismaMock.sanction.findMany as unknown as { mock: { calls: FindManyArgs[][] } }).mock.calls[0][0];
    expect(findArgs.where).toMatchObject({ guildId, type: 'WARN', archivedAt: null });
    const cutoff = (findArgs.where?.createdAt as { lt: Date }).lt;
    // 30 jours en arrière, à la seconde près pour rester insensible au temps d'exécution.
    expect(Math.abs(cutoff.getTime() - (Date.now() - 30 * 24 * 60 * 60 * 1000))).toBeLessThan(5000);

    const updateArgs = (prismaMock.sanction.updateMany as unknown as { mock: { calls: UpdateManyArgs[][] } }).mock.calls[0][0];
    expect(updateArgs.data).toMatchObject({ archiveReason: 'Expiration automatique après 30 jours' });
  });

  test('saute une guilde dont le délai est nul', async () => {
    prismaMock.guild.findMany = mock(async () => [{ id: guildId, warnAutoArchiveDays: 0 }]);
    expect(await runWarnAutoArchive()).toBe(0);
    expect((prismaMock.sanction.findMany as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(0);
  });
});
