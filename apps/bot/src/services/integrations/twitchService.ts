import { type Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { buildTwitchEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { allowedMentionsFor } from '../../utils/mentions.js';
import { resolveFollowMessage, templateHasVariable } from './socialTemplates.js';
import type { DashboardFeatureConfig, Guild, TwitchChannelFollow } from '@prisma/client';

/** Abonnement Twitch charge par le polling, guilde et config de module incluses. */
type TwitchFollowWithGuild = TwitchChannelFollow & {
  guild: Guild & { dashboardFeatureConfigs: DashboardFeatureConfig[] };
};

/** Signature de `fetch`, injectable dans les tests. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Reponse de l'API Twitch : seuls les champs consommes ici sont decrits. */
type TwitchUser = { id: string; login: string; display_name?: string };

export type TwitchStream = {
  id: string;
  user_id?: string;
  user_login: string;
  user_name: string;
  title: string;
  game_name?: string;
  viewer_count?: number;
  thumbnail_url?: string;
  started_at?: string;
};

const TWITCH_REQUEST_TIMEOUT_MS = 10_000;
/** Maximum de `user_login` accepte par requete sur l'endpoint Helix `streams`. */
const TWITCH_BATCH_SIZE = 100;

let twitchAccessToken: string | null = null;
let twitchTokenExpiresAt = 0;

/** Remet l'etat d'authentification a zero entre deux tests. */
export function resetTwitchAuthForTests(): void {
  twitchAccessToken = null;
  twitchTokenExpiresAt = 0;
}

// ==================== HELPERS PURS ====================

/**
 * Normalise une saisie utilisateur en login Twitch.
 * Accepte un pseudo brut, une URL `twitch.tv/...` ou un `@pseudo`.
 * Retourne `null` si rien d'exploitable n'en ressort.
 */
export function normalizeTwitchLogin(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (!value) return null;

  const urlMatch = value.match(/twitch\.tv\/([a-z0-9_]+)/);
  if (urlMatch) {
    value = urlMatch[1];
  } else if (value.startsWith('@')) {
    value = value.slice(1);
  }

  // Un login Twitch fait 4 a 25 caracteres alphanumeriques ou underscore.
  return /^[a-z0-9_]{4,25}$/.test(value) ? value : null;
}

/** URL Helix interrogeant le statut d'un lot de chaines. */
export function buildStreamsUrl(logins: readonly string[]): string {
  const query = logins.map((login) => `user_login=${encodeURIComponent(login)}`).join('&');
  return `https://api.twitch.tv/helix/streams?${query}`;
}

/** Decoupe une liste de logins en lots acceptes par Helix. */
export function chunkLogins(logins: readonly string[], size = TWITCH_BATCH_SIZE): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < logins.length; i += size) {
    chunks.push(logins.slice(i, i + size));
  }
  return chunks;
}

/**
 * Un live est annonce lorsqu'il devient visible ou que son identifiant change
 * (nouveau stream apres une coupure), jamais deux fois pour le meme stream.
 */
export function shouldAnnounceStream(
  state: Pick<TwitchChannelFollow, 'isLive' | 'lastStreamId'>,
  streamId: string,
): boolean {
  return !state.isLive || state.lastStreamId !== streamId;
}

/** Contenu du message et titre de l'embed d'une alerte live. */
export function buildTwitchNotification(
  follow: Pick<TwitchChannelFollow, 'liveMessage'>,
  stream: TwitchStream,
): { content: string; embedTitle: string } {
  const vars = {
    title: stream.title,
    channel: stream.user_name,
    game: stream.game_name,
    viewers: stream.viewer_count,
    url: `https://twitch.tv/${stream.user_login}`,
  };

  return {
    content: resolveFollowMessage(
      follow.liveMessage,
      `🎥 **${stream.user_name}** est en live sur Twitch !`,
      vars,
    ),
    // Le titre du stream reste celui de l'embed sauf si le modele le reformule.
    embedTitle: templateHasVariable(follow.liveMessage, 'title')
      ? resolveFollowMessage(follow.liveMessage, stream.title, vars)
      : stream.title,
  };
}

// ==================== HTTP ====================

async function fetchWithTimeout(url: string, init: RequestInit, fetchImpl: FetchLike): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TWITCH_REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Jeton applicatif (Client Credentials Flow), mis en cache en memoire.
 * `forceRefresh` sert a repartir d'un jeton neuf apres un 401.
 */
async function getTwitchToken(fetchImpl: FetchLike = fetch, forceRefresh = false): Promise<string | null> {
  const clientId = process.env.TWITCH_CLIENT_ID;
  const clientSecret = process.env.TWITCH_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    logger.warn('TwitchService', 'TWITCH_CLIENT_ID ou TWITCH_CLIENT_SECRET manquant dans .env.');
    return null;
  }

  const now = Date.now();
  if (!forceRefresh && twitchAccessToken && now < twitchTokenExpiresAt) {
    return twitchAccessToken;
  }

  try {
    const res = await fetchWithTimeout('https://id.twitch.tv/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
      }),
    }, fetchImpl);

    if (!res.ok) {
      throw new Error(`Reponse ${res.status} ${res.statusText}`);
    }

    const data = await res.json() as { access_token: string; expires_in: number };
    twitchAccessToken = data.access_token;
    // Marge de 60 secondes pour ne pas utiliser un jeton expirant en vol.
    twitchTokenExpiresAt = now + (data.expires_in - 60) * 1000;
    return twitchAccessToken;
  } catch (error) {
    twitchAccessToken = null;
    twitchTokenExpiresAt = 0;
    logger.error('TwitchService', 'Obtention du jeton OAuth Twitch impossible:', error);
    return null;
  }
}

/**
 * Appel Helix authentifie. Un 401 declenche un unique renouvellement de jeton
 * puis un second essai : Twitch peut revoquer un jeton avant son expiration.
 */
async function helixFetch(url: string, fetchImpl: FetchLike): Promise<Response | null> {
  const clientId = process.env.TWITCH_CLIENT_ID;
  if (!clientId) return null;

  for (const forceRefresh of [false, true]) {
    const token = await getTwitchToken(fetchImpl, forceRefresh);
    if (!token) return null;

    const res = await fetchWithTimeout(url, {
      headers: { 'Client-ID': clientId, 'Authorization': `Bearer ${token}` },
    }, fetchImpl).catch((error: unknown) => {
      logger.error('TwitchService', `Appel Helix en echec (${url}):`, error);
      return null;
    });

    if (!res) return null;
    if (res.status !== 401) return res;

    twitchAccessToken = null;
    twitchTokenExpiresAt = 0;
  }

  logger.warn('TwitchService', 'Helix renvoie 401 malgre un jeton renouvele.');
  return null;
}

/** Identifiant Twitch d'une chaine, ou `null` si elle n'existe pas. */
export async function getTwitchUserId(username: string, fetchImpl: FetchLike = fetch): Promise<string | null> {
  const login = normalizeTwitchLogin(username);
  if (!login) return null;

  const res = await helixFetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, fetchImpl);
  if (!res?.ok) return null;

  try {
    const data = await res.json() as { data?: TwitchUser[] };
    return data.data?.[0]?.id ?? null;
  } catch (error) {
    logger.error('TwitchService', `Lecture de la reponse users echouee pour ${login}:`, error);
    return null;
  }
}

/** Statut live d'un ensemble de chaines, indexe par login en minuscules. */
export async function fetchLiveStreams(
  logins: readonly string[],
  fetchImpl: FetchLike = fetch,
): Promise<Map<string, TwitchStream>> {
  const liveMap = new Map<string, TwitchStream>();

  for (const batch of chunkLogins(logins)) {
    const res = await helixFetch(buildStreamsUrl(batch), fetchImpl);
    if (!res?.ok) {
      logger.warn('TwitchService', `Recuperation des statuts Twitch impossible (${res?.status ?? 'reseau'}).`);
      continue;
    }

    const data = await res.json().catch(() => null) as { data?: TwitchStream[] } | null;
    for (const stream of data?.data ?? []) {
      liveMap.set(stream.user_login.toLowerCase(), stream);
    }
  }

  return liveMap;
}

// ==================== BOUCLE PRINCIPALE ====================

export async function checkTwitchFollows(client: Client, fetchImpl: FetchLike = fetch): Promise<void> {
  logger.debug('TwitchService', 'Verification des chaines Twitch suivies...');

  if (!process.env.TWITCH_CLIENT_ID || !process.env.TWITCH_CLIENT_SECRET) return;

  try {
    const follows = await prisma.twitchChannelFollow.findMany({
      include: {
        guild: {
          include: {
            dashboardFeatureConfigs: { where: { featureKey: 'twitch' } },
          },
        },
      },
    }) as TwitchFollowWithGuild[];

    // Un module explicitement desactive coupe les alertes de sa guilde.
    const activeFollows = follows.filter((follow) => {
      const config = follow.guild.dashboardFeatureConfigs.find((c) => c.featureKey === 'twitch');
      return !config || config.enabled;
    });

    if (activeFollows.length === 0) return;

    const logins = Array.from(new Set(activeFollows.map((f) => f.streamerName.toLowerCase())));
    const liveMap = await fetchLiveStreams(logins, fetchImpl);

    for (const follow of activeFollows) {
      await processFollow(client, follow, liveMap.get(follow.streamerName.toLowerCase()));
    }
  } catch (error) {
    logger.error('TwitchService', 'Erreur pendant la verification des abonnements Twitch:', error);
  }
}

async function processFollow(
  client: Client,
  follow: TwitchFollowWithGuild,
  stream: TwitchStream | undefined,
): Promise<void> {
  if (!stream) {
    // Fin de live : on remet l'etat a plat, sans notification (suivi simplifie).
    if (follow.isLive) {
      await prisma.twitchChannelFollow.update({
        where: { id: follow.id },
        data: { isLive: false },
      }).catch((e: Error) => logger.error('TwitchService', "Mise a jour de l'abonnement impossible:", e));
    }
    return;
  }

  if (!shouldAnnounceStream(follow, stream.id)) return;

  const targetChannelId = follow.discordChannelId || follow.guild.publicChannelId;
  if (targetChannelId) {
    const discordGuild = client.guilds.cache.get(follow.guildId)
      ?? await client.guilds.fetch(follow.guildId).catch(() => null);

    const channel = discordGuild
      ? discordGuild.channels.cache.get(targetChannelId)
        ?? await discordGuild.channels.fetch(targetChannelId).catch(() => null)
      : null;

    if (channel?.isTextBased()) {
      const { content, embedTitle } = buildTwitchNotification(follow, stream);
      const embed = buildTwitchEmbed({
        title: embedTitle,
        streamerName: stream.user_name,
        gameName: stream.game_name,
        viewerCount: stream.viewer_count,
        thumbnailUrl: stream.thumbnail_url,
      });

      await channel.send({
        content: follow.mention ? `${follow.mention} ${content}` : content,
        embeds: [embed],
        // Sans consigne explicite, la conversion V2 des embeds neutralise tous
        // les pings : la mention configuree doit etre autorisee nommement.
        allowedMentions: allowedMentionsFor(follow.mention),
      }).catch((e: Error) => logger.error('TwitchService', "Envoi de l'alerte live impossible:", e));
    } else {
      logger.warn('TwitchService', `Salon ${targetChannelId} introuvable ou non textuel (guilde ${follow.guildId}).`);
    }
  }

  await prisma.twitchChannelFollow.update({
    where: { id: follow.id },
    data: {
      isLive: true,
      lastStreamId: stream.id,
      // L'identifiant numerique n'est connu qu'a partir d'un stream observe.
      ...(stream.user_id ? { streamerId: stream.user_id } : {}),
    },
  }).catch((e: Error) => logger.error('TwitchService', "Mise a jour de l'abonnement impossible:", e));
}
