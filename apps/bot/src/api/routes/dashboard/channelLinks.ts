import { IncomingMessage, ServerResponse } from 'node:http';
import { ChannelType, Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import {
  json,
  readJsonBody,
  type AuthClaims,
} from '../../shared.js';
import {
  addGroupMember,
  createDirectGroup,
  getGroup,
  inspectRelayPermissions,
  needsMessageMapping,
  refreshGroupTopics,
  removeGroup,
  removeGroupMember,
  updateGroupConfig,
  updateGroupMemberConfig,
  type LinkGroup,
  type LinkMemberMode,
  type LinkRelayMode,
} from '../../../services/features/channelLinkService.js';
import { isLinkGuestGuild } from '../../../services/features/channelLinkGuestService.js';
import { INVITE_SOURCE, recordBotInvite } from '../../../services/analytics/inviteService.js';

const RESERVED_SEGMENTS = new Set(['invites', 'other-guilds', 'direct']);

function readMode(value: unknown, fallback: LinkMemberMode = 'BOTH'): LinkMemberMode {
  return value === 'SEND_ONLY' || value === 'RECEIVE_ONLY' || value === 'BOTH' ? value : fallback;
}

function readRelayMode(value: unknown, fallback: LinkRelayMode = 'WEBHOOK'): LinkRelayMode {
  return value === 'EMBED' ? 'EMBED' : fallback;
}

function serializeGroup(group: LinkGroup, guildId: string, client: Client) {
  const issuesByMember = new Map(inspectRelayPermissions(client, group).map((issue) => [issue.memberId, issue]));

  const members = group.members.map((member) => {
    const memberGuild = client.guilds.cache.get(member.guildId);
    const channel = memberGuild?.channels.cache.get(member.channelId);
    const issue = issuesByMember.get(member.id);
    return {
      id: member.id,
      guildId: member.guildId,
      guildName: memberGuild?.name ?? member.guildId,
      guildIcon: memberGuild?.iconURL() ?? null,
      channelId: member.channelId,
      channelName: channel?.name ?? member.channelId,
      mode: member.mode,
      relayMode: member.relayMode,
      enabled: member.enabled,
      isLocal: member.guildId === guildId,
      // Ce serveur n'a pas de clé : il ne voit que ce pont, et Kotbo n'y
      // collecte rien. À afficher pour lever le doute des communautés qui
      // acceptent un lien sans vouloir « du bot ».
      isLinkOnly: isLinkGuestGuild(member.guildId),
      // Ce qui manque à ce salon pour relayer complètement. Un webhook emprunte
      // les permissions d'@everyone : sans emojis externes, Discord réduit les
      // emojis venus d'ailleurs à leur raccourci, sans que rien ne l'explique.
      missingBotPermissions: issue?.bot.map((permission) => permission.key) ?? [],
      missingEveryonePermissions: issue?.everyone.map((permission) => permission.key) ?? [],
      channelMissing: issue?.channelMissing ?? false,
    };
  });

  return {
    ...group,
    members,
    localMembers: members.filter((m) => m.isLocal),
    remoteGuildCount: new Set(members.filter((m) => !m.isLocal).map((m) => m.guildId)).size,
    // `true` quand ce pont inscrit en base la correspondance entre un message et
    // ses copies - nécessaire aux éditions, suppressions, réactions et
    // épinglages, inutile autrement.
    storesMessageMap: needsMessageMapping(group),
  };
}

async function canManageGuild(client: Client, guildId: string, userId: string): Promise<boolean> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return false;
  const member = guild.members.cache.get(userId) ?? await guild.members.fetch(userId).catch(() => null);
  if (!member) return false;
  return member.permissions.has('Administrator') || member.permissions.has('ManageGuild');
}

export async function handleChannelLinkRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
): Promise<boolean> {
  const method = req.method;

  if (parts[4] !== 'channel-links') return false;

  // GET /api/dashboard/guilds/:guildId/channel-links
  if (parts.length === 5 && method === 'GET') {
    try {
      const groups = await prisma.channelLinkGroup.findMany({
        where: { members: { some: { guildId } } },
        include: { members: true },
        orderBy: { createdAt: 'desc' },
      });

      json(res, 200, groups.map((group) => serializeGroup(group, guildId, client)));
    } catch (err) {
      logger.error('ChannelLinkAPI', 'Erreur GET channel-links', err);
      json(res, 500, { error: 'Erreur serveur' });
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/channel-links/other-guilds
  if (parts.length === 6 && parts[5] === 'other-guilds' && method === 'GET') {
    try {
      // Le membre etait resolu serveur par serveur, en sequence : chaque
      // absence du cache declenchait un aller-retour Discord, et la reponse
      // coutait donc N fois cette latence. On lit d'abord le cache, et les
      // fetchs restants partent en parallele (discord.js gere lui-meme la file
      // de rate limit).
      const resolved = await Promise.all(
        [...client.guilds.cache.values()].map(async (guild) => {
          const member = guild.members.cache.get(user.userId)
            ?? await guild.members.fetch(user.userId).catch(() => null);
          if (!member) return null;
          if (!member.permissions.has('Administrator') && !member.permissions.has('ManageGuild')) return null;

          const channels = guild.channels.cache
            .filter((c) => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
            .map((c) => ({ id: c.id, name: c.name }))
            .sort((a, b) => a.name.localeCompare(b.name, 'fr'));

          return {
            id: guild.id,
            name: guild.name,
            icon: guild.iconURL({ size: 64 }) ?? null,
            channels,
          };
        }),
      );

      json(res, 200, resolved.filter((guild) => guild !== null));
    } catch (err) {
      logger.error('ChannelLinkAPI', 'Erreur GET other-guilds', err);
      json(res, 500, { error: 'Erreur serveur' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/channel-links/direct
  if (parts.length === 6 && parts[5] === 'direct' && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const sourceChannelId = typeof body?.sourceChannelId === 'string' ? body.sourceChannelId : null;

      // Le dashboard envoie une liste de cibles ; l'ancien couple
      // targetGuildId/targetChannelId reste accepté pour les appels existants.
      const rawTargets: any[] = Array.isArray(body?.targets)
        ? body.targets
        : (body?.targetGuildId && body?.targetChannelId
          ? [{ guildId: body.targetGuildId, channelId: body.targetChannelId, mode: body?.direction === 'UNIDIRECTIONAL' ? 'RECEIVE_ONLY' : 'BOTH' }]
          : []);

      if (!sourceChannelId || rawTargets.length === 0) {
        json(res, 400, { error: 'sourceChannelId et au moins une cible sont requis' });
        return true;
      }

      const targets = [];
      for (const raw of rawTargets) {
        const targetGuildId = typeof raw?.guildId === 'string' ? raw.guildId : null;
        const targetChannelId = typeof raw?.channelId === 'string' ? raw.channelId : null;
        if (!targetGuildId || !targetChannelId) {
          json(res, 400, { error: 'Chaque cible doit préciser guildId et channelId.' });
          return true;
        }
        if (!client.guilds.cache.get(targetGuildId)) {
          json(res, 400, { error: 'Le bot n\'est pas présent sur l\'un des serveurs cibles.' });
          return true;
        }
        if (!(await canManageGuild(client, targetGuildId, user.userId))) {
          json(res, 403, { error: 'Vous devez être admin de chacun des serveurs cibles.' });
          return true;
        }
        targets.push({ guildId: targetGuildId, channelId: targetChannelId, mode: readMode(raw?.mode) });
      }

      const result = await createDirectGroup({
        ownerGuildId: guildId,
        ownerChannelId: sourceChannelId,
        targets,
        createdByUserId: user.userId,
        name: typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : null,
        ownerMode: readMode(body?.ownerMode, body?.direction === 'UNIDIRECTIONAL' ? 'SEND_ONLY' : 'BOTH'),
        relayMode: readRelayMode(body?.relayMode),
        client,
      });

      if ('error' in result) {
        json(res, 400, { error: result.error });
        return true;
      }

      let serverInviteUrl: string | null = null;
      if (body?.createServerInvite) {
        try {
          const sourceGuild = client.guilds.cache.get(guildId);
          const sourceChannel = sourceGuild?.channels.cache.get(sourceChannelId);
          if (sourceChannel && 'createInvite' in sourceChannel && typeof sourceChannel.createInvite === 'function') {
            const discordInvite = await sourceChannel.createInvite({
              maxAge: 0,
              maxUses: 0,
              reason: 'Kotbo Link: Invitation pour la description des salons liés',
            });
            serverInviteUrl = discordInvite.url;
            await recordBotInvite(discordInvite, INVITE_SOURCE.channelLinkPairing());
          }
        } catch (err) {
          logger.warn('ChannelLinkAPI', 'Impossible de créer l\'invitation Discord', err);
        }
      }

      json(res, 201, { ...serializeGroup(result, guildId, client), serverInviteUrl });
    } catch (err) {
      logger.error('ChannelLinkAPI', 'Erreur POST direct link', err);
      json(res, 500, { error: 'Erreur serveur' });
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/channel-links/invites
  if (parts.length === 6 && parts[5] === 'invites' && method === 'GET') {
    try {
      const invites = await prisma.channelLinkInvite.findMany({
        where: { guildId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      json(res, 200, invites);
    } catch (err) {
      logger.error('ChannelLinkAPI', 'Erreur GET invites', err);
      json(res, 500, { error: 'Erreur serveur' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/channel-links/invites
  if (parts.length === 6 && parts[5] === 'invites' && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (!body?.channelId) {
        json(res, 400, { error: 'channelId requis' });
        return true;
      }

      // Un code peut viser un pont existant : chaque serveur qui l'utilise
      // rejoint alors le même pont, au lieu d'en ouvrir un nouveau à deux.
      const groupId = typeof body?.groupId === 'string' ? body.groupId : null;
      if (groupId) {
        const group = await getGroup(groupId);
        if (!group || !group.members.some((m) => m.guildId === guildId)) {
          json(res, 404, { error: 'Pont introuvable' });
          return true;
        }
      }

      const { randomBytes } = await import('node:crypto');
      const code = randomBytes(6).toString('hex').toUpperCase();
      const requestedMaxUses = typeof body?.maxUses === 'number' ? body.maxUses : Number.NaN;
      const maxUses = Number.isInteger(requestedMaxUses) && requestedMaxUses > 0
        ? Math.min(requestedMaxUses, 25)
        : 1;

      const invite = await prisma.channelLinkInvite.create({
        data: {
          code,
          guildId,
          channelId: String(body?.channelId ?? ''),
          groupId,
          memberMode: readMode(body?.memberMode),
          direction: body?.direction === 'UNIDIRECTIONAL' ? 'UNIDIRECTIONAL' : 'BIDIRECTIONAL',
          relayMode: readRelayMode(body?.relayMode),
          relayText: typeof body?.relayText === 'boolean' ? body.relayText : true,
          relayImages: typeof body?.relayImages === 'boolean' ? body.relayImages : true,
          relayEmbeds: typeof body?.relayEmbeds === 'boolean' ? body.relayEmbeds : false,
          relayReactions: typeof body?.relayReactions === 'boolean' ? body.relayReactions : false,
          relayEdits: typeof body?.relayEdits === 'boolean' ? body.relayEdits : true,
          relayDeletes: typeof body?.relayDeletes === 'boolean' ? body.relayDeletes : true,
          relayPins: typeof body?.relayPins === 'boolean' ? body.relayPins : true,
          maxUses,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
          createdByUserId: user.userId,
        },
      });

      let serverInviteUrl: string | null = null;
      if (body.createServerInvite) {
        try {
          const guild = client.guilds.cache.get(guildId);
          const channel = guild?.channels.cache.get(String(body?.channelId ?? ''));
          if (channel && 'createInvite' in channel && typeof channel.createInvite === 'function') {
            const discordInvite = await channel.createInvite({
              maxAge: 24 * 60 * 60,
              maxUses: 5,
              reason: 'Kotbo Link: Invitation pour lier le salon',
            });
            serverInviteUrl = discordInvite.url;
            // Le serveur distant n'est pas encore connu à ce stade de l'appairage.
            await recordBotInvite(discordInvite, INVITE_SOURCE.channelLinkPairing());
          }
        } catch (err) {
          logger.warn('ChannelLinkAPI', 'Impossible de créer l\'invitation Discord', err);
        }
      }

      json(res, 201, { ...invite, serverInviteUrl });
    } catch (err) {
      logger.error('ChannelLinkAPI', 'Erreur POST invite', err);
      json(res, 500, { error: 'Erreur serveur' });
    }
    return true;
  }

  const groupId = parts.length >= 6 && !RESERVED_SEGMENTS.has(parts[5]!) ? parts[5]! : null;
  if (!groupId) return false;

  const group = await getGroup(groupId);
  if (!group || !group.members.some((m) => m.guildId === guildId)) {
    if (parts.length >= 6 && (method === 'PATCH' || method === 'DELETE' || method === 'POST')) {
      json(res, 404, { error: 'Pont introuvable' });
      return true;
    }
    return false;
  }

  // PATCH /api/dashboard/guilds/:guildId/channel-links/:groupId
  if (parts.length === 6 && method === 'PATCH') {
    try {
      const body = await readJsonBody(req);

      const allowedFields = ['name', 'relayText', 'relayImages', 'relayEmbeds', 'relayReactions', 'relayEdits', 'relayDeletes', 'relayThreads', 'relayPolls', 'relayPins', 'enabled', 'updateTopic'];
      const updateData: Record<string, any> = {};
      for (const field of allowedFields) {
        if (body?.[field] !== undefined) updateData[field] = body[field];
      }

      // Passe par le service : lui seul sait invalider le cache des ponts,
      // rouvrir ou refermer la garde des serveurs en liaison seule et purger les
      // correspondances de messages devenues inutiles.
      const updated = await updateGroupConfig(groupId, updateData);
      if (!updated) {
        json(res, 404, { error: 'Pont introuvable' });
        return true;
      }

      json(res, 200, serializeGroup(updated, guildId, client));
    } catch (err) {
      logger.error('ChannelLinkAPI', 'Erreur PATCH channel-link', err);
      json(res, 500, { error: 'Erreur serveur' });
    }
    return true;
  }

  // DELETE /api/dashboard/guilds/:guildId/channel-links/:groupId
  if (parts.length === 6 && method === 'DELETE') {
    try {
      await removeGroup(groupId, client);
      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('ChannelLinkAPI', 'Erreur DELETE channel-link', err);
      json(res, 500, { error: 'Erreur serveur' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/channel-links/:groupId/members
  if (parts.length === 7 && parts[6] === 'members' && method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const memberGuildId = typeof body?.guildId === 'string' ? body.guildId : null;
      const memberChannelId = typeof body?.channelId === 'string' ? body.channelId : null;
      if (!memberGuildId || !memberChannelId) {
        json(res, 400, { error: 'guildId et channelId requis' });
        return true;
      }

      if (!client.guilds.cache.get(memberGuildId)) {
        json(res, 400, { error: 'Le bot n\'est pas présent sur ce serveur.' });
        return true;
      }
      if (!(await canManageGuild(client, memberGuildId, user.userId))) {
        json(res, 403, { error: 'Vous devez être admin du serveur ajouté.' });
        return true;
      }

      const result = await addGroupMember({
        groupId,
        guildId: memberGuildId,
        channelId: memberChannelId,
        addedByUserId: user.userId,
        mode: readMode(body?.mode),
        relayMode: readRelayMode(body?.relayMode),
        client,
      });

      if ('error' in result) {
        json(res, 400, { error: result.error });
        return true;
      }

      json(res, 201, serializeGroup(result, guildId, client));
    } catch (err) {
      logger.error('ChannelLinkAPI', 'Erreur POST membre de pont', err);
      json(res, 500, { error: 'Erreur serveur' });
    }
    return true;
  }

  // PATCH /api/dashboard/guilds/:guildId/channel-links/:groupId/members/:memberId
  if (parts.length === 8 && parts[6] === 'members' && method === 'PATCH') {
    try {
      const body = await readJsonBody(req);
      const data: Record<string, any> = {};
      if (body?.mode !== undefined) data.mode = readMode(body.mode);
      if (body?.relayMode !== undefined) data.relayMode = readRelayMode(body.relayMode);
      if (typeof body?.enabled === 'boolean') data.enabled = body.enabled;

      const updated = await updateGroupMemberConfig(groupId, parts[7]!, data);
      if (!updated) {
        json(res, 404, { error: 'Salon introuvable dans ce pont' });
        return true;
      }

      json(res, 200, serializeGroup(updated, guildId, client));
    } catch (err) {
      logger.error('ChannelLinkAPI', 'Erreur PATCH membre de pont', err);
      json(res, 500, { error: 'Erreur serveur' });
    }
    return true;
  }

  // DELETE /api/dashboard/guilds/:guildId/channel-links/:groupId/members/:memberId
  if (parts.length === 8 && parts[6] === 'members' && method === 'DELETE') {
    try {
      const memberId = parts[7]!;
      const member = group.members.find((m) => m.id === memberId);
      if (!member) {
        json(res, 404, { error: 'Salon introuvable dans ce pont' });
        return true;
      }
      // Retirer le salon d'un autre serveur suppose d'y être admin ; retirer le
      // sien est toujours permis, c'est la façon de quitter un pont.
      if (member.guildId !== guildId && !(await canManageGuild(client, member.guildId, user.userId))) {
        json(res, 403, { error: 'Vous devez être admin de ce serveur pour le retirer.' });
        return true;
      }

      const remaining = await removeGroupMember(groupId, memberId, client);
      json(res, 200, { ok: true, group: remaining ? serializeGroup(remaining, guildId, client) : null });
    } catch (err) {
      logger.error('ChannelLinkAPI', 'Erreur DELETE membre de pont', err);
      json(res, 500, { error: 'Erreur serveur' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/channel-links/:groupId/invite
  if (parts.length === 7 && parts[6] === 'invite' && method === 'POST') {
    try {
      const localMember = group.members.find((m) => m.guildId === guildId);
      const localChannel = localMember ? client.guilds.cache.get(guildId)?.channels.cache.get(localMember.channelId) : null;

      if (!localChannel || !('createInvite' in localChannel) || typeof localChannel.createInvite !== 'function') {
        json(res, 400, { error: 'Impossible de créer une invitation sur ce salon.' });
        return true;
      }

      const discordInvite = await localChannel.createInvite({
        maxAge: 0,
        maxUses: 0,
        reason: 'Kotbo Link: Invitation pour la description des salons liés',
      });

      const guild = client.guilds.cache.get(guildId);
      await recordBotInvite(discordInvite, INVITE_SOURCE.channelLink(guild?.name ?? guildId));

      // Les descriptions listent tous les participants : les réécrire propage
      // l'invitation partout, au lieu du seul salon d'en face.
      let topicUpdated = false;
      if (group.updateTopic) {
        await refreshGroupTopics(client, group, true);
        topicUpdated = true;
      }

      json(res, 201, { inviteUrl: discordInvite.url, topicUpdated });
    } catch (err) {
      logger.error('ChannelLinkAPI', 'Erreur POST invite pour pont', err);
      json(res, 500, { error: 'Erreur serveur' });
    }
    return true;
  }

  return false;
}
