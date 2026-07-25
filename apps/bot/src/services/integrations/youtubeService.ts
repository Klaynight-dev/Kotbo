import { type Client } from 'discord.js';
import prisma from '../../utils/db.js';
import type { EmbedBuilder } from 'discord.js';
import { buildYouTubeEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import type { DashboardFeatureConfig, Guild, YoutubeChannelFollow } from '@prisma/client';

/**
 * Abonnement YouTube tel que charge par le polling : la guilde et sa config de
 * module sont incluses par la requete, ce que le modele seul ne dit pas.
 */
type YoutubeFollowWithGuild = YoutubeChannelFollow & {
  guild: Guild & { dashboardFeatureConfigs: DashboardFeatureConfig[] };
};

// ==================== TYPES ====================

interface YouTubeChannelSnippet {
  title: string;
  description?: string;
  publishedAt?: string;
  thumbnails?: {
    default?: { url: string };
    medium?: { url: string };
    high?: { url: string };
  };
}

interface YouTubeChannelResource {
  id: string;
  snippet: YouTubeChannelSnippet;
}

interface YouTubeChannelResponse {
  items?: YouTubeChannelResource[];
  error?: {
    code: number;
    message: string;
    errors?: Array<{
      reason: string;
      message: string;
    }>;
  };
}

interface YouTubeSearchItem {
  id: {
    channelId?: string;
    kind: string;
  };
  snippet: {
    title: string;
    channelId?: string;
  };
}

interface YouTubeSearchResponse {
  items?: YouTubeSearchItem[];
  error?: { message?: string };
}

interface YouTubePlaylistItemSnippet {
  title: string;
  publishedAt: string;
  channelId: string;
  description?: string;
}

interface YouTubePlaylistItemContentDetails {
  videoId: string;
}

interface YouTubePlaylistItem {
  snippet: YouTubePlaylistItemSnippet;
  contentDetails: YouTubePlaylistItemContentDetails;
}

interface YouTubePlaylistItemsResponse {
  items?: YouTubePlaylistItem[];
  nextPageToken?: string;
  error?: unknown;
}

interface LiveStatus {
  isLive: boolean;
  videoId?: string;
  title?: string;
}

interface VideoInfo {
  videoId: string;
  title: string;
  publishedAt: Date;
  isShort: boolean;
}

// ==================== CONFIGURATION ====================

const YOUTUBE_CONFIG = {
  API_BASE: 'https://www.googleapis.com/youtube/v3',
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 1000,
  CACHE_TTL_MS: 5 * 60 * 1000,
  MAX_CONCURRENT_REQUESTS: 5,
  REQUEST_TIMEOUT_MS: 10000,
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

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) this.cache.delete(key);
    }
  }
}

const cache = new YouTubeCache();

setInterval(() => {
  cache.evictExpired();
}, 10 * 60 * 1000);

// ==================== RATE LIMITER ====================

class RateLimiter {
  private activeRequests = 0;
  private waiters: Array<() => void> = [];

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    while (this.activeRequests >= YOUTUBE_CONFIG.MAX_CONCURRENT_REQUESTS) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }

    this.activeRequests++;
    try {
      return await fn();
    } finally {
      this.activeRequests--;
      this.waiters.shift()?.();
    }
  }
}

const rateLimiter = new RateLimiter();

// ==================== RETRY LOGIC ====================

async function fetchWithRetry<T>(
  url: string,
  options: RequestInit = {},
  retries = YOUTUBE_CONFIG.MAX_RETRIES
): Promise<T | null> {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), YOUTUBE_CONFIG.REQUEST_TIMEOUT_MS);
      
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);

      if (response.ok) {
        return await response.json() as T;
      }

      if (response.status === 429) {
        const delay = YOUTUBE_CONFIG.RETRY_DELAY_MS * Math.pow(2, i);
        logger.warn('YouTubeService', `Rate limited, retrying in ${delay}ms (attempt ${i + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      if (i === retries - 1) {
        const text = await response.text().catch(() => '');
        logger.error('YouTubeService', `Request failed with status ${response.status}: ${text}`);
        return null;
      }

      const delay = YOUTUBE_CONFIG.RETRY_DELAY_MS * Math.pow(2, i);
      await new Promise(resolve => setTimeout(resolve, delay));
    } catch (error) {
      if (i === retries - 1) {
        logger.error('YouTubeService', `Request failed after ${retries} retries:`, error);
        return null;
      }
      
      const delay = YOUTUBE_CONFIG.RETRY_DELAY_MS * Math.pow(2, i);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  return null;
}

// ==================== CHANNEL RESOLUTION ====================

export async function resolveYoutubeChannel(query: string): Promise<{ channelId: string; channelName: string } | null> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) {
    logger.warn('YouTubeService', 'YOUTUBE_API_KEY is not defined');
    return null;
  }

  const cleaned = query.trim();
  const cacheKey = `channel:${cleaned}`;
  
  const cached = cache.get<{ channelId: string; channelName: string }>(cacheKey);
  if (cached) return cached;

  let result: { channelId: string; channelName: string } | null = null;

  if (/^UC[a-zA-Z0-9_-]{22}$/.test(cleaned)) {
    result = await fetchChannelById(cleaned, key);
  }
  
  if (!result) {
    const { handle, channelId } = extractFromUrl(cleaned);
    
    if (channelId) {
      result = await fetchChannelById(channelId, key);
    } else if (handle) {
      result = await fetchChannelByHandle(handle, key);
    }
  }

  if (!result) {
    result = await searchChannel(cleaned, key);
  }

  if (result) {
    cache.set(cacheKey, result);
  }

  return result;
}

function extractFromUrl(query: string): { handle: string | null; channelId: string | null } {
  let handle: string | null = null;
  let channelId: string | null = null;

  if (query.includes('youtube.com/') || query.includes('youtu.be/')) {
    const matchChannel = query.match(/\/channel\/(UC[a-zA-Z0-9_-]{22})/);
    if (matchChannel) {
      channelId = matchChannel[1];
    } else {
      const matchHandle = query.match(/\/@([^/?\s#]+)/);
      if (matchHandle) {
        handle = '@' + matchHandle[1];
      }
    }
  } else if (query.startsWith('@')) {
    handle = query;
  }

  return { handle, channelId };
}

async function fetchChannelById(channelId: string, key: string): Promise<{ channelId: string; channelName: string } | null> {
  const url = `${YOUTUBE_CONFIG.API_BASE}/channels?part=snippet&id=${channelId}&key=${key}`;
  const data = await fetchWithRetry<YouTubeChannelResponse>(url);
  
  if (data?.items?.[0]) {
    return {
      channelId: data.items[0].id,
      channelName: data.items[0].snippet.title,
    };
  }
  
  return null;
}

async function fetchChannelByHandle(handle: string, key: string): Promise<{ channelId: string; channelName: string } | null> {
  const url = `${YOUTUBE_CONFIG.API_BASE}/channels?part=snippet&forHandle=${encodeURIComponent(handle)}&key=${key}`;
  const data = await fetchWithRetry<YouTubeChannelResponse>(url);
  
  if (data?.items?.[0]) {
    return {
      channelId: data.items[0].id,
      channelName: data.items[0].snippet.title,
    };
  } else if (data?.error) {
    logger.warn('YouTubeService', `No channel found for handle "${handle}": ${data.error.message}`);
  }
  
  return null;
}

async function searchChannel(query: string, key: string): Promise<{ channelId: string; channelName: string } | null> {
  const url = `${YOUTUBE_CONFIG.API_BASE}/search?part=snippet&q=${encodeURIComponent(query)}&type=channel&maxResults=1&key=${key}`;
  const data = await fetchWithRetry<YouTubeSearchResponse>(url);
  
  if (data?.items?.[0]?.id?.channelId) {
    return {
      channelId: data.items[0].id.channelId,
      channelName: data.items[0].snippet.title,
    };
  } else if (data?.error) {
    logger.warn('YouTubeService', `No search result for query "${query}": ${data.error.message}`);
  }
  
  return null;
}

// ==================== SHORT DETECTION ====================

async function isYoutubeShort(videoId: string): Promise<boolean> {
  const cacheKey = `short:${videoId}`;
  
  const cachedShort = cache.get<boolean>(cacheKey);
  if (cachedShort !== null) {
    return cachedShort;
  }

  try {
    const response = await rateLimiter.execute(async () => {
      const res = await fetch(`https://www.youtube.com/shorts/${videoId}`, {
        method: 'HEAD',
        redirect: 'manual',
      });
      return res;
    });
    
    const isShort = response.status === 200;
    cache.set(cacheKey, isShort);
    return isShort;
  } catch (error) {
    logger.error('YouTubeService', `Error testing short redirect for ${videoId}:`, error);
    return false;
  }
}

// ==================== LIVE STATUS ====================

async function checkYoutubeLiveStatus(channelId: string): Promise<LiveStatus> {
  const cacheKey = `live:${channelId}`;
  const cached = cache.get(cacheKey) as LiveStatus | null;
  if (cached) return cached;

  const LIVE_CACHE_TTL_MS = 60_000;

  const rssResult = await checkLiveViaRSS(channelId);
  if (rssResult.isLive) {
    cache.set(cacheKey, rssResult, LIVE_CACHE_TTL_MS);
    return rssResult;
  }

  const htmlResult = await checkLiveViaHTML(channelId);
  cache.set(cacheKey, htmlResult, LIVE_CACHE_TTL_MS);
  return htmlResult;
}

async function checkLiveViaRSS(channelId: string): Promise<LiveStatus> {
  try {
    const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
    const response = await rateLimiter.execute(async () => {
      return await fetch(rssUrl, {
        headers: { 'User-Agent': YOUTUBE_CONFIG.USER_AGENT },
      });
    });

    if (!response.ok) {
      return { isLive: false };
    }

    const text = await response.text();
    
    if (text.includes('<yt:videoId>') && text.includes('live_broadcast')) {
      const videoIdMatch = text.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
      const titleMatch = text.match(/<title>([^<]+)<\/title>/);
      
      if (videoIdMatch) {
        return {
          isLive: true,
          videoId: videoIdMatch[1],
          title: titleMatch?.[1] || 'En direct sur YouTube',
        };
      }
    }
  } catch (error) {
    logger.debug('YouTubeService', `RSS live check failed for ${channelId}, falling back to HTML`);
  }

  return { isLive: false };
}

async function checkLiveViaHTML(channelId: string): Promise<LiveStatus> {
  try {
    const response = await rateLimiter.execute(async () => {
      return await fetch(`https://www.youtube.com/channel/${channelId}/live`, {
        headers: { 'User-Agent': YOUTUBE_CONFIG.USER_AGENT },
      });
    });

    if (!response.ok) {
      return { isLive: false };
    }

    const html = await response.text();
    
    const canonicalMatch = html.match(/canonical" href="https:\/\/www.youtube.com\/watch\?v=([^"]+)"/);
    const videoId = canonicalMatch ? canonicalMatch[1] : undefined;

    const liveIndicators = ['isLive', 'liveStreamability', '"style":"LIVE"', 'LIVE_STARTED'];
    const isLive = videoId && liveIndicators.some(indicator => html.includes(indicator));

    if (isLive && videoId) {
      const titleMatch = html.match(/"title":"([^"]+)"/) || html.match(/<title>([^<]+)<\/title>/);
      const title = titleMatch ? titleMatch[1].replace(' - YouTube', '') : 'En direct sur YouTube';
      return { isLive: true, videoId, title };
    }
  } catch (error) {
    logger.error('YouTubeService', `Error checking live status for channel ${channelId}:`, error);
  }

  return { isLive: false };
}

// ==================== VIDEO FETCHING ====================

async function fetchRecentVideos(channelId: string, key: string): Promise<VideoInfo[]> {
  const uploadsPlaylistId = 'UU' + channelId.substring(2);
  const url = `${YOUTUBE_CONFIG.API_BASE}/playlistItems?part=snippet,contentDetails&playlistId=${uploadsPlaylistId}&maxResults=10&key=${key}`;
  
  const data = await fetchWithRetry<YouTubePlaylistItemsResponse>(url);
  
  if (!data?.items) {
    return [];
  }

  const validItems = data.items.filter(
    (item) => item.contentDetails?.videoId && item.snippet?.title && item.snippet?.publishedAt,
  );

  const shortResults = await Promise.all(
    validItems.map((item) => isYoutubeShort(item.contentDetails.videoId)),
  );

  const videos: VideoInfo[] = validItems.map((item, i) => ({
    videoId: item.contentDetails.videoId,
    title: item.snippet.title,
    publishedAt: new Date(item.snippet.publishedAt),
    isShort: shortResults[i],
  }));

  return videos.sort((a, b) => a.publishedAt.getTime() - b.publishedAt.getTime());
}

// ==================== NOTIFICATION HELPERS ====================

async function sendNotification(
  client: Client,
  guildId: string,
  targetChannelId: string,
  content: string,
  embed: EmbedBuilder,
  mention?: string
): Promise<void> {
  const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) return;

  const channel = discordGuild.channels.cache.get(targetChannelId) || 
                 await discordGuild.channels.fetch(targetChannelId).catch(() => null);
  
  if (!channel?.isTextBased()) return;

  const finalContent = mention ? `${mention} ${content}` : content;
  
  await channel.send({ content: finalContent, embeds: [embed] })
    .catch((e: Error) => logger.error('YouTubeService', 'Failed to send notification:', e));
}

async function updateFollowRecord(followId: string, updates: Record<string, string>): Promise<void> {
  await prisma.youtubeChannelFollow.update({
    where: { id: followId },
    data: updates,
  }).catch((e: Error) => logger.error('YouTubeService', 'Failed to update follow record:', e));
}

// ==================== MAIN CHECK FUNCTION ====================

export async function checkYoutubeFollows(client: Client) {
  logger.debug('YouTubeService', 'Checking YouTube followed channels...');
  const key = process.env.YOUTUBE_API_KEY;
  
  if (!key) {
    logger.warn('YouTubeService', 'YOUTUBE_API_KEY is not defined in .env.');
    return;
  }

  try {
    const follows = await prisma.youtubeChannelFollow.findMany({
      include: {
        guild: {
          include: {
            dashboardFeatureConfigs: {
              where: { featureKey: 'youtube' },
            },
          },
        },
      },
    });

    const processingPromises = follows.map((follow) => 
      rateLimiter.execute(() => processFollow(client, follow, key))
    );

    await Promise.allSettled(processingPromises);
    
    logger.debug('YouTubeService', `Checked ${follows.length} YouTube follows`);
  } catch (error) {
    logger.error('YouTubeService', 'Error checking YouTube follows:', error);
  }
}

async function processFollow(
  client: Client,
  follow: YoutubeFollowWithGuild,
  key: string
): Promise<void> {
  const ytFeatureConfig = follow.guild.dashboardFeatureConfigs.find((c) => c.featureKey === 'youtube');
  if (ytFeatureConfig && !ytFeatureConfig.enabled) {
    return;
  }

  const guildId = follow.guildId;
  const channelId = follow.channelId;
  const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  
  if (!discordGuild) return;

  await checkAndNotifyLive(client, follow, channelId, discordGuild);
  await checkAndNotifyVideos(client, follow, channelId, key, discordGuild);
}

async function checkAndNotifyLive(
  client: Client,
  follow: YoutubeFollowWithGuild,
  channelId: string,
  _discordGuild: unknown
): Promise<void> {
  const liveStatus = await checkYoutubeLiveStatus(channelId);

  if (liveStatus.isLive && liveStatus.videoId && liveStatus.videoId !== follow.lastLiveId) {
    const targetChannelId = follow.discordChannelId || follow.guild.publicChannelId;

    if (targetChannelId) {
      // Use custom message if provided, otherwise use default
      const message = follow.liveMessage || `🔴 **${follow.channelName}** est en direct sur YouTube !`;

      // Use custom embed title if message contains {title}, otherwise use default
      const embedTitle = follow.liveMessage?.includes('{title}')
        ? follow.liveMessage.replace('{title}', (liveStatus.title ?? ''))
        : `🔴 En Live : ${(liveStatus.title ?? '')}`;

      const embed = buildYouTubeEmbed({
        title: embedTitle,
        videoId: liveStatus.videoId,
        channelName: follow.channelName,
        publishedAt: new Date(),
      });

      await sendNotification(
        client,
        follow.guildId,
        targetChannelId,
        message.replace('{title}', (liveStatus.title ?? '')).replace('{channel}', follow.channelName),
        embed,
        follow.mention ?? undefined
      );
    }

    await updateFollowRecord(follow.id, { lastLiveId: liveStatus.videoId });
  }
}

async function checkAndNotifyVideos(
  client: Client,
  follow: YoutubeFollowWithGuild,
  channelId: string,
  key: string,
  _discordGuild: unknown
): Promise<void> {
  const videos = await fetchRecentVideos(channelId, key);
  
  // Only process the latest video (first one after sorting by publishedAt)
  const latestVideo = videos[0];
  if (!latestVideo) return;

  if (latestVideo.videoId === follow.lastVideoId || latestVideo.videoId === follow.lastShortId) {
    return;
  }

  const targetChannelId = follow.discordChannelId || follow.guild.publicChannelId;

  if (latestVideo.isShort) {
    if (targetChannelId) {
      // Use custom message if provided, otherwise use default
      const message = follow.shortMessage || `⚡ Nouveau Short de **${follow.channelName}** !`;

      // Use custom embed title if message contains {title}, otherwise use default
      const embedTitle = follow.shortMessage?.includes('{title}')
        ? follow.shortMessage.replace('{title}', latestVideo.title)
        : `⚡ Short : ${latestVideo.title}`;

      const embed = buildYouTubeEmbed({
        title: embedTitle,
        videoId: latestVideo.videoId,
        channelName: follow.channelName,
        publishedAt: latestVideo.publishedAt,
      });

      await sendNotification(
        client,
        follow.guildId,
        targetChannelId,
        message.replace('{title}', latestVideo.title).replace('{channel}', follow.channelName),
        embed,
        follow.mention ?? undefined
      );
    }

    await updateFollowRecord(follow.id, { lastShortId: latestVideo.videoId });
  } else {
    if (targetChannelId) {
      // Use custom message if provided, otherwise use default
      const message = follow.videoMessage || `🎥 Nouvelle vidéo de **${follow.channelName}** !`;

      // Use custom embed title if message contains {title}, otherwise use default
      const embedTitle = follow.videoMessage?.includes('{title}')
        ? follow.videoMessage.replace('{title}', latestVideo.title)
        : latestVideo.title;

      const embed = buildYouTubeEmbed({
        title: embedTitle,
        videoId: latestVideo.videoId,
        channelName: follow.channelName,
        publishedAt: latestVideo.publishedAt,
      });

      await sendNotification(
        client,
        follow.guildId,
        targetChannelId,
        message.replace('{title}', latestVideo.title).replace('{channel}', follow.channelName),
        embed,
        follow.mention ?? undefined
      );
    }

    await updateFollowRecord(follow.id, { lastVideoId: latestVideo.videoId });
  }
}
