import { type Client } from 'discord.js';
import cron from 'node-cron';
import prisma from '../utils/db.js';
import { runDailyAlgoForAllGuilds, runDailyAlgoSummariesForAllGuilds } from '../services/progression/dailyAlgoService.js';
import { scanGuildMembersForYoungAccounts, JOIN_TO_ACCOUNT_CREATION_PROXIMITY_MS } from '../services/moderation/dcDetectionService.js';
import { processScheduledSanctions, checkMissingReports } from '../services/moderation/sanctionService.js';
import { processMeetingNotifications } from '../services/staff/staffLeadershipService.js';
import { logger } from '../utils/logger.js';
import pLimit from 'p-limit';
import { runActivitySnapshot } from './advancedLogs.js';
import { enqueueBackgroundJob, registerBackgroundJobHandlers, type BackgroundJobName } from '../infra/queues/backgroundQueue.js';
import { checkYoutubeFollows } from '../services/integrations/youtubeService.js';
import { checkTwitchFollows } from '../services/integrations/twitchService.js';
import { initializeDatabaseBackup } from '../services/system/databaseBackupService.js';
import { checkTicketInactivity } from '../services/features/ticketService.js';
import { refreshAllAutoLeaderboards } from '../services/progression/leaderboardService.js';
import { pruneOldMessageLogs } from './messageLogging.js';

const runningJobs = new Set<string>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runCronJob(name: string, task: () => Promise<void>, jitterMs = 0): Promise<void> {
  const minuteTimestamp = Math.floor(Date.now() / 60000);
  const enqueued = await enqueueBackgroundJob(name as BackgroundJobName, { jitterMs }, { jobId: `cron-${name}-${minuteTimestamp}` });
  if (enqueued) {
    logger.debug('Cron', `Job mis en file: ${name}`);
    return;
  }

  if (runningJobs.has(name)) {
    logger.warn('Cron', `Job ignoré (déjà en cours): ${name}`);
    return;
  }

  runningJobs.add(name);
  const startedAt = Date.now();

  try {
    if (jitterMs > 0) {
      const jitter = Math.floor(Math.random() * jitterMs);
      await delay(jitter);
    }

    await task();
    logger.debug('Cron', `Job terminé: ${name} (${Date.now() - startedAt}ms)`);
  } catch (error) {
    logger.error('Cron', `Erreur job ${name}:`, error);
  } finally {
    runningJobs.delete(name);
  }
}

async function expireStaffWarnings(): Promise<void> {
  logger.debug('Cron', "Vérification de l'expiration des avertissements staff...");
  const now = new Date();

  const expiredWarnings = await prisma.staffWarning.findMany({
    where: {
      isActive: true,
      expiresAt: { lte: now },
    },
    select: { id: true, staffUserId: true },
  });

  if (expiredWarnings.length > 0) {
    await prisma.staffWarning.updateMany({
      where: {
        id: { in: expiredWarnings.map((w) => w.id) },
      },
      data: { isActive: false },
    });
    logger.info('Cron', `✅ ${expiredWarnings.length} avertissement(s) staff expiré(s)`);
  }
}

async function expireStaffBlacklist(): Promise<void> {
  logger.debug('Cron', "Vérification de l'expiration de la blacklist staff...");
  const now = new Date();

  const expiredBlacklists = await prisma.staffBlacklist.findMany({
    where: {
      isActive: true,
      endDate: { lte: now },
    },
    select: { id: true, staffUserId: true },
  });

  if (expiredBlacklists.length > 0) {
    await prisma.staffBlacklist.updateMany({
      where: {
        id: { in: expiredBlacklists.map((b) => b.id) },
      },
      data: { isActive: false },
    });
    logger.info('Cron', `✅ ${expiredBlacklists.length} blacklist(s) staff expiré(e)s`);
  }
}

export async function registerCrons(client: Client): Promise<void> {
  logger.info('Cron', "Début de l'enregistrement des cron jobs...");
  // Initialiser le backup automatique de la base de données
  initializeDatabaseBackup();
  logger.info('Cron', 'Backup automatique initialisé');

  // Initialiser les planifications dynamiques de la base de données
  try {
    logger.info('Cron', 'Chargement du planificateur de tâches planifiées...');
    const { initializeScheduler } = await import('../services/system/scheduleService.js');
    await initializeScheduler(client);
    logger.info('Cron', 'Planificateur de tâches planifiées initialisé');
  } catch (err) {
    logger.error('Cron', 'Erreur lors du démarrage du planificateur de tâches planifiées:', err);
  }

  registerBackgroundJobHandlers({
    'scheduled-events': async () => {
      logger.debug('Cron', 'Vérification des événements planifiés...');
      const { checkScheduledEvents } = await import('../services/features/eventService.js');
      await checkScheduledEvents(client);
    },
    'daily-algo': async () => {
      const now = new Date();
      const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      logger.debug('Cron', `Vérification du daily algo à ${currentTime}...`);
      await runDailyAlgoForAllGuilds(client);
    },
    'daily-algo-summary': async () => {
      logger.debug('Cron', 'Génération du bilan quotidien Daily Algo...');
      await runDailyAlgoSummariesForAllGuilds(client);
    },
    sanctions: async () => {
      logger.debug('Cron', 'Traitement des sanctions planifiées...');
      await processScheduledSanctions(client);
    },
    youtube: async () => {
      logger.debug('Cron', 'Vérification YouTube...');
      await checkYoutubeFollows(client);
    },
    twitch: async () => {
      logger.debug('Cron', 'Vérification Twitch...');
      await checkTwitchFollows(client);
    },
    'staff-warnings-expiration': expireStaffWarnings,
    'staff-blacklist-expiration': expireStaffBlacklist,
    'activity-10min-snapshot': async () => {
      runActivitySnapshot(client).catch((error) => {
        logger.error('Analytics', "Erreur lors du snapshot d'activité en arrière-plan:", error);
      });
    },
    'missing-reports-check': async () => {
      logger.info('Cron', 'Vérification des rapports de sanction manquants...');
      await checkMissingReports();
    },
    'ticket-inactivity': async () => {
      logger.debug('Cron', "Vérification de l'inactivité des tickets...");
      await checkTicketInactivity(client);
    },
    'leaderboard-refresh': async () => {
      logger.debug('Cron', 'Actualisation des leaderboards automatiques...');
      await refreshAllAutoLeaderboards(client);
    },
    'meeting-notifications': async () => {
      await processMeetingNotifications();
    },
    'channel-health-analysis': async () => {
      logger.debug('Cron', 'Analyse de santé des salons...');
      const { runChannelHealthAnalysis } = await import('../services/analytics/channelHealthService.js');
      await runChannelHealthAnalysis(client);
    },
    'pulse-snapshot': async () => {
      logger.debug('Cron', 'Calcul du Pulse pour tous les serveurs...');
      const { runPulseForAllGuilds } = await import('../services/analytics/pulseService.js');
      await runPulseForAllGuilds(client);
    },
    'season-check': async () => {
      logger.debug('Cron', 'Vérification des saisons de leveling...');
      const { checkAndProgressSeasons } = await import('../services/progression/seasonService.js');
      await checkAndProgressSeasons(client);
    },
    'clan-season-check': async () => {
      logger.debug('Cron', 'Vérification des saisons de clans...');
      const { checkAndProgressClanSeasons } = await import('../services/community/clanService.js');
      await checkAndProgressClanSeasons(client);
    },
    'marketplace-expiration': async () => {
      logger.debug('Cron', 'Traitement des annonces marketplace expirées...');
      const { processExpiredListings } = await import('../services/economy/marketplaceService.js');
      await processExpiredListings();
    },
    'quest-expiration': async () => {
      logger.debug('Cron', 'Expiration des quêtes anciennes...');
      const { expireOldProgress } = await import('../services/community/questService.js');
      await expireOldProgress();
    },
    'widget-refresh': async () => {
      logger.debug('Cron', 'Rafraîchissement des widgets staff...');
      const { refreshAllStaffWidgets } = await import('../services/integrations/widgetService.js');
      const guilds = await prisma.widgetSubscription.findMany({
        where: { enabled: true },
        select: { guildId: true },
        distinct: ['guildId'],
      });
      for (const { guildId } of guilds) {
        await refreshAllStaffWidgets(guildId);
      }
    },
    'dc-scan': async () => {
      const featureConfigs = await prisma.dashboardFeatureConfig.findMany({
        where: { featureKey: 'double_accounts', enabled: true },
        select: { guildId: true, metadata: true }
      });

      const limit = pLimit(5);
      const tasks = featureConfigs.map((cfg) => limit(async () => {
        try {
          const meta = cfg.metadata as unknown;
          const autoEnabled = meta?.workflowDraft?.autoDetectionEnabled ?? meta?.autoDetectionEnabled ?? false;
          if (!autoEnabled) return;

          const guild = await client.guilds.fetch(cfg.guildId).catch(() => null);
          if (!guild) return;

          const res = await scanGuildMembersForYoungAccounts(guild, JOIN_TO_ACCOUNT_CREATION_PROXIMITY_MS).catch((e) => {
            logger.error('Cron', `Erreur pendant dc-scan pour guild ${cfg.guildId}:`, e);
            return null;
          });

          if (res && res.flaggedCount > 0) {
            logger.info('Cron', `dc-scan: ${res.flaggedCount} détection(s) sur la guilde ${cfg.guildId}`);
          }
        } catch (e) {
          logger.error('Cron', 'Erreur dc-scan boucle:', e);
        }
      }));

      await Promise.all(tasks);
    },
    'stats-ping': async () => {
      logger.debug('Cron', 'Vérification du stats ping...');
      const { pingMasterServer } = await import('../services/system/statsService.js');
      await pingMasterServer(client);
    },
  });

  logger.info('Cron', "Handlers de jobs de fond enregistrés, début de l'enregistrement des cron schedules...");


  // 📊 Daily Algo: Toutes les minutes (vérification de l'heure configurée)
  cron.schedule('* * * * *', async () => {
    await runCronJob('daily-algo', async () => {
      await runDailyAlgoForAllGuilds(client);
    }, 3000);
  });

  // 📊 Daily Algo: Bilan à 23:59 UTC
  cron.schedule('59 23 * * *', async () => {
    await runCronJob('daily-algo-summary', async () => {
      await runDailyAlgoSummariesForAllGuilds(client);
    }, 2000);
  }, { timezone: 'UTC' });

  // 🛡️ Sanctions: Toutes les minutes (expiration des mutes/bans)
  cron.schedule('* * * * *', async () => {
    await runCronJob('sanctions', async () => {
      await processScheduledSanctions(client);
    }, 1000);
  });

  // 🎯 Événements planifiés: Toutes les minutes (CTF & Quiz planifiés)
  cron.schedule('* * * * *', async () => {
    await runCronJob('scheduled-events', async () => {
      const { checkScheduledEvents } = await import('../services/features/eventService.js');
      await checkScheduledEvents(client);
    }, 1000);
  });

  // 📊 Activity & Heatmap: Toutes les 10 minutes (Snapshot présences lissé)
  // Offloaded to BullMQ worker to avoid blocking the main event loop
  cron.schedule('*/10 * * * *', async () => {
    await runCronJob('activity-10min-snapshot', async () => {
      await runActivitySnapshot(client);
    }, 2000);
  });

  // 🛡️ Staff Management: Expirations à minuit
  cron.schedule('0 0 * * *', async () => {
    await runCronJob('staff-warnings-expiration', expireStaffWarnings, 1000);
  });

  cron.schedule('0 1 * * *', async () => {
    await runCronJob('staff-blacklist-expiration', expireStaffBlacklist, 1000);
  });

  // 🗂️ Journalisation des messages: purge selon la rétention (tous les jours à 03:30)
  cron.schedule('30 3 * * *', async () => {
    await runCronJob('message-logs-prune', pruneOldMessageLogs, 2000);
  });

  // 🛡️ Sanctions: Rapports manquants (tous les jours à 12:00, heure de Paris)
  cron.schedule('0 12 * * *', async () => {
    await runCronJob('missing-reports-check', async () => {
      await checkMissingReports();
    }, 2000);
  }, { timezone: 'Europe/Paris' });

  // 📅 Réunions: Notifications (toutes les 2 minutes — suffisant pour les rappels)
  cron.schedule('*/2 * * * *', async () => {
    await runCronJob('meeting-notifications', async () => {
      await processMeetingNotifications();
    }, 3000);
  });

  // ⏰ Rappels Staff: Toutes les minutes
  cron.schedule('* * * * *', async () => {
    await runCronJob('staff-reminders', async () => {
      const { processDueReminders } = await import('../services/staff/reminderService.js');
      await processDueReminders(client);
    }, 1000);
  });

  // 🔍 DC Scan: Toutes les heures (vérifie les guildes qui ont activé l'auto-détection)
  cron.schedule('0 * * * *', async () => {
    await runCronJob('dc-scan', async () => {
      const featureConfigs = await prisma.dashboardFeatureConfig.findMany({
        where: { featureKey: 'double_accounts', enabled: true },
        select: { guildId: true, metadata: true }
      });

      const dcLimit = pLimit(5);
      await Promise.all(featureConfigs.map((cfg) => dcLimit(async () => {
        try {
          const meta = cfg.metadata as unknown;
          const autoEnabled = meta?.workflowDraft?.autoDetectionEnabled ?? meta?.autoDetectionEnabled ?? false;
          if (!autoEnabled) return;

          const guild = await client.guilds.fetch(cfg.guildId).catch(() => null);
          if (!guild) return;

          await scanGuildMembersForYoungAccounts(guild, JOIN_TO_ACCOUNT_CREATION_PROXIMITY_MS).catch((e) => {
            logger.error('Cron', `Erreur pendant dc-scan pour guild ${cfg.guildId}:`, e);
          });
        } catch (e) {
          logger.error('Cron', 'Erreur dc-scan cron:', e);
        }
      })));
    }, 5000);
  });

  // 📺 YouTube & Twitch checks: toutes les 5 minutes (en parallèle)
  cron.schedule('*/5 * * * *', async () => {
    await Promise.allSettled([
      runCronJob('youtube', async () => {
        await checkYoutubeFollows(client);
      }, 5000),
      runCronJob('twitch', async () => {
        await checkTwitchFollows(client);
      }, 5000),
    ]);
  });

  // 🎫 Ticket Inactivity Checks: toutes les 10 minutes
  cron.schedule('*/10 * * * *', async () => {
    await runCronJob('ticket-inactivity', async () => {
      await checkTicketInactivity(client);
    }, 2000);
  });

  // 🏆 Leaderboard Auto-Refresh: toutes les heures
  cron.schedule('5 * * * *', async () => {
    await runCronJob('leaderboard-refresh', async () => {
      await refreshAllAutoLeaderboards(client);
    }, 5000);
  });

  // 📊 Channel Health Analysis: tous les jours à 4h du matin
  cron.schedule('0 4 * * *', async () => {
    await runCronJob('channel-health-analysis', async () => {
      const { runChannelHealthAnalysis } = await import('../services/analytics/channelHealthService.js');
      await runChannelHealthAnalysis(client);
    }, 5000);
  }, { timezone: 'Europe/Paris' });

  // 💓 Pulse: Snapshot quotidien à 3h du matin
  cron.schedule('0 3 * * *', async () => {
    await runCronJob('pulse-snapshot', async () => {
      const { runPulseForAllGuilds } = await import('../services/analytics/pulseService.js');
      await runPulseForAllGuilds(client);
    }, 5000);
  }, { timezone: 'Europe/Paris' });

  // 🏆 Leveling Seasons: Vérification quotidienne à 0h05
  cron.schedule('5 0 * * *', async () => {
    await runCronJob('season-check', async () => {
      const { checkAndProgressSeasons } = await import('../services/progression/seasonService.js');
      await checkAndProgressSeasons(client);
    }, 3000);
  }, { timezone: 'Europe/Paris' });

  // 🛡️ Clan Seasons: Vérification toutes les 15 minutes
  cron.schedule('*/15 * * * *', async () => {
    await runCronJob('clan-season-check', async () => {
      const { checkAndProgressClanSeasons } = await import('../services/community/clanService.js');
      await checkAndProgressClanSeasons(client);
    }, 3000);
  });

  // 🏪 Marketplace: Expiration des annonces toutes les 10 minutes
  cron.schedule('*/10 * * * *', async () => {
    await runCronJob('marketplace-expiration', async () => {
      const { processExpiredListings } = await import('../services/economy/marketplaceService.js');
      await processExpiredListings();
    }, 2000);
  });

  // 📋 Quests: Expiration des quêtes quotidiennes à minuit
  cron.schedule('0 0 * * *', async () => {
    await runCronJob('quest-expiration', async () => {
      const { expireOldProgress } = await import('../services/community/questService.js');
      await expireOldProgress();
    }, 2000);
  }, { timezone: 'Europe/Paris' });

  // 🎨 Widget: Refresh des widgets staff toutes les 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    await runCronJob('widget-refresh', async () => {
      const { refreshAllStaffWidgets } = await import('../services/integrations/widgetService.js');
      const guilds = await prisma.widgetSubscription.findMany({
        where: { enabled: true },
        select: { guildId: true },
        distinct: ['guildId'],
      });
      for (const { guildId } of guilds) {
        await refreshAllStaffWidgets(guildId);
      }
    }, 5000);
  });

  // 📊 Stats: Ping all instances every 6 hours
  cron.schedule('0 */6 * * *', async () => {
    await runCronJob('stats-ping', async () => {
      const { pingMasterServer } = await import('../services/system/statsService.js');
      await pingMasterServer(client);
    }, 5000);
  });

  // Trigger a stats ping shortly after startup (10 seconds) to refresh stats
  setTimeout(() => {
    logger.info('Cron', 'Triggering startup stats ping...');
    import('../services/system/statsService.js')
      .then(({ pingMasterServer }) => pingMasterServer(client))
      .catch((err) => logger.error('Cron', 'Failed to run startup stats ping:', err));
  }, 10_000);

  logger.success('Cron', "Tous les jobs cron sont enregistrés (Suivi d'activité minute activé)");
}
