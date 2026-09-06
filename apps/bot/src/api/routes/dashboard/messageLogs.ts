import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { cache } from '../../../utils/cache.js';
import { logger } from '../../../utils/logger.js';
import { json, readJsonBody, type AuthClaims, type DashboardAccess } from '../../shared.js';

/**
 * Global message search - Discord/Windows-style full-text search across every
 * message the bot has recorded for a guild (when message logging is enabled).
 *
 * Routes (all under /api/dashboard/guilds/:guildId/message-logs):
 *   GET    /search?q=&channelId=&authorId=&isBot=&hasAttachment=&includeDeleted=&from=&to=&limit=&offset=&order=
 *   GET    /channels                 → distinct channels present in the logs (for filters)
 *   DELETE /:messageLogId            → delete a single logged message (admin)
 *   DELETE ?channelId=&before=       → bulk delete logged messages (admin)
 */
export async function handleMessageLogRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  _client: Client,
  _user: AuthClaims,
  guildId: string,
  access: DashboardAccess,
): Promise<boolean> {
  const method = req.method;
  if (parts[4] !== 'message-logs') return false;

  // Message content can be sensitive → restrict to staff.
  const isStaff = access.level === 'admin' || access.level === 'moderator';
  if (!isStaff) {
    json(res, 403, { error: 'Accès refusé. Réservé au staff.' });
    return true;
  }

  // GET /message-logs/search
  if (parts.length === 6 && parts[5] === 'search' && method === 'GET') {
    try {
      const q = url.searchParams.get('q')?.trim() || '';
      const channelId = url.searchParams.get('channelId')?.trim() || '';
      const authorId = url.searchParams.get('authorId')?.trim() || '';
      const isBotParam = url.searchParams.get('isBot');
      const hasAttachmentParam = url.searchParams.get('hasAttachment');
      const includeDeleted = url.searchParams.get('includeDeleted') === 'true';
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const order = url.searchParams.get('order') === 'asc' ? 'asc' : 'desc';
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 100);
      const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);

      const where: Record<string, unknown> = { guildId };
      if (q) where.content = { contains: q, mode: 'insensitive' };
      if (channelId) where.channelId = channelId;
      if (authorId) where.authorId = authorId;
      if (isBotParam === 'true') where.isBot = true;
      if (isBotParam === 'false') where.isBot = false;
      if (hasAttachmentParam === 'true') where.hasAttachment = true;
      if (!includeDeleted) where.deletedAt = null;
      if (from || to) {
        const createdAt: Record<string, Date> = {};
        if (from) { const d = new Date(from); if (!isNaN(d.getTime())) createdAt.gte = d; }
        if (to) { const d = new Date(to); if (!isNaN(d.getTime())) createdAt.lte = d; }
        if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;
      }

      const [messages, total] = await Promise.all([
        prisma.messageLog.findMany({
          where,
          orderBy: { createdAt: order },
          skip: offset,
          take: limit,
        }),
        prisma.messageLog.count({ where }),
      ]);

      json(res, 200, { messages, total, limit, offset });
    } catch (err) {
      logger.error('MessageLogsAPI', 'Erreur lors de la recherche de messages:', err);
      json(res, 500, { error: 'Erreur lors de la recherche de messages' });
    }
    return true;
  }

  // GET /message-logs/channels → distinct channels for the filter dropdown
  // ?authorId= narrows the list to the channels a single member actually posted in.
  if (parts.length === 6 && parts[5] === 'channels' && method === 'GET') {
    try {
      const authorId = url.searchParams.get('authorId')?.trim() || '';
      const rows = await prisma.messageLog.groupBy({
        by: ['channelId', 'channelName'],
        where: authorId ? { guildId, authorId } : { guildId },
        _count: { _all: true },
        _max: { createdAt: true },
        orderBy: { _count: { channelId: 'desc' } },
        take: 200,
      });
      // A renamed channel yields one row per historical name → merge them back
      // into a single entry (the dropdown is keyed by channelId) and keep the
      // most recently seen name.
      const merged = new Map<string, { channelId: string; channelName: string; count: number; lastSeen: number }>();
      for (const r of rows) {
        const lastSeen = r._max.createdAt?.getTime() ?? 0;
        const existing = merged.get(r.channelId);
        if (!existing) {
          merged.set(r.channelId, {
            channelId: r.channelId,
            channelName: r.channelName,
            count: r._count._all,
            lastSeen,
          });
          continue;
        }
        existing.count += r._count._all;
        if (lastSeen > existing.lastSeen) {
          existing.channelName = r.channelName;
          existing.lastSeen = lastSeen;
        }
      }
      const channels = [...merged.values()]
        .sort((a, b) => b.count - a.count)
        .map(({ channelId, channelName, count }) => ({ channelId, channelName, count }));
      json(res, 200, { channels });
    } catch (err) {
      logger.error('MessageLogsAPI', 'Erreur lors de la récupération des salons:', err);
      json(res, 500, { error: 'Erreur lors de la récupération des salons' });
    }
    return true;
  }

  // GET /message-logs/stats → quick overview (total logged, enabled state)
  if (parts.length === 6 && parts[5] === 'stats' && method === 'GET') {
    try {
      const [total, config] = await Promise.all([
        prisma.messageLog.count({ where: { guildId } }),
        prisma.guild.findUnique({
          where: { id: guildId },
          select: {
            messageLoggingEnabled: true,
            messageLoggingRetentionDays: true,
            messageLoggingIgnoredChannels: true,
            messageLoggingStatus: true,
          },
        }),
      ]);
      json(res, 200, {
        total,
        enabled: config?.messageLoggingEnabled ?? false,
        retentionDays: config?.messageLoggingRetentionDays ?? 90,
        ignoredChannels: config?.messageLoggingIgnoredChannels ?? [],
        status: config?.messageLoggingStatus ?? null,
      });
    } catch (err) {
      logger.error('MessageLogsAPI', 'Erreur lors de la récupération des statistiques:', err);
      json(res, 500, { error: 'Erreur lors de la récupération des statistiques' });
    }
    return true;
  }

  // PATCH /message-logs/config - enable/disable logging + retention (admin only)
  if (parts.length === 6 && parts[5] === 'config' && method === 'PATCH') {
    if (access.level !== 'admin') {
      json(res, 403, { error: 'Seuls les administrateurs peuvent modifier la configuration.' });
      return true;
    }
    try {
      const body = await readJsonBody<{
        enabled?: boolean;
        retentionDays?: number;
        ignoredChannels?: string[];
      }>(req);
      const data: Record<string, unknown> = {};
      if (typeof body?.enabled === 'boolean') data.messageLoggingEnabled = body.enabled;
      if (typeof body?.retentionDays === 'number' && Number.isFinite(body.retentionDays)) {
        data.messageLoggingRetentionDays = Math.min(Math.max(Math.floor(body.retentionDays), 0), 3650);
      }
      if (Array.isArray(body?.ignoredChannels)) {
        data.messageLoggingIgnoredChannels = body.ignoredChannels.filter((c) => typeof c === 'string');
      }
      if (Object.keys(data).length === 0) {
        json(res, 400, { error: 'Aucun champ valide fourni.' });
        return true;
      }
      const updated = await prisma.guild.update({
        where: { id: guildId },
        data,
        select: {
          messageLoggingEnabled: true,
          messageLoggingRetentionDays: true,
          messageLoggingIgnoredChannels: true,
          messageLoggingStatus: true,
        },
      });

      // `getCachedGuild` sert les écouteurs de messages : sans purge, la liste
      // des salons ignorés ne prendrait effet qu'à l'expiration du cache.
      await cache.invalidateGuild(guildId);

      if (body?.enabled === true) {
        const { startMessageLoggingBackfill } = await import('../../../services/features/messageLoggingScraperService.js');
        void startMessageLoggingBackfill(_client, guildId);
      }

      json(res, 200, {
        enabled: updated.messageLoggingEnabled,
        retentionDays: updated.messageLoggingRetentionDays,
        ignoredChannels: updated.messageLoggingIgnoredChannels,
        status: updated.messageLoggingStatus,
      });
    } catch (err) {
      logger.error('MessageLogsAPI', 'Erreur lors de la mise à jour de la configuration:', err);
      json(res, 500, { error: 'Erreur lors de la mise à jour de la configuration' });
    }
    return true;
  }

  // DELETE /message-logs  (bulk, via query params) - admin only
  if (parts.length === 5 && method === 'DELETE') {
    if (access.level !== 'admin') {
      json(res, 403, { error: 'Seuls les administrateurs peuvent supprimer des messages.' });
      return true;
    }
    try {
      const channelId = url.searchParams.get('channelId')?.trim() || '';
      const before = url.searchParams.get('before');
      const where: Record<string, unknown> = { guildId };
      if (channelId) where.channelId = channelId;
      if (before) {
        const d = new Date(before);
        if (!isNaN(d.getTime())) where.createdAt = { lt: d };
      }
      // Guard against wiping the entire guild by accident: require at least one filter.
      if (!channelId && !before) {
        json(res, 400, { error: 'Précisez au moins un filtre (channelId ou before) pour une suppression groupée.' });
        return true;
      }
      const { count } = await prisma.messageLog.deleteMany({ where });
      json(res, 200, { ok: true, deleted: count });
    } catch (err) {
      logger.error('MessageLogsAPI', 'Erreur lors de la suppression groupée:', err);
      json(res, 500, { error: 'Erreur lors de la suppression groupée' });
    }
    return true;
  }

  // DELETE /message-logs/:messageLogId - admin only
  if (parts.length === 6 && method === 'DELETE') {
    if (access.level !== 'admin') {
      json(res, 403, { error: 'Seuls les administrateurs peuvent supprimer des messages.' });
      return true;
    }
    const id = parts[5];
    try {
      const log = await prisma.messageLog.findUnique({ where: { id }, select: { id: true, guildId: true } });
      if (!log || log.guildId !== guildId) {
        json(res, 404, { error: 'Message introuvable' });
        return true;
      }
      await prisma.messageLog.delete({ where: { id } });
      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('MessageLogsAPI', 'Erreur lors de la suppression du message:', err);
      json(res, 500, { error: 'Erreur lors de la suppression du message' });
    }
    return true;
  }

  return false;
}
