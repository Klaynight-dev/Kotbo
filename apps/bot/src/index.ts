import type { Prisma } from '@prisma/client';
import { trackGhostSignal } from './services/analytics/ghostActivityTracker.js';
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '../../.env') });

import './utils/patchV2.js';

import {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  Events,
  ActivityType,
  ApplicationCommandType,
  MessageFlags,
  DiscordAPIError,
  type ChatInputCommandInteraction,
  type Guild,
  type Interaction,
} from 'discord.js';
import { logger } from './utils/logger.js';
import { parseInstanceIdFromArgs, setCurrentInstance, getCurrentInstance, isWhiteLabelInstance } from './utils/instanceContext.js';
import { loadAllInstances, getInstanceById, getDefaultInstance } from './utils/instanceResolver.js';
import { queueAuditLog } from './utils/auditLogger.js';
import { replyOrFollowUp } from './utils/interactionResponses.js';
import { registerCrons } from './events/crons.js';
import {
  handleButton,
  handleSelectMenu,
  handleModalSubmit,
} from './handlers/interactionHandler.js';
import prisma from './utils/db.js';
import { trackAcquisitionStep } from './services/analytics/acquisitionService.js';
import { successEmbed } from './utils/embeds.js';
import { loadApplicationEmojis } from './utils/emojis.js';
import { getCachedDashboardSettings, cache } from './utils/cache.js';
import {
  evaluateCommandRestriction,
  isPrivilegedCommandExecutor,
  normalizeCommandRestrictions,
} from './utils/commandAccess.js';
import { registerCodePoliceListener } from './events/codePolice.js';
import { registerAdvancedLogsListener } from './events/advancedLogs.js';
import { registerCloseSourceWarningListener } from './events/closeSourceWarning.js';
import { registerNicknameModerationListener } from './events/nicknameModeration.js';
import { registerTempVoiceListener } from './events/tempVoice.js';
import { registerHoneypotListener } from './events/honeypot.js';
import { registerMessageLoggingListener } from './events/messageLogging.js';
import { registerAuditEventsListener } from './events/auditEvents.js';
import { registerAnalyticsTrackers } from './events/analyticsTrackers.js';
import { registerStatsChannelListener } from './events/stats.js';
import { registerFunEventsListener } from './events/funEvents.js';
import { registerGiveawayEventsListener } from './events/giveawayEvents.js';
import { registerDailyAlgoHandlers } from './handlers/dailyAlgoHandler.js';
import { registerMeetingEvents } from './events/meetingEvents.js';
import { syncOngoingDailyAlgoButtons } from './services/progression/dailyAlgoService.js';
import { checkTranslationProviderHealth } from './services/integrations/translationService.js';
import { startDashboardApi } from './api/dashboardApi.js';
import { broadcastDashboardEventAcrossShards } from './api/shared/sharding.js';
import { initBotSentry, captureException } from './observability/sentry.js';
import { initRedis, assertRedisConnection } from './infra/redis.js';
import { startBackgroundQueueWorker } from './infra/queues/backgroundQueue.js';
import botPackageJson from '../package.json';
import { registerLevelingListener } from './events/levelingEvents.js';
import { registerSecurityVerificationListener } from './events/securityVerificationEvents.js';
import { registerAutoResponseListener } from './events/autoResponseEvents.js';
import { registerChannelLinkListener } from './events/channelLinkEvents.js';
import { registerStarboardListener } from './events/starboardEvents.js';
import { registerStaffServerListener } from './events/staffServerEvents.js';
import { registerAbsenceMentionListener } from './events/absenceMentionEvents.js';
import { registerPartnershipListener } from './services/features/partnershipService.js';
import { registerRaidProtectionListener } from './events/raidProtection.js';
import { registerServerTagRoleListener } from './events/serverTagRole.js';
import { registerClanListener } from './events/clanEvents.js';
import { registerEventBusBridge } from './events/eventBusBridge.js';
import { registerAnalyticsBusSubscribers } from './modules/analytics.module.js';
import { registerWorkflowBusSubscribers } from './modules/workflow.module.js';
import { registerLevelingBusSubscribers } from './modules/leveling.module.js';
import { registerRankedBusSubscribers } from './modules/ranked.module.js';
import { registerAutoModBusSubscribers } from './modules/autoMod.module.js';
import { registerAdminLockModule } from './modules/adminLock.module.js';
import { registerAutoThreadBusSubscribers } from './modules/autoThread.module.js';
import { registerStickyMessageBusSubscribers } from './modules/stickyMessage.module.js';
import { registerWelcomeGoodbyeBusSubscribers } from './modules/welcomeGoodbye.module.js';
import { registerModerationBusSubscribers } from './modules/moderation.module.js';
import { registerTicketsBusSubscribers } from './modules/tickets.module.js';
import { loadActivatedGuilds, isGuildActivated, activateGuildSelfServe } from './utils/activation.js';
import {
  dispatchLinkGuestEvent,
  isLinkGuestGuild,
  loadLinkGuestGuilds,
} from './services/features/channelLinkGuestService.js';
import { resolveEventGuildId } from './utils/eventGuild.js';
import { initializeAutoBackupForAllGuilds, initializeAutoBackup, stopAutoBackup } from './services/system/autoBackupService.js';
import {
  commands as slashCommandDefinitions,
  contextCommands as contextCommandDefinitions,
  getCommandModuleKey,
  type ContextCommandDefinition,
  type SlashCommandDefinition,
} from './commands.js';
import { getModuleDefinition, getModuleForCustomId } from '@kotbo/contracts';
import { isModuleEnabled } from './services/core/moduleGate.js';
import { scopeClientToModule } from './services/core/moduleScope.js';
import { reconcileGuildCommands } from './services/core/commandDeployment.js';

initBotSentry();

// Resolve white-label instance from launcher args
const instanceId = parseInstanceIdFromArgs();
let resolvedInstance;

if (instanceId === '__default__') {
  resolvedInstance = getDefaultInstance();
  // Load white-label instances in the background to populate CORS origins and config cache
  loadAllInstances().catch((err) => {
    logger.warn('WhiteLabel', 'Failed to load white-label instances in background:', err);
  });
} else {
  await loadAllInstances();
  resolvedInstance = getInstanceById(instanceId);
}

if (!resolvedInstance) {
  logger.error('Bot', `Instance white-label introuvable: ${instanceId}`);
  process.exit(1);
}
setCurrentInstance(resolvedInstance);
if (!resolvedInstance.isDefault) {
  logger.info('WhiteLabel', `Worker démarré pour l'instance "${resolvedInstance.name}" (${resolvedInstance.slug})`);
}

import { setClient } from './utils/client.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildInvites,
  ],
  partials: [Partials.Message, Partials.Reaction],
});

setClient(client);

// ==========================================================
// Guild Activation Central Event Interceptor Gate
// ==========================================================
const PASSTHROUGH_EVENTS = new Set<string | symbol>([
  Events.ClientReady,
  Events.ShardReady,
  Events.GuildCreate,
  Events.GuildDelete,
  // discord.js consomme lui-même cet événement pour résoudre
  // `guild.members.fetch()` : le filtrer ferait expirer les récupérations de
  // membres au lieu de bloquer un traitement métier.
  Events.GuildMembersChunk,
]);
const OWNER_ID = process.env.DISCORD_CLIENT_OWNER_ID;

// `/activate` doit franchir la garde, sinon un serveur non activé n'aurait aucun
// moyen de s'activer. `/link` pour la même raison : un serveur invité en mode
// liaison seule n'a pas de code et doit pouvoir accepter (puis gérer, puis
// rompre) le pont qui le relie au serveur activé. La commande applique
// elle-même ses propres restrictions dans ce cas.
const GATE_EXEMPT_COMMANDS = new Set(['activate', 'link']);

const originalEmit = client.emit;
client.emit = function (eventName: string | symbol, ...args: unknown[]) {
  if (PASSTHROUGH_EVENTS.has(eventName)) {
    return originalEmit.call(client, eventName, ...args);
  }

  // Les evenements Discord transportent des objets heterogenes : la resolution
  // balaye tous les arguments, la guilde n'etant pas toujours portee par le
  // premier (`GuildAuditLogEntryCreate` emet `(entry, guild)`).
  type InteractionBearing = {
    // Presents sur les interactions uniquement.
    commandName?: unknown;
    user?: { id?: unknown } | null;
    author?: { id?: unknown } | null;
  };

  const arg = args[0] as InteractionBearing | null | undefined;
  if (!arg || typeof arg !== 'object') {
    return originalEmit.call(client, eventName, ...args);
  }

  let isExemptCommand = false;
  let isOwnerInteraction = false;

  const guildId = resolveEventGuildId(args);

  if (guildId) {
    // On se contente de `commandName`, porté par les seules interactions de
    // commande : dépendre d'une méthode de discord.js avait fait échouer cette
    // exception en silence, `isChatInput` (nom v13) n'existant plus en v14 sous
    // ce nom. La garde renvoyant `false` sans rien journaliser, la commande
    // restait muette sans le moindre indice.
    if (
      eventName === Events.InteractionCreate &&
      typeof arg.commandName === 'string' &&
      GATE_EXEMPT_COMMANDS.has(arg.commandName)
    ) {
      isExemptCommand = true;
    }

    if (OWNER_ID) {
      const userId = arg.user?.id ?? arg.author?.id;
      if (userId === OWNER_ID) isOwnerInteraction = true;
    }
  }

  // Intercept and block unactivated guilds silently
  if (guildId && !isExemptCommand && !isOwnerInteraction) {
    if (!isGuildActivated(guildId)) {
      // Mode « liaison seule » : un serveur relié à un serveur activé n'a pas de
      // code à lui, et n'obtient pas pour autant l'accès au bot. Ses événements
      // ne rejoignent jamais le flux général ; seuls ceux dont le pont a besoin
      // sont repoussés sur un bus privé auquel seul le relais est abonné.
      // Aucun module de collecte ne peut donc les voir.
      if (isLinkGuestGuild(guildId)) {
        dispatchLinkGuestEvent(eventName, args);
      }
      return false;
    }
  }

  return originalEmit.call(client, eventName, ...args);
};

if (!client.shard || client.shard.ids.includes(0)) {
  await startDashboardApi(client);
}

const slashCommands = new Collection<string, SlashCommandDefinition>();
slashCommandDefinitions.forEach((cmd) => {
  slashCommands.set(cmd.data.name, cmd);
});

// Discord autorise un menu User et un menu Message à porter le même nom : les
// deux types doivent donc être indexés séparément, sinon l'un écrase l'autre.
const userContextCommands = new Collection<string, ContextCommandDefinition>();
const messageContextCommands = new Collection<string, ContextCommandDefinition>();
contextCommandDefinitions.forEach((cmd) => {
  const { type } = cmd.data.toJSON() as { type?: number };
  if (type === ApplicationCommandType.Message) messageContextCommands.set(cmd.data.name, cmd);
  else userContextCommands.set(cmd.data.name, cmd);
});

async function enforceCommandAccess(interaction: ChatInputCommandInteraction): Promise<boolean> {
  if (!interaction.guildId) return true;

  const settings = await getCachedDashboardSettings(interaction.guildId);

  const commandRestrictions = normalizeCommandRestrictions(settings?.commandRestrictions);
  if (commandRestrictions.length === 0) return true;

  const isPrivileged = isPrivilegedCommandExecutor(interaction);
  let roleIds: string[] = [];
  if (!isPrivileged) {
    if (interaction.member) {
      if (Array.isArray(interaction.member.roles)) {
        roleIds = interaction.member.roles;
      } else if (interaction.member.roles && 'cache' in interaction.member.roles) {
        roleIds = interaction.member.roles.cache.map((role) => role.id);
      }
    }
    if (roleIds.length === 0) {
      roleIds = (await interaction.guild?.members.fetch(interaction.user.id).catch(() => null))?.roles.cache.map((role) => role.id) ?? [];
    }
  }

  const decision = evaluateCommandRestriction(
    commandRestrictions,
    interaction.commandName,
    interaction.channelId,
    roleIds,
    interaction.user.id,
    isPrivileged,
  );

  if (decision.allowed) return true;

  await interaction.reply({
    content: `❌ ${decision.reason ?? 'Cette commande est bloquée par la configuration du serveur.'}`,
    flags: [MessageFlags.Ephemeral],
  });

  return false;
}

/**
 * Refuse les interactions qui appartiennent à un module éteint.
 *
 * Un point de passage unique plutôt qu'une garde par commande : c'est le seul
 * moyen d'être certain qu'aucun bouton ni modal ne franchisse la barrière parce
 * qu'on aurait oublié de l'y soumettre. Le module est déduit du nom de la
 * commande pour les commandes, du préfixe de `customId` pour les composants.
 *
 * Répond en éphémère plutôt que de rester muet : un membre qui tape une
 * commande attend un retour, et un silence se lit comme une panne du bot.
 */
async function enforceModuleGate(interaction: Interaction): Promise<boolean> {
  if (!interaction.guildId) return true;

  let moduleKey: string | undefined;
  if (interaction.isChatInputCommand() || interaction.isContextMenuCommand() || interaction.isAutocomplete()) {
    moduleKey = getCommandModuleKey(interaction.commandName);
  } else if ('customId' in interaction && typeof interaction.customId === 'string') {
    moduleKey = getModuleForCustomId(interaction.customId);
  }

  if (!moduleKey) return true;
  if (await isModuleEnabled(interaction.guildId, moduleKey)) return true;

  // L'autocomplétion n'accepte pas de message : on renvoie une liste vide, ce
  // que Discord affiche comme « aucune option ».
  if (interaction.isAutocomplete()) {
    await interaction.respond([]).catch(() => null);
    return false;
  }

  const moduleName = getModuleDefinition(moduleKey)?.name ?? moduleKey;
  if (interaction.isRepliable()) {
    await replyOrFollowUp(interaction, {
      content: `🚫 Le module **${moduleName}** est désactivé sur ce serveur.\nUn administrateur peut le réactiver depuis le dashboard, page **Modules**.`,
      flags: [MessageFlags.Ephemeral],
    }).catch(() => null);
  }

  return false;
}


client.once(Events.ClientReady, async (c) => {
  logger.success('Bot', `Connecté en tant que ${c.user.tag}`);
  const activityPrefix = isWhiteLabelInstance() ? `${getCurrentInstance().brandName} | ` : '';
  c.user.setActivity(`${activityPrefix}/help | v${botPackageJson.version}`, { type: ActivityType.Playing });

  // Load application emojis before anything else
  await loadApplicationEmojis(client);

  // Load activated guilds into cache at startup
  await loadActivatedGuilds().catch((error) =>
    logger.error('Activation', 'Impossible de charger les serveurs activés :', error)
  );

  // Dépend du cache d'activation ci-dessus : un serveur n'est « invité » que si
  // l'autre extrémité de son lien est activée.
  await loadLinkGuestGuilds();

  await initRedis();
  await assertRedisConnection().catch((err) => {
    logger.warn('Redis', String(err));
  });

  // Enable distributed Event Bus if configured (Phase 2: multi-process split)
  if (process.env.EVENTBUS_DISTRIBUTED === 'true') {
    try {
      const { createRedisForWorker } = await import('./infra/redis.js');
      const { kotboEventBus } = await import('@kotbo/core');
      const pub = createRedisForWorker();
      const sub = createRedisForWorker();
      if (pub && sub) {
        await pub.connect();
        await sub.connect();
        kotboEventBus.enableDistributed(pub, sub);
        logger.success('EventBus', 'Mode distribué (Redis Pub/Sub) activé.');
      }
    } catch (err) {
      logger.warn('EventBus', 'Impossible d\'activer le mode distribué:', err);
    }
  }

  await checkTranslationProviderHealth();

  // Load global config & blacklist into memory
  try {
    const config = await prisma.botGlobalConfig.findUnique({ where: { key: 'MAINTENANCE_MODE' } });
    global.KOTBO_MAINTENANCE_MODE = config?.value === 'true';

    const blacklist = await prisma.globalBlacklist.findMany({ select: { userId: true } });
    global.KOTBO_BLACKLIST = new Set(blacklist.map(b => b.userId));
  } catch (err) {
    logger.error('System', 'Erreur lors du chargement de la config globale', err);
    global.KOTBO_MAINTENANCE_MODE = false;
    global.KOTBO_BLACKLIST = new Set();
  }

  // ── Event Bus Bridge (Phase 1: in-process) ──────────────────
  // The bridge captures raw Discord events and publishes normalized
  // payloads on the Kotbo Event Bus. Modules can subscribe to bus
  // events instead of client.on() directly, enabling future split
  // into independent processes (Phase 2).
  registerEventBusBridge(client);

  // ── Bus-based modules (decoupled, error-isolated) ─────────
  // Les abonnés au bus filtrent eux-mêmes via `subscribeForModule`. Ceux qui
  // sont restés sur `client.on()` reçoivent la vue filtrée du client.
  registerAnalyticsBusSubscribers(client);
  registerWorkflowBusSubscribers(client);
  registerLevelingBusSubscribers(client);
  registerRankedBusSubscribers(client);
  registerAutoModBusSubscribers(scopeClientToModule(client, 'automod'));
  registerAdminLockModule(scopeClientToModule(client, 'automod'));
  registerAutoThreadBusSubscribers(client);
  registerStickyMessageBusSubscribers(client);
  registerWelcomeGoodbyeBusSubscribers(client);
  registerModerationBusSubscribers(scopeClientToModule(client, 'sanctions'));
  registerTicketsBusSubscribers(client);

  // ── Direct listeners (not yet migrated to the bus) ────────
  //
  // Chaque écouteur rattaché à un module reçoit une vue du client filtrée par
  // `scopeClientToModule` : ses abonnements ne se déclenchent que sur les
  // serveurs où le module est allumé. Les écouteurs sans module (avertissement
  // code source, rôle de tag serveur, partenariats) gardent le client brut.
  client.setMaxListeners(30);
  registerCodePoliceListener(scopeClientToModule(client, 'codepolice'));
  registerAdvancedLogsListener(scopeClientToModule(client, 'logs'));
  registerCloseSourceWarningListener(client);
  registerNicknameModerationListener(scopeClientToModule(client, 'nickname_moderation'));
  registerTempVoiceListener(scopeClientToModule(client, 'auto_thread'));
  registerStarboardListener(scopeClientToModule(client, 'starboard'));
  registerHoneypotListener(scopeClientToModule(client, 'automod'));
  registerMessageLoggingListener(scopeClientToModule(client, 'logs'));
  registerAuditEventsListener(scopeClientToModule(client, 'logs'));
  registerAnalyticsTrackers(scopeClientToModule(client, 'analytics'));
  registerStatsChannelListener(scopeClientToModule(client, 'analytics'));
  registerFunEventsListener(scopeClientToModule(client, 'fun'));
  registerGiveawayEventsListener(scopeClientToModule(client, 'giveaways'));
  registerDailyAlgoHandlers(scopeClientToModule(client, 'daily_algo'));
  registerMeetingEvents(scopeClientToModule(client, 'meetings'));
  registerLevelingListener(scopeClientToModule(client, 'leveling')); // XP vocale uniquement (boucle de polling)
  registerSecurityVerificationListener(scopeClientToModule(client, 'security_verification'));
  registerAutoResponseListener(scopeClientToModule(client, 'auto_responses'));
  registerChannelLinkListener(scopeClientToModule(client, 'channel_links'));
  registerStaffServerListener(scopeClientToModule(client, 'staff_server'));
  registerAbsenceMentionListener(scopeClientToModule(client, 'absences'));
  registerPartnershipListener(client);
  registerRaidProtectionListener(scopeClientToModule(client, 'raid_protection'));
  registerServerTagRoleListener(client);
  registerClanListener(scopeClientToModule(client, 'clans'));

  // Un arrêt en plein tour de captcha vocal laisse des autorisations
  // individuelles sur le salon, qui l'ouvriraient pendant le tour d'un autre.
  void import('./services/moderation/voiceCaptchaService.js')
    .then(({ sweepStaleOverwrites }) => sweepStaleOverwrites(client))
    .catch((error) => logger.error('System', 'Nettoyage du captcha vocal impossible', error));

  // Les commandes sont publiées par serveur, en fonction des modules allumés.
  // Cette réconciliation rattrape ce qui a changé pendant que le bot était
  // arrêté : un module basculé depuis un autre shard, un serveur désactivé, une
  // republication tombée en échec. Chaque shard ne voit que ses propres
  // serveurs, le travail se répartit donc tout seul ; une empreinte évite de
  // republier les serveurs inchangés.
  void reconcileGuildCommands(
    client,
    c.guilds.cache.map((guild) => guild.id),
    isGuildActivated,
  ).catch((error) => logger.error('Commandes', 'Réconciliation impossible :', error));

  // Enregistrer les cron jobs AVANT les opérations potentiellement bloquantes
  logger.info('System', 'Enregistrement des cron jobs...');
  await registerCrons(client);
  logger.info('System', 'Cron jobs enregistrés');

  // Les jobs conservés dans Redis peuvent être repris dès la création du
  // worker. Tous leurs handlers doivent donc être enregistrés auparavant.
  await startBackgroundQueueWorker();
  
  logger.info('System', 'Début de la synchronisation des boutons DailyAlgo...');
  await syncOngoingDailyAlgoButtons(client).catch((error) =>
    logger.error('DailyAlgo', 'Impossible de synchroniser les boutons des runs en cours:', error),
  );
  logger.info('System', 'Synchronisation DailyAlgo terminée, initialisation des backups automatiques...');
  await initializeAutoBackupForAllGuilds(c.guilds.cache.values()).catch((error) =>
    logger.error('AutoBackup', "Impossible d'initialiser les backups automatiques:", error)
  );
  logger.info('System', 'Backups automatiques initialisés');

  // Reprendre les synchronisations d'activation de manière séquentielle. Membres
  // et historique partagent statsConfig et ne doivent donc jamais tourner ensemble.
  try {
    const { scheduleGuildDataSync } = await import('./services/analytics/guildDataSyncService.js');
    const activatedGuildsForSync = await prisma.guild.findMany({
      where: { activated: true },
      select: { id: true, statsConfig: true }
    });

    interface StartupSyncConfig {
      historicalScrapeStatus?: string;
      historicalScrapeError?: string;
      memberScrapeStatus?: string;
      memberScrapeError?: string;
      fullSyncStatus?: string;
      fullSyncError?: string;
    }

    for (const g of activatedGuildsForSync) {
      const config = { ...((g.statsConfig as StartupSyncConfig | null) || {}) } as StartupSyncConfig;
      let configChanged = false;

      if (config.historicalScrapeStatus === 'IN_PROGRESS') {
        config.historicalScrapeStatus = 'FAILED';
        config.historicalScrapeError = 'Interrompu par le redémarrage du bot';
        configChanged = true;
      }
      if (config.memberScrapeStatus === 'IN_PROGRESS') {
        config.memberScrapeStatus = 'FAILED';
        config.memberScrapeError = 'Interrompu par le redémarrage du bot';
        configChanged = true;
      }
      if (config.fullSyncStatus === 'IN_PROGRESS') {
        config.fullSyncStatus = 'FAILED';
        config.fullSyncError = 'Interrompu par le redémarrage du bot';
        configChanged = true;
      }
      if (configChanged) {
        await prisma.guild.update({
          where: { id: g.id },
          data: { statsConfig: config as unknown as Prisma.InputJsonValue }
        });
      }

      const membersNeedSync = !config.memberScrapeStatus
        || config.memberScrapeStatus === 'NOT_STARTED'
        || config.memberScrapeStatus === 'FAILED';
      const historyNeedsSync = !config.historicalScrapeStatus
        || config.historicalScrapeStatus === 'NOT_STARTED'
        || config.historicalScrapeStatus === 'FAILED';

      if (membersNeedSync || historyNeedsSync) {
        logger.info('System', `Reprise de la synchronisation d'activation pour la guilde ${g.id}`);
        scheduleGuildDataSync(client, g.id);
      }
    }
  } catch (err) {
    logger.error('System', "Erreur lors de la reprise des synchronisations d'activation:", err);
  }

  logger.success('System', 'Bot opérationnel et synchronisé.');
});

client.on(Events.GuildCreate, async (guild) => {
  logger.info('System', `Le bot a rejoint le serveur : ${guild.name} (${guild.id})`);

  // Entree du tunnel cote serveur. `void` volontaire : l'arrivee ne doit pas
  // attendre une ecriture de statistiques, et le service n'echoue jamais.
  void recordBotArrival(guild);

  // « Mes serveurs » attendait cette arrivee en redemandant la liste toutes les
  // trois secondes, pendant deux minutes, apres quoi elle abandonnait : une
  // autorisation un peu lente laissait la personne devant un serveur toujours
  // annonce comme depourvu du bot. L'annoncer coute un message.
  void announceBotGuildChange(guild.id, 'joined');

  // Initialize auto backup if the guild is activated
  await initializeAutoBackup(guild).catch((err) =>
    logger.error('AutoBackup', `Impossible d'initialiser les backups pour le serveur ${guild.name}:`, err)
  );

  // Le serveur entre seul : reclamer un code a quelqu'un qui vient d'inviter
  // le bot arretait net tout parcours en libre-service. L'entree ne donne
  // acces a rien - l'offre `FREE` ne comprend aucun module - elle ouvre
  // seulement le dashboard et la mise en place. Ce qui se vend reste ferme.
  const justActivated = await activateGuildSelfServe(guild.id).catch((err) => {
    logger.error('Activation', `Activation libre-service impossible pour ${guild.id}:`, err);
    return false;
  });

  if (isGuildActivated(guild.id)) {
    const { scheduleGuildDataSync } = await import('./services/analytics/guildDataSyncService.js');
    scheduleGuildDataSync(client, guild.id);
  }

  // Seulement a la premiere arrivee : un serveur deja active qui reapparait
  // apres un redemarrage n'a pas a etre accueilli une seconde fois.
  if (justActivated) {
    const channel = guild.systemChannel || guild.channels.cache.find(
      (c) => c.isTextBased() && c.permissionsFor(guild.members.me!)?.has('SendMessages')
    );

    if (channel && channel.isTextBased()) {
      const embed = successEmbed(
        'Kotbo est en place',
        `Merci d'avoir invité **Kotbo** sur **${guild.name}** !

`
        + `👉 **La suite se passe sur le tableau de bord.**
`
        + `Il regarde si votre serveur est neuf ou déjà installé, puis vous guide : salons, rôles, modération, accueil. Quelques minutes suffisent.

`
        + `*Configurer ne coûte rien.* Les modules se mettent en place tout de suite et s'allument le jour où vous choisissez une offre - il n'y a rien à refaire.

`
        + `🔗 **Vous ne vouliez qu'un pont entre deux communautés ?**
`
        + `Demandez une invitation de liaison à l'autre serveur, puis lancez ici \`/link accept code:<code>\`. Le bot passera en **mode liaison seule** : il ne fera que faire circuler les messages du salon relié, sans activer le moindre autre module et sans enregistrer aucune donnée d'activité. \`/link status\` détaille à tout moment ce qui est actif.`
      );
      await channel.send({ embeds: [embed] }).catch(() => null);
    }
  }
});

client.on(Events.GuildDelete, (guild) => {
  logger.info('System', `Le bot a quitté le serveur : ${guild.name} (${guild.id})`);
  stopAutoBackup(guild.id);
  void announceBotGuildChange(guild.id, 'left');

  // Jusqu'ici, un depart ne laissait que la ligne de journal ci-dessus : aucun
  // churn n'etait mesurable, et la seule question qui compte vraiment - qui
  // part, et quand - n'avait aucune reponse en base.
  trackAcquisitionStep({
    step: 'bot_removed',
    guildId: guild.id,
    metadata: { memberCount: guild.memberCount ?? null, name: guild.name },
  });
});

/**
 * Enregistre l'arrivee du bot, en distinguant une premiere fois d'un retour.
 *
 * La distinction n'est pas cosmetique : compter une reinstallation comme une
 * acquisition neuve gonflerait le haut du tunnel et ferait changer le serveur
 * de cohorte, ce qui deplacerait les courbes de retention sans que rien ne le
 * signale. `GuildLifecycle` sait deja si le serveur est connu.
 *
 * La provenance est relue depuis le serveur lui-meme quand elle a ete posee au
 * passage par le dashboard ; sinon l'arrivee reste sans provenance plutot que
 * de s'en inventer une.
 */
async function recordBotArrival(guild: Guild): Promise<void> {
  try {
    const known = await prisma.guildLifecycle.findUnique({
      where: { guildId: guild.id },
      select: { invitedAt: true, source: true },
    });

    const row = await prisma.guild.findUnique({
      where: { id: guild.id },
      select: { instanceId: true, language: true, timezone: true },
    });

    trackAcquisitionStep({
      step: known?.invitedAt ? 'bot_reinstalled' : 'bot_joined',
      guildId: guild.id,
      metadata: {
        memberCount: guild.memberCount ?? null,
        locale: row?.language ?? guild.preferredLocale ?? null,
        timezone: row?.timezone ?? null,
        instanceId: row?.instanceId ?? null,
      },
    });
  } catch (error) {
    logger.warn('Acquisition', `Arrivee sur ${guild.id} non enregistree: ${String(error)}`);
  }
}

/**
 * Prevenir les dashboards ouverts que la liste des serveurs equipes a change.
 *
 * Le message ne porte que l'identifiant : il part vers tous les onglets
 * connectes, y compris ceux de personnes etrangeres a ce serveur. Ce sont les
 * clients qui redemandent ensuite leur propre liste a l'API, laquelle la
 * restreint a ce qu'ils administrent reellement.
 */
async function announceBotGuildChange(guildId: string, change: 'joined' | 'left') {
  try {
    await broadcastDashboardEventAcrossShards(client, {
      type: 'bot_guilds_changed',
      guildId,
      change,
    });
  } catch (error) {
    // Une diffusion ratee ne fait perdre que l'instantaneite : les vues
    // concernees gardent un rafraichissement de secours.
    logger.warn('DashboardWS', `Diffusion de l'arrivee/depart du serveur ${guildId} impossible:`, error);
  }
}

client.on(Events.InteractionCreate, async (interaction) => {
  logger.info('Interactions', `Interaction reçue: ${interaction.type} - ${interaction.id}`);
  try {
    // 1. Vérification de la blacklist globale
    const blacklist: Set<string> = global.KOTBO_BLACKLIST || new Set();
    if (blacklist.has(interaction.user.id)) {
      if (interaction.isRepliable()) {
        await interaction.reply({
          content: "❌ Vous avez été banni globalement de l'utilisation de ce bot.",
          flags: [MessageFlags.Ephemeral]
        });
      }
      return;
    }

    // 2. Vérification du mode maintenance (sauf pour créateur et admins globaux)
    if (global.KOTBO_MAINTENANCE_MODE && interaction.user.id !== process.env.DISCORD_CLIENT_OWNER_ID) {
      // Allow global admins bypass
      const admin = await prisma.globalAdmin.findUnique({ where: { userId: interaction.user.id } });
      if (!admin) {
        if (interaction.isRepliable()) {
          await interaction.reply({
            content: '⚠️ **Mode Maintenance**\nKotbo est actuellement en cours de maintenance globale. Réessayez plus tard.',
            flags: [MessageFlags.Ephemeral]
          });
        }
        return;
      }
    }

    // 3. Ghost Analyzer : toute interaction prouve qu'un compte est habité,
    //    même si son porteur n'écrit jamais dans les salons.
    if (interaction.guildId && !interaction.user.bot) {
      trackGhostSignal(interaction.guildId, interaction.user.id, 'interaction');
    }

    // 4. Garde des modules : une fonctionnalité éteinte ne doit répondre à
    //    aucune de ses entrées, commande comme bouton.
    if (!(await enforceModuleGate(interaction))) {
      return;
    }

    if (interaction.isChatInputCommand()) {
      if (!(await enforceCommandAccess(interaction))) {
        return;
      }

      const cmd = slashCommands.get(interaction.commandName);
      if (!cmd) {
        await interaction.reply({
          content: "⚠️ Cette commande n'est pas encore disponible sur cette instance du bot. Redémarre le bot puis redéploie les commandes.",
          flags: [MessageFlags.Ephemeral],
        });
        return;
      }

      if (interaction.guildId) {
        const optionsString = interaction.options.data.map(opt => {
          if (opt.value !== undefined) {
            return `${opt.name}: ${opt.value}`;
          }
          if (opt.options) {
            return `${opt.name} (${opt.options.map(subOpt => `${subOpt.name}: ${subOpt.value}`).join(', ')})`;
          }
          return opt.name;
        }).join(' | ');

        queueAuditLog({
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          user: `${interaction.user.tag} (<@${interaction.user.id}>)`,
          action: `Commande /${interaction.commandName}`,
          context: interaction.guild?.name || 'Discord',
          module: 'Commandes',
          eventType: 'Discord',
          details: `Commande slash /${interaction.commandName} exécutée.${optionsString ? ` Arguments: ${optionsString}` : ''}`,
        });
      }

      await cmd.execute(interaction);
      if (interaction.guildId && (interaction.commandName === 'admin' || interaction.commandName === 'config' || interaction.commandName === 'setup')) {
        await cache.invalidateGuild(interaction.guildId);
      }

      // Track command usage for analytics (buffered)
      try {
        const usageKey = `${interaction.guildId || 'DM'}:${interaction.commandName}:${interaction.user.id}`;
        commandUsageBuffer.set(usageKey, (commandUsageBuffer.get(usageKey) || 0) + 1);
      } catch (e) {
        logger.error('Analytics', 'Erreur lors de la mise en buffer de commande', e);
      }
    }

    else if (interaction.isAutocomplete()) {
      const cmd = slashCommands.get(interaction.commandName);
      if (cmd?.autocomplete) await cmd.autocomplete(interaction);
    }

    else if (interaction.isUserContextMenuCommand()) {
      const cmd = userContextCommands.get(interaction.commandName);
      if (cmd) {
        if (interaction.guildId) {
          queueAuditLog({
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            user: `${interaction.user.tag} (<@${interaction.user.id}>)`,
            action: `Menu contextuel: ${interaction.commandName}`,
            context: interaction.guild?.name || 'Discord',
            module: 'Commandes',
            eventType: 'Discord',
            details: `Commande de menu contextuel "${interaction.commandName}" exécutée sur l'utilisateur <@${interaction.targetId}> (${interaction.targetId}).`,
          });
        }
        await (cmd.execute as any)(interaction);
      }
    }

    else if (interaction.isMessageContextMenuCommand()) {
      const cmd = messageContextCommands.get(interaction.commandName);
      if (cmd) {
        if (interaction.guildId) {
          queueAuditLog({
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            user: `${interaction.user.tag} (<@${interaction.user.id}>)`,
            action: `Menu contextuel: ${interaction.commandName}`,
            context: interaction.guild?.name || 'Discord',
            module: 'Commandes',
            eventType: 'Discord',
            details: `Commande de menu contextuel de message "${interaction.commandName}" exécutée sur le message ${interaction.targetId}.`,
          });
        }
        await (cmd.execute as any)(interaction);
      }
    }

    else if (interaction.isButton()) {
      await handleButton(interaction, client);
      if (interaction.guildId) await cache.invalidateGuild(interaction.guildId);
    }

    else if (interaction.isAnySelectMenu()) {
      await handleSelectMenu(interaction, client);
      if (interaction.guildId) await cache.invalidateGuild(interaction.guildId);
    }

    else if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction, client);
      if (interaction.guildId) await cache.invalidateGuild(interaction.guildId);
    }
  } catch (err) {
    captureException(err, 'interaction-create');

    if (err instanceof DiscordAPIError && err.code === 10062) {
      logger.warn('Event', 'InteractionCreate: DiscordAPIError 10062 (Unknown interaction) ignored.');
      return;
    }

    logger.error('Event', 'InteractionCreate error:', err);
    try {
      if (interaction.isRepliable() && !interaction.deferred && !interaction.replied) {
        await replyOrFollowUp(interaction, { content: '❌ Une erreur est survenue.', flags: [MessageFlags.Ephemeral] });
      } else {
        logger.warn('Event', "Interaction déjà acquittée au moment de la gestion d'erreur; aucun message supplémentaire envoyé.");
      }
    } catch (e){
      captureException(e, 'interaction-create-error-handler');

      if (e instanceof DiscordAPIError && e.code === 40060) {
        logger.warn('Event', 'InteractionCreate follow-up: DiscordAPIError 40060 (already acknowledged) ignored.');
        return;
      }
      if (e instanceof DiscordAPIError && e.code === 10062) {
        logger.warn('Event', 'InteractionCreate follow-up: DiscordAPIError 10062 ignored.');
        return;
      }
      logger.error('Event', 'InteractionCreate error:', e);
    }
  }
});

// ============================================================================
// IN-MEMORY BUFFERS FOR PERFORMANCE
// ============================================================================
const commandUsageBuffer = new Map<string, number>();
let errorLogBuffer: Array<{ message: string, stack: string | null, source: string }> = [];

async function flushIndexBuffers() {
  // Flush Command Usage
  const usageEntries = [...commandUsageBuffer.entries()];
  commandUsageBuffer.clear();
  
  if (usageEntries.length > 0) {
    try {
      const ops = usageEntries.map(([key, count]) => {
        const [guildId, commandName, userId] = key.split(':');
        return prisma.dashboardCommandUsage.upsert({
          where: { guildId_commandName_userId: { guildId, commandName, userId } },
          update: { count: { increment: count }, lastUsedAt: new Date() },
          create: { guildId, commandName, userId, count }
        });
      });
      await Promise.all(ops);
    } catch (e) {
      // Re-queue entries so they can be retried on next flush
      for (const [key, count] of usageEntries) {
        commandUsageBuffer.set(key, (commandUsageBuffer.get(key) || 0) + count);
      }
      logger.error('Analytics', 'Erreur lors du flush des command usages', e);
    }
  }

  // Flush Error Logs
  const errorsToInsert = [...errorLogBuffer];
  errorLogBuffer = [];
  if (errorsToInsert.length > 0) {
    try {
      await prisma.botErrorLog.createMany({
        data: errorsToInsert
      });
    } catch (e) {
      // Re-queue entries so they can be retried on next flush
      errorLogBuffer.unshift(...errorsToInsert);
      logger.error('System', 'Erreur lors du flush des bot error logs', e);
    }
  }
}

const FLUSH_INTERVAL_MS = Number.parseInt(process.env.FLUSH_INTERVAL_MS ?? '10000', 10) || 10000;
const flushInterval = setInterval(() => {
  void flushIndexBuffers();
}, FLUSH_INTERVAL_MS);

async function flushAndStop(exitCode = 0) {
  clearInterval(flushInterval);
  try {
    await flushIndexBuffers();
  } finally {
    process.exit(exitCode);
  }
}

process.on('SIGINT', () => {
  void flushAndStop(0);
});

process.on('SIGTERM', () => {
  void flushAndStop(0);
});

process.on('beforeExit', () => {
  clearInterval(flushInterval);
  void flushIndexBuffers();
});
// ============================================================================

const token = getCurrentInstance().discordToken;
if (!token) {
  logger.error('Bot', `DISCORD_TOKEN non défini pour l'instance "${getCurrentInstance().slug}" !`);
  process.exit(1);
}

// Global Error Logging for Dashboard (buffered)
function logErrorToDb(error: Error, source: string) {
  errorLogBuffer.push({
    message: error.message || 'Erreur inconnue',
    stack: error.stack?.substring(0, 4000) || null,
    source
  });
}

// Une exception isolée venant d'un écouteur Discord (souvent une requête qui
// échoue pour un seul serveur) ne justifie pas de tuer le shard : le faire
// coupait le bot sur tous les autres serveurs, et le redémarrage rejouait
// aussitôt la même erreur. On ne rend la main au superviseur que si les
// exceptions deviennent continues, signe d'un état réellement irrécupérable.
const UNCAUGHT_BURST_WINDOW_MS = 10_000;
const UNCAUGHT_BURST_THRESHOLD = 50;
let uncaughtWindowStart = 0;
let uncaughtWindowCount = 0;

process.on('uncaughtException', (error) => {
  logger.error('System', 'Uncaught Exception:', error);
  logErrorToDb(error, 'uncaughtException');

  const now = Date.now();
  if (now - uncaughtWindowStart > UNCAUGHT_BURST_WINDOW_MS) {
    uncaughtWindowStart = now;
    uncaughtWindowCount = 0;
  }
  uncaughtWindowCount++;

  if (uncaughtWindowCount >= UNCAUGHT_BURST_THRESHOLD) {
    logger.error('System', `${uncaughtWindowCount} exceptions non gérées en ${UNCAUGHT_BURST_WINDOW_MS / 1000}s : arrêt du processus.`);
    void flushAndStop(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('System', 'Unhandled Rejection at:', promise, 'reason:', reason);
  logErrorToDb(reason instanceof Error ? reason : new Error(String(reason)), 'unhandledRejection');
});

client.login(token).catch((error) => {
  logger.error('Bot', 'Échec critique lors de la connexion Discord (client.login) :', error);
  process.exit(1);
});
