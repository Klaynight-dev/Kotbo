import { Queue, Worker, type JobsOptions, type Processor } from 'bullmq';
import type { Redis } from 'ioredis';
import { createRedisForWorker } from '../redis.js';
import { logger } from '../../utils/logger.js';

export type BackgroundJobName =
  | 'rss'
  | 'youtube'
  | 'twitch'
  | 'digest'
  | 'daily-algo'
  | 'daily-algo-summary'
  | 'daily-algo-week'
  | 'weekly-recap'
  | 'sanctions'
  | 'staff-warnings-expiration'
  | 'staff-blacklist-expiration'
  | 'activity-10min-snapshot'
  | 'analytics-hourly-snapshot'
  | 'analytics-snapshot'
  | 'missing-reports-check'
  | 'meeting-notifications'
  | 'dc-scan'
  | 'ticket-inactivity'
  | 'satisfaction-prompt-expiry'
  | 'scheduled-events'
  | 'leaderboard-refresh'
  | 'history-scrape'
  | 'data-retention'
  | 'channel-health-analysis'
  | 'pulse-snapshot'
  | 'widget-refresh'
  | 'season-check'
  | 'clan-season-check'
  | 'clan-bet-expiration'
  | 'marketplace-expiration'
  | 'quest-expiration'
  | 'giveaways-expiration'
  | 'access-lifecycle'
  | 'stats-ping'
  | 'message-logs-prune'
  | 'audit-events-prune'
  | 'billing-events-prune'
  | 'billing-renewal-notice'
  | 'analytics-daily-snapshot'
  | 'acquisition-events-prune'
  | 'acquisition-abandon-scan'
  | 'acquisition-alerts-check'
  | 'acquisition-weekly-recap'
  | 'workflow-resume'
  | 'word-stats-prune'
  | 'ban-hygiene-scan'
  | 'warn-auto-archive'
  | 'staff-reminders'
  | 'raid-protection-tick'
  | 'raid-protection-locks-renew'
  | 'welcome-thread-cleanup'
  | 'member-access-reconcile'
  | 'ranked-decay'
  | 'ranked-events'
  | 'ranked-streak-freezes'
  | 'ranked-logs-prune'
  | 'black-market-cycle'
  | 'drop-cycle'
  // Ces trois-la etaient enregistres par `crons.ts` sans figurer ici :
  // le typecheck echouait sur leur handler.
  | 'raid-cycle'
  | 'clan-weekly-digest'
  | 'workflow-schedule'
  | 'campaign-cycle';



type BackgroundJobPayload = {
  jitterMs?: number;
  guildId?: string;
  channelId?: string;
  beforeMessageId?: string;
};

const QUEUE_NAME = 'kotbo-background-jobs';
const DEFAULT_LOCK_DURATION_MS = 120_000;
const DEFAULT_MAX_STALLED_COUNT = 3;

let queue: Queue<BackgroundJobPayload, void, BackgroundJobName> | null = null;
let worker: Worker<BackgroundJobPayload, void, BackgroundJobName> | null = null;
let queueConnection: Redis | null = null;
let workerConnection: Redis | null = null;
let handlers: Partial<Record<BackgroundJobName, () => Promise<void>>> = {};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getProcessor(): Processor<BackgroundJobPayload, void, BackgroundJobName> {
  return async (job) => {
    const handler = handlers[job.name as BackgroundJobName];
    if (!handler) {
      // Un succès silencieux supprimait définitivement le job de BullMQ alors
      // que le fallback local n'était plus exécuté.
      throw new Error(`Aucun handler enregistré pour ${job.name}.`);
    }

    if (job.data?.jitterMs && job.data.jitterMs > 0) {
      await delay(Math.floor(Math.random() * job.data.jitterMs));
    }

    await handler();
  };
}

export function registerBackgroundJobHandlers(nextHandlers: Partial<Record<BackgroundJobName, () => Promise<void>>>): void {
  handlers = { ...handlers, ...nextHandlers };
}

export async function startBackgroundQueueWorker(): Promise<boolean> {
  if (queue && worker) return true;

  queueConnection = createRedisForWorker();
  workerConnection = createRedisForWorker();
  if (!queueConnection || !workerConnection) {
    logger.warn('Queue', 'BullMQ désactivé: Redis indisponible.');
    return false;
  }

  try {
    await queueConnection.connect();
    await workerConnection.connect();

    queue = new Queue<BackgroundJobPayload, void, BackgroundJobName>(QUEUE_NAME, {
      connection: queueConnection,
      defaultJobOptions: {
        removeOnComplete: 50,
        removeOnFail: 200,
      },
    });

    worker = new Worker<BackgroundJobPayload, void, BackgroundJobName>(
      QUEUE_NAME,
      getProcessor(),
      {
        connection: workerConnection,
        concurrency: readPositiveInteger(process.env.BULLMQ_CONCURRENCY, 10),
        // Certains jobs (notamment le snapshot d'activité lissé sur 9 minutes)
        // restent actifs longtemps. Un verrou plus généreux évite les faux
        // "stalled" lors d'une courte pause de l'event loop, tandis que BullMQ
        // continue de le renouveler automatiquement à mi-durée.
        lockDuration: readPositiveInteger(
          process.env.BULLMQ_LOCK_DURATION_MS,
          DEFAULT_LOCK_DURATION_MS,
        ),
        // Un redéploiement interrompt les jobs actifs. Autoriser plusieurs
        // récupérations empêche qu'un job périodique devienne irrécupérable
        // après deux redéploiements rapprochés.
        maxStalledCount: readPositiveInteger(
          process.env.BULLMQ_MAX_STALLED_COUNT,
          DEFAULT_MAX_STALLED_COUNT,
        ),
      },
    );

    worker.on('stalled', (jobId) => {
      logger.warn('Queue', `Job interrompu puis remis en attente: ${jobId}`);
    });

    worker.on('failed', (job, error) => {
      logger.error('Queue', `Job échoué: ${job?.name ?? 'inconnu'}`, error);
    });

    worker.on('completed', (job) => {
      logger.debug('Queue', `Job terminé: ${job.name}`);
    });

    logger.success('Queue', 'BullMQ initialisé.');
    return true;
  } catch (error) {
    logger.error('Queue', 'Impossible de démarrer BullMQ:', error);
    await queue?.close().catch(() => undefined);
    await worker?.close().catch(() => undefined);
    queue = null;
    worker = null;
    queueConnection?.disconnect();
    workerConnection?.disconnect();
    queueConnection = null;
    workerConnection = null;
    return false;
  }
}

export async function enqueueBackgroundJob(
  name: BackgroundJobName,
  payload: BackgroundJobPayload = {},
  options: JobsOptions = {},
): Promise<boolean> {
  if (!queue) return false;

  try {
    await queue.add(name, payload, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 2000 },
      ...options,
    });
    return true;
  } catch (error) {
    logger.error('Queue', `Impossible d'enfiler le job ${name}:`, error);
    return false;
  }
}

export function isBackgroundQueueEnabled(): boolean {
  return Boolean(queue && worker);
}

export async function enqueueHistoryScrape(
  guildId: string,
  channelId: string,
  beforeMessageId?: string,
): Promise<boolean> {
  return enqueueBackgroundJob(
    'history-scrape',
    { guildId, channelId, beforeMessageId },
    {
      priority: 10,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      jobId: `history-scrape-${guildId}-${channelId}`,
    },
  );
}
