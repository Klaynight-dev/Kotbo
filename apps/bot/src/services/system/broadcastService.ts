/**
 * Envoi des annonces globales Kotbo.
 *
 * Extrait de `routes/admin.ts`, ou la logique d'envoi vivait au milieu du
 * routeur et ne remontait que deux compteurs agreges. Le service ajoute :
 *   - un resultat serveur par serveur (salon retenu, raison d'echec) ;
 *   - un cycle de vie (brouillon, programme, en cours, envoye, annule) ;
 *   - la validation des URL d'image avant diffusion.
 */
import type { Client } from 'discord.js';
import { EmbedBuilder, type ColorResolvable } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { resolveEmojiShortcodes, resolveEmojiShortcodesToUnicode } from '../../utils/emojis.js';
import { checkEmbedImageUrl, markBroadcastMediaUsed } from './broadcastMediaService.js';

export type BroadcastTarget = 'ALL' | 'ACTIVATED' | 'CUSTOM';
export type BroadcastChannelPref = 'AUTO' | 'NEWS' | 'PUBLIC' | 'STAFF' | 'FALLBACK';
export type BroadcastStatus = 'DRAFT' | 'SCHEDULED' | 'SENDING' | 'SENT' | 'CANCELLED' | 'FAILED';

export interface BroadcastContent {
  title?: string;
  message: string;
  color?: string;
  thumbnailUrl?: string | null;
  imageUrl?: string | null;
  footerText?: string;
  target?: BroadcastTarget;
  targetGuilds?: string[];
  channelPref?: BroadcastChannelPref;
}

export const DEFAULT_BROADCAST_TITLE = '📢 Annonce Globale Kotbo';
export const DEFAULT_BROADCAST_FOOTER = "Système d'annonce globale Kotbo";

interface GuildChannelConfig {
  broadcastChannelId: string | null;
  newsChannelId: string | null;
  publicChannelId: string | null;
  staffAnnouncementChannelId: string | null;
}

export interface DeliveryResult {
  guildId: string;
  guildName: string;
  channelId: string | null;
  channelName: string | null;
  status: 'SENT' | 'FAILED' | 'SKIPPED';
  reason: string | null;
  messageId: string | null;
}

export class BroadcastValidationError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message);
    this.name = 'BroadcastValidationError';
  }
}

/**
 * Normalise le contenu et refuse ce que Discord ne saura pas afficher.
 * Les URL d'image sont le point sensible : voir `checkEmbedImageUrl`.
 */
export function normalizeBroadcastContent(content: BroadcastContent): {
  title: string;
  message: string;
  color: string;
  thumbnailUrl: string | null;
  imageUrl: string | null;
  footerText: string;
  target: BroadcastTarget;
  targetGuilds: string[];
  channelPref: BroadcastChannelPref;
  warnings: string[];
} {
  const message = content.message?.trim();
  if (!message) throw new BroadcastValidationError('Message requis', 'message');
  if (message.length > 4000) {
    throw new BroadcastValidationError('Le message dépasse la limite Discord de 4000 caractères.', 'message');
  }

  const title = resolveEmojiShortcodesToUnicode(content.title?.trim() || DEFAULT_BROADCAST_TITLE);
  if (title.length > 256) {
    throw new BroadcastValidationError('Le titre dépasse la limite Discord de 256 caractères.', 'title');
  }

  const footerText = resolveEmojiShortcodesToUnicode(content.footerText?.trim() || DEFAULT_BROADCAST_FOOTER);
  if (footerText.length > 2048) {
    throw new BroadcastValidationError('Le pied de page dépasse la limite Discord de 2048 caractères.', 'footerText');
  }

  const rawColor = (content.color || '#5865F2').trim();
  const color = /^#[0-9a-fA-F]{6}$/.test(rawColor) ? rawColor.toUpperCase() : '#5865F2';

  const warnings: string[] = [];

  const thumbnail = checkEmbedImageUrl(content.thumbnailUrl);
  if (!thumbnail.ok) throw new BroadcastValidationError(thumbnail.message ?? 'Vignette invalide.', 'thumbnailUrl');
  if (thumbnail.message) warnings.push(`Vignette : ${thumbnail.message}`);

  const image = checkEmbedImageUrl(content.imageUrl);
  if (!image.ok) throw new BroadcastValidationError(image.message ?? 'Image invalide.', 'imageUrl');
  if (image.message) warnings.push(`Image : ${image.message}`);

  const target: BroadcastTarget = content.target ?? 'ALL';
  const targetGuilds = Array.isArray(content.targetGuilds) ? content.targetGuilds.filter((id) => /^\d{17,20}$/.test(id)) : [];
  if (target === 'CUSTOM' && targetGuilds.length === 0) {
    throw new BroadcastValidationError('Sélectionnez au moins un serveur pour un ciblage personnalisé.', 'targetGuilds');
  }

  return {
    title,
    message: resolveEmojiShortcodes(message),
    color,
    thumbnailUrl: thumbnail.value,
    imageUrl: image.value,
    footerText,
    target,
    targetGuilds,
    channelPref: content.channelPref ?? 'AUTO',
    warnings,
  };
}

/** Ordre de repli des salons, identique dans le processus principal et dans les shards. */
function buildChannelPreference(config: GuildChannelConfig | undefined, pref: BroadcastChannelPref): string[] {
  const order: (string | null | undefined)[] = [config?.broadcastChannelId];
  if (pref === 'NEWS') order.push(config?.newsChannelId, config?.publicChannelId);
  else if (pref === 'PUBLIC') order.push(config?.publicChannelId, config?.newsChannelId);
  else if (pref === 'STAFF') order.push(config?.staffAnnouncementChannelId, config?.newsChannelId);
  else if (pref === 'FALLBACK') order.push(config?.newsChannelId, config?.publicChannelId, config?.staffAnnouncementChannelId);
  else order.push(config?.newsChannelId, config?.publicChannelId, config?.staffAnnouncementChannelId);
  return order.filter((id): id is string => Boolean(id));
}

export async function loadGuildChannelMap(): Promise<Record<string, GuildChannelConfig>> {
  const rows = await prisma.guild.findMany({
    select: {
      id: true,
      broadcastChannelId: true,
      newsChannelId: true,
      publicChannelId: true,
      staffAnnouncementChannelId: true,
    },
  });
  const map: Record<string, GuildChannelConfig> = Object.create(null);
  for (const row of rows) {
    map[row.id] = {
      broadcastChannelId: row.broadcastChannelId,
      newsChannelId: row.newsChannelId,
      publicChannelId: row.publicChannelId,
      staffAnnouncementChannelId: row.staffAnnouncementChannelId,
    };
  }
  return map;
}

/**
 * Resout la liste des serveurs cibles.
 *
 * `ALL` inclut les serveurs presents en cache Discord meme s'ils n'ont pas
 * encore de ligne en base : sinon un serveur fraichement rejoint ne recevrait
 * aucune annonce globale.
 */
export async function resolveTargetGuildIds(
  client: Client,
  target: BroadcastTarget,
  targetGuilds: string[],
  collectShardGuilds: (client: Client) => Promise<{ id: string }[]>,
): Promise<Set<string>> {
  const dbGuilds = await prisma.guild.findMany({ select: { id: true, activated: true } });
  const allowed = new Set<string>();

  for (const guild of dbGuilds) {
    if (target === 'ALL') allowed.add(guild.id);
    else if (target === 'ACTIVATED' && guild.activated) allowed.add(guild.id);
    else if (target === 'CUSTOM' && targetGuilds.includes(guild.id)) allowed.add(guild.id);
  }

  if (target === 'ALL') {
    for (const guild of await collectShardGuilds(client)) allowed.add(guild.id);
  }

  return allowed;
}

interface ShardBroadcastContext {
  embed: {
    title: string;
    message: string;
    color: string;
    thumbnailUrl: string | null;
    imageUrl: string | null;
    footerText: string;
  };
  channelMap: Record<string, GuildChannelConfig>;
  allowedIds: string[];
  channelPref: BroadcastChannelPref;
}

/**
 * Diffuse l'annonce et renvoie le detail par serveur.
 *
 * Le corps de `broadcastEval` est serialise puis execute dans chaque shard :
 * il ne peut donc rien capturer du scope courant, d'ou la duplication de la
 * logique de choix de salon dans la fonction inline.
 */
export async function deliverBroadcast(
  client: Client,
  params: {
    title: string;
    message: string;
    color: string;
    thumbnailUrl: string | null;
    imageUrl: string | null;
    footerText: string;
    channelPref: BroadcastChannelPref;
    allowedIds: string[];
    channelMap: Record<string, GuildChannelConfig>;
  },
): Promise<DeliveryResult[]> {
  const context: ShardBroadcastContext = {
    embed: {
      title: params.title,
      message: params.message,
      color: params.color,
      thumbnailUrl: params.thumbnailUrl,
      imageUrl: params.imageUrl,
      footerText: params.footerText,
    },
    channelMap: params.channelMap,
    allowedIds: params.allowedIds,
    channelPref: params.channelPref,
  };

  if (client.shard) {
    const results = await client.shard.broadcastEval<DeliveryResult[], ShardBroadcastContext>(
      async (shardClient, ctx) => {
        const { EmbedBuilder: ShardEmbed } = await import('discord.js');
        const out: DeliveryResult[] = [];

        for (const [id, guild] of shardClient.guilds.cache) {
          if (!ctx.allowedIds.includes(id)) continue;

          const config = ctx.channelMap[id];
          const order: (string | null | undefined)[] = [config?.broadcastChannelId];
          if (ctx.channelPref === 'NEWS') order.push(config?.newsChannelId, config?.publicChannelId);
          else if (ctx.channelPref === 'PUBLIC') order.push(config?.publicChannelId, config?.newsChannelId);
          else if (ctx.channelPref === 'STAFF') order.push(config?.staffAnnouncementChannelId, config?.newsChannelId);
          else order.push(config?.newsChannelId, config?.publicChannelId, config?.staffAnnouncementChannelId);

          let channel = null as null | { id: string; name: string; isTextBased: () => boolean; send: (payload: unknown) => Promise<{ id: string }> };

          for (const channelId of order) {
            if (!channelId) continue;
            const found = guild.channels.cache.get(channelId);
            if (found && (found.type === 0 || found.type === 5)) {
              channel = found as unknown as typeof channel;
              break;
            }
          }

          if (!channel) {
            const fallback = guild.channels.cache.find(
              (c) => c.type === 0 && c.permissionsFor(shardClient.user!)?.has('SendMessages'),
            );
            channel = (fallback ?? null) as unknown as typeof channel;
          }

          if (!channel) {
            out.push({
              guildId: id,
              guildName: guild.name,
              channelId: null,
              channelName: null,
              status: 'SKIPPED',
              reason: "Aucun salon textuel accessible : configurez un salon de broadcast pour ce serveur.",
              messageId: null,
            });
            continue;
          }

          try {
            const embed = new ShardEmbed()
              .setTitle(ctx.embed.title)
              .setDescription(ctx.embed.message)
              .setColor(parseInt(ctx.embed.color.replace('#', ''), 16))
              .setFooter({ text: ctx.embed.footerText })
              .setTimestamp();
            if (ctx.embed.thumbnailUrl) embed.setThumbnail(ctx.embed.thumbnailUrl);
            if (ctx.embed.imageUrl) embed.setImage(ctx.embed.imageUrl);

            const sent = await channel.send({ embeds: [embed] });
            out.push({
              guildId: id,
              guildName: guild.name,
              channelId: channel.id,
              channelName: channel.name,
              status: 'SENT',
              reason: null,
              messageId: sent.id,
            });
          } catch (err) {
            out.push({
              guildId: id,
              guildName: guild.name,
              channelId: channel.id,
              channelName: channel.name,
              status: 'FAILED',
              reason: (err as Error).message?.slice(0, 300) ?? 'Erreur inconnue',
              messageId: null,
            });
          }
        }

        return out;
      },
      { context },
    );

    return results.flat();
  }

  // Processus unique (developpement, ou bot non sharde).
  const out: DeliveryResult[] = [];
  for (const [id, guild] of client.guilds.cache) {
    if (!params.allowedIds.includes(id)) continue;

    const order = buildChannelPreference(params.channelMap[id], params.channelPref);
    let channel = order
      .map((channelId) => guild.channels.cache.get(channelId))
      .find((found) => found && (found.type === 0 || found.type === 5));

    if (!channel) {
      channel = guild.channels.cache.find(
        (c) => c.type === 0 && c.permissionsFor(client.user!)?.has('SendMessages'),
      );
    }

    if (!channel || !channel.isTextBased()) {
      out.push({
        guildId: id,
        guildName: guild.name,
        channelId: null,
        channelName: null,
        status: 'SKIPPED',
        reason: "Aucun salon textuel accessible : configurez un salon de broadcast pour ce serveur.",
        messageId: null,
      });
      continue;
    }

    try {
      const embed = new EmbedBuilder()
        .setTitle(params.title)
        .setDescription(params.message)
        .setColor(params.color as ColorResolvable)
        .setFooter({ text: params.footerText })
        .setTimestamp();
      if (params.thumbnailUrl) embed.setThumbnail(params.thumbnailUrl);
      if (params.imageUrl) embed.setImage(params.imageUrl);

      const sent = await channel.send({ embeds: [embed] });
      out.push({
        guildId: id,
        guildName: guild.name,
        channelId: channel.id,
        channelName: 'name' in channel ? String(channel.name) : null,
        status: 'SENT',
        reason: null,
        messageId: sent.id,
      });
    } catch (err) {
      out.push({
        guildId: id,
        guildName: guild.name,
        channelId: channel.id,
        channelName: 'name' in channel ? String(channel.name) : null,
        status: 'FAILED',
        reason: (err as Error).message?.slice(0, 300) ?? 'Erreur inconnue',
        messageId: null,
      });
    }
  }
  return out;
}

/** Persiste le detail d'envoi et met le broadcast dans son etat final. */
export async function finalizeBroadcast(
  broadcastId: string,
  deliveries: DeliveryResult[],
  totalTargeted: number,
): Promise<{ successCount: number; failCount: number }> {
  const successCount = deliveries.filter((d) => d.status === 'SENT').length;
  const failCount = deliveries.length - successCount;

  if (deliveries.length > 0) {
    await prisma.broadcastDelivery.createMany({
      data: deliveries.map((delivery) => ({
        broadcastId,
        guildId: delivery.guildId,
        guildName: delivery.guildName.slice(0, 200),
        channelId: delivery.channelId,
        channelName: delivery.channelName?.slice(0, 200) ?? null,
        status: delivery.status,
        reason: delivery.reason?.slice(0, 500) ?? null,
        messageId: delivery.messageId,
      })),
      skipDuplicates: true,
    });
  }

  await prisma.broadcastLog.update({
    where: { id: broadcastId },
    data: {
      status: successCount === 0 && totalTargeted > 0 ? 'FAILED' : 'SENT',
      successCount,
      failCount,
      totalTargeted,
      finishedAt: new Date(),
    },
  });

  return { successCount, failCount };
}

/**
 * Reprend les annonces programmees arrivees a echeance.
 *
 * Le scheduler tourne dans le processus qui porte l'API : un redemarrage ne
 * perd rien puisque l'etat vit en base, l'envoi est simplement repris au tick
 * suivant.
 */
export function startBroadcastScheduler(
  client: Client,
  collectShardGuilds: (client: Client) => Promise<{ id: string }[]>,
): () => void {
  const TICK_MS = 60_000;

  const tick = async () => {
    try {
      const due = await prisma.broadcastLog.findMany({
        where: { status: 'SCHEDULED', scheduledAt: { lte: new Date() } },
        orderBy: { scheduledAt: 'asc' },
        take: 5,
      });

      for (const broadcast of due) {
        // Verrou optimiste : seul le tick qui reussit la transition envoie.
        const claimed = await prisma.broadcastLog.updateMany({
          where: { id: broadcast.id, status: 'SCHEDULED' },
          data: { status: 'SENDING', startedAt: new Date() },
        });
        if (claimed.count === 0) continue;

        try {
          const allowed = await resolveTargetGuildIds(
            client,
            broadcast.target as BroadcastTarget,
            broadcast.targetGuilds,
            collectShardGuilds,
          );
          const channelMap = await loadGuildChannelMap();
          const deliveries = await deliverBroadcast(client, {
            title: broadcast.title,
            message: resolveEmojiShortcodes(broadcast.message),
            color: broadcast.color,
            thumbnailUrl: broadcast.thumbnailUrl,
            imageUrl: broadcast.imageUrl,
            footerText: broadcast.footerText ?? DEFAULT_BROADCAST_FOOTER,
            channelPref: broadcast.channelPref as BroadcastChannelPref,
            allowedIds: [...allowed],
            channelMap,
          });

          await finalizeBroadcast(broadcast.id, deliveries, allowed.size);
          await markBroadcastMediaUsed([broadcast.imageUrl, broadcast.thumbnailUrl]);
          logger.info('Broadcast', `Annonce programmee ${broadcast.id} envoyee (${deliveries.length} serveurs)`);
        } catch (err) {
          await prisma.broadcastLog.update({
            where: { id: broadcast.id },
            data: { status: 'FAILED', finishedAt: new Date() },
          }).catch(() => {});
          logger.error('Broadcast', `Annonce programmee ${broadcast.id} en echec:`, err);
        }
      }
    } catch (err) {
      logger.warn('Broadcast', `Tick du planificateur en echec: ${(err as Error).message}`);
    }
  };

  const timer = setInterval(() => { void tick(); }, TICK_MS);
  timer.unref?.();
  void tick();

  return () => clearInterval(timer);
}
