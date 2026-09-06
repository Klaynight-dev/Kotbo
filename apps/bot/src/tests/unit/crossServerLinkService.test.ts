import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';
import { LinkedAccountStatus, LinkedAccountType } from '@prisma/client';

/**
 * Signal « lien déjà posé sur d'autres serveurs ».
 *
 * Le point vérifié ici est la promesse du signal : la note monte avec le nombre
 * de serveurs qui portent le même lien, sans jamais dépasser le plafond, et le
 * partage reste coupé quand le serveur courant ne participe pas.
 */

type LinkRow = {
  guildId: string;
  user1Id: string;
  user2Id: string;
  type: LinkedAccountType;
  status: LinkedAccountStatus;
  reason: string | null;
  createdAt: Date;
};

let guildRow: { instanceId: string | null; crossServerSanctionsEnabled: boolean } | null = null;
let siblingRows: { id: string }[] = [];
let linkRows: LinkRow[] = [];

const mockDb = {
  guild: {
    findUnique: mock(() => Promise.resolve(guildRow)),
    findMany: mock(() => Promise.resolve(siblingRows)),
  },
  linkedAccount: {
    findMany: mock(() => Promise.resolve(linkRows)),
  },
};

// Seul l'accès base est simulé : `computeCrossServerLinkSignals` ne touche pas au
// cache, et simuler le module de cache ici le remplacerait pour toute la suite.
for (const ext of ['ts', 'js']) {
  mock.module(path.resolve(import.meta.dir, `../../utils/db.${ext}`), () => ({
    default: mockDb,
    prisma: mockDb,
    prismaRead: mockDb,
  }));
}

const { computeCrossServerLinkSignals, crossServerLinkScore } = await import(
  '../../services/moderation/crossServerLinkService.js'
);

const MAIN_GUILD = 'guild-main';
const USER = '100000000000000001';
const PARTNER = '100000000000000002';

function link(guildId: string, overrides: Partial<LinkRow> = {}): LinkRow {
  return {
    guildId,
    user1Id: USER,
    user2Id: PARTNER,
    type: LinkedAccountType.MANUAL,
    status: LinkedAccountStatus.VALIDATED,
    reason: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

beforeEach(() => {
  guildRow = { instanceId: null, crossServerSanctionsEnabled: true };
  siblingRows = [{ id: 'guild-a' }, { id: 'guild-b' }, { id: 'guild-c' }, { id: 'guild-d' }];
  linkRows = [];
});

describe('crossServerLinkScore', () => {
  test('la note augmente avec le nombre de serveurs portant le lien', () => {
    const one = crossServerLinkScore([link('guild-a')]);
    const two = crossServerLinkScore([link('guild-a'), link('guild-b')]);
    const three = crossServerLinkScore([link('guild-a'), link('guild-b'), link('guild-c')]);

    expect(one).toBeGreaterThan(0);
    expect(two).toBeGreaterThan(one);
    expect(three).toBeGreaterThan(two);
  });

  test('la note reste plafonnée quel que soit le nombre de serveurs', () => {
    const many = Array.from({ length: 20 }, (_, i) => link(`guild-${i}`));
    expect(crossServerLinkScore(many)).toBeLessThanOrEqual(85);
  });

  test('un lien automatique pèse moins qu’un lien posé par un staff', () => {
    const manual = crossServerLinkScore([link('guild-a')]);
    const automatic = crossServerLinkScore([link('guild-a', { type: LinkedAccountType.AUTOMATIC })]);
    expect(automatic).toBeLessThan(manual);
  });

  test('un lien rejeté ailleurs ne compte pas', () => {
    expect(crossServerLinkScore([link('guild-a', { status: LinkedAccountStatus.REJECTED })])).toBe(0);
  });
});

describe('computeCrossServerLinkSignals', () => {
  test('produit un signal par partenaire, dont la note croît avec le nombre de serveurs', async () => {
    linkRows = [link('guild-a')];
    const [single] = await computeCrossServerLinkSignals(MAIN_GUILD, USER);
    expect(single.type).toBe('cross_server_link');
    expect(single.matchedUserId).toBe(PARTNER);
    expect(single.label).toContain('1 autre serveur');

    linkRows = [link('guild-a'), link('guild-b'), link('guild-c')];
    const [triple] = await computeCrossServerLinkSignals(MAIN_GUILD, USER);
    expect(triple.label).toContain('3 autres serveurs');
    expect(triple.score).toBeGreaterThan(single.score);
  });

  test('reconnaît le partenaire quel que soit le sens du lien stocké', async () => {
    linkRows = [link('guild-a', { user1Id: PARTNER, user2Id: USER })];
    const [signal] = await computeCrossServerLinkSignals(MAIN_GUILD, USER);
    expect(signal.matchedUserId).toBe(PARTNER);
  });

  test('ne partage rien quand le serveur courant est hors du partage cross-serveur', async () => {
    guildRow = { instanceId: null, crossServerSanctionsEnabled: false };
    linkRows = [link('guild-a'), link('guild-b')];
    expect(await computeCrossServerLinkSignals(MAIN_GUILD, USER)).toEqual([]);
  });

  test('ne produit aucun signal sans serveur frère', async () => {
    siblingRows = [];
    linkRows = [link('guild-a')];
    expect(await computeCrossServerLinkSignals(MAIN_GUILD, USER)).toEqual([]);
  });
});
