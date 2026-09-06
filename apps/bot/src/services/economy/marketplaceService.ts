import prisma, { prismaRead } from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { isModuleEnabled } from '../core/moduleGate.js';

class MarketplacePurchaseError extends Error {}

async function attachItemsToListings<T extends { itemId: string }>(listings: T[]) {
  const itemIds = [...new Set(listings.map((listing) => listing.itemId))];
  const items = itemIds.length > 0
    ? await prismaRead.rpgItem.findMany({
        where: { id: { in: itemIds } },
        select: { id: true, name: true, emoji: true },
      })
    : [];
  const itemsById = new Map(items.map((item) => [item.id, item]));

  return listings.map((listing) => ({
    ...listing,
    item: itemsById.get(listing.itemId) ?? null,
  }));
}

export async function getMarketplaceSellableItems(guildId: string, userId: string) {
  const profile = await prismaRead.rpgProfile.findUnique({
    where: { guildId_userId: { guildId, userId } },
    select: { id: true },
  });
  if (!profile) return [];

  return prismaRead.rpgInventoryItem.findMany({
    where: { rpgProfileId: profile.id, quantity: { gt: 0 } },
    include: {
      item: {
        select: { id: true, name: true, emoji: true },
      },
    },
    orderBy: { itemId: 'asc' },
  });
}

export async function getMarketplaceListingChoices(
  guildId: string,
  userId: string,
  action: 'buy' | 'bid' | 'cancel',
) {
  const listings = await prismaRead.marketplaceListing.findMany({
    where: {
      guildId,
      status: 'ACTIVE',
      expiresAt: { gt: new Date() },
      ...(action === 'cancel' ? { sellerId: userId } : { sellerId: { not: userId } }),
      ...(action === 'buy' ? { type: 'FIXED_PRICE' } : {}),
      ...(action === 'bid' ? { type: 'AUCTION' } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  return attachItemsToListings(listings);
}

export async function createListing(guildId: string, sellerId: string, data: {
  itemId: string;
  quantity: number;
  price: number;
  type: 'FIXED_PRICE' | 'AUCTION';
  durationHours?: number;
}): Promise<{ success: boolean; error?: string; listing?: any }> {
  const quantity = Math.trunc(Number(data.quantity));
  if (!Number.isFinite(quantity) || quantity < 1) {
    return { success: false, error: 'La quantité doit être d\'au moins un.' };
  }
  if (data.price <= 0) return { success: false, error: 'Le prix doit être positif.' };

  const durationMs = (data.durationHours ?? 24) * 3600000;
  const expiresAt = new Date(Date.now() + durationMs);

  try {
    const listing = await prisma.$transaction(async (tx) => {
      const profile = await tx.rpgProfile.findUnique({
        where: { guildId_userId: { guildId, userId: sellerId } },
        select: { id: true },
      });
      if (!profile) throw new MarketplacePurchaseError('Profil RPG introuvable.');

      // Retrait conditionnel : la ligne lue puis décrémentée sans garde laissait deux
      // mises en vente simultanées retirer deux fois le même exemplaire, et la quantité
      // passer sous zéro. C'était une duplication d'objet à portée de double-clic.
      const removed = await tx.rpgInventoryItem.updateMany({
        where: { rpgProfileId: profile.id, itemId: data.itemId, quantity: { gte: quantity } },
        data: { quantity: { decrement: quantity } },
      });
      if (removed.count === 0) {
        throw new MarketplacePurchaseError('Vous n\'avez pas assez de cet objet.');
      }

      // Une ligne d'inventaire vidée est supprimée, comme après une fabrication : la
      // laisser à zéro ferait proposer un objet qu'on ne possède plus.
      const emptied = await tx.rpgInventoryItem.deleteMany({
        where: { rpgProfileId: profile.id, itemId: data.itemId, quantity: { lte: 0 } },
      });

      // Mettre en vente son dernier exemplaire emporte sa progression (forge,
      // enchantements) : l'acheteur reçoit un objet nu, et retirer l'annonce ne restitue
      // donc pas une amélioration qu'on aurait pu revendre au prix du neuf.
      if (emptied.count > 0) {
        await tx.rpgItemInstance.deleteMany({
          where: { rpgProfileId: profile.id, itemId: data.itemId },
        });
      }

      return tx.marketplaceListing.create({
        data: {
          guildId,
          sellerId,
          itemId: data.itemId,
          quantity,
          price: data.price,
          type: data.type,
          expiresAt,
        },
      });
    });

    return { success: true, listing };
  } catch (error) {
    if (error instanceof MarketplacePurchaseError) {
      return { success: false, error: error.message };
    }
    throw error;
  }
}

export async function buyListing(
  guildId: string,
  buyerId: string,
  listingId: string,
): Promise<{
  success: boolean;
  error?: string;
  /** Details de l'annonce achetee, utilises pour le message de confirmation. */
  listing?: { itemId: string; quantity: number; price: number; sellerId: string };
}> {
  try {
    const purchased = await prisma.$transaction(async (tx) => {
      const listing = await tx.marketplaceListing.findFirst({
        where: { id: listingId, guildId, status: 'ACTIVE', type: 'FIXED_PRICE' },
      });

      if (!listing) throw new MarketplacePurchaseError('Annonce introuvable ou déjà vendue.');
      if (listing.sellerId === buyerId) {
        throw new MarketplacePurchaseError('Vous ne pouvez pas acheter votre propre annonce.');
      }
      if (listing.expiresAt < new Date()) {
        throw new MarketplacePurchaseError('Cette annonce a expiré.');
      }

      const buyerProfile = await tx.rpgProfile.findUnique({
        where: { guildId_userId: { guildId, userId: buyerId } },
        select: { id: true },
      });
      if (!buyerProfile) throw new MarketplacePurchaseError('Fonds insuffisants.');

      const claimed = await tx.marketplaceListing.updateMany({
        where: { id: listingId, guildId, status: 'ACTIVE', type: 'FIXED_PRICE' },
        data: { status: 'SOLD' },
      });
      if (claimed.count === 0) {
        throw new MarketplacePurchaseError('Annonce introuvable ou déjà vendue.');
      }

      const debited = await tx.rpgProfile.updateMany({
        where: { id: buyerProfile.id, balance: { gte: listing.price } },
        data: { balance: { decrement: listing.price } },
      });
      if (debited.count === 0) throw new MarketplacePurchaseError('Fonds insuffisants.');

      await tx.rpgProfile.update({
        where: { guildId_userId: { guildId, userId: listing.sellerId } },
        data: { balance: { increment: listing.price } },
      });
      await tx.rpgInventoryItem.upsert({
        where: { rpgProfileId_itemId: { rpgProfileId: buyerProfile.id, itemId: listing.itemId } },
        create: { rpgProfileId: buyerProfile.id, itemId: listing.itemId, quantity: listing.quantity },
        update: { quantity: { increment: listing.quantity } },
      });
      await tx.marketplaceTransaction.create({
        data: {
          guildId,
          listingId,
          sellerId: listing.sellerId,
          buyerId,
          itemId: listing.itemId,
          quantity: listing.quantity,
          price: listing.price,
        },
      });

      return {
        itemId: listing.itemId,
        quantity: listing.quantity,
        price: listing.price,
        sellerId: listing.sellerId,
      };
    });

    return { success: true, listing: purchased };
  } catch (error) {
    if (error instanceof MarketplacePurchaseError) {
      return { success: false, error: error.message };
    }
    throw error;
  }
}

/**
 * Pose une enchère : débite le nouvel enchérisseur et rend sa mise au précédent.
 *
 * Tout tient dans une transaction, sur le même patron que l'achat à prix fixe juste
 * au-dessus. Le remboursement du précédent se faisait auparavant dehors et *avant* le
 * débit : un incident entre les deux lui rendait sa mise sans lui retirer sa place, et
 * l'enchère suivante le remboursait une seconde fois.
 *
 * La lecture passe par la base primaire et non la réplique : c'est une décision d'écriture,
 * et une réplique en retard ferait accepter une enchère déjà dépassée.
 */
export async function placeBid(
  guildId: string,
  bidderId: string,
  listingId: string,
  amount: number,
): Promise<{ success: boolean; error?: string; listing?: { itemId: string } }> {
  try {
    const listing = await prisma.$transaction(async (tx) => {
      const current = await tx.marketplaceListing.findFirst({
        where: { id: listingId, guildId, status: 'ACTIVE', type: 'AUCTION' },
      });

      if (!current) throw new MarketplacePurchaseError('Enchère introuvable.');
      if (current.sellerId === bidderId) {
        throw new MarketplacePurchaseError('Vous ne pouvez pas enchérir sur votre propre annonce.');
      }
      if (current.expiresAt < new Date()) throw new MarketplacePurchaseError('Cette enchère a expiré.');

      const minBid = (current.currentBid ?? current.price) + 1;
      if (amount < minBid) {
        throw new MarketplacePurchaseError(`L'enchère minimum est de ${minBid} coins.`);
      }

      // L'annonce doit être restée dans l'état qui a servi à décider. Sans cette
      // condition, deux enchères simultanées passent le contrôle ensemble, se débitent
      // toutes les deux, et la seconde écrase la première - dont la mise n'est alors
      // rendue par personne.
      const claimed = await tx.marketplaceListing.updateMany({
        where: {
          id: listingId,
          status: 'ACTIVE',
          currentBid: current.currentBid,
          bidderId: current.bidderId,
        },
        data: { currentBid: amount, bidderId },
      });
      if (claimed.count === 0) {
        throw new MarketplacePurchaseError('Quelqu\'un vient de surenchérir : reprenez au montant affiché.');
      }

      // Débit conditionnel, comme à l'achat : un solde lu puis décrémenté sans garde peut
      // passer sous zéro entre les deux.
      const debited = await tx.rpgProfile.updateMany({
        where: { guildId, userId: bidderId, balance: { gte: amount } },
        data: { balance: { decrement: amount } },
      });
      if (debited.count === 0) throw new MarketplacePurchaseError('Fonds insuffisants.');

      if (current.bidderId && current.currentBid) {
        await tx.rpgProfile.updateMany({
          where: { guildId, userId: current.bidderId },
          data: { balance: { increment: current.currentBid } },
        });
      }

      return { itemId: current.itemId };
    });

    return { success: true, listing };
  } catch (error) {
    if (error instanceof MarketplacePurchaseError) {
      return { success: false, error: error.message };
    }
    throw error;
  }
}

/**
 * Retire une annonce : l'objet revient au vendeur, la mise en cours à l'enchérisseur.
 *
 * L'annonce est réclamée avant tout mouvement. Sans ça, deux clics sur « annuler » -
 * l'annonce n'étant fermée qu'à la fin - rendaient l'objet deux fois et remboursaient
 * l'enchérisseur deux fois : une duplication d'objet à la portée d'un double-clic.
 */
export async function cancelListing(
  guildId: string,
  userId: string,
  listingId: string,
): Promise<{ success: boolean; error?: string; listing?: { itemId: string } }> {
  try {
    const cancelled = await prisma.$transaction(async (tx) => {
      const listing = await tx.marketplaceListing.findFirst({
        where: { id: listingId, guildId, sellerId: userId, status: 'ACTIVE' },
      });
      if (!listing) throw new MarketplacePurchaseError('Annonce introuvable.');

      const claimed = await tx.marketplaceListing.updateMany({
        where: { id: listingId, status: 'ACTIVE' },
        data: { status: 'CANCELLED' },
      });
      if (claimed.count === 0) throw new MarketplacePurchaseError('Annonce introuvable.');

      if (listing.bidderId && listing.currentBid) {
        await tx.rpgProfile.updateMany({
          where: { guildId, userId: listing.bidderId },
          data: { balance: { increment: listing.currentBid } },
        });
      }

      const seller = await tx.rpgProfile.findUnique({
        where: { guildId_userId: { guildId, userId } },
        select: { id: true },
      });
      if (seller) {
        await tx.rpgInventoryItem.upsert({
          where: { rpgProfileId_itemId: { rpgProfileId: seller.id, itemId: listing.itemId } },
          create: { rpgProfileId: seller.id, itemId: listing.itemId, quantity: listing.quantity },
          update: { quantity: { increment: listing.quantity } },
        });
      }

      return { itemId: listing.itemId };
    });

    return { success: true, listing: cancelled };
  } catch (error) {
    if (error instanceof MarketplacePurchaseError) {
      return { success: false, error: error.message };
    }
    throw error;
  }
}

type ExpiredListing = {
  id: string;
  guildId: string;
  sellerId: string;
  bidderId: string | null;
  currentBid: number | null;
  itemId: string;
  quantity: number;
};

/**
 * Solde une enchère remportée : le vendeur touche la mise, l'acheteur reçoit l'objet.
 *
 * Le tout dans une transaction, réclamation de l'annonce comprise : un simple `update` du
 * statut laissait deux passages du cycle payer le vendeur deux fois, et la remise de
 * l'objet, faite après coup, pouvait échouer sur un acheteur qui avait déjà payé.
 */
async function settleAuction(listing: ExpiredListing & { bidderId: string; currentBid: number }): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.marketplaceListing.updateMany({
      where: { id: listing.id, status: 'ACTIVE' },
      data: { status: 'SOLD' },
    });
    if (claimed.count === 0) return;

    const [seller, buyer] = await Promise.all([
      tx.rpgProfile.findUnique({
        where: { guildId_userId: { guildId: listing.guildId, userId: listing.sellerId } },
        select: { id: true },
      }),
      tx.rpgProfile.findUnique({
        where: { guildId_userId: { guildId: listing.guildId, userId: listing.bidderId } },
        select: { id: true },
      }),
    ]);

    // Vendeur disparu : la vente ne peut pas se conclure. La mise revient à
    // l'enchérisseur plutôt que de rester gelée, et l'annonce se ferme au lieu d'être
    // reprise en échec à chaque tour du cycle.
    if (!seller) {
      if (buyer) {
        await tx.rpgProfile.update({
          where: { id: buyer.id },
          data: { balance: { increment: listing.currentBid } },
        });
      }
      await tx.marketplaceListing.updateMany({ where: { id: listing.id }, data: { status: 'EXPIRED' } });
      logger.warn('Marketplace', `Vendeur introuvable pour l'enchère ${listing.id} : mise rendue.`);
      return;
    }

    await tx.rpgProfile.update({
      where: { id: seller.id },
      data: { balance: { increment: listing.currentBid } },
    });

    if (buyer) {
      await tx.rpgInventoryItem.upsert({
        where: { rpgProfileId_itemId: { rpgProfileId: buyer.id, itemId: listing.itemId } },
        create: { rpgProfileId: buyer.id, itemId: listing.itemId, quantity: listing.quantity },
        update: { quantity: { increment: listing.quantity } },
      });
    } else {
      // L'acheteur a payé au moment d'enchérir : sans profil, l'objet n'a nulle part où
      // aller, mais la vente reste due au vendeur.
      logger.warn('Marketplace', `Acheteur introuvable pour l'enchère ${listing.id} : objet non remis.`);
    }

    await tx.marketplaceTransaction.create({
      data: {
        guildId: listing.guildId,
        listingId: listing.id,
        sellerId: listing.sellerId,
        buyerId: listing.bidderId,
        itemId: listing.itemId,
        quantity: listing.quantity,
        price: listing.currentBid,
      },
    });
  });
}

/** Rend l'objet à son vendeur : annonce non vendue, ou enchère sans le moindre pari. */
async function returnListingToSeller(listing: ExpiredListing): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const claimed = await tx.marketplaceListing.updateMany({
      where: { id: listing.id, status: 'ACTIVE' },
      data: { status: 'EXPIRED' },
    });
    if (claimed.count === 0) return;

    const seller = await tx.rpgProfile.findUnique({
      where: { guildId_userId: { guildId: listing.guildId, userId: listing.sellerId } },
      select: { id: true },
    });
    if (!seller) {
      logger.warn('Marketplace', `Vendeur introuvable pour l'annonce ${listing.id} : objet non rendu.`);
      return;
    }

    await tx.rpgInventoryItem.upsert({
      where: { rpgProfileId_itemId: { rpgProfileId: seller.id, itemId: listing.itemId } },
      create: { rpgProfileId: seller.id, itemId: listing.itemId, quantity: listing.quantity },
      update: { quantity: { increment: listing.quantity } },
    });
  });
}

export async function processExpiredListings(guildId?: string): Promise<void> {
  const expired = await prisma.marketplaceListing.findMany({
    where: {
      status: 'ACTIVE',
      expiresAt: { lt: new Date() },
      ...(guildId ? { guildId } : {}),
    },
  });

  for (const listing of expired) {
    try {
      // Une enchère qui se clôture toute seule déplacerait de la monnaie sur un
      // serveur qui a coupé le marché.
      if (!(await isModuleEnabled(listing.guildId, 'marketplace'))) continue;

      if (listing.type === 'AUCTION' && listing.bidderId && listing.currentBid) {
        await settleAuction({ ...listing, bidderId: listing.bidderId, currentBid: listing.currentBid });
      } else {
        await returnListingToSeller(listing);
      }
    } catch (error) {
      logger.error('Marketplace', `Erreur traitement expiration listing ${listing.id}:`, error);
    }
  }
}

export async function getActiveListings(guildId: string, page = 0, limit = 20) {
  const [rawListings, total] = await Promise.all([
    prismaRead.marketplaceListing.findMany({
      where: { guildId, status: 'ACTIVE', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      skip: page * limit,
      take: limit,
    }),
    prismaRead.marketplaceListing.count({
      where: { guildId, status: 'ACTIVE', expiresAt: { gt: new Date() } },
    }),
  ]);
  const listings = await attachItemsToListings(rawListings);

  return { listings, total, page, totalPages: Math.ceil(total / limit) };
}

export async function getMyListings(guildId: string, userId: string) {
  const listings = await prismaRead.marketplaceListing.findMany({
    where: { guildId, sellerId: userId },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
  return attachItemsToListings(listings);
}

export async function getTransactionHistory(guildId: string, userId?: string, limit = 30) {
  const where: any = { guildId };
  if (userId) where.OR = [{ sellerId: userId }, { buyerId: userId }];

  return prismaRead.marketplaceTransaction.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

export async function getMarketplaceDashboardData(guildId: string) {
  const [active, recent, totalTransactions, totalVolume] = await Promise.all([
    getActiveListings(guildId, 0, 50),
    getTransactionHistory(guildId, undefined, 30),
    prismaRead.marketplaceTransaction.count({ where: { guildId } }),
    prismaRead.marketplaceTransaction.aggregate({
      where: { guildId },
      _sum: { price: true },
    }),
  ]);

  return {
    activeListings: active.listings,
    recentTransactions: recent,
    totalTransactions,
    totalVolume: totalVolume._sum.price ?? 0,
  };
}
