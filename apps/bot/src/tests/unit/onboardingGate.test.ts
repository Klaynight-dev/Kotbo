import { describe, expect, test, mock, beforeEach } from 'bun:test';
import path from 'node:path';

/**
 * La porte du parcours de configuration.
 *
 * Ce qui est verifie ici tient en une phrase : la reponse ne depend que du
 * serveur. Ni son offre, ni un acces accorde a la main, ni le statut de la
 * personne connectee ne font disparaitre le parcours - c'est ce qui donnait
 * l'impression qu'un administrateur du bot y echappait.
 */

const mockDb = {
  guild: {
    findUnique: mock(() => Promise.resolve(null as unknown)),
    updateMany: mock(() => Promise.resolve({ count: 1 })),
  },
};

const cacheStore = new Map<string, unknown>();
const mockCache = {
  get: mock(async (key: string) => (cacheStore.has(key) ? cacheStore.get(key) : null)),
  set: mock(async (key: string, value: unknown) => { cacheStore.set(key, value); }),
  delete: mock(async (key: string) => { cacheStore.delete(key); }),
};

/** Etat de la facturation, deplacable d'un test a l'autre. */
const billing = { enabled: true, sellable: ['PRO'] as string[] };

for (const dbPath of ['../../utils/db.ts', '../../utils/db.js']) {
  mock.module(path.resolve(__dirname, dbPath), () => ({
    default: mockDb,
    prisma: mockDb,
    prismaRead: mockDb,
  }));
}

for (const cachePath of ['../../utils/cache.ts', '../../utils/cache.js']) {
  mock.module(path.resolve(__dirname, cachePath), () => ({ cache: mockCache }));
}

for (const stripePath of ['../../services/billing/stripeService.ts', '../../services/billing/stripeService.js']) {
  mock.module(path.resolve(__dirname, stripePath), () => ({
    isBillingEnabled: () => billing.enabled,
    sellablePlans: () => billing.sellable,
  }));
}

const {
  WIZARD_CONFIG_SEGMENTS,
  canFinishOnboardingWithoutPayment,
  isGuildInOnboarding,
  isOnboardingFeatureEnabled,
  markOnboardingComplete,
} = await import('../../services/core/onboardingGate');

const FREE_GUILD = {
  plan: 'FREE',
  stripeSubscriptionId: null,
  accessType: 'PERMANENT',
  activationCode: null,
};

beforeEach(() => {
  cacheStore.clear();
  billing.enabled = true;
  billing.sellable = ['PRO'];
  mockDb.guild.findUnique.mockClear();
  mockDb.guild.updateMany.mockClear();
  mockCache.delete.mockClear();
});

describe('isGuildInOnboarding', () => {
  test('un serveur dont le parcours n\'est pas termine y reste, quelle que soit son offre', async () => {
    mockDb.guild.findUnique = mock(() => Promise.resolve({ onboardingCompletedAt: null })) as never;

    expect(await isGuildInOnboarding('1')).toBe(true);
  });

  test('une offre posee a la main ne fait plus disparaitre le parcours', async () => {
    // C'est exactement le cas d'un serveur repris par un administrateur du bot :
    // offre CUSTOM, code de partenariat, acces accorde. Il traverse le parcours
    // comme les autres tant qu'il ne l'a pas fini.
    mockDb.guild.findUnique = mock(() => Promise.resolve({
      onboardingCompletedAt: null,
      plan: 'CUSTOM',
      stripeSubscriptionId: 'sub_1',
      accessType: 'SUBSCRIPTION',
      activationCode: 'KOTBO-1',
    })) as never;

    expect(await isGuildInOnboarding('2')).toBe(true);
  });

  test('un parcours mene a son terme ferme la porte', async () => {
    mockDb.guild.findUnique = mock(() => Promise.resolve({ onboardingCompletedAt: new Date() })) as never;

    expect(await isGuildInOnboarding('3')).toBe(false);
  });

  test('sans facturation en production, aucun parcours n\'est presente', async () => {
    billing.enabled = false;
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(isOnboardingFeatureEnabled()).toBe(false);
      expect(await isGuildInOnboarding('4')).toBe(false);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

describe('canFinishOnboardingWithoutPayment', () => {
  test('un serveur FREE sur une instance qui vend doit passer par la caisse', () => {
    expect(canFinishOnboardingWithoutPayment(FREE_GUILD)).toBe(false);
  });

  test('une offre deja posee, un abonnement, un acces limite ou un code ouvrent la sortie', () => {
    expect(canFinishOnboardingWithoutPayment({ ...FREE_GUILD, plan: 'CUSTOM' })).toBe(true);
    expect(canFinishOnboardingWithoutPayment({ ...FREE_GUILD, stripeSubscriptionId: 'sub_1' })).toBe(true);
    expect(canFinishOnboardingWithoutPayment({ ...FREE_GUILD, accessType: 'SUBSCRIPTION' })).toBe(true);
    expect(canFinishOnboardingWithoutPayment({ ...FREE_GUILD, activationCode: 'KOTBO-1' })).toBe(true);
  });

  test('sans facturation, ou sans offre vendable, il n\'y a rien a payer', () => {
    billing.enabled = false;
    expect(canFinishOnboardingWithoutPayment(FREE_GUILD)).toBe(true);

    billing.enabled = true;
    billing.sellable = [];
    expect(canFinishOnboardingWithoutPayment(FREE_GUILD)).toBe(true);
  });
});

describe('markOnboardingComplete', () => {
  test('n\'ecrase pas une cloture deja posee, et vide le cache', async () => {
    await markOnboardingComplete('5', 'test');

    const call = (mockDb.guild.updateMany as unknown as { mock: { calls: any[][] } }).mock.calls[0][0];
    expect(call.where).toEqual({ id: '5', onboardingCompletedAt: null });
    expect(call.data.onboardingCompletedAt).toBeInstanceOf(Date);
    expect(mockCache.delete).toHaveBeenCalledWith('guild:5:onboarding_required');
  });
});

describe('WIZARD_CONFIG_SEGMENTS', () => {
  test('ouvre l écriture aux segments de tous les écrans du parcours', () => {
    const requiredSegments = [
      'automod',
      'banned-words',
      'raid-protection',
      'announcement',
      'welcome',
      'welcome-thread',
      'regulation',
      'tickets',
      'leveling',
      'logs',
      'message-logs',
      'audit-events',
      'economy',
      'rpg',
      'shop',
      'quests',
      'drops',
      'mcp-keys',
      'mcp-logs',
    ];

    for (const segment of requiredSegments) {
      expect(WIZARD_CONFIG_SEGMENTS.has(segment)).toBe(true);
    }
  });
});

