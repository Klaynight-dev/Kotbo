import { type AutoModerationActionOptions, Message, PermissionFlagsBits, EmbedBuilder, Client, PartialMessage, User, Role, Collection, AuditLogEvent, AutoModerationRuleTriggerType, AutoModerationRuleEventType, AutoModerationActionType, AutoModerationRuleKeywordPresetType, GuildMember } from 'discord.js';
import type { AutoModConfig } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { registerWarnSanction, registerTimeoutSanction } from './sanctionService.js';
import { loadBannedWords, loadGlobalWords, loadCustomWords } from './bannedWordsService.js';
import { isReservedByNicknameModeration } from './nicknameModerationService.js';
import { mirrorModlogToStaffServer } from '../staff/staffServerService.js';
import { getUppercasePercentage } from './capsDetection.js';

// Cache for AutoMod configs: key is guildId, value is the config object
const autoModConfigsCache = new Map<string, AutoModConfig>();

// In-memory spam tracker: key is "guildId:userId", value is array of timestamps of messages sent
const userMessageTimestamps = new Map<string, number[]>();

/**
 * Invalide le cache de configuration AutoMod pour une guilde
 */
export function invalidateAutoModCache(guildId: string) {
  autoModConfigsCache.delete(guildId);
}

/**
 * Récupère ou initialise la configuration AutoMod d'une guilde
 */
export async function getOrCreateAutoModConfig(guildId: string): Promise<AutoModConfig> {
  let config: AutoModConfig | null | undefined = autoModConfigsCache.get(guildId);
  if (!config) {
    config = await prisma.autoModConfig.findUnique({
      where: { guildId },
    });

    if (!config) {
      config = await prisma.autoModConfig.create({
        data: {
          guildId,
          discordAutoModEnabled: true,
          spamEnabled: false,
          spamLimit: 5,
          spamIntervalSeconds: 5,
          spamAction: 'TIMEOUT',
          linksEnabled: false,
          linksAction: 'DELETE_AND_WARN',
          capsEnabled: false,
          capsThresholdPercent: 80,
          capsMinLength: 10,
          emojisEnabled: false,
          emojisLimit: 10,
          mentionsEnabled: false,
          mentionsLimit: 5,
          ghostPingEnabled: false,
          ghostPingAction: 'ALERT',
          antiEveryoneEnabled: false,
          antiEveryoneAction: 'DELETE_AND_WARN',
          customWordsEnabled: false,
          customWordsAction: 'BLOCK',
          customWords: [],
          customWordsAllowList: [],
          customWordsTimeoutSec: 60,
          profanityEnabled: false,
          profanityPresetProfanity: true,
          profanityPresetSexual: true,
          profanityPresetSlurs: true,
          profanityAction: 'BLOCK',
          profanityAllowList: [],
          profanityTimeoutSec: 60,
          inviteFilterEnabled: false,
          inviteFilterAction: 'BLOCK',
          inviteFilterAllowedGuilds: [],
          inviteFilterTimeoutSec: 60,
          antiBotEnabled: false,
          antiBotAction: 'KICK',
          antiBotBypassUsers: [],
        },
      });
    } else if (!config.discordAutoModEnabled) {
      config = await prisma.autoModConfig.update({
        where: { guildId },
        data: { discordAutoModEnabled: true },
      });
    }
    autoModConfigsCache.set(guildId, config);
  }
  return config;
}

function buildNativeActions(action: string, timeoutSec: number, logChannelId: string | null, blockMessage: string): AutoModerationActionOptions[] {
  const actions: AutoModerationActionOptions[] = [];

  if (action === 'BLOCK' || action === 'TIMEOUT') {
    actions.push({
      type: AutoModerationActionType.BlockMessage,
      metadata: { customMessage: blockMessage }
    });
  }

  if (action === 'TIMEOUT') {
    const duration = Math.max(5, Math.min(2419200, timeoutSec || 60));
    actions.push({
      type: AutoModerationActionType.Timeout,
      metadata: { durationSeconds: duration }
    });
  }

  if (logChannelId) {
    actions.push({
      type: AutoModerationActionType.SendAlertMessage,
      metadata: { channel: logChannelId }
    });
  }

  if (actions.length === 0) {
    if (logChannelId) {
      actions.push({
        type: AutoModerationActionType.SendAlertMessage,
        metadata: { channel: logChannelId }
      });
    } else {
      actions.push({
        type: AutoModerationActionType.BlockMessage,
        metadata: { customMessage: blockMessage }
      });
    }
  }

  return actions;
}

/**
 * Synchronise les configurations AutoMod avec les règles natives de Discord
 */
export async function syncDiscordAutoModRules(client: Client, guildId: string, config: AutoModConfig) {
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    throw new Error(`Serveur ${guildId} introuvable ou inaccessible par le bot.`);
  }

  const botMember = guild.members.me;
  if (botMember && !botMember.permissions.has(PermissionFlagsBits.ManageGuild)) {
    throw new Error(`Le bot n'a pas la permission « Gérer le serveur » sur ${guild.name}. Cette permission est nécessaire pour synchroniser les règles AutoMod.`);
  }

  const existingRules = await guild.autoModerationRules.fetch().catch((err) => {
    logger.warn('AutoModService', `Impossible de récupérer les règles AutoMod pour ${guild.name} (${guildId}) :`, err);
    throw new Error(`Impossible de récupérer les règles AutoMod existantes pour ${guild.name}.`);
  });

  try {

    // Récupérer le logChannelId de la guilde depuis la base de données
    const guildDb = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { logChannelId: true }
    });
    const rawLogChannelId = guildDb?.logChannelId || null;

    /**
     * Le salon d'alerte, s'il est utilisable.
     *
     * Discord refuse la regle entiere - 50035
     * INVALID_AUTO_MODERATION_CHANNEL_FLAG_ACTION_ACCESS - quand le bot n'a pas
     * « Voir le salon » et « Envoyer des messages » sur le salon d'alerte. Le
     * salon de logs pose par la mise en place est reserve au staff : sur un
     * serveur qui vient d'etre monte, aucune regle native ne se creait, et
     * l'AutoMod entier restait muet a cause d'une action accessoire.
     *
     * On retombe donc sur les seules actions qui bloquent. L'alerte revient
     * d'elle-meme a la prochaine synchronisation, le jour ou le salon s'ouvre.
     */
    const logChannelId = await (async () => {
      if (!rawLogChannelId) return null;

      const me = guild.members.me;
      if (!me) return null;

      const channel = guild.channels.cache.get(rawLogChannelId)
        ?? await guild.channels.fetch(rawLogChannelId).catch(() => null);
      if (!channel || !channel.isTextBased()) return null;

      const permissions = channel.permissionsFor(me);
      const usable = !!permissions?.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
      ]);

      if (!usable) {
        logger.warn(
          'AutoModService',
          `Salon d'alerte AutoMod ${rawLogChannelId} inaccessible au bot sur ${guild.name} (${guildId}) : `
          + `les regles natives sont creees sans action d'alerte.`,
        );
      }

      return usable ? rawLogChannelId : null;
    })();

    // Définir les rôles et salons exemptés (limités par Discord : max 20 rôles, max 50 salons)
    const exemptRoles = (config.bypassRoles || []).slice(0, 20);
    const exemptChannels = (config.bypassChannels || []).slice(0, 50);

    const ruleNames = {
      spam: 'Kotbo AutoMod - Spam',
      mentions: 'Kotbo AutoMod - Mentions',
      links: 'Kotbo AutoMod - Liens',
      customWords: 'Kotbo AutoMod - Mots personnalisés',
      profanity: 'Kotbo AutoMod - Profanités',
      invites: 'Kotbo AutoMod - Invitations',
    };

    const deleteRuleIfExists = async (ruleName: string) => {
      const existing = existingRules.find(r => r.name === ruleName);
      if (existing) {
        logger.info('AutoModService', `Suppression de la règle native Discord "${ruleName}" pour ${guild.name}`);
        await existing.delete('Configuration modifiée dans le dashboard').catch(e => {
          logger.error('AutoModService', `Erreur lors de la suppression de la règle "${ruleName}" :`, e);
        });
      }
    };

    if (!config.discordAutoModEnabled) {
      await deleteRuleIfExists(ruleNames.spam);
      await deleteRuleIfExists(ruleNames.mentions);
      await deleteRuleIfExists(ruleNames.links);
      await deleteRuleIfExists(ruleNames.customWords);
      await deleteRuleIfExists(ruleNames.profanity);
      await deleteRuleIfExists(ruleNames.invites);
      return;
    }

    // 1. Règle Anti-Spam
    if (config.spamEnabled) {
      const existingSpam = existingRules.find(r => r.name === ruleNames.spam);
      const actions: AutoModerationActionOptions[] = [
        {
          type: AutoModerationActionType.BlockMessage,
          metadata: {
            customMessage: "Message bloqué par l'AutoMod Kotbo (Spam détecté)."
          }
        }
      ];
      if (logChannelId) {
        actions.push({
          type: AutoModerationActionType.SendAlertMessage,
          metadata: {
            channel: logChannelId
          }
        });
      }

      const ruleData = {
        name: ruleNames.spam,
        eventType: AutoModerationRuleEventType.MessageSend,
        triggerType: AutoModerationRuleTriggerType.Spam,
        triggerMetadata: {},
        actions,
        enabled: true,
        exemptRoles,
        exemptChannels
      };

      try {
        if (existingSpam) {
          logger.info('AutoModService', `Mise à jour de la règle native Discord "${ruleNames.spam}" pour ${guild.name}`);
          await existingSpam.edit(ruleData);
        } else {
          logger.info('AutoModService', `Création de la règle native Discord "${ruleNames.spam}" pour ${guild.name}`);
          await guild.autoModerationRules.create(ruleData);
        }
      } catch (err) {
        logger.error('AutoModService', `Erreur lors de la création/modification de la règle "${ruleNames.spam}" :`, err);
      }
    } else {
      await deleteRuleIfExists(ruleNames.spam);
    }

    // 2. Règle Anti-Mentions
    if (config.mentionsEnabled) {
      const existingMentions = existingRules.find(r => r.name === ruleNames.mentions);
      const actions: AutoModerationActionOptions[] = [
        {
          type: AutoModerationActionType.BlockMessage,
          metadata: {
            customMessage: "Message bloqué par l'AutoMod Kotbo (Excès de mentions)."
          }
        }
      ];
      if (logChannelId) {
        actions.push({
          type: AutoModerationActionType.SendAlertMessage,
          metadata: {
            channel: logChannelId
          }
        });
      }

      // mentionTotalLimit doit être compris entre 1 et 50
      const limit = Math.max(1, Math.min(50, config.mentionsLimit || 5));

      const ruleData = {
        name: ruleNames.mentions,
        eventType: AutoModerationRuleEventType.MessageSend,
        triggerType: AutoModerationRuleTriggerType.MentionSpam,
        triggerMetadata: {
          mentionTotalLimit: limit
        },
        actions,
        enabled: true,
        exemptRoles,
        exemptChannels
      };

      try {
        if (existingMentions) {
          logger.info('AutoModService', `Mise à jour de la règle native Discord "${ruleNames.mentions}" pour ${guild.name}`);
          await existingMentions.edit(ruleData);
        } else {
          logger.info('AutoModService', `Création de la règle native Discord "${ruleNames.mentions}" pour ${guild.name}`);
          await guild.autoModerationRules.create(ruleData);
        }
      } catch (err) {
        logger.error('AutoModService', `Erreur lors de la création/modification de la règle "${ruleNames.mentions}" :`, err);
      }
    } else {
      await deleteRuleIfExists(ruleNames.mentions);
    }

    // 3. Règle Anti-Liens & Invitations
    if (config.linksEnabled) {
      const existingLinks = existingRules.find(r => r.name === ruleNames.links);
      const actions: AutoModerationActionOptions[] = [
        {
          type: AutoModerationActionType.BlockMessage,
          metadata: {
            customMessage: "Message bloqué par l'AutoMod Kotbo (Lien ou invitation non autorisé)."
          }
        }
      ];
      if (logChannelId) {
        actions.push({
          type: AutoModerationActionType.SendAlertMessage,
          metadata: {
            channel: logChannelId
          }
        });
      }

      // Préparer les filtres de mots-clés pour les liens et invitations
      const keywordFilter = ['*discord.gg/*', '*discord.com/invite/*', '*http://*', '*https://*'];
      
      // La whitelist des domaines autorisés
      const allowList = (config.linksWhitelist || []).map((domain: string) => `*${domain}*`).slice(0, 100);

      const ruleData = {
        name: ruleNames.links,
        eventType: AutoModerationRuleEventType.MessageSend,
        triggerType: AutoModerationRuleTriggerType.Keyword,
        triggerMetadata: {
          keywordFilter,
          allowList: allowList.length > 0 ? allowList : undefined
        },
        actions,
        enabled: true,
        exemptRoles,
        exemptChannels
      };

      try {
        if (existingLinks) {
          logger.info('AutoModService', `Mise à jour de la règle native Discord "${ruleNames.links}" pour ${guild.name}`);
          await existingLinks.edit(ruleData);
        } else {
          logger.info('AutoModService', `Création de la règle native Discord "${ruleNames.links}" pour ${guild.name}`);
          await guild.autoModerationRules.create(ruleData);
        }
      } catch (err) {
        logger.error('AutoModService', `Erreur lors de la création/modification de la règle "${ruleNames.links}" :`, err);
      }
    } else {
      await deleteRuleIfExists(ruleNames.links);
    }

    // 4. Règle Custom Words Filter
    if (config.customWordsEnabled && config.customWords?.length > 0) {
      const existingCustomWords = existingRules.find(r => r.name === ruleNames.customWords);
      const actions = buildNativeActions(config.customWordsAction, config.customWordsTimeoutSec, logChannelId, "Message bloqué par l'AutoMod Kotbo (Mot interdit détecté).");

      const keywords = (config.customWords as string[])
        .map((w: string) => w.trim().toLowerCase())
        .filter((w: string) => w.length > 0 && w.length <= 60)
        .slice(0, 1000);

      if (keywords.length > 0) {
        const allowList = (config.customWordsAllowList || [])
          .map((w: string) => w.trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 100);

        const ruleData = {
          name: ruleNames.customWords,
          eventType: AutoModerationRuleEventType.MessageSend,
          triggerType: AutoModerationRuleTriggerType.Keyword,
          triggerMetadata: {
            keywordFilter: keywords,
            allowList: allowList.length > 0 ? allowList : undefined
          },
          actions,
          enabled: true,
          exemptRoles,
          exemptChannels
        };

        try {
          if (existingCustomWords) {
            logger.info('AutoModService', `Mise à jour de la règle native Discord "${ruleNames.customWords}" pour ${guild.name}`);
            await existingCustomWords.edit(ruleData);
          } else {
            logger.info('AutoModService', `Création de la règle native Discord "${ruleNames.customWords}" pour ${guild.name}`);
            await guild.autoModerationRules.create(ruleData);
          }
        } catch (err) {
          logger.error('AutoModService', `Erreur lors de la création/modification de la règle "${ruleNames.customWords}" :`, err);
        }
      } else {
        await deleteRuleIfExists(ruleNames.customWords);
      }
    } else {
      await deleteRuleIfExists(ruleNames.customWords);
    }

    // 5. Règle Profanity Filter (KeywordPreset)
    if (config.profanityEnabled) {
      const existingProfanity = existingRules.find(r => r.name === ruleNames.profanity);
      const actions = buildNativeActions(config.profanityAction, config.profanityTimeoutSec, logChannelId, "Message bloqué par l'AutoMod Kotbo (Contenu inapproprié détecté).");

      const presets: AutoModerationRuleKeywordPresetType[] = [];
      if (config.profanityPresetProfanity) presets.push(AutoModerationRuleKeywordPresetType.Profanity);
      if (config.profanityPresetSexual) presets.push(AutoModerationRuleKeywordPresetType.SexualContent);
      if (config.profanityPresetSlurs) presets.push(AutoModerationRuleKeywordPresetType.Slurs);

      if (presets.length > 0) {
        const allowList = (config.profanityAllowList || [])
          .map((w: string) => w.trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 100);

        const ruleData = {
          name: ruleNames.profanity,
          eventType: AutoModerationRuleEventType.MessageSend,
          triggerType: AutoModerationRuleTriggerType.KeywordPreset,
          triggerMetadata: {
            presets,
            allowList: allowList.length > 0 ? allowList : undefined
          },
          actions,
          enabled: true,
          exemptRoles,
          exemptChannels
        };

        try {
          if (existingProfanity) {
            logger.info('AutoModService', `Mise à jour de la règle native Discord "${ruleNames.profanity}" pour ${guild.name}`);
            await existingProfanity.edit(ruleData);
          } else {
            logger.info('AutoModService', `Création de la règle native Discord "${ruleNames.profanity}" pour ${guild.name}`);
            await guild.autoModerationRules.create(ruleData);
          }
        } catch (err) {
          logger.error('AutoModService', `Erreur lors de la création/modification de la règle "${ruleNames.profanity}" :`, err);
        }
      } else {
        await deleteRuleIfExists(ruleNames.profanity);
      }
    } else {
      await deleteRuleIfExists(ruleNames.profanity);
    }

    // 6. Règle Invite Filter
    if (config.inviteFilterEnabled) {
      const existingInvites = existingRules.find(r => r.name === ruleNames.invites);
      const actions = buildNativeActions(config.inviteFilterAction, config.inviteFilterTimeoutSec, logChannelId, "Message bloqué par l'AutoMod Kotbo (Invitation Discord non autorisée).");

      const keywordFilter = ['*discord.gg/*', '*discord.com/invite/*', '*discordapp.com/invite/*'];
      const allowList = (config.inviteFilterAllowedGuilds || [])
        .map((g: string) => `*discord.gg/${g.trim()}*`)
        .filter(Boolean)
        .slice(0, 100);

      const ruleData = {
        name: ruleNames.invites,
        eventType: AutoModerationRuleEventType.MessageSend,
        triggerType: AutoModerationRuleTriggerType.Keyword,
        triggerMetadata: {
          keywordFilter,
          allowList: allowList.length > 0 ? allowList : undefined
        },
        actions,
        enabled: true,
        exemptRoles,
        exemptChannels
      };

      try {
        if (existingInvites) {
          logger.info('AutoModService', `Mise à jour de la règle native Discord "${ruleNames.invites}" pour ${guild.name}`);
          await existingInvites.edit(ruleData);
        } else {
          logger.info('AutoModService', `Création de la règle native Discord "${ruleNames.invites}" pour ${guild.name}`);
          await guild.autoModerationRules.create(ruleData);
        }
      } catch (err) {
        logger.error('AutoModService', `Erreur lors de la création/modification de la règle "${ruleNames.invites}" :`, err);
      }
    } else {
      await deleteRuleIfExists(ruleNames.invites);
    }

  } catch (err) {
    logger.error('AutoModService', 'Erreur globale lors de la synchronisation des règles AutoMod Discord Native :', err);
    throw err;
  }
}

/**
 * Synchronise la règle native d'AutoMod de Discord pour les pseudos de profil de membre (MEMBER_PROFILE)
 */
export async function syncDiscordAutoModProfileRule(client: Client, guildId: string) {
  try {
    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) {
      logger.warn('AutoModService', `Impossible de synchroniser la règle AutoMod Pseudos : Serveur ${guildId} introuvable ou inaccessible par le bot.`);
      return;
    }

    const guildDb = await prisma.guild.findUnique({
      where: { id: guildId },
      select: {
        nickModDiscordAutoModSync: true,
        logChannelId: true,
        nicknameModerationWhitelist: true,
        nicknameModerationBypass: true,
        nickModCheckGlobal: true,
        nickModCheckCustom: true,
      }
    });

    if (!guildDb) return;

    const existingRules = await guild.autoModerationRules.fetch().catch((err) => {
      logger.warn('AutoModService', `Impossible de récupérer les règles AutoMod pour ${guild.name} (${guildId}) :`, err);
      return null;
    });

    if (!existingRules) return;

    const ruleName = 'Kotbo AutoMod - Pseudos';
    const existingRule = existingRules.find(r => r.name === ruleName);

    const deleteRule = async () => {
      if (existingRule) {
        logger.info('AutoModService', `Suppression de la règle native Discord "${ruleName}" pour ${guild.name}`);
        await existingRule.delete('Configuration modifiée dans le dashboard').catch(e => {
          logger.error('AutoModService', `Erreur lors de la suppression de la règle "${ruleName}" :`, e);
        });
      }
    };

    if (!guildDb.nickModDiscordAutoModSync) {
      await deleteRule();
      return;
    }

    // Charger les mots bannis
    const checkGlobal = guildDb.nickModCheckGlobal ?? true;
    const checkCustom = guildDb.nickModCheckCustom ?? true;
    let bannedWords: string[] = [];
    if (checkGlobal && checkCustom) {
      bannedWords = await loadBannedWords(guildId);
    } else if (checkGlobal) {
      bannedWords = await loadGlobalWords();
    } else if (checkCustom) {
      bannedWords = await loadCustomWords(guildId);
    }

    // Limites de Discord: mots clés <= 60 caractères, max 1000 mots
    const keywords = bannedWords
      .map(w => w.trim().toLowerCase())
      .filter(w => w.length > 0 && w.length <= 60 && !isReservedByNicknameModeration(w))
      .slice(0, 1000);

    if (keywords.length === 0) {
      // Discord nécessite au moins 1 mot-clé dans les filtres personnalisés
      await deleteRule();
      return;
    }

    const exemptRoles = (guildDb.nicknameModerationBypass || []).slice(0, 20);
    // Limite Discord pour l'allowList : max 100
    const allowList = (guildDb.nicknameModerationWhitelist || [])
      .map(w => w.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 100);

    const actions: AutoModerationActionOptions[] = [
      {
        type: 4 as AutoModerationActionType // BLOCK_MEMBER_INTERACTION
      }
    ];

    if (guildDb.logChannelId) {
      actions.push({
        type: 2 as AutoModerationActionType, // SEND_ALERT_MESSAGE
        metadata: {
          channel: guildDb.logChannelId
        }
      });
    }

    const ruleData = {
      name: ruleName,
      eventType: 2 as AutoModerationRuleEventType, // MEMBER_UPDATE
      triggerType: 6 as AutoModerationRuleTriggerType, // MEMBER_PROFILE
      triggerMetadata: {
        keywordFilter: keywords,
        allowList: allowList.length > 0 ? allowList : undefined
      },
      actions,
      enabled: true,
      exemptRoles,
      exemptChannels: []
    };

    if (existingRule) {
      logger.info('AutoModService', `Mise à jour de la règle native Discord "${ruleName}" pour ${guild.name}`);
      await existingRule.edit(ruleData).catch(err => {
        logger.error('AutoModService', `Erreur lors de la modification de la règle "${ruleName}" :`, err);
      });
    } else {
      logger.info('AutoModService', `Création de la règle native Discord "${ruleName}" pour ${guild.name}`);
      await guild.autoModerationRules.create(ruleData).catch(err => {
        logger.error('AutoModService', `Erreur lors de la création de la règle "${ruleName}" :`, err);
      });
    }
  } catch (err) {
    logger.error('AutoModService', 'Erreur globale lors de la synchronisation de la règle AutoMod Pseudos Discord Native :', err);
  }
}


/**
 * Analyse un message et applique des sanctions si nécessaire
 * @returns true si le message a été supprimé ou l'utilisateur sanctionné (interrompre le traitement)
 */
export async function handleAutoMod(message: Message, client: Client): Promise<boolean> {
  // Ignorer si message privé, envoyé par un bot, ou par un administrateur du serveur
  if (!message.guild || !message.member || message.author.bot) return false;
  if (message.member.permissions.has(PermissionFlagsBits.Administrator)) return false;

  try {
    const guildId = message.guild.id;
    const config = await getOrCreateAutoModConfig(guildId);

    // Vérifier si le rôle ou le salon est exempté
    if (config.bypassChannels.includes(message.channel.id)) return false;
    const hasBypassRole = message.member.roles.cache.some(r => config.bypassRoles.includes(r.id));
    if (hasBypassRole) return false;

    const content = message.content;
    const userId = message.author.id;

    // 1. Anti-Spam
    if (config.spamEnabled) {
      const trackerKey = `${guildId}:${userId}`;
      const now = Date.now();
      const userTimes = userMessageTimestamps.get(trackerKey) || [];

      // Nettoyer les vieux messages hors de la fenêtre d'intervalle
      const thresholdTime = now - (config.spamIntervalSeconds * 1000);
      const recentTimes = userTimes.filter(t => t > thresholdTime);
      recentTimes.push(now);
      userMessageTimestamps.set(trackerKey, recentTimes);

      if (recentTimes.length > config.spamLimit) {
        // Déclencher sanction de Spam
        await deleteMessage(message);
        await applySanction(
          message,
          config.spamAction,
          '[AutoMod] Spam détecté (messages trop rapides)',
          client
        );
        return true;
      }
    }

    // 2. Anti-Liens / Invitations Discord
    if (config.linksEnabled) {
      const inviteRegex = /(discord\.(gg|io|me|li)\/.+|discord\.com\/invite\/.+)/gi;
      if (inviteRegex.test(content)) {
        // Vérifier si le lien appartient à la whitelist
        const domains = config.linksWhitelist || [];
        const isWhitelisted = domains.some((domain: string) => content.includes(domain));

        if (!isWhitelisted) {
          await deleteMessage(message);
          await applySanction(
            message,
            config.linksAction,
            "[AutoMod] Partage d'invitation Discord non autorisé",
            client
          );
          return true;
        }
      }
    }

    // 3. Limite de majuscules (Caps Lock)
    if (config.capsEnabled) {
      const percent = getUppercasePercentage(content, config.capsMinLength);

      if (percent !== null && percent >= config.capsThresholdPercent) {
        await deleteMessage(message);
        await applySanction(
          message,
          'WARN',
          `[AutoMod] Excès de majuscules (${Math.round(percent)}% de majuscules)`,
          client
        );
        return true;
      }
    }

    // 4. Limite d'émojis
    if (config.emojisEnabled) {
      const customEmojiRegex = /<a?:\w+:\d+>/g;
      const unicodeEmojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{2700}-\u{27BF}]|[\u{1F600}-\u{1F64F}]|[\u{1F680}-\u{1F6FF}]|[\u{2600}-\u{26FF}]|[\u{1F1E6}-\u{1F1FF}]/gu;
      
      const customCount = (content.match(customEmojiRegex) || []).length;
      const unicodeCount = (content.match(unicodeEmojiRegex) || []).length;
      const totalEmojis = customCount + unicodeCount;

      if (totalEmojis > config.emojisLimit) {
        await deleteMessage(message);
        await applySanction(
          message,
          'WARN',
          `[AutoMod] Trop d'émojis (${totalEmojis} émojis envoyés)`,
          client
        );
        return true;
      }
    }

    // 5. Limite de mentions
    if (config.mentionsEnabled) {
      const mentionCount = message.mentions.users.size + message.mentions.roles.size;
      if (mentionCount > config.mentionsLimit) {
        await deleteMessage(message);
        await applySanction(
          message,
          'TIMEOUT',
          `[AutoMod] Excès de mentions (${mentionCount} mentions)`,
          client
        );
        return true;
      }
    }

    // 6. Anti-Troll Everyone / Here
    if (config.antiEveryoneEnabled) {
      const hasMentionEveryonePermission = message.member?.permissionsIn(message.channelId).has(PermissionFlagsBits.MentionEveryone);
      if (!hasMentionEveryonePermission) {
        const contentLower = content.toLowerCase();
        if (message.mentions.everyone || contentLower.includes('@everyone') || contentLower.includes('@here')) {
          await deleteMessage(message);
          await applySanction(
            message,
            config.antiEveryoneAction || 'DELETE_AND_WARN',
            "[AutoMod] Tentative de mention d'everyone/here (anti-troll)",
            client
          );
          return true;
        }
      }
    }
  } catch (err) {
    logger.error('AutoModService', "Erreur lors de l'exécution d'AutoMod :", err);
  }

  return false;
}

/**
 * Supprime proprement le message fautif
 */
async function deleteMessage(message: Message) {
  await message.delete().catch(e => logger.warn('AutoModService', 'Impossible de supprimer le message :', e));
}

/**
 * Applique une sanction (WARN, TIMEOUT, ou DELETE_AND_WARN)
 */
async function applySanction(message: Message, action: string, reason: string, client: Client) {
  const guildId = message.guild!.id;
  const target = {
    id: message.author.id,
    tag: message.author.tag,
  };
  const moderator = {
    id: (client as any).user.id,
    tag: (client as any).user.tag,
  };

  // Informer l'utilisateur dans le salon d'origine de manière éphémère (ou message normal supprimé rapidement)
  if (action !== 'DELETE_ONLY') {
    const warnAlert = message.channel.isSendable() ? await message.channel.send(`⚠️ <@${message.author.id}>, votre message a été supprimé : ${reason.replace('[AutoMod] ', '')}`).catch(() => null) : null;
    if (warnAlert) {
      setTimeout(() => {
        warnAlert.delete().catch(() => null);
      }, 6000);
    }
  }

  // Générer la transcription pour le message de preuve
  const evidenceLinks: string[] = [];
  if (action === 'WARN' || action === 'DELETE_AND_WARN' || action === 'TIMEOUT') {
    try {
      const { generateTranscriptFromMessages } = await import('../features/transcriptService.js');
      const transcript = await generateTranscriptFromMessages(message.channel as any, [message]);
      const { getDashboardUrl } = await import('../../api/shared.js');
      const dashboardUrl = getDashboardUrl();
      const transcriptUrl = `${dashboardUrl}${transcript.url}`;
      evidenceLinks.push(transcriptUrl);
    } catch (err) {
      logger.warn('AutoModService', 'Impossible de générer la transcription pour le message de preuve :', err);
    }
  }

  // Notifier dans le salon de log si configuré
  try {
    const guildDb = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { logChannelId: true },
    });
    const embed = new EmbedBuilder()
      .setTitle('🛡️ Sanction AutoMod')
      .setDescription(`L'utilisateur <@${target.id}> a déclenché une alerte de sécurité.`)
      .addFields(
        { name: 'Utilisateur', value: `${target.tag} (<@${target.id}>)`, inline: true },
        { name: 'Action', value: action, inline: true },
        { name: 'Raison', value: reason, inline: false },
        { name: 'Salon', value: `<#${message.channel.id}>`, inline: true }
      )
      .setColor('#ED4245')
      .setTimestamp();

    if (guildDb?.logChannelId) {
      const logChannel = message.guild!.channels.cache.get(guildDb.logChannelId);
      if (logChannel?.isTextBased()) {
        await logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
      }
    }

    await mirrorModlogToStaffServer(client, guildId, embed);
  } catch (err) {
    logger.warn('AutoModService', "Impossible d'envoyer le log AutoMod :", err);
  }

  // Appliquer l'effet de sanction réel
  if (action === 'WARN' || action === 'DELETE_AND_WARN') {
    await registerWarnSanction({
      guildId,
      target,
      moderator,
      reason,
      client: client as any,
      evidenceLinks,
    });
  } else if (action === 'TIMEOUT') {
    // Timeout de 10 minutes par défaut pour l'AutoMod
    const tenMinutesMs = 10 * 60 * 1000;
    await registerTimeoutSanction({
      guildId,
      target,
      moderator,
      reason,
      durationMs: tenMinutesMs,
      member: message.member!,
      client: client as any,
      evidenceLinks,
    });
  }
}

/**
 * Gère la détection de ghost ping lors de la suppression d'un message
 */
export async function handleGhostPingDelete(message: Message | PartialMessage, client: Client) {
  if (message.partial) return;
  if (!message.guild || !message.member || message.author.bot) return;
  if (message.member.permissions.has(PermissionFlagsBits.Administrator)) return;

  try {
    const guildId = message.guild.id;
    const config = await getOrCreateAutoModConfig(guildId);

    if (!config.ghostPingEnabled) return;

    // Bypasser si l'auteur du message est membre du personnel (staff)
    const guildDb = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { baseStaffRoleId: true, moderatorRoleId: true, testStaffRoleId: true }
    });
    const isStaffRole = message.member.roles.cache.some(r => 
      (guildDb?.baseStaffRoleId && r.id === guildDb.baseStaffRoleId) ||
      (guildDb?.moderatorRoleId && r.id === guildDb.moderatorRoleId) ||
      (guildDb?.testStaffRoleId && r.id === guildDb.testStaffRoleId)
    );
    const isStaffDb = await prisma.staffMember.findUnique({
      where: { guildId_userId: { guildId, userId: message.author.id } }
    });
    if (isStaffRole || !!isStaffDb) return;

    // Vérifier si le rôle ou le salon est exempté
    if (config.bypassChannels.includes(message.channel.id)) return;
    const hasBypassRole = message.member.roles.cache.some(r => config.bypassRoles.includes(r.id));
    if (hasBypassRole) return;

    // Vérifier via l'Audit Log si c'est un staff qui a supprimé le message
    // Si oui, ne pas déclencher le ghost ping (ce n'est pas l'auteur qui a supprimé)
    try {
      await new Promise(resolve => setTimeout(resolve, 500)); // Laisser le temps à l'audit log de se mettre à jour
      const auditLogs = await message.guild.fetchAuditLogs({
        type: AuditLogEvent.MessageDelete,
        limit: 5,
      });

      const deletionLog = auditLogs.entries.find(entry => {
        const isRecent = Date.now() - entry.createdTimestamp < 5000;
        const isTargetMessage =
          (entry.target as { id?: string } | null)?.id === message.author.id &&
          (entry.extra as { channel?: { id?: string } } | null)?.channel?.id === message.channel.id;
        return isRecent && isTargetMessage;
      });

      if (deletionLog && deletionLog.executor?.id !== message.author.id) {
        // Un autre membre (staff) a supprimé le message → pas de ghost ping
        return;
      }
    } catch {
      // Si on ne peut pas lire l'audit log (permissions manquantes), on continue normalement
    }

    // Récupérer les mentions cibles (exclure l'auteur et les bots)
    const targetUsers = message.mentions.users.filter(user => !user.bot && user.id !== message.author.id);
    const targetRoles = message.mentions.roles;
    const hasEveryone = message.mentions.everyone;

    if (targetUsers.size === 0 && targetRoles.size === 0 && !hasEveryone) return;

    await triggerGhostPingAlert(message as Message, targetUsers, targetRoles, hasEveryone, false, config, client);
  } catch (err) {
    logger.error('AutoModService', 'Erreur lors de la détection de ghost ping sur suppression :', err);
  }
}

/**
 * Gère la détection de ghost ping lors de la modification d'un message
 */
export async function handleGhostPingUpdate(
  oldMessage: Message | PartialMessage,
  newMessage: Message | PartialMessage,
  client: Client
) {
  if (oldMessage.partial || newMessage.partial) return;
  if (!oldMessage.guild || !oldMessage.member || oldMessage.author.bot) return;
  if (oldMessage.member.permissions.has(PermissionFlagsBits.Administrator)) return;

  try {
    const guildId = oldMessage.guild.id;
    const config = await getOrCreateAutoModConfig(guildId);

    if (!config.ghostPingEnabled) return;

    // Bypasser si l'auteur du message est membre du personnel (staff)
    const guildDb = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { baseStaffRoleId: true, moderatorRoleId: true, testStaffRoleId: true }
    });
    const isStaffRole = oldMessage.member.roles.cache.some(r => 
      (guildDb?.baseStaffRoleId && r.id === guildDb.baseStaffRoleId) ||
      (guildDb?.moderatorRoleId && r.id === guildDb.moderatorRoleId) ||
      (guildDb?.testStaffRoleId && r.id === guildDb.testStaffRoleId)
    );
    const isStaffDb = await prisma.staffMember.findUnique({
      where: { guildId_userId: { guildId, userId: oldMessage.author.id } }
    });
    if (isStaffRole || !!isStaffDb) return;

    // Vérifier si le rôle ou le salon est exempté
    if (config.bypassChannels.includes(oldMessage.channel.id)) return;
    const hasBypassRole = oldMessage.member.roles.cache.some(r => config.bypassRoles.includes(r.id));
    if (hasBypassRole) return;

    // Trouver les mentions supprimées lors de l'édition
    const deletedUsers = oldMessage.mentions.users.filter(user => 
      !user.bot && 
      user.id !== oldMessage.author.id && 
      !newMessage.mentions.users.has(user.id)
    );
    const deletedRoles = oldMessage.mentions.roles.filter(role => 
      !newMessage.mentions.roles.has(role.id)
    );
    const deletedEveryone = oldMessage.mentions.everyone && !newMessage.mentions.everyone;

    if (deletedUsers.size === 0 && deletedRoles.size === 0 && !deletedEveryone) return;

    await triggerGhostPingAlert(oldMessage as Message, deletedUsers, deletedRoles, deletedEveryone, true, config, client);
  } catch (err) {
    logger.error('AutoModService', 'Erreur lors de la détection de ghost ping sur modification :', err);
  }
}

/**
 * Déclenche l'alerte et la sanction de ghost ping
 */
async function triggerGhostPingAlert(
  message: Message,
  targetUsers: Collection<string, User>,
  targetRoles: Collection<string, Role>,
  hasEveryone: boolean,
  isEdit: boolean,
  config: AutoModConfig,
  client: Client
) {
  const guildId = message.guild!.id;
  const author = message.author;
  const action = config.ghostPingAction || 'ALERT';

  // 1. Préparer la liste des cibles sans les mentionner à nouveau pour éviter un double ping
  const targetsList: string[] = [];
  targetUsers.forEach(u => targetsList.push(`**${u.username}**`));
  targetRoles.forEach(r => targetsList.push(`**@${r.name}**`));
  if (hasEveryone) targetsList.push('**@everyone / @here**');

  const targetsString = targetsList.join(', ');
  const reason = isEdit 
    ? `[AutoMod] Ghost Ping détecté (mention retirée d'un message modifié)`
    : `[AutoMod] Ghost Ping détecté (message supprimé contenant une mention)`;

  // 2. Envoyer un message d'alerte publique dans le salon d'origine
  const alertText = isEdit
    ? `👻 **Ghost Ping détecté !** <@${author.id}> a mentionné ${targetsString} puis a modifié son message pour retirer la mention.`
    : `👻 **Ghost Ping détecté !** <@${author.id}> a mentionné ${targetsString} puis a supprimé son message.`;

  if (message.channel.isSendable()) {
    await message.channel.send(alertText).catch(() => null);
  }

  // 3. Notifier dans le salon de log si configuré
  try {
    const guildDb = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { logChannelId: true },
    });
    const embed = new EmbedBuilder()
      .setTitle('🛡️ Alerte AutoMod (Ghost Ping)')
      .setDescription(`Un ghost ping a été détecté dans le salon <#${message.channel.id}>.`)
      .addFields(
        { name: 'Utilisateur', value: `${author.tag} (<@${author.id}>)`, inline: true },
        { name: 'Cibles mentionnées', value: targetsString || 'Inconnues', inline: true },
        { name: 'Action', value: action, inline: true },
        { name: "Type d'infraction", value: isEdit ? 'Modification de message' : 'Suppression de message', inline: true }
      )
      .setColor('#ED4245')
      .setTimestamp();

    // Si le contenu original du message est disponible, l'ajouter de manière sécurisée
    if (message.content) {
      const contentSnippet = message.content.substring(0, 1024);
      embed.addFields({ name: 'Message original', value: contentSnippet, inline: false });
    }

    if (guildDb?.logChannelId) {
      const logChannel = message.guild!.channels.cache.get(guildDb.logChannelId);
      if (logChannel?.isTextBased()) {
        await logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
      }
    }

    await mirrorModlogToStaffServer(client, guildId, embed);
  } catch (err) {
    logger.warn('AutoModService', "Impossible d'envoyer le log de Ghost Ping :", err);
  }

  // 4. Appliquer une sanction d'avertissement (WARN) si configurée
  if (action === 'WARN') {
    const target = {
      id: author.id,
      tag: author.tag,
    };
    const moderator = {
      id: client.user!.id,
      tag: client.user!.tag,
    };

    await registerWarnSanction({
      guildId,
      target,
      moderator,
      reason,
      client,
    });
  }
}

/**
 * Gère l'ajout d'un bot sur le serveur en mode sécurisé.
 * Si antiBotEnabled est actif, seul le propriétaire du serveur peut ajouter un bot.
 * Sinon, le bot ajouté est expulsé ou banni automatiquement.
 */
export async function handleAntiBotAdd(member: GuildMember, client: Client): Promise<boolean> {
  if (!member.user.bot) return false;
  if (!member.guild) return false;

  // Ne jamais s'expulser soi-même
  if (member.id === client.user?.id) return false;

  try {
    const guildId = member.guild.id;
    const config = await getOrCreateAutoModConfig(guildId);

    if (!config.antiBotEnabled) return false;

    // Chercher qui a ajouté le bot via l'audit log
    let addedById: string | null = null;
    try {
      const auditLogs = await member.guild.fetchAuditLogs({
        type: AuditLogEvent.BotAdd,
        limit: 5,
      });

      const entry = auditLogs.entries.find(e => {
        const isRecent = Date.now() - e.createdTimestamp < 10000;
        return isRecent && e.targetId === member.id;
      });

      addedById = entry?.executorId ?? null;
    } catch {
      logger.warn('AutoModService', `Impossible de lire l'audit log pour l'ajout du bot ${member.user.tag} sur ${guildId}`);
    }

    // Si c'est le propriétaire ou un utilisateur bypass qui a ajouté le bot, on autorise
    const ownerId = member.guild.ownerId;
    if (addedById === ownerId) return false;
    if (addedById && (config.antiBotBypassUsers || []).includes(addedById)) return false;

    const action = config.antiBotAction || 'KICK';
    const reason = `[AutoMod] Ajout de bot non autorisé - seul le propriétaire du serveur peut ajouter des bots (mode sécurisé)`;

    // Appliquer l'action
    if (action === 'BAN') {
      await member.ban({ reason }).catch(err => {
        logger.error('AutoModService', `Impossible de bannir le bot ${member.user.tag} :`, err);
      });
    } else {
      await member.kick(reason).catch(err => {
        logger.error('AutoModService', `Impossible d'expulser le bot ${member.user.tag} :`, err);
      });
    }

    logger.info('AutoModService', `Bot ${member.user.tag} (${member.id}) ${action === 'BAN' ? 'banni' : 'expulsé'} du serveur ${guildId} - ajouté par ${addedById ?? 'inconnu'} (non propriétaire)`);

    // Notifier dans le salon de log
    try {
      const guildDb = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { logChannelId: true },
      });
      const embed = new EmbedBuilder()
        .setTitle('🤖 Bot bloqué (Mode Sécurisé)')
        .setDescription(`Le bot **${member.user.tag}** a été ${action === 'BAN' ? 'banni' : 'expulsé'} automatiquement.`)
        .addFields(
          { name: 'Bot', value: `${member.user.tag} (<@${member.id}>)`, inline: true },
          { name: 'Ajouté par', value: addedById ? `<@${addedById}>` : 'Inconnu', inline: true },
          { name: 'Action', value: action, inline: true },
          { name: 'Raison', value: 'Seul le propriétaire du serveur peut ajouter des bots en mode sécurisé.', inline: false },
        )
        .setColor('#ED4245')
        .setTimestamp();

      if (guildDb?.logChannelId) {
        const logChannel = member.guild.channels.cache.get(guildDb.logChannelId);
        if (logChannel?.isTextBased()) {
          await logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
        }
      }

      await mirrorModlogToStaffServer(client, guildId, embed);
    } catch (err) {
      logger.warn('AutoModService', "Impossible d'envoyer le log anti-bot :", err);
    }

    // Notifier la personne qui a ajouté le bot (si identifiable)
    if (addedById) {
      try {
        const adder = await client.users.fetch(addedById).catch(() => null);
        if (adder) {
          await adder.send(
            `⚠️ Le bot **${member.user.tag}** que vous avez ajouté sur **${member.guild.name}** a été ${action === 'BAN' ? 'banni' : 'expulsé'} automatiquement. Ce serveur est en **mode sécurisé** : seul le propriétaire peut ajouter des bots.`
          ).catch(() => null);
        }
      } catch {
        // DM fermés, pas grave
      }
    }

    return true;
  } catch (err) {
    logger.error('AutoModService', "Erreur lors du traitement anti-bot :", err);
    return false;
  }
}
