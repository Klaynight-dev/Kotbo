/** Routes dashboard du module `social-follows`. */
import { getTwitchUserId, normalizeTwitchLogin } from '../../../../services/integrations/twitchService.js';
import { resolveYoutubeChannel } from '../../../../services/integrations/youtubeService.js';
import prisma from '../../../../utils/db.js';
import { errorMessage } from '../../../../utils/errors.js';
import { logger } from '../../../../utils/logger.js';
import { normalizeRoleMention } from '../../../../utils/mentions.js';
import { getGuildName, json, pushAudit, readJsonBody } from '../../../shared.js';
import { type ModuleRouteContext } from './_shared.js';

export async function handleSocialFollowsRoutes(ctx: ModuleRouteContext): Promise<boolean> {
  const { req, res, parts, client, guildId, method, auditUser, moduleKey } = ctx;

  // GET/POST/DELETE /api/dashboard/guilds/:guildId/social-follows
  if (moduleKey === 'social-follows') {
    if (parts.length === 5 && method === 'GET') {
      try {
        const youtube = await prisma.youtubeChannelFollow.findMany({ where: { guildId } });
        const twitch = await prisma.twitchChannelFollow.findMany({ where: { guildId } });
        json(res, 200, { youtube, twitch });
      } catch (err: unknown) {
        logger.error('SocialFollowsAPI', `Error fetching social follows: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la récupération des réseaux sociaux suivis' });
      }
      return true;
    }

    if (parts.length === 6 && parts[5] === 'youtube' && method === 'POST') {
      try {
        const body = await readJsonBody<{
          query: string;
          discordChannelId?: string | null;
          mention?: string | null;
          liveMessage?: string | null;
          videoMessage?: string | null;
          shortMessage?: string | null;
        }>(req);
        if (!body?.query) {
          json(res, 400, { error: 'Recherche ou URL YouTube requise' });
          return true;
        }

        const resolved = await resolveYoutubeChannel(body.query);
        if (!resolved) {
          json(res, 400, { error: 'Impossible de résoudre la chaîne YouTube' });
          return true;
        }

        const { channelId, channelName } = resolved;
        const follow = await prisma.youtubeChannelFollow.upsert({
          where: { guildId_channelId: { guildId, channelId } },
          create: {
            guildId,
            channelId,
            channelName,
            discordChannelId: body.discordChannelId || null,
            mention: normalizeRoleMention(body.mention),
            liveMessage: body.liveMessage || null,
            videoMessage: body.videoMessage || null,
            shortMessage: body.shortMessage || null,
          },
          update: {
            channelName,
            discordChannelId: body.discordChannelId || null,
            mention: normalizeRoleMention(body.mention),
            liveMessage: body.liveMessage || null,
            videoMessage: body.videoMessage || null,
            shortMessage: body.shortMessage || null,
          }
        });

        await pushAudit(guildId, {
          user: auditUser,
          action: 'YouTube Follow',
          context: getGuildName(client, guildId),
          module: 'YouTube',
          eventType: 'Manuel',
          details: `Chaîne YouTube "${channelName}" (${channelId}) suivie/mise à jour.`,
          channelId: null
        });

        json(res, 200, follow);
      } catch (err: unknown) {
        logger.error('SocialFollowsAPI', `Error adding youtube follow: ${errorMessage(err)}`);
        json(res, 500, { error: "Erreur lors de l'ajout du suivi YouTube" });
      }
      return true;
    }

    if (parts.length === 7 && parts[5] === 'youtube' && method === 'DELETE') {
      try {
        const followId = parts[6];
        // Le filtre sur guildId empêche la suppression d'un suivi d'une autre guilde.
        const follow = await prisma.youtubeChannelFollow.findFirst({ where: { id: followId, guildId } });
        if (follow) {
          await prisma.youtubeChannelFollow.delete({ where: { id: followId } });
          await pushAudit(guildId, {
            user: auditUser,
            action: 'YouTube Unfollow',
            context: getGuildName(client, guildId),
            module: 'YouTube',
            eventType: 'Manuel',
            details: `Chaîne YouTube "${follow.channelName}" unfollow.`,
            channelId: null
          });
        }
        json(res, 200, { success: true });
      } catch (err: unknown) {
        logger.error('SocialFollowsAPI', `Error deleting youtube follow: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la suppression du suivi YouTube' });
      }
      return true;
    }

    if (parts.length === 6 && parts[5] === 'twitch' && method === 'POST') {
      try {
        const body = await readJsonBody<{
          streamerName: string;
          discordChannelId?: string | null;
          mention?: string | null;
          liveMessage?: string | null;
        }>(req);
        if (!body?.streamerName) {
          json(res, 400, { error: 'streamerName requis' });
          return true;
        }
        // Une URL ou un @pseudo doit être ramené au login seul : c'est cette
        // valeur que le polling compare aux logins renvoyés par Helix.
        const streamerName = normalizeTwitchLogin(body.streamerName);
        if (!streamerName) {
          json(res, 400, { error: 'Nom de chaîne Twitch invalide' });
          return true;
        }
        const streamerId = await getTwitchUserId(streamerName);

        const follow = await prisma.twitchChannelFollow.upsert({
          where: { guildId_streamerName: { guildId, streamerName } },
          create: {
            guildId,
            streamerName,
            streamerId,
            discordChannelId: body.discordChannelId || null,
            mention: normalizeRoleMention(body.mention),
            liveMessage: body.liveMessage || null,
          },
          update: {
            streamerId,
            discordChannelId: body.discordChannelId || null,
            mention: normalizeRoleMention(body.mention),
            liveMessage: body.liveMessage || null,
          }
        });

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Twitch Follow',
          context: getGuildName(client, guildId),
          module: 'Twitch',
          eventType: 'Manuel',
          details: `Streamer Twitch "${streamerName}" suivi/mis à jour.`,
          channelId: null
        });

        json(res, 200, follow);
      } catch (err: unknown) {
        logger.error('SocialFollowsAPI', `Error adding twitch follow: ${errorMessage(err)}`);
        json(res, 500, { error: "Erreur lors de l'ajout du suivi Twitch" });
      }
      return true;
    }

    if (parts.length === 7 && parts[5] === 'twitch' && method === 'DELETE') {
      try {
        const followId = parts[6];
        // Le filtre sur guildId empêche la suppression d'un suivi d'une autre guilde.
        const follow = await prisma.twitchChannelFollow.findFirst({ where: { id: followId, guildId } });
        if (follow) {
          await prisma.twitchChannelFollow.delete({ where: { id: followId } });
          await pushAudit(guildId, {
            user: auditUser,
            action: 'Twitch Unfollow',
            context: getGuildName(client, guildId),
            module: 'Twitch',
            eventType: 'Manuel',
            details: `Streamer Twitch "${follow.streamerName}" unfollow.`,
            channelId: null
          });
        }
        json(res, 200, { success: true });
      } catch (err: unknown) {
        logger.error('SocialFollowsAPI', `Error deleting twitch follow: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la suppression du suivi Twitch' });
      }
      return true;
    }
  }

  return false;
}
