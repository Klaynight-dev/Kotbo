/**
 * Marché noir : une fenêtre d'ouverture courte, à date et heure imprévisibles, pendant
 * laquelle chaque membre se voit proposer sa propre poignée d'objets de la boutique à
 * prix cassé, en quantité limitée.
 *
 * Découpage : la fenêtre est commune au serveur (une session), les offres sont tirées
 * par membre et **paresseusement**, à sa première visite. Tirer d'avance pour tous les
 * membres coûterait des milliers de lignes par session pour une poignée de visiteurs.
 */
import { EmbedBuilder, type Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { COLORS } from '../../../utils/embeds.js';
import { isBlackMarketEligible, isShopItemAvailable } from '../economyPolicy.js';
import { getOrCreateEconomyConfig, getOrCreateRpgProfile, getShopModuleState } from '../economyService.js';
import { resolveGuildLocale, type BotLocale } from '../../../utils/i18n.js';
import * as m from '../../../lib/paraglide/messages.js';
import {
  drawBlackMarketOffers,
  planNextBlackMarketWindow,
} from './rpgBlackMarketPolicy.js';

type EconomyConfig = Awaited<ReturnType<typeof getOrCreateEconomyConfig>>;

export type BlackMarketSession = { id: string; guildId: string; opensAt: Date; closesAt: Date; announcedAt: Date | null };

export interface BlackMarketOfferView {
  id: string;
  itemId: string;
  name: string;
  description: string;
  emoji: string;
  rarity: string;
  type: string;
  basePrice: number;
  price: number;
  discount: number;
  stock: number;
  purchased: number;
}

/** État du marché noir tel que le panneau `/rpg` doit l'afficher. */
export interface BlackMarketState {
  enabled: boolean;
  session: BlackMarketSession | null;
  nextOpensAt: Date | null;
}

/** Session ouverte à l'instant présent, ou `null`. */
export async function getOpenBlackMarketSession(guildId: string): Promise<BlackMarketSession | null> {
  const now = new Date();
  return prisma.rpgBlackMarketSession.findFirst({
    where: { guildId, opensAt: { lte: now }, closesAt: { gt: now } },
    orderBy: { opensAt: 'desc' },
  });
}

/**
 * Renvoie l'état affichable du marché noir. La prochaine ouverture n'est jamais
 * divulguée à la minute près - seul le fait qu'une ouverture est planifiée l'est -
 * sinon le marché n'aurait plus rien d'imprévisible pour les joueurs.
 */
export async function getBlackMarketState(guildId: string, config?: EconomyConfig): Promise<BlackMarketState> {
  const economy = config ?? await getOrCreateEconomyConfig(guildId);
  if (!economy.enabled || !economy.blackMarketEnabled) {
    return { enabled: false, session: null, nextOpensAt: null };
  }

  const session = await getOpenBlackMarketSession(guildId);
  if (session) return { enabled: true, session, nextOpensAt: null };

  const upcoming = await prisma.rpgBlackMarketSession.findFirst({
    where: { guildId, opensAt: { gt: new Date() } },
    orderBy: { opensAt: 'asc' },
    select: { opensAt: true },
  });
  return { enabled: true, session: null, nextOpensAt: upcoming?.opensAt ?? null };
}

/**
 * Garantit qu'une ouverture est planifiée pour ce serveur, et la crée sinon.
 * Idempotent : appelable à chaque tick de cron sans multiplier les sessions.
 */
export async function ensureBlackMarketSchedule(guildId: string, config: EconomyConfig): Promise<void> {
  const now = new Date();
  const latest = await prisma.rpgBlackMarketSession.findFirst({
    where: { guildId },
    orderBy: { closesAt: 'desc' },
    select: { closesAt: true },
  });

  // Une session encore en cours ou à venir couvre déjà le cycle : rien à planifier.
  if (latest && latest.closesAt > now) return;

  // On repart de maintenant, jamais de la dernière fermeture : après une longue coupure
  // - ou un marché noir désactivé pendant des mois - repartir du passé ferait rattraper
  // une période par tick de cron, en semant autant de sessions mortes au passage.
  const window = planNextBlackMarketWindow(now, config);
  await prisma.rpgBlackMarketSession.create({
    data: { guildId, opensAt: window.opensAt, closesAt: window.closesAt },
  });
}

/**
 * Offres du membre pour la session en cours, tirées à la première visite puis figées.
 *
 * Le tirage est encadré par la contrainte d'unicité `(sessionId, userId, itemId)` :
 * deux ouvertures simultanées du panneau ne peuvent pas doubler la vitrine, la seconde
 * retombe simplement sur les offres déjà écrites.
 */
export async function getMemberBlackMarketOffers(
  guildId: string,
  userId: string,
  session: BlackMarketSession,
  config: EconomyConfig,
): Promise<BlackMarketOfferView[]> {
  const modules = await getShopModuleState(guildId);
  const existing = await prisma.rpgBlackMarketOffer.findMany({
    where: { sessionId: session.id, userId },
    include: { item: true },
    orderBy: { price: 'asc' },
  });
  // Un objet retiré du marché noir - ou dont le module vient d'être éteint - disparaît des
  // offres déjà tirées. Le test porte sur la liste *avant* filtrage : une vitrine devenue
  // vide ne doit pas déclencher un second tirage pour ce membre.
  if (existing.length > 0) {
    return existing.filter((offer) => isBlackMarketEligible(offer.item, modules)).map(toOfferView);
  }

  // Un objet dont le module est éteint ne doit pas être tiré : proposé puis refusé à
  // l'achat, il ferait passer une offre morte pour une bonne affaire. Ceux qu'un serveur
  // a explicitement retirés du marché noir sortent au même endroit.
  const items = (await prisma.rpgItem.findMany({
    where: { OR: [{ guildId: null }, { guildId }], purchasable: true, blackMarketEligible: true },
  })).filter((item) => isBlackMarketEligible(item, modules));
  if (items.length === 0) return [];

  const drawn = drawBlackMarketOffers(items, config);
  await prisma.rpgBlackMarketOffer.createMany({
    data: drawn.map((offer) => ({
      sessionId: session.id,
      userId,
      itemId: offer.item.id,
      price: offer.price,
      discount: offer.discount,
      stock: offer.stock,
    })),
    skipDuplicates: true,
  });

  const created = await prisma.rpgBlackMarketOffer.findMany({
    where: { sessionId: session.id, userId },
    include: { item: true },
    orderBy: { price: 'asc' },
  });
  return created.map(toOfferView);
}

function toOfferView(offer: {
  id: string;
  itemId: string;
  price: number;
  discount: number;
  stock: number;
  purchased: number;
  item: { name: string; description: string; emoji: string; rarity: string; type: string; price: number };
}): BlackMarketOfferView {
  return {
    id: offer.id,
    itemId: offer.itemId,
    name: offer.item.name,
    description: offer.item.description,
    emoji: offer.item.emoji,
    rarity: offer.item.rarity,
    type: offer.item.type,
    basePrice: offer.item.price,
    price: offer.price,
    discount: offer.discount,
    stock: offer.stock,
    purchased: offer.purchased,
  };
}

export interface BlackMarketPurchase {
  itemName: string;
  itemEmoji: string;
  price: number;
  discount: number;
  remaining: number;
  newBalance: number;
}

/**
 * Achète une offre du marché noir.
 *
 * Stock et solde sont consommés par des écritures conditionnelles (`purchased < stock`,
 * `balance >= price`) dans une transaction unique : deux clics simultanés sur la dernière
 * unité ne peuvent pas aboutir tous les deux, et tout refus annule aussi bien le débit que
 * la remise de l'objet - le rembourser après coup laisserait l'objet acquis gratuitement.
 */
export async function buyBlackMarketOffer(guildId: string, userId: string, offerId: string): Promise<BlackMarketPurchase> {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.enabled || !config.blackMarketEnabled) throw new Error('Le marché noir est désactivé.');

  const session = await getOpenBlackMarketSession(guildId);
  if (!session) throw new Error('Le marché noir est fermé.');

  const offer = await prisma.rpgBlackMarketOffer.findUnique({
    where: { id: offerId },
    include: { item: true },
  });
  if (!offer || offer.userId !== userId || offer.sessionId !== session.id) {
    throw new Error('Cette offre ne vous est pas destinée ou a expiré.');
  }
  const modules = await getShopModuleState(guildId);
  if (!isShopItemAvailable(offer.item, guildId, modules) || !isBlackMarketEligible(offer.item, modules)) {
    throw new Error("Cet objet n'est plus disponible à l'achat.");
  }

  // Crée le profil hors transaction : `getOrCreateRpgProfile` gère ses propres écritures.
  const profile = await getOrCreateRpgProfile(guildId, userId);

  return prisma.$transaction(async (tx) => {
    const claimed = await tx.rpgBlackMarketOffer.updateMany({
      where: { id: offer.id, purchased: { lt: offer.stock } },
      data: { purchased: { increment: 1 } },
    });
    if (claimed.count === 0) throw new Error('Vous avez déjà épuisé cette offre.');

    const debited = await tx.rpgProfile.updateMany({
      where: { id: profile.id, balance: { gte: offer.price } },
      data: { balance: { decrement: offer.price } },
    });
    if (debited.count === 0) {
      throw new Error(`Vous n'avez pas assez de ${config.currencyName} (requis: ${offer.price} ${config.currencyEmoji}).`);
    }

    await tx.rpgInventoryItem.upsert({
      where: { rpgProfileId_itemId: { rpgProfileId: profile.id, itemId: offer.itemId } },
      update: { quantity: { increment: 1 } },
      create: { rpgProfileId: profile.id, itemId: offer.itemId, quantity: 1 },
    });

    const updated = await tx.rpgBlackMarketOffer.findUniqueOrThrow({
      where: { id: offer.id },
      select: { purchased: true },
    });
    const balance = await tx.rpgProfile.findUniqueOrThrow({
      where: { id: profile.id },
      select: { balance: true },
    });

    return {
      itemName: offer.item.name,
      itemEmoji: offer.item.emoji,
      price: offer.price,
      discount: offer.discount,
      remaining: offer.stock - updated.purchased,
      newBalance: balance.balance,
    };
  });
}

/**
 * Tick de cron : planifie les ouvertures manquantes et annonce celles qui viennent
 * de s'ouvrir. Une session n'est annoncée qu'une fois (`announcedAt`).
 */
export async function runBlackMarketCycle(client: Client): Promise<void> {
  const configs = await prisma.economyConfig.findMany({
    where: { enabled: true, blackMarketEnabled: true },
  });

  for (const config of configs) {
    try {
      await ensureBlackMarketSchedule(config.guildId, config);
      await announceOpenSession(client, config);
    } catch (error) {
      logger.error('BlackMarket', `Cycle en échec pour ${config.guildId}:`, error);
    }
  }
}

async function announceOpenSession(client: Client, config: EconomyConfig): Promise<void> {
  if (config.blackMarketAnnounce === 'NONE' || !config.blackMarketChannelId) return;

  const session = await getOpenBlackMarketSession(config.guildId);
  if (!session || session.announcedAt) return;

  // Marquage avant envoi : au pire l'annonce est perdue, jamais dupliquée à chaque tick
  // si l'envoi échoue en boucle.
  const marked = await prisma.rpgBlackMarketSession.updateMany({
    where: { id: session.id, announcedAt: null },
    data: { announcedAt: new Date() },
  });
  if (marked.count === 0) return;

  const channel = await client.channels.fetch(config.blackMarketChannelId).catch(() => null);
  if (!channel?.isTextBased() || !channel.isSendable()) {
    logger.warn('BlackMarket', `Salon d'annonce injoignable pour ${config.guildId}.`);
    return;
  }

  const locale: BotLocale = await resolveGuildLocale(config.guildId);
  const closesAtUnix = Math.floor(session.closesAt.getTime() / 1000);
  const embed = new EmbedBuilder()
    .setTitle(m.rpg_blackmarket_announce_title({}, { locale }))
    .setDescription(m.rpg_blackmarket_announce_desc({ closes: `<t:${closesAtUnix}:R>` }, { locale }))
    .setColor(COLORS.dark);

  const mention = config.blackMarketAnnounce === 'CHANNEL_ROLE' && config.blackMarketRoleId
    ? `<@&${config.blackMarketRoleId}>`
    : undefined;

  await channel.send({
    content: mention,
    embeds: [embed],
    allowedMentions: mention ? { roles: [config.blackMarketRoleId!] } : { parse: [] },
  }).catch((error: unknown) => {
    logger.error('BlackMarket', `Annonce impossible pour ${config.guildId}:`, error);
  });
}
