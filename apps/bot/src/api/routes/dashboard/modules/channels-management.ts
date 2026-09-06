/** Routes dashboard du module `channels-management`. */
import { updateGuildStats } from '../../../../events/stats.js';
import { readStatsConfig } from '../../../../services/analytics/statsConfig.js';
import { cache } from '../../../../utils/cache.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName, json, pushAudit, readJsonBody } from '../../../shared.js';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { resolveGuildLocale } from '../../../../utils/i18n.js';
import { honeypotChannelName, provisionHoneypotChannel } from '../../../../services/moderation/honeypotProvisioning.js';
import { type ModuleRouteContext } from './_shared.js';

/**
 * Fonctionnalites qui se reglent salon par salon, et le champ de la guilde qui
 * les porte. Toutes se ramenent a deux formes : une liste d'identifiants a
 * laquelle le salon appartient ou non, ou un champ unique qui pointe le salon
 * elu. La vue « Par salon » les manipule sans connaitre le detail de chacune.
 */
const CHANNEL_FEATURES = {
  autoThread: { kind: 'list', field: 'autoThreadChannels', label: 'Fils automatiques' },
  logIgnored: { kind: 'list', field: 'logIgnoredChannelIds', label: 'Exclu des logs' },
  honeypot: { kind: 'single', field: 'honeypotChannelId', label: 'Salon piège' },
  funCounting: { kind: 'single', field: 'funCountingChannelId', label: 'Comptage' },
  funOneWordStory: { kind: 'single', field: 'funOneWordStoryChannelId', label: 'Histoire à un mot' },
  funGuessNumber: { kind: 'single', field: 'funGuessNumberChannelId', label: 'Devine le nombre' },
  funWordChain: { kind: 'single', field: 'funWordChainChannelId', label: 'Chaîne de mots' },
  funEmojiRiddle: { kind: 'single', field: 'funEmojiRiddleChannelId', label: 'Rébus emoji' },
  funNeverSay: { kind: 'single', field: 'funNeverSayChannelId', label: 'Ni oui ni non' },
  funEmojiOnly: { kind: 'single', field: 'funEmojiOnlyChannelId', label: 'Emoji uniquement' },
} as const;

type ChannelFeatureKey = keyof typeof CHANNEL_FEATURES;

const CHANNEL_FEATURE_KEYS = Object.keys(CHANNEL_FEATURES) as ChannelFeatureKey[];

/** Colonnes a lire pour connaitre l'etat de toutes les fonctionnalites. */
const CHANNEL_FEATURE_SELECT = Object.fromEntries(
  CHANNEL_FEATURE_KEYS.map((key) => [CHANNEL_FEATURES[key].field, true]),
) as Record<string, true>;

export async function handleChannelsManagementRoutes(ctx: ModuleRouteContext): Promise<boolean> {
  const { req, res, parts, client, guildId, method, auditUser, moduleKey } = ctx;

  // GET /api/dashboard/guilds/:guildId/channels-management/by-channel
  //
  // Renvoie la liste des salons du serveur avec, pour chacun, les
  // fonctionnalites qui y sont actives. La page les reglait auparavant module
  // par module : savoir ce qui touchait un salon donne demandait de parcourir
  // cinq onglets.
  if (moduleKey === 'channels-management' && parts.length === 6 && parts[5] === 'by-channel' && method === 'GET') {
    try {
      const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
      if (!guild) {
        json(res, 404, { error: 'Serveur Discord introuvable' });
        return true;
      }
      if (guild.channels.cache.size === 0) await guild.channels.fetch().catch(() => null);

      const [config, stickies, tempVoiceGenerators] = await Promise.all([
        prisma.guild.findUnique({ where: { id: guildId }, select: CHANNEL_FEATURE_SELECT }),
        prisma.stickyMessage.findMany({ where: { guildId }, select: { channelId: true, enabled: true } }),
        prisma.guild
          .findUnique({ where: { id: guildId }, select: { tempVoiceGenerators: true, tempVoiceChannelId: true } })
          .then((g) => {
            const raw = Array.isArray(g?.tempVoiceGenerators) ? (g!.tempVoiceGenerators as unknown[]) : [];
            const ids = raw
              .map((item) => (item && typeof item === 'object' ? (item as Record<string, unknown>).channelId : null))
              .filter((id): id is string => typeof id === 'string');
            // Le generateur historique vit dans son propre champ : sans lui, un
            // serveur configure avant les generateurs multiples verrait le sien
            // disparaitre de la vue.
            if (g?.tempVoiceChannelId) ids.push(g.tempVoiceChannelId);
            return new Set(ids);
          }),
      ]);

      const stickyByChannel = new Map(stickies.map((s) => [s.channelId, s.enabled]));
      const record = (config ?? {}) as Record<string, unknown>;

      const featuresFor = (channelId: string) => {
        const active: string[] = [];
        for (const key of CHANNEL_FEATURE_KEYS) {
          const { kind, field } = CHANNEL_FEATURES[key];
          const value = record[field];
          const on = kind === 'list'
            ? Array.isArray(value) && (value as string[]).includes(channelId)
            : value === channelId;
          if (on) active.push(key);
        }
        if (stickyByChannel.has(channelId)) active.push('sticky');
        if (tempVoiceGenerators.has(channelId)) active.push('tempVoiceGenerator');
        return active;
      };

      const channels = Array.from(guild.channels.cache.values())
        .filter((ch) => ch.type !== ChannelType.GuildCategory && !ch.isThread())
        .map((ch) => ({
          id: ch.id,
          name: ch.name,
          type: ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice
            ? 'voice'
            : ch.type === ChannelType.GuildForum ? 'forum' : 'text',
          categoryId: ch.parentId,
          categoryName: ch.parent?.name ?? null,
          position: 'rawPosition' in ch ? ch.rawPosition : 0,
          // `manageable` dit si le bot peut renommer ou supprimer ce salon : la
          // page grise les actions plutot que de les laisser echouer au clic.
          manageable: 'manageable' in ch ? ch.manageable : false,
          features: featuresFor(ch.id),
        }))
        .sort((a, b) => (a.categoryName ?? '').localeCompare(b.categoryName ?? '') || a.position - b.position);

      json(res, 200, {
        channels,
        features: Object.fromEntries(CHANNEL_FEATURE_KEYS.map((k) => [k, CHANNEL_FEATURES[k].label])),
      });
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'Erreur GET by-channel:', err);
      json(res, 500, { error: 'Erreur lors de la récupération des salons' });
    }
    return true;
  }

  // PATCH /api/dashboard/guilds/:guildId/channels-management/by-channel/:channelId
  // { feature, enabled }
  if (moduleKey === 'channels-management' && parts.length === 7 && parts[5] === 'by-channel' && method === 'PATCH') {
    try {
      const channelId = parts[6];
      const body = await readJsonBody<{ feature?: string; enabled?: boolean }>(req);
      const feature = body?.feature as ChannelFeatureKey | undefined;

      if (!feature || !CHANNEL_FEATURE_KEYS.includes(feature)) {
        json(res, 400, { error: 'Fonctionnalité inconnue' });
        return true;
      }

      const { kind, field, label } = CHANNEL_FEATURES[feature];
      const enabled = body?.enabled === true;

      if (kind === 'single') {
        // Un champ unique ne se « decoche » pas ailleurs : eteindre revient a
        // vider le champ, et l'allumer deplace la fonctionnalite sur ce salon.
        await prisma.guild.update({
          where: { id: guildId },
          data: { [field]: enabled ? channelId : null },
        });
      } else {
        const current = await prisma.guild.findUnique({ where: { id: guildId }, select: { [field]: true } });
        const list = Array.isArray((current as Record<string, unknown> | null)?.[field])
          ? ((current as Record<string, unknown>)[field] as string[])
          : [];
        const next = enabled
          ? Array.from(new Set([...list, channelId]))
          : list.filter((id) => id !== channelId);
        await prisma.guild.update({ where: { id: guildId }, data: { [field]: next } });
      }

      await pushAudit(guildId, {
        channelId,
        user: auditUser,
        action: `${enabled ? 'Activation' : 'Désactivation'} : ${label}`,
        context: getGuildName(client, guildId),
        module: 'Salons',
        eventType: 'Settings',
        details: `Salon ${channelId} · ${label} ${enabled ? 'activé' : 'désactivé'}`,
      });

      json(res, 200, { success: true });
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'Erreur PATCH by-channel:', err);
      json(res, 500, { error: 'Erreur lors de la mise à jour du salon' });
    }
    return true;
  }

  // PATCH /api/dashboard/guilds/:guildId/channels-management/channel/:channelId
  // { name } - renomme le salon Discord
  if (moduleKey === 'channels-management' && parts.length === 7 && parts[5] === 'channel' && method === 'PATCH') {
    try {
      const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
      const channel = await guild?.channels.fetch(parts[6]).catch(() => null);
      if (!guild || !channel) {
        json(res, 404, { error: 'Salon introuvable' });
        return true;
      }
      if (!channel.manageable) {
        json(res, 403, { error: 'Le bot ne peut pas modifier ce salon (permissions ou hiérarchie).' });
        return true;
      }

      const body = await readJsonBody<{ name?: string }>(req);
      const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 100) : '';
      if (!name) {
        json(res, 400, { error: 'Nom de salon invalide' });
        return true;
      }

      const previous = channel.name;
      await channel.setName(name, `Renommé depuis le dashboard par ${auditUser}`);

      await pushAudit(guildId, {
        channelId: channel.id,
        user: auditUser,
        action: 'Renommage de salon',
        context: getGuildName(client, guildId),
        module: 'Salons',
        eventType: 'Manuel',
        details: `#${previous} → #${name}`,
      });

      json(res, 200, { success: true, name });
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'Erreur PATCH channel:', err);
      json(res, 500, { error: 'Erreur lors du renommage du salon' });
    }
    return true;
  }

  // DELETE /api/dashboard/guilds/:guildId/channels-management/channel/:channelId
  if (moduleKey === 'channels-management' && parts.length === 7 && parts[5] === 'channel' && method === 'DELETE') {
    try {
      const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
      const channel = await guild?.channels.fetch(parts[6]).catch(() => null);
      if (!guild || !channel) {
        json(res, 404, { error: 'Salon introuvable' });
        return true;
      }
      if (!channel.manageable) {
        json(res, 403, { error: 'Le bot ne peut pas supprimer ce salon (permissions ou hiérarchie).' });
        return true;
      }

      const name = channel.name;
      await channel.delete(`Supprimé depuis le dashboard par ${auditUser}`);

      await pushAudit(guildId, {
        channelId: null,
        user: auditUser,
        action: 'Suppression de salon',
        context: getGuildName(client, guildId),
        module: 'Salons',
        eventType: 'Manuel',
        details: `#${name} (${parts[6]})`,
      });

      json(res, 200, { success: true });
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'Erreur DELETE channel:', err);
      json(res, 500, { error: 'Erreur lors de la suppression du salon' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/channels-management/rescan-stats
  if (moduleKey === 'channels-management' && parts.length === 6 && parts[5] === 'rescan-stats' && method === 'POST') {
    try {
      const body = await readJsonBody<{ force?: boolean; forcer?: boolean }>(req);
      const force = !!(body?.force || body?.forcer);

      const { startHistoricalScraping } = await import('../../../../services/analytics/messageScraperService.js');
      await startHistoricalScraping(client, guildId, force);

      json(res, 200, { ok: true, message: 'Scraping historique lancé avec succès.' });
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'POST rescan-stats error:', err);
      json(res, 500, { error: 'Erreur lors du lancement du scraping' });
    }
    return true;
  }

  // ── Sticky bot ─────────────────────────────────────────────────────────────
  // GET /api/dashboard/guilds/:guildId/channels-management/sticky
  if (moduleKey === 'channels-management' && parts.length === 6 && parts[5] === 'sticky' && method === 'GET') {
    try {
      const stickies = await prisma.stickyMessage.findMany({
        where: { guildId },
        orderBy: { createdAt: 'asc' },
      });
      json(res, 200, { stickies });
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'GET sticky error:', err);
      json(res, 500, { error: 'Erreur lors du chargement des messages sticky' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/channels-management/sticky (upsert par salon)
  if (moduleKey === 'channels-management' && parts.length === 6 && parts[5] === 'sticky' && method === 'POST') {
    try {
      const body = await readJsonBody<{
        channelId?: string;
        enabled?: boolean;
        content?: string;
        embedEnabled?: boolean;
        embedTitle?: string | null;
        embedColor?: string;
        messageThreshold?: number;
        cooldownSeconds?: number;
      }>(req);

      const channelId = (body?.channelId || '').trim();
      if (!channelId) {
        json(res, 400, { error: 'Salon manquant' });
        return true;
      }

      const discordGuild = client.guilds.cache.get(guildId);
      const channel = discordGuild?.channels.cache.get(channelId);
      if (!channel || (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
        json(res, 400, { error: 'Salon textuel introuvable sur ce serveur' });
        return true;
      }

      const content = (body?.content ?? '').slice(0, 2000);
      if (!content.trim()) {
        json(res, 400, { error: 'Le message sticky ne peut pas être vide' });
        return true;
      }

      const threshold = Math.min(200, Math.max(1, Math.floor(Number(body?.messageThreshold ?? 5) || 5)));
      const cooldown = Math.min(3600, Math.max(0, Math.floor(Number(body?.cooldownSeconds ?? 10) || 0)));
      const embedColor = /^#[0-9a-fA-F]{6}$/.test(body?.embedColor ?? '') ? body!.embedColor! : '#5865F2';

      const payload = {
        enabled: body?.enabled ?? true,
        content,
        embedEnabled: !!body?.embedEnabled,
        embedTitle: (body?.embedTitle || '').slice(0, 256) || null,
        embedColor,
        messageThreshold: threshold,
        cooldownSeconds: cooldown,
      };

      const previous = await prisma.stickyMessage.findUnique({
        where: { guildId_channelId: { guildId, channelId } },
      });

      const sticky = await prisma.stickyMessage.upsert({
        where: { guildId_channelId: { guildId, channelId } },
        create: { guildId, channelId, ...payload },
        update: payload,
      });

      const { clearStickyMessage, invalidateStickyCache, repostSticky, resetStickyCounter } =
        await import('../../../../services/features/stickyMessageService.js');
      await invalidateStickyCache(guildId);
      resetStickyCounter(channelId);

      if (!sticky.enabled) {
        // Désactivation : on retire le message encore affiché.
        await clearStickyMessage(client, sticky);
        await prisma.stickyMessage.update({
          where: { id: sticky.id },
          data: { lastMessageId: null },
        }).catch(() => null);
        await invalidateStickyCache(guildId);
      } else {
        // Publication immédiate : sans ça, rien n'apparaît avant le prochain
        // franchissement de seuil, ce qui donne l'impression d'un module cassé.
        const contentChanged = !previous
          || previous.content !== sticky.content
          || previous.embedEnabled !== sticky.embedEnabled
          || previous.embedTitle !== sticky.embedTitle
          || previous.embedColor !== sticky.embedColor
          || !previous.enabled;
        if (contentChanged) await repostSticky(client, sticky, { force: true });
      }

      await pushAudit(guildId, {
        user: auditUser,
        action: `Configuration du sticky de #${channel.name}`,
        context: getGuildName(client, guildId),
        module: 'Gestion des salons',
        eventType: 'Manuel',
        details: `Sticky ${sticky.enabled ? 'actif' : 'désactivé'}, renvoi tous les ${threshold} message(s).`,
        channelId,
      });

      json(res, 200, { ok: true, sticky });
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'POST sticky error:', err);
      json(res, 500, { error: 'Erreur lors de l\'enregistrement du message sticky' });
    }
    return true;
  }

  // DELETE /api/dashboard/guilds/:guildId/channels-management/sticky/:channelId
  if (moduleKey === 'channels-management' && parts.length === 7 && parts[5] === 'sticky' && method === 'DELETE') {
    const channelId = parts[6];
    try {
      const sticky = await prisma.stickyMessage.findUnique({
        where: { guildId_channelId: { guildId, channelId } },
      });
      if (!sticky) {
        json(res, 404, { error: 'Sticky introuvable' });
        return true;
      }

      const { clearStickyMessage, invalidateStickyCache } =
        await import('../../../../services/features/stickyMessageService.js');
      await clearStickyMessage(client, sticky);
      await prisma.stickyMessage.delete({ where: { id: sticky.id } });
      await invalidateStickyCache(guildId);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Suppression d\'un message sticky',
        context: getGuildName(client, guildId),
        module: 'Gestion des salons',
        eventType: 'Manuel',
        details: `Sticky du salon ${channelId} supprimé.`,
        channelId,
      });

      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'DELETE sticky error:', err);
      json(res, 500, { error: 'Erreur lors de la suppression du message sticky' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/channels-management/sticky/:channelId/repost
  if (moduleKey === 'channels-management' && parts.length === 8 && parts[5] === 'sticky' && parts[7] === 'repost' && method === 'POST') {
    const channelId = parts[6];
    try {
      const sticky = await prisma.stickyMessage.findUnique({
        where: { guildId_channelId: { guildId, channelId } },
      });
      if (!sticky || !sticky.enabled) {
        json(res, 404, { error: 'Sticky introuvable ou désactivé' });
        return true;
      }

      const { repostSticky } = await import('../../../../services/features/stickyMessageService.js');
      const messageId = await repostSticky(client, sticky, { force: true });
      if (!messageId) {
        json(res, 502, { error: 'Renvoi impossible (salon ou permissions).' });
        return true;
      }

      json(res, 200, { ok: true, messageId });
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'POST sticky repost error:', err);
      json(res, 500, { error: 'Erreur lors du renvoi du message sticky' });
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/channels-management/temp-voice/channels
  if (moduleKey === 'channels-management' && parts.length === 7 && parts[5] === 'temp-voice' && parts[6] === 'channels' && method === 'GET') {
    try {
      const dbChannels = await prisma.tempVoiceChannel.findMany({
        where: { guildId }
      });

      const discordGuild = client.guilds.cache.get(guildId);
      const activeChannels = [];

      for (const dbChan of dbChannels) {
        const channel = discordGuild?.channels.cache.get(dbChan.id);
        if (channel && channel.type === ChannelType.GuildVoice) {
          const creatorMember = discordGuild ? await discordGuild.members.fetch(dbChan.creatorId).catch(() => null) : null;
          activeChannels.push({
            id: dbChan.id,
            name: channel.name,
            creatorId: dbChan.creatorId,
            creatorName: creatorMember?.displayName || 'Inconnu',
            creatorAvatar: creatorMember?.user.displayAvatarURL() || null,
            membersCount: channel.members.size,
            roleId: dbChan.roleId,
            createdAt: dbChan.createdAt
          });
        } else {
          // Clean up stale database entry
          await prisma.tempVoiceChannel.delete({ where: { id: dbChan.id } }).catch(() => null);
        }
      }

      json(res, 200, activeChannels);
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'GET active channels error:', err);
      json(res, 500, { error: 'Erreur lors du chargement des salons actifs.' });
    }
    return true;
  }

  // PATCH /api/dashboard/guilds/:guildId/channels-management/temp-voice/channels/:channelId
  if (moduleKey === 'channels-management' && parts.length === 8 && parts[5] === 'temp-voice' && parts[6] === 'channels' && method === 'PATCH') {
    const channelId = parts[7];
    try {
      const body = await readJsonBody<{ name?: string; roleId?: string | null; action?: 'DELETE' }>(req);
      const discordGuild = client.guilds.cache.get(guildId);
      const channel = discordGuild?.channels.cache.get(channelId);

      if (!channel || channel.type !== ChannelType.GuildVoice) {
        json(res, 404, { error: 'Salon introuvable.' });
        return true;
      }

      const dbChan = await prisma.tempVoiceChannel.findUnique({
        where: { id: channelId }
      });

      if (!dbChan) {
        json(res, 404, { error: 'Salon non enregistré.' });
        return true;
      }

      // 1. Action Delete
      if (body?.action === 'DELETE') {
        // Disconnect members
        for (const [_, member] of channel.members) {
          await member.voice.disconnect('Salon temporaire fermé via le dashboard.').catch(() => null);
        }
        await channel.delete('Fermé par le dashboard.').catch(() => null);
        await prisma.tempVoiceChannel.delete({ where: { id: channelId } }).catch(() => null);

        // Also clean up from local memory cache
        const { tempChannels } = await import('../../../../events/tempVoice.js');
        tempChannels.delete(channelId);

        await pushAudit(guildId, {
          user: auditUser,
          action: `Fermeture forcée du salon temporaire ${channel.name}`,
          context: getGuildName(client, guildId),
          module: 'Gestion des salons',
          eventType: 'Manuel',
          details: `Salon temporaire ${channel.name} (${channelId}) supprimé par l'administrateur.`,
          channelId: null
        });

        json(res, 200, { ok: true, message: 'Salon fermé avec succès.' });
        return true;
      }

      // 2. Action Update (Rename/Reserve)
      const data: Record<string, unknown> = {};

      if (body?.name !== undefined && body.name.trim() !== '') {
        const newName = body.name.trim();
        await channel.setName(newName).catch(() => null);
        await pushAudit(guildId, {
          user: auditUser,
          action: `Renommer salon temporaire ${channel.name} -> ${newName}`,
          context: getGuildName(client, guildId),
          module: 'Gestion des salons',
          eventType: 'Manuel',
          details: `Renommé de ${channel.name} à ${newName}.`,
          channelId: null
        });
      }

      if (body?.roleId !== undefined) {
        const newRoleId = body.roleId; // string | null

        if (newRoleId) {
          // Deny everyone connect
          await channel.permissionOverwrites.edit(guildId, {
            Connect: false
          }).catch(() => null);

          // Allow creator
          await channel.permissionOverwrites.edit(dbChan.creatorId, {
            Connect: true,
            ViewChannel: true,
            Speak: true
          }).catch(() => null);

          // Allow role
          await channel.permissionOverwrites.edit(newRoleId, {
            Connect: true,
            ViewChannel: true,
            Speak: true
          }).catch(() => null);

          data.roleId = newRoleId;
        } else {
          // Clear role connect restriction, revert back to general connect permission for everyone
          await channel.permissionOverwrites.edit(guildId, {
            Connect: true
          }).catch(() => null);

          data.roleId = null;
        }

        await prisma.tempVoiceChannel.update({
          where: { id: channelId },
          data
        });

        await pushAudit(guildId, {
          user: auditUser,
          action: newRoleId ? `Réservation du salon ${channel.name} pour le rôle ID ${newRoleId}` : `Libération de la réservation du salon ${channel.name}`,
          context: getGuildName(client, guildId),
          module: 'Gestion des salons',
          eventType: 'Manuel',
          details: newRoleId ? `Accès restreint au rôle ${newRoleId}.` : `Salon ouvert à tous.`,
          channelId: null
        });
      }

      json(res, 200, { ok: true, message: 'Salon mis à jour avec succès.' });
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'PATCH active channel error:', err);
      json(res, 500, { error: 'Erreur lors du mise à jour du salon.' });
    }
    return true;
  }

  // GET/PATCH /api/dashboard/guilds/:guildId/channels-management
  if (moduleKey === 'channels-management' && parts.length === 5) {
    if (method === 'GET') {
      try {
        const guild = await prisma.guild.findUnique({
          where: { id: guildId },
          select: {
            autoThreadEnabled: true,
            autoThreadChannels: true,
            autoThreadBotsEnabled: true,
            statsEnabled: true,
            statsConfig: true,
            tempVoiceEnabled: true,
            tempVoiceChannelId: true,
            tempVoiceCategoryId: true,
            tempVoiceNameTemplate: true,
            tempVoiceRequiredRoleId: true,
            tempVoiceGenerators: true,
            honeypotEnabled: true,
            honeypotChannelId: true,
            honeypotSanction: true,
            honeypotReinvite: true,
            verificationEnabled: true,
            verificationMode: true,
            verificationAction: true,
            verificationChannelId: true,
            verificationFallbackChannelId: true,
            verificationRoleId: true,
            verificationLogChannelId: true,
            verificationEmbedTitle: true,
            verificationEmbedDesc: true,
            verificationEmbedColor: true,
            verificationOnJoin: true,
            verificationSaveIp: true,
            verificationSaveDevice: true,
            verificationLevelCommand: true,
            verificationLevelJoin: true,
            verificationWarnThreshold: true,
            verificationWarnAutoMode: true,
            verificationWarnReason: true,
            warnWeightingEnabled: true,
            warnDecayDays: true,
            countArchivedInWarnScore: true,
            warnAutoArchiveDays: true,
            wordStatsEnabled: true,
            banHygieneEnabled: true,
          },
        });
        if (!guild) {
          json(res, 404, { error: 'Serveur introuvable' });
          return true;
        }
        json(res, 200, {
          autoThreadEnabled: guild.autoThreadEnabled,
          autoThreadChannels: guild.autoThreadChannels,
          autoThreadBotsEnabled: guild.autoThreadBotsEnabled,
          statsEnabled: guild.statsEnabled,
          statsConfig: guild.statsConfig,
          tempVoiceEnabled: guild.tempVoiceEnabled,
          tempVoiceChannelId: guild.tempVoiceChannelId,
          tempVoiceCategoryId: guild.tempVoiceCategoryId,
          tempVoiceNameTemplate: guild.tempVoiceNameTemplate,
          tempVoiceRequiredRoleId: guild.tempVoiceRequiredRoleId,
          tempVoiceGenerators: guild.tempVoiceGenerators,
          honeypotEnabled: guild.honeypotEnabled,
          honeypotChannelId: guild.honeypotChannelId,
          honeypotSanction: guild.honeypotSanction,
          honeypotReinvite: guild.honeypotReinvite,
          verificationEnabled: guild.verificationEnabled,
          verificationMode: guild.verificationMode,
          verificationAction: guild.verificationAction,
          verificationChannelId: guild.verificationChannelId,
          verificationFallbackChannelId: guild.verificationFallbackChannelId,
          verificationRoleId: guild.verificationRoleId,
          verificationLogChannelId: guild.verificationLogChannelId,
          verificationEmbedTitle: guild.verificationEmbedTitle,
          verificationEmbedDesc: guild.verificationEmbedDesc,
           verificationEmbedColor: guild.verificationEmbedColor,
          verificationOnJoin: guild.verificationOnJoin,
          verificationSaveIp: guild.verificationSaveIp,
          verificationSaveDevice: guild.verificationSaveDevice,
          verificationLevelCommand: guild.verificationLevelCommand,
          verificationLevelJoin: guild.verificationLevelJoin,
          verificationWarnThreshold: guild.verificationWarnThreshold,
          verificationWarnAutoMode: guild.verificationWarnAutoMode,
          verificationWarnReason: guild.verificationWarnReason,
          warnWeightingEnabled: guild.warnWeightingEnabled,
          warnDecayDays: guild.warnDecayDays,
          countArchivedInWarnScore: guild.countArchivedInWarnScore,
          warnAutoArchiveDays: guild.warnAutoArchiveDays,
          wordStatsEnabled: guild.wordStatsEnabled,
          banHygieneEnabled: guild.banHygieneEnabled,
        });
      } catch (err) {
        logger.error('ChannelsManagementAPI', 'GET config error:', err);
        json(res, 500, { error: 'Erreur lors de la récupération de la configuration' });
      }
      return true;
    }

    if (method === 'PATCH') {
      try {
        const body = await readJsonBody<{
          autoThreadEnabled?: boolean;
          autoThreadChannels?: string[];
          autoThreadBotsEnabled?: boolean;
          statsEnabled?: boolean;
          statsConfig?: unknown;
          tempVoiceEnabled?: boolean;
          tempVoiceChannelId?: string | null;
          tempVoiceCategoryId?: string | null;
          tempVoiceNameTemplate?: string;
          tempVoiceRequiredRoleId?: string | null;
          tempVoiceGenerators?: Array<{ channelId?: string; categoryId?: string; nameTemplate?: string; requiredRoleId?: string | null }>;
          honeypotEnabled?: boolean;
          /** Demande au dashboard de creer le salon piege automatiquement. */
          createHoneypotChannel?: boolean;
          honeypotChannelId?: string | null;
          honeypotSanction?: string;
          honeypotReinvite?: boolean;
          verificationEnabled?: boolean;
          verificationMode?: string;
          verificationAction?: string;
          verificationChannelId?: string | null;
          verificationFallbackChannelId?: string | null;
          verificationRoleId?: string | null;
          verificationLogChannelId?: string | null;
          verificationEmbedTitle?: string;
          verificationEmbedDesc?: string;
          verificationEmbedColor?: string;
          verificationOnJoin?: boolean;
          verificationSaveIp?: boolean;
          verificationSaveDevice?: boolean;
          verificationLevelCommand?: string;
          verificationLevelJoin?: string;
          verificationWarnThreshold?: number | null;
          verificationWarnAutoMode?: string;
          verificationWarnReason?: string;
          warnWeightingEnabled?: boolean;
          warnDecayDays?: number | null;
          countArchivedInWarnScore?: boolean;
          warnAutoArchiveDays?: number | null;
          wordStatsEnabled?: boolean;
          banHygieneEnabled?: boolean;
        }>(req);

        if (!body) {
          json(res, 400, { error: 'Payload invalide' });
          return true;
        }

        const data: Record<string, unknown> = {};
        if (Object.prototype.hasOwnProperty.call(body, 'autoThreadEnabled')) {
          data.autoThreadEnabled = !!body.autoThreadEnabled;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'autoThreadChannels')) {
          data.autoThreadChannels = body.autoThreadChannels;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'autoThreadBotsEnabled')) {
          data.autoThreadBotsEnabled = !!body.autoThreadBotsEnabled;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'statsEnabled')) {
          data.statsEnabled = !!body.statsEnabled;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'statsConfig')) {
          data.statsConfig = body.statsConfig;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'tempVoiceEnabled')) {
          data.tempVoiceEnabled = !!body.tempVoiceEnabled;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'tempVoiceChannelId')) {
          data.tempVoiceChannelId = body.tempVoiceChannelId;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'tempVoiceCategoryId')) {
          data.tempVoiceCategoryId = body.tempVoiceCategoryId;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'tempVoiceNameTemplate')) {
          data.tempVoiceNameTemplate = body.tempVoiceNameTemplate;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'tempVoiceRequiredRoleId')) {
          data.tempVoiceRequiredRoleId = body.tempVoiceRequiredRoleId;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'tempVoiceGenerators')) {
          data.tempVoiceGenerators = body.tempVoiceGenerators;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'honeypotEnabled')) {
          data.honeypotEnabled = !!body.honeypotEnabled;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'honeypotChannelId')) {
          data.honeypotChannelId = body.honeypotChannelId;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'honeypotSanction')) {
          if (['WARN', 'KICK', 'TIMEOUT', 'BAN', 'SOFTBAN'].includes(body.honeypotSanction as string)) {
            data.honeypotSanction = body.honeypotSanction;
          } else {
            json(res, 400, { error: 'Type de sanction honeypot invalide' });
            return true;
          }
        }
        if (Object.prototype.hasOwnProperty.call(body, 'honeypotReinvite')) {
          data.honeypotReinvite = !!body.honeypotReinvite;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationEnabled')) {
          data.verificationEnabled = !!body.verificationEnabled;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationMode')) {
          if (['DM', 'EMBED'].includes(body.verificationMode as string)) {
            data.verificationMode = body.verificationMode;
          }
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationAction')) {
          if (['AUTO_LINK', 'NOTIFY_STAFF'].includes(body.verificationAction as string)) {
            data.verificationAction = body.verificationAction;
          }
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationChannelId')) {
          data.verificationChannelId = body.verificationChannelId;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationFallbackChannelId')) {
          data.verificationFallbackChannelId = body.verificationFallbackChannelId;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationRoleId')) {
          data.verificationRoleId = body.verificationRoleId;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationLogChannelId')) {
          data.verificationLogChannelId = body.verificationLogChannelId;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationEmbedTitle')) {
          data.verificationEmbedTitle = (body.verificationEmbedTitle || '').slice(0, 256);
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationEmbedDesc')) {
          data.verificationEmbedDesc = (body.verificationEmbedDesc || '').slice(0, 2048);
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationEmbedColor')) {
          data.verificationEmbedColor = body.verificationEmbedColor;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationOnJoin')) {
          data.verificationOnJoin = !!body.verificationOnJoin;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationSaveIp')) {
          data.verificationSaveIp = !!body.verificationSaveIp;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationSaveDevice')) {
          data.verificationSaveDevice = !!body.verificationSaveDevice;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationLevelCommand')) {
          if (['LOW', 'MEDIUM', 'HIGH'].includes(body.verificationLevelCommand as string)) {
            data.verificationLevelCommand = body.verificationLevelCommand;
          }
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationLevelJoin')) {
          if (['LOW', 'MEDIUM', 'HIGH'].includes(body.verificationLevelJoin as string)) {
            data.verificationLevelJoin = body.verificationLevelJoin;
          }
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationWarnThreshold')) {
          // null or 0 = disabled, positive integer = threshold
          if (body.verificationWarnThreshold === null || body.verificationWarnThreshold === 0) {
            data.verificationWarnThreshold = null;
          } else if (typeof body.verificationWarnThreshold === 'number' && body.verificationWarnThreshold > 0) {
            data.verificationWarnThreshold = Math.floor(body.verificationWarnThreshold);
          }
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationWarnAutoMode')) {
          if (['FULL_AUTO', 'NOTIFY_STAFF'].includes(body.verificationWarnAutoMode as string)) {
            data.verificationWarnAutoMode = body.verificationWarnAutoMode;
          }
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationWarnReason')) {
          data.verificationWarnReason = (body.verificationWarnReason || '').slice(0, 512);
        }
        if (Object.prototype.hasOwnProperty.call(body, 'warnWeightingEnabled')) {
          data.warnWeightingEnabled = !!body.warnWeightingEnabled;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'warnDecayDays')) {
          // null ou 0 = pas de décroissance, entier positif = fenêtre en jours
          if (body.warnDecayDays === null || body.warnDecayDays === 0) {
            data.warnDecayDays = null;
          } else if (typeof body.warnDecayDays === 'number' && body.warnDecayDays > 0) {
            data.warnDecayDays = Math.floor(body.warnDecayDays);
          }
        }
        if (Object.prototype.hasOwnProperty.call(body, 'countArchivedInWarnScore')) {
          data.countArchivedInWarnScore = !!body.countArchivedInWarnScore;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'warnAutoArchiveDays')) {
          // null ou 0 = pas d'expiration automatique des warns
          if (body.warnAutoArchiveDays === null || body.warnAutoArchiveDays === 0) {
            data.warnAutoArchiveDays = null;
          } else if (typeof body.warnAutoArchiveDays === 'number' && body.warnAutoArchiveDays > 0) {
            data.warnAutoArchiveDays = Math.floor(body.warnAutoArchiveDays);
          }
        }
        if (Object.prototype.hasOwnProperty.call(body, 'wordStatsEnabled')) {
          data.wordStatsEnabled = !!body.wordStatsEnabled;
        }
        // Capturé avant l'update : sert à détecter la bascule off → on plus bas.
        const wordStatsWasEnabled = Object.prototype.hasOwnProperty.call(body, 'wordStatsEnabled')
          ? (await prisma.guild.findUnique({ where: { id: guildId }, select: { wordStatsEnabled: true } }))?.wordStatsEnabled ?? false
          : null;
        if (Object.prototype.hasOwnProperty.call(body, 'banHygieneEnabled')) {
          data.banHygieneEnabled = !!body.banHygieneEnabled;
        }

        const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);

        if (discordGuild) {
          if (body.tempVoiceEnabled) {
            if (!body.tempVoiceCategoryId) {
              const existing = discordGuild.channels.cache.find(
                c => c.type === ChannelType.GuildCategory && c.name === '🔊 Salons Vocaux'
              );
              const cat = existing || await discordGuild.channels.create({
                name: '🔊 Salons Vocaux',
                type: ChannelType.GuildCategory,
              }).catch(() => null);
              if (cat) data.tempVoiceCategoryId = cat.id;
            }
            if (!body.tempVoiceChannelId) {
              const parentId = (data.tempVoiceCategoryId as string | undefined) || body.tempVoiceCategoryId || undefined;
              const newVoice = await discordGuild.channels.create({
                name: '➕ Créer un salon',
                type: ChannelType.GuildVoice,
                parent: parentId,
              }).catch(() => null);
              if (newVoice) {
                data.tempVoiceChannelId = newVoice.id;
              }
            }

            // Auto-create channels for additional generators
            if (Array.isArray(body.tempVoiceGenerators)) {
              const resolvedGenerators = [];
              for (const gen of body.tempVoiceGenerators) {
                const resolved = { ...gen };

                if (!resolved.categoryId) {
                  const cat = await discordGuild.channels.create({
                    name: '🔊 Salons Vocaux',
                    type: ChannelType.GuildCategory,
                  }).catch(() => null);
                  if (cat) resolved.categoryId = cat.id;
                }

                if (!resolved.channelId) {
                  const newVoice = await discordGuild.channels.create({
                    name: '➕ Créer un salon',
                    type: ChannelType.GuildVoice,
                    parent: resolved.categoryId || undefined,
                  }).catch(() => null);
                  if (newVoice) resolved.channelId = newVoice.id;
                }

                if (resolved.channelId) {
                  resolvedGenerators.push(resolved);
                }
              }
              data.tempVoiceGenerators = resolvedGenerators;
            }
          }

          if (body.honeypotEnabled && body.createHoneypotChannel) {
            const locale = await resolveGuildLocale(guildId, discordGuild.preferredLocale);
            const newHoneypot = await provisionHoneypotChannel(discordGuild, {
              name: honeypotChannelName(locale),
            }).catch(() => null);
            if (newHoneypot) {
              data.honeypotChannelId = newHoneypot.id;
            }
          }

          if (body.statsEnabled && body.statsConfig) {
            const sc = readStatsConfig(body.statsConfig);

            const needsMember = sc.memberChannelId === '' || sc.memberChannelId === null;
            const needsBot = sc.botChannelId === '' || sc.botChannelId === null;
            const needsRole = sc.roleChannelId === '' || sc.roleChannelId === null;
            const needsChannel = sc.channelChannelId === '' || sc.channelChannelId === null;
            const needsCategory = sc.categoryChannelId === '' || sc.categoryChannelId === null;
            const needsActivity = sc.activityChannelId === '' || sc.activityChannelId === null;
            const needsCustomStats = Array.isArray(sc.customStats) && sc.customStats.some((c) => c.enabled && !c.channelId);

            if (needsMember || needsBot || needsRole || needsChannel || needsCategory || needsActivity || needsCustomStats || !sc.categoryId) {
              let statsCatId: string | undefined = sc.categoryId || undefined;
              
              if (!statsCatId) {
                const existingStatsCat = discordGuild.channels.cache.find(
                  c => c.type === ChannelType.GuildCategory && c.name === '📊 Statistiques'
                );
                if (existingStatsCat) {
                  statsCatId = existingStatsCat.id;
                } else {
                  const newCat = await discordGuild.channels.create({
                    name: '📊 Statistiques',
                    type: ChannelType.GuildCategory,
                    permissionOverwrites: [
                      {
                        id: discordGuild.roles.everyone.id,
                        deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.SendMessages],
                      },
                    ],
                  }).catch(() => null);
                  if (newCat) statsCatId = newCat.id;
                }
              }

              const createStatChannel = async (defaultName: string, asCategory = false): Promise<string | undefined> => {
                if (asCategory) {
                  const ch = await discordGuild.channels.create({
                    name: defaultName,
                    type: ChannelType.GuildCategory,
                    permissionOverwrites: [
                      {
                        id: discordGuild.roles.everyone.id,
                        deny: [PermissionFlagsBits.SendMessages],
                      },
                    ],
                  }).catch(() => null);
                  return ch?.id;
                }
                const ch = await discordGuild.channels.create({
                  name: defaultName,
                  type: ChannelType.GuildVoice,
                  parent: statsCatId,
                  permissionOverwrites: [
                    {
                      id: discordGuild.roles.everyone.id,
                      deny: [PermissionFlagsBits.Connect],
                    },
                  ],
                }).catch(() => null);
                return ch?.id;
              };

              const newSc = { ...sc };
              if (statsCatId) {
                newSc.categoryId = statsCatId;
              }

              if (needsMember) {
                const tpl = sc.memberTemplate || '👤 Membres : {count}';
                newSc.memberChannelId = await createStatChannel(tpl.replace('{count}', '…')) ?? sc.memberChannelId;
              }
              if (needsBot) {
                const tpl = sc.botTemplate || '🤖 Bots : {count}';
                newSc.botChannelId = await createStatChannel(tpl.replace('{count}', '…')) ?? sc.botChannelId;
              }
              if (needsRole) {
                const tpl = sc.roleTemplate || '👑 Staff : {count}';
                newSc.roleChannelId = await createStatChannel(tpl.replace('{count}', '…')) ?? sc.roleChannelId;
              }
              if (needsChannel) {
                const tpl = sc.channelTemplate || '💬 Salons : {count}';
                newSc.channelChannelId = await createStatChannel(tpl.replace('{count}', '…')) ?? sc.channelChannelId;
              }
              if (needsCategory) {
                const tpl = sc.categoryTemplate || '📁 Catégories : {count}';
                newSc.categoryChannelId = await createStatChannel(tpl.replace('{count}', '…')) ?? sc.categoryChannelId;
              }
              if (needsActivity) {
                const tpl = sc.activityTemplate || '📈 Actifs 24h : {count}';
                newSc.activityChannelId = await createStatChannel(tpl.replace('{count}', '…')) ?? sc.activityChannelId;
              }

              if (Array.isArray(sc.customStats)) {
                const updatedCustomStats = [];
                for (const custom of sc.customStats) {
                  const item = { ...custom };
                  if (item.enabled && !item.channelId) {
                    const tpl = item.template || 'Stat : {count}';
                    let initialName = tpl.replace('{count}', '…');
                    if (item.type === 'goal' && item.goalTarget) {
                      initialName = initialName.replace('{goal}', item.goalTarget.toString());
                    }
                    item.channelId = await createStatChannel(initialName, item.channelType === 'category') ?? '';
                  }
                  updatedCustomStats.push(item);
                }
                newSc.customStats = updatedCustomStats;
              }

              data.statsConfig = newSc;
            }
          }
        }

        await prisma.guild.update({
          where: { id: guildId },
          data,
        });

        // Purge les caches préfixés guild:<id>: - config du bot (getCachedGuild)
        // et payloads d'analytics avancées, qui embarquent les toggles (ex.
        // wordStatsEnabled). Sans ça, le dashboard continue d'afficher l'ancien
        // état pendant toute la durée du TTL.
        await cache.invalidateGuild(guildId);

        // Activation des stats de mots : indexer les messages déjà journalisés
        // plutôt que d'attendre que le tracker live accumule des données.
        if (wordStatsWasEnabled === false && data.wordStatsEnabled === true) {
          void (async () => {
            const { startWordStatsBackfill, backfillMessageMentions } = await import('../../../../services/analytics/wordStatsBackfillService.js');
            await backfillMessageMentions(guildId).catch((err) =>
              logger.error('ChannelsManagementAPI', `Backfill des mentions échoué pour ${guildId}:`, err),
            );
            await startWordStatsBackfill(guildId);
          })().catch((err) =>
            logger.error('ChannelsManagementAPI', `Lancement du backfill des stats de mots échoué pour ${guildId}:`, err),
          );
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Sauvegarde configuration Gestion des salons',
          context: getGuildName(client, guildId),
          module: 'Gestion des salons',
          eventType: 'Manuel',
          details: 'Configuration de la gestion des salons mise à jour.',
          channelId: null
        });

        if (body.statsEnabled) {
          updateGuildStats(client, guildId).catch((err) => 
            logger.error('ChannelsManagementAPI', `Erreur lors de la mise à jour des stats pour la guilde ${guildId} :`, err)
          );
        }

        if (Object.prototype.hasOwnProperty.call(body, 'autoThreadEnabled')) {
          await prisma.dashboardFeatureConfig.upsert({
            where: { guildId_featureKey: { guildId, featureKey: 'auto_thread' } },
            create: {
              guildId,
              featureKey: 'auto_thread',
              featureName: 'Gestion des salons',
              enabled: !!body.autoThreadEnabled,
              loggingEnabled: true,
              userActivityTracking: true,
              notifyViaDiscordChannel: true,
            },
            update: {
              enabled: !!body.autoThreadEnabled
            }
          });
        }

        json(res, 200, {
          ok: true,
          resolved: {
            tempVoiceChannelId: data.tempVoiceChannelId,
            tempVoiceCategoryId: data.tempVoiceCategoryId,
            tempVoiceGenerators: data.tempVoiceGenerators,
            honeypotChannelId: data.honeypotChannelId,
            honeypotSanction: data.honeypotSanction,
            honeypotReinvite: data.honeypotReinvite,
            statsConfig: data.statsConfig,
          }
        });
      } catch (err) {
        logger.error('ChannelsManagementAPI', 'PATCH config error:', err);
        json(res, 500, { error: 'Erreur lors de la mise à jour' });
      }
      return true;
    }
  }

  return false;
}
