import { beforeEach, describe, expect, mock, test } from 'bun:test';
import path from 'node:path';

type MarketplaceState = {
  listingStatus: 'ACTIVE' | 'SOLD' | 'CANCELLED';
  buyerBalance: number;
  sellerBalance: number;
  inventoryQuantity: number;
  transactionCount: number;
  /** Cumul des mises rendues : c'est lui qui trahit un remboursement versé deux fois. */
  refunded: number;
};

let state: MarketplaceState;
let transactionQueue = Promise.resolve();

const listing = {
  id: 'listing-1',
  guildId: 'guild-1',
  sellerId: 'seller-1',
  itemId: 'item-1',
  quantity: 1,
  price: 100,
  type: 'FIXED_PRICE',
  expiresAt: new Date(Date.now() + 60_000),
};

const tx = {
  marketplaceListing: {
    findFirst: mock(async () => state.listingStatus === 'ACTIVE'
      ? { ...listing, status: state.listingStatus }
      : null),
    updateMany: mock(async ({ data }: any) => {
      if (state.listingStatus !== 'ACTIVE') return { count: 0 };
      state.listingStatus = data.status;
      return { count: 1 };
    }),
  },
  rpgProfile: {
    findUnique: mock(async ({ where }: any) => {
      const userId = where.guildId_userId.userId;
      if (userId === 'buyer-1') return { id: 'buyer-profile' };
      if (userId === 'seller-1') return { id: 'seller-profile' };
      return null;
    }),
    updateMany: mock(async ({ where, data }: any) => {
      // Remboursement : désigné par son couple serveur/membre, sans condition de solde.
      if (data.balance?.increment !== undefined) {
        state.refunded += data.balance.increment;
        return { count: 1 };
      }
      if (where.id !== 'buyer-profile' || state.buyerBalance < where.balance.gte) {
        return { count: 0 };
      }
      state.buyerBalance -= data.balance.decrement;
      return { count: 1 };
    }),
    update: mock(async ({ data }: any) => {
      state.sellerBalance += data.balance.increment;
      return {};
    }),
  },
  rpgInventoryItem: {
    upsert: mock(async ({ update, create }: any) => {
      state.inventoryQuantity += state.inventoryQuantity > 0
        ? update.quantity.increment
        : create.quantity;
      return {};
    }),
  },
  marketplaceTransaction: {
    create: mock(async () => {
      if (state.transactionCount > 0) throw new Error('unique listingId');
      state.transactionCount++;
      return {};
    }),
  },
};

const mockDb = {
  ...tx,
  $transaction: mock(<T>(callback: (client: typeof tx) => Promise<T>): Promise<T> => {
    const run = transactionQueue.then(async () => {
      const snapshot = { ...state };
      try {
        return await callback(tx);
      } catch (error) {
        state = snapshot;
        throw error;
      }
    });
    transactionQueue = run.then(() => undefined, () => undefined);
    return run;
  }),
};

const dbPath = path.resolve(import.meta.dir, '../../utils/db.ts');
const dbJsPath = path.resolve(import.meta.dir, '../../utils/db.js');
mock.module(dbPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));
mock.module(dbJsPath, () => ({ default: mockDb, prisma: mockDb, prismaRead: mockDb }));

const { buyListing, cancelListing } = await import('../../services/economy/marketplaceService.js');

beforeEach(() => {
  state = {
    listingStatus: 'ACTIVE',
    buyerBalance: 100,
    sellerBalance: 0,
    inventoryQuantity: 0,
    transactionCount: 0,
    refunded: 0,
  };
  transactionQueue = Promise.resolve();
});

describe('atomic marketplace purchase', () => {
  test('a listing can only be purchased once concurrently', async () => {
    const results = await Promise.all([
      buyListing('guild-1', 'buyer-1', 'listing-1'),
      buyListing('guild-1', 'buyer-1', 'listing-1'),
    ]);

    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(results.filter((result) => !result.success)).toHaveLength(1);
    expect(state.listingStatus).toBe('SOLD');
    expect(state.buyerBalance).toBe(0);
    expect(state.sellerBalance).toBe(100);
    expect(state.inventoryQuantity).toBe(1);
    expect(state.transactionCount).toBe(1);
  });
});

describe('retrait d’une annonce', () => {
  // L'annonce n'était fermée qu'après le remboursement et la remise de l'objet : deux
  // clics sur « annuler » rendaient donc l'objet deux fois. Une duplication à portée de
  // double-clic, sur un module qui brasse de la monnaie.
  test('deux retraits simultanés ne rendent l’objet qu’une fois', async () => {
    const results = await Promise.all([
      cancelListing('guild-1', 'seller-1', 'listing-1'),
      cancelListing('guild-1', 'seller-1', 'listing-1'),
    ]);

    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(state.listingStatus).toBe('CANCELLED');
    expect(state.inventoryQuantity).toBe(1);
  });

  test('un retrait rend l’objet à son vendeur', async () => {
    const result = await cancelListing('guild-1', 'seller-1', 'listing-1');

    expect(result.success).toBe(true);
    expect(state.inventoryQuantity).toBe(1);
    // Aucune enchère sur cette annonce : il n'y a personne à rembourser.
    expect(state.refunded).toBe(0);
  });
});
