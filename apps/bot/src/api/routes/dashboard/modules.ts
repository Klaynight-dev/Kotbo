import type { ColorResolvable, OverwriteResolvable } from 'discord.js';
import { readStatsConfig } from '../../../services/analytics/statsConfig.js';
import { errorCode, errorMessage, errorStack } from '../../../utils/errors.js';
import { IncomingMessage, ServerResponse } from 'node:http';
import { cache } from '../../../utils/cache.js';
import {
  Client,
  ChannelType,
  PermissionFlagsBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  TextChannel,
  type Message,
  type Guild,
  type Embed,
} from 'discord.js';
import { Prisma, SanctionType } from '@prisma/client';
import pLimit from 'p-limit';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { COLORS, successEmbed } from '../../../utils/embeds.js';
import { json, readJsonBody, getGuildName, getAuditActor, resolveFeatureAccessMap, pushAudit, extractDiscordSnowflake, getOrCreateRuntime, resolveAdminAccess, broadcastDashboardStateChange, type AuthClaims, type DashboardAccess, type SeverityLevel, type ModuleStatus, type DashboardPresetKey, type CommandAccessLevel, type NotificationSettings } from '../../shared.js';
import { normalizeCommandRestrictions } from '../../../utils/commandAccess.js';
import { getTwitchUserId } from '../../../services/integrations/twitchService.js';
import { resolveYoutubeChannel } from '../../../services/integrations/youtubeService.js';
import { publishOrUpdateRegulationMessage, applyRegulationLock } from '../../../services/staff/regulationService.js';
import { publishNewsArticle } from '../../../services/core/newsService.js';
import {
  getLocalDateKey,
  reviewDailyAlgoSubmission,
} from '../../../services/progression/dailyAlgoService.js';
import {
  closeDailyAlgoWeek,
  getCurrentDailyAlgoWeek,
  getDailyAlgoWeekHistory,
} from '../../../services/progression/dailyAlgoWeekService.js';
import { invalidateNicknameModerationCache } from '../../../events/nicknameModeration.js';
import { updateGuildStats } from '../../../events/stats.js';
import { invalidateBannedWordsCache } from '../../../services/moderation/bannedWordsService.js';
import { generateTranscriptFromMessages, resolveMentionsToText, embedToApiShape } from '../../../services/features/transcriptService.js';

import { parseDiscordMarkdown, extractMediaUrls, resolveDailyAlgoTotalPoints } from '../../shared.js';
import {
  getModuleStatsSummary,
  getModuleActivationStats,
  getModuleUsageStats,
  getModulePerformanceStats,
  KOTBO_MODULES,
  setModuleActivation,
  type KotboModule,
} from '../../../services/analytics/moduleStatsService.js';

const PRESET_LABELS: Record<DashboardPresetKey, string> = {
  general: 'Communauté générale',
  gaming: 'Gaming/Esport',
  dev: 'Dev/Tech',
};

const PRESET_COMMAND_OVERRIDES: Record<DashboardPresetKey, Partial<Record<string, CommandAccessLevel>>> = {
  general: {},
  gaming: {},
  dev: { dailyAlgo: 'tout_le_monde' },
};

const _DEFAULT_SEVERITY_BY_MODULE = [
  { module: 'auth', level: 'info' as SeverityLevel },
  { module: 'moderation', level: 'attention' as SeverityLevel },
  { module: 'tickets', level: 'info' as SeverityLevel },
  { module: 'system', level: 'critique' as SeverityLevel }
];

const _DEFAULT_MESSAGE_TEMPLATE = 'Bonjour {user}, ...';

function resolveDailyAlgoFinalScore(submission: {
  scoreFinal: number | null;
  scoreCorrectness: number | null;
  scoreComments: number | null;
  scoreCompactness: number | null;
  scoreOptimization: number | null;
  scoreReadability: number | null;
}): number | null {
  if (submission.scoreFinal !== null) {
    return submission.scoreFinal;
  }

  const components = [
    submission.scoreCorrectness,
    submission.scoreComments,
    submission.scoreCompactness,
    submission.scoreOptimization,
    submission.scoreReadability,
  ];

  if (components.some((value) => value === null)) {
    return null;
  }

  const sum = (components as number[]).reduce((acc, value) => acc + value, 0);
  return Math.round((sum / 5) * 10) / 10;
}

function getDailyAlgoDateKeyWithOffset(offsetDays: number, baseDate = new Date()): string {
  const anchor = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate()));
  anchor.setUTCDate(anchor.getUTCDate() + offsetDays);

  const year = anchor.getUTCFullYear();
  const month = String(anchor.getUTCMonth() + 1).padStart(2, '0');
  const day = String(anchor.getUTCDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

async function getDailyAlgoScheduleRuns(guildId: string, daysBack: number, daysForward: number) {
  const safeDaysBack = Math.max(0, Math.trunc(daysBack));
  const safeDaysForward = Math.max(0, Math.trunc(daysForward));
  const startDateKey = getDailyAlgoDateKeyWithOffset(-safeDaysBack);
  const endDateKey = getDailyAlgoDateKeyWithOffset(safeDaysForward);

  const runs = await prisma.dailyAlgoRun.findMany({
    where: {
      guildId,
      dateKey: {
        gte: startDateKey,
        lte: endDateKey,
      },
    },
    include: {
      problem: true,
      _count: {
        select: {
          submissions: true,
        },
      },
    },
    orderBy: {
      dateKey: 'asc',
    },
  });

  return runs.map((run) => ({
    id: run.id,
    guildId: run.guildId,
    dateKey: run.dateKey,
    problemId: run.problemId,
    challengeChannelId: run.challengeChannelId,
    validationChannelId: run.validationChannelId,
    challengeMessageId: run.challengeMessageId,
    leaderboardMessageId: run.leaderboardMessageId,
    summarySentAt: run.summarySentAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    submissionsCount: run._count.submissions,
    problem: {
      id: run.problem.id,
      title: run.problem.title,
      description: run.problem.description,
      solution: run.problem.solution,
      difficulty: run.problem.difficulty,
      language: run.problem.language,
      functionName: run.problem.functionName,
      functionArgs: run.problem.functionArgs,
      unitTests: run.problem.unitTests,
      allowedLanguages: run.problem.allowedLanguages,
      usedAt: run.problem.usedAt?.toISOString() ?? null,
      createdAt: run.problem.createdAt.toISOString(),
      updatedAt: run.problem.updatedAt.toISOString(),
    },
  }));
}

async function ensureDailyAlgoScheduleRuns(guildId: string, daysForward: number) {
  const safeDaysForward = Math.max(1, Math.trunc(daysForward));
  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
    select: {
      id: true,
      dailyAlgoChannelId: true,
      dailyAlgoValidationChannelId: true,
    },
  });

  if (!guild) {
    throw new Error('Guilde introuvable.');
  }

  if (!guild.dailyAlgoChannelId) {
    return {
      createdDateKeys: [],
      createdCount: 0,
    };
  }

  const createdDateKeys: string[] = [];

  for (let offsetDays = 0; offsetDays <= safeDaysForward; offsetDays += 1) {
    const dateKey = getDailyAlgoDateKeyWithOffset(offsetDays);
    const existingRun = await prisma.dailyAlgoRun.findUnique({
      where: {
        guildId_dateKey: {
          guildId,
          dateKey,
        },
      },
    });

    if (existingRun) {
      continue;
    }

    const existingRunForDate = await prisma.dailyAlgoRun.findFirst({
      where: { dateKey },
      select: { problemId: true }
    });

    let problemId = existingRunForDate?.problemId;

    if (!problemId) {
      const problemCandidate = await prisma.dailyAlgoProblem.findFirst({
        where: {
          language: 'fr',
          usedAt: null,
        },
        orderBy: [
          { createdAt: 'asc' },
          { id: 'asc' },
        ],
        select: {
          id: true,
        },
      });

      if (!problemCandidate) {
        break;
      }
      problemId = problemCandidate.id;

      await prisma.dailyAlgoProblem.update({
        where: { id: problemId },
        data: { usedAt: new Date() }
      });
    }

    await prisma.dailyAlgoRun.create({
      data: {
        guildId,
        dateKey,
        problemId: problemId,
        challengeChannelId: guild.dailyAlgoChannelId!,
        validationChannelId: guild.dailyAlgoValidationChannelId ?? null,
      },
    });

    createdDateKeys.push(dateKey);
  }

  return {
    createdDateKeys,
    createdCount: createdDateKeys.length,
  };
}

type DashboardSanctionType = 'WARN' | 'KICK' | 'TIMEOUT' | 'TEMP_BAN' | 'BAN' | 'SOFTBAN';

function toSanctionType(value: DashboardSanctionType): SanctionType {
  return value as SanctionType;
}

function parseEvidenceLinks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => /^https?:\/\//i.test(entry));
}

const MAX_EVIDENCE_MESSAGES = 200;
const MAX_SCAN_MESSAGES = 400;
const EVIDENCE_CHANNEL_CONCURRENCY = 5;

interface FetchedEvidenceChannel {
  channelId: string;
  channelName: string;
  rawMessages: Message[];
  truncated: boolean;
}

async function resolveEvidenceChannel(client: Client, guildId: string, channelId: string): Promise<{ channel: TextChannel } | { error: string }> {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) {
    return { error: 'Serveur Discord introuvable.' };
  }

  let channel = guild.channels.cache.get(channelId) ?? null;
  if (!channel) {
    channel = await guild.channels.fetch(channelId).catch(() => null);
  }
  if (!channel) {
    return { error: 'Salon introuvable sur ce serveur.' };
  }

  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
    return { error: 'Ce type de salon n’est pas encore pris en charge.' };
  }

  const textChannel = channel as TextChannel;
  const me = guild.members.me;
  if (!me || !textChannel.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
    return { error: "Le bot n'a pas accès à ce salon." };
  }

  return { channel: textChannel };
}

async function fetchUserMessagesInChannel(
  channel: TextChannel,
  authorId: string,
  limit = MAX_EVIDENCE_MESSAGES,
): Promise<{ messages: Message[]; truncated: boolean }> {
  const matched: Message[] = [];
  let scanned = 0;
  let cursor: string | undefined;
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), MAX_EVIDENCE_MESSAGES);

  while (matched.length < safeLimit && scanned < MAX_SCAN_MESSAGES) {
    const batch = await channel.messages.fetch({ limit: 100, before: cursor });
    if (batch.size === 0) break;

    for (const msg of batch.values()) {
      scanned++;
      if (msg.author.id === authorId) {
        matched.push(msg);
        if (matched.length >= safeLimit) break;
      }
    }

    cursor = batch.last()?.id;
    if (batch.size < 100) break;
  }

  return {
    messages: matched.sort((a, b) => a.createdTimestamp - b.createdTimestamp),
    truncated: matched.length < safeLimit && scanned >= MAX_SCAN_MESSAGES,
  };
}

function serializeEvidenceMessage(msg: Message, guild?: Guild) {
  return {
    id: msg.id,
    content: msg.content ? resolveMentionsToText(msg.content, guild) : '',
    createdAt: msg.createdAt.toISOString(),
    attachments: [...msg.attachments.values()].map((attachment) => ({
      url: attachment.url,
      name: attachment.name,
      contentType: attachment.contentType,
      size: attachment.size,
      kind: attachment.contentType?.startsWith('image/')
        ? 'image' as const
        : attachment.contentType?.startsWith('video/')
          ? 'video' as const
          : 'file' as const,
    })),
    embeds: msg.embeds.map((embed) => embedToApiShape(embed, guild)),
    stickers: [...msg.stickers.values()].map((sticker) => ({
      id: sticker.id,
      name: sticker.name,
      url: sticker.url,
    })),
  };
}

function formatSanctionDurationLabel(seconds: number | null): string | null {
  if (!seconds) return null;

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];

  if (days) parts.push(`${days}j`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);

  return parts.length > 0 ? parts.join(' ') : `${seconds}s`;
}

function normalizeBrokenRulesPayload(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      return trimmed;
    }

    const normalized = parsed
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;

        const snapshot = entry as Record<string, unknown>;
        const id = typeof snapshot.id === 'string' ? snapshot.id.trim() : '';
        if (!id) return null;

        const title = typeof snapshot.title === 'string'
          ? snapshot.title.trim()
          : typeof snapshot.label === 'string'
            ? snapshot.label.trim()
            : '';

        const description = typeof snapshot.description === 'string'
          ? snapshot.description.trim()
          : typeof snapshot.details === 'string'
            ? snapshot.details.trim()
            : '';

        if (!title || !description) return null;

        const emoji = typeof snapshot.emoji === 'string' && snapshot.emoji.trim() ? snapshot.emoji.trim() : null;
        const sortOrder = typeof snapshot.sortOrder === 'number' && Number.isFinite(snapshot.sortOrder) ? snapshot.sortOrder : 0;

        return {
          id,
          title,
          description,
          emoji,
          sortOrder,
        };
      })
      .filter((entry): entry is { id: string; title: string; description: string; emoji: string | null; sortOrder: number } => !!entry);

    return normalized.length > 0 ? JSON.stringify(normalized) : trimmed;
  } catch {
    return trimmed;
  }
}

const buildModuleUpdatesForPreset = (presetKey: DashboardPresetKey) => {
  if (presetKey === 'dev') {
    return {
      dailyAlgoEnabled: true,
      codePoliceEnabled: false,
      autoNicknameModerationEnabled: false,
      sanctionSyncEnabled: false,
      translationEnabled: false,
    };
  }
  if (presetKey === 'gaming') {
    return {
      dailyAlgoEnabled: false,
      codePoliceEnabled: true,
      autoNicknameModerationEnabled: true,
      sanctionSyncEnabled: true,
      translationEnabled: true,
    };
  }
  return {
    dailyAlgoEnabled: false,
    codePoliceEnabled: false,
    autoNicknameModerationEnabled: true,
    sanctionSyncEnabled: false,
    translationEnabled: true,
  };
};

const buildCommandRestrictionsForPreset = (
  presetKey: DashboardPresetKey,
  options: {
    moderatorRoleId: string | null;
    adminRoleIds: string[];
    fallbackUserId: string;
    modRoleIds: string[];
  }
) => {
  const list: unknown[] = [];
  const rules = PRESET_COMMAND_OVERRIDES[presetKey] || {};

  const modRole = options.moderatorRoleId ? [options.moderatorRoleId] : options.modRoleIds;
  const adminRoles = options.adminRoleIds;

  const getAuthorizedRoles = (level: CommandAccessLevel): string[] => {
    if (level === 'administration') return adminRoles;
    if (level === 'modération') return [...adminRoles, ...modRole];
    return [];
  };

  const getAuthorizedUsers = (level: CommandAccessLevel): string[] => {
    if (level === 'tout_le_monde') return [];
    return [options.fallbackUserId];
  };

  for (const [cmd, val] of Object.entries(rules)) {
    const lvl = val as CommandAccessLevel;
    list.push({
      commandName: cmd,
      authorizedRoles: getAuthorizedRoles(lvl),
      authorizedUsers: getAuthorizedUsers(lvl),
      bannedUsers: [],
      bannedRoles: [],
      mode: lvl === 'tout_le_monde' ? 'ALLOW_ALL' : 'RESTRICTED',
    });
  }

  return list;
};

export async function handleModulesRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  access: DashboardAccess
): Promise<boolean> {
  const method = req.method;
  const auditUser = user.username ?? `User${user.userId}`;

  // Check sub-routers matching parts[4]
  const moduleKey = parts[4];

  // PUT /api/dashboard/guilds/:guildId/modules/:moduleId
  if (moduleKey === 'modules' && parts.length === 6 && method === 'PUT') {
    const moduleId = parts[5];
    try {
      const body = (await readJsonBody<{ status: ModuleStatus }>(req)) ?? { status: 'inactive' };

      const updates: Record<string, unknown> = {};
      if (moduleId === 'codepolice') updates.codePoliceEnabled = body.status === 'active';
      if (moduleId === 'dailyalgo' || moduleId === 'daily_algo') updates.dailyAlgoEnabled = body.status === 'active';
      if (moduleId === 'traduction' || moduleId === 'translation') updates.translationEnabled = body.status === 'active';
      if (moduleId === 'sanctions') {
        updates.sanctionSyncEnabled = body.status === 'active';
        updates.sanctionReportEnabled = body.status === 'active';
      }
      if (moduleId === 'nickname_moderation') updates.autoNicknameModerationEnabled = body.status === 'active';
      if (moduleId === 'auto_thread') updates.autoThreadEnabled = body.status === 'active';
      if (moduleId === 'fun') updates.funEnabled = body.status === 'active';
      if (moduleId === 'leveling') {
        await prisma.levelConfig.upsert({
          where: { guildId },
          create: { guildId, enabled: body.status === 'active' },
          update: { enabled: body.status === 'active' }
        });
      }

      if (Object.keys(updates).length > 0) {
        await prisma.guild.update({ where: { id: guildId }, data: updates });
      }

      const normalizedKey = moduleId === 'dailyalgo'
        ? 'daily_algo'
        : moduleId === 'traduction'
          ? 'translation'
          : moduleId;
      
      // Mapper l'ID du module vers le nom KotboModule
      const moduleMapping: Record<string, KotboModule> = {
        'codepolice': 'codePolice',
        'daily_algo': 'dailyAlgo',
        'translation': 'translation',
        'sanctions': 'sanction',
        'nickname_moderation': 'nicknameModeration',
        'auto_thread': 'autoThread',
        'fun': 'fun',
        'leveling': 'leveling',
      };
      
      const kotboModuleName = moduleMapping[normalizedKey];
      if (kotboModuleName) {
        await setModuleActivation(guildId, kotboModuleName, body.status === 'active', {
          featureKey: normalizedKey,
        }).catch((err) => {
          logger.warn('ModulesAPI', 'Failed to track module activation:', err);
        });
      }
      
      await prisma.dashboardFeatureConfig.upsert({
        where: { guildId_featureKey: { guildId, featureKey: normalizedKey } },
        create: {
          guildId,
          featureKey: normalizedKey,
          featureName: moduleId.charAt(0).toUpperCase() + moduleId.slice(1),
          enabled: body.status === 'active',
          loggingEnabled: true,
          userActivityTracking: true,
          notifyViaDiscordChannel: true,
        },
        update: {
          enabled: body.status === 'active'
        }
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour module',
        context: getGuildName(client, guildId),
        module: moduleId,
        eventType: 'Manuel',
        details: `Statut changé vers ${body.status}.`,
        channelId: null
      });

      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('ModulesAPI', 'Error updating module:', err);
      json(res, 500, { error: 'Erreur lors de la mise à jour du module' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/presets
  if (moduleKey === 'presets' && parts.length === 5 && method === 'POST') {
    try {
      const body = await readJsonBody<{ presetKey?: string }>(req);
      const presetKey = (body?.presetKey ?? '').trim() as DashboardPresetKey;

      if (!presetKey || !Object.keys(PRESET_LABELS).includes(presetKey)) {
        json(res, 400, { error: 'Preset invalide.' });
        return true;
      }

      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      if (!discordGuild) {
        json(res, 404, { error: 'Serveur introuvable.' });
        return true;
      }

      const member = await discordGuild.members.fetch(user.userId).catch(() => null);
      const roleIds = member
        ? member.roles.cache
            .map((role) => role?.id)
            .filter((roleId): roleId is string => !!roleId)
        : [];
      const featureAccess = await resolveFeatureAccessMap(client, guildId, access, user.userId, roleIds);

      if (!access.canManageSettings && !(featureAccess.modules?.canConfigure && featureAccess.commands?.canConfigure)) {
        json(res, 403, { error: 'Accès refusé. Permissions insuffisantes.' });
        return true;
      }

      const guildConfig = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { moderatorRoleId: true },
      });

      const adminRoleIds = discordGuild.roles.cache
        .filter((role) => !!role && role.permissions.has(PermissionFlagsBits.Administrator))
        .map((role) => role.id);
      const modRoleIds = discordGuild.roles.cache
        .filter((role) => !!role && (role.permissions.has(PermissionFlagsBits.ModerateMembers)
          || role.permissions.has(PermissionFlagsBits.ManageMessages)
          || role.permissions.has(PermissionFlagsBits.KickMembers)
          || role.permissions.has(PermissionFlagsBits.BanMembers)))
        .map((role) => role.id);

      const moduleUpdates = buildModuleUpdatesForPreset(presetKey);
      const commandRestrictions = buildCommandRestrictionsForPreset(presetKey, {
        moderatorRoleId: guildConfig?.moderatorRoleId ?? null,
        adminRoleIds,
        fallbackUserId: user.userId,
        modRoleIds,
      });

      const { applyPresetToFeatureAccess } = await import('../../../services/core/dashboardManagementService.js');
      await applyPresetToFeatureAccess(guildId, presetKey, { adminRoleIds, modRoleIds });

      await prisma.$transaction([
        prisma.guild.update({ where: { id: guildId }, data: moduleUpdates }),
        prisma.dashboardSettings.update({ where: { guildId }, data: { commandRestrictions: commandRestrictions as unknown as Prisma.InputJsonValue } }),
      ]);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Application preset',
        context: getGuildName(client, guildId),
        module: 'Dashboard',
        eventType: 'Manuel',
        details: `Preset appliqué : ${PRESET_LABELS[presetKey]}.`,
        channelId: null,
      });

      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('PresetsAPI', 'Error applying preset:', err);
      json(res, 500, { error: "Erreur lors de l'application du preset" });
    }
    return true;
  }

  // PUT /api/dashboard/guilds/:guildId/sanctions/tables
  if (moduleKey === 'sanctions' && parts.length === 6 && parts[5] === 'tables' && method === 'PUT') {
    try {
      const tables = await readJsonBody<Record<string, unknown>[]>(req);
      if (!Array.isArray(tables)) {
        json(res, 400, { error: 'Payload invalide. Doit être un tableau.' });
        return true;
      }

      if (!access.canManageSettings) {
        json(res, 403, { error: 'Permissions insuffisantes pour modifier la configuration.' });
        return true;
      }

      // La validation ci-dessous produit une structure typee reutilisee plus bas :
      // sans cela, les controles (`typeof table.name === 'string'`...) sont
      // perdus des qu'on change de boucle, et chaque lecture redevient `unknown`.
      type SanctionTierInput = {
        level: number;
        action: SanctionType;
        durationSeconds: number | null;
        customReason: string | null;
      };
      type SanctionTableInput = { id?: string; name: string; tiers: SanctionTierInput[] };

      const validatedTables: SanctionTableInput[] = [];

      for (const table of tables) {
        if (typeof table.name !== 'string' || !table.name.trim()) {
          json(res, 400, { error: 'Chaque tableau doit avoir un nom valide.' });
          return true;
        }
        const tableName = table.name;
        if (!Array.isArray(table.tiers)) {
          json(res, 400, { error: `Le tableau "${tableName}" doit avoir une liste de paliers.` });
          return true;
        }
        const rawTiers = table.tiers as Record<string, unknown>[];
        const levels = rawTiers.map((t) => Number(t.level));
        levels.sort((a, b) => a - b);
        for (let i = 0; i < levels.length; i++) {
          if (levels[i] !== i + 1) {
            json(res, 400, { error: `Les paliers du tableau "${tableName}" doivent être séquentiels et commencer par le niveau 1.` });
            return true;
          }
        }

        const tiers: SanctionTierInput[] = [];
        for (const tier of rawTiers) {
          const action = String(tier.action) as SanctionType;
          if (!['WARN', 'KICK', 'TIMEOUT', 'TEMP_BAN', 'BAN', 'SOFTBAN'].includes(action)) {
            json(res, 400, { error: `Action invalide "${action}" dans le tableau "${tableName}".` });
            return true;
          }
          let durationSeconds: number | null = null;
          if (['TIMEOUT', 'TEMP_BAN'].includes(action)) {
            const secs = Number(tier.durationSeconds);
            if (Number.isNaN(secs) || secs <= 0) {
              json(res, 400, { error: `Le palier de niveau ${tier.level} (${action}) du tableau "${tableName}" requiert une durée positive valide.` });
              return true;
            }
            durationSeconds = secs;
          }
          tiers.push({
            level: Number(tier.level),
            action,
            durationSeconds,
            customReason: typeof tier.customReason === 'string' ? tier.customReason : null,
          });
        }

        validatedTables.push({
          id: typeof table.id === 'string' ? table.id : undefined,
          name: tableName,
          tiers,
        });
      }

      await prisma.$transaction(async (tx) => {
        const existingTables = await tx.sanctionTable.findMany({
          where: { guildId },
          include: { tiers: true },
        });

        const inputIds = new Set(validatedTables.map((t) => t.id).filter(Boolean));
        const tablesToDelete = existingTables.filter((t) => !inputIds.has(t.id));
        if (tablesToDelete.length > 0) {
          await tx.sanctionTable.deleteMany({
            where: { id: { in: tablesToDelete.map((t) => t.id) } },
          });
        }

        for (const table of validatedTables) {
          const matched = table.id ? existingTables.find((t) => t.id === table.id) : undefined;
          // Toujours defini a la sortie du if/else : soit le tableau existait,
          // soit il vient d'etre cree.
          let tableId: string;

          if (matched) {
            tableId = matched.id;
            if (matched.name !== table.name) {
              await tx.sanctionTable.update({
                where: { id: tableId },
                data: { name: table.name.trim() },
              });
            }
            await tx.sanctionTier.deleteMany({
              where: { tableId },
            });
          } else {
            const newTable = await tx.sanctionTable.create({
              data: {
                guildId,
                name: table.name.trim(),
              },
            });
            tableId = newTable.id;
          }

          if (table.tiers.length > 0) {
            await tx.sanctionTier.createMany({
              data: table.tiers.map((tier) => ({
                tableId,
                level: tier.level,
                action: tier.action,
                durationSeconds: tier.durationSeconds,
                customReason: tier.customReason?.trim() || null,
              })),
            });
          }
        }
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour tableaux de sanction',
        context: getGuildName(client, guildId),
        module: 'Sanctions',
        eventType: 'Manuel',
        details: `Les tableaux de sanction ont été reconfigurés.`,
        channelId: null,
      });

      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('SanctionsAPI', 'Error updating sanction tables:', err);
      json(res, 500, { error: 'Erreur lors de la mise à jour des tableaux de sanction' });
    }
    return true;
  }

  // DELETE /api/dashboard/guilds/:guildId/sanctions/:sanctionId
  if (moduleKey === 'sanctions' && parts.length === 6 && method === 'DELETE' && parts[5] !== 'reports') {
    if (access.level !== 'admin') {
      json(res, 403, { error: 'Seuls les administrateurs peuvent supprimer une infraction.' });
      return true;
    }

    const sanctionId = parts[5];
    try {
      const sanction = await prisma.sanction.findFirst({
        where: { id: sanctionId, guildId },
        select: {
          id: true,
          type: true,
          targetTag: true,
          targetUserId: true,
        }
      });

      if (!sanction) {
        json(res, 404, { error: 'Infraction introuvable sur ce serveur.' });
        return true;
      }

      await prisma.sanction.delete({ where: { id: sanction.id } });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Suppression infraction',
        context: getGuildName(client, guildId),
        module: 'Sanctions',
        eventType: 'Manuel',
        details: `Infraction ${sanction.id} supprimée (${sanction.type}) pour ${sanction.targetTag ?? sanction.targetUserId}.`,
        channelId: null
      });

      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('SanctionsAPI', 'Error deleting sanction:', err);
      json(res, 500, { error: "Erreur lors de la suppression de l'infraction" });
    }
    return true;
  }

function verifyMagicBytes(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  }
  if (mimeType === 'image/gif') {
    return buffer.length >= 4 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38;
  }
  if (mimeType === 'image/webp') {
    return buffer.length >= 12 &&
           buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 && // RIFF
           buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50; // WEBP
  }
  if (mimeType === 'application/pdf') {
    return buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46; // %PDF
  }
  if (mimeType === 'video/mp4') {
    return buffer.length >= 8 && buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70; // ftyp
  }
  if (mimeType === 'video/webm') {
    return buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3; // EBML
  }
  if (mimeType === 'video/quicktime') {
    return buffer.length >= 8 && (
      (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) || // ftyp
      (buffer[4] === 0x6d && buffer[5] === 0x6f && buffer[6] === 0x6f && buffer[7] === 0x76) || // moov
      (buffer[4] === 0x6d && buffer[5] === 0x64 && buffer[6] === 0x61 && buffer[7] === 0x74)    // mdat
    );
  }
  return false;
}

  // POST /api/dashboard/guilds/:guildId/sanctions/evidence-files
  if (moduleKey === 'sanctions' && parts.length === 6 && parts[5] === 'evidence-files' && method === 'POST') {
    try {
      const body = await readJsonBody<{
        sanctionId?: string | null;
        fileName?: string;
        mimeType?: string;
        data?: string; // base64 encoded
      }>(req);

      const sanctionId = body?.sanctionId?.trim() || null;
      const fileName = body?.fileName?.trim() || 'unnamed_file';
      const mimeType = body?.mimeType?.trim() || '';
      const dataStr = body?.data || '';

      if (!mimeType || !dataStr) {
        json(res, 400, { error: 'mimeType et data sont requis.' });
        return true;
      }

      // Valider le type MIME
      const allowedMimes = [
        'image/png', 'image/jpeg', 'image/gif', 'image/webp',
        'application/pdf',
        'video/mp4', 'video/webm', 'video/quicktime'
      ];
      if (!allowedMimes.includes(mimeType)) {
        json(res, 400, { error: `Type de fichier non autorisé : ${mimeType}. Veuillez utiliser une image (PNG, JPEG, GIF, WEBP), un PDF ou une vidéo (MP4, WEBM, MOV).` });
        return true;
      }

      // Convertir base64 en buffer et valider la taille
      let buffer: Buffer;
      try {
        buffer = Buffer.from(dataStr, 'base64');
      } catch {
        json(res, 400, { error: 'Données de fichier encodées en base64 invalides.' });
        return true;
      }

      const fileSize = buffer.length;
      if (fileSize > 10 * 1024 * 1024) {
        json(res, 400, { error: 'La taille maximale par fichier est de 10 Mo.' });
        return true;
      }

      // Vérifier les magic bytes
      if (!verifyMagicBytes(buffer, mimeType)) {
        json(res, 400, { error: `La signature du fichier ne correspond pas au type MIME déclaré (${mimeType}).` });
        return true;
      }

      // Si sanctionId est fourni, vérifier qu'elle existe
      if (sanctionId) {
        const sanction = await prisma.sanction.findFirst({
          where: { id: sanctionId, guildId }
        });
        if (!sanction) {
          json(res, 404, { error: 'Sanction liée introuvable.' });
          return true;
        }

        // Limite de 6 fichiers max par sanction
        const existingCount = await prisma.sanctionEvidenceFile.count({
          where: { sanctionId }
        });
        if (existingCount >= 6) {
          json(res, 400, { error: 'Limite de 6 fichiers de preuve par sanction atteinte.' });
          return true;
        }
      }

      // Vérification du quota du serveur (50 Mo cumulés)
      const totalExistingSizeResult = await prisma.sanctionEvidenceFile.aggregate({
        where: { guildId },
        _sum: { size: true }
      });
      const totalExistingSize = totalExistingSizeResult._sum.size ?? 0;
      const limitBytes = 50 * 1024 * 1024; // 50 Mo
      if (totalExistingSize + fileSize > limitBytes) {
        json(res, 400, {
          error: "Quota de stockage de preuves dépassé (50 Mo maximum par serveur). Veuillez passer à une offre payante/premium pour augmenter cette limite.",
          quotaExceeded: true
        });
        return true;
      }

      // Création de l'enregistrement en base
      const file = await prisma.sanctionEvidenceFile.create({
        data: {
          guildId,
          sanctionId,
          fileName,
          mimeType,
          size: fileSize,
          data: new Uint8Array(buffer),
          uploadedByUserId: user.userId
        }
      });

      json(res, 201, { ok: true, id: file.id });
    } catch (err: unknown) {
      logger.error('SanctionsAPI', 'Error uploading evidence file:', err);
      json(res, 500, { error: "Erreur lors de l'upload du fichier de preuve." });
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/sanctions/evidence-files/:fileId/signed-url
  if (moduleKey === 'sanctions' && parts.length === 8 && parts[5] === 'evidence-files' && parts[7] === 'signed-url' && method === 'GET') {
    const fileId = parts[6];
    if (!/^[a-zA-Z0-9_-]+$/.test(fileId)) {
      json(res, 400, { error: 'ID de fichier invalide' });
      return true;
    }
    try {
      const file = await prisma.sanctionEvidenceFile.findFirst({
        where: { id: fileId, guildId },
        select: { id: true }
      });
      if (!file) {
        json(res, 404, { error: 'Fichier introuvable.' });
        return true;
      }
      const { generateEvidenceFileSignature } = await import('@kotbo/core');
      const { expires, signature } = generateEvidenceFileSignature(fileId, 3600);
      const signedUrl = `/api/public/sanction-evidence/${fileId}?expires=${expires}&sig=${signature}`;
      json(res, 200, { signedUrl });
    } catch (err: unknown) {
      logger.error('SanctionsAPI', `Error generating signed evidence URL: ${(err as Error).message}`);
      json(res, 500, { error: 'Erreur lors de la génération du lien signé.' });
    }
    return true;
  }

  // DELETE /api/dashboard/guilds/:guildId/sanctions/evidence-files/:fileId
  if (moduleKey === 'sanctions' && parts.length === 7 && parts[5] === 'evidence-files' && method === 'DELETE') {
    const fileId = parts[6];
    try {
      const file = await prisma.sanctionEvidenceFile.findFirst({
        where: { id: fileId, guildId }
      });
      if (!file) {
        json(res, 404, { error: 'Fichier introuvable.' });
        return true;
      }
      await prisma.sanctionEvidenceFile.delete({ where: { id: fileId } });
      json(res, 200, { ok: true });
    } catch (err: unknown) {
      logger.error('SanctionsAPI', 'Error deleting evidence file:', err);
      json(res, 500, { error: 'Erreur lors de la suppression du fichier.' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/sanctions/reports
  if (moduleKey === 'sanctions' && parts.length === 6 && parts[5] === 'reports' && method === 'POST') {
    try {
      const body = await readJsonBody<{
        sanctionId?: string | null;
        staffPseudo?: string;
        incidentAt?: string;
        memberPseudo?: string;
        memberReference?: string;
        sanctionType?: string;
        sanctionDurationLabel?: string | null;
        brokenRules?: string;
        detailedReason?: string;
        evidenceLinks?: unknown;
        additionalNotes?: string | null;
      }>(req);

      const sanctionId = body?.sanctionId?.trim() ?? '';
      const brokenRules = normalizeBrokenRulesPayload(body?.brokenRules?.trim() ?? '');
      const detailedReason = body?.detailedReason?.trim() ?? '';
      const evidenceLinks = parseEvidenceLinks(body?.evidenceLinks);
      const incidentAt = body?.incidentAt ? new Date(body.incidentAt) : null;

      if (!sanctionId) {
        json(res, 400, { error: 'La sanction liée est obligatoire pour créer un rapport.' });
        return true;
      }

      if (!incidentAt || Number.isNaN(incidentAt.getTime())) {
        json(res, 400, { error: "Date/heure de l'incident invalide." });
        return true;
      }

      if (evidenceLinks.length === 0) {
        json(res, 400, { error: 'Au moins un lien de preuve valide est obligatoire.' });
        return true;
      }

      const sanction = await prisma.sanction.findFirst({ where: { id: sanctionId, guildId } });
      if (!sanction) {
        json(res, 404, { error: 'Sanction liée introuvable sur ce serveur.' });
        return true;
      }

      if (sanction.moderatorUserId !== user.userId) {
        json(res, 403, { error: 'Seule la personne qui a appliqué la sanction peut créer ce rapport.' });
        return true;
      }

      const existingReport = await prisma.sanctionReport.findFirst({ where: { guildId, sanctionId } });
      if (existingReport) {
        json(res, 409, { error: 'Un rapport existe déjà pour cette sanction.' });
        return true;
      }

      const staffPseudo = sanction.moderatorTag?.trim() || body?.staffPseudo?.trim() || getAuditActor(user);
      const memberPseudo = sanction.targetTag?.trim() || body?.memberPseudo?.trim() || `Utilisateur ${sanction.targetUserId}`;
      const memberReference = sanction.targetUserId?.trim() || body?.memberReference?.trim() || sanction.targetUserId;
      const sanctionTypeRaw = sanction.type as DashboardSanctionType;
      const sanctionDurationLabel = body?.sanctionDurationLabel?.trim() || formatSanctionDurationLabel(sanction.durationSeconds);
      const finalIncidentAt = Number.isNaN(incidentAt.getTime()) ? sanction.createdAt : incidentAt;
      const finalBrokenRules = brokenRules || sanction.reason;
      const finalDetailedReason = detailedReason || sanction.reason;

      if (!finalBrokenRules || !finalDetailedReason) {
        json(res, 400, { error: 'Les champs de contenu du rapport sont obligatoires.' });
        return true;
      }

      const report = await prisma.sanctionReport.create({
        data: {
          guildId,
          sanctionId,
          staffPseudo,
          incidentAt: finalIncidentAt,
          memberPseudo,
          memberReference,
          sanctionType: toSanctionType(sanctionTypeRaw),
          sanctionDurationLabel,
          brokenRules: finalBrokenRules,
          detailedReason: finalDetailedReason,
          evidenceLinks,
          additionalNotes: body?.additionalNotes?.trim() || null,
          createdByUserId: user.userId,
          createdByTag: user.username ?? null,
        }
      });

      // Synchronize reports for linked alt accounts
      const altAccountService = await import('../../../services/moderation/altAccountService.js');
      await altAccountService.syncAltAccountSanctionReports(guildId, sanctionId, evidenceLinks, report).catch((err) => {
        logger.error('SanctionsAPI', 'Error synchronizing report to alt accounts (POST):', err);
      });

      const { announceSanctionReportToStaff } = await import('../../../services/moderation/sanctionService.js');
      await announceSanctionReportToStaff(client, report).catch((err) => {
        logger.warn('SanctionsAPI', `Impossible d'annoncer le rapport ${report.id} sur le serveur staff :`, err);
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Création rapport sanction',
        context: getGuildName(client, guildId),
        module: 'Sanctions',
        eventType: 'Manuel',
        details: `Rapport ${report.id} créé pour ${memberPseudo} (${sanctionTypeRaw}).`,
        channelId: null
      });

      json(res, 201, { ok: true, reportId: report.id });
    } catch (err) {
      logger.error('SanctionsAPI', 'Error creating report:', err);
      json(res, 500, { error: 'Erreur lors de la création du rapport' });
    }
    return true;
  }

  // PATCH /api/dashboard/guilds/:guildId/sanctions/reports/:reportId
  if (moduleKey === 'sanctions' && parts.length === 7 && parts[5] === 'reports' && method === 'PATCH') {
    const reportId = parts[6];
    try {
      const existingReport = await prisma.sanctionReport.findFirst({
        where: { id: reportId, guildId }
      });

      if (!existingReport) {
        json(res, 404, { error: 'Rapport introuvable.' });
        return true;
      }

      if (existingReport.createdByUserId !== user.userId && access.level !== 'admin') {
        json(res, 403, { error: "Seul l'auteur du rapport ou un administrateur peut le modifier." });
        return true;
      }

      const body = await readJsonBody<{
        brokenRules?: string;
        detailedReason?: string;
        evidenceLinks?: unknown;
        additionalNotes?: string | null;
      }>(req);

      const updatedBrokenRules = body?.brokenRules !== undefined 
        ? normalizeBrokenRulesPayload(body.brokenRules.trim()) 
        : existingReport.brokenRules;
      
      const updatedDetailedReason = body?.detailedReason !== undefined
        ? body.detailedReason.trim()
        : existingReport.detailedReason;

      const updatedEvidenceLinks = body?.evidenceLinks !== undefined
        ? parseEvidenceLinks(body.evidenceLinks)
        : parseEvidenceLinks(existingReport.evidenceLinks);

      const updatedAdditionalNotes = body?.additionalNotes !== undefined
        ? body.additionalNotes?.trim() || null
        : existingReport.additionalNotes;

      if (!updatedBrokenRules || !updatedDetailedReason) {
        json(res, 400, { error: 'Les champs de contenu du rapport sont obligatoires.' });
        return true;
      }

      if (Array.isArray(updatedEvidenceLinks) && updatedEvidenceLinks.length === 0) {
        json(res, 400, { error: 'Au moins un lien de preuve valide est obligatoire.' });
        return true;
      }

      const updatedReport = await prisma.sanctionReport.update({
        where: { id: reportId },
        data: {
          brokenRules: updatedBrokenRules,
          detailedReason: updatedDetailedReason,
          evidenceLinks: updatedEvidenceLinks,
          additionalNotes: updatedAdditionalNotes,
        }
      });

      // Synchronize reports for linked alt accounts
      if (updatedReport.sanctionId) {
        const altAccountService = await import('../../../services/moderation/altAccountService.js');
        await altAccountService.syncAltAccountSanctionReports(guildId, updatedReport.sanctionId, updatedEvidenceLinks, updatedReport).catch((err) => {
          logger.error('SanctionsAPI', 'Error synchronizing report to alt accounts (PATCH):', err);
        });
      }

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Modification rapport sanction',
        context: getGuildName(client, guildId),
        module: 'Sanctions',
        eventType: 'Manuel',
        details: `Rapport ${reportId} modifié par ${user.username ?? user.userId}.`,
        channelId: null
      });

      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('SanctionsAPI', 'Error patching report:', err);
      json(res, 500, { error: 'Erreur lors de la modification du rapport' });
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/sanctions/reports/discord-messages
  if (moduleKey === 'sanctions' && parts.length === 7 && parts[5] === 'reports' && parts[6] === 'discord-messages' && method === 'GET') {
    try {
      const sanctionId = url.searchParams.get('sanctionId')?.trim() ?? '';
      const requestedLimit = Number.parseInt(url.searchParams.get('limit') ?? '', 10);
      const messageLimit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), MAX_EVIDENCE_MESSAGES)
        : 50;

      if (!sanctionId) {
        json(res, 400, { error: 'sanctionId est obligatoire.' });
        return true;
      }

      const sanction = await prisma.sanction.findFirst({ where: { id: sanctionId, guildId } });
      if (!sanction) {
        json(res, 404, { error: 'Sanction introuvable sur ce serveur.' });
        return true;
      }

      if (sanction.moderatorUserId !== user.userId && access.level !== 'admin') {
        json(res, 403, { error: 'Seule la personne qui a appliqué la sanction peut importer des preuves.' });
        return true;
      }

      const guild = client.guilds.cache.get(guildId);
      if (!guild) {
        json(res, 404, { error: 'Serveur Discord introuvable.' });
        return true;
      }

      const me = guild.members.me;
      const searchableChannels = [...guild.channels.cache.values()].filter((channel): channel is TextChannel => {
        if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) {
          return false;
        }
        return Boolean(me && channel.permissionsFor(me).has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.ReadMessageHistory,
        ]));
      });

      const concurrencyLimit = pLimit(EVIDENCE_CHANNEL_CONCURRENCY);
      let failedChannelCount = 0;
      const fetchedChannels: Array<FetchedEvidenceChannel | null> = await Promise.all(
        searchableChannels.map((channel) => concurrencyLimit(async (): Promise<FetchedEvidenceChannel | null> => {
          try {
            const { messages, truncated } = await fetchUserMessagesInChannel(channel, sanction.targetUserId, messageLimit);
            return {
              channelId: channel.id,
              channelName: channel.name,
              rawMessages: messages,
              truncated,
            };
          } catch (err) {
            failedChannelCount++;
            logger.error('SanctionsAPI', `Error fetching evidence messages for channel ${channel.id}:`, err);
            return null;
          }
        })),
      );

      const successfulChannels = fetchedChannels.filter(
        (channel): channel is FetchedEvidenceChannel => channel !== null,
      );

      const newestMessages = successfulChannels
        .flatMap((channel) => channel.rawMessages.map((message) => ({ channel, message })))
        .sort((a, b) => b.message.createdTimestamp - a.message.createdTimestamp)
        .slice(0, messageLimit);

      const includedMessageIds = new Set(newestMessages.map(({ message }) => message.id));
      const channels = successfulChannels
        .map((channel) => ({
          channelId: channel.channelId,
          channelName: channel.channelName,
          messages: channel.rawMessages
            .filter((message) => includedMessageIds.has(message.id))
            .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
            .map((message) => serializeEvidenceMessage(message, guild)),
          truncated: channel.truncated,
        }))
        .filter((channel) => channel.messages.length > 0)
        .sort((a, b) => a.channelName.localeCompare(b.channelName, 'fr'));

      json(res, 200, {
        targetTag: sanction.targetTag,
        channels,
        messageCount: newestMessages.length,
        searchedChannelCount: searchableChannels.length,
        failedChannelCount,
        truncatedChannelCount: successfulChannels.filter((channel) => channel.truncated).length,
      });
    } catch (err) {
      logger.error('SanctionsAPI', 'Error listing discord evidence messages:', err);
      json(res, 500, { error: 'Erreur lors de la récupération des messages Discord' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/sanctions/reports/discord-transcripts
  if (moduleKey === 'sanctions' && parts.length === 7 && parts[5] === 'reports' && parts[6] === 'discord-transcripts' && method === 'POST') {
    try {
      const body = await readJsonBody<{
        sanctionId?: string;
        selections?: Array<{ channelId?: string; messageIds?: string[] }>;
      }>(req);

      const sanctionId = body?.sanctionId?.trim() ?? '';
      if (!sanctionId) {
        json(res, 400, { error: 'sanctionId est obligatoire.' });
        return true;
      }

      const selections = Array.isArray(body?.selections) ? body.selections : [];
      if (selections.length === 0) {
        json(res, 400, { error: 'Aucun message sélectionné.' });
        return true;
      }

      const totalSelectedMessages = selections.reduce((total, selection) => (
        total + (Array.isArray(selection?.messageIds) ? selection.messageIds.length : 0)
      ), 0);
      if (totalSelectedMessages > MAX_EVIDENCE_MESSAGES) {
        json(res, 400, { error: `Maximum ${MAX_EVIDENCE_MESSAGES} messages par transcription.` });
        return true;
      }

      const sanction = await prisma.sanction.findFirst({ where: { id: sanctionId, guildId } });
      if (!sanction) {
        json(res, 404, { error: 'Sanction introuvable sur ce serveur.' });
        return true;
      }

      if (sanction.moderatorUserId !== user.userId && access.level !== 'admin') {
        json(res, 403, { error: 'Seule la personne qui a appliqué la sanction peut importer des preuves.' });
        return true;
      }

      const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';
      const results: Array<{ channelId: string; channelName: string; url: string; count: number }> = [];
      const errors: Array<{ channelId: string; error: string }> = [];

      await Promise.all(selections.map(async (selection) => {
        const channelId = selection?.channelId?.trim() ?? '';
        const messageIds = Array.isArray(selection?.messageIds)
          ? [...new Set(selection.messageIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0))]
          : [];

        if (!channelId || messageIds.length === 0) {
          errors.push({ channelId: channelId || 'inconnu', error: 'Sélection invalide.' });
          return;
        }
        const resolved = await resolveEvidenceChannel(client, guildId, channelId);
        if ('error' in resolved) {
          errors.push({ channelId, error: resolved.error });
          return;
        }

        try {
          const fetched = await Promise.all(messageIds.map((id) => resolved.channel.messages.fetch(id).catch(() => null)));
          const validMessages = fetched.filter((msg): msg is Message<true> => msg !== null && msg.author.id === sanction.targetUserId);

          if (validMessages.length === 0) {
            errors.push({ channelId, error: 'Aucun message valide à transcrire.' });
            return;
          }

          validMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
          const transcript = await generateTranscriptFromMessages(resolved.channel, validMessages);

          await pushAudit(guildId, {
            user: auditUser,
            action: 'Génération transcription (preuve sanction)',
            context: getGuildName(client, guildId),
            module: 'Sanctions',
            eventType: 'Manuel',
            details: `Transcription ${transcript.id} générée pour #${resolved.channel.name} (${transcript.count} messages, sanction ${sanctionId}).`,
            channelId: resolved.channel.id
          });

          results.push({
            channelId,
            channelName: resolved.channel.name,
            url: `${dashboardUrl}${transcript.url}`,
            count: transcript.count,
          });
        } catch (err) {
          logger.error('SanctionsAPI', `Error generating evidence transcript for channel ${channelId}:`, err);
          errors.push({ channelId, error: 'Erreur lors de la génération de la transcription.' });
        }
      }));

      json(res, 200, { results, errors });
    } catch (err) {
      logger.error('SanctionsAPI', 'Error generating discord evidence transcripts:', err);
      json(res, 500, { error: 'Erreur lors de la génération des transcriptions' });
    }
    return true;
  }

  // GET/PATCH /api/dashboard/guilds/:guildId/nickname-moderation
  if (moduleKey === 'nickname-moderation' && parts.length === 5) {
    if (method === 'GET') {
      try {
        const guild = await prisma.guild.findUnique({
          where: { id: guildId },
          select: {
            autoNicknameModerationEnabled: true,
            nicknameModerationWhitelist: true,
            nicknameModerationBypass: true,
            nickModOnJoin: true,
            nickModOnUpdate: true,
            nickModCheckInvisible: true,
            nickModCheckGlobal: true,
            nickModCheckCustom: true,
            nickModDiscordAutoModSync: true,
          },
        }).catch(async (dbErr) => {
          logger.warn('NicknameAPI', 'Failed to fetch bypass list, retrying without it:', dbErr);
          return prisma.guild.findUnique({
            where: { id: guildId },
            select: {
              autoNicknameModerationEnabled: true,
              nicknameModerationWhitelist: true,
            },
          });
        });
        if (!guild) {
          json(res, 404, { error: 'Serveur introuvable' });
          return true;
        }
        // Le repli ci-dessus ne selectionne que deux colonnes (base pas encore
        // migree) : les autres sont donc optionnelles a la lecture.
        const nickConfig = guild as typeof guild & Partial<{
          nicknameModerationBypass: string[];
          nickModOnJoin: boolean;
          nickModOnUpdate: boolean;
          nickModCheckInvisible: boolean;
          nickModCheckGlobal: boolean;
          nickModCheckCustom: boolean;
          nickModDiscordAutoModSync: boolean;
        }>;
        json(res, 200, {
          enabled: guild.autoNicknameModerationEnabled,
          whitelist: guild.nicknameModerationWhitelist,
          bypass: nickConfig.nicknameModerationBypass ?? [],
          onJoin: nickConfig.nickModOnJoin ?? true,
          onUpdate: nickConfig.nickModOnUpdate ?? true,
          checkInvisible: nickConfig.nickModCheckInvisible ?? true,
          checkGlobal: nickConfig.nickModCheckGlobal ?? true,
          checkCustom: nickConfig.nickModCheckCustom ?? true,
          discordAutoModSync: nickConfig.nickModDiscordAutoModSync ?? false,
        });
      } catch (err) {
        logger.error('NicknameAPI', 'GET nickname-moderation error:', err);
        json(res, 500, { error: 'Erreur lors de la récupération de la configuration' });
      }
      return true;
    }

    if (method === 'PATCH') {
      try {
        const body = await readJsonBody<{ enabled?: boolean; whitelist?: string[]; bypass?: string[]; onJoin?: boolean; onUpdate?: boolean; checkInvisible?: boolean; checkGlobal?: boolean; checkCustom?: boolean; discordAutoModSync?: boolean }>(req);

        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          json(res, 400, { error: 'Payload invalide' });
          return true;
        }

        const allowedFields = new Set([
          'enabled',
          'whitelist',
          'bypass',
          'onJoin',
          'onUpdate',
          'checkInvisible',
          'checkGlobal',
          'checkCustom',
          'discordAutoModSync',
        ]);
        const unknownFields = Object.keys(body).filter((key) => !allowedFields.has(key));
        if (unknownFields.length > 0) {
          json(res, 400, { error: `Champs inconnus : ${unknownFields.join(', ')}` });
          return true;
        }

        const updateData: Record<string, unknown> = {};
        if (body && Object.prototype.hasOwnProperty.call(body, 'enabled')) {
          if (typeof body.enabled !== 'boolean') {
            json(res, 400, { error: 'Le champ enabled doit être un booléen' });
            return true;
          }
          updateData.autoNicknameModerationEnabled = body.enabled;
        }
        // Toggles granulaires
        const toggleFields = [
          { key: 'onJoin', dbKey: 'nickModOnJoin' },
          { key: 'onUpdate', dbKey: 'nickModOnUpdate' },
          { key: 'checkInvisible', dbKey: 'nickModCheckInvisible' },
          { key: 'checkGlobal', dbKey: 'nickModCheckGlobal' },
          { key: 'checkCustom', dbKey: 'nickModCheckCustom' },
          { key: 'discordAutoModSync', dbKey: 'nickModDiscordAutoModSync' },
        ] as const;
        for (const { key, dbKey } of toggleFields) {
          if (body && Object.prototype.hasOwnProperty.call(body, key)) {
            if (typeof body[key] !== 'boolean') {
              json(res, 400, { error: `Le champ ${key} doit être un booléen` });
              return true;
            }
            updateData[dbKey] = body[key];
          }
        }
        if (body && Object.prototype.hasOwnProperty.call(body, 'whitelist')) {
          if (!Array.isArray(body.whitelist) || body.whitelist.some(item => typeof item !== 'string')) {
            json(res, 400, { error: 'Format whitelist invalide (doit être un tableau de chaînes)' });
            return true;
          }
          const cleanedWhitelist = [...new Set(body.whitelist.map((w: string) => w.trim().toLowerCase()).filter(Boolean))];
          if (cleanedWhitelist.length > 250) {
            json(res, 400, { error: 'La whitelist ne peut pas contenir plus de 250 pseudos' });
            return true;
          }
          if (cleanedWhitelist.some(w => w.length > 32)) {
            json(res, 400, { error: 'Les pseudos autorisés ne peuvent pas dépasser 32 caractères' });
            return true;
          }
          updateData.nicknameModerationWhitelist = cleanedWhitelist;
        }
        if (body && Object.prototype.hasOwnProperty.call(body, 'bypass')) {
          if (!Array.isArray(body.bypass) || body.bypass.some(item => typeof item !== 'string')) {
            json(res, 400, { error: 'Format bypass invalide (doit être un tableau de chaînes)' });
            return true;
          }
          const cleanedBypass = [...new Set(body.bypass.map((id: string) => id.trim()).filter(Boolean))];
          if (cleanedBypass.length > 250) {
            json(res, 400, { error: 'La liste des membres exemptés ne peut pas contenir plus de 250 IDs' });
            return true;
          }
          if (cleanedBypass.some(id => !/^\d{17,20}$/.test(id))) {
            json(res, 400, { error: 'Format bypass invalide : certains IDs sont incorrects (doivent être de 17 à 20 chiffres)' });
            return true;
          }
          updateData.nicknameModerationBypass = cleanedBypass;
        }

        if (Object.keys(updateData).length === 0) {
          json(res, 400, { error: 'Payload invalide — aucun champ à mettre à jour fourni' });
          return true;
        }

        if (updateData.nicknameModerationWhitelist) {
          const activeBannedWords = await prisma.bannedWord.findMany({
            where: {
              guildId,
              enabled: true,
            },
            select: { word: true },
          });
          const bannedSet = new Set(
            activeBannedWords.map((b) => b.word.trim().toLowerCase())
          );

          const whitelistToCheck = (updateData.nicknameModerationWhitelist ?? []) as string[];
          const invalidItems = whitelistToCheck.filter((item) => bannedSet.has(item));
          if (invalidItems.length > 0) {
            json(res, 400, {
              error: `Impossible d'autoriser ces pseudos car ils font partie de la liste des mots bannis personnalisés : ${invalidItems.join(', ')}`,
            });
            return true;
          }
        }

        await prisma.guild.update({
          where: { id: guildId },
          data: updateData,
        });

        invalidateNicknameModerationCache(guildId);

        // La configuration locale est déjà persistée. La synchronisation Discord
        // reste best-effort et ne doit pas bloquer la réponse HTTP ni figer les
        // boutons du dashboard quand Discord répond lentement.
        void import('../../../services/moderation/autoModService.js')
          .then(({ syncDiscordAutoModProfileRule }) => syncDiscordAutoModProfileRule(client, guildId))
          .catch((syncErr) => {
            logger.error('NicknameAPI', `Erreur lors de la synchronisation AutoMod Pseudos pour ${guildId}:`, syncErr);
          });

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Mise à jour modération pseudos',
          context: getGuildName(client, guildId),
          module: 'Modération des pseudos',
          eventType: 'Manuel',
          details: `Modifications appliquées: ${Object.keys(updateData).join(', ')}`,
          channelId: null,
        });

        broadcastDashboardStateChange(guildId, 'nickname_moderation_updated');

        json(res, 200, { ok: true });
      } catch (err) {
        logger.error('NicknameAPI', 'PATCH nickname-moderation error:', err);
        json(res, 500, { error: 'Erreur lors de la mise à jour' });
      }
      return true;
    }
  }

  // GET /api/dashboard/guilds/:guildId/modules/stats - Module statistics
  if (moduleKey === 'modules' && parts.length === 6 && parts[5] === 'stats' && method === 'GET') {
    try {
      const moduleName = (url.searchParams.get('moduleName') as KotboModule | null) ?? undefined;
      const startDate = url.searchParams.get('startDate') || undefined;
      const endDate = url.searchParams.get('endDate') || undefined;
      const periodDays = url.searchParams.get('period') ? parseInt(url.searchParams.get('period')!) : 30;
      const summary = url.searchParams.get('summary') === 'true';

      if (summary) {
        const data = await getModuleStatsSummary({ guildId, periodDays });
        json(res, 200, data);
      } else {
        const [activation, usage, performance] = await Promise.all([
          getModuleActivationStats(guildId),
          getModuleUsageStats({ guildId, moduleName, startDate, endDate, periodDays }),
          getModulePerformanceStats({ guildId, moduleName, startDate, endDate, periodDays }),
        ]);

        json(res, 200, {
          modules: KOTBO_MODULES,
          activation,
          usage,
          performance,
        });
      }
    } catch (err) {
      logger.error('ModulesAPI', 'Error fetching module stats:', err);
      json(res, 500, { error: 'Erreur interne du serveur' });
    }
    return true;
  }

  // GET/PATCH /api/dashboard/guilds/:guildId/auto-thread
  if (moduleKey === 'auto-thread' && parts.length === 5) {
    if (method === 'GET') {
      try {
        const guild = await prisma.guild.findUnique({
          where: { id: guildId },
          select: { autoThreadEnabled: true, autoThreadChannels: true, autoThreadBotsEnabled: true },
        });
        if (!guild) {
          json(res, 404, { error: 'Serveur introuvable' });
          return true;
        }
        json(res, 200, { enabled: guild.autoThreadEnabled, channels: guild.autoThreadChannels, botsEnabled: guild.autoThreadBotsEnabled });
      } catch (err) {
        logger.error('AutoThreadAPI', 'GET auto-thread error:', err);
        json(res, 500, { error: 'Erreur lors de la récupération de la configuration' });
      }
      return true;
    }

    if (method === 'PATCH') {
      try {
        const body = await readJsonBody<{ enabled?: boolean; channels?: string[]; botsEnabled?: boolean }>(req);
        if (!body) {
          json(res, 400, { error: 'Payload settings invalide' });
          return true;
        }

        const data: Record<string, unknown> = {};
        if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
          data.autoThreadEnabled = !!body.enabled;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'channels')) {
          data.autoThreadChannels = body.channels;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'botsEnabled')) {
          data.autoThreadBotsEnabled = !!body.botsEnabled;
        }

        await prisma.guild.update({
          where: { id: guildId },
          data,
        });

        if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
          await prisma.dashboardFeatureConfig.upsert({
            where: { guildId_featureKey: { guildId, featureKey: 'auto_thread' } },
            create: {
              guildId,
              featureKey: 'auto_thread',
              featureName: 'Auto-Thread',
              enabled: !!body.enabled,
              loggingEnabled: true,
              userActivityTracking: true,
              notifyViaDiscordChannel: true,
            },
            update: {
              enabled: !!body.enabled
            }
          });
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Sauvegarde configuration Auto-Thread',
          context: getGuildName(client, guildId),
          module: 'Auto-Thread',
          eventType: 'Manuel',
          details: `Configuration Auto-Thread mise à jour (salons: ${body.channels?.length ?? 0}).`,
          channelId: null
        });

        json(res, 200, { ok: true });
      } catch (err) {
        logger.error('AutoThreadAPI', 'PATCH auto-thread error:', err);
        json(res, 500, { error: 'Erreur lors de la mise à jour' });
      }
      return true;
    }
  }

  // POST /api/dashboard/guilds/:guildId/channels-management/rescan-stats
  if (moduleKey === 'channels-management' && parts.length === 6 && parts[5] === 'rescan-stats' && method === 'POST') {
    try {
      const body = await readJsonBody<{ force?: boolean; forcer?: boolean }>(req);
      const force = !!(body?.force || body?.forcer);

      const { startHistoricalScraping } = await import('../../../services/analytics/messageScraperService.js');
      await startHistoricalScraping(client, guildId, force);

      json(res, 200, { ok: true, message: 'Scraping historique lancé avec succès.' });
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'POST rescan-stats error:', err);
      json(res, 500, { error: 'Erreur lors du lancement du scraping' });
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/channels-management/temp-voice/channels
  if (moduleKey === 'channels-management' && parts.length === 7 && parts[5] === 'temp-voice' && parts[6] === 'channels' && method === 'GET') {
    try {
      const dbChannels = await prisma.tempVoiceChannel.findMany({
        where: { guildId }
      });

      const discordGuild = client.guilds.cache.get(guildId);
      const activeChannels = [];

      for (const dbChan of dbChannels) {
        const channel = discordGuild?.channels.cache.get(dbChan.id);
        if (channel && channel.type === ChannelType.GuildVoice) {
          const creatorMember = discordGuild ? await discordGuild.members.fetch(dbChan.creatorId).catch(() => null) : null;
          activeChannels.push({
            id: dbChan.id,
            name: channel.name,
            creatorId: dbChan.creatorId,
            creatorName: creatorMember?.displayName || 'Inconnu',
            creatorAvatar: creatorMember?.user.displayAvatarURL() || null,
            membersCount: channel.members.size,
            roleId: dbChan.roleId,
            createdAt: dbChan.createdAt
          });
        } else {
          // Clean up stale database entry
          await prisma.tempVoiceChannel.delete({ where: { id: dbChan.id } }).catch(() => null);
        }
      }

      json(res, 200, activeChannels);
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'GET active channels error:', err);
      json(res, 500, { error: 'Erreur lors du chargement des salons actifs.' });
    }
    return true;
  }

  // PATCH /api/dashboard/guilds/:guildId/channels-management/temp-voice/channels/:channelId
  if (moduleKey === 'channels-management' && parts.length === 8 && parts[5] === 'temp-voice' && parts[6] === 'channels' && method === 'PATCH') {
    const channelId = parts[7];
    try {
      const body = await readJsonBody<{ name?: string; roleId?: string | null; action?: 'DELETE' }>(req);
      const discordGuild = client.guilds.cache.get(guildId);
      const channel = discordGuild?.channels.cache.get(channelId);

      if (!channel || channel.type !== ChannelType.GuildVoice) {
        json(res, 404, { error: 'Salon introuvable.' });
        return true;
      }

      const dbChan = await prisma.tempVoiceChannel.findUnique({
        where: { id: channelId }
      });

      if (!dbChan) {
        json(res, 404, { error: 'Salon non enregistré.' });
        return true;
      }

      // 1. Action Delete
      if (body?.action === 'DELETE') {
        // Disconnect members
        for (const [_, member] of channel.members) {
          await member.voice.disconnect('Salon temporaire fermé via le dashboard.').catch(() => null);
        }
        await channel.delete('Fermé par le dashboard.').catch(() => null);
        await prisma.tempVoiceChannel.delete({ where: { id: channelId } }).catch(() => null);

        // Also clean up from local memory cache
        const { tempChannels } = await import('../../../events/tempVoice.js');
        tempChannels.delete(channelId);

        await pushAudit(guildId, {
          user: auditUser,
          action: `Fermeture forcée du salon temporaire ${channel.name}`,
          context: getGuildName(client, guildId),
          module: 'Gestion des salons',
          eventType: 'Manuel',
          details: `Salon temporaire ${channel.name} (${channelId}) supprimé par l'administrateur.`,
          channelId: null
        });

        json(res, 200, { ok: true, message: 'Salon fermé avec succès.' });
        return true;
      }

      // 2. Action Update (Rename/Reserve)
      const data: Record<string, unknown> = {};

      if (body?.name !== undefined && body.name.trim() !== '') {
        const newName = body.name.trim();
        await channel.setName(newName).catch(() => null);
        await pushAudit(guildId, {
          user: auditUser,
          action: `Renommer salon temporaire ${channel.name} -> ${newName}`,
          context: getGuildName(client, guildId),
          module: 'Gestion des salons',
          eventType: 'Manuel',
          details: `Renommé de ${channel.name} à ${newName}.`,
          channelId: null
        });
      }

      if (body?.roleId !== undefined) {
        const newRoleId = body.roleId; // string | null

        if (newRoleId) {
          // Deny everyone connect
          await channel.permissionOverwrites.edit(guildId, {
            Connect: false
          }).catch(() => null);

          // Allow creator
          await channel.permissionOverwrites.edit(dbChan.creatorId, {
            Connect: true,
            ViewChannel: true,
            Speak: true
          }).catch(() => null);

          // Allow role
          await channel.permissionOverwrites.edit(newRoleId, {
            Connect: true,
            ViewChannel: true,
            Speak: true
          }).catch(() => null);

          data.roleId = newRoleId;
        } else {
          // Clear role connect restriction, revert back to general connect permission for everyone
          await channel.permissionOverwrites.edit(guildId, {
            Connect: true
          }).catch(() => null);

          data.roleId = null;
        }

        await prisma.tempVoiceChannel.update({
          where: { id: channelId },
          data
        });

        await pushAudit(guildId, {
          user: auditUser,
          action: newRoleId ? `Réservation du salon ${channel.name} pour le rôle ID ${newRoleId}` : `Libération de la réservation du salon ${channel.name}`,
          context: getGuildName(client, guildId),
          module: 'Gestion des salons',
          eventType: 'Manuel',
          details: newRoleId ? `Accès restreint au rôle ${newRoleId}.` : `Salon ouvert à tous.`,
          channelId: null
        });
      }

      json(res, 200, { ok: true, message: 'Salon mis à jour avec succès.' });
    } catch (err) {
      logger.error('ChannelsManagementAPI', 'PATCH active channel error:', err);
      json(res, 500, { error: 'Erreur lors du mise à jour du salon.' });
    }
    return true;
  }

  // GET/PATCH /api/dashboard/guilds/:guildId/channels-management
  if (moduleKey === 'channels-management' && parts.length === 5) {
    if (method === 'GET') {
      try {
        const guild = await prisma.guild.findUnique({
          where: { id: guildId },
          select: {
            autoThreadEnabled: true,
            autoThreadChannels: true,
            autoThreadBotsEnabled: true,
            statsEnabled: true,
            statsConfig: true,
            tempVoiceEnabled: true,
            tempVoiceChannelId: true,
            tempVoiceCategoryId: true,
            tempVoiceNameTemplate: true,
            tempVoiceRequiredRoleId: true,
            tempVoiceGenerators: true,
            honeypotEnabled: true,
            honeypotChannelId: true,
            honeypotSanction: true,
            honeypotReinvite: true,
            verificationEnabled: true,
            verificationMode: true,
            verificationAction: true,
            verificationChannelId: true,
            verificationFallbackChannelId: true,
            verificationRoleId: true,
            verificationLogChannelId: true,
            verificationEmbedTitle: true,
            verificationEmbedDesc: true,
            verificationEmbedColor: true,
            verificationOnJoin: true,
            verificationSaveIp: true,
            verificationSaveDevice: true,
            verificationLevelCommand: true,
            verificationLevelJoin: true,
            verificationWarnThreshold: true,
            verificationWarnAutoMode: true,
            verificationWarnReason: true,
            warnWeightingEnabled: true,
            warnDecayDays: true,
            wordStatsEnabled: true,
            banHygieneEnabled: true,
          },
        });
        if (!guild) {
          json(res, 404, { error: 'Serveur introuvable' });
          return true;
        }
        json(res, 200, {
          autoThreadEnabled: guild.autoThreadEnabled,
          autoThreadChannels: guild.autoThreadChannels,
          autoThreadBotsEnabled: guild.autoThreadBotsEnabled,
          statsEnabled: guild.statsEnabled,
          statsConfig: guild.statsConfig,
          tempVoiceEnabled: guild.tempVoiceEnabled,
          tempVoiceChannelId: guild.tempVoiceChannelId,
          tempVoiceCategoryId: guild.tempVoiceCategoryId,
          tempVoiceNameTemplate: guild.tempVoiceNameTemplate,
          tempVoiceRequiredRoleId: guild.tempVoiceRequiredRoleId,
          tempVoiceGenerators: guild.tempVoiceGenerators,
          honeypotEnabled: guild.honeypotEnabled,
          honeypotChannelId: guild.honeypotChannelId,
          honeypotSanction: guild.honeypotSanction,
          honeypotReinvite: guild.honeypotReinvite,
          verificationEnabled: guild.verificationEnabled,
          verificationMode: guild.verificationMode,
          verificationAction: guild.verificationAction,
          verificationChannelId: guild.verificationChannelId,
          verificationFallbackChannelId: guild.verificationFallbackChannelId,
          verificationRoleId: guild.verificationRoleId,
          verificationLogChannelId: guild.verificationLogChannelId,
          verificationEmbedTitle: guild.verificationEmbedTitle,
          verificationEmbedDesc: guild.verificationEmbedDesc,
           verificationEmbedColor: guild.verificationEmbedColor,
          verificationOnJoin: guild.verificationOnJoin,
          verificationSaveIp: guild.verificationSaveIp,
          verificationSaveDevice: guild.verificationSaveDevice,
          verificationLevelCommand: guild.verificationLevelCommand,
          verificationLevelJoin: guild.verificationLevelJoin,
          verificationWarnThreshold: guild.verificationWarnThreshold,
          verificationWarnAutoMode: guild.verificationWarnAutoMode,
          verificationWarnReason: guild.verificationWarnReason,
          warnWeightingEnabled: guild.warnWeightingEnabled,
          warnDecayDays: guild.warnDecayDays,
          wordStatsEnabled: guild.wordStatsEnabled,
          banHygieneEnabled: guild.banHygieneEnabled,
        });
      } catch (err) {
        logger.error('ChannelsManagementAPI', 'GET config error:', err);
        json(res, 500, { error: 'Erreur lors de la récupération de la configuration' });
      }
      return true;
    }

    if (method === 'PATCH') {
      try {
        const body = await readJsonBody<{
          autoThreadEnabled?: boolean;
          autoThreadChannels?: string[];
          autoThreadBotsEnabled?: boolean;
          statsEnabled?: boolean;
          statsConfig?: unknown;
          tempVoiceEnabled?: boolean;
          tempVoiceChannelId?: string | null;
          tempVoiceCategoryId?: string | null;
          tempVoiceNameTemplate?: string;
          tempVoiceRequiredRoleId?: string | null;
          tempVoiceGenerators?: Array<{ channelId?: string; categoryId?: string; nameTemplate?: string; requiredRoleId?: string | null }>;
          honeypotEnabled?: boolean;
          /** Demande au dashboard de creer le salon piege automatiquement. */
          createHoneypotChannel?: boolean;
          honeypotChannelId?: string | null;
          honeypotSanction?: string;
          honeypotReinvite?: boolean;
          verificationEnabled?: boolean;
          verificationMode?: string;
          verificationAction?: string;
          verificationChannelId?: string | null;
          verificationFallbackChannelId?: string | null;
          verificationRoleId?: string | null;
          verificationLogChannelId?: string | null;
          verificationEmbedTitle?: string;
          verificationEmbedDesc?: string;
          verificationEmbedColor?: string;
          verificationOnJoin?: boolean;
          verificationSaveIp?: boolean;
          verificationSaveDevice?: boolean;
          verificationLevelCommand?: string;
          verificationLevelJoin?: string;
          verificationWarnThreshold?: number | null;
          verificationWarnAutoMode?: string;
          verificationWarnReason?: string;
          warnWeightingEnabled?: boolean;
          warnDecayDays?: number | null;
          wordStatsEnabled?: boolean;
          banHygieneEnabled?: boolean;
        }>(req);

        if (!body) {
          json(res, 400, { error: 'Payload invalide' });
          return true;
        }

        const data: Record<string, unknown> = {};
        if (Object.prototype.hasOwnProperty.call(body, 'autoThreadEnabled')) {
          data.autoThreadEnabled = !!body.autoThreadEnabled;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'autoThreadChannels')) {
          data.autoThreadChannels = body.autoThreadChannels;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'autoThreadBotsEnabled')) {
          data.autoThreadBotsEnabled = !!body.autoThreadBotsEnabled;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'statsEnabled')) {
          data.statsEnabled = !!body.statsEnabled;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'statsConfig')) {
          data.statsConfig = body.statsConfig;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'tempVoiceEnabled')) {
          data.tempVoiceEnabled = !!body.tempVoiceEnabled;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'tempVoiceChannelId')) {
          data.tempVoiceChannelId = body.tempVoiceChannelId;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'tempVoiceCategoryId')) {
          data.tempVoiceCategoryId = body.tempVoiceCategoryId;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'tempVoiceNameTemplate')) {
          data.tempVoiceNameTemplate = body.tempVoiceNameTemplate;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'tempVoiceRequiredRoleId')) {
          data.tempVoiceRequiredRoleId = body.tempVoiceRequiredRoleId;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'tempVoiceGenerators')) {
          data.tempVoiceGenerators = body.tempVoiceGenerators;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'honeypotEnabled')) {
          data.honeypotEnabled = !!body.honeypotEnabled;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'honeypotChannelId')) {
          data.honeypotChannelId = body.honeypotChannelId;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'honeypotSanction')) {
          if (['WARN', 'KICK', 'TIMEOUT', 'BAN', 'SOFTBAN'].includes(body.honeypotSanction as string)) {
            data.honeypotSanction = body.honeypotSanction;
          } else {
            json(res, 400, { error: 'Type de sanction honeypot invalide' });
            return true;
          }
        }
        if (Object.prototype.hasOwnProperty.call(body, 'honeypotReinvite')) {
          data.honeypotReinvite = !!body.honeypotReinvite;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationEnabled')) {
          data.verificationEnabled = !!body.verificationEnabled;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationMode')) {
          if (['DM', 'EMBED'].includes(body.verificationMode as string)) {
            data.verificationMode = body.verificationMode;
          }
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationAction')) {
          if (['AUTO_LINK', 'NOTIFY_STAFF'].includes(body.verificationAction as string)) {
            data.verificationAction = body.verificationAction;
          }
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationChannelId')) {
          data.verificationChannelId = body.verificationChannelId;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationFallbackChannelId')) {
          data.verificationFallbackChannelId = body.verificationFallbackChannelId;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationRoleId')) {
          data.verificationRoleId = body.verificationRoleId;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationLogChannelId')) {
          data.verificationLogChannelId = body.verificationLogChannelId;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationEmbedTitle')) {
          data.verificationEmbedTitle = (body.verificationEmbedTitle || '').slice(0, 256);
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationEmbedDesc')) {
          data.verificationEmbedDesc = (body.verificationEmbedDesc || '').slice(0, 2048);
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationEmbedColor')) {
          data.verificationEmbedColor = body.verificationEmbedColor;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationOnJoin')) {
          data.verificationOnJoin = !!body.verificationOnJoin;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationSaveIp')) {
          data.verificationSaveIp = !!body.verificationSaveIp;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationSaveDevice')) {
          data.verificationSaveDevice = !!body.verificationSaveDevice;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationLevelCommand')) {
          if (['LOW', 'MEDIUM', 'HIGH'].includes(body.verificationLevelCommand as string)) {
            data.verificationLevelCommand = body.verificationLevelCommand;
          }
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationLevelJoin')) {
          if (['LOW', 'MEDIUM', 'HIGH'].includes(body.verificationLevelJoin as string)) {
            data.verificationLevelJoin = body.verificationLevelJoin;
          }
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationWarnThreshold')) {
          // null or 0 = disabled, positive integer = threshold
          if (body.verificationWarnThreshold === null || body.verificationWarnThreshold === 0) {
            data.verificationWarnThreshold = null;
          } else if (typeof body.verificationWarnThreshold === 'number' && body.verificationWarnThreshold > 0) {
            data.verificationWarnThreshold = Math.floor(body.verificationWarnThreshold);
          }
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationWarnAutoMode')) {
          if (['FULL_AUTO', 'NOTIFY_STAFF'].includes(body.verificationWarnAutoMode as string)) {
            data.verificationWarnAutoMode = body.verificationWarnAutoMode;
          }
        }
        if (Object.prototype.hasOwnProperty.call(body, 'verificationWarnReason')) {
          data.verificationWarnReason = (body.verificationWarnReason || '').slice(0, 512);
        }
        if (Object.prototype.hasOwnProperty.call(body, 'warnWeightingEnabled')) {
          data.warnWeightingEnabled = !!body.warnWeightingEnabled;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'warnDecayDays')) {
          // null ou 0 = pas de décroissance, entier positif = fenêtre en jours
          if (body.warnDecayDays === null || body.warnDecayDays === 0) {
            data.warnDecayDays = null;
          } else if (typeof body.warnDecayDays === 'number' && body.warnDecayDays > 0) {
            data.warnDecayDays = Math.floor(body.warnDecayDays);
          }
        }
        if (Object.prototype.hasOwnProperty.call(body, 'wordStatsEnabled')) {
          data.wordStatsEnabled = !!body.wordStatsEnabled;
        }
        // Capturé avant l'update : sert à détecter la bascule off → on plus bas.
        const wordStatsWasEnabled = Object.prototype.hasOwnProperty.call(body, 'wordStatsEnabled')
          ? (await prisma.guild.findUnique({ where: { id: guildId }, select: { wordStatsEnabled: true } }))?.wordStatsEnabled ?? false
          : null;
        if (Object.prototype.hasOwnProperty.call(body, 'banHygieneEnabled')) {
          data.banHygieneEnabled = !!body.banHygieneEnabled;
        }

        const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);

        if (discordGuild) {
          if (body.tempVoiceEnabled) {
            if (!body.tempVoiceCategoryId) {
              const existing = discordGuild.channels.cache.find(
                c => c.type === ChannelType.GuildCategory && c.name === '🔊 Salons Vocaux'
              );
              const cat = existing || await discordGuild.channels.create({
                name: '🔊 Salons Vocaux',
                type: ChannelType.GuildCategory,
              }).catch(() => null);
              if (cat) data.tempVoiceCategoryId = cat.id;
            }
            if (!body.tempVoiceChannelId) {
              const parentId = (data.tempVoiceCategoryId as string | undefined) || body.tempVoiceCategoryId || undefined;
              const newVoice = await discordGuild.channels.create({
                name: '➕ Créer un salon',
                type: ChannelType.GuildVoice,
                parent: parentId,
              }).catch(() => null);
              if (newVoice) {
                data.tempVoiceChannelId = newVoice.id;
              }
            }

            // Auto-create channels for additional generators
            if (Array.isArray(body.tempVoiceGenerators)) {
              const resolvedGenerators = [];
              for (const gen of body.tempVoiceGenerators) {
                const resolved = { ...gen };

                if (!resolved.categoryId) {
                  const cat = await discordGuild.channels.create({
                    name: '🔊 Salons Vocaux',
                    type: ChannelType.GuildCategory,
                  }).catch(() => null);
                  if (cat) resolved.categoryId = cat.id;
                }

                if (!resolved.channelId) {
                  const newVoice = await discordGuild.channels.create({
                    name: '➕ Créer un salon',
                    type: ChannelType.GuildVoice,
                    parent: resolved.categoryId || undefined,
                  }).catch(() => null);
                  if (newVoice) resolved.channelId = newVoice.id;
                }

                if (resolved.channelId) {
                  resolvedGenerators.push(resolved);
                }
              }
              data.tempVoiceGenerators = resolvedGenerators;
            }
          }

          if (body.honeypotEnabled && body.createHoneypotChannel) {
            const newHoneypot = await discordGuild.channels.create({
              name: 'ne-rien-envoyer-ici',
              type: ChannelType.GuildText,
              permissionOverwrites: [
                {
                  id: discordGuild.roles.everyone.id,
                  allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
                },
              ],
            }).catch(() => null);
            if (newHoneypot) {
              data.honeypotChannelId = newHoneypot.id;

              const honeyEmbed = new EmbedBuilder()
                .setTitle('⚠️ SALON PROTECTEUR - NE PAS ÉCRIRE ⚠️')
                .setDescription(
                  '### 🛡️ Honeypot de Sécurité\n\n' +
                  "Ce salon sert d'appât pour intercepter les bots de spam et les comptes compromis.\n\n" +
                  '> 🛑 **RÈGLE CRUCIALE** : Ne postez **absolument aucun** message dans ce salon sous peine de **BANNISSEMENT DÉFINITIF ET IMMÉDIAT** de ce serveur Discord.\n\n' +
                  '*Si vous êtes un utilisateur légitime, ignorez ou masquez simplement ce salon.*'
                )
                .setColor(0xEE5555)
                .setTimestamp()
                .setFooter({ text: 'Système de protection Kotbo' });

              await newHoneypot.send({ embeds: [honeyEmbed], allowedMentions: { parse: [] } }).catch(() => null);
            }
          }

          if (body.statsEnabled && body.statsConfig) {
            const sc = readStatsConfig(body.statsConfig);

            const needsMember = sc.memberChannelId === '' || sc.memberChannelId === null;
            const needsBot = sc.botChannelId === '' || sc.botChannelId === null;
            const needsRole = sc.roleChannelId === '' || sc.roleChannelId === null;
            const needsChannel = sc.channelChannelId === '' || sc.channelChannelId === null;
            const needsCategory = sc.categoryChannelId === '' || sc.categoryChannelId === null;
            const needsActivity = sc.activityChannelId === '' || sc.activityChannelId === null;
            const needsCustomStats = Array.isArray(sc.customStats) && sc.customStats.some((c) => c.enabled && !c.channelId);

            if (needsMember || needsBot || needsRole || needsChannel || needsCategory || needsActivity || needsCustomStats || !sc.categoryId) {
              let statsCatId: string | undefined = sc.categoryId || undefined;
              
              if (!statsCatId) {
                const existingStatsCat = discordGuild.channels.cache.find(
                  c => c.type === ChannelType.GuildCategory && c.name === '📊 Statistiques'
                );
                if (existingStatsCat) {
                  statsCatId = existingStatsCat.id;
                } else {
                  const newCat = await discordGuild.channels.create({
                    name: '📊 Statistiques',
                    type: ChannelType.GuildCategory,
                    permissionOverwrites: [
                      {
                        id: discordGuild.roles.everyone.id,
                        deny: [PermissionFlagsBits.Connect, PermissionFlagsBits.SendMessages],
                      },
                    ],
                  }).catch(() => null);
                  if (newCat) statsCatId = newCat.id;
                }
              }

              const createStatChannel = async (defaultName: string, asCategory = false): Promise<string | undefined> => {
                if (asCategory) {
                  const ch = await discordGuild.channels.create({
                    name: defaultName,
                    type: ChannelType.GuildCategory,
                    permissionOverwrites: [
                      {
                        id: discordGuild.roles.everyone.id,
                        deny: [PermissionFlagsBits.SendMessages],
                      },
                    ],
                  }).catch(() => null);
                  return ch?.id;
                }
                const ch = await discordGuild.channels.create({
                  name: defaultName,
                  type: ChannelType.GuildVoice,
                  parent: statsCatId,
                  permissionOverwrites: [
                    {
                      id: discordGuild.roles.everyone.id,
                      deny: [PermissionFlagsBits.Connect],
                    },
                  ],
                }).catch(() => null);
                return ch?.id;
              };

              const newSc = { ...sc };
              if (statsCatId) {
                newSc.categoryId = statsCatId;
              }

              if (needsMember) {
                const tpl = sc.memberTemplate || '👤 Membres : {count}';
                newSc.memberChannelId = await createStatChannel(tpl.replace('{count}', '…')) ?? sc.memberChannelId;
              }
              if (needsBot) {
                const tpl = sc.botTemplate || '🤖 Bots : {count}';
                newSc.botChannelId = await createStatChannel(tpl.replace('{count}', '…')) ?? sc.botChannelId;
              }
              if (needsRole) {
                const tpl = sc.roleTemplate || '👑 Staff : {count}';
                newSc.roleChannelId = await createStatChannel(tpl.replace('{count}', '…')) ?? sc.roleChannelId;
              }
              if (needsChannel) {
                const tpl = sc.channelTemplate || '💬 Salons : {count}';
                newSc.channelChannelId = await createStatChannel(tpl.replace('{count}', '…')) ?? sc.channelChannelId;
              }
              if (needsCategory) {
                const tpl = sc.categoryTemplate || '📁 Catégories : {count}';
                newSc.categoryChannelId = await createStatChannel(tpl.replace('{count}', '…')) ?? sc.categoryChannelId;
              }
              if (needsActivity) {
                const tpl = sc.activityTemplate || '📈 Actifs 24h : {count}';
                newSc.activityChannelId = await createStatChannel(tpl.replace('{count}', '…')) ?? sc.activityChannelId;
              }

              if (Array.isArray(sc.customStats)) {
                const updatedCustomStats = [];
                for (const custom of sc.customStats) {
                  const item = { ...custom };
                  if (item.enabled && !item.channelId) {
                    const tpl = item.template || 'Stat : {count}';
                    let initialName = tpl.replace('{count}', '…');
                    if (item.type === 'goal' && item.goalTarget) {
                      initialName = initialName.replace('{goal}', item.goalTarget.toString());
                    }
                    item.channelId = await createStatChannel(initialName, item.channelType === 'category') ?? '';
                  }
                  updatedCustomStats.push(item);
                }
                newSc.customStats = updatedCustomStats;
              }

              data.statsConfig = newSc;
            }
          }
        }

        await prisma.guild.update({
          where: { id: guildId },
          data,
        });

        // Purge les caches préfixés guild:<id>: — config du bot (getCachedGuild)
        // et payloads d'analytics avancées, qui embarquent les toggles (ex.
        // wordStatsEnabled). Sans ça, le dashboard continue d'afficher l'ancien
        // état pendant toute la durée du TTL.
        await cache.invalidateGuild(guildId);

        // Activation des stats de mots : indexer les messages déjà journalisés
        // plutôt que d'attendre que le tracker live accumule des données.
        if (wordStatsWasEnabled === false && data.wordStatsEnabled === true) {
          void (async () => {
            const { startWordStatsBackfill, backfillMessageMentions } = await import('../../../services/analytics/wordStatsBackfillService.js');
            await backfillMessageMentions(guildId).catch((err) =>
              logger.error('ChannelsManagementAPI', `Backfill des mentions échoué pour ${guildId}:`, err),
            );
            await startWordStatsBackfill(guildId);
          })().catch((err) =>
            logger.error('ChannelsManagementAPI', `Lancement du backfill des stats de mots échoué pour ${guildId}:`, err),
          );
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Sauvegarde configuration Gestion des salons',
          context: getGuildName(client, guildId),
          module: 'Gestion des salons',
          eventType: 'Manuel',
          details: 'Configuration de la gestion des salons mise à jour.',
          channelId: null
        });

        if (body.statsEnabled) {
          updateGuildStats(client, guildId).catch((err) => 
            logger.error('ChannelsManagementAPI', `Erreur lors de la mise à jour des stats pour la guilde ${guildId} :`, err)
          );
        }

        if (Object.prototype.hasOwnProperty.call(body, 'autoThreadEnabled')) {
          await prisma.dashboardFeatureConfig.upsert({
            where: { guildId_featureKey: { guildId, featureKey: 'auto_thread' } },
            create: {
              guildId,
              featureKey: 'auto_thread',
              featureName: 'Gestion des salons',
              enabled: !!body.autoThreadEnabled,
              loggingEnabled: true,
              userActivityTracking: true,
              notifyViaDiscordChannel: true,
            },
            update: {
              enabled: !!body.autoThreadEnabled
            }
          });
        }

        json(res, 200, {
          ok: true,
          resolved: {
            tempVoiceChannelId: data.tempVoiceChannelId,
            tempVoiceCategoryId: data.tempVoiceCategoryId,
            tempVoiceGenerators: data.tempVoiceGenerators,
            honeypotChannelId: data.honeypotChannelId,
            honeypotSanction: data.honeypotSanction,
            honeypotReinvite: data.honeypotReinvite,
            statsConfig: data.statsConfig,
          }
        });
      } catch (err) {
        logger.error('ChannelsManagementAPI', 'PATCH config error:', err);
        json(res, 500, { error: 'Erreur lors de la mise à jour' });
      }
      return true;
    }
  }

  // GET/POST/PATCH/DELETE /api/dashboard/guilds/:guildId/banned-words
  if (moduleKey === 'banned-words') {
    if (parts.length === 5 && method === 'GET') {
      try {
        const [globalWords, guildWords] = await Promise.all([
          prisma.bannedWord.findMany({
            where: { guildId: null },
            select: { id: true, word: true, category: true, enabled: true, guildId: true },
            orderBy: [{ category: 'asc' }, { word: 'asc' }],
          }),
          prisma.bannedWord.findMany({
            where: { guildId },
            select: { id: true, word: true, category: true, enabled: true, guildId: true },
            orderBy: [{ category: 'asc' }, { word: 'asc' }],
          }),
        ]);
        json(res, 200, { global: globalWords, custom: guildWords });
      } catch (err) {
        logger.error('BannedWordsAPI', 'GET banned-words error:', err);
        json(res, 500, { error: 'Erreur lors de la récupération des mots bannis' });
      }
      return true;
    }

    if (parts.length === 5 && method === 'POST') {
      try {
        const body = await readJsonBody<{ word: string; category?: string }>(req);
        if (!body?.word || typeof body.word !== 'string' || !body.word.trim()) {
          json(res, 400, { error: 'Champ `word` requis' });
          return true;
        }

        const cleanWord = body.word.trim().toLowerCase().slice(0, 100);

        if (cleanWord.includes('automod') || cleanWord.includes('pseudo non conforme')) {
          json(res, 400, { error: 'Ce mot ne peut pas être banni (réservé par le système de modération)' });
          return true;
        }

        const category = ['custom', 'racism', 'threat', 'sexual', 'lgbtphobia', 'hate', 'insult'].includes(body.category ?? '')
          ? body.category!
          : 'custom';

        const guildData = await prisma.guild.findUnique({
          where: { id: guildId },
          select: { nicknameModerationWhitelist: true },
        });
        const whitelist = guildData?.nicknameModerationWhitelist ?? [];
        if (whitelist.includes(cleanWord)) {
          json(res, 400, {
            error: `Impossible de bannir ce mot car il est déjà présent dans la liste des pseudos autorisés (whitelist) : ${cleanWord}`,
          });
          return true;
        }

        const created = await prisma.bannedWord.create({
          data: { guildId, word: cleanWord, category },
        });

        invalidateBannedWordsCache(guildId);

        const guildDb = await prisma.guild.findUnique({
          where: { id: guildId },
          select: { nickModDiscordAutoModSync: true }
        });
        if (guildDb?.nickModDiscordAutoModSync) {
          void import('../../../services/moderation/autoModService.js')
            .then(({ syncDiscordAutoModProfileRule }) => syncDiscordAutoModProfileRule(client, guildId))
            .catch((syncErr) => {
              logger.error('BannedWordsAPI', `Erreur lors de la synchronisation AutoMod Pseudos pour ${guildId}:`, syncErr);
            });
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Ajout mot banni',
          context: getGuildName(client, guildId),
          module: 'Mots bannis',
          eventType: 'Manuel',
          details: `Mot "${cleanWord}" ajouté (catégorie: ${category})`,
          channelId: null,
        });

        broadcastDashboardStateChange(guildId, 'banned_words_updated');

        json(res, 201, { ok: true, id: created.id });
      } catch (err: unknown) {
        if (errorCode(err) === 'P2002') {
          json(res, 409, { error: 'Ce mot existe déjà sur ce serveur' });
        } else {
          logger.error('BannedWordsAPI', 'POST banned-words error:', err);
          json(res, 500, { error: "Erreur lors de l'ajout du mot" });
        }
      }
      return true;
    }

    if (parts.length === 6 && method === 'PATCH') {
      const wordId = parts[5];
      try {
        const body = await readJsonBody<{ enabled: boolean }>(req);
        if (!body || typeof body.enabled !== 'boolean') {
          json(res, 400, { error: 'Champ `enabled` requis (boolean)' });
          return true;
        }

        const existing = await prisma.bannedWord.findFirst({ where: { id: wordId, guildId } });
        if (!existing) {
          json(res, 404, { error: 'Mot introuvable' });
          return true;
        }

        if (body.enabled) {
          const guildData = await prisma.guild.findUnique({
            where: { id: guildId },
            select: { nicknameModerationWhitelist: true },
          });
          const whitelist = guildData?.nicknameModerationWhitelist ?? [];
          if (whitelist.includes(existing.word.toLowerCase())) {
            json(res, 400, {
              error: `Impossible d'activer ce mot car il est déjà présent dans la liste des pseudos autorisés (whitelist) : ${existing.word}`,
            });
            return true;
          }
        }

        await prisma.bannedWord.update({ where: { id: wordId }, data: { enabled: body.enabled } });

        invalidateBannedWordsCache(guildId);

        const guildDb = await prisma.guild.findUnique({
          where: { id: guildId },
          select: { nickModDiscordAutoModSync: true }
        });
        if (guildDb?.nickModDiscordAutoModSync) {
          void import('../../../services/moderation/autoModService.js')
            .then(({ syncDiscordAutoModProfileRule }) => syncDiscordAutoModProfileRule(client, guildId))
            .catch((syncErr) => {
              logger.error('BannedWordsAPI', `Erreur lors de la synchronisation AutoMod Pseudos pour ${guildId}:`, syncErr);
            });
        }

        broadcastDashboardStateChange(guildId, 'banned_words_updated');
        json(res, 200, { ok: true });
      } catch (err) {
        logger.error('BannedWordsAPI', 'PATCH banned-words error:', err);
        json(res, 500, { error: 'Erreur lors de la mise à jour' });
      }
      return true;
    }

    if (parts.length === 6 && method === 'DELETE') {
      const wordId = parts[5];
      try {
        const existing = await prisma.bannedWord.findFirst({ where: { id: wordId, guildId } });
        if (!existing) {
          json(res, 404, { error: 'Mot introuvable ou non modifiable' });
          return true;
        }

        await prisma.bannedWord.delete({ where: { id: wordId } });

        invalidateBannedWordsCache(guildId);

        const guildDb = await prisma.guild.findUnique({
          where: { id: guildId },
          select: { nickModDiscordAutoModSync: true }
        });
        if (guildDb?.nickModDiscordAutoModSync) {
          void import('../../../services/moderation/autoModService.js')
            .then(({ syncDiscordAutoModProfileRule }) => syncDiscordAutoModProfileRule(client, guildId))
            .catch((syncErr) => {
              logger.error('BannedWordsAPI', `Erreur lors de la synchronisation AutoMod Pseudos pour ${guildId}:`, syncErr);
            });
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Suppression mot banni',
          context: getGuildName(client, guildId),
          module: 'Mots bannis',
          eventType: 'Manuel',
          details: `Mot "${existing.word}" supprimé`,
          channelId: null,
        });

        broadcastDashboardStateChange(guildId, 'banned_words_updated');

        json(res, 200, { ok: true });
      } catch (err) {
        logger.error('BannedWordsAPI', 'DELETE banned-words error:', err);
        json(res, 500, { error: 'Erreur lors de la suppression' });
      }
      return true;
    }
  }

  // GET /api/dashboard/guilds/:guildId/notifications/features
  if (moduleKey === 'notifications' && parts.length === 6 && parts[5] === 'features' && method === 'GET') {
    try {
      const { getOrCreateFeatureConfigs } = await import('../../../services/core/dashboardManagementService.js');
      const configs = await getOrCreateFeatureConfigs(guildId);
      json(res, 200, { features: configs });
    } catch (err) {
      logger.error('NotificationsAPI', 'Error fetching feature configurations:', err);
      json(res, 500, { error: 'Erreur lors de la récupération des configurations des modules' });
    }
    return true;
  }

  // PATCH /api/dashboard/guilds/:guildId/notifications/features/:featureKey
  if (moduleKey === 'notifications' && parts.length === 7 && parts[5] === 'features' && method === 'PATCH') {
    if (!access.canManageSettings) {
      json(res, 403, { error: 'Accès refusé. Permissions administratives requises.' });
      return true;
    }

    const featureKey = parts[6];
    try {
      const body = await readJsonBody<{
        enabled?: boolean;
        channelId?: string | null;
        secondaryChannelId?: string | null;
        requiredRoleId?: string | null;
        notificationRoleId?: string | null;
        notifyViaDiscordChannel?: boolean;
        notifyViaDM?: boolean;
        loggingEnabled?: boolean;
        userActivityTracking?: boolean;
        metadata?: Record<string, unknown>;
      }>(req);

      if (!body) {
        json(res, 400, { error: 'Payload de configuration invalide' });
        return true;
      }

      const { updateFeatureConfig } = await import('../../../services/core/dashboardManagementService.js');
      const updated = await updateFeatureConfig(guildId, featureKey, body);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour module',
        context: getGuildName(client, guildId),
        module: 'Configuration',
        eventType: 'Manuel',
        details: `Configuration du module "${featureKey}" mise à jour.`,
        channelId: null
      });

      json(res, 200, { ok: true, config: updated });
    } catch (err) {
      logger.error('NotificationsAPI', `Error updating feature configuration for ${featureKey}:`, err);
      json(res, 500, { error: 'Erreur lors de la mise à jour de la configuration du module' });
    }
    return true;
  }

  // Management feature routes (role-access and notification-targets)
  if (moduleKey === 'management') {
    if (!access.canManageSettings) {
      json(res, 403, { error: 'Accès refusé. Permissions administratives requises.' });
      return true;
    }

    // PUT /api/dashboard/guilds/:guildId/management/features/:featureKey/role-access
    if (parts.length === 8 && parts[5] === 'features' && parts[7] === 'role-access' && method === 'PUT') {
      const featureKey = parts[6];
      try {
        const body = await readJsonBody<{
          roleAccessConfigs: Array<{
            roleId: string;
            canView?: boolean;
            canModerate?: boolean;
            canConfigure?: boolean;
            canDelete?: boolean;
          }>;
        }>(req);

        if (!body || !Array.isArray(body.roleAccessConfigs)) {
          json(res, 400, { error: "Payload d'accès de rôle invalide" });
          return true;
        }

        const featureConfig = await prisma.dashboardFeatureConfig.findUnique({
          where: {
            guildId_featureKey: { guildId, featureKey }
          }
        });

        if (!featureConfig) {
          json(res, 404, { error: 'Configuration du module introuvable' });
          return true;
        }

        const { updateRoleAccess } = await import('../../../services/core/dashboardManagementService.js');
        const updated = await updateRoleAccess(guildId, featureConfig.id, body.roleAccessConfigs);

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Mise à jour accès rôle',
          context: getGuildName(client, guildId),
          module: 'Configuration',
          eventType: 'Manuel',
          details: `Accès rôles pour le module "${featureKey}" mis à jour (${body.roleAccessConfigs.length} rôles).`,
          channelId: null
        });

        json(res, 200, { ok: true, config: updated });
      } catch (err) {
        logger.error('ManagementAPI', `Error updating role access for ${featureKey}:`, err);
        json(res, 500, { error: 'Erreur lors de la mise à jour des permissions du module' });
      }
      return true;
    }

    // PUT /api/dashboard/guilds/:guildId/management/features/:featureKey/notification-targets
    if (parts.length === 8 && parts[5] === 'features' && parts[7] === 'notification-targets' && method === 'PUT') {
      const featureKey = parts[6];
      try {
        const body = await readJsonBody<{
          notificationTargets: Array<{
            targetType: string;
            targetId?: string | null;
            enabled?: boolean;
          }>;
        }>(req);

        if (!body || !Array.isArray(body.notificationTargets)) {
          json(res, 400, { error: 'Payload de cibles de notification invalide' });
          return true;
        }

        const featureConfig = await prisma.dashboardFeatureConfig.findUnique({
          where: {
            guildId_featureKey: { guildId, featureKey }
          }
        });

        if (!featureConfig) {
          json(res, 404, { error: 'Configuration du module introuvable' });
          return true;
        }

        const { updateNotificationTargets } = await import('../../../services/core/dashboardManagementService.js');
        const updated = await updateNotificationTargets(guildId, featureConfig.id, body.notificationTargets);

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Mise à jour cibles alertes',
          context: getGuildName(client, guildId),
          module: 'Configuration',
          eventType: 'Manuel',
          details: `Cibles de notifications pour le module "${featureKey}" mises à jour.`,
          channelId: null
        });

        json(res, 200, { ok: true, config: updated });
      } catch (err) {
        logger.error('ManagementAPI', `Error updating notification targets for ${featureKey}:`, err);
        json(res, 500, { error: 'Erreur lors de la mise à jour des cibles de notification du module' });
      }
      return true;
    }
  }

  // PUT /api/dashboard/guilds/:guildId/notifications
  if (moduleKey === 'notifications' && parts.length === 5 && method === 'PUT') {
    try {
      const body = await readJsonBody<NotificationSettings>(req);
      if (!body) {
        json(res, 400, { error: 'Payload notifications invalide' });
        return true;
      }

      const runtime = await getOrCreateRuntime(guildId);

      await prisma.guild.update({
        where: { id: guildId },
        data: {
          statusCheckChannelId: body.discordChannel?.replace(/[^0-9]/g, '') || null
        }
      });

      await prisma.dashboardSettings.update({
        where: { guildId },
        data: {
          email: body.email ?? '',
          emailEnabled: !!body.emailEnabled,
          cloudBackup: !!body.cloudBackup,
          debugLog: !!body.debugLog,
          killSwitchEnabled: !!body.killSwitchEnabled,
          severityByModule: body.severityByModule ?? runtime.severityByModule
        }
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Sauvegarde notifications',
        context: getGuildName(client, guildId),
        module: 'Notifications',
        eventType: 'Manuel',
        details: 'Paramètres globaux mis à jour.',
        channelId: body.discordChannel?.replace(/[^0-9]/g, '') || null
      });

      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('NotificationsAPI', 'Error updating notifications:', err);
      json(res, 500, { error: 'Erreur lors de la mise à jour des notifications' });
    }
    return true;
  }

  // PATCH/PUT /api/dashboard/guilds/:guildId/settings
  if (moduleKey === 'settings' && parts.length === 5 && (method === 'PATCH' || method === 'PUT')) {
    try {
      const body = await readJsonBody<{
        discordChannel?: string;
        logChannelId?: string | null;
        moderatorRoleId?: string | null;
        regulationChannelId?: string | null;
        propagateSanctions?: boolean;
        crossServerSanctionsEnabled?: boolean;
        messageTemplate?: string;
        sidebarFavorites?: unknown;
        configChannelId?: string | null;
        publicChannelId?: string | null;
        newsChannelId?: string | null;
        dailyAlgoChannelId?: string | null;
        meetingAnnouncementChannelId?: string | null;
        meetingVoiceChannelId?: string | null;
        baseStaffRoleId?: string | null;
        testStaffRoleId?: string | null;
        translationEnabled?: boolean;
        codePoliceEnabled?: boolean;
        dailyAlgoEnabled?: boolean;
        // ── Daily Algo v2 : barème, semaine, sanctions, pont clans ──
        dailyAlgoTimezone?: string;
        dailyAlgoParticipationPoints?: number;
        dailyAlgoWeekendMultiplier?: number;
        dailyAlgoWeeklyRewardsEnabled?: boolean;
        dailyAlgoWeekRole1Id?: string | null;
        dailyAlgoWeekRole2Id?: string | null;
        dailyAlgoWeekRole3Id?: string | null;
        dailyAlgoWeekRoleRotate?: boolean;
        dailyAlgoWeekXp1?: number;
        dailyAlgoWeekXp2?: number;
        dailyAlgoWeekXp3?: number;
        dailyAlgoWeekParticipationXp?: number;
        dailyAlgoWeekAnnouncementChannelId?: string | null;
        dailyAlgoSanctionType?: string;
        dailyAlgoSanctionWeight?: number;
        dailyAlgoSanctionDurationMinutes?: number;
        clanPointsFromDailyAlgo?: boolean;
        clanPointsFromDailyAlgoRate?: number;
        clanPointsDailyAlgoTop1?: number;
        clanPointsDailyAlgoTop2?: number;
        clanPointsDailyAlgoTop3?: number;
        githubReleasesEnabled?: boolean;
        digestEnabled?: boolean;
        youtubeEnabled?: boolean;
        autoThreadEnabled?: boolean;
        twitchEnabled?: boolean;
        socialNetworksEnabled?: boolean;
        regulationVerificationEnabled?: boolean;
        regulationRoleId?: string | null;
        regulationLockEnabled?: boolean;
        sanctionReportEnabled?: boolean;
      }>(req);

      if (!body) {
        json(res, 400, { error: 'Payload settings invalide' });
        return true;
      }

      const oldGuild = await prisma.guild.findUnique({
        where: { id: guildId },
        select: {
          regulationVerificationEnabled: true,
          regulationRoleId: true,
          regulationLockEnabled: true,
          regulationChannelId: true,
        },
      });

      const data: Record<string, unknown> = {};
      let applyLockChanged = false;
      if (Object.prototype.hasOwnProperty.call(body, 'discordChannel')) {
        data.statusCheckChannelId = extractDiscordSnowflake(body.discordChannel);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'logChannelId')) {
        data.logChannelId = extractDiscordSnowflake(body.logChannelId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'moderatorRoleId')) {
        data.moderatorRoleId = extractDiscordSnowflake(body.moderatorRoleId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'regulationChannelId')) {
        data.regulationChannelId = extractDiscordSnowflake(body.regulationChannelId);
        applyLockChanged = true;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'regulationVerificationEnabled')) {
        data.regulationVerificationEnabled = !!body.regulationVerificationEnabled;
        applyLockChanged = true;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'regulationRoleId')) {
        data.regulationRoleId = extractDiscordSnowflake(body.regulationRoleId);
        applyLockChanged = true;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'regulationLockEnabled')) {
        data.regulationLockEnabled = !!body.regulationLockEnabled;
        applyLockChanged = true;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'propagateSanctions')) {
        data.propagateSanctions = !!body.propagateSanctions;
        data.sanctionSyncEnabled = !!body.propagateSanctions;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'crossServerSanctionsEnabled')) {
        data.crossServerSanctionsEnabled = !!body.crossServerSanctionsEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'sanctionReportEnabled')) {
        data.sanctionReportEnabled = !!body.sanctionReportEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'configChannelId')) {
        data.configChannelId = extractDiscordSnowflake(body.configChannelId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'publicChannelId')) {
        data.publicChannelId = extractDiscordSnowflake(body.publicChannelId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'newsChannelId')) {
        data.newsChannelId = extractDiscordSnowflake(body.newsChannelId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoChannelId')) {
        data.dailyAlgoChannelId = extractDiscordSnowflake(body.dailyAlgoChannelId);
      }

      // ── Daily Algo v2 ────────────────────────────────────────────────────────
      // Toutes ces valeurs sont réglables depuis le panel : rien n'est codé en dur
      // côté bot. Les bornes ci-dessous évitent qu'une saisie farfelue casse le
      // barème (multiplicateur nul, XP négative, taux de conversion à zéro…).
      const readClampedInt = (value: unknown, min: number, max: number, fallback: number): number => {
        const parsed = Math.trunc(Number(value));
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(max, Math.max(min, parsed));
      };

      const readClampedFloat = (value: unknown, min: number, max: number, fallback: number): number => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(max, Math.max(min, parsed));
      };

      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoTimezone')) {
        const candidate = typeof body.dailyAlgoTimezone === 'string' ? body.dailyAlgoTimezone.trim() : '';
        // Un fuseau invalide ferait échouer tous les calculs de semaine : on le
        // vérifie ici plutôt que de le découvrir à la clôture du lundi.
        let isValidTimeZone = false;
        if (candidate) {
          try {
            new Intl.DateTimeFormat('en-US', { timeZone: candidate });
            isValidTimeZone = true;
          } catch {
            isValidTimeZone = false;
          }
        }

        if (!isValidTimeZone) {
          json(res, 400, { error: `Fuseau horaire invalide : « ${candidate} ».` });
          return true;
        }

        data.dailyAlgoTimezone = candidate;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoParticipationPoints')) {
        data.dailyAlgoParticipationPoints = readClampedInt(body.dailyAlgoParticipationPoints, 0, 50, 1);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoWeekendMultiplier')) {
        data.dailyAlgoWeekendMultiplier = readClampedFloat(body.dailyAlgoWeekendMultiplier, 1, 10, 1.5);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoWeeklyRewardsEnabled')) {
        data.dailyAlgoWeeklyRewardsEnabled = !!body.dailyAlgoWeeklyRewardsEnabled;
      }
      // Rôles du podium : facultatifs. Vider le champ = aucun rôle attribué, le
      // reste des récompenses continue de fonctionner.
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoWeekRole1Id')) {
        data.dailyAlgoWeekRole1Id = extractDiscordSnowflake(body.dailyAlgoWeekRole1Id);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoWeekRole2Id')) {
        data.dailyAlgoWeekRole2Id = extractDiscordSnowflake(body.dailyAlgoWeekRole2Id);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoWeekRole3Id')) {
        data.dailyAlgoWeekRole3Id = extractDiscordSnowflake(body.dailyAlgoWeekRole3Id);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoWeekRoleRotate')) {
        data.dailyAlgoWeekRoleRotate = !!body.dailyAlgoWeekRoleRotate;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoWeekXp1')) {
        data.dailyAlgoWeekXp1 = readClampedInt(body.dailyAlgoWeekXp1, 0, 1_000_000, 500);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoWeekXp2')) {
        data.dailyAlgoWeekXp2 = readClampedInt(body.dailyAlgoWeekXp2, 0, 1_000_000, 300);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoWeekXp3')) {
        data.dailyAlgoWeekXp3 = readClampedInt(body.dailyAlgoWeekXp3, 0, 1_000_000, 150);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoWeekParticipationXp')) {
        data.dailyAlgoWeekParticipationXp = readClampedInt(body.dailyAlgoWeekParticipationXp, 0, 1_000_000, 100);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoWeekAnnouncementChannelId')) {
        data.dailyAlgoWeekAnnouncementChannelId = extractDiscordSnowflake(body.dailyAlgoWeekAnnouncementChannelId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoSanctionType')) {
        data.dailyAlgoSanctionType = body.dailyAlgoSanctionType === 'TIMEOUT' ? 'TIMEOUT' : 'WARN';
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoSanctionWeight')) {
        data.dailyAlgoSanctionWeight = readClampedInt(body.dailyAlgoSanctionWeight, 1, 3, 1);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoSanctionDurationMinutes')) {
        data.dailyAlgoSanctionDurationMinutes = readClampedInt(body.dailyAlgoSanctionDurationMinutes, 1, 40_320, 60);
      }
      // Pont Daily Algo → Clans : troisième interrupteur, indépendant de
      // `clansEnabled` et `dailyAlgoEnabled`.
      if (Object.prototype.hasOwnProperty.call(body, 'clanPointsFromDailyAlgo')) {
        data.clanPointsFromDailyAlgo = !!body.clanPointsFromDailyAlgo;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'clanPointsFromDailyAlgoRate')) {
        data.clanPointsFromDailyAlgoRate = readClampedFloat(body.clanPointsFromDailyAlgoRate, 0.1, 100, 1);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'clanPointsDailyAlgoTop1')) {
        data.clanPointsDailyAlgoTop1 = readClampedInt(body.clanPointsDailyAlgoTop1, 0, 100_000, 30);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'clanPointsDailyAlgoTop2')) {
        data.clanPointsDailyAlgoTop2 = readClampedInt(body.clanPointsDailyAlgoTop2, 0, 100_000, 20);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'clanPointsDailyAlgoTop3')) {
        data.clanPointsDailyAlgoTop3 = readClampedInt(body.clanPointsDailyAlgoTop3, 0, 100_000, 10);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'meetingAnnouncementChannelId')) {
        data.meetingAnnouncementChannelId = extractDiscordSnowflake(body.meetingAnnouncementChannelId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'meetingVoiceChannelId')) {
        data.meetingVoiceChannelId = extractDiscordSnowflake(body.meetingVoiceChannelId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'baseStaffRoleId')) {
        data.baseStaffRoleId = extractDiscordSnowflake(body.baseStaffRoleId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'testStaffRoleId')) {
        data.testStaffRoleId = extractDiscordSnowflake(body.testStaffRoleId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'translationEnabled')) {
        data.translationEnabled = !!body.translationEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'codePoliceEnabled')) {
        data.codePoliceEnabled = !!body.codePoliceEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoEnabled')) {
        data.dailyAlgoEnabled = !!body.dailyAlgoEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'githubReleasesEnabled')) {
        data.githubReleasesEnabled = !!body.githubReleasesEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'digestEnabled')) {
        data.digestEnabled = !!body.digestEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'autoThreadEnabled')) {
        data.autoThreadEnabled = !!body.autoThreadEnabled;
      }

      if (Object.keys(data).length > 0) {
        await prisma.guild.update({ where: { id: guildId }, data });
      }

      if (applyLockChanged) {
        const finalGuild = await prisma.guild.findUnique({
          where: { id: guildId },
          select: {
            regulationVerificationEnabled: true,
            regulationRoleId: true,
            regulationLockEnabled: true,
            regulationChannelId: true,
          },
        });
        if (finalGuild) {
          const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
          if (discordGuild) {
            let verifiedRoleId = finalGuild.regulationRoleId;
            if (finalGuild.regulationVerificationEnabled && !verifiedRoleId) {
              let role = discordGuild.roles.cache.find((r) => r.name === 'Vérifié') ?? null;
              if (!role) {
                try {
                  role = await discordGuild.roles.create({
                    name: 'Vérifié',
                    reason: 'Créé automatiquement pour le règlement du serveur.',
                  });
                } catch (err) {
                  logger.error('SettingsAPI', `Impossible de créer le rôle 'Vérifié' :`, err);
                }
              }
              if (role) {
                verifiedRoleId = role.id;
                await prisma.guild.update({
                  where: { id: guildId },
                  data: { regulationRoleId: role.id },
                });
              }
            }

            const oldLocked = !!(oldGuild?.regulationVerificationEnabled && oldGuild?.regulationLockEnabled);
            const newLocked = !!(finalGuild.regulationVerificationEnabled && finalGuild.regulationLockEnabled);
            const lockStateChanged = oldLocked !== newLocked;
            const roleChanged = oldGuild?.regulationRoleId !== finalGuild.regulationRoleId;
            const channelChanged = oldGuild?.regulationChannelId !== finalGuild.regulationChannelId;

            if (verifiedRoleId && finalGuild.regulationChannelId && (lockStateChanged || roleChanged || channelChanged)) {
              // Run in background to prevent API timeout / rate limit blocks
              applyRegulationLock(
                discordGuild,
                verifiedRoleId,
                finalGuild.regulationChannelId,
                newLocked
              ).catch((err) => {
                logger.error('SettingsAPI', `Error in applyRegulationLock background task:`, err);
              });
            }
          }
        }
      }

      // Les valeurs viennent de l'accumulateur `data`, alimente champ par champ
      // depuis le corps de requete : on les normalise ici plutot qu'a chacun des
      // ~20 appels.
      const syncFeature = async (featureKey: string, featureName: string, rawEnabled?: unknown, rawChannelId?: unknown, rawSecondaryChannelId?: unknown) => {
        const enabled = typeof rawEnabled === 'boolean' ? rawEnabled : undefined;
        const channelId = rawChannelId === undefined ? undefined : (typeof rawChannelId === 'string' ? rawChannelId : null);
        const secondaryChannelId = rawSecondaryChannelId === undefined ? undefined : (typeof rawSecondaryChannelId === 'string' ? rawSecondaryChannelId : null);

        const updateData: Record<string, unknown> = {};
        if (enabled !== undefined) updateData.enabled = enabled;
        if (channelId !== undefined) updateData.channelId = channelId;
        if (secondaryChannelId !== undefined) updateData.secondaryChannelId = secondaryChannelId;

        if (Object.keys(updateData).length > 0) {
          await prisma.dashboardFeatureConfig.upsert({
            where: { guildId_featureKey: { guildId, featureKey } },
            create: {
              guildId,
              featureKey,
              featureName,
              enabled: enabled ?? true,
              channelId: channelId ?? null,
              secondaryChannelId: secondaryChannelId ?? null,
              loggingEnabled: true,
              userActivityTracking: true,
              notifyViaDiscordChannel: true,
            },
            update: updateData,
          });
        }
      };

      await syncFeature('daily_algo', 'Daily Algo', data.dailyAlgoEnabled, data.dailyAlgoChannelId, undefined);
      await syncFeature('digest', 'Digest', data.digestEnabled, undefined, undefined);
      await syncFeature('translation', 'Translation', data.translationEnabled, undefined, undefined);
      await syncFeature('codepolice', 'Code Police', data.codePoliceEnabled, undefined, undefined);
      await syncFeature('logs', 'Logs Discord', undefined, data.logChannelId, undefined);
      await syncFeature('regulation', 'Règlement', undefined, data.regulationChannelId, undefined);
      await syncFeature('meetings', 'Réunions', undefined, data.meetingAnnouncementChannelId, data.meetingVoiceChannelId);
      await syncFeature('settings', 'Paramètres', undefined, data.configChannelId, undefined);
      await syncFeature('dashboard', "Vue d'ensemble", undefined, data.publicChannelId, undefined);
      await syncFeature('news', 'Actualités & RSS', undefined, data.newsChannelId, undefined);
      await syncFeature('auto_thread', 'Auto-Thread', data.autoThreadEnabled, undefined, undefined);
      
      if (body.youtubeEnabled !== undefined) {
        await syncFeature('youtube', 'YouTube', body.youtubeEnabled, undefined, undefined);
      }

      if (body.twitchEnabled !== undefined) {
        await syncFeature('twitch', 'Twitch', body.twitchEnabled, undefined, undefined);
      }

      if (body.socialNetworksEnabled !== undefined) {
        await syncFeature('social_networks', 'Réseaux Sociaux', body.socialNetworksEnabled, undefined, undefined);
      }

      const _runtime = await getOrCreateRuntime(guildId);
      const dashboardSettingsPatch: { messageTemplate?: string; sidebarFavorites?: string[] } = {};
      if (typeof body.messageTemplate === 'string') {
        dashboardSettingsPatch.messageTemplate = body.messageTemplate;
      }

      if (Object.prototype.hasOwnProperty.call(body, 'sidebarFavorites')) {
        if (!Array.isArray(body.sidebarFavorites)) {
          json(res, 400, { error: 'sidebarFavorites doit être un tableau de chemins.' });
          return true;
        }

        dashboardSettingsPatch.sidebarFavorites = body.sidebarFavorites
          .filter((entry): entry is string => typeof entry === 'string' && entry.startsWith('/'))
          .map((entry) => entry.trim())
          .filter((entry, index, arr) => entry.length > 0 && arr.indexOf(entry) === index)
          .slice(0, 80);
      }

      if (Object.keys(dashboardSettingsPatch).length > 0) {
        await prisma.dashboardSettings.update({
          where: { guildId },
          data: dashboardSettingsPatch
        });
      }

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Sauvegarde paramètres globaux',
        context: getGuildName(client, guildId),
        module: 'Dashboard',
        eventType: 'Manuel',
        details: 'Paramètres globaux mis à jour.',
        channelId: null
      });

      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('SettingsAPI', 'Error updating settings:', err);
      json(res, 500, { error: 'Erreur lors de la mise à jour des paramètres' });
    }
    return true;
  }

  // Regulation routes
  if (moduleKey === 'regulation') {
    // POST /api/dashboard/guilds/:guildId/regulation/articles
    if (parts.length === 6 && parts[5] === 'articles' && method === 'POST') {
      try {
        const body = await readJsonBody<{
          title?: string;
          description?: string;
          emoji?: string | null;
          sortOrder?: number | string | null;
          enabled?: boolean;
        }>(req);

        const title = body?.title?.trim() ?? '';
        const description = body?.description?.trim() ?? '';
        const emoji = body?.emoji?.trim() ?? null;
        const providedSortOrder = body?.sortOrder !== undefined ? Number(body.sortOrder) : null;
        const highestSortOrder = await prisma.guildRegulationArticle.findFirst({
          where: { guildId },
          orderBy: { sortOrder: 'desc' },
          select: { sortOrder: true },
        });
        const sortOrder = Number.isFinite(providedSortOrder)
          ? (providedSortOrder as number)
          : (highestSortOrder?.sortOrder ?? -1) + 1;

        if (!title || !description) {
          json(res, 400, { error: 'Le titre et la description sont obligatoires.' });
          return true;
        }

        const article = await prisma.guildRegulationArticle.create({
          data: {
            guildId,
            title,
            description,
            emoji: emoji || null,
            sortOrder,
            enabled: body?.enabled ?? true,
          },
        });

        const orderedArticles = await prisma.guildRegulationArticle.findMany({
          where: { guildId },
          select: { id: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        });

        await prisma.$transaction(
          orderedArticles.map((entry, index) =>
            prisma.guildRegulationArticle.update({
              where: { id: entry.id },
              data: { sortOrder: index },
            })
          )
        );

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Création article règlement',
          context: getGuildName(client, guildId),
          module: 'Règlement',
          eventType: 'Manuel',
          details: `Article "${article.title}" ajouté au règlement.`,
          channelId: null
        });

        json(res, 201, { ok: true, articleId: article.id });
      } catch (err) {
        logger.error('RegulationAPI', 'Error creating regulation article:', err);
        json(res, 500, { error: "Erreur lors de la création de l'article" });
      }
      return true;
    }

    // PATCH /api/dashboard/guilds/:guildId/regulation/articles/reorder
    if (parts.length === 7 && parts[5] === 'articles' && parts[6] === 'reorder' && method === 'PATCH') {
      try {
        const body = await readJsonBody<{ articleIds?: unknown }>(req);
        const requestedIds = Array.isArray(body?.articleIds)
          ? body.articleIds.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
          : [];

        if (requestedIds.length === 0) {
          json(res, 400, { error: 'La liste des articles à réordonner est invalide.' });
          return true;
        }

        const existingArticles = await prisma.guildRegulationArticle.findMany({
          where: { guildId },
          select: { id: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        });
        const existingById = new Set(existingArticles.map((article) => article.id));
        const orderedIds: string[] = [];
        const seenIds = new Set<string>();

        for (const articleId of requestedIds) {
          if (!existingById.has(articleId) || seenIds.has(articleId)) {
            continue;
          }

          orderedIds.push(articleId);
          seenIds.add(articleId);
        }

        for (const article of existingArticles) {
          if (seenIds.has(article.id)) {
            continue;
          }

          orderedIds.push(article.id);
          seenIds.add(article.id);
        }

        await prisma.$transaction(
          orderedIds.map((articleId, index) =>
            prisma.guildRegulationArticle.update({
              where: { id: articleId },
              data: { sortOrder: index },
            })
          )
        );

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Réordonnancement articles règlement',
          context: getGuildName(client, guildId),
          module: 'Règlement',
          eventType: 'Manuel',
          details: `${orderedIds.length} article(s) réorganisé(s).`,
          channelId: null
        });

        json(res, 200, { ok: true });
      } catch (err) {
        logger.error('RegulationAPI', 'Error reordering articles:', err);
        json(res, 500, { error: 'Erreur lors du réordonnancement des articles' });
      }
      return true;
    }

    // PATCH /api/dashboard/guilds/:guildId/regulation/articles/:articleId
    if (parts.length === 7 && parts[5] === 'articles' && method === 'PATCH') {
      const articleId = parts[6];
      try {
        const existingArticle = await prisma.guildRegulationArticle.findFirst({
          where: { id: articleId, guildId },
        });

        if (!existingArticle) {
          json(res, 404, { error: 'Article de règlement introuvable.' });
          return true;
        }

        const body = await readJsonBody<{
          title?: string;
          description?: string;
          emoji?: string | null;
          sortOrder?: number | string | null;
          enabled?: boolean;
        }>(req);

        const title = typeof body?.title === 'string' ? body.title.trim() : existingArticle.title;
        const description = typeof body?.description === 'string' ? body.description.trim() : existingArticle.description;
        const emoji = typeof body?.emoji === 'string' ? body.emoji.trim() : existingArticle.emoji;
        const sortOrderValue = body?.sortOrder !== undefined ? Number(body.sortOrder) : existingArticle.sortOrder;

        if (!title || !description) {
          json(res, 400, { error: 'Le titre et la description sont obligatoires.' });
          return true;
        }

        const article = await prisma.guildRegulationArticle.update({
          where: { id: existingArticle.id },
          data: {
            title,
            description,
            emoji: emoji || null,
            sortOrder: Number.isFinite(sortOrderValue) ? sortOrderValue : existingArticle.sortOrder,
            enabled: typeof body?.enabled === 'boolean' ? body.enabled : existingArticle.enabled,
          },
        });

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Modification article règlement',
          context: getGuildName(client, guildId),
          module: 'Règlement',
          eventType: 'Manuel',
          details: `Article "${article.title}" mis à jour.`,
          channelId: null
        });

        json(res, 200, { ok: true });
      } catch (err) {
        logger.error('RegulationAPI', 'Error patching article:', err);
        json(res, 500, { error: "Erreur lors de la modification de l'article" });
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/regulation/articles/:articleId
    if (parts.length === 7 && parts[5] === 'articles' && method === 'DELETE') {
      const articleId = parts[6];
      try {
        const article = await prisma.guildRegulationArticle.findFirst({ where: { id: articleId, guildId } });

        if (!article) {
          json(res, 404, { error: 'Article de règlement introuvable.' });
          return true;
        }

        await prisma.guildRegulationArticle.delete({ where: { id: article.id } });

        const remainingArticles = await prisma.guildRegulationArticle.findMany({
          where: { guildId },
          select: { id: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        });

        if (remainingArticles.length > 0) {
          await prisma.$transaction(
            remainingArticles.map((entry, index) =>
              prisma.guildRegulationArticle.update({
                where: { id: entry.id },
                data: { sortOrder: index },
              })
            )
          );
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Suppression article règlement',
          context: getGuildName(client, guildId),
          module: 'Règlement',
          eventType: 'Manuel',
          details: `Article "${article.title}" supprimé du règlement.`,
          channelId: null
        });

        json(res, 200, { ok: true });
      } catch (err) {
        logger.error('RegulationAPI', 'Error deleting article:', err);
        json(res, 500, { error: "Erreur lors de la suppression de l'article" });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/regulation/publish
    if (parts.length === 6 && parts[5] === 'publish' && method === 'POST') {
      try {
        const result = await publishOrUpdateRegulationMessage(client, guildId);

        await pushAudit(guildId, {
          user: auditUser,
          action: result.mode === 'updated' ? 'Actualisation règlement' : 'Publication règlement',
          context: getGuildName(client, guildId),
          module: 'Règlement',
          eventType: 'Manuel',
          details: result.mode === 'updated'
              ? 'Message de règlement mis à jour dans le salon de publication du règlement.'
              : 'Message de règlement publié dans le salon de publication du règlement.',
          channelId: null
        });

        json(res, 200, { ok: true, mode: result.mode, messageId: result.messageId });
      } catch (error) {
        logger.error('RegulationAPI', `Erreur lors de la publication du règlement pour la guilde ${guildId}:`, error);
        json(res, 400, {
          error: error instanceof Error ? error.message : 'Impossible de publier le règlement.',
        });
      }
      return true;
    }
  }

  // News routes
  if (moduleKey === 'news') {
    // GET /api/dashboard/guilds/:guildId/news
    if (parts.length === 5 && method === 'GET') {
      try {
        const articles = await prisma.newsArticle.findMany({
          where: { guildId },
          orderBy: { publishedAt: 'desc' },
        });
        json(res, 200, articles);
      } catch (err: unknown) {
        logger.error('NewsAPI', `Error listing news for guild ${guildId}: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la récupération des actualités' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/news
    if (parts.length === 5 && method === 'POST') {
      try {
        const body = await readJsonBody<{
          title: string;
          content: string;
          summary?: string;
          imageUrl?: string;
          category?: string;
          subcategory?: string;
          published?: boolean;
          publishMode?: 'summary' | 'full_embed';
        }>(req);

        if (!body || !body.title || !body.content) {
          json(res, 400, { error: 'Le titre et le contenu sont requis.' });
          return true;
        }

        const authorUser = await client.users.fetch(user.userId).catch(() => null);
        const authorName = authorUser?.globalName || authorUser?.username || user.username || 'Staff';
        const authorAvatar = authorUser?.displayAvatarURL() || null;

        const isPublished = body.published ?? false;

        const article = await prisma.newsArticle.create({
          data: {
            guildId,
            title: body.title,
            content: body.content,
            summary: body.summary || null,
            imageUrl: body.imageUrl || null,
            category: body.category || 'Mise à jour',
            subcategory: body.subcategory || '',
            published: isPublished,
            authorId: user.userId,
            authorName,
            authorAvatar,
            publishedAt: new Date(),
          },
        });

        await pushAudit(guildId, {
          user: auditUser,
          action: isPublished ? 'Publication actualité' : 'Création brouillon actualité',
          context: getGuildName(client, guildId),
          module: 'Actualités',
          eventType: 'Manuel',
          details: `Article "${body.title}" de catégorie "${body.category || 'Mise à jour'}" créé.`,
          channelId: null,
        });

        if (isPublished) {
          const publishMode = body.publishMode === 'full_embed' ? 'full_embed' : 'summary';
          await publishNewsArticle(client, guildId, article.id, publishMode).catch(err => {
            logger.error('NewsAPI', `Failed to send news notification to Discord for article ${article.id}:`, err);
          });
        }

        json(res, 201, article);
      } catch (err: unknown) {
        logger.error('NewsAPI', `Error creating news for guild ${guildId}: ${errorMessage(err)}`);
        json(res, 500, { error: "Erreur lors de la création de l'actualité" });
      }
      return true;
    }

    // PATCH /api/dashboard/guilds/:guildId/news/:articleId
    if (parts.length === 6 && method === 'PATCH') {
      const articleId = parts[5];
      try {
        const existing = await prisma.newsArticle.findUnique({
          where: { id: articleId },
        });

        if (!existing || existing.guildId !== guildId) {
          json(res, 404, { error: 'Actualité introuvable' });
          return true;
        }

        const body = await readJsonBody<{
          title?: string;
          content?: string;
          summary?: string;
          imageUrl?: string;
          category?: string;
          subcategory?: string;
          published?: boolean;
          publishMode?: 'summary' | 'full_embed';
        }>(req);

        if (!body) {
          json(res, 400, { error: 'Données manquantes' });
          return true;
        }

        const isPublishing = body.published === true && !existing.published;

        const updated = await prisma.newsArticle.update({
          where: { id: articleId },
          data: {
            title: body.title !== undefined ? body.title : undefined,
            content: body.content !== undefined ? body.content : undefined,
            summary: body.summary !== undefined ? body.summary : undefined,
            imageUrl: body.imageUrl !== undefined ? body.imageUrl : undefined,
            category: body.category !== undefined ? body.category : undefined,
            subcategory: body.subcategory !== undefined ? body.subcategory : undefined,
            published: body.published !== undefined ? body.published : undefined,
            publishedAt: isPublishing ? new Date() : undefined,
          },
        });

        await pushAudit(guildId, {
          user: auditUser,
          action: isPublishing ? 'Publication actualité' : 'Modification actualité',
          context: getGuildName(client, guildId),
          module: 'Actualités',
          eventType: 'Manuel',
          details: `Article "${updated.title}" mis à jour (Publié: ${updated.published}).`,
          channelId: null,
        });

        if (isPublishing) {
          const publishMode = body.publishMode === 'full_embed' ? 'full_embed' : 'summary';
          await publishNewsArticle(client, guildId, updated.id, publishMode).catch(err => {
            logger.error('NewsAPI', `Failed to send news notification to Discord for article ${updated.id}:`, err);
          });
        }

        json(res, 200, updated);
      } catch (err: unknown) {
        logger.error('NewsAPI', `Error updating news article ${articleId}: ${errorMessage(err)}`);
        json(res, 500, { error: "Erreur lors de la modification de l'actualité" });
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/news/:articleId
    if (parts.length === 6 && method === 'DELETE') {
      const articleId = parts[5];
      try {
        const existing = await prisma.newsArticle.findUnique({
          where: { id: articleId },
        });

        if (!existing || existing.guildId !== guildId) {
          json(res, 404, { error: 'Actualité introuvable' });
          return true;
        }

        await prisma.newsArticle.delete({
          where: { id: articleId },
        });

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Suppression actualité',
          context: getGuildName(client, guildId),
          module: 'Actualités',
          eventType: 'Manuel',
          details: `Article "${existing.title}" supprimé.`,
          channelId: null,
        });

        json(res, 200, { success: true });
      } catch (err: unknown) {
        logger.error('NewsAPI', `Error deleting news article ${articleId}: ${errorMessage(err)}`);
        json(res, 500, { error: "Erreur lors de la suppression de l'actualité" });
      }
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/news/category-configs
    if (parts.length === 6 && parts[5] === 'category-configs' && method === 'GET') {
      try {
        const configs = await prisma.newsCategoryConfig.findMany({
          where: { guildId },
          orderBy: { category: 'asc' },
        });
        json(res, 200, configs);
      } catch (err: unknown) {
        logger.error('NewsAPI', `Error listing news category configs for guild ${guildId}: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la récupération de la configuration des catégories' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/news/category-configs
    if (parts.length === 6 && parts[5] === 'category-configs' && method === 'POST') {
      try {
        const body = await readJsonBody<{
          category: string;
          subcategory?: string;
          channelId: string;
        }>(req);

        if (!body || !body.category || !body.channelId) {
          json(res, 400, { error: 'La catégorie et le salon Discord sont requis.' });
          return true;
        }

        const category = body.category.trim();
        const subcategory = (body.subcategory || '').trim();
        const channelId = body.channelId.trim();

        const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        if (!discordGuild) {
          json(res, 404, { error: 'Serveur introuvable' });
          return true;
        }
        const channel = await discordGuild.channels.fetch(channelId).catch(() => null);
        if (!channel) {
          json(res, 400, { error: 'Le salon Discord spécifié est introuvable ou inaccessible.' });
          return true;
        }

        const config = await prisma.newsCategoryConfig.upsert({
          where: {
            guildId_category_subcategory: {
              guildId,
              category,
              subcategory,
            }
          },
          create: {
            guildId,
            category,
            subcategory,
            channelId,
          },
          update: {
            channelId,
          }
        });

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Config catégorie actualité',
          context: getGuildName(client, guildId),
          module: 'Actualités',
          eventType: 'Manuel',
          details: `Configuration du salon #${channel.name} pour la catégorie "${category}"${subcategory ? ` (${subcategory})` : ''}.`,
          channelId: null,
        });

        json(res, 200, config);
      } catch (err: unknown) {
        logger.error('NewsAPI', `Error saving news category config for guild ${guildId}: ${errorMessage(err)}`);
        json(res, 500, { error: "Erreur lors de l'enregistrement de la configuration de catégorie" });
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/news/category-configs/:id
    if (parts.length === 7 && parts[5] === 'category-configs' && method === 'DELETE') {
      const configId = parts[6];
      try {
        const existing = await prisma.newsCategoryConfig.findUnique({
          where: { id: configId },
        });

        if (!existing || existing.guildId !== guildId) {
          json(res, 404, { error: 'Configuration de catégorie introuvable' });
          return true;
        }

        await prisma.newsCategoryConfig.delete({
          where: { id: configId },
        });

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Suppression config catégorie actualité',
          context: getGuildName(client, guildId),
          module: 'Actualités',
          eventType: 'Manuel',
          details: `Configuration de catégorie "${existing.category}"${existing.subcategory ? ` (${existing.subcategory})` : ''} supprimée.`,
          channelId: null,
        });

        json(res, 200, { success: true });
      } catch (err: unknown) {
        logger.error('NewsAPI', `Error deleting news category config ${configId}: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la suppression de la configuration de catégorie' });
      }
      return true;
    }
  }

  // PUT /api/dashboard/guilds/:guildId/command-access
  if (moduleKey === 'command-access' && parts.length === 5 && method === 'PUT') {
    try {
      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      const member = discordGuild ? await discordGuild.members.fetch(user.userId).catch(() => null) : null;
      const roleIds = member?.roles.cache.map((role) => role.id) ?? [];
      const featureAccess = await resolveFeatureAccessMap(client, guildId, access, user.userId, roleIds);

      if (!featureAccess.commands?.canConfigure && !access.canManageSettings) {
        json(res, 403, { error: 'Accès refusé. Permissions insuffisantes.' });
        return true;
      }

      const body = await readJsonBody<{ commandRestrictions?: unknown }>(req);
      if (!body) {
        json(res, 400, { error: 'Payload de restrictions invalide' });
        return true;
      }

      const commandRestrictions = normalizeCommandRestrictions(body.commandRestrictions);

      await prisma.dashboardSettings.update({
        where: { guildId },
        data: { commandRestrictions }
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Sauvegarde restrictions commandes',
        context: getGuildName(client, guildId),
        module: 'Dashboard',
        eventType: 'Manuel',
        details: `${commandRestrictions.length} règle(s) de commande enregistrée(s).`,
        channelId: null
      });

      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('CommandAccessAPI', 'Error updating command restrictions:', err);
      json(res, 500, { error: 'Erreur lors de la mise à jour des restrictions' });
    }
    return true;
  }

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
        const body = await readJsonBody<{ query: string; liveChannelId?: string | null; shortChannelId?: string | null; videoChannelId?: string | null }>(req);
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
            liveChannelId: body.liveChannelId || null,
            shortChannelId: body.shortChannelId || null,
            videoChannelId: body.videoChannelId || null,
          },
          update: {
            channelName,
            liveChannelId: body.liveChannelId || null,
            shortChannelId: body.shortChannelId || null,
            videoChannelId: body.videoChannelId || null,
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
        const follow = await prisma.youtubeChannelFollow.findUnique({ where: { id: followId } });
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
        const body = await readJsonBody<{ streamerName: string; liveChannelId?: string | null; otherChannelId?: string | null }>(req);
        if (!body?.streamerName) {
          json(res, 400, { error: 'streamerName requis' });
          return true;
        }
        const streamerName = body.streamerName.toLowerCase().trim();
        const streamerId = await getTwitchUserId(streamerName);

        const follow = await prisma.twitchChannelFollow.upsert({
          where: { guildId_streamerName: { guildId, streamerName } },
          create: {
            guildId,
            streamerName,
            streamerId,
            liveChannelId: body.liveChannelId || null,
            otherChannelId: body.otherChannelId || null,
          },
          update: {
            streamerId,
            liveChannelId: body.liveChannelId || null,
            otherChannelId: body.otherChannelId || null,
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
        const follow = await prisma.twitchChannelFollow.findUnique({ where: { id: followId } });
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

  // PUT /api/dashboard/guilds/:guildId/template
  if (moduleKey === 'template' && parts.length === 5 && method === 'PUT') {
    try {
      const body = await readJsonBody<{ messageTemplate: string }>(req);
      const runtime = await getOrCreateRuntime(guildId);
      await prisma.dashboardSettings.update({
        where: { guildId },
        data: { messageTemplate: body?.messageTemplate || runtime.messageTemplate }
      });
      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour template',
        context: getGuildName(client, guildId),
        module: 'Contenu',
        eventType: 'Manuel',
        details: 'Template de message éditorial mis à jour.',
        channelId: null
      });
      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('TemplateAPI', 'Error updating template:', err);
      json(res, 500, { error: 'Erreur lors de la mise à jour du template' });
    }
    return true;
  }

  // GET/POST /api/dashboard/guilds/:guildId/daily-algo-problems
  if (moduleKey === 'daily-algo-problems') {
    if (parts.length === 5 && method === 'GET') {
      try {
        const problems = await prisma.dailyAlgoProblem.findMany({
          orderBy: [
            { usedAt: { sort: 'asc', nulls: 'first' } },
            { createdAt: 'desc' },
          ]
        });
        json(res, 200, problems);
      } catch (err) {
        logger.error('DailyAlgoAPI', 'Error fetching daily algo problems:', err);
        json(res, 500, { error: 'Erreur lors de la récupération des exercices' });
      }
      return true;
    }

    if (parts.length === 5 && method === 'POST') {
      const MAIN_GUILD_ID = '1477350874740424986';
      const isBotAdmin = await resolveAdminAccess(client, user.userId);
      
      if (guildId !== MAIN_GUILD_ID && !isBotAdmin) {
        json(res, 403, { error: 'Seul le serveur principal peut ajouter des exercices.' });
        return true;
      }

      try {
        const body = await readJsonBody<{
          title: string;
          description: string;
          solution?: string;
          difficulty?: string;
          language?: string;
          functionName?: string;
          functionArgs?: unknown;
          unitTests?: unknown;
          allowedLanguages?: string[];
        }>(req);
        if (!body || !body.title || !body.description) {
          json(res, 400, { error: 'Payload invalide : champs manquants' });
          return true;
        }

        const problem = await prisma.dailyAlgoProblem.create({
          data: {
            title: body.title,
            description: body.description,
            solution: body.solution || '',
            difficulty: body.difficulty || 'moyen',
            language: body.language || 'fr',
            functionName: body.functionName || 'solve',
            functionArgs: body.functionArgs !== undefined ? (body.functionArgs as Prisma.InputJsonValue) : undefined,
            unitTests: body.unitTests !== undefined ? (body.unitTests as Prisma.InputJsonValue) : undefined,
            allowedLanguages: Array.isArray(body.allowedLanguages) ? body.allowedLanguages.map(String) : undefined,
          }
        });

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Ajout Exercice',
          context: getGuildName(client, guildId),
          module: 'Daily Algo',
          eventType: 'Manuel',
          details: `Ajout d'un nouvel exercice : ${problem.title}`,
          channelId: null
        });

        broadcastDashboardStateChange(guildId, 'daily_algo_problems_updated');

        json(res, 201, problem);
      } catch (err) {
        logger.error('DailyAlgoAPI', 'Error creating daily algo problem:', err);
        json(res, 500, { error: "Erreur lors de la création de l'exercice" });
      }
      return true;
    }

    // PATCH /api/dashboard/guilds/:guildId/daily-algo-problems/:problemId
    if (parts.length === 6 && method === 'PATCH') {
      const MAIN_GUILD_ID = '1477350874740424986';
      const isBotAdmin = await resolveAdminAccess(client, user.userId);
      
      if (guildId !== MAIN_GUILD_ID && !isBotAdmin) {
        json(res, 403, { error: 'Seul le serveur principal peut modifier des exercices.' });
        return true;
      }

      const problemId = parts[5];
      try {
        const body = await readJsonBody<{
          title?: string;
          description?: string;
          solution?: string;
          difficulty?: string;
          language?: string;
          functionName?: string;
          functionArgs?: unknown;
          unitTests?: unknown;
          allowedLanguages?: string[];
        }>(req);

        if (!body) {
          json(res, 400, { error: 'Payload invalide' });
          return true;
        }

        const existing = await prisma.dailyAlgoProblem.findUnique({
          where: { id: problemId }
        });

        if (!existing) {
          json(res, 404, { error: 'Exercice introuvable' });
          return true;
        }

        const updated = await prisma.dailyAlgoProblem.update({
          where: { id: problemId },
          data: {
            title: body.title !== undefined ? body.title : undefined,
            description: body.description !== undefined ? body.description : undefined,
            solution: body.solution !== undefined ? body.solution : undefined,
            difficulty: body.difficulty !== undefined ? body.difficulty : undefined,
            language: body.language !== undefined ? body.language : undefined,
            functionName: body.functionName !== undefined ? body.functionName : undefined,
            functionArgs: body.functionArgs !== undefined ? (body.functionArgs as Prisma.InputJsonValue) : undefined,
            unitTests: body.unitTests !== undefined ? (body.unitTests as Prisma.InputJsonValue) : undefined,
            allowedLanguages: Array.isArray(body.allowedLanguages) ? body.allowedLanguages.map(String) : undefined,
          }
        });

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Modification Exercice',
          context: getGuildName(client, guildId),
          module: 'Daily Algo',
          eventType: 'Manuel',
          details: `Exercice "${updated.title}" mis à jour.`,
          channelId: null
        });

        broadcastDashboardStateChange(guildId, 'daily_algo_problems_updated');

        json(res, 200, updated);
      } catch (err) {
        logger.error('DailyAlgoAPI', `Error updating daily algo problem ${problemId}:`, err);
        json(res, 500, { error: "Erreur lors de la modification de l'exercice" });
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/daily-algo-problems/:problemId
    if (parts.length === 6 && method === 'DELETE') {
      const MAIN_GUILD_ID = '1477350874740424986';
      const isBotAdmin = await resolveAdminAccess(client, user.userId);
      
      if (guildId !== MAIN_GUILD_ID && !isBotAdmin) {
        json(res, 403, { error: 'Seul le serveur principal peut supprimer des exercices.' });
        return true;
      }

      const problemId = parts[5];
      try {
        const existing = await prisma.dailyAlgoProblem.findUnique({
          where: { id: problemId }
        });

        if (!existing) {
          json(res, 404, { error: 'Exercice introuvable' });
          return true;
        }

        await prisma.dailyAlgoProblem.delete({
          where: { id: problemId }
        });

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Suppression Exercice',
          context: getGuildName(client, guildId),
          module: 'Daily Algo',
          eventType: 'Manuel',
          details: `Exercice "${existing.title}" supprimé.`,
          channelId: null
        });

        broadcastDashboardStateChange(guildId, 'daily_algo_problems_updated');

        json(res, 200, { success: true });
      } catch (err) {
        logger.error('DailyAlgoAPI', `Error deleting daily algo problem ${problemId}:`, err);
        json(res, 500, { error: "Erreur lors de la suppression de l'exercice" });
      }
      return true;
    }
  }

  // invitations routes
  if (moduleKey === 'invitations') {
    // GET /api/dashboard/guilds/:guildId/invitations
    if (parts.length === 5 && method === 'GET') {
      try {
        const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        if (discordGuild) {
          const { syncGuildInvites } = await import('../../../services/analytics/inviteService.js');
          await syncGuildInvites(discordGuild);
        }

        const invitations = await prisma.guildInvite.findMany({
          where: { guildId }
        });

        const suspendedInviters = await prisma.suspendedInviter.findMany({
          where: { guildId }
        });

        const inviteUsage = await prisma.memberInvite.groupBy({
          by: ['inviteCode'],
          where: { guildId, inviteCode: { not: null } },
          _count: {
            _all: true,
            leftAt: true,
          },
          _max: {
            joinedAt: true,
          }
        });

        const inviterUsage = await prisma.memberInvite.groupBy({
          by: ['inviterId', 'inviterTag'],
          where: { guildId, inviterId: { not: null } },
          _count: {
            _all: true,
            leftAt: true,
          },
          _max: {
            joinedAt: true,
          }
        });

        const totalJoined = await prisma.memberInvite.count({
          where: { guildId }
        });

        const totalLeft = await prisma.memberInvite.count({
          where: { guildId, leftAt: { not: null } }
        });

        json(res, 200, {
          invitations,
          suspendedInviters,
          inviteUsage,
          inviterUsage,
          summary: { totalJoined, totalLeft }
        });
      } catch (err) {
        logger.error('InvitationsAPI', 'Error fetching invitations:', err);
        json(res, 500, { error: 'Erreur lors de la récupération des invitations' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/invitations/suspended-inviters
    if (parts.length === 6 && parts[5] === 'suspended-inviters' && method === 'POST') {
      if (!access.canModerateContent && !access.canManageSettings) {
        json(res, 403, { error: 'Accès refusé. Permissions de modération requises.' });
        return true;
      }

      try {
        const body = await readJsonBody<{ userId: string; userTag?: string; reason?: string; cascade?: boolean }>(req);
        if (!body || !body.userId) {
          json(res, 400, { error: 'ID utilisateur requis' });
          return true;
        }

        const suspended = await prisma.suspendedInviter.upsert({
          where: { guildId_userId: { guildId, userId: body.userId } },
          create: {
            guildId,
            userId: body.userId,
            userTag: body.userTag || null,
            reason: body.reason || null
          },
          update: {
            userTag: body.userTag || null,
            reason: body.reason || null
          }
        });

        let cascadeResult: { purgedCount: number } | undefined;

        if (body.cascade) {
          const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
          if (discordGuild) {
            const invites = await discordGuild.invites.fetch().catch(() => null);
            if (invites) {
              for (const invite of invites.values()) {
                if (invite.inviter?.id === body.userId) {
                  await invite.delete('Creator suspended').catch(() => null);
                }
              }
            }
          }

          await prisma.guildInvite.updateMany({
            where: { guildId, inviterId: body.userId },
            data: { isSuspended: true }
          });

          const membersToPurge = await prisma.memberInvite.findMany({
            where: { guildId, inviterId: body.userId, leftAt: null }
          });

          let purgedCount = 0;
          if (discordGuild) {
            for (const m of membersToPurge) {
              const memberObj = await discordGuild.members.fetch(m.userId).catch(() => null);
              if (memberObj) {
                await memberObj.kick('Purge en cascade (créateur suspendu)').catch(() => null);
                purgedCount++;
              }
            }
          }

          await prisma.memberInvite.updateMany({
            where: { guildId, inviterId: body.userId, leftAt: null },
            data: { leftAt: new Date() }
          });

          cascadeResult = { purgedCount };
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Suspension Créateur',
          context: getGuildName(client, guildId),
          module: 'Invitations',
          eventType: 'Manuel',
          details: `Créateur d'invitations ${body.userId} suspendu.${body.cascade ? ` Cascade purge active.` : ''}`,
          channelId: null
        });

        json(res, 200, { ok: true, suspended, cascade: cascadeResult });
      } catch (err) {
        logger.error('InvitationsAPI', 'Error suspending creator:', err);
        json(res, 500, { error: 'Erreur lors de la suspension du créateur' });
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/invitations/suspended-inviters/:userId
    if (parts.length === 7 && parts[5] === 'suspended-inviters' && method === 'DELETE') {
      if (!access.canModerateContent && !access.canManageSettings) {
        json(res, 403, { error: 'Accès refusé. Permissions de modération requises.' });
        return true;
      }

      const userId = parts[6];
      try {
        await prisma.suspendedInviter.delete({
          where: { guildId_userId: { guildId, userId } }
        });

        await prisma.guildInvite.updateMany({
          where: { guildId, inviterId: userId },
          data: { isSuspended: false }
        });

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Restauration Créateur',
          context: getGuildName(client, guildId),
          module: 'Invitations',
          eventType: 'Manuel',
          details: `Créateur d'invitations ${userId} réhabilité.`,
          channelId: null
        });

        json(res, 200, { ok: true });
      } catch (err) {
        logger.error('InvitationsAPI', `Error removing suspended inviter ${userId}:`, err);
        json(res, 500, { error: 'Erreur lors de la réhabilitation du créateur' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/invitations/inviters/:userId/purge
    if (parts.length === 8 && parts[5] === 'inviters' && parts[7] === 'purge' && method === 'POST') {
      if (!access.canModerateContent && !access.canManageSettings) {
        json(res, 403, { error: 'Accès refusé. Permissions de modération requises.' });
        return true;
      }

      const userId = parts[6];
      try {
        const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        const membersToPurge = await prisma.memberInvite.findMany({
          where: { guildId, inviterId: userId, leftAt: null }
        });

        let purgedCount = 0;
        if (discordGuild) {
          for (const m of membersToPurge) {
            const memberObj = await discordGuild.members.fetch(m.userId).catch(() => null);
            if (memberObj) {
              await memberObj.kick('Purge en cascade (inviter purge)').catch(() => null);
              purgedCount++;
            }
          }
        }

        await prisma.memberInvite.updateMany({
          where: { guildId, inviterId: userId, leftAt: null },
          data: { leftAt: new Date() }
        });

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Purge Créateur',
          context: getGuildName(client, guildId),
          module: 'Invitations',
          eventType: 'Manuel',
          details: `Membres invités par ${userId} purgés (${purgedCount} exclus).`,
          channelId: null
        });

        json(res, 200, { purgedCount });
      } catch (err) {
        logger.error('InvitationsAPI', `Error purging inviter ${userId} members:`, err);
        json(res, 500, { error: 'Erreur lors de la purge du créateur' });
      }
      return true;
    }

    // PUT /api/dashboard/guilds/:guildId/invitations/:code/suspend
    if (parts.length === 7 && parts[6] === 'suspend' && method === 'PUT') {
      if (!access.canModerateContent && !access.canManageSettings) {
        json(res, 403, { error: 'Accès refusé. Permissions de modération requises.' });
        return true;
      }

      const code = parts[5];
      try {
        const body = await readJsonBody<{ suspended: boolean }>(req);
        if (!body || typeof body.suspended !== 'boolean') {
          json(res, 400, { error: 'Statut de suspension requis' });
          return true;
        }

        await prisma.guildInvite.update({
          where: { code },
          data: { isSuspended: body.suspended }
        });

        if (body.suspended) {
          const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
          if (discordGuild) {
            const inviteObj = await discordGuild.invites.fetch(code).catch(() => null);
            if (inviteObj) {
              await inviteObj.delete('Suspendu depuis le tableau de bord').catch(() => null);
            }
          }
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: body.suspended ? 'Suspension Invitation' : 'Restauration Invitation',
          context: getGuildName(client, guildId),
          module: 'Invitations',
          eventType: 'Manuel',
          details: `L'invitation ${code} a été ${body.suspended ? 'suspendue' : 'restaurée'}.`,
          channelId: null
        });

        json(res, 200, { ok: true });
      } catch (err) {
        logger.error('InvitationsAPI', `Error suspending invite ${code}:`, err);
        json(res, 500, { error: "Erreur lors de la suspension de l'invitation" });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/invitations/:code/purge
    if (parts.length === 7 && parts[6] === 'purge' && method === 'POST') {
      if (!access.canModerateContent && !access.canManageSettings) {
        json(res, 403, { error: 'Accès refusé. Permissions de modération requises.' });
        return true;
      }

      const code = parts[5];
      try {
        const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        const membersToPurge = await prisma.memberInvite.findMany({
          where: { guildId, inviteCode: code, leftAt: null }
        });

        let purgedCount = 0;
        if (discordGuild) {
          for (const m of membersToPurge) {
            const memberObj = await discordGuild.members.fetch(m.userId).catch(() => null);
            if (memberObj) {
              await memberObj.kick('Purge en cascade (code purge)').catch(() => null);
              purgedCount++;
            }
          }
        }

        await prisma.memberInvite.updateMany({
          where: { guildId, inviteCode: code, leftAt: null },
          data: { leftAt: new Date() }
        });

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Purge Invitation',
          context: getGuildName(client, guildId),
          module: 'Invitations',
          eventType: 'Manuel',
          details: `Membres invités via le code ${code} purgés (${purgedCount} exclus).`,
          channelId: null
        });

        json(res, 200, { purgedCount });
      } catch (err) {
        logger.error('InvitationsAPI', `Error purging members of invite ${code}:`, err);
        json(res, 500, { error: "Erreur lors de la purge de l'invitation" });
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/invitations/:code
    if (parts.length === 6 && method === 'DELETE') {
      if (!access.canModerateContent && !access.canManageSettings) {
        json(res, 403, { error: 'Accès refusé. Permissions de modération requises.' });
        return true;
      }

      const code = parts[5];
      try {
        const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        if (discordGuild) {
          const inviteObj = await discordGuild.invites.fetch(code).catch(() => null);
          if (inviteObj) {
            await inviteObj.delete('Supprimé depuis le tableau de bord').catch(() => null);
          }
        }

        await prisma.guildInvite.update({
          where: { code },
          data: { isDeleted: true }
        });

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Suppression Invitation',
          context: getGuildName(client, guildId),
          module: 'Invitations',
          eventType: 'Manuel',
          details: `L'invitation ${code} a été supprimée.`,
          channelId: null
        });

        json(res, 200, { ok: true });
      } catch (err) {
        logger.error('InvitationsAPI', `Error deleting invite ${code}:`, err);
        json(res, 500, { error: "Erreur lors de la suppression de l'invitation" });
      }
      return true;
    }
  }

  // Daily-algo runs routes
  if (moduleKey === 'daily-algo-runs') {
    // GET /api/dashboard/guilds/:guildId/daily-algo-runs/schedule
    if (parts.length === 6 && parts[5] === 'schedule' && method === 'GET') {
      try {
        const daysBack = Number(url.searchParams.get('daysBack') ?? '7');
        const daysForward = Number(url.searchParams.get('daysForward') ?? '21');
        const runs = await getDailyAlgoScheduleRuns(guildId, daysBack, daysForward);
        json(res, 200, { runs });
      } catch (err) {
        logger.error('DailyAlgoAPI', 'Erreur lors de la récupération du planning Daily Algo:', err);
        json(res, 500, { error: 'Erreur lors de la récupération du planning Daily Algo' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/daily-algo-runs/schedule/ensure
    if (parts.length === 7 && parts[5] === 'schedule' && parts[6] === 'ensure' && method === 'POST') {
      try {
        const body = await readJsonBody<{ daysForward?: unknown }>(req);
        const parsedDaysForward = Number(body?.daysForward ?? url.searchParams.get('daysForward') ?? '21');
        const daysForward = Number.isFinite(parsedDaysForward) ? parsedDaysForward : 21;
        const result = await ensureDailyAlgoScheduleRuns(guildId, daysForward);
        // Uniquement si le planning a reellement bouge : cette route est appelee
        // automatiquement a l'ouverture de la page, et prevenir les clients d'un
        // appel qui n'a rien cree ne ferait que les faire rappeler cette route.
        if (result.createdCount > 0) {
          broadcastDashboardStateChange(guildId, 'daily_algo_schedule_updated');
        }
        json(res, 200, { ok: true, ...result });
      } catch (err) {
        logger.error('DailyAlgoAPI', 'Erreur lors de la génération du planning Daily Algo:', err);
        json(res, 500, { error: err instanceof Error ? err.message : 'Erreur lors de la génération du planning Daily Algo' });
      }
      return true;
    }
  }

  // Semaine compétitive Daily Algo
  if (moduleKey === 'daily-algo-weeks') {
    // GET /api/dashboard/guilds/:guildId/daily-algo-weeks/current
    if (parts.length === 6 && parts[5] === 'current' && method === 'GET') {
      if (!access.canViewDashboard) {
        json(res, 403, { error: 'Accès refusé.' });
        return true;
      }

      try {
        const week = await getCurrentDailyAlgoWeek(guildId);
        json(res, 200, { week });
      } catch (err) {
        logger.error('DailyAlgoAPI', 'Erreur lors de la récupération de la semaine en cours:', err);
        json(res, 500, { error: 'Erreur lors de la récupération de la semaine en cours' });
      }
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/daily-algo-weeks/history
    if (parts.length === 6 && parts[5] === 'history' && method === 'GET') {
      if (!access.canViewDashboard) {
        json(res, 403, { error: 'Accès refusé.' });
        return true;
      }

      try {
        const parsedLimit = Number(url.searchParams.get('limit') ?? '10');
        const limit = Number.isFinite(parsedLimit) ? parsedLimit : 10;
        const weeks = await getDailyAlgoWeekHistory(guildId, limit);
        json(res, 200, { weeks });
      } catch (err) {
        logger.error('DailyAlgoAPI', 'Erreur lors de la récupération de l\'historique des semaines:', err);
        json(res, 500, { error: 'Erreur lors de la récupération de l\'historique des semaines' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/daily-algo-weeks/close
    // Clôture manuelle : « finir la semaine plus tôt ». Verse les récompenses
    // immédiatement, sans attendre le cron du lundi. Geste non annulable, donc
    // réservé à ceux qui peuvent configurer le serveur.
    if (parts.length === 6 && parts[5] === 'close' && method === 'POST') {
      if (!access.canManageSettings) {
        json(res, 403, { error: 'Seuls les administrateurs peuvent clôturer une semaine.' });
        return true;
      }

      try {
        const body = await readJsonBody<{ weekKey?: unknown }>(req);
        const weekKey = typeof body?.weekKey === 'string' && body.weekKey.trim().length > 0
          ? body.weekKey.trim()
          : undefined;

        const result = await closeDailyAlgoWeek({
          client,
          guildId,
          weekKey,
          closedById: user.userId,
        });

        if (result.status === 'disabled') {
          json(res, 400, { error: "Le Daily Algo n'est pas activé sur ce serveur." });
          return true;
        }

        if (result.status === 'already-closed') {
          json(res, 409, {
            error: `La semaine ${result.weekKey} est déjà clôturée et rien de nouveau n'est à rattraper.`,
            weekKey: result.weekKey,
          });
          return true;
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Clôture manuelle de la semaine Daily Algo',
          context: getGuildName(client, guildId),
          module: 'Daily Algo',
          eventType: 'Manuel',
          details: `Semaine ${result.weekKey} clôturée : ${result.participants} participant(s), ${result.xpGranted} XP versée, ${result.rolesAssigned} rôle(s) attribué(s).`,
          channelId: null,
        });

        json(res, 200, { ok: true, ...result });
      } catch (err) {
        logger.error('DailyAlgoAPI', 'Erreur lors de la clôture manuelle de la semaine:', err);
        json(res, 500, { error: err instanceof Error ? err.message : 'Erreur lors de la clôture de la semaine' });
      }
      return true;
    }
  }

  // GET/PATCH daily-algo-submissions routes
  if (moduleKey === 'daily-algo-submissions') {
    // GET /api/dashboard/guilds/:guildId/daily-algo-submissions/global-leaderboard
    if (parts.length === 6 && parts[5] === 'global-leaderboard' && method === 'GET') {
      try {
        const dateKey = getLocalDateKey();
        const runs = await prisma.dailyAlgoRun.findMany({
          where: { dateKey },
          select: { id: true, guildId: true }
        });

        const runIds = runs.map(r => r.id);
        const rawSubmissions = await prisma.dailyAlgoSubmission.findMany({
          where: { runId: { in: runIds }, status: 'APPROVED' },
          include: {
            run: {
              select: { guildId: true }
            }
          }
        });

        const submissions = rawSubmissions.map(submission => {
          const finalScore = resolveDailyAlgoFinalScore(submission);
          const totalPoints = resolveDailyAlgoTotalPoints(submission);

          return {
            id: submission.id,
            authorId: submission.authorId,
            authorName: submission.authorName,
            guildId: submission.run.guildId,
            guildName: getGuildName(client, submission.run.guildId),
            scoreFinal: finalScore,
            speedBonusPoints: submission.speedBonusPoints,
            totalPoints,
            submittedAt: submission.submittedAt.toISOString(),
          };
        });

        submissions.sort((a, b) => {
          if ((b.totalPoints ?? 0) !== (a.totalPoints ?? 0)) return (b.totalPoints ?? 0) - (a.totalPoints ?? 0);
          return new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime();
        });

        json(res, 200, { dateKey, submissions });
      } catch (err) {
        logger.error('DailyAlgoAPI', 'Error getting global leaderboard:', err);
        json(res, 500, { error: 'Erreur lors de la récupération du classement global' });
      }
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/daily-algo-submissions/today
    if (parts.length === 6 && parts[5] === 'today' && method === 'GET') {
      try {
        const dateKey = getLocalDateKey();
        const run = await prisma.dailyAlgoRun.findUnique({
          where: {
            guildId_dateKey: {
              guildId,
              dateKey,
            },
          },
          include: {
            problem: {
              select: {
                id: true,
                title: true,
                description: true,
                difficulty: true,
              },
            },
            submissions: {
              orderBy: {
                submittedAt: 'asc',
              },
            },
          },
        });

        if (!run) {
          json(res, 200, {
            dateKey,
            run: null,
            submissions: [],
          });
          return true;
        }

        const validatedByIds = [...new Set(run.submissions.map((submission) => submission.validatedById).filter((value): value is string => Boolean(value)))];
        const validatedByLabelEntries = await Promise.all(
          validatedByIds.map(async (moderatorId) => {
            const discordUser = await client.users.fetch(moderatorId).catch(() => null);
            return [moderatorId, discordUser?.globalName ?? discordUser?.username ?? `Utilisateur ${moderatorId}`] as const;
          }),
        );
        const validatedByMap = new Map<string, string>(validatedByLabelEntries);

        const submissions = run.submissions.map((submission) => {
          const finalScore = resolveDailyAlgoFinalScore(submission);
          const totalPoints = resolveDailyAlgoTotalPoints(submission);

          return {
            id: submission.id,
            authorId: submission.authorId,
            authorName: submission.authorName,
            solution: submission.solution,
            status: submission.status,
            submittedAt: submission.submittedAt.toISOString(),
            speedRank: submission.speedRank,
            speedBonusPoints: submission.speedBonusPoints,
            scoreCorrectness: submission.scoreCorrectness,
            scoreComments: submission.scoreComments,
            scoreCompactness: submission.scoreCompactness,
            scoreOptimization: submission.scoreOptimization,
            scoreReadability: submission.scoreReadability,
            scoreFinal: finalScore,
            totalPoints,
            reviewFeedback: submission.reviewFeedback,
            validatedById: submission.validatedById,
            validatedByName: submission.validatedById ? validatedByMap.get(submission.validatedById) ?? `Utilisateur ${submission.validatedById}` : null,
            validatedAt: submission.validatedAt?.toISOString() ?? null,
          };
        });

        json(res, 200, {
          dateKey,
          run: {
            id: run.id,
            challengeChannelId: run.challengeChannelId,
            validationChannelId: run.validationChannelId,
            problem: {
              id: run.problem.id,
              title: run.problem.title,
              description: run.problem.description,
              difficulty: run.problem.difficulty,
            },
            createdAt: run.createdAt.toISOString(),
          },
          submissions,
        });
      } catch (err) {
        logger.error('DailyAlgoAPI', 'Error getting today submissions:', err);
        json(res, 500, { error: 'Erreur lors de la récupération des soumissions du jour' });
      }
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/daily-algo-submissions/history
    if (parts.length === 6 && parts[5] === 'history' && method === 'GET') {
      try {
        const todayKey = getLocalDateKey();
        const limitParam = Number(url.searchParams.get('limit') ?? 7);
        const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(30, Math.trunc(limitParam))) : 7;

        const runs = await prisma.dailyAlgoRun.findMany({
          where: {
            guildId,
            dateKey: {
              lt: todayKey,
            },
          },
          orderBy: {
            dateKey: 'desc',
          },
          take: limit,
          include: {
            problem: {
              select: {
                id: true,
                title: true,
                difficulty: true,
              },
            },
            submissions: {
              orderBy: {
                submittedAt: 'asc',
              },
            },
          },
        });

        const history = runs.map((run) => {
          const approved = run.submissions.filter((submission) => submission.status === 'APPROVED');
          const rejected = run.submissions.filter((submission) => submission.status === 'REJECTED');
          const pending = run.submissions.filter((submission) => submission.status === 'PENDING');

          const topEntries = approved
            .map((submission) => ({
              id: submission.id,
              authorName: submission.authorName,
              totalPoints: resolveDailyAlgoTotalPoints(submission),
              scoreFinal: resolveDailyAlgoFinalScore(submission),
              speedBonusPoints: submission.speedBonusPoints,
              speedRank: submission.speedRank,
            }))
            .filter((entry) => entry.totalPoints !== null)
            .sort((left, right) => {
              if ((right.totalPoints ?? 0) !== (left.totalPoints ?? 0)) return (right.totalPoints ?? 0) - (left.totalPoints ?? 0);
              return (left.speedRank ?? 999) - (right.speedRank ?? 999);
            })
            .slice(0, 3);

          return {
            id: run.id,
            dateKey: run.dateKey,
            createdAt: run.createdAt.toISOString(),
            problem: {
              id: run.problem.id,
              title: run.problem.title,
              difficulty: run.problem.difficulty,
            },
            stats: {
              total: run.submissions.length,
              approved: approved.length,
              rejected: rejected.length,
              pending: pending.length,
            },
            topEntries,
          };
        });

        json(res, 200, {
          todayKey,
          history,
        });
      } catch (err) {
        logger.error('DailyAlgoAPI', 'Error getting submissions history:', err);
        json(res, 500, { error: "Erreur lors de la récupération de l'historique des soumissions" });
      }
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/daily-algo-submissions/:id
    if (parts.length === 6 && method === 'GET') {
      const submissionId = parts[5];
      try {
        const submission = await prisma.dailyAlgoSubmission.findUnique({
          where: { id: submissionId }
        });

        if (!submission) {
          json(res, 404, { error: 'Soumission introuvable' });
          return true;
        }

        const finalScore = resolveDailyAlgoFinalScore(submission);
        const totalPoints = resolveDailyAlgoTotalPoints(submission);

        json(res, 200, {
          id: submission.id,
          authorId: submission.authorId,
          authorName: submission.authorName,
          solution: submission.solution,
          status: submission.status,
          submittedAt: submission.submittedAt.toISOString(),
          speedRank: submission.speedRank,
          speedBonusPoints: submission.speedBonusPoints,
          scoreCorrectness: submission.scoreCorrectness,
          scoreComments: submission.scoreComments,
          scoreCompactness: submission.scoreCompactness,
          scoreOptimization: submission.scoreOptimization,
          scoreReadability: submission.scoreReadability,
          scoreFinal: finalScore,
          totalPoints,
          reviewFeedback: submission.reviewFeedback,
          validatedById: submission.validatedById,
          validatedAt: submission.validatedAt?.toISOString() ?? null,
        });
      } catch (err) {
        logger.error('DailyAlgoAPI', 'Error getting submission:', err);
        json(res, 500, { error: 'Erreur récupération soumission' });
      }
      return true;
    }

    // PATCH /api/dashboard/guilds/:guildId/daily-algo-submissions/:id
    if (parts.length === 6 && method === 'PATCH') {
      const submissionId = parts[5];
      try {
        const body = await readJsonBody<{
          // `dismiss` = hors-sujet : aucun point, mais aucune sanction.
          action?: 'approve' | 'reject' | 'dismiss';
          feedback?: string;
          scores?: {
            correctness?: number;
            comments?: number;
            compactness?: number;
            optimization?: number;
            readability?: number;
          };
        }>(req);

        if (!body?.action || !['approve', 'reject', 'dismiss'].includes(body.action)) {
          json(res, 400, { error: 'Action Daily Algo invalide.' });
          return true;
        }

        let scores:
          | {
              correctness: number;
              comments: number;
              compactness: number;
              optimization: number;
              readability: number;
            }
          | undefined;

        if (body.action === 'approve') {
          const rawScores = body.scores;
          if (!rawScores) {
            json(res, 400, { error: 'Les notes sont requises pour valider une soumission.' });
            return true;
          }

          const parsed = {
            correctness: Number(rawScores.correctness),
            comments: Number(rawScores.comments),
            compactness: Number(rawScores.compactness),
            optimization: Number(rawScores.optimization),
            readability: Number(rawScores.readability),
          };

          const hasInvalidScore = Object.values(parsed).some((value) => !Number.isFinite(value) || value < 1 || value > 5);
          if (hasInvalidScore) {
            json(res, 400, { error: 'Chaque note doit être comprise entre 1 et 5.' });
            return true;
          }

          scores = parsed;
        }

        const success = await reviewDailyAlgoSubmission({
          client,
          submissionId,
          action: body.action,
          moderatorId: user.userId,
          scores,
          feedback: body.feedback,
          allowReviewedUpdate: true,
        });

        if (!success) {
          json(res, 404, { error: 'Soumission Daily Algo introuvable ou déjà traitée.' });
          return true;
        }

        const auditAction = body.action === 'approve'
          ? 'Validation soumission Daily Algo'
          : body.action === 'dismiss'
            ? 'Soumission Daily Algo hors-sujet'
            : 'Rejet soumission Daily Algo';

        const auditDetails = body.action === 'approve'
          ? `Soumission ${submissionId} validée avec notation.`
          : body.action === 'dismiss'
            ? `Soumission ${submissionId} classée hors-sujet (aucun point, aucune sanction).`
            : `Soumission ${submissionId} rejetée.`;

        await pushAudit(guildId, {
          user: auditUser,
          action: auditAction,
          context: getGuildName(client, guildId),
          module: 'Daily Algo',
          eventType: 'Manuel',
          details: auditDetails,
          channelId: null,
        });

        json(res, 200, { ok: true });
      } catch (err) {
        logger.error('DailyAlgoAPI', 'Error reviewing submission:', err);
        json(res, 500, { error: 'Erreur lors du traitement de la soumission' });
      }
      return true;
    }
  }

  // POST /api/dashboard/guilds/:guildId/import
  if (moduleKey === 'import' && parts.length === 5 && method === 'POST') {
    try {
      const body = await readJsonBody<Record<string, unknown>>(req);
      if (!body) {
        json(res, 400, { error: 'Payload import invalide' });
        return true;
      }

      // Bloc `notifications` du fichier d'import : structure connue, mais le
      // fichier vient de l'utilisateur donc tous les champs sont optionnels.
      const notifications = (body?.notifications ?? {}) as Partial<{
        email: string;
        emailEnabled: boolean;
        cloudBackup: boolean;
        debugLog: boolean;
        killSwitchEnabled: boolean;
        severityByModule: unknown;
      }>;

      const runtime = await getOrCreateRuntime(guildId);
      await prisma.dashboardSettings.update({
        where: { guildId },
        data: {
          email: notifications.email ?? runtime.email,
          emailEnabled: !!notifications.emailEnabled,
          cloudBackup: !!notifications.cloudBackup,
          debugLog: !!notifications.debugLog,
          killSwitchEnabled: !!notifications.killSwitchEnabled,
          severityByModule: notifications.severityByModule ?? runtime.severityByModule,
          messageTemplate: body.messageTemplate ?? runtime.messageTemplate
        }
      });

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Import dashboard',
        context: getGuildName(client, guildId),
        module: 'Dashboard',
        eventType: 'Manuel',
        details: 'Configuration importée depuis un fichier JSON.',
        channelId: null
      });

      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('ImportAPI', 'Error importing state:', err);
      json(res, 500, { error: "Erreur lors de l'importation de la configuration" });
    }
    return true;
  }

  // Logs event configurations
  if (moduleKey === 'logs') {
    const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    const member = discordGuild ? await discordGuild.members.fetch(user.userId).catch(() => null) : null;
    const roleIds = member
      ? member.roles.cache
          .map((role) => role?.id)
          .filter((roleId): roleId is string => !!roleId)
      : [];
    const featureAccess = await resolveFeatureAccessMap(client, guildId, access, user.userId, roleIds);

    const isGetMethod = method === 'GET';
    if (!isGetMethod && !access.canManageSettings && !featureAccess.logs?.canConfigure) {
      json(res, 403, { error: 'Accès refusé. Seuls les administrateurs peuvent modifier les logs.' });
      return true;
    }

    if (isGetMethod && !access.canViewDashboard) {
      json(res, 403, { error: "Accès refusé. Vous n'avez pas accès au dashboard." });
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/logs/event-configs
    if (parts.length === 6 && parts[5] === 'event-configs' && method === 'GET') {
      try {
        const LOG_EVENT_TYPES = [
          'message_delete', 'message_edit', 'message_bulk_delete',
          'member_join', 'member_leave', 'member_roles_update', 'member_timeout',
          'moderation_kick', 'moderation_ban', 'moderation_unban',
          'voice_join', 'voice_leave', 'voice_move',
          'channel_lifecycle', 'role_lifecycle'
        ];

        const existingConfigs = await prisma.guildLogEventConfig.findMany({
          where: { guildId }
        });

        const existingMap = new Map(existingConfigs.map(c => [c.eventType, c]));
        const missingTypes = LOG_EVENT_TYPES.filter(t => !existingMap.has(t));

        if (missingTypes.length > 0) {
          await prisma.$transaction(
            missingTypes.map(t => prisma.guildLogEventConfig.create({
              data: {
                guildId,
                eventType: t,
                enabled: true,
                channelId: null
              }
            }))
          );
        }

        const allConfigs = await prisma.guildLogEventConfig.findMany({
          where: { guildId },
          orderBy: { eventType: 'asc' }
        });

        json(res, 200, { configs: allConfigs });
      } catch (err) {
        logger.error('LogsConfigAPI', 'Error fetching logs event configs:', err);
        json(res, 500, { error: 'Erreur lors de la récupération de la configuration des événements' });
      }
      return true;
    }

    // PUT /api/dashboard/guilds/:guildId/logs/event-configs
    if (parts.length === 6 && parts[5] === 'event-configs' && method === 'PUT') {
      try {
        const body = await readJsonBody<{
          configs: Array<{
            eventType: string;
            enabled: boolean;
            channelId: string | null;
          }>;
        }>(req);

        if (!body?.configs || !Array.isArray(body.configs)) {
          json(res, 400, { error: 'Format invalide. Liste de configurations attendue.' });
          return true;
        }

        await prisma.$transaction(
          body.configs.map(c => prisma.guildLogEventConfig.upsert({
            where: {
              guildId_eventType: { guildId, eventType: c.eventType }
            },
            update: {
              enabled: c.enabled,
              channelId: c.channelId ? c.channelId : null
            },
            create: {
              guildId,
              eventType: c.eventType,
              enabled: c.enabled,
              channelId: c.channelId ? c.channelId : null
            }
          }))
        );

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Mise à jour configuration logs granulaires',
          context: getGuildName(client, guildId),
          module: 'Logs',
          eventType: 'Manuel',
          details: 'Configuration par événement mise à jour.',
          channelId: null
        });

        json(res, 200, { ok: true });
      } catch (err) {
        logger.error('LogsConfigAPI', 'Error updating logs event configs:', err);
        json(res, 500, { error: 'Erreur lors de la mise à jour de la configuration des événements' });
      }
      return true;
    }
  }

  // Tickets routes
  if (moduleKey === 'tickets') {
    const isStaff = access.level === 'admin' || access.level === 'moderator';
    if (!isStaff) {
      json(res, 403, { error: 'Accès refusé. Réservé au staff.' });
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/tickets/config
    if (parts.length === 6 && parts[5] === 'config' && method === 'GET') {
      try {
        const guildConfig = await prisma.guild.findUnique({
          where: { id: guildId },
          select: {
            ticketCategoryId: true,
            ticketLogChannelId: true,
            ticketStaffRoleId: true,
            ticketChannelId: true,
            ticketEmbedTitle: true,
            ticketEmbedDesc: true,
            ticketEmbedButtonText: true,
            ticketEmbedColor: true,
            ticketEmbedType: true,
            ticketMode: true,
            ticketDmRelayChannelId: true,
            ticketTypes: true,
            ticketFormEnabled: true,
            ticketFormCustomFields: true,
            ticketEmbedThumbnail: true,
            ticketEmbedImage: true,
            ticketEmbedFooter: true,
            ticketEmbedAuthorName: true,
            ticketEmbedAuthorIcon: true,
            ticketWelcomeTitle: true,
            ticketWelcomeDesc: true,
            ticketWelcomeColor: true,
            ticketWelcomeThumbnail: true,
            ticketWelcomeImage: true,
            ticketWelcomeFooter: true,
            ticketAllowOverclaim: true,
            ticketOverclaimPermission: true,
            ticketInactivityEnabled: true,
            ticketInactivityHours: true,
            ticketInactivityMessage: true,
          }
        });
        json(res, 200, guildConfig || {});
      } catch (err) {
        logger.error('TicketsAPI', 'Error getting ticket config:', err);
        json(res, 500, { error: 'Erreur configuration' });
      }
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/tickets/transcripts?q=&from=&to=&limit=&offset=
    if (parts.length === 6 && parts[5] === 'transcripts' && method === 'GET') {
      try {
        const q = url.searchParams.get('q')?.trim() || '';
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 1), 200);
        const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);

        const where: Record<string, unknown> = { guildId };
        if (q) {
          where.OR = [
            { channelName: { contains: q, mode: 'insensitive' } },
            { channelId: { contains: q } },
            { id: { contains: q } },
          ];
        }
        if (from || to) {
          const createdAt: Record<string, Date> = {};
          if (from) { const d = new Date(from); if (!isNaN(d.getTime())) createdAt.gte = d; }
          if (to) { const d = new Date(to); if (!isNaN(d.getTime())) createdAt.lte = d; }
          if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;
        }

        const [transcripts, total] = await Promise.all([
          prisma.transcript.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: offset,
            take: limit,
            select: {
              id: true,
              guildId: true,
              channelId: true,
              channelName: true,
              startMessageId: true,
              endMessageId: true,
              startTime: true,
              endTime: true,
              createdAt: true
            }
          }),
          prisma.transcript.count({ where }),
        ]);
        json(res, 200, { transcripts, total, limit, offset });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error listing transcripts: ${(err as Error).message}`);
        json(res, 500, { error: 'Erreur lors de la récupération des transcriptions' });
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/tickets/transcripts/:transcriptId
    if (parts.length === 7 && parts[5] === 'transcripts' && method === 'DELETE') {
      if (access.level !== 'admin') {
        json(res, 403, { error: 'Seuls les administrateurs peuvent supprimer des transcriptions.' });
        return true;
      }
      const transcriptId = parts[6];
      if (!/^[a-zA-Z0-9_-]+$/.test(transcriptId)) {
        json(res, 400, { error: 'ID de transcription invalide' });
        return true;
      }
      try {
        const transcript = await prisma.transcript.findUnique({
          where: { id: transcriptId },
          select: { id: true, guildId: true },
        });
        if (!transcript || transcript.guildId !== guildId) {
          json(res, 404, { error: 'Transcription introuvable' });
          return true;
        }
        await prisma.transcript.delete({ where: { id: transcriptId } });
        json(res, 200, { ok: true });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error deleting transcript: ${(err as Error).message}`);
        json(res, 500, { error: 'Erreur lors de la suppression de la transcription' });
      }
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/tickets/transcripts/:transcriptId/signed-url
    if (parts.length === 8 && parts[5] === 'transcripts' && parts[7] === 'signed-url' && method === 'GET') {
      const transcriptId = parts[6];
      if (!/^[a-zA-Z0-9_-]+$/.test(transcriptId)) {
        json(res, 400, { error: 'ID de transcription invalide' });
        return true;
      }
      try {
        const transcript = await prisma.transcript.findUnique({
          where: { id: transcriptId },
          select: { id: true, guildId: true },
        });
        if (!transcript || transcript.guildId !== guildId) {
          json(res, 404, { error: 'Transcription introuvable' });
          return true;
        }
        const { generateTranscriptSignature } = await import('@kotbo/core');
        const { expires, signature } = generateTranscriptSignature(transcriptId, 3600);
        const signedUrl = `/api/public/transcripts/${transcriptId}?expires=${expires}&sig=${signature}`;
        json(res, 200, { signedUrl });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error generating signed transcript URL: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la génération du lien signé' });
      }
      return true;
    }

    // PATCH /api/dashboard/guilds/:guildId/tickets/config
    if (parts.length === 6 && parts[5] === 'config' && method === 'PATCH') {
      if (access.level !== 'admin') {
        json(res, 403, { error: 'Seuls les administrateurs peuvent modifier la configuration.' });
        return true;
      }

      interface TicketConfigInput {
        ticketCategoryId?: string | null;
        ticketLogChannelId?: string | null;
        ticketStaffRoleId?: string | null;
        ticketChannelId?: string | null;
        ticketEmbedTitle?: string | null;
        ticketEmbedDesc?: string | null;
        ticketEmbedButtonText?: string | null;
        ticketEmbedColor?: string | null;
        ticketEmbedType?: string | null;
        ticketMode?: string | null;
        ticketDmRelayChannelId?: string | null;
        ticketFormEnabled?: boolean | null;
        ticketFormCustomFields?: Record<string, unknown> | unknown[] | null;
        ticketEmbedThumbnail?: string | null;
        ticketEmbedImage?: string | null;
        ticketEmbedFooter?: string | null;
        ticketEmbedAuthorName?: string | null;
        ticketEmbedAuthorIcon?: string | null;
        ticketWelcomeTitle?: string | null;
        ticketWelcomeDesc?: string | null;
        ticketWelcomeColor?: string | null;
        ticketWelcomeThumbnail?: string | null;
        ticketWelcomeImage?: string | null;
        ticketWelcomeFooter?: string | null;
        /** Types de tickets proposes a l'ouverture, valides plus bas champ par champ. */
        ticketTypes?: unknown;
        ticketAllowOverclaim?: unknown;
        ticketInactivityEnabled?: unknown;
        ticketInactivityHours?: unknown;
        ticketInactivityMessage?: unknown;
        ticketOverclaimPermission?: unknown;
      }

      try {
        const body = (await readJsonBody<TicketConfigInput>(req)) ?? {};
        const updated = await prisma.guild.update({
          where: { id: guildId },
          data: {
            ticketCategoryId: body.ticketCategoryId || null,
            ticketLogChannelId: body.ticketLogChannelId || null,
            ticketStaffRoleId: body.ticketStaffRoleId || null,
            ticketChannelId: body.ticketChannelId || null,
            ticketEmbedTitle: body.ticketEmbedTitle || 'Support Technique',
            ticketEmbedDesc: body.ticketEmbedDesc || 'Cliquez sur le bouton ci-dessous pour ouvrir un ticket de support.',
            ticketEmbedButtonText: body.ticketEmbedButtonText || 'Ouvrir un ticket',
            ticketEmbedColor: body.ticketEmbedColor || '#5865F2',
            ticketEmbedType: body.ticketEmbedType === 'DROPDOWN' ? 'DROPDOWN' : 'BUTTONS',
            ticketMode: body.ticketMode === 'DM' || body.ticketMode === 'THREAD' ? body.ticketMode : 'CHANNEL',
            ticketDmRelayChannelId: body.ticketDmRelayChannelId || null,
            ticketFormEnabled: body.ticketFormEnabled ?? true,
            ticketFormCustomFields: (body.ticketFormCustomFields ?? null) as Prisma.InputJsonValue,
            ticketEmbedThumbnail: body.ticketEmbedThumbnail || null,
            ticketEmbedImage: body.ticketEmbedImage || null,
            ticketEmbedFooter: body.ticketEmbedFooter || null,
            ticketEmbedAuthorName: body.ticketEmbedAuthorName || null,
            ticketEmbedAuthorIcon: body.ticketEmbedAuthorIcon || null,
            ticketWelcomeTitle: body.ticketWelcomeTitle || "🎫 Ticket d'Assistance · {type_label}",
            ticketWelcomeDesc: body.ticketWelcomeDesc || "Bonjour {user} !\nLe personnel {staff_mention} va prendre en charge votre demande rapidement. En attendant, merci de bien détailler vos questions ou explications.\n\n**Description du problème :**\n{description}",
            ticketWelcomeColor: body.ticketWelcomeColor || "#5865F2",
            ticketWelcomeThumbnail: body.ticketWelcomeThumbnail || null,
            ticketWelcomeImage: body.ticketWelcomeImage || null,
            ticketWelcomeFooter: body.ticketWelcomeFooter || "Kotbo · Ticket ID: {ticket_id}",
            ...(body.ticketTypes !== undefined
              ? {
                  ticketTypes: Array.isArray(body.ticketTypes)
                    ? body.ticketTypes
                        .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
                        .map((item, index: number) => ({
                          id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `ticket-type-${index + 1}`,
                          label: typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 80) : `Ticket ${index + 1}`,
                          description: typeof item.description === 'string' ? item.description.trim().slice(0, 200) : null,
                          emoji: typeof item.emoji === 'string' ? item.emoji.trim().slice(0, 16) : null,
                          categoryId: typeof item.categoryId === 'string' && item.categoryId.trim() ? item.categoryId.trim() : null,
                          staffRoleId: typeof item.staffRoleId === 'string' && item.staffRoleId.trim() ? item.staffRoleId.trim() : null,
                          buttonStyle: item.buttonStyle === 'SECONDARY' || item.buttonStyle === 'SUCCESS' || item.buttonStyle === 'DANGER'
                            ? item.buttonStyle
                            : 'PRIMARY',
                          mode: item.mode === 'CHANNEL' || item.mode === 'DM' || item.mode === 'THREAD' ? item.mode : null,
                          anonymous: item.anonymous === true,
                          staffServerRelay: item.staffServerRelay === true,
                          staffServerChannel: item.staffServerChannel === true,
                          staffServerCategoryId: typeof item.staffServerCategoryId === 'string' && item.staffServerCategoryId.trim() ? item.staffServerCategoryId.trim() : null,
                          formEnabled: item.formEnabled !== false,
                          fields: Array.isArray(item.fields) ? item.fields : null,
                          formCustomFields: Array.isArray(item.formCustomFields) ? item.formCustomFields : null,
                        })) as unknown as Prisma.InputJsonValue
                    : Prisma.JsonNull,
                }
              : {}),
            ticketAllowOverclaim: typeof body.ticketAllowOverclaim === 'boolean' ? body.ticketAllowOverclaim : true,
            ticketOverclaimPermission: typeof body.ticketOverclaimPermission === 'string' ? body.ticketOverclaimPermission : 'ANY',
            ticketInactivityEnabled: typeof body.ticketInactivityEnabled === 'boolean' ? body.ticketInactivityEnabled : false,
            ticketInactivityHours: body.ticketInactivityHours !== undefined ? Number(body.ticketInactivityHours) : 24,
            ticketInactivityMessage: body.ticketInactivityMessage !== undefined ? String(body.ticketInactivityMessage) : "Bonjour {user}, votre ticket est inactif depuis un moment. N'hésitez pas à y répondre si vous avez toujours besoin d'aide !",
          }
        });

        json(res, 200, { success: true, config: updated });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error updating ticket config: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la mise à jour de la configuration' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/tickets/config/send-embed
    if (parts.length === 7 && parts[5] === 'config' && parts[6] === 'send-embed' && method === 'POST') {
      if (access.level !== 'admin') {
        json(res, 403, { error: 'Seuls les administrateurs peuvent envoyer le panel.' });
        return true;
      }

      try {
        const { sendTicketSetupEmbed } = await import('../../../services/features/ticketService.js');
        await sendTicketSetupEmbed(client, guildId);
        json(res, 200, { success: true });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error sending ticket setup embed: ${errorMessage(err)}`);
        json(res, 500, { error: errorMessage(err) || "Erreur lors de l'envoi de l'embed" });
      }
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/tickets
    if (parts.length === 5 && method === 'GET') {
      try {
        const tickets = await prisma.ticket.findMany({
          where: { guildId },
          orderBy: { createdAt: 'desc' },
        });

        const fetchAvatar = async (discordId: string, size = 64): Promise<string | null> => {
          try {
            const u = client.users.cache.get(discordId) || await client.users.fetch(discordId);
            return u.displayAvatarURL({ size: size as 64 | 128 });
          } catch {
            return `https://cdn.discordapp.com/embed/avatars/${(BigInt(discordId) >> 22n) % 6n}.png`;
          }
        };

        const enrichedTickets = await Promise.all(tickets.map(async (t) => {
          const userAvatar = await fetchAvatar(t.userId);
          const claimedByAvatar = t.claimedById ? await fetchAvatar(t.claimedById) : null;
          return { ...t, userAvatar, claimedByAvatar };
        }));

        const guildConfig = await prisma.guild.findUnique({
          where: { id: guildId },
          select: {
            ticketCategoryId: true,
            ticketLogChannelId: true,
            ticketStaffRoleId: true,
            ticketChannelId: true,
            ticketEmbedTitle: true,
            ticketEmbedDesc: true,
            ticketEmbedButtonText: true,
            ticketEmbedColor: true,
            ticketEmbedType: true,
            ticketMode: true,
            ticketDmRelayChannelId: true,
            ticketTypes: true,
            ticketFormEnabled: true,
            ticketFormCustomFields: true,
            ticketEmbedThumbnail: true,
            ticketEmbedImage: true,
            ticketEmbedFooter: true,
            ticketEmbedAuthorName: true,
            ticketEmbedAuthorIcon: true,
            ticketWelcomeTitle: true,
            ticketWelcomeDesc: true,
            ticketWelcomeColor: true,
            ticketWelcomeThumbnail: true,
            ticketWelcomeImage: true,
            ticketWelcomeFooter: true,
            ticketAllowOverclaim: true,
            ticketOverclaimPermission: true,
            ticketInactivityEnabled: true,
            ticketInactivityHours: true,
            ticketInactivityMessage: true,
          }
        });
        json(res, 200, { tickets: enrichedTickets, config: guildConfig || {} });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error listing tickets: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la récupération des tickets' });
      }
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/tickets/:ticketId
    if (parts.length === 6 && method === 'GET') {
      const ticketId = parts[5];
      try {
        const ticket = await prisma.ticket.findUnique({
          where: { id: ticketId }
        });

        if (!ticket) {
          json(res, 404, { error: 'Ticket introuvable' });
          return true;
        }

        let channelName: string | null = null;
        let messages: unknown[] = [];
        if (ticket.channelId) {
          const discordChannel = client.channels.cache.get(ticket.channelId);
          if (discordChannel && discordChannel instanceof TextChannel) {
            channelName = discordChannel.name;
            try {
              const fetched = await discordChannel.messages.fetch({ limit: 50 });
              const guild = discordChannel.guild;
              messages = fetched.map(m => ({
                id: m.id,
                authorId: m.author.id,
                authorName: m.member?.displayName || m.author.displayName || m.author.username,
                authorAvatar: m.author.displayAvatarURL(),
                isStaff: m.author.bot,
                content: m.content,
                htmlContent: parseDiscordMarkdown(m.content, guild),
                mediaUrls: extractMediaUrls(m.content),
                stickers: m.stickers ? m.stickers.map(s => ({ id: s.id, name: s.name, url: s.url })) : [],
                attachments: m.attachments.map(a => ({ url: a.url, contentType: a.contentType })),
                embeds: msgEmbedsMap(m.embeds, guild),
                createdAt: m.createdAt.toISOString()
              }));
              messages.reverse();
            } catch { /* ignored */ }
          }
        }

        const fetchAvatarDetail = async (discordId: string, size = 128): Promise<string | null> => {
          try {
            const u = client.users.cache.get(discordId) || await client.users.fetch(discordId);
            return u.displayAvatarURL({ size: size as 64 | 128 });
          } catch {
            return `https://cdn.discordapp.com/embed/avatars/${(BigInt(discordId) >> 22n) % 6n}.png`;
          }
        };
        const userAvatar = await fetchAvatarDetail(ticket.userId, 128);
        const claimedByAvatar = ticket.claimedById ? await fetchAvatarDetail(ticket.claimedById) : null;

        json(res, 200, { ticket: { ...ticket, channelName, userAvatar, claimedByAvatar }, messages });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error reading ticket details: ${errorStack(err)}`);
        json(res, 500, { error: `Erreur lors de la récupération du ticket: ${errorStack(err)}` });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/tickets/:ticketId/message
    if (parts.length === 7 && parts[6] === 'message' && method === 'POST') {
      const ticketId = parts[5];
      try {
        const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
        if (!ticket || !ticket.channelId) {
          json(res, 404, { error: 'Ticket introuvable ou salon inactif' });
          return true;
        }

        const body = await readJsonBody<{ content: string }>(req);
        if (!body?.content) {
          json(res, 400, { error: 'Contenu du message requis' });
          return true;
        }

        const discordChannel = client.channels.cache.get(ticket.channelId);
        if (!discordChannel || !(discordChannel instanceof TextChannel)) {
          json(res, 400, { error: 'Salon Discord introuvable' });
          return true;
        }

        const sent = await discordChannel.send(`💬 **[Kotbo Dashboard - ${user.username}]** ${body.content}`);
        
        json(res, 200, {
          success: true,
          message: {
            id: sent.id,
            author: {
              id: client.user?.id || 'bot',
              username: 'Kotbo',
              displayName: 'Kotbo',
              avatar: client.user?.displayAvatarURL() || '',
              bot: true
            },
            content: sent.content,
            createdAt: sent.createdAt.toISOString()
          }
        });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error sending message to ticket: ${errorMessage(err)}`);
        json(res, 500, { error: "Erreur lors de l'envoi du message" });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/tickets/:ticketId/claim
    if (parts.length === 7 && parts[6] === 'claim' && method === 'POST') {
      const ticketId = parts[5];
      try {
        const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
        if (!ticket) {
          json(res, 404, { error: 'Ticket introuvable' });
          return true;
        }

        const guildConfig = await prisma.guild.findUnique({ where: { id: guildId } });
        if (!guildConfig) {
          json(res, 404, { error: 'Serveur introuvable' });
          return true;
        }

        const allowOverclaim = guildConfig.ticketAllowOverclaim ?? true;
        const overclaimPermission = guildConfig.ticketOverclaimPermission || 'ANY';

        if (ticket.status === 'CLAIMED') {
          if (!allowOverclaim || overclaimPermission === 'NONE') {
            json(res, 400, { error: `Ce ticket est déjà pris en charge par ${ticket.claimedByName || ticket.claimedById}.` });
            return true;
          }

          if (ticket.claimedById === user.userId) {
            json(res, 400, { error: 'Vous prenez déjà en charge ce ticket.' });
            return true;
          }

          if (overclaimPermission === 'SUPERIOR_OR_EQUAL') {
            const isDashboardAdmin = access.level === 'admin';
            if (!isDashboardAdmin) {
              const getStaffLevelLocal = async (uid: string) => {
                const staff = await prisma.staffMember.findUnique({
                  where: { guildId_userId: { guildId, userId: uid } }
                });
                if (!staff) return 0;
                const role = await prisma.staffRole.findFirst({
                  where: { guildId, name: staff.grade, enabled: true }
                });
                return role ? role.level : 0;
              };

              const claimantLevel = await getStaffLevelLocal(user.userId);
              const currentLevel = ticket.claimedById ? await getStaffLevelLocal(ticket.claimedById) : 0;

              if (claimantLevel < currentLevel) {
                json(res, 403, { error: 'Votre grade est insuffisant pour sur-revendiquer ce ticket.' });
                return true;
              }
            }
          }
        }

        const updated = await prisma.ticket.update({
          where: { id: ticketId },
          data: {
            status: 'CLAIMED',
            claimedById: user.userId,
            claimedByName: user.username
          }
        });

        if (ticket.channelId) {
          const ch = client.channels.cache.get(ticket.channelId);
          if (ch && ch instanceof TextChannel) {
            try {
              const welcomeMsg = (await ch.messages.fetch({ limit: 50 })).find(m => m.author.id === client.user?.id && m.embeds.length > 0 && m.embeds[0].title?.startsWith('🎫'));
              if (welcomeMsg) {
                const oldEmbed = welcomeMsg.embeds[0];
                if (oldEmbed) {
                  const updatedEmbed = EmbedBuilder.from(oldEmbed)
                    .setColor(COLORS.warning as ColorResolvable)
                    .setDescription(`Ce ticket est actuellement pris en charge par **${user.username}**.\n\n**Auteur :** <@${ticket.userId}>\n**Raison :** ${ticket.reason}\n**Description :** ${ticket.description}`)
                    .setFields([
                      { name: 'Statut', value: `🛠️ Pris en charge par <@${user.userId}>`, inline: true }
                    ]);

                  const componentsList: ButtonBuilder[] = [];
                  if (allowOverclaim && overclaimPermission !== 'NONE') {
                    componentsList.push(
                      new ButtonBuilder().setCustomId(`ticket:claim:${ticketId}`).setLabel('Sur-revendiquer').setStyle(ButtonStyle.Primary).setEmoji('🛠️')
                    );
                  }
                  componentsList.push(
                    new ButtonBuilder().setCustomId(`ticket:info:${ticketId}`).setLabel('Infos Membre').setStyle(ButtonStyle.Secondary).setEmoji('🔍'),
                    new ButtonBuilder().setCustomId(`ticket:close:${ticketId}`).setLabel('Fermer').setStyle(ButtonStyle.Danger).setEmoji('🔒')
                  );

                  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(componentsList);
                  await welcomeMsg.edit({ embeds: [updatedEmbed], components: [row] }).catch(() => null);
                }
              }
            } catch (welcomeErr) {
              logger.error('TicketsAPI', `Error updating welcome embed from dashboard API: ${welcomeErr}`);
            }

            await ch.send({
              embeds: [successEmbed('Pris en charge', `Ce ticket a été revendiqué depuis le Dashboard Kotbo par **${user.username}**.`)]
            }).catch(() => null);
          }
        }

        json(res, 200, updated);
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error claiming ticket: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la prise en charge du ticket' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/tickets/:ticketId/close
    if (parts.length === 7 && parts[6] === 'close' && method === 'POST') {
      const ticketId = parts[5];
      try {
        const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
        if (!ticket) {
          json(res, 404, { error: 'Ticket introuvable' });
          return true;
        }

        const { closeTicket } = await import('../../../services/features/ticketService.js');
        const updated = await closeTicket(client, ticketId, user.userId, user.username ?? user.userId);

        json(res, 200, updated);
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error closing ticket: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/tickets/:ticketId/reopen
    if (parts.length === 7 && parts[6] === 'reopen' && method === 'POST') {
      const ticketId = parts[5];
      try {
        const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
        if (!ticket) {
          json(res, 404, { error: 'Ticket introuvable' });
          return true;
        }

        const updated = await prisma.ticket.update({
          where: { id: ticketId },
          data: {
            status: 'OPEN',
            closedById: null,
            closedByName: null,
            closedAt: null
          }
        });

        if (ticket.channelId) {
          const ch = client.channels.cache.get(ticket.channelId);
          if (ch && ch instanceof TextChannel) {
            await ch.permissionOverwrites.edit(ticket.userId, {
              ViewChannel: true,
              SendMessages: true,
              ReadMessageHistory: true
            }).catch(() => {});

            const { renameChannelToOpen } = await import('../../../services/features/ticketService.js');
            await renameChannelToOpen(client, ticket.channelId).catch(() => {});

            await ch.send({
              embeds: [successEmbed('Ticket Réouvert', `Le ticket a été réouvert depuis le Dashboard Kotbo par **${user.username}**.`)]
            }).catch(() => null);
          }
        }

        json(res, 200, updated);
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error reopening ticket: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/tickets/:ticketId/rename
    if (parts.length === 7 && parts[6] === 'rename' && method === 'POST') {
      const ticketId = parts[5];
      try {
        const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
        if (!ticket) {
          json(res, 404, { error: 'Ticket introuvable' });
          return true;
        }

        const body = await readJsonBody<{ name?: string }>(req);
        const requestedName = body?.name?.trim();
        if (!requestedName) {
          json(res, 400, { error: 'Le nouveau nom est requis' });
          return true;
        }

        const guildConfig = await prisma.guild.findUnique({ where: { id: guildId } });
        if (!guildConfig) {
          json(res, 404, { error: 'Serveur introuvable' });
          return true;
        }

        const { renameTicketChannel } = await import('../../../services/features/ticketService.js');
        const finalName = await renameTicketChannel(
          client,
          ticket,
          guildConfig!,
          { id: user.userId, username: user.username || 'Utilisateur' },
          requestedName,
        );

        json(res, 200, { success: true, channelName: finalName });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error renaming ticket: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors du renommage du ticket' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/tickets/:ticketId/restore
    if (parts.length === 7 && parts[6] === 'restore' && method === 'POST') {
      const ticketId = parts[5];
      try {
        const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
        if (!ticket) {
          json(res, 404, { error: 'Ticket introuvable' });
          return true;
        }
        if (ticket.status !== 'CLOSED') {
          json(res, 400, { error: 'Seul un ticket fermé peut être restauré.' });
          return true;
        }
        if (!ticket.transcriptId) {
          json(res, 400, { error: "Ce ticket n'a pas de transcription associée." });
          return true;
        }

        // Restore limits: 1st = instant, 2nd = after 1 day, 3rd = after 1 week, then blocked
        const restoreCount = ticket.restoreCount ?? 0;
        const lastRestoredAt = ticket.lastRestoredAt;
        if (restoreCount >= 3) {
          json(res, 429, { error: 'Ce ticket a atteint la limite maximale de restaurations (3).' });
          return true;
        }
        if (restoreCount === 1 && lastRestoredAt) {
          const oneDayMs = 24 * 60 * 60 * 1000;
          const elapsed = Date.now() - new Date(lastRestoredAt).getTime();
          if (elapsed < oneDayMs) {
            const remaining = Math.ceil((oneDayMs - elapsed) / (60 * 60 * 1000));
            json(res, 429, { error: `Deuxième restauration disponible dans ${remaining}h. Délai : 24h après la première restauration.` });
            return true;
          }
        }
        if (restoreCount === 2 && lastRestoredAt) {
          const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
          const elapsed = Date.now() - new Date(lastRestoredAt).getTime();
          if (elapsed < oneWeekMs) {
            const remainingDays = Math.ceil((oneWeekMs - elapsed) / (24 * 60 * 60 * 1000));
            json(res, 429, { error: `Troisième restauration disponible dans ${remainingDays}j. Délai : 7 jours après la deuxième restauration.` });
            return true;
          }
        }

        const transcript = await prisma.transcript.findUnique({ where: { id: ticket.transcriptId } });
        if (!transcript) {
          json(res, 404, { error: 'Transcription introuvable.' });
          return true;
        }

        const guildConfig = await prisma.guild.findUnique({ where: { id: guildId } });
        if (!guildConfig) {
          json(res, 404, { error: 'Serveur introuvable' });
          return true;
        }

        const discordGuild = client.guilds.cache.get(guildId);
        if (!discordGuild) {
          json(res, 404, { error: 'Serveur Discord introuvable.' });
          return true;
        }

        const categoryId = ticket.categoryId || guildConfig.ticketCategoryId || null;
        const ticketCategory = categoryId ? discordGuild.channels.cache.get(categoryId) : null;
        const staffRoleId = ticket.staffRoleId || guildConfig.ticketStaffRoleId || null;

        const cleanedUsername = ticket.username.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'membre';
        const channelName = `ticket-${cleanedUsername}`;

        const permissionOverwrites: OverwriteResolvable[] = [
          { id: discordGuild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: ticket.userId, allow: [
            PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.AttachFiles
          ]}
        ];
        if (staffRoleId) {
          permissionOverwrites.push({ id: staffRoleId, allow: [
            PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.AttachFiles
          ]});
        }
        if (guildConfig.moderatorRoleId) {
          permissionOverwrites.push({ id: guildConfig.moderatorRoleId, allow: [
            PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.EmbedLinks,
            PermissionFlagsBits.AttachFiles
          ]});
        }

        const ticketChannel = await discordGuild.channels.create({
          name: channelName,
          type: ChannelType.GuildText,
          parent: ticketCategory && ticketCategory.type === ChannelType.GuildCategory ? ticketCategory.id : undefined,
          topic: `Ticket restauré de ${ticket.username} — Raison : ${ticket.reason}`,
          permissionOverwrites
        });

        // Parse transcript and replay messages via webhook
        const { parseTranscriptHtml } = await import('../../../services/features/transcriptService.js');
        const parsedMessages = parseTranscriptHtml(transcript.html);

        if (parsedMessages.length > 0) {
          const webhook = await ticketChannel.createWebhook({ name: 'Kotbo Restore' });

          const headerEmbed = new EmbedBuilder()
            .setTitle('📜 Historique restauré')
            .setDescription(`Ce ticket a été restauré depuis une transcription par **${user.username || 'Staff'}** (<@${user.userId}>).\nLes messages ci-dessous sont une restitution de la conversation d'origine.`)
            .setColor(COLORS.primary as ColorResolvable)
            .setTimestamp();
          await ticketChannel.send({ embeds: [headerEmbed], allowedMentions: { parse: [] } });

          for (const msg of parsedMessages) {
            if (!msg.content && !msg.username && msg.embeds.length === 0 && msg.imageUrls.length === 0) continue;
            // Discord webhook username must be 1-80 chars, avoid "clyde"
            let webhookName = msg.username.slice(0, 80) || 'Utilisateur';
            if (/clyde/i.test(webhookName)) webhookName = webhookName.replace(/clyde/gi, 'C|yde');

            // Build embeds from parsed transcript data
            const discordEmbeds: EmbedBuilder[] = [];
            for (const e of msg.embeds) {
              const eb = new EmbedBuilder();
              if (e.color) {
                try { eb.setColor(e.color as ColorResolvable); } catch { /* ignored */ }
              }
              if (e.authorName) {
                eb.setAuthor({ name: e.authorName, iconURL: e.authorIconUrl || undefined, url: e.authorUrl || undefined });
              }
              if (e.title) eb.setTitle(e.title.slice(0, 256));
              if (e.url) eb.setURL(e.url);
              if (e.description) eb.setDescription(e.description.slice(0, 4096));
              if (e.fields.length > 0) {
                eb.addFields(e.fields.slice(0, 25).map(f => ({
                  name: f.name.slice(0, 256) || '​',
                  value: f.value.slice(0, 1024) || '​',
                  inline: f.inline
                })));
              }
              if (e.thumbnailUrl) eb.setThumbnail(e.thumbnailUrl);
              if (e.imageUrl) eb.setImage(e.imageUrl);
              if (e.footerText) {
                eb.setFooter({ text: e.footerText.slice(0, 2048), iconURL: e.footerIconUrl || undefined });
              }
              discordEmbeds.push(eb);
            }

            // Add standalone image attachments as embeds
            for (const imgUrl of msg.imageUrls) {
              if (discordEmbeds.length >= 10) break;
              discordEmbeds.push(new EmbedBuilder().setImage(imgUrl));
            }

            try {
              await webhook.send({
                content: msg.content ? msg.content.slice(0, 2000) : (discordEmbeds.length === 0 ? '*(message sans contenu texte)*' : undefined),
                username: `${webhookName} (historique)`,
                avatarURL: msg.avatarUrl || undefined,
                embeds: discordEmbeds.length > 0 ? discordEmbeds.slice(0, 10) : undefined,
                allowedMentions: { parse: [] },
              });
            } catch (sendErr) {
              logger.warn('TicketsAPI', `Failed to replay message from ${msg.username}: ${errorMessage(sendErr)}`);
            }
          }

          await webhook.delete('Restore terminé').catch(() => {});
        }

        // Send separator + welcome back embed
        const restoreEmbed = new EmbedBuilder()
          .setTitle('🔄 Ticket Restauré')
          .setDescription(`Ce ticket a été réouvert par **${user.username || "Staff"}** (<@${user.userId}>) depuis le Dashboard.\n\n**Raison d'origine :** ${ticket.reason}\n**Description :** ${ticket.description || "Aucune"}`)
          .setColor(COLORS.primary as ColorResolvable)
          .setTimestamp()
          .setFooter({ text: `Kotbo · Ticket ID: ${ticket.id}` });

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`ticket:claim:${ticket.id}`).setLabel('Prendre en charge').setStyle(ButtonStyle.Primary).setEmoji('🛠️'),
          new ButtonBuilder().setCustomId(`ticket:close:${ticket.id}`).setLabel('Fermer').setStyle(ButtonStyle.Danger).setEmoji('🔒')
        );
        await ticketChannel.send({ embeds: [restoreEmbed], components: [row], allowedMentions: { parse: [] } });

        await prisma.ticket.update({
          where: { id: ticketId },
          data: {
            channelId: ticketChannel.id,
            status: 'OPEN',
            restoreCount: restoreCount + 1,
            lastRestoredAt: new Date(),
            claimedById: null,
            claimedByName: null,
            closedById: null,
            closedByName: null,
            closedAt: null,
          }
        });

        if (guildConfig.ticketLogChannelId) {
          const logCh = client.channels.cache.get(guildConfig.ticketLogChannelId);
          if (logCh && logCh instanceof TextChannel) {
            const logEmbed = new EmbedBuilder()
              .setTitle('🔄 Ticket Restauré')
              .setDescription(`Le ticket de **${ticket.username}** a été restauré depuis le Dashboard par **${user.username}**.`)
              .setColor(COLORS.primary as ColorResolvable)
              .addFields([
                { name: 'Créateur', value: `<@${ticket.userId}>`, inline: true },
                { name: 'Restauré par', value: `<@${user.userId}>`, inline: true },
                { name: 'Nouveau salon', value: `<#${ticketChannel.id}>`, inline: true },
              ])
              .setTimestamp()
              .setFooter({ text: `Kotbo · Ticket ID: ${ticket.id}` });
            await logCh.send({ embeds: [logEmbed], allowedMentions: { parse: [] } }).catch(() => {});
          }
        }

        json(res, 200, { success: true, channelId: ticketChannel.id });
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error restoring ticket: ${errorStack(err)}`);
        json(res, 500, { error: `Erreur lors de la restauration: ${errorMessage(err)}` });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/tickets/:ticketId/delete
    if (parts.length === 7 && parts[6] === 'delete' && method === 'POST') {
      const ticketId = parts[5];
      try {
        const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
        if (!ticket) {
          json(res, 404, { error: 'Ticket introuvable' });
          return true;
        }

        if (!ticket.channelId) {
          json(res, 200, { success: true });
          return true;
        }

        const ch = client.channels.cache.get(ticket.channelId);
        if (ch && ch instanceof TextChannel) {
          const { generateTranscript } = await import('../../../services/features/transcriptService.js');
          const transcriptData = await generateTranscript(ch);
          
          await prisma.ticket.update({
            where: { id: ticketId },
            data: {
              channelId: null,
              status: 'CLOSED',
              transcriptId: transcriptData.id
            }
          });

          const guildConfig = await prisma.guild.findUnique({ where: { id: guildId } });
          const { getDashboardUrl } = await import('../../shared.js');
          const dashboardUrl = getDashboardUrl();
          const publicLink = `${dashboardUrl}/transcripts/${transcriptData.id}`;
          
          const usersToDm = new Set<string>();
          if (ticket.userId) usersToDm.add(ticket.userId);
          if (ticket.claimedById) usersToDm.add(ticket.claimedById);
          if (ticket.closedById) usersToDm.add(ticket.closedById);
          if (user.userId) usersToDm.add(user.userId);
          
           const serverName = getGuildName(client, guildId);
           const dmEmbed = new EmbedBuilder()
            .setTitle('📄 Transcription de ticket')
            .setDescription(`Le ticket d'assistance **${ticket.reason}** du serveur **${serverName}** a été supprimé.\n\nVoici le lien pour consulter la transcription complète :`)
            .addFields([{ name: "Lien d'accès", value: `🌐 [Consulter le transcript](${publicLink})` }])
            .setColor('#5865F2')
            .setTimestamp()
            .setFooter({ text: `Serveur : ${serverName}` });
            
          for (const dmUserId of usersToDm) {
            try {
              const dmUser = await client.users.fetch(dmUserId);
              if (dmUser) await dmUser.send({ embeds: [dmEmbed], allowedMentions: { parse: [] } });
            } catch { /* ignored */ }
          }

          if (guildConfig && guildConfig.ticketLogChannelId) {
            const logCh = client.channels.cache.get(guildConfig.ticketLogChannelId);
            if (logCh && logCh instanceof TextChannel) {
              const logEmbed = new EmbedBuilder()
                .setTitle('🗑️ Ticket Supprimé')
                .setDescription(`Le ticket ouvert par **${ticket.username}** a été définitivement supprimé par **${user.username}** depuis le Dashboard.`)
                .setColor(0x000000)
                .addFields([
                  { name: 'Créateur', value: `<@${ticket.userId}>`, inline: true },
                  { name: 'Supprimé par', value: `<@${user.userId}>`, inline: true },
                  { name: 'Transcription publique', value: `🌐 [Consulter le transcript](${publicLink})` }
                ])
                .setTimestamp()
                .setFooter({ text: `Kotbo · Ticket ID: ${ticket.id}` });
              await logCh.send({ embeds: [logEmbed], allowedMentions: { parse: [] } }).catch(() => {});
            }
          }

          setTimeout(async () => {
            await ch.delete(`Ticket supprimé depuis le Dashboard par ${user.username}`).catch(() => {});
          }, 1000);

          json(res, 200, { success: true, transcriptId: transcriptData.id });
        } else {
          await prisma.ticket.update({
            where: { id: ticketId },
            data: { channelId: null }
          });
          json(res, 200, { success: true });
        }
      } catch (err: unknown) {
        logger.error('TicketsAPI', `Error deleting ticket: ${errorMessage(err)}`);
        json(res, 500, { error: 'Erreur lors de la suppression' });
      }
      return true;
    }
  }

  return false;
}

function msgEmbedsMap(embeds: Embed[], guild: Guild | null) {
  return embeds.map(e => ({
    title: e.title,
    description: e.description,
    htmlDescription: e.description ? parseDiscordMarkdown(e.description, guild) : '',
    color: e.hexColor,
    fields: e.fields ? e.fields.map((f) => ({
      name: f.name,
      value: f.value,
      htmlValue: f.value ? parseDiscordMarkdown(f.value, guild) : ''
    })) : [],
    image: e.image ? { url: e.image.url } : null,
    thumbnail: e.thumbnail ? { url: e.thumbnail.url } : null,
    video: e.video ? { url: e.video.url } : null
  }));
}
