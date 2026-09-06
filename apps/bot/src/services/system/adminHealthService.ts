/**
 * Historique de sante du bot pour la console admin.
 *
 * `/api/admin/stats` ne renvoie qu'un instantane : impossible d'y lire une
 * fuite memoire lente ou une degradation de ping. On echantillonne donc en
 * memoire dans le processus qui porte l'API, ce qui suffit a tracer des
 * courbes sans ajouter une table ecrite toutes les 30 secondes.
 */
import type { Client } from 'discord.js';
import { logger } from '../../utils/logger.js';
import { collectShardSnapshots } from '../../api/shared/sharding.js';
import type { ShardSnapshot } from '../../api/shared/core.js';

export interface HealthSample {
  /** Epoch ms. */
  t: number;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  averagePing: number;
  onlineShards: number;
  totalShards: number;
  guilds: number;
  members: number;
  /** Charge CPU du processus sur l'intervalle, en pourcentage d'un cœur. */
  cpu: number;
  uptime: number;
}

const SAMPLE_INTERVAL_MS = 30_000;
/** 24 h d'historique a 30 s d'intervalle. */
const MAX_SAMPLES = Math.ceil((24 * 60 * 60 * 1000) / SAMPLE_INTERVAL_MS);

const samples: HealthSample[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let lastCpuUsage: NodeJS.CpuUsage | null = null;
let lastCpuAt = 0;

function measureCpuPercent(): number {
  const now = Date.now();
  const usage = process.cpuUsage();
  if (!lastCpuUsage || lastCpuAt === 0) {
    lastCpuUsage = usage;
    lastCpuAt = now;
    return 0;
  }
  const elapsedMs = now - lastCpuAt;
  if (elapsedMs <= 0) return 0;
  const deltaMicros = (usage.user - lastCpuUsage.user) + (usage.system - lastCpuUsage.system);
  lastCpuUsage = usage;
  lastCpuAt = now;
  return Math.max(0, Math.round((deltaMicros / 1000 / elapsedMs) * 100));
}

async function takeSample(client: Client): Promise<void> {
  try {
    const memory = process.memoryUsage();
    let snapshots: ShardSnapshot[] = [];
    try {
      snapshots = await collectShardSnapshots(client);
    } catch {
      snapshots = [];
    }

    const online = snapshots.filter((snapshot) => snapshot.status !== 'offline');
    const averagePing = snapshots.length > 0
      ? Math.round(snapshots.reduce((acc, snapshot) => acc + snapshot.ping, 0) / snapshots.length)
      : Math.max(0, Math.round(client.ws.ping));

    const guilds = snapshots.length > 0
      ? snapshots.reduce((acc, snapshot) => acc + (snapshot.guildCount ?? 0), 0)
      : client.guilds.cache.size;
    const members = snapshots.length > 0
      ? snapshots.reduce((acc, snapshot) => acc + (snapshot.memberCount ?? 0), 0)
      : client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0);

    samples.push({
      t: Date.now(),
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
      rss: memory.rss,
      external: memory.external,
      averagePing,
      onlineShards: online.length,
      totalShards: snapshots.length,
      guilds,
      members,
      cpu: measureCpuPercent(),
      uptime: Math.floor(process.uptime()),
    });

    while (samples.length > MAX_SAMPLES) samples.shift();
  } catch (err) {
    logger.warn('AdminHealth', `Echantillonnage impossible: ${(err as Error).message}`);
  }
}

/** Demarre l'echantillonnage une seule fois, a la premiere consultation. */
export function ensureAdminHealthSampling(client: Client): void {
  if (timer) return;
  void takeSample(client);
  timer = setInterval(() => { void takeSample(client); }, SAMPLE_INTERVAL_MS);
  timer.unref?.();
  logger.info('AdminHealth', `Historique de sante actif (${SAMPLE_INTERVAL_MS / 1000}s, ${MAX_SAMPLES} points max)`);
}

export function stopAdminHealthSampling(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export interface HealthSeries {
  samples: HealthSample[];
  intervalMs: number;
  /** Tendance de la memoire heap sur la fenetre demandee, en octets par heure. */
  heapTrendPerHour: number;
  peak: { heapUsed: number; rss: number; averagePing: number; cpu: number } | null;
}

/**
 * Serie sur les `minutes` dernieres minutes, sous-echantillonnee pour ne
 * jamais renvoyer plus de `maxPoints` points au navigateur.
 */
export function getAdminHealthSeries(minutes = 60, maxPoints = 180): HealthSeries {
  const since = Date.now() - minutes * 60_000;
  const window = samples.filter((sample) => sample.t >= since);

  const step = Math.max(1, Math.ceil(window.length / maxPoints));
  const reduced = step === 1 ? window : window.filter((_, index) => index % step === 0);

  let heapTrendPerHour = 0;
  if (window.length >= 2) {
    const first = window[0];
    const last = window[window.length - 1];
    const hours = (last.t - first.t) / 3_600_000;
    if (hours > 0.05) {
      heapTrendPerHour = Math.round((last.heapUsed - first.heapUsed) / hours);
    }
  }

  const peak = window.length > 0
    ? {
      heapUsed: Math.max(...window.map((s) => s.heapUsed)),
      rss: Math.max(...window.map((s) => s.rss)),
      averagePing: Math.max(...window.map((s) => s.averagePing)),
      cpu: Math.max(...window.map((s) => s.cpu)),
    }
    : null;

  return { samples: reduced, intervalMs: SAMPLE_INTERVAL_MS * step, heapTrendPerHour, peak };
}
