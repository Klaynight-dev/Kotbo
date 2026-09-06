import { describe, expect, test, mock } from 'bun:test';
import path from 'node:path';

// ── Mock de la couche base ────────────────────────────────────────────────────
// Les opérations dont les arguments sont inspectés dans les assertions déclarent
// un paramètre : sans lui, `mock.calls` est typé comme un tuple vide.
type PrismaArgs = Record<string, unknown>;

const mockDb = {
  ghostAnalyzerConfig: {
    findUnique: mock((_args?: PrismaArgs): Promise<unknown> => Promise.resolve(null)),
    upsert: mock((_args: PrismaArgs): Promise<unknown> => Promise.resolve({})),
  },
  ghostPruneRun: {
    create: mock((_args: PrismaArgs): Promise<unknown> => Promise.resolve({ id: 'run-1' })),
    update: mock((_args: PrismaArgs): Promise<unknown> => Promise.resolve({})),
    findMany: mock((_args: PrismaArgs): Promise<unknown[]> => Promise.resolve([])),
  },
  memberProfile: {
    findMany: mock((_args?: PrismaArgs): Promise<unknown[]> => Promise.resolve([])),
    updateMany: mock((_args: PrismaArgs): Promise<unknown> => Promise.resolve({ count: 0 })),
    count: mock((_args?: PrismaArgs): Promise<number> => Promise.resolve(0)),
    groupBy: mock((_args?: PrismaArgs): Promise<unknown[]> => Promise.resolve([])),
  },
  staffRole: { findMany: mock((_args?: PrismaArgs): Promise<unknown[]> => Promise.resolve([])) },
  staffMember: { findMany: mock((_args?: PrismaArgs): Promise<unknown[]> => Promise.resolve([])) },
};

const dbPath = path.resolve(import.meta.dir, '../../utils/db.ts');
const dbJsPath = path.resolve(import.meta.dir, '../../utils/db.js');
mock.module(dbPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
mock.module(dbJsPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));

const {
  classifyGhostStatus,
  computeGhostScore,
  resolveLastSilentActivity,
  resolveLastAnyActivity,
  resolveProtections,
  sanitizeGhostConfigPatch,
  executeGhostPrune,
  getGhostConfig,
  upsertGhostConfig,
  buildProtectionContext,
  recomputeGhostStatuses,
  previewGhostPrune,
  getGhostPruneRuns,
  GhostPruneValidationError,
  DEFAULT_GHOST_CONFIG,
} = await import('../../services/analytics/ghostMembersService');

const THRESHOLDS = {
  inactiveDays: DEFAULT_GHOST_CONFIG.inactiveDays,
  spectatorWindowDays: DEFAULT_GHOST_CONFIG.spectatorWindowDays,
  gracePeriodDays: DEFAULT_GHOST_CONFIG.gracePeriodDays,
};

const NOW = new Date('2026-07-29T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
/** Membre installé de longue date : sort de la période de grâce. */
const OLD_JOIN = daysAgo(400);
/**
 * `recomputeGhostStatuses` lit l'horloge système au lieu de recevoir un `now`.
 * Ses fixtures récentes se calent donc sur l'heure réelle : ancrées sur `NOW`,
 * elles vieilliraient jusqu'à sortir de la période de grâce et de la fenêtre
 * spectateur, et le test finirait par tomber tout seul.
 */
const realDaysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

describe('classifyGhostStatus', () => {
  test('classe NEW un membre encore en période de grâce, même sans aucune activité', () => {
    const status = classifyGhostStatus({ guildJoinedAt: daysAgo(5) }, THRESHOLDS, NOW);
    expect(status).toBe('NEW');
  });

  test('la période de grâce prime sur tout le reste', () => {
    const status = classifyGhostStatus(
      { guildJoinedAt: daysAgo(2), lastMessageAt: daysAgo(1) },
      THRESHOLDS,
      NOW,
    );
    expect(status).toBe('NEW');
  });

  test('classe ACTIVE un membre ayant écrit récemment', () => {
    const status = classifyGhostStatus(
      { guildJoinedAt: OLD_JOIN, lastMessageAt: daysAgo(10) },
      THRESHOLDS,
      NOW,
    );
    expect(status).toBe('ACTIVE');
  });

  test('classe SPECTATOR un membre muet mais présent en vocal', () => {
    const status = classifyGhostStatus(
      { guildJoinedAt: OLD_JOIN, lastMessageAt: null, voiceLastLeftAt: daysAgo(3) },
      THRESHOLDS,
      NOW,
    );
    expect(status).toBe('SPECTATOR');
  });

  test('classe SPECTATOR un membre dont seule une réaction est récente', () => {
    const status = classifyGhostStatus(
      { guildJoinedAt: OLD_JOIN, lastReactionAt: daysAgo(12) },
      THRESHOLDS,
      NOW,
    );
    expect(status).toBe('SPECTATOR');
  });

  test('une connexion au dashboard suffit à éviter le statut INACTIVE', () => {
    const status = classifyGhostStatus(
      { guildJoinedAt: OLD_JOIN, lastDashboardLoginAt: daysAgo(4) },
      THRESHOLDS,
      NOW,
    );
    expect(status).toBe('SPECTATOR');
  });

  test('classe SPECTATOR un ancien bavard redevenu muet mais toujours en vocal', () => {
    const status = classifyGhostStatus(
      { guildJoinedAt: OLD_JOIN, lastMessageAt: daysAgo(300), voiceLastJoinedAt: daysAgo(2) },
      THRESHOLDS,
      NOW,
    );
    expect(status).toBe('SPECTATOR');
  });

  test('classe INACTIVE un membre sans aucun signal sur aucun canal', () => {
    const status = classifyGhostStatus(
      { guildJoinedAt: OLD_JOIN, lastMessageAt: daysAgo(200), voiceLastLeftAt: daysAgo(180) },
      THRESHOLDS,
      NOW,
    );
    expect(status).toBe('INACTIVE');
  });

  test('classe INACTIVE un profil totalement vide hors période de grâce', () => {
    const status = classifyGhostStatus({ guildJoinedAt: OLD_JOIN }, THRESHOLDS, NOW);
    expect(status).toBe('INACTIVE');
  });

  test('un signal vocal juste au-delà de la fenêtre spectateur bascule en INACTIVE', () => {
    const status = classifyGhostStatus(
      { guildJoinedAt: OLD_JOIN, voiceLastLeftAt: daysAgo(31) },
      THRESHOLDS,
      NOW,
    );
    expect(status).toBe('INACTIVE');
  });

  test('retombe sur firstSeenAt quand la date d\'arrivée est inconnue', () => {
    const status = classifyGhostStatus({ firstSeenAt: daysAgo(3) }, THRESHOLDS, NOW);
    expect(status).toBe('NEW');
  });
});

describe('resolveLastSilentActivity', () => {
  test('retient le signal silencieux le plus récent', () => {
    const result = resolveLastSilentActivity({
      voiceLastLeftAt: daysAgo(10),
      lastReactionAt: daysAgo(2),
      lastDashboardLoginAt: daysAgo(30),
    });
    expect(result?.toISOString()).toBe(daysAgo(2).toISOString());
  });

  test('ignore le dernier message, qui n\'est pas un signal silencieux', () => {
    const result = resolveLastSilentActivity({
      lastMessageAt: NOW,
      lastReactionAt: daysAgo(5),
    });
    expect(result?.toISOString()).toBe(daysAgo(5).toISOString());
  });

  test('retourne null en l\'absence de tout signal', () => {
    expect(resolveLastSilentActivity({})).toBeNull();
  });
});

describe('resolveLastAnyActivity', () => {
  test('prend en compte le texte comme les signaux silencieux', () => {
    const result = resolveLastAnyActivity({
      lastMessageAt: daysAgo(1),
      lastReactionAt: daysAgo(9),
    });
    expect(result?.toISOString()).toBe(daysAgo(1).toISOString());
  });
});

describe('computeGhostScore', () => {
  test('donne 100 à un profil sans la moindre trace', () => {
    expect(computeGhostScore({}, THRESHOLDS, NOW)).toBe(100);
  });

  test('donne 0 à un membre actif à l\'instant', () => {
    expect(computeGhostScore({ lastMessageAt: NOW }, THRESHOLDS, NOW)).toBe(0);
  });

  test('plafonne à 100 au-delà du seuil d\'inactivité', () => {
    expect(computeGhostScore({ lastMessageAt: daysAgo(500) }, THRESHOLDS, NOW)).toBe(100);
  });

  test('progresse proportionnellement à l\'ancienneté du dernier signal', () => {
    // 30 jours sur un seuil de 60 → la moitié du chemin
    expect(computeGhostScore({ lastMessageAt: daysAgo(30) }, THRESHOLDS, NOW)).toBe(50);
  });
});

describe('sanitizeGhostConfigPatch', () => {
  test('borne les seuils hors limites au lieu de les rejeter', () => {
    const patch = sanitizeGhostConfigPatch({ inactiveDays: 5000, spectatorWindowDays: 0 });
    expect(patch.inactiveDays).toBe(730);
    expect(patch.spectatorWindowDays).toBe(1);
  });

  test('ignore les champs de type invalide', () => {
    const patch = sanitizeGhostConfigPatch({ inactiveDays: 'beaucoup', enabled: 'oui' });
    expect(patch.inactiveDays).toBeUndefined();
    expect(patch.enabled).toBeUndefined();
  });

  test('ne retient que des identifiants de rôle plausibles', () => {
    const patch = sanitizeGhostConfigPatch({
      protectedRoleIds: ['123456789012345678', 'pas-un-id', '', 42],
    });
    expect(patch.protectedRoleIds).toEqual(['123456789012345678']);
  });

  test('accepte les booléens de garde-fous', () => {
    const patch = sanitizeGhostConfigPatch({ protectStaff: false, protectBoosters: true });
    expect(patch.protectStaff).toBe(false);
    expect(patch.protectBoosters).toBe(true);
  });

  test('rejette un motif vide mais tronque un motif trop long', () => {
    expect(sanitizeGhostConfigPatch({ pruneReason: '   ' }).pruneReason).toBeUndefined();
    const long = sanitizeGhostConfigPatch({ pruneReason: 'x'.repeat(600) }).pruneReason as string;
    expect(long.length).toBe(400);
  });

  test('ne laisse passer aucun champ inconnu', () => {
    const patch = sanitizeGhostConfigPatch({ guildId: 'autre-serveur', enabled: true });
    expect(patch.guildId).toBeUndefined();
    expect(Object.keys(patch)).toEqual(['enabled']);
  });
});

describe('resolveProtections', () => {
  const context = {
    protectStaff: true,
    protectBoosters: true,
    protectedRoleIds: new Set(['role-vip']),
    staffRoleIds: new Set(['role-mod']),
    staffUserIds: new Set(['staff-user']),
  };

  function member(overrides: {
    id?: string;
    bot?: boolean;
    premiumSince?: Date | null;
    roleIds?: string[];
    hasPermission?: boolean;
  } = {}) {
    const roleIds = overrides.roleIds ?? [];
    return {
      id: overrides.id ?? 'member-1',
      user: { bot: overrides.bot ?? false },
      premiumSince: overrides.premiumSince ?? null,
      roles: { cache: { some: (fn: (r: { id: string }) => boolean) => roleIds.some((id) => fn({ id })) } },
      permissions: { has: () => overrides.hasPermission ?? false },
    } as never;
  }

  test('ne protège pas un membre ordinaire', () => {
    expect(resolveProtections(member(), context)).toEqual([]);
  });

  test('protège le porteur d\'un rôle staff', () => {
    expect(resolveProtections(member({ roleIds: ['role-mod'] }), context)).toContain('STAFF');
  });

  test('protège un membre disposant de permissions de modération', () => {
    expect(resolveProtections(member({ hasPermission: true }), context)).toContain('STAFF');
  });

  test('protège un membre staff enregistré même sans rôle Discord', () => {
    expect(resolveProtections(member({ id: 'staff-user' }), context)).toContain('STAFF');
  });

  test('protège les boosters', () => {
    expect(resolveProtections(member({ premiumSince: NOW }), context)).toContain('BOOSTER');
  });

  test('protège les porteurs d\'un rôle protégé configuré', () => {
    expect(resolveProtections(member({ roleIds: ['role-vip'] }), context)).toContain('PROTECTED_ROLE');
  });

  test('protège toujours les bots', () => {
    expect(resolveProtections(member({ bot: true }), context)).toContain('BOT');
  });

  test('cumule les raisons de protection', () => {
    const reasons = resolveProtections(
      member({ roleIds: ['role-mod', 'role-vip'], premiumSince: NOW }),
      context,
    );
    expect(reasons).toContain('STAFF');
    expect(reasons).toContain('BOOSTER');
    expect(reasons).toContain('PROTECTED_ROLE');
  });

  test('ne protège plus le staff quand le garde-fou est désactivé', () => {
    const reasons = resolveProtections(member({ roleIds: ['role-mod'] }), {
      ...context,
      protectStaff: false,
    });
    expect(reasons).not.toContain('STAFF');
  });

  test('ne protège plus les boosters quand le garde-fou est désactivé', () => {
    const reasons = resolveProtections(member({ premiumSince: NOW }), {
      ...context,
      protectBoosters: false,
    });
    expect(reasons).not.toContain('BOOSTER');
  });
});

describe('getGhostConfig', () => {
  test('retombe sur les valeurs par défaut quand rien n\'est configuré', async () => {
    mockDb.ghostAnalyzerConfig.findUnique.mockResolvedValueOnce(null);
    const config = await getGhostConfig('guild-1');
    expect(config.guildId).toBe('guild-1');
    expect(config.inactiveDays).toBe(60);
    expect(config.enabled).toBe(false);
    expect(config.lastComputedAt).toBeNull();
  });

  test('retourne la configuration enregistrée quand elle existe', async () => {
    mockDb.ghostAnalyzerConfig.findUnique.mockResolvedValueOnce({
      guildId: 'guild-1',
      ...DEFAULT_GHOST_CONFIG,
      inactiveDays: 120,
      lastComputedAt: NOW,
    });
    const config = await getGhostConfig('guild-1');
    expect(config.inactiveDays).toBe(120);
  });
});

describe('upsertGhostConfig', () => {
  test('complète la création avec les valeurs par défaut', async () => {
    mockDb.ghostAnalyzerConfig.upsert.mockResolvedValueOnce({ guildId: 'guild-1' });
    await upsertGhostConfig('guild-1', { inactiveDays: 90 });

    const call = mockDb.ghostAnalyzerConfig.upsert.mock.calls.at(-1)?.[0] as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(call.create.inactiveDays).toBe(90);
    expect(call.create.spectatorWindowDays).toBe(30);
    expect(call.update).toEqual({ inactiveDays: 90 });
  });
});

describe('buildProtectionContext', () => {
  test('agrège rôles staff, membres staff et rôles protégés', async () => {
    mockDb.staffRole.findMany.mockResolvedValueOnce([
      { discordRoleId: 'role-mod' },
      { discordRoleId: null },
    ]);
    mockDb.staffMember.findMany.mockResolvedValueOnce([{ userId: 'staff-1' }]);

    const context = await buildProtectionContext('guild-1', {
      guildId: 'guild-1',
      ...DEFAULT_GHOST_CONFIG,
      protectedRoleIds: ['role-vip'],
      lastComputedAt: null,
    });

    expect([...context.staffRoleIds]).toEqual(['role-mod']);
    expect([...context.staffUserIds]).toEqual(['staff-1']);
    expect([...context.protectedRoleIds]).toEqual(['role-vip']);
  });

  test('n\'interroge pas la base quand la protection du staff est désactivée', async () => {
    mockDb.staffRole.findMany.mockClear();
    mockDb.staffMember.findMany.mockClear();

    const context = await buildProtectionContext('guild-1', {
      guildId: 'guild-1',
      ...DEFAULT_GHOST_CONFIG,
      protectStaff: false,
      lastComputedAt: null,
    });

    expect(mockDb.staffRole.findMany).not.toHaveBeenCalled();
    expect(mockDb.staffMember.findMany).not.toHaveBeenCalled();
    expect(context.staffRoleIds.size).toBe(0);
  });
});

describe('recomputeGhostStatuses', () => {
  test('range chaque membre dans le bon groupe et persiste par lot', async () => {
    mockDb.ghostAnalyzerConfig.findUnique.mockResolvedValueOnce(null);
    mockDb.memberProfile.findMany.mockResolvedValueOnce([
      { userId: 'actif', guildJoinedAt: OLD_JOIN, lastMessageAt: realDaysAgo(2) },
      { userId: 'spectateur', guildJoinedAt: OLD_JOIN, voiceLastLeftAt: realDaysAgo(5) },
      { userId: 'inactif', guildJoinedAt: OLD_JOIN },
      { userId: 'nouveau', guildJoinedAt: realDaysAgo(3) },
    ]);
    mockDb.memberProfile.updateMany.mockClear();

    const counts = await recomputeGhostStatuses('guild-1');

    expect(counts).toEqual({ ACTIVE: 1, SPECTATOR: 1, INACTIVE: 1, NEW: 1 });
    // Un updateMany par statut non vide
    expect(mockDb.memberProfile.updateMany).toHaveBeenCalledTimes(4);
  });

  test('n\'émet aucune écriture pour un serveur sans membre', async () => {
    mockDb.ghostAnalyzerConfig.findUnique.mockResolvedValueOnce(null);
    mockDb.memberProfile.findMany.mockResolvedValueOnce([]);
    mockDb.memberProfile.updateMany.mockClear();

    const counts = await recomputeGhostStatuses('guild-1');

    expect(counts).toEqual({ ACTIVE: 0, SPECTATOR: 0, INACTIVE: 0, NEW: 0 });
    expect(mockDb.memberProfile.updateMany).not.toHaveBeenCalled();
  });
});

describe('previewGhostPrune', () => {
  /** Membre Discord minimal, non protégé et résolvable depuis le cache. */
  function discordMember(id: string) {
    return {
      id,
      user: { bot: false },
      premiumSince: null,
      roles: { cache: { some: () => false } },
      permissions: { has: () => false },
    };
  }

  function clientWith(memberIds: string[]) {
    const cache = new Map(memberIds.map((id) => [id, discordMember(id)]));
    return {
      guilds: {
        cache: {
          get: () => ({
            id: 'guild-1',
            members: { cache, fetch: () => Promise.resolve(new Map()) },
          }),
        },
      },
    } as never;
  }

  test('ne retient que les statuts réellement expulsables', async () => {
    mockDb.ghostAnalyzerConfig.findUnique.mockResolvedValueOnce(null);
    const preview = await previewGhostPrune(clientWith([]), 'guild-1', { statuses: ['ACTIVE'] as never });
    expect(preview.candidates).toEqual([]);
    expect(preview.analyzedCount).toBe(0);
  });

  test('écarte les membres protégés du décompte des candidats', async () => {
    mockDb.ghostAnalyzerConfig.findUnique.mockResolvedValueOnce(null);
    mockDb.staffRole.findMany.mockResolvedValueOnce([]);
    mockDb.staffMember.findMany.mockResolvedValueOnce([]);
    mockDb.memberProfile.findMany.mockResolvedValueOnce([
      { userId: 'present', guildJoinedAt: OLD_JOIN, messageCount: 0, voiceTimeSeconds: 0, interactionCount: 0 },
      { userId: 'parti', guildJoinedAt: OLD_JOIN, messageCount: 0, voiceTimeSeconds: 0, interactionCount: 0 },
    ]);

    // Seul « present » est encore résolvable côté Discord
    const preview = await previewGhostPrune(clientWith(['present']), 'guild-1', { statuses: ['INACTIVE'] });

    expect(preview.candidates.map((c) => c.userId)).toEqual(['present']);
    expect(preview.protectedCount).toBe(1);
    expect(preview.analyzedCount).toBe(2);
  });
});

describe('getGhostPruneRuns', () => {
  test('borne le nombre d\'entrées demandées', async () => {
    mockDb.ghostPruneRun.findMany.mockClear();
    await getGhostPruneRuns('guild-1', 5000);
    const call = mockDb.ghostPruneRun.findMany.mock.calls.at(-1)?.[0] as { take: number };
    expect(call.take).toBe(100);
  });

  test('refuse une valeur nulle ou négative', async () => {
    mockDb.ghostPruneRun.findMany.mockClear();
    await getGhostPruneRuns('guild-1', 0);
    const call = mockDb.ghostPruneRun.findMany.mock.calls.at(-1)?.[0] as { take: number };
    expect(call.take).toBe(1);
  });
});

describe('executeGhostPrune - garde-fous de confirmation', () => {
  const client = { guilds: { cache: { get: () => ({ id: 'guild-1' }) } } } as never;
  const executor = { userId: 'admin-1', username: 'Admin (admin-1)' };

  test('refuse une sélection vide', async () => {
    await expect(
      executeGhostPrune(client, 'guild-1', { userIds: [], confirmCount: 0 }, executor),
    ).rejects.toThrow(GhostPruneValidationError);
  });

  test('refuse quand le nombre confirmé ne correspond pas à la sélection', async () => {
    await expect(
      executeGhostPrune(client, 'guild-1', { userIds: ['a', 'b'], confirmCount: 3 }, executor),
    ).rejects.toThrow(/Confirmation invalide/);
  });

  test('dédoublonne la sélection avant de comparer au nombre confirmé', async () => {
    // 3 identifiants dont un doublon → 2 membres réels, une confirmation à 3 doit échouer
    await expect(
      executeGhostPrune(client, 'guild-1', { userIds: ['a', 'a', 'b'], confirmCount: 3 }, executor),
    ).rejects.toThrow(/Confirmation invalide/);
  });

  test('refuse quand le serveur est introuvable', async () => {
    const emptyClient = { guilds: { cache: { get: () => undefined } } } as never;
    await expect(
      executeGhostPrune(emptyClient, 'guild-1', { userIds: ['a'], confirmCount: 1 }, executor),
    ).rejects.toThrow(/Serveur introuvable/);
  });

  test('expulse les membres confirmés et journalise le run', async () => {
    const kick = mock((_reason?: string): Promise<unknown> => Promise.resolve({}));
    const member = (id: string) => ({
      id,
      user: { bot: false },
      premiumSince: null,
      roles: { cache: { some: () => false } },
      permissions: { has: () => false },
      kickable: true,
      kick,
    });
    const cache = new Map([['ghost-1', member('ghost-1')], ['ghost-2', member('ghost-2')]]);
    const guildClient = {
      guilds: {
        cache: {
          get: () => ({ id: 'guild-1', members: { cache, fetch: () => Promise.resolve(new Map()) } }),
        },
      },
    } as never;

    mockDb.ghostAnalyzerConfig.findUnique.mockResolvedValueOnce(null);
    mockDb.ghostAnalyzerConfig.findUnique.mockResolvedValueOnce(null);
    mockDb.staffRole.findMany.mockResolvedValueOnce([]);
    mockDb.staffMember.findMany.mockResolvedValueOnce([]);
    mockDb.memberProfile.findMany.mockResolvedValueOnce([
      { userId: 'ghost-1', guildJoinedAt: OLD_JOIN, messageCount: 0, voiceTimeSeconds: 0, interactionCount: 0 },
      { userId: 'ghost-2', guildJoinedAt: OLD_JOIN, messageCount: 0, voiceTimeSeconds: 0, interactionCount: 0 },
    ]);
    mockDb.ghostPruneRun.create.mockResolvedValueOnce({ id: 'run-42' });
    mockDb.ghostPruneRun.update.mockClear();
    mockDb.memberProfile.updateMany.mockClear();

    const result = await executeGhostPrune(
      guildClient,
      'guild-1',
      { statuses: ['INACTIVE'], userIds: ['ghost-1', 'ghost-2'], confirmCount: 2, reason: 'Grand ménage' },
      executor,
    );

    expect(result.status).toBe('COMPLETED');
    expect(result.successCount).toBe(2);
    expect(result.failureCount).toBe(0);
    expect(kick).toHaveBeenCalledTimes(2);
    expect(kick.mock.calls[0][0]).toBe('Grand ménage');

    const runUpdate = mockDb.ghostPruneRun.update.mock.calls.at(-1)?.[0] as {
      data: { status: string; kickedUserIds: string[] };
    };
    expect(runUpdate.data.status).toBe('COMPLETED');
    expect(runUpdate.data.kickedUserIds).toEqual(['ghost-1', 'ghost-2']);

    // Les profils sont marqués comme sortis pour ne plus polluer les prochains calculs
    const profileUpdate = mockDb.memberProfile.updateMany.mock.calls.at(-1)?.[0] as {
      data: { guildLeftAt: Date };
    };
    expect(profileUpdate.data.guildLeftAt).toBeInstanceOf(Date);
  }, 15_000);

  test('signale un run PARTIAL quand le bot ne peut pas expulser un membre', async () => {
    const kick = mock((_reason?: string): Promise<unknown> => Promise.resolve({}));
    const cache = new Map<string, unknown>([
      ['ok', {
        id: 'ok',
        user: { bot: false },
        premiumSince: null,
        roles: { cache: { some: () => false } },
        permissions: { has: () => false },
        kickable: true,
        kick,
      }],
      // Membre plus haut que le bot dans la hiérarchie des rôles
      ['intouchable', {
        id: 'intouchable',
        user: { bot: false },
        premiumSince: null,
        roles: { cache: { some: () => false } },
        permissions: { has: () => false },
        kickable: false,
        kick,
      }],
    ]);
    const guildClient = {
      guilds: {
        cache: {
          get: () => ({ id: 'guild-1', members: { cache, fetch: () => Promise.resolve(new Map()) } }),
        },
      },
    } as never;

    mockDb.ghostAnalyzerConfig.findUnique.mockResolvedValueOnce(null);
    mockDb.ghostAnalyzerConfig.findUnique.mockResolvedValueOnce(null);
    mockDb.staffRole.findMany.mockResolvedValueOnce([]);
    mockDb.staffMember.findMany.mockResolvedValueOnce([]);
    mockDb.memberProfile.findMany.mockResolvedValueOnce([
      { userId: 'ok', guildJoinedAt: OLD_JOIN, messageCount: 0, voiceTimeSeconds: 0, interactionCount: 0 },
      { userId: 'intouchable', guildJoinedAt: OLD_JOIN, messageCount: 0, voiceTimeSeconds: 0, interactionCount: 0 },
    ]);
    mockDb.ghostPruneRun.create.mockResolvedValueOnce({ id: 'run-43' });

    const result = await executeGhostPrune(
      guildClient,
      'guild-1',
      { statuses: ['INACTIVE'], userIds: ['ok', 'intouchable'], confirmCount: 2 },
      executor,
    );

    expect(result.status).toBe('PARTIAL');
    expect(result.successCount).toBe(1);
    expect(result.failureCount).toBe(1);
    expect(result.failures[0].userId).toBe('intouchable');
    expect(result.failures[0].error).toMatch(/hiérarchie/);
  }, 15_000);

  test('refuse d\'expulser un membre absent de la prévisualisation', async () => {
    // La prévisualisation ne renvoie aucun candidat : la demande doit être rejetée
    // même si l'appelant fournit des identifiants bien formés.
    mockDb.memberProfile.findMany.mockResolvedValueOnce([]);
    await expect(
      executeGhostPrune(client, 'guild-1', { userIds: ['a'], confirmCount: 1 }, executor),
    ).rejects.toThrow(/n'est encore éligible/);
  });
});
