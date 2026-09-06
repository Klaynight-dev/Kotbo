import { type Client, type EmbedBuilder } from 'discord.js';
import pLimit from 'p-limit';
import prisma from '../../utils/db.js';
import { buildYouTubeComponents, buildYouTubeEmbed, youtubeVideoUrl } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { allowedMentionsFor } from '../../utils/mentions.js';
import { resolveFollowMessage, templateHasVariable } from './socialTemplates.js';
import type { DashboardFeatureConfig, Guild, YoutubeChannelFollow } from '@prisma/client';

/**
 * Abonnement YouTube tel que charge par le polling : la guilde et sa config de
 * module sont incluses par la requete, ce que le modele seul ne dit pas.
 */
type YoutubeFollowWithGuild = YoutubeChannelFollow & {
  guild: Guild & { dashboardFeatureConfigs: DashboardFeatureConfig[] };
};

// ==================== TYPES ====================

/** Signature de `fetch`, injectable dans les tests. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface YoutubeChannelRef {
  channelId: string;
  channelName: string;
}

export interface YoutubeLiveStatus {
  isLive: boolean;
  videoId?: string;
  title?: string;
  description?: string | null;
}

export interface YoutubeFeedVideo {
  videoId: string;
  title: string;
  publishedAt: Date;
  /** Description publiee sur YouTube, reprise telle quelle dans l'embed. */
  description: string | null;
  /** Miniature annoncee par le flux (hqdefault) ; sert de repli. */
  thumbnailUrl: string | null;
}

export type YoutubeVideo = YoutubeFeedVideo & { isShort: boolean };

export interface YoutubeFollowState {
  lastLiveId: string | null;
  lastVideoId: string | null;
  lastShortId: string | null;
}

/**
 * Action decidee pour un abonnement. `notify: false` signifie « memoriser sans
 * annoncer » : c'est le cas du premier passage sur une chaine, qui ne doit pas
 * republier son back-catalogue.
 */
export interface YoutubeAction {
  kind: 'live' | 'video' | 'short';
  videoId: string;
  title: string;
  publishedAt: Date;
  notify: boolean;
  description?: string | null;
  thumbnailUrl?: string | null;
}

interface YouTubeApiChannelResponse {
  items?: Array<{
    id: string;
    snippet: {
      title: string;
      thumbnails?: Record<string, { url?: string } | undefined>;
    };
  }>;
  error?: { code?: number; message?: string };
}

interface YouTubeApiSearchResponse {
  items?: Array<{ id?: { channelId?: string }; snippet?: { title?: string; channelTitle?: string } }>;
  error?: { code?: number; message?: string };
}

// ==================== CONFIGURATION ====================

const YOUTUBE_CONFIG = {
  API_BASE: 'https://www.googleapis.com/youtube/v3',
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 1000,
  CACHE_TTL_MS: 5 * 60 * 1000,
  LIVE_CACHE_TTL_MS: 60 * 1000,
  /** Un avatar de chaine ne bouge quasiment jamais. */
  AVATAR_CACHE_TTL_MS: 6 * 60 * 60 * 1000,
  /** Requetes HTTP simultanees, tous abonnements confondus. */
  MAX_CONCURRENT_REQUESTS: 5,
  /** Abonnements traites en parallele. */
  MAX_CONCURRENT_FOLLOWS: 4,
  REQUEST_TIMEOUT_MS: 10_000,
  /** Au-dela, une video est consideree comme du back-catalogue : pas d'annonce. */
  VIDEO_MAX_AGE_MS: 24 * 60 * 60 * 1000,
  USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
} as const;

// ==================== CACHE ====================

class YouTubeCache {
  private cache = new Map<string, { data: unknown; expiresAt: number }>();

  set(key: string, data: unknown, ttlMs = YOUTUBE_CONFIG.CACHE_TTL_MS): void {
    this.cache.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  /** Le type stocke est connu du seul appelant : il le declare a la lecture. */
  get<T = unknown>(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    return entry.data as T;
  }

  clear(): void {
    this.cache.clear();
  }

  evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) this.cache.delete(key);
    }
  }
}

const cache = new YouTubeCache();

const evictionTimer = setInterval(() => {
  cache.evictExpired();
}, 10 * 60 * 1000);
// Ne pas maintenir le process en vie uniquement pour purger un cache memoire.
evictionTimer.unref?.();

/** Remet le service a zero entre deux tests. */
export function resetYoutubeCacheForTests(): void {
  cache.clear();
}

// ==================== HTTP ====================

/**
 * Limite les requetes HTTP sortantes. Ce limiteur ne doit **jamais** encadrer
 * le traitement complet d'un abonnement : un appel imbrique attendrait un
 * creneau detenu par son propre parent (interblocage).
 */
const httpLimit = pLimit(YOUTUBE_CONFIG.MAX_CONCURRENT_REQUESTS);

async function timedFetch(url: string, init: RequestInit, fetchImpl: FetchLike): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), YOUTUBE_CONFIG.REQUEST_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchText(url: string, fetchImpl: FetchLike): Promise<string | null> {
  try {
    const response = await httpLimit(() =>
      timedFetch(url, { headers: { 'User-Agent': YOUTUBE_CONFIG.USER_AGENT } }, fetchImpl),
    );
    if (!response.ok) return null;
    return await response.text();
  } catch (error) {
    logger.debug('YouTubeService', `GET ${url} a echoue: ${String(error)}`);
    return null;
  }
}

async function fetchJsonWithRetry<T>(url: string, fetchImpl: FetchLike): Promise<T | null> {
  for (let attempt = 0; attempt < YOUTUBE_CONFIG.MAX_RETRIES; attempt++) {
    const isLastAttempt = attempt === YOUTUBE_CONFIG.MAX_RETRIES - 1;
    try {
      const response = await httpLimit(() => timedFetch(url, {}, fetchImpl));

      if (response.ok) {
        return await response.json() as T;
      }

      // 4xx hors quota : reessayer ne changera rien.
      if (response.status < 500 && response.status !== 429) {
        const text = await response.text().catch(() => '');
        logger.error('YouTubeService', `Requete refusee (${response.status}): ${text.slice(0, 300)}`);
        return null;
      }

      if (isLastAttempt) {
        logger.error('YouTubeService', `Requete en echec apres ${YOUTUBE_CONFIG.MAX_RETRIES} tentatives (${response.status}).`);
        return null;
      }
    } catch (error) {
      if (isLastAttempt) {
        logger.error('YouTubeService', `Requete en echec apres ${YOUTUBE_CONFIG.MAX_RETRIES} tentatives:`, error);
        return null;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, YOUTUBE_CONFIG.RETRY_DELAY_MS * 2 ** attempt));
  }

  return null;
}

// ==================== PARSING (pur) ====================

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
};

/** Decode les entites XML/HTML rencontrees dans les flux YouTube. */
export function decodeXmlEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&(?:amp|lt|gt|quot|apos|#39);/g, (match) => XML_ENTITIES[match] ?? match);
}

/**
 * Nettoie un texte issu de YouTube avant affichage : les caracteres de controle
 * et invisibles n'ont rien a faire dans un embed, et servent a masquer du
 * contenu injecte dans une description tierce.
 */
export function sanitizeFeedText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060\uFEFF]/g, '')
    // Plus de deux sauts de ligne consecutifs : inutile dans un embed.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extrait les videos du flux Atom d'une chaine (`/feeds/videos.xml`).
 * Ce flux ne consomme aucun quota API et est trie du plus recent au plus ancien.
 */
export function parseYoutubeFeed(xml: string): YoutubeFeedVideo[] {
  const videos: YoutubeFeedVideo[] = [];
  const entryPattern = /<entry>([\s\S]*?)<\/entry>/g;

  for (const entryMatch of xml.matchAll(entryPattern)) {
    const entry = entryMatch[1];
    const videoId = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    const published = entry.match(/<published>([^<]+)<\/published>/)?.[1];
    if (!videoId || !title || !published) continue;

    const publishedAt = new Date(published);
    if (Number.isNaN(publishedAt.getTime())) continue;

    const description = entry.match(/<media:description[^>]*>([\s\S]*?)<\/media:description>/)?.[1];
    const thumbnailUrl = entry.match(/<media:thumbnail[^>]*\surl="([^"]+)"/)?.[1];

    videos.push({
      videoId: videoId.trim(),
      title: decodeXmlEntities(title).trim(),
      publishedAt,
      description: description ? sanitizeFeedText(decodeXmlEntities(description)) || null : null,
      thumbnailUrl: thumbnailUrl ? decodeXmlEntities(thumbnailUrl) : null,
    });
  }

  return videos.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
}

/**
 * Determine si la page `/live` d'une chaine diffuse en direct.
 * YouTube expose `"isLiveNow":true` dans le player payload uniquement pendant
 * un direct ; hors direct la page retombe sur la derniere rediffusion.
 */
export function detectLiveFromHtml(html: string): YoutubeLiveStatus {
  if (!html.includes('"isLiveNow":true')) {
    return { isLive: false };
  }

  const videoId =
    html.match(/<link\s+rel="canonical"\s+href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/)?.[1] ??
    html.match(/"videoId":"([\w-]{11})"/)?.[1];

  if (!videoId) return { isLive: false };

  const rawTitle =
    html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/)?.[1] ??
    html.match(/"title":"([^"]*)"/)?.[1] ??
    html.match(/<title>([^<]*)<\/title>/)?.[1];

  const title = rawTitle ? decodeXmlEntities(rawTitle).replace(/\s*-\s*YouTube$/, '').trim() : '';

  const rawDescription = html.match(/<meta\s+property="og:description"\s+content="([^"]*)"/)?.[1];
  const description = rawDescription ? sanitizeFeedText(decodeXmlEntities(rawDescription)) || null : null;

  return { isLive: true, videoId, title: title || 'En direct sur YouTube', description };
}

/**
 * Avatar de la chaine, tel qu'expose par `og:image` sur sa page publique ou par
 * le player payload. Les deux formes renvoient une URL `yt3.googleusercontent`.
 */
export function extractChannelAvatarFromHtml(html: string): string | null {
  const raw =
    html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/)?.[1] ??
    html.match(/"avatar":\{"thumbnails":\[\{"url":"([^"]+)"/)?.[1];
  if (!raw) return null;

  const url = decodeXmlEntities(raw).replace(/\\\//g, '/');
  return url.startsWith('https://') ? url : null;
}

/** Recupere l'identifiant de chaine (`UC…`) depuis le HTML d'une page YouTube. */
export function extractChannelIdFromHtml(html: string): string | null {
  return (
    html.match(/<meta\s+itemprop="(?:identifier|channelId)"\s+content="(UC[\w-]{22})"/)?.[1] ??
    html.match(/"(?:channelId|externalId)":"(UC[\w-]{22})"/)?.[1] ??
    html.match(/\/channel\/(UC[\w-]{22})/)?.[1] ??
    null
  );
}

/** Recupere le nom lisible d'une chaine depuis le HTML de sa page. */
export function extractChannelNameFromHtml(html: string): string | null {
  const raw =
    html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/)?.[1] ??
    html.match(/<title>([^<]*)<\/title>/)?.[1];
  if (!raw) return null;
  const name = decodeXmlEntities(raw).replace(/\s*-\s*YouTube$/, '').trim();
  return name || null;
}

/** Separe une saisie utilisateur en identifiant de chaine et/ou handle `@nom`. */
export function extractFromQuery(query: string): { handle: string | null; channelId: string | null } {
  const cleaned = query.trim();

  if (/^UC[\w-]{22}$/.test(cleaned)) {
    return { handle: null, channelId: cleaned };
  }

  if (cleaned.includes('youtube.com/') || cleaned.includes('youtu.be/')) {
    const channelId = cleaned.match(/\/channel\/(UC[\w-]{22})/)?.[1] ?? null;
    if (channelId) return { handle: null, channelId };

    const handle = cleaned.match(/\/@([^/?\s#]+)/)?.[1] ?? null;
    // Anciennes URLs /c/nom et /user/nom : traitees comme un handle a resoudre.
    const legacy = cleaned.match(/\/(?:c|user)\/([^/?\s#]+)/)?.[1] ?? null;
    return { handle: handle ?? legacy, channelId: null };
  }

  if (cleaned.startsWith('@')) {
    return { handle: cleaned.slice(1), channelId: null };
  }

  return { handle: null, channelId: null };
}

/**
 * Decide quoi annoncer pour un abonnement, a partir de son etat persiste.
 *
 * Regles :
 * - un direct est annonce des qu'il change d'identifiant ;
 * - la video du direct, qui apparait aussi dans le flux RSS, n'est jamais
 *   annoncee une deuxieme fois comme upload ;
 * - au premier passage (aucun identifiant memorise) ou pour une video trop
 *   ancienne, on memorise sans annoncer.
 */
export function planYoutubeActions(
  state: YoutubeFollowState,
  input: { live?: YoutubeLiveStatus | null; latestVideo?: YoutubeVideo | null },
  now: Date = new Date(),
): YoutubeAction[] {
  const actions: YoutubeAction[] = [];
  const live = input.live;

  if (live?.isLive && live.videoId && live.videoId !== state.lastLiveId) {
    actions.push({
      kind: 'live',
      videoId: live.videoId,
      title: live.title || 'En direct sur YouTube',
      publishedAt: now,
      notify: true,
      description: live.description ?? null,
      thumbnailUrl: null,
    });
  }

  const video = input.latestVideo;
  if (video) {
    const kind = video.isShort ? 'short' : 'video';
    const alreadySeen = video.isShort
      ? state.lastShortId === video.videoId
      : state.lastVideoId === video.videoId;
    const isLiveBroadcast = video.videoId === live?.videoId || video.videoId === state.lastLiveId;
    const isFirstRun = video.isShort ? state.lastShortId === null : state.lastVideoId === null;
    const isStale = now.getTime() - video.publishedAt.getTime() > YOUTUBE_CONFIG.VIDEO_MAX_AGE_MS;

    if (!alreadySeen && !isLiveBroadcast) {
      actions.push({
        kind,
        videoId: video.videoId,
        title: video.title,
        publishedAt: video.publishedAt,
        notify: !isFirstRun && !isStale,
        description: video.description,
        thumbnailUrl: video.thumbnailUrl,
      });
    }
  }

  return actions;
}

// ==================== RESOLUTION DE CHAINE ====================

async function resolveViaHtml(url: string, fetchImpl: FetchLike): Promise<YoutubeChannelRef | null> {
  const html = await fetchText(url, fetchImpl);
  if (!html) return null;

  const channelId = extractChannelIdFromHtml(html);
  if (!channelId) return null;

  return { channelId, channelName: extractChannelNameFromHtml(html) ?? channelId };
}

async function resolveViaApi(path: string, key: string, fetchImpl: FetchLike): Promise<YoutubeChannelRef | null> {
  const data = await fetchJsonWithRetry<YouTubeApiChannelResponse>(
    `${YOUTUBE_CONFIG.API_BASE}/channels?part=snippet&${path}&key=${key}`,
    fetchImpl,
  );
  const item = data?.items?.[0];
  if (!item) {
    if (data?.error?.message) logger.warn('YouTubeService', `API channels: ${data.error.message}`);
    return null;
  }
  return { channelId: item.id, channelName: item.snippet.title };
}

async function searchViaApi(query: string, key: string, fetchImpl: FetchLike): Promise<YoutubeChannelRef | null> {
  const data = await fetchJsonWithRetry<YouTubeApiSearchResponse>(
    `${YOUTUBE_CONFIG.API_BASE}/search?part=snippet&q=${encodeURIComponent(query)}&type=channel&maxResults=1&key=${key}`,
    fetchImpl,
  );
  const item = data?.items?.[0];
  const channelId = item?.id?.channelId;
  if (!channelId) {
    if (data?.error?.message) logger.warn('YouTubeService', `API search: ${data.error.message}`);
    return null;
  }
  return { channelId, channelName: item?.snippet?.channelTitle ?? item?.snippet?.title ?? channelId };
}

/**
 * Resout une chaine depuis un identifiant, un handle, une URL ou un nom.
 * Fonctionne sans `YOUTUBE_API_KEY` : on retombe alors sur les pages publiques.
 */
export async function resolveYoutubeChannel(query: string, fetchImpl: FetchLike = fetch): Promise<YoutubeChannelRef | null> {
  const cleaned = query.trim();
  if (!cleaned) return null;

  const cacheKey = `channel:${cleaned.toLowerCase()}`;
  const cached = cache.get<YoutubeChannelRef>(cacheKey);
  if (cached) return cached;

  const key = process.env.YOUTUBE_API_KEY;
  const { handle, channelId } = extractFromQuery(cleaned);
  let result: YoutubeChannelRef | null = null;

  if (channelId) {
    result = key ? await resolveViaApi(`id=${channelId}`, key, fetchImpl) : null;
    result ??= await resolveViaHtml(`https://www.youtube.com/channel/${channelId}`, fetchImpl);
  }

  if (!result && handle) {
    result = key ? await resolveViaApi(`forHandle=${encodeURIComponent('@' + handle)}`, key, fetchImpl) : null;
    result ??= await resolveViaHtml(`https://www.youtube.com/@${encodeURIComponent(handle)}`, fetchImpl);
  }

  if (!result && !channelId && !handle) {
    result = key ? await searchViaApi(cleaned, key, fetchImpl) : null;
    // Sans cle API, une saisie libre est tentee comme handle.
    result ??= await resolveViaHtml(`https://www.youtube.com/@${encodeURIComponent(cleaned)}`, fetchImpl);
  }

  if (result) cache.set(cacheKey, result);
  return result;
}

// ==================== ETAT D'UNE CHAINE ====================

/** Videos recentes d'une chaine via son flux Atom (aucun quota consomme). */
export async function fetchRecentVideos(channelId: string, fetchImpl: FetchLike = fetch): Promise<YoutubeFeedVideo[]> {
  const xml = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, fetchImpl);
  if (!xml) return [];
  return parseYoutubeFeed(xml);
}

/**
 * Un Short redirige vers `/watch` lorsque la video n'en est pas un : un HEAD
 * sans suivi de redirection suffit a trancher.
 */
export async function isYoutubeShort(videoId: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
  const cacheKey = `short:${videoId}`;
  const cached = cache.get<boolean>(cacheKey);
  if (cached !== null) return cached;

  try {
    const response = await httpLimit(() =>
      timedFetch(
        `https://www.youtube.com/shorts/${videoId}`,
        { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': YOUTUBE_CONFIG.USER_AGENT } },
        fetchImpl,
      ),
    );
    const isShort = response.status === 200;
    cache.set(cacheKey, isShort);
    return isShort;
  } catch (error) {
    logger.debug('YouTubeService', `Detection Short impossible pour ${videoId}: ${String(error)}`);
    return false;
  }
}

/** Statut de direct d'une chaine, mis en cache une minute. */
export async function checkYoutubeLiveStatus(channelId: string, fetchImpl: FetchLike = fetch): Promise<YoutubeLiveStatus> {
  const cacheKey = `live:${channelId}`;
  const cached = cache.get<YoutubeLiveStatus>(cacheKey);
  if (cached) return cached;

  const html = await fetchText(`https://www.youtube.com/channel/${channelId}/live`, fetchImpl);
  const status = html ? detectLiveFromHtml(html) : { isLive: false };

  cache.set(cacheKey, status, YOUTUBE_CONFIG.LIVE_CACHE_TTL_MS);
  return status;
}

/**
 * Avatar de la chaine pour l'entete de la notification. Resolu via l'API si une
 * cle est configuree, sinon depuis la page publique. `null` n'est pas bloquant :
 * l'embed se contente alors de ne pas afficher d'icone.
 */
export async function fetchChannelAvatar(channelId: string, fetchImpl: FetchLike = fetch): Promise<string | null> {
  const cacheKey = `avatar:${channelId}`;
  const cached = cache.get<string | null>(cacheKey);
  if (cached !== null) return cached;

  const key = process.env.YOUTUBE_API_KEY;
  let avatar: string | null = null;

  if (key) {
    const data = await fetchJsonWithRetry<YouTubeApiChannelResponse>(
      `${YOUTUBE_CONFIG.API_BASE}/channels?part=snippet&id=${channelId}&key=${key}`,
      fetchImpl,
    );
    const thumbnails = data?.items?.[0]?.snippet?.thumbnails;
    avatar = thumbnails?.high?.url ?? thumbnails?.medium?.url ?? thumbnails?.default?.url ?? null;
  }

  if (!avatar) {
    const html = await fetchText(`https://www.youtube.com/channel/${channelId}`, fetchImpl);
    avatar = html ? extractChannelAvatarFromHtml(html) : null;
  }

  if (avatar) cache.set(cacheKey, avatar, YOUTUBE_CONFIG.AVATAR_CACHE_TTL_MS);
  return avatar;
}

/**
 * Miniature de la video en pleine largeur. `maxresdefault` n'existe pas pour
 * toutes les videos : un HEAD tranche avant de coller une image cassee dans
 * l'embed, et le flux fournit le repli en `hqdefault`.
 */
export async function resolveVideoThumbnail(
  videoId: string,
  fallbackUrl: string | null = null,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const fallback = fallbackUrl ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
  const maxRes = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;

  const cacheKey = `thumb:${videoId}`;
  const cached = cache.get<string>(cacheKey);
  if (cached !== null) return cached;

  try {
    const response = await httpLimit(() =>
      timedFetch(maxRes, { method: 'HEAD', headers: { 'User-Agent': YOUTUBE_CONFIG.USER_AGENT } }, fetchImpl),
    );
    const url = response.ok ? maxRes : fallback;
    cache.set(cacheKey, url);
    return url;
  } catch (error) {
    logger.debug('YouTubeService', `Miniature HD indisponible pour ${videoId}: ${String(error)}`);
    return fallback;
  }
}

/** Derniere video publiee, enrichie de sa nature (Short ou non). */
export async function fetchLatestVideo(channelId: string, fetchImpl: FetchLike = fetch): Promise<YoutubeVideo | null> {
  const videos = await fetchRecentVideos(channelId, fetchImpl);
  const latest = videos[0];
  if (!latest) return null;
  return { ...latest, isShort: await isYoutubeShort(latest.videoId, fetchImpl) };
}

// ==================== NOTIFICATIONS ====================

const DEFAULT_MESSAGES = {
  live: (channelName: string) => `🔴 **${channelName}** est en direct sur YouTube !`,
  video: (channelName: string) => `🎥 Nouvelle vidéo de **${channelName}** !`,
  short: (channelName: string) => `⚡ Nouveau Short de **${channelName}** !`,
} as const;

const EMBED_TITLE_PREFIX = {
  live: (title: string) => `🔴 En Live : ${title}`,
  short: (title: string) => `⚡ Short : ${title}`,
  video: (title: string) => title,
} as const;

/** Champ d'etat a mettre a jour pour chaque type d'action. */
const STATE_FIELD: Record<YoutubeAction['kind'], 'lastLiveId' | 'lastVideoId' | 'lastShortId'> = {
  live: 'lastLiveId',
  video: 'lastVideoId',
  short: 'lastShortId',
};

/** Modele personnalise associe a un type d'action. */
export function templateForAction(
  follow: Pick<YoutubeChannelFollow, 'liveMessage' | 'videoMessage' | 'shortMessage'>,
  kind: YoutubeAction['kind'],
): string | null {
  if (kind === 'live') return follow.liveMessage;
  if (kind === 'short') return follow.shortMessage;
  return follow.videoMessage;
}

/** Contenu du message et titre de l'embed pour une action donnee. */
export function buildYoutubeNotification(
  follow: Pick<YoutubeChannelFollow, 'liveMessage' | 'videoMessage' | 'shortMessage' | 'channelName'>,
  action: YoutubeAction,
): { content: string; embedTitle: string } {
  const template = templateForAction(follow, action.kind);
  const vars = {
    title: action.title,
    channel: follow.channelName,
    url: youtubeVideoUrl(action.videoId, action.kind),
  };

  return {
    content: resolveFollowMessage(template, DEFAULT_MESSAGES[action.kind](follow.channelName), vars),
    // Le modele ne remplace le titre de l'embed que s'il reference [title].
    embedTitle: templateHasVariable(template, 'title')
      ? resolveFollowMessage(template, action.title, vars)
      : EMBED_TITLE_PREFIX[action.kind](action.title),
  };
}

async function sendNotification(
  client: Client,
  guildId: string,
  targetChannelId: string,
  content: string,
  embed: EmbedBuilder,
  components: ReturnType<typeof buildYouTubeComponents>,
  mention?: string | null,
): Promise<void> {
  const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) return;

  const channel = discordGuild.channels.cache.get(targetChannelId)
    ?? await discordGuild.channels.fetch(targetChannelId).catch(() => null);

  if (!channel?.isTextBased()) {
    logger.warn('YouTubeService', `Salon ${targetChannelId} introuvable ou non textuel (guilde ${guildId}).`);
    return;
  }

  await channel.send({
    content: mention ? `${mention} ${content}` : content,
    embeds: [embed],
    components,
    // Sans consigne explicite, la conversion V2 des embeds neutralise tous
    // les pings : la mention configuree doit etre autorisee nommement.
    allowedMentions: allowedMentionsFor(mention),
  })
    .catch((e: Error) => logger.error('YouTubeService', 'Envoi de la notification impossible:', e));
}

// ==================== BOUCLE PRINCIPALE ====================

export async function checkYoutubeFollows(client: Client, fetchImpl: FetchLike = fetch): Promise<void> {
  logger.debug('YouTubeService', 'Verification des chaines YouTube suivies...');

  try {
    const follows = await prisma.youtubeChannelFollow.findMany({
      include: {
        guild: {
          include: {
            dashboardFeatureConfigs: { where: { featureKey: 'youtube' } },
          },
        },
      },
    });

    if (follows.length === 0) return;

    const followLimit = pLimit(YOUTUBE_CONFIG.MAX_CONCURRENT_FOLLOWS);
    await Promise.allSettled(
      follows.map((follow) => followLimit(() => processFollow(client, follow, fetchImpl))),
    );

    logger.debug('YouTubeService', `${follows.length} abonnement(s) YouTube verifie(s).`);
  } catch (error) {
    logger.error('YouTubeService', 'Erreur pendant la verification des abonnements YouTube:', error);
  }
}

async function processFollow(client: Client, follow: YoutubeFollowWithGuild, fetchImpl: FetchLike): Promise<void> {
  const featureConfig = follow.guild.dashboardFeatureConfigs.find((c) => c.featureKey === 'youtube');
  if (featureConfig && !featureConfig.enabled) return;

  try {
    const [live, latestVideo] = await Promise.all([
      checkYoutubeLiveStatus(follow.channelId, fetchImpl),
      fetchLatestVideo(follow.channelId, fetchImpl),
    ]);

    const actions = planYoutubeActions(follow, { live, latestVideo });
    if (actions.length === 0) return;

    const targetChannelId = follow.discordChannelId || follow.guild.publicChannelId;

    for (const action of actions) {
      if (action.notify && targetChannelId) {
        const { content, embedTitle } = buildYoutubeNotification(follow, action);
        // Avatar et miniature ne sont resolus qu'au moment d'annoncer : inutile
        // de payer ces requetes a chaque tour de boucle.
        const [channelAvatarUrl, thumbnailUrl] = await Promise.all([
          fetchChannelAvatar(follow.channelId, fetchImpl),
          resolveVideoThumbnail(action.videoId, action.thumbnailUrl ?? null, fetchImpl),
        ]);
        const embed = buildYouTubeEmbed({
          title: embedTitle,
          videoId: action.videoId,
          channelName: follow.channelName,
          publishedAt: action.publishedAt,
          kind: action.kind,
          description: action.description,
          channelUrl: `https://www.youtube.com/channel/${follow.channelId}`,
          channelAvatarUrl,
          thumbnailUrl,
        });
        const components = buildYouTubeComponents({ videoId: action.videoId, kind: action.kind });
        await sendNotification(client, follow.guildId, targetChannelId, content, embed, components, follow.mention);
      }

      await prisma.youtubeChannelFollow.update({
        where: { id: follow.id },
        data: { [STATE_FIELD[action.kind]]: action.videoId },
      }).catch((e: Error) => logger.error('YouTubeService', "Mise a jour de l'abonnement impossible:", e));
    }
  } catch (error) {
    logger.error('YouTubeService', `Erreur sur l'abonnement ${follow.channelId}:`, error);
  }
}
