/**
 * Sticky bot : maintient un message en dernière position d'un salon.
 *
 * Principe : on compte les messages postés dans le salon depuis le dernier
 * envoi du sticky. Au-delà du seuil configuré, l'ancien envoi est supprimé et
 * le message est republié - il redevient donc le dernier message visible.
 *
 * Le compteur vit en mémoire (un write DB par message serait ruineux) ; seul
 * `lastMessageId` est persisté, pour pouvoir nettoyer l'ancien sticky après un
 * redémarrage du bot.
 */

import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type Client,
  type GuildTextBasedChannel,
} from 'discord.js';
import type { StickyMessage } from '@prisma/client';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { resolvePlaceholders } from '../../utils/placeholders.js';

/** TTL du cache de configuration. Invalidé explicitement par le dashboard. */
const CONFIG_TTL_SECONDS = 300;

/** Compteur de messages depuis le dernier envoi, par salon. */
const pendingCounts = new Map<string, number>();
/** Salons dont un renvoi est en cours : évite les doublons sur les rafales. */
const reposting = new Set<string>();
/**
 * Envoi sticky en place, par salon, pour que l'autothread ne lui ouvre pas de
 * fil : le sticky remonte à chaque seuil, chaque renvoi laisserait sinon un fil
 * vide derrière lui.
 *
 * Indexé par salon et non par message : un salon n'a qu'un sticky à la fois, et
 * un ensemble d'identifiants grossissait à chaque renvoi sans jamais se vider.
 */
const stickyMessageByChannel = new Map<string, string>();

function trackStickyMessage(channelId: string, messageId: string | null): void {
  if (messageId) stickyMessageByChannel.set(channelId, messageId);
  else stickyMessageByChannel.delete(channelId);
}

/**
 * Ce message est-il le sticky actuellement affiché dans son salon ?
 *
 * La carte mémoire n'est celle que du processus qui a posté. En mode distribué
 * l'autothread peut tourner ailleurs, d'où le repli sur la configuration
 * persistée, qui porte `lastMessageId`. Ce repli a du retard le temps que
 * l'écriture et l'invalidation du cache se propagent : c'est la même course que
 * celle déjà admise entre l'envoi et l'événement `message:new`.
 */
export async function isStickyMessage(
  guildId: string,
  channelId: string,
  messageId: string,
): Promise<boolean> {
  if (stickyMessageByChannel.get(channelId) === messageId) return true;

  const stickies = await getGuildStickies(guildId);
  return stickies.some((sticky) => sticky.channelId === channelId && sticky.lastMessageId === messageId);
}

function cacheKey(guildId: string): string {
  return `guild:${guildId}:sticky`;
}

/** Configurations sticky d'une guilde, indexées par salon. */
async function getGuildStickies(guildId: string): Promise<StickyMessage[]> {
  const cached = await cache.get<StickyMessage[]>(cacheKey(guildId));
  if (cached) return cached;

  const rows = await prisma.stickyMessage.findMany({ where: { guildId } }).catch((err) => {
    logger.error('Sticky', `Lecture des sticky de ${guildId} impossible`, err);
    return null;
  });
  if (!rows) return [];

  await cache.set(cacheKey(guildId), rows, CONFIG_TTL_SECONDS);
  return rows;
}

/** À appeler après toute écriture depuis le dashboard ou une commande. */
export async function invalidateStickyCache(guildId: string): Promise<void> {
  await cache.delete(cacheKey(guildId));
}

/** Remet à zéro le compteur mémoire d'un salon (suppression, renvoi manuel). */
export function resetStickyCounter(channelId: string): void {
  pendingCounts.delete(channelId);
}

function buildPayload(sticky: StickyMessage, channel: GuildTextBasedChannel) {
  const content = resolvePlaceholders(sticky.content ?? '', { guild: channel.guild });

  if (!sticky.embedEnabled) {
    return { content, allowedMentions: { parse: [] as never[] } };
  }

  const embed = new EmbedBuilder().setDescription(content || '​');
  if (sticky.embedTitle) {
    embed.setTitle(resolvePlaceholders(sticky.embedTitle, { guild: channel.guild }).slice(0, 256));
  }
  if (/^#[0-9a-fA-F]{6}$/.test(sticky.embedColor)) {
    embed.setColor(Number.parseInt(sticky.embedColor.slice(1), 16));
  }
  return { embeds: [embed], allowedMentions: { parse: [] as never[] } };
}

function resolveChannel(client: Client, channelId: string): GuildTextBasedChannel | null {
  const channel = client.channels.cache.get(channelId);
  if (!channel) return null;
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) return null;
  return channel as GuildTextBasedChannel;
}

/**
 * Republie le sticky d'un salon : suppression de l'ancien envoi puis nouvel
 * envoi. Retourne l'id du nouveau message, ou null si l'envoi a échoué.
 */
export async function repostSticky(
  client: Client,
  sticky: StickyMessage,
  options: { force?: boolean } = {},
): Promise<string | null> {
  const channel = resolveChannel(client, sticky.channelId);
  if (!channel) return null;

  const me = channel.guild.members.me ?? (await channel.guild.members.fetchMe().catch(() => null));
  if (!me) return null;
  const perms = me.permissionsIn(channel);
  if (!perms.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.SendMessages)) {
    return null;
  }
  if (sticky.embedEnabled && !perms.has(PermissionFlagsBits.EmbedLinks)) return null;

  // Cooldown : protège des rate limits quand un salon s'emballe. Le compteur
  // n'est pas remis à zéro, le renvoi aura donc lieu au message suivant.
  // `lastPostedAt` revient en chaîne ISO quand la config sort du cache Redis :
  // on repasse systématiquement par le constructeur Date.
  if (!options.force && sticky.lastPostedAt) {
    const elapsed = Date.now() - new Date(sticky.lastPostedAt as unknown as string).getTime();
    if (elapsed < sticky.cooldownSeconds * 1000) return null;
  }

  if (reposting.has(sticky.channelId)) return null;
  reposting.add(sticky.channelId);

  try {
    if (sticky.lastMessageId) {
      const previous = await channel.messages.fetch(sticky.lastMessageId).catch(() => null);
      await previous?.delete().catch(() => null);
    }

    const sent = await channel.send(buildPayload(sticky, channel)).catch((err: unknown) => {
      logger.error('Sticky', `Envoi du sticky impossible dans ${sticky.channelId}`, err);
      return null;
    });
    if (!sent) return null;
    trackStickyMessage(sticky.channelId, sent.id);

    await prisma.stickyMessage.update({
      where: { id: sticky.id },
      data: { lastMessageId: sent.id, lastPostedAt: new Date() },
    }).catch(() => null);
    await invalidateStickyCache(sticky.guildId);

    pendingCounts.delete(sticky.channelId);
    return sent.id;
  } finally {
    reposting.delete(sticky.channelId);
  }
}

/**
 * Compte un message dans le salon et déclenche le renvoi au franchissement du
 * seuil. Appelé pour chaque message de guilde, hors messages du bot lui-même.
 */
export async function handleStickyMessage(
  client: Client,
  guildId: string,
  channelId: string,
  authorId: string,
): Promise<void> {
  // Ne jamais compter nos propres envois : le sticky se relancerait lui-même.
  if (authorId === client.user?.id) return;

  const stickies = await getGuildStickies(guildId);
  if (stickies.length === 0) return;

  const sticky = stickies.find((s) => s.channelId === channelId);
  if (!sticky || !sticky.enabled || !sticky.content.trim()) return;

  const count = (pendingCounts.get(channelId) ?? 0) + 1;
  pendingCounts.set(channelId, count);
  if (count < Math.max(1, sticky.messageThreshold)) return;

  await repostSticky(client, sticky);
}

/**
 * Supprime le sticky encore affiché dans un salon (désactivation, suppression
 * de la configuration depuis le dashboard).
 */
export async function clearStickyMessage(client: Client, sticky: StickyMessage): Promise<void> {
  resetStickyCounter(sticky.channelId);
  trackStickyMessage(sticky.channelId, null);
  if (!sticky.lastMessageId) return;

  const channel = resolveChannel(client, sticky.channelId);
  if (!channel) return;

  const previous = await channel.messages.fetch(sticky.lastMessageId).catch(() => null);
  await previous?.delete().catch(() => null);
}
