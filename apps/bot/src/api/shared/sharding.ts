/** Configuration du sharding et instantanes des shards. */
import { type Client } from 'discord.js';
import prisma from '../../utils/db.js';
import type { ShardSnapshot, ShardingConfig } from './core.js';

export const SHARDING_CONFIG_KEY = 'SHARDING_CONFIG';

export const DEFAULT_SHARDING_CONFIG: ShardingConfig = {
  mode: 'auto',
  shardCount: null,
};

export function parseShardingConfig(rawValue: string | null | undefined): ShardingConfig {
  if (!rawValue) return DEFAULT_SHARDING_CONFIG;

  try {
    const parsed = JSON.parse(rawValue) as Partial<ShardingConfig>;
    if (parsed.mode === 'fixed') {
      const shardCount = Number(parsed.shardCount);
      if (Number.isFinite(shardCount) && shardCount > 0) {
        return { mode: 'fixed', shardCount: Math.floor(shardCount) };
      }
    }
  } catch {
    // ignore
  }

  return DEFAULT_SHARDING_CONFIG;
}

export async function loadShardingConfig(): Promise<ShardingConfig> {
  const config = await prisma.botGlobalConfig.findUnique({ where: { key: SHARDING_CONFIG_KEY } });
  return parseShardingConfig(config?.value ?? null);
}

export async function saveShardingConfig(config: ShardingConfig) {
  await prisma.botGlobalConfig.upsert({
    where: { key: SHARDING_CONFIG_KEY },
    update: { value: JSON.stringify(config) },
    create: { key: SHARDING_CONFIG_KEY, value: JSON.stringify(config) },
  });
}

export function requestContainerRestart() {
  if (typeof process.send === 'function') {
    process.send({ type: 'restart-container' });
    return;
  }

  setTimeout(() => process.exit(0), 250);
}

export function requestShardRespawn(shardId: number) {
  if (typeof process.send === 'function') {
    process.send({ type: 'respawn-shard', shardId });
    return;
  }

  requestContainerRestart();
}

export async function resolveGuildById(client: Client, guildId: string) {
  return client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
}

export async function collectShardSnapshots(client: Client): Promise<ShardSnapshot[]> {
  const sharding = client.shard;
  if (!sharding) {
    return [{
      shardId: 0,
      status: 'online',
      guildCount: client.guilds.cache.size,
      memberCount: client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0),
      ping: Math.round(client.ws.ping || 0),
      uptime: Math.floor(process.uptime()),
      readyAt: client.readyAt?.toISOString() ?? null,
      memoryUsage: process.memoryUsage(),
    }];
  }

  const configuredShardCount = Number(sharding.count ?? 1);
  const onlineSnapshots = await sharding.broadcastEval<ShardSnapshot>((shardClient: Client) => ({
    shardId: Number(shardClient.shard?.ids?.[0] ?? 0),
    status: shardClient.isReady() ? 'online' : 'starting',
    guildCount: shardClient.guilds.cache.size,
    memberCount: shardClient.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0),
    ping: Math.round(shardClient.ws.ping || 0),
    uptime: Math.floor(process.uptime()),
    readyAt: shardClient.readyAt?.toISOString() ?? null,
    memoryUsage: process.memoryUsage(),
  }));

  const snapshotById = new Map<number, ShardSnapshot>();
  for (const snapshot of onlineSnapshots) {
    snapshotById.set(snapshot.shardId, snapshot);
  }

  for (let shardId = 0; shardId < configuredShardCount; shardId += 1) {
    if (!snapshotById.has(shardId)) {
      snapshotById.set(shardId, {
        shardId,
        status: 'offline',
        guildCount: 0,
        memberCount: 0,
        ping: 0,
        uptime: 0,
        readyAt: null,
        memoryUsage: { rss: 0, heapUsed: 0, heapTotal: 0 },
      });
    }
  }

  return [...snapshotById.values()].sort((a, b) => a.shardId - b.shardId);
}

export async function collectShardGuilds(client: Client) {
  const sharding = client.shard;
  if (!sharding) {
    return client.guilds.cache.map((guild) => ({
      id: guild.id,
      name: guild.name,
      icon: guild.iconURL(),
      memberCount: guild.memberCount,
      joinedAt: guild.joinedAt?.toISOString() ?? null,
      activated: false,
      activationCode: null,
      shardId: 0,
    }));
  }

  interface ShardGuildResult {
    id: string;
    name: string;
    icon: string | null;
    memberCount: number;
    joinedAt: string | null;
    shardId: number;
  }

  const results = await sharding.broadcastEval<ShardGuildResult[]>((shardClient: Client) => shardClient.guilds.cache.map((guild) => ({
    id: guild.id,
    name: guild.name,
    icon: guild.iconURL(),
    memberCount: guild.memberCount,
    joinedAt: guild.joinedAt?.toISOString() ?? null,
    shardId: Number(shardClient.shard?.ids?.[0] ?? 0),
  })));

  return results.flat();
}

export let dashboardStateBroadcaster: ((guildId: string, reason: string) => void) | null = null;
export const setDashboardStateBroadcaster = (fn: (guildId: string, reason: string) => void) => {
  dashboardStateBroadcaster = fn;
};

export const broadcastDashboardStateChange = (guildId: string, reason: string) => {
  dashboardStateBroadcaster?.(guildId, reason);
};

export type DashboardEvent = { type: string } & Record<string, unknown>;

export let dashboardEventBroadcaster: ((event: DashboardEvent) => void) | null = null;
export const setDashboardEventBroadcaster = (fn: (event: DashboardEvent) => void) => {
  dashboardEventBroadcaster = fn;
};

/**
 * Diffuser un evenement qui ne porte pas sur un serveur en particulier.
 *
 * `broadcastDashboardStateChange` ne sait dire qu'une chose : « l'etat du
 * serveur X a change ». Elle ne peut donc pas annoncer l'arrivee du bot sur un
 * serveur, que personne ne regardait encore.
 *
 * Le message part vers tous les onglets connectes : il ne doit contenir que
 * l'identifiant de ce qui a bouge, jamais les donnees elles-memes. Chaque
 * client redemande alors ce qui le concerne par l'API, qui, elle, verifie ses
 * droits.
 */
export const broadcastDashboardEvent = (event: DashboardEvent) => {
  dashboardEventBroadcaster?.(event);
};

/**
 * Diffuser depuis n'importe quel shard.
 *
 * Seul le shard 0 porte l'API, et donc les WebSockets : un evenement emis
 * ailleurs - l'arrivee du bot sur un serveur, par exemple, qui se produit sur
 * le shard auquel Discord l'a attribue - n'atteindrait aucun onglet. On le
 * fait donc traverser par les shards, ou chaque processus tente sa propre
 * diffusion : seul celui qui porte l'API a un emetteur, les autres n'y voient
 * rien a faire.
 */
export const broadcastDashboardEventAcrossShards = async (
  client: Client,
  event: DashboardEvent,
): Promise<void> => {
  const sharding = client.shard;
  if (!sharding) {
    broadcastDashboardEvent(event);
    return;
  }

  // Le corps est serialise puis execute dans chaque shard : il ne peut rien
  // capturer de la portee locale, d'ou le passage par le global.
  await sharding.broadcastEval((_shardClient, payload) => {
    const broadcaster = (globalThis as unknown as Record<string, unknown>).KOTBO_WS_EVENT_BROADCASTER;
    if (typeof broadcaster === 'function') {
      (broadcaster as (value: unknown) => void)(payload);
    }
  }, { context: event });
};
