import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  PermissionFlagsBits,
  type Client,
  TextChannel,
  Collection,
  GuildMember,
} from 'discord.js';
import { SanctionType, TutoringItemState } from '@prisma/client';
import jwt from 'jsonwebtoken';
import WebSocket, { WebSocketServer } from 'ws';
import prisma from '../utils/db.js';
import { logger } from '../utils/logger.js';
import { COLORS, successEmbed } from '../utils/embeds.js';
import { isGuildActivated, activateGuild, deactivateGuild, activatedGuilds } from '../utils/activation.js';
import { translate } from '../services/translationService.js';
import {
  registerBanSanction,
  registerKickSanction,
  registerTimeoutSanction,
  registerWarnSanction,
  runGuildBan,
  formatDurationFr,
} from '../services/sanctionService.js';
import {
  COMMAND_CATALOG,
  normalizeCommandRestrictions,
  type CommandRestrictionRule,
} from '../utils/commandAccess.js';
import { getDailyAlgoUserProfile, getDailyAlgoUserParticipations, getLocalDateKey, reviewDailyAlgoSubmission } from '../services/dailyAlgoService.js';
import {
  hashAPIKey,
  generateAPIKey,
  getStaffMember,
  addStaffMember,
  toggleTutorStatus,
  updateStaffGrade,
  removeStaffMember,
  getStaffMemberStats,
  issueStaffWarning,
  blacklistStaff,
  getActiveBlacklist,
  createTestingPeriod,
  addMentorReport,
  endTestingPeriod,
  getStaffRoles,
  createStaffRole,
  reorderStaffRoles,
  deleteStaffRole,
  createAPIKey,
  getAPIKeys,
  deleteAPIKey,
  verifyAPIKey,
  recordStaffActivity,
} from '../services/staffManagementService.js';
import {
  getPublicProfileSnapshot,
  getStaffProfileSnapshot,
} from '../services/profileService.js';
import {
  getPolls,
  createPoll,
  castPollVote,
  getAbsences,
  createAbsence,
  deleteAbsence,
  getMeetings,
  updateAbsenceStatus,
  getManagerNotes,
  createManagerNote,
  deleteManagerNote,
  getStaffAlertsAndProgression,
  createMeeting,
  updateMeeting,
  deleteMeeting,
  syncMeetingPresencesWithAbsences,
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  createNotification,
  getStaffCalendarData,
} from '../services/staffLeadershipService.js';
import * as tutoringService from '../services/tutoringService.js';
import {
  getEvents,
  getEvent,
  createEvent,
  publishEvent,
  nextQuestion,
  getEventStats,
  prevQuestion,
  finishEvent,
  deleteEvent
} from '../services/eventService.js';
import {
  getCandidatures,
  createCandidature,
  getEligibleTutors,
  updateCandidatureStatus,
  deleteCandidature as deleteRecruitmentCandidature,
  approveCandidature,
  rejectCandidature,
  completeOral,
  assignTutor,
  getCandidatureHistory,
} from '../services/recruitmentService.js';
import * as altAccountService from '../services/altAccountService.js';
import { scanGuildMembersForYoungAccounts } from '../services/dcDetectionService.js';
import { publishOrUpdateRegulationMessage } from '../services/regulationService.js';
import { publishNewsArticle, generateRssXml } from '../services/newsService.js';
import { env } from 'node:process';

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;
const JWT_SECRET = process.env.JWT_SECRET || 'kotbo-secret-key-123';
const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:5173';
const DEFAULT_TRANSLATION_TARGET_LANG = 'FR';
const DISCORD_CLIENT_OWNER_ID = process.env.DISCORD_CLIENT_OWNER_ID;

type ModuleStatus = 'active' | 'inactive' | 'error';
type SeverityLevel = 'off' | 'info' | 'attention' | 'critique';
type DashboardPresetKey = 'general' | 'gaming' | 'dev';
type CommandAccessLevel = 'tout_le_monde' | 'modération' | 'administration';

type ModuleItem = {
  id: string;
  name: string;
  description: string;
  status: ModuleStatus;
  uptime: number;
  interactions: number;
  lastSync: string;
  errorMessage?: string;
  isFixed?: boolean;
};

type NotificationSettings = {
  discordChannel: string;
  email: string;
  emailEnabled: boolean;
  cloudBackup: boolean;
  debugLog: boolean;
  killSwitchEnabled: boolean;
  severityByModule: Array<{ module: string; level: SeverityLevel }>;
};

type AuditEntry = {
  id: string;
  user: string;
  action: string;
  context: string;
  module: string;
  eventType: string;
  source: 'dashboard' | 'discord';
  details: string;
  dateIso: string;
  channelId: string | null;
};

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

type RoleDisplay = {
  id: string;
  name: string;
};

type PrimaryRoleDisplay = RoleDisplay | null;

interface CachedMembers {
  members: Collection<string, GuildMember>;
  timestamp: number;
}

const guildMembersCache = new Map<string, CachedMembers>();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes cache

async function getGuildMembers(discordGuild: any): Promise<Collection<string, GuildMember>> {
  const guildId = discordGuild.id;
  const cached = guildMembersCache.get(guildId);
  if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
    return cached.members;
  }

  try {
    const allMembers = await discordGuild.members.fetch();
    guildMembersCache.set(guildId, {
      members: allMembers,
      timestamp: Date.now(),
    });
    return allMembers;
  } catch (fetchErr) {
    logger.warn('AnalyticsAPI', `Error fetching guild members for guild ${guildId}: ${String(fetchErr)}`);
    if (cached) {
      logger.info('AnalyticsAPI', `Using stale member cache for guild ${guildId} due to fetch error.`);
      return cached.members;
    }
    logger.info('AnalyticsAPI', `Falling back to members cache for guild ${guildId}.`);
    return discordGuild.members.cache;
  }
}

function isDisplayableRoleName(name: string): boolean {
  const trimmedName = name.trim();
  return trimmedName.length > 0 && trimmedName !== '@everyone' && !/^[\W_]+$/u.test(trimmedName);
}

async function resolveProfileRoleDisplay(client: Client, guildId: string, roleIds: string[]): Promise<{
  roles: RoleDisplay[];
  primaryRole: PrimaryRoleDisplay;
}> {
  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);

  if (!guild) {
    return { roles: [], primaryRole: null };
  }

  const resolvedRoles = roleIds
    .map((roleId) => guild.roles.cache.get(roleId) ?? guild.roles.cache.find((role) => role.name === roleId) ?? null)
    .filter((role): role is NonNullable<typeof role> => !!role && role.name !== '@everyone')
    .sort((left, right) => right.position - left.position || left.id.localeCompare(right.id));

  const primaryRole = resolvedRoles.find((role) => isDisplayableRoleName(role.name)) ?? resolvedRoles[0] ?? null;

  return {
    roles: resolvedRoles.map((role) => ({
      id: role.id,
      name: role.name,
    })),
    primaryRole: primaryRole
      ? {
          id: primaryRole.id,
          name: primaryRole.name,
        }
      : null,
  };
}

const buildModuleUpdatesForPreset = (presetKey: DashboardPresetKey) => {
  if (presetKey === 'dev') {
    return {
      codePoliceEnabled: true,
      dailyAlgoEnabled: true,
      translationEnabled: false,
    };
  }

  return {
    codePoliceEnabled: false,
    dailyAlgoEnabled: false,
    translationEnabled: true,
  };
};

const buildCommandRestrictionsForPreset = (
  presetKey: DashboardPresetKey,
  options: {
    moderatorRoleId?: string | null;
    adminRoleIds: string[];
    fallbackUserId: string;
    modRoleIds: string[];
  },
): CommandRestrictionRule[] => {
  const accessByCommand: Record<string, CommandAccessLevel> = {};
  for (const command of COMMAND_CATALOG) {
    accessByCommand[command.name] = command.defaultAccess;
  }

  const overrides = PRESET_COMMAND_OVERRIDES[presetKey] ?? {};
  for (const [commandName, access] of Object.entries(overrides)) {
    if (access) {
      accessByCommand[commandName] = access;
    }
  }

  return Object.entries(accessByCommand)
    .filter(([, access]) => access !== 'tout_le_monde')
    .map(([commandName, access]) => {
      const allowedRoleIds = access === 'administration'
        ? options.adminRoleIds
        : (options.moderatorRoleId ? [options.moderatorRoleId] : options.modRoleIds);
      const allowedUserIds = allowedRoleIds.length > 0 ? [] : [options.fallbackUserId];

      return {
        commandName,
        allowedChannelIds: [],
        blockedChannelIds: [],
        allowedRoleIds,
        blockedRoleIds: [],
        allowedUserIds,
        blockedUserIds: [],
      };
    });
};

type DashboardSanctionType = 'WARN' | 'KICK' | 'TIMEOUT' | 'TEMP_BAN' | 'BAN';
type DashboardSanctionStatus = 'ACTIVE' | 'RESOLVED' | 'FAILED';

type SanctionItem = {
  id: string;
  type: DashboardSanctionType;
  status: DashboardSanctionStatus;
  targetUserId: string;
  targetTag: string;
  moderatorUserId: string;
  moderatorTag: string;
  reason: string;
  durationSeconds: number | null;
  expiresAt: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
};

type SanctionReportItem = {
  id: string;
  sanctionId: string | null;
  staffPseudo: string;
  incidentAt: string;
  memberPseudo: string;
  memberReference: string;
  sanctionType: DashboardSanctionType;
  sanctionDurationLabel: string | null;
  brokenRules: string;
  detailedReason: string;
  evidenceLinks: string[];
  additionalNotes: string | null;
  createdByUserId: string;
  createdByTag: string | null;
  createdAt: string;
};

type RegulationRuleItem = {
  id: string;
  title: string;
  description: string;
  emoji: string | null;
  sortOrder: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

type AnalyticsData = {
  activityTrend: number[];
  messagesTrend: number[];
  voiceTrend: number[];
  joinsTrend: number[];
  leavesTrend: number[];
  sanctionsTrend: number[];
  totalAutomations: number;
  healthStatus: number;
};

type DashboardChannel = {
  id: string;
  name: string;
  mention: string;
};

type DashboardRole = {
  id: string;
  name: string;
  mention: string;
  permissions: string[];
  position?: number;
  color?: string;
};

type MemberCaseQuickAction = 'WARN' | 'KICK' | 'TIMEOUT' | 'BAN';

type MemberCaseLogEntry = {
  id: string;
  user: string;
  action: string;
  context: string;
  module: string;
  eventType: string;
  source: 'dashboard' | 'discord';
  details: string;
  dateIso: string;
  channelId: string | null;
};

type MemberCaseChannelMessage = {
  id: string;
  channelId: string;
  channelName: string;
  content: string;
  dateIso: string;
};

type MemberCaseChannelSummary = {
  channelId: string;
  channelName: string;
  count: number;
  lastMessageAt: string | null;
  recentMessages: MemberCaseChannelMessage[];
};

type MemberCaseInviteInfo = {
  code: string | null;
  inviterId: string | null;
  inviterTag: string | null;
  inviterAvatarUrl: string | null;
  joinedAt: string | null;
};

type MemberCaseProfile = {
  id: string;
  userId: string;
  userTag: string | null;
  username: string | null;
  globalName: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  bannerUrl: string | null;
  accentColor: number | null;
  locale: string | null;
  isBot: boolean;
  accountCreatedAt: string | null;
  guildJoinedAt: string | null;
  guildLeftAt: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  lastMessageAt: string | null;
  lastMessageChannelId: string | null;
  messageCount: number;
  voiceSessionCount: number;
  voiceTimeSeconds: number;
  voiceLastChannelId: string | null;
  voiceLastJoinedAt: string | null;
  voiceLastLeftAt: string | null;
  rolesSnapshot: string[];
  presenceStatus: string | null;
  pronouns: string | null;
  isTutor: boolean;
  staffGrade: string | null;
  isSuspectedDC: boolean;
  moderatorNote: string | null;
};

type LinkedAccountItem = {
  userId: string;
  userTag: string | null;
  avatarUrl: string | null;
  type: string;
  status: string;
};

type MemberCaseInteractionNode = {
  id: string;
  label: string;
  type: 'user' | 'target';
  avatar?: string | null;
};

type MemberCaseInteractionEdge = {
  from: string;
  to: string;
  type: 'mention' | 'reply' | 'reaction';
  count: number;
};

type MemberCaseInteractionGraph = {
  nodes: MemberCaseInteractionNode[];
  edges: MemberCaseInteractionEdge[];
};

type MemberCaseResponse = {
  profile: MemberCaseProfile | null;
  invite: MemberCaseInviteInfo | null;
  roles: DashboardRole[];
  effectivePermissions: string[];
  sanctions: SanctionItem[];
  logs: MemberCaseLogEntry[];
  messagesByChannel: MemberCaseChannelSummary[];
  recentMessageCount: number;
  recentLogCount: number;
  connections: Array<{ name: string; type: string; visible: boolean }>;
  connectionsNote: string;
  candidatures: Array<{
    id: string;
    status: string;
    notes: string;
    createdAt: string;
    data: any;
    autoRejected: boolean;
    autoRejectReason: string | null;
    rejectionReason: string | null;
    oralResult: string | null;
    reapplyAfter: string | null;
  }>;
  linkedAccounts: LinkedAccountItem[];
  isSuspectedDC: boolean;
  interactionGraph: MemberCaseInteractionGraph;
};

type CommandRestrictionState = CommandRestrictionRule;

type CommandCatalogEntry = {
  name: string;
  label: string;
  description: string;
  defaultAccess: 'tout_le_monde' | 'modération' | 'administration';
};

type DashboardAccessLevel = 'none' | 'moderator' | 'admin';

type DashboardAccess = {
  level: DashboardAccessLevel;
  canViewDashboard: boolean;
  canModerateContent: boolean;
  canModerateDailyAlgo: boolean;
  canManageSettings: boolean;
  canManageTutoring: boolean;
};

type FeatureAccess = {
  canView: boolean;
  canModerate: boolean;
  canConfigure: boolean;
  canDelete: boolean;
};

type FeatureAccessMap = Record<string, FeatureAccess>;

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

type DashboardState = {
  guildName: string;
  configChannelId: string;
  logChannelId: string;
  regulationChannelId: string;
  regulationMessageId: string | null;
  recruitmentCategoryId: string;
  recruitmentLogChannelId: string;
  recruitmentAutoRejectEnabled: boolean;
  modules: ModuleItem[];
  discordChannels: DashboardChannel[];
  discordVoiceChannels: DashboardChannel[];
  discordRoles: DashboardRole[];
  moderatorRoleId: string;
  commandRestrictions: CommandRestrictionState[];
  commandCatalog: CommandCatalogEntry[];
  access: {
    level: Exclude<DashboardAccessLevel, 'none'>;
    canModerateContent: boolean;
    canModerateDailyAlgo: boolean;
    canManageSettings: boolean;
  };
  featureAccess: FeatureAccessMap;
  notifications: NotificationSettings;
  auditTrail: AuditEntry[];
  sanctions: SanctionItem[];
  sanctionReports: SanctionReportItem[];
  regulationRules: RegulationRuleItem[];
  messageTemplate: string;
  analytics: AnalyticsData;
};

type RuntimeState = {
  email: string;
  emailEnabled: boolean;
  cloudBackup: boolean;
  debugLog: boolean;
  killSwitchEnabled: boolean;
  severityByModule: Array<{ module: string; level: SeverityLevel }>;
  commandRestrictions: CommandRestrictionState[];
  messageTemplate: string;
};

const MODULE_DESCRIPTIONS: Record<string, string> = {
  codepolice: 'Vérification de la syntaxe et bonnes pratiques sur les snippets.',
  dailyalgo: "Génération quotidienne d'un défi d'algorithmique.",
  traduction: 'Traduction instantanée vers la langue configurée.',
  regulation: 'Configuration et publication du règlement du serveur.',
  staff_management: 'Gestion complète du personnel, recrutements et absences.',
  sanctions: 'Historique et gestion des sanctions (warns, mutes, bans).',
  members: 'Gestion avancée des membres et détection de doubles comptes.',
  logs: 'Journaux d\'événements Discord (messages, salons, membres).',
  activity: 'Suivi détaillé de l\'activité utilisateur sur le dashboard.',
  auto_thread: 'Création automatique de fils de discussion sur les messages.',
  analytics: 'Statistiques de croissance et d\'engagement du serveur.',
  profile: 'Gestion du profil utilisateur et paramètres personnels.',
  recruitment: 'Suivi des candidatures et intégration du personnel.',
  tickets: 'Système complet de tickets d\'assistance et de support configurable.',
  youtube: 'Intégration YouTube pour les notifications de nouvelles vidéos.',
  digest: 'Génération de résumés automatiques et flux RSS.',
  tutoring: 'Gestion des périodes d\'essai et formation des nouveaux staff.',
  meetings: 'Planification et suivi des réunions d\'équipe.',
  absences: 'Gestion des congés et disponibilités du personnel.',
  double_accounts: 'Détection et gestion des comptes multiples pour la sécurité.',
  events: 'Organisation et gestion d\'événements communautaires et quiz.',
};

const DEFAULT_SEVERITY_BY_MODULE: Array<{ module: string; level: SeverityLevel }> = [
  { module: 'Auto-Modération', level: 'attention' },
  { module: 'Daily Algo', level: 'info' }
];

const DEFAULT_MESSAGE_TEMPLATE =
  '🔔 {titre}\n\n{resume}\n\nSource: {source}\nAuteur: {auteur}\n\nPublié automatiquement par Kotbo.';

const recruitmentAutoRejectEnabledByGuild = new Map<string, boolean>();

const isRecruitmentAutoRejectEnabled = (guildId: string) => {
  return recruitmentAutoRejectEnabledByGuild.get(guildId) ?? true;
};

const makeId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

const nowIso = () => new Date().toISOString();

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
    throw new Error('Le salon Daily Algo doit être configuré avant de générer le planning.');
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

    // Tenter de trouver un problème déjà assigné à cette date par une autre guilde (SYNCHRONISATION)
    const existingRunForDate = await prisma.dailyAlgoRun.findFirst({
      where: { dateKey },
      select: { problemId: true }
    });

    let problemId = existingRunForDate?.problemId;

    if (!problemId) {
      // Aucun problème pour cette date, on en choisit un nouveau
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

      // On le marque comme utilisé
      await prisma.dailyAlgoProblem.update({
        where: { id: problemId },
        data: { usedAt: new Date() }
      });
    }

    // Créer le run pour cette guilde
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

function normalizeLangCode(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase();
  if (!normalized) return null;
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

function isDashboardSanctionType(value: string): value is DashboardSanctionType {
  return value === 'WARN' || value === 'KICK' || value === 'TIMEOUT' || value === 'TEMP_BAN' || value === 'BAN';
}

function toSanctionType(value: DashboardSanctionType): SanctionType {
  return value as SanctionType;
}

function parseEvidenceLinks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => /^https?:\/\//i.test(entry));
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

const toRuntimeState = (settings: {
  email: string;
  emailEnabled: boolean;
  cloudBackup: boolean;
  debugLog: boolean;
  killSwitchEnabled: boolean;
  severityByModule: unknown;
  commandRestrictions: unknown;
  messageTemplate: string;
}): RuntimeState => {
  const rawSeverity = Array.isArray(settings.severityByModule)
    ? settings.severityByModule
    : DEFAULT_SEVERITY_BY_MODULE;

  const severityByModule = rawSeverity
    .map((item) => {
      if (!item || typeof item !== 'object') return null;

      const module = (item as Record<string, unknown>).module;
      const level = (item as Record<string, unknown>).level;
      const allowedLevels: SeverityLevel[] = ['off', 'info', 'attention', 'critique'];

      if (typeof module !== 'string' || typeof level !== 'string' || !allowedLevels.includes(level as SeverityLevel)) {
        return null;
      }

      return { module, level: level as SeverityLevel };
    })
    .filter((entry): entry is { module: string; level: SeverityLevel } => !!entry);

  return {
    email: settings.email,
    emailEnabled: settings.emailEnabled,
    cloudBackup: settings.cloudBackup,
    debugLog: settings.debugLog,
    killSwitchEnabled: settings.killSwitchEnabled,
    severityByModule: severityByModule.length > 0 ? severityByModule : DEFAULT_SEVERITY_BY_MODULE,
    commandRestrictions: normalizeCommandRestrictions(settings.commandRestrictions),
    messageTemplate: settings.messageTemplate || DEFAULT_MESSAGE_TEMPLATE
  };
};

const json = (res: ServerResponse, statusCode: number, data: unknown) => {
  if (!res.headersSent) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
  }

  res.statusCode = statusCode;
  if (statusCode === 204) {
    res.end();
  } else {
    res.end(JSON.stringify(data));
  }
};

type AuthClaims = {
  userId: string;
  username?: string;
  avatar?: string;
  discordToken?: string;
};

const verifyAuth = (req: IncomingMessage): AuthClaims | null => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.split(' ')[1];
  try {
    return jwt.verify(token, JWT_SECRET) as AuthClaims;
  } catch {
    return null;
  }
};

type RecruitmentWebhookAuthResult = {
  auth: AuthClaims | null;
  reason: 'ok_jwt' | 'ok_api_key' | 'missing_credentials' | 'invalid_jwt' | 'invalid_api_key';
};

const verifyRecruitmentWebhookAuth = async (req: IncomingMessage, guildId: string): Promise<RecruitmentWebhookAuthResult> => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    try {
      return {
        auth: jwt.verify(token, JWT_SECRET) as AuthClaims,
        reason: 'ok_jwt',
      };
    } catch {
      // ignore and try API key below
    }
  }

  const apiKey = req.headers['x-kotbo-api-key'] ?? req.headers['x-api-key'];
  const apiKeyValue = Array.isArray(apiKey) ? apiKey[0] : apiKey;
  if (!apiKeyValue || typeof apiKeyValue !== 'string') {
    if (authHeader && authHeader.startsWith('Bearer ')) {
      return { auth: null, reason: 'invalid_jwt' };
    }
    return { auth: null, reason: 'missing_credentials' };
  }

  const key = await verifyAPIKey(hashAPIKey(apiKeyValue.trim()), guildId);
  if (!key) return { auth: null, reason: 'invalid_api_key' };

  if (!key.permissions || (!key.permissions.includes('recruitment:forms') && !key.permissions.includes('recruitment:manage'))) {
    return { auth: null, reason: 'insufficient_permissions' };
  }

  return {
    auth: {
      userId: key.createdByUserId,
      username: key.name,
    },
    reason: 'ok_api_key',
  };
};

const getAuditActor = (auth: AuthClaims) => {
  const username = auth.username?.trim();
  if (username) return username;
  return `Utilisateur ${auth.userId.slice(0, 8)}`;
};

const DISCORD_PERMISSION_ADMINISTRATOR = BigInt(0x8);
const DISCORD_PERMISSION_MANAGE_GUILD = BigInt(0x20);

const hasDashboardAdminPermission = (permissions: bigint) => {
  return (permissions & DISCORD_PERMISSION_ADMINISTRATOR) === DISCORD_PERMISSION_ADMINISTRATOR
    || (permissions & DISCORD_PERMISSION_MANAGE_GUILD) === DISCORD_PERMISSION_MANAGE_GUILD;
};

const DASHBOARD_ACCESS_NONE: DashboardAccess = {
  level: 'none',
  canViewDashboard: false,
  canModerateContent: false,
  canModerateDailyAlgo: false,
  canManageSettings: false,
  canManageTutoring: false,
};

const DASHBOARD_ACCESS_MODERATOR: DashboardAccess = {
  level: 'moderator',
  canViewDashboard: true,
  canModerateContent: true,
  canModerateDailyAlgo: true,
  canManageSettings: false,
  canManageTutoring: false,
};

const DASHBOARD_ACCESS_DAILY_ALGO_REVIEWER: DashboardAccess = {
  level: 'moderator',
  canViewDashboard: true,
  canModerateContent: false,
  canModerateDailyAlgo: true,
  canManageSettings: false,
  canManageTutoring: false,
};

const DASHBOARD_ACCESS_ADMIN: DashboardAccess = {
  level: 'admin',
  canViewDashboard: true,
  canModerateContent: true,
  canModerateDailyAlgo: true,
  canManageSettings: true,
  canManageTutoring: true,
};

const resolveDashboardAccess = async (
  client: Client,
  guildId: string,
  userId: string,
  knownPermissions?: bigint | null,
): Promise<DashboardAccess> => {
  const isGlobalAdmin = await resolveAdminAccess(client, userId);
  if (isGlobalAdmin) return DASHBOARD_ACCESS_ADMIN;

  const guildConfig = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { moderatorRoleId: true }
  });

  if (!guildConfig) return DASHBOARD_ACCESS_NONE;

  if (knownPermissions !== null && knownPermissions !== undefined && hasDashboardAdminPermission(knownPermissions)) {
    return DASHBOARD_ACCESS_ADMIN;
  }

  const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) return DASHBOARD_ACCESS_NONE;

  const member = await discordGuild.members.fetch(userId).catch(() => null);
  if (!member) return DASHBOARD_ACCESS_NONE;

  if (member.permissions.has('Administrator') || member.permissions.has('ManageGuild')) {
    return DASHBOARD_ACCESS_ADMIN;
  }

  if (guildConfig.moderatorRoleId && member.roles.cache.has(guildConfig.moderatorRoleId)) {
    return DASHBOARD_ACCESS_MODERATOR;
  }

  const staffProfile = await prisma.staffMember.findUnique({
    where: { guildId_userId: { guildId, userId } },
    select: { id: true, isTutor: true },
  });

  if (!staffProfile) {
    return DASHBOARD_ACCESS_NONE;
  }

  // Si c'est un tuteur, on lui donne accès au management du tutorat
  if (staffProfile.isTutor) {
    return {
      ...DASHBOARD_ACCESS_MODERATOR, // Base de modérateur
      canManageTutoring: true,
    };
  }

  return DASHBOARD_ACCESS_DAILY_ALGO_REVIEWER;
};

async function resolveAdminAccess(client: Client, userId: string): Promise<boolean> {
  if (userId === DISCORD_CLIENT_OWNER_ID) return true;

  const admin = await prisma.globalAdmin.findUnique({
    where: { userId }
  });
  
  return !!admin;
}



const readJsonBody = async <T>(req: IncomingMessage): Promise<T | null> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) return null;
  const raw = Buffer.concat(chunks).toString('utf8');
  return JSON.parse(raw) as T;
};

const truncate = (value?: string | null, length = 160) => {
  if (!value) return '';
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
};

const DASHBOARD_CONTENT_EXCERPT_LENGTH = 160;

const prepareDescriptionForTranslation = (value?: string | null) => {
  if (!value) return '';
  return truncate(value.trim(), DASHBOARD_CONTENT_EXCERPT_LENGTH);
};


const deleteValidationQueueMessage = async (client: Client, guildId: string, queueMessageId: string | null) => {
  if (!queueMessageId) return;

  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { configChannelId: true }
  });

  if (!guild?.configChannelId) return;

  const channel = await client.channels.fetch(guild.configChannelId).catch(() => null) as TextChannel | null;
  if (!channel) return;

  await channel.messages.delete(queueMessageId).catch(() => null);
};


const getOrCreateRuntime = async (guildId: string): Promise<RuntimeState> => {
  const settings = await prisma.dashboardSettings.upsert({
    where: { guildId },
    update: {},
    create: {
      guildId,
      email: '',
      emailEnabled: false,
      cloudBackup: true,
      debugLog: false,
      killSwitchEnabled: false,
      severityByModule: DEFAULT_SEVERITY_BY_MODULE,
      commandRestrictions: [],
      messageTemplate: DEFAULT_MESSAGE_TEMPLATE
    }
  });

  return toRuntimeState(settings);
};

const pushAudit = async (guildId: string, entry: Omit<AuditEntry, 'id' | 'dateIso' | 'source'>) => {
  await prisma.dashboardAuditLog.create({
    data: {
      guildId,
      channelId: entry.channelId,
      user: entry.user,
      action: entry.action,
      context: entry.context,
      module: entry.module,
      eventType: entry.eventType,
      details: entry.details,
      dateIso: new Date()
    }
  });
};

const GLOBAL_BANNED_WORD_CATEGORIES = new Set([
  'custom',
  'racism',
  'threat',
  'sexual',
  'lgbtphobia',
  'hate',
  'insult',
]);

const normalizeGlobalBannedWordCategory = (value: unknown): string => {
  if (typeof value !== 'string') return 'custom';
  return GLOBAL_BANNED_WORD_CATEGORIES.has(value) ? value : 'custom';
};

const normalizeGlobalBannedWord = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().slice(0, 100);
};

const normalizeGlobalBannedWordKey = (value: string): string => {
  return normalizeGlobalBannedWord(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ');
};

const cleanupGlobalBannedWords = async () => {
  const words = await prisma.bannedWord.findMany({
    where: { guildId: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  const seen = new Map<string, (typeof words)[number]>();
  const duplicates: string[] = [];

  for (const word of words) {
    const key = normalizeGlobalBannedWordKey(word.word);
    if (!key) continue;

    if (seen.has(key)) {
      duplicates.push(word.id);
      continue;
    }

    seen.set(key, {
      ...word,
      word: normalizeGlobalBannedWord(word.word),
    });
  }

  const updates = Array.from(seen.values()).map((word) => {
    return prisma.bannedWord.update({
      where: { id: word.id },
      data: {
        word: word.word,
      },
    });
  });

  if (duplicates.length > 0) {
    await prisma.bannedWord.deleteMany({ where: { id: { in: duplicates } } });
  }

  await Promise.all(updates);

  return {
    cleanedCount: seen.size,
    duplicateCount: duplicates.length,
    words: await prisma.bannedWord.findMany({
      where: { guildId: null },
      orderBy: [{ word: 'asc' }],
      select: { id: true, word: true, category: true, enabled: true, guildId: true },
    }),
  };
};

function formatChannelName(guild: { channels: { cache: Map<string, { id: string; name?: string }> } } | null, channelId: string | null): string {
  if (!channelId) return 'Aucun';
  const channel = guild?.channels.cache.get(channelId);
  return channel?.name ? `#${channel.name}` : `Salon ${channelId}`;
}

function interpretMentions(guild: any | null, content: string): string {
  if (!content) return content;
  
  // Escape HTML characters to prevent XSS
  let escaped = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  // Interpréter les mentions d'utilisateurs <@ID> ou <@!ID>
  let processed = escaped.replace(/&lt;@!?(\d+)&gt;/g, (match, id) => {
    const member = guild?.members.cache.get(id);
    const name = member ? (member.displayName || member.user.username) : id;
    return `<span class="mention">@${name}</span>`;
  });

  // Interpréter les mentions de salons <#ID>
  processed = processed.replace(/&lt;#(\d+)&gt;/g, (match, id) => {
    const channel = guild?.channels.cache.get(id);
    const name = channel?.name || id;
    return `<a href="https://discord.com/channels/${guild?.id || '@me'}/${id}" target="_blank" class="mention-link">#${name}</a>`;
  });

  // Interpréter les mentions de rôles <@&ID>
  processed = processed.replace(/&lt;@&amp;(\d+)&gt;/g, (match, id) => {
    const role = guild?.roles.cache.get(id);
    const name = role?.name || id;
    return `<span class="mention">@${name}</span>`;
  });

  return processed;
}

function extractMessageId(details: string): string | null {
  return parseCaseField(details, 'ID');
}

function extractDiscordSnowflake(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().replace(/[^0-9]/g, '');
  return normalized.length > 0 ? normalized : null;
}

function parseCaseField(details: string, label: string): string | null {
  const match = details.match(new RegExp(`${label}:\\s*([^\\n|]+)`, 'i'));
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : null;
}

function parseInviteFromDetails(details: string): MemberCaseInviteInfo | null {
  const inviteCode = parseCaseField(details, 'Invite utilisée') ?? parseCaseField(details, 'Invite d\'arrivée');
  const inviter = parseCaseField(details, 'Créateur de l\'invite');
  const inviterId = parseCaseField(details, 'ID créateur');

  if (!inviteCode && !inviter && !inviterId) return null;

  const inviterMentionMatch = inviter?.match(/<@!?([0-9]+)>/);
  const normalizedInviter = inviter?.replace(/\s*\(<@!?[0-9]+>\)\s*$/, '').trim() || null;

  return {
    code: inviteCode,
    inviterId: inviterId ?? inviterMentionMatch?.[1] ?? null,
    inviterTag: normalizedInviter,
    inviterAvatarUrl: null,
    joinedAt: null,
  };
}

function extractMessagePreview(details: string): string | null {
  const content = parseCaseField(details, 'Contenu');
  if (!content) return null;
  return content === '_vide_' ? '' : content;
}

function mapGuildRolePermissions(role: { id: string; name: string; hexColor?: string; permissions?: { toArray: () => string[] } | string[] }, mention: string): DashboardRole {
  const permissions = Array.isArray(role.permissions)
    ? role.permissions
    : typeof role.permissions?.toArray === 'function'
      ? role.permissions.toArray()
      : [];

  return {
    id: role.id,
    name: role.name,
    mention,
    permissions,
    color: role.hexColor,
  };
}

async function fetchMemberConnections(discordToken?: string | null): Promise<{ connections: Array<{ name: string; type: string; visible: boolean }>; note: string }> {
  if (!discordToken) {
    return {
      connections: [],
      note: 'Connexions indisponibles sans jeton OAuth.',
    };
  }

  try {
    const response = await fetch('https://discord.com/api/users/@me/connections', {
      headers: { Authorization: `Bearer ${discordToken}` },
    });

    if (!response.ok) {
      return {
        connections: [],
        note: 'Connexions non exposées par le jeton OAuth actuel.',
      };
    }

    const payload = await response.json() as Array<{ name?: string; type?: string; visibility?: number }>;
    return {
      connections: Array.isArray(payload)
        ? payload.map((connection) => ({
            name: connection.name ?? 'Inconnue',
            type: connection.type ?? 'inconnue',
            visible: connection.visibility === 1,
          }))
        : [],
      note: 'Connexions récupérées via le scope OAuth connections.',
    };
  } catch {
    return {
      connections: [],
      note: 'Impossible de récupérer les connexions depuis Discord.',
    };
  }
}

function safeIsoDate(value: any, fallback: string | null = null): string | null {
  if (!value) return fallback;
  try {
    const date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) return fallback;
    return date.toISOString();
  } catch {
    return fallback;
  }
}

async function buildMemberCaseData(client: Client, guildId: string, userId: string, auth: AuthClaims): Promise<MemberCaseResponse | null> {
  const discordGuild = client.guilds.cache.get(guildId);
  if (!discordGuild) return null;

  let actualUserId = userId.startsWith('!') ? userId.substring(1) : userId;
  
  // Si l'ID n'est pas numérique, c'est peut-être un CUID interne (StaffMember.id)
  // On tente de résoudre le vrai ID Discord
  if (!/^\d+$/.test(actualUserId)) {
    const staff = await prisma.staffMember.findUnique({
      where: { id: actualUserId },
      select: { userId: true }
    });
    if (staff) {
      actualUserId = staff.userId;
    } else {
      // Si ce n'est pas un staff non plus, on tente de voir si c'est un ID de profil membre
      const profile = await prisma.memberProfile.findUnique({
        where: { id: actualUserId },
        select: { userId: true }
      });
      if (profile) actualUserId = profile.userId;
    }
  }

  try {
    const linkedUserIds = await altAccountService.getAllLinkedUserIds(guildId, actualUserId);

    const [user, member, profile, sanctions, auditLogs, inviteConnections, staffMember, candidatureHistory, sanctionReports, dbInvite] = await Promise.all([
      Promise.race([
        client.users.fetch(actualUserId).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))
      ]),
      Promise.race([
        discordGuild.members.fetch({ user: actualUserId, withPresences: true }).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000))
      ]),
      prisma.memberProfile.findUnique({
        where: {
          guildId_userId: {
            guildId,
            userId: actualUserId,
          },
        },
      }).catch(() => null),
      prisma.sanction.findMany({
        where: { guildId, targetUserId: { in: linkedUserIds } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }).catch(() => []),
      prisma.dashboardAuditLog.findMany({
        where: {
          guildId,
          OR: [
            { user: { contains: actualUserId } },
            { details: { contains: actualUserId } }
          ]
        },
        orderBy: { dateIso: 'desc' },
        take: 500,
      }).catch(() => []),
      fetchMemberConnections(auth.userId === actualUserId ? auth.discordToken : null).catch(() => ({ connections: [], note: "Erreur lors de la récupération des connexions." })),
      getStaffMember(guildId, actualUserId).catch(() => null),
      getCandidatureHistory(guildId, actualUserId).catch(() => []),
      prisma.sanctionReport.findMany({
        where: { guildId, memberReference: { in: linkedUserIds } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }).catch(() => []),
      prisma.memberInvite.findFirst({
        where: { guildId, userId: actualUserId },
      }).catch(() => null),
    ]);

  const effectivePermissions = member?.permissions?.toArray() ?? [];
  const roles = member
    ? [...member.roles.cache.values()]
        .filter((role) => !!role && role.id !== discordGuild.id)
        .map((role) => mapGuildRolePermissions(role, `<@&${role.id}>`))
        .sort((left, right) => {
          const positionLeft = discordGuild.roles.cache.get(left.id)?.position ?? 0;
          const positionRight = discordGuild.roles.cache.get(right.id)?.position ?? 0;
          return positionRight - positionLeft || left.name.localeCompare(right.name, 'fr');
        })
    : [];

  const tagCandidates = new Set<string>([user?.tag, profile?.userTag, member?.user?.tag].filter((entry): entry is string => !!entry));

    const relevantLogs = (auditLogs || []).filter((entry) => {
      try {
        const haystack = `${entry.user || ""} ${entry.details || ""}`;
        // Inclure si l'utilisateur est mentionné (format Discord ou ID brut)
        if (haystack.includes(actualUserId)) return true;
        
        // Inclure si les tags connus sont présents
        if ([...tagCandidates].some((candidate) => candidate && haystack.includes(candidate))) return true;
        
        // Inclure si c'est l'auteur du log
        if (entry.user === actualUserId) return true;
        
        return false;
      } catch (e) {
        return false;
      }
    });

    const mappedLogs: MemberCaseLogEntry[] = relevantLogs.slice(0, 120).map((entry) => ({
      id: entry.id,
      user: entry.user,
      action: entry.action,
      context: entry.context,
      module: entry.module,
      eventType: entry.eventType,
      source: entry.eventType === 'Discord' ? 'discord' : 'dashboard',
      details: interpretMentions(discordGuild, entry.details),
      dateIso: safeIsoDate(entry.dateIso) || new Date().toISOString(),
      channelId: entry.channelId,
    }));

  let invite: MemberCaseInviteInfo | null = dbInvite ? {
    code: dbInvite.inviteCode,
    inviterId: dbInvite.inviterId,
    inviterTag: dbInvite.inviterTag,
    inviterAvatarUrl: null,
    joinedAt: dbInvite.joinedAt.toISOString(),
  } : null;

  if (!invite) {
    invite = mappedLogs
      .map((entry) => parseInviteFromDetails(entry.details))
      .find((entry): entry is MemberCaseInviteInfo => !!entry) ?? null;
  }

  if (invite && invite.inviterId) {
    const cachedUser = client.users.cache.get(invite.inviterId);
    if (cachedUser) {
      invite.inviterTag = cachedUser.tag || cachedUser.username;
      invite.inviterAvatarUrl = cachedUser.displayAvatarURL({ size: 64 }) || null;
    } else {
      const fetchedUser = await client.users.fetch(invite.inviterId).catch(() => null);
      if (fetchedUser) {
        invite.inviterTag = fetchedUser.tag || fetchedUser.username;
        invite.inviterAvatarUrl = fetchedUser.displayAvatarURL({ size: 64 }) || null;
      } else {
        const inviterProfile = await prisma.memberProfile.findFirst({
          where: { guildId, userId: invite.inviterId },
          select: { userTag: true, displayName: true, username: true, avatarUrl: true }
        }).catch(() => null);
        if (inviterProfile) {
          invite.inviterTag = inviterProfile.displayName || inviterProfile.userTag || inviterProfile.username;
          invite.inviterAvatarUrl = inviterProfile.avatarUrl || null;
        }
      }
    }
  }

  if (invite && invite.inviterId && !invite.inviterTag) {
    invite.inviterTag = `Utilisateur ${invite.inviterId}`;
  }

    const messages = (auditLogs || [])
      .filter((entry) => {
        if (entry.module !== 'Messages' || entry.action !== 'Message envoyé') return false;
        // Le champ user est formaté "Tag (ID)", on vérifie que l'ID est bien à la fin
        return entry.user === actualUserId || entry.user.endsWith(`(${actualUserId})`);
      })
      .slice(0, 250)
      .map((entry) => {
        const msgId = extractMessageId(entry.details);
        return {
          id: entry.id,
          channelId: entry.channelId ?? 'unknown',
          channelName: formatChannelName(discordGuild, entry.channelId),
          content: interpretMentions(discordGuild, extractMessagePreview(entry.details) ?? entry.details),
          dateIso: safeIsoDate(entry.dateIso) || new Date().toISOString(),
          discordUrl: msgId ? `https://discord.com/channels/${guildId}/${entry.channelId}/${msgId}` : null,
        };
      });

  const messagesByChannelMap = new Map<string, MemberCaseChannelSummary>();
  for (const message of messages) {
    const current = messagesByChannelMap.get(message.channelId) ?? {
      channelId: message.channelId,
      channelName: message.channelName,
      count: 0,
      lastMessageAt: null,
      recentMessages: [],
    };

    current.count += 1;
    current.lastMessageAt = message.dateIso;
    if (current.recentMessages.length < 5) {
      current.recentMessages.push(message);
    }
    messagesByChannelMap.set(message.channelId, current);
  }

    // --- Calcul du graph d'interactions ---
    const extractIdFromUserStr = (str: string | null | undefined): string | null => {
      if (!str) return null;
      const match = str.match(/\(<@(\d+)>\)/);
      if (match) return match[1];
      const rawIdMatch = str.match(/^(\d+)$/);
      return rawIdMatch ? rawIdMatch[1] : null;
    };

    const nodes: MemberCaseInteractionNode[] = [
      { id: actualUserId, label: user?.tag ?? profile?.userTag ?? "Utilisateur", type: 'user', avatar: profile?.avatarUrl ?? user?.displayAvatarURL?.() }
    ];
    const edges: MemberCaseInteractionEdge[] = [];
    const targets = new Map<string, { label: string; mention: number; reply: number; reaction: number; total: number }>();

    const getOrCreateTarget = (targetId: string, defaultLabel: string) => {
      let t = targets.get(targetId);
      if (!t) {
        t = { label: defaultLabel, mention: 0, reply: 0, reaction: 0, total: 0 };
        targets.set(targetId, t);
      }
      return t;
    };

    for (const log of auditLogs || []) {
      const logUserId = extractIdFromUserStr(log.user);
      if (!logUserId) continue;

      if (log.module === 'Messages' && log.action === 'Message envoyé') {
        const details = log.details || '';
        const contentMatch = details.match(/Contenu: (.*)/);
        const content = contentMatch ? contentMatch[1] : details;

        // Parse mentions
        const mentionRegex = /<@!?(\d+)>/g;
        let match;
        const processedMentions = new Set<string>();
        while ((match = mentionRegex.exec(content)) !== null) {
          const targetId = match[1];
          if (processedMentions.has(targetId)) continue;
          processedMentions.add(targetId);

          if (logUserId === actualUserId) {
            // Outgoing mention
            if (targetId !== actualUserId) {
              const t = getOrCreateTarget(targetId, `User ${targetId}`);
              t.mention += 1;
              t.total += 1;
            }
          } else {
            // Incoming mention
            if (targetId === actualUserId) {
              const t = getOrCreateTarget(logUserId, `User ${logUserId}`);
              t.mention += 1;
              t.total += 1;
            }
          }
        }

        // Parse replies
        const replyMatch = details.match(/Réponse à:\s*<@!?(\d+)>/i);
        if (replyMatch) {
          const targetId = replyMatch[1];
          if (logUserId === actualUserId) {
            // Outgoing reply
            if (targetId !== actualUserId) {
              const t = getOrCreateTarget(targetId, `User ${targetId}`);
              t.reply += 1;
              t.total += 1;
            }
          } else {
            // Incoming reply
            if (targetId === actualUserId) {
              const t = getOrCreateTarget(logUserId, `User ${logUserId}`);
              t.reply += 1;
              t.total += 1;
            }
          }
        }
      } else if (log.module === 'Interactions' && log.action === 'Réaction ajoutée') {
        const details = log.details || '';
        const targetMatch = details.match(/Cible:\s*.*?\(<@!?(\d+)>\)/i);
        if (targetMatch) {
          const targetId = targetMatch[1];
          if (logUserId === actualUserId) {
            // Outgoing reaction
            if (targetId !== actualUserId) {
              const t = getOrCreateTarget(targetId, `User ${targetId}`);
              t.reaction += 1;
              t.total += 1;
            }
          } else {
            // Incoming reaction
            if (targetId === actualUserId) {
              const t = getOrCreateTarget(logUserId, `User ${logUserId}`);
              t.reaction += 1;
              t.total += 1;
            }
          }
        }
      }
    }

    // On récupère les tags des cibles si possible (limité au top 12 pour la perf et le visuel)
    const topTargets = [...targets.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 12);

    for (const [targetId, data] of topTargets) {
      let targetLabel = data.label;
      let targetAvatar: string | null = null;
      const cachedUser = client.users.cache.get(targetId);
      if (cachedUser) {
        targetLabel = cachedUser.tag;
        targetAvatar = cachedUser.displayAvatarURL({ size: 128 });
      }

      nodes.push({ id: targetId, label: targetLabel, type: 'target', avatar: targetAvatar });
      
      if (data.mention > 0) {
        edges.push({ from: actualUserId, to: targetId, type: 'mention', count: data.mention });
      }
      if (data.reply > 0) {
        edges.push({ from: actualUserId, to: targetId, type: 'reply', count: data.reply });
      }
      if (data.reaction > 0) {
        edges.push({ from: actualUserId, to: targetId, type: 'reaction', count: data.reaction });
      }
    }

    const result: MemberCaseResponse = {
      profile: {
        id: profile?.id ?? `${guildId}:${actualUserId}`,
        userId: actualUserId,
        userTag: user?.tag ?? profile?.userTag ?? null,
        username: user?.username ?? profile?.username ?? null,
        globalName: user?.globalName ?? profile?.globalName ?? null,
        displayName: member?.displayName ?? profile?.displayName ?? user?.globalName ?? user?.username ?? null,
        avatarUrl: profile?.avatarUrl ?? user?.displayAvatarURL?.({ size: 256 }) ?? null,
        bannerUrl: profile?.bannerUrl ?? null,
        accentColor: profile?.accentColor ?? user?.accentColor ?? null,
        locale: profile?.locale ?? null,
        isBot: profile?.isBot ?? user?.bot ?? false,
        accountCreatedAt: safeIsoDate(profile?.accountCreatedAt ?? user?.createdAt),
        guildJoinedAt: safeIsoDate(profile?.guildJoinedAt ?? member?.joinedAt),
        guildLeftAt: safeIsoDate(profile?.guildLeftAt),
        firstSeenAt: safeIsoDate(profile?.firstSeenAt),
        lastSeenAt: safeIsoDate(profile?.lastSeenAt),
        lastMessageAt: safeIsoDate(profile?.lastMessageAt),
        lastMessageChannelId: profile?.lastMessageChannelId ?? null,
        messageCount: profile?.messageCount ?? 0,
        voiceSessionCount: profile?.voiceSessionCount ?? 0,
        voiceTimeSeconds: profile?.voiceTimeSeconds ?? 0,
        voiceLastChannelId: profile?.voiceLastChannelId ?? null,
        voiceLastJoinedAt: safeIsoDate(profile?.voiceLastJoinedAt),
        voiceLastLeftAt: safeIsoDate(profile?.voiceLastLeftAt),
        rolesSnapshot: profile?.rolesSnapshot ?? [],
        presenceStatus: member?.presence?.status ?? null,
        pronouns: null,
        isTutor: staffMember?.isTutor ?? false,
        staffGrade: staffMember?.grade ?? null,
        isSuspectedDC: profile?.isSuspectedDC ?? false,
        moderatorNote: (profile as any)?.moderatorNote ?? null,
      },
      invite: invite
        ? {
            ...invite,
            joinedAt: invite.joinedAt ?? safeIsoDate(member?.joinedAt ?? profile?.guildJoinedAt),
          }
        : null,
      roles,
      effectivePermissions,
      sanctions: (sanctions || []).map((entry) => ({
        id: entry.id,
        type: entry.type as DashboardSanctionType,
        status: entry.status as DashboardSanctionStatus,
        targetUserId: entry.targetUserId,
        targetTag: entry.targetTag ?? `Utilisateur ${entry.targetUserId}`,
        moderatorUserId: entry.moderatorUserId,
        moderatorTag: entry.moderatorTag ?? `Modérateur ${entry.moderatorUserId}`,
        reason: entry.reason,
        durationSeconds: entry.durationSeconds,
        expiresAt: safeIsoDate(entry.expiresAt),
        createdAt: safeIsoDate(entry.createdAt) || new Date().toISOString(),
        resolvedAt: safeIsoDate(entry.resolvedAt),
        resolutionNote: entry.resolutionNote ?? null,
      })),
      logs: mappedLogs,
      messagesByChannel: [...messagesByChannelMap.values()].sort((left, right) => (right.lastMessageAt ?? '').localeCompare(left.lastMessageAt ?? '')),
      recentMessageCount: messages.length,
      recentLogCount: mappedLogs.length,
      connections: inviteConnections?.connections || [],
      connectionsNote: inviteConnections?.note || "",
      isSuspectedDC: profile?.isSuspectedDC ?? false,
      interactionGraph: { nodes, edges },
      candidatures: (candidatureHistory || []).map((c) => ({
        id: c.id,
        status: c.status,
        notes: c.notes ?? '',
        createdAt: safeIsoDate(c.createdAt) || new Date().toISOString(),
        data: c.data,
        autoRejected: c.autoRejected,
        autoRejectReason: c.autoRejectReason,
        rejectionReason: c.rejectionReason,
        oralResult: c.oralResult,
        reapplyAfter: safeIsoDate(c.reapplyAfter),
      })),
      sanctionReports: (sanctionReports || []).map((entry) => ({
        id: entry.id,
        sanctionId: entry.sanctionId ?? null,
        staffPseudo: entry.staffPseudo,
        incidentAt: safeIsoDate(entry.incidentAt) || new Date().toISOString(),
        memberPseudo: entry.memberPseudo,
        memberReference: entry.memberReference,
        sanctionType: entry.sanctionType as DashboardSanctionType,
        sanctionDurationLabel: entry.sanctionDurationLabel ?? null,
        brokenRules: entry.brokenRules,
        detailedReason: entry.detailedReason,
        evidenceLinks: entry.evidenceLinks,
        additionalNotes: entry.additionalNotes ?? null,
        createdByUserId: entry.createdByUserId,
        createdByTag: entry.createdByTag ?? null,
        createdAt: safeIsoDate(entry.createdAt) || new Date().toISOString(),
      })),
      linkedAccounts: await Promise.all(
        linkedUserIds
          .filter(id => id !== actualUserId)
          .map(async (lid) => {
            try {
              const lProfile = await prisma.memberProfile.findUnique({
                where: { guildId_userId: { guildId, userId: lid } },
                select: { userTag: true, username: true, displayName: true, avatarUrl: true }
              });
              const lLink = await prisma.linkedAccount.findFirst({
                where: {
                  guildId,
                  OR: [
                    { user1Id: actualUserId, user2Id: lid },
                    { user1Id: lid, user2Id: actualUserId }
                  ]
                }
              });
              return {
                userId: lid,
                userTag: lProfile?.displayName ?? lProfile?.userTag ?? lProfile?.username ?? `Utilisateur ${lid}`,
                avatarUrl: lProfile?.avatarUrl ?? null,
                type: lLink?.type ?? 'DC',
                status: lLink?.status ?? 'UNKNOWN'
              };
            } catch (e) {
              return {
                userId: lid,
                userTag: `Utilisateur ${lid}`,
                avatarUrl: null,
                type: 'DC',
                status: 'UNKNOWN'
              };
            }
          })
      )
    };

    return result;
  } catch (err) {
    logger.error('MembersAPI', `Fatal error building member case for ${actualUserId}:`, err);
    throw err;
  }
}

const getGuildName = (client: Client, guildId: string) => client.guilds.cache.get(guildId)?.name ?? `Serveur ${guildId}`;

async function resolveFeatureAccessMap(
  client: Client,
  guildId: string,
  access: DashboardAccess,
  userId: string | null,
  roleIds: string[],
): Promise<FeatureAccessMap> {
  const { getOrCreateFeatureConfigs } = await import('../services/dashboardManagementService.js');
  const featureConfigs = await getOrCreateFeatureConfigs(guildId);
  const isGlobalAdmin = userId ? await resolveAdminAccess(client, userId) : false;

  const moderationFeatureKeys = new Set([
    'content',
    'members',
    'sanctions',
    'double_accounts',
    'logs',
    'activity',
    'auto_thread',
  ]);
  const staffFeatureKeys = new Set([
    'recruitment',
    'staff_directory',
    'staff_roles',
    'tutoring',
    'meetings',
    'absences',
    'polls',
    'discipline',
    'events',
  ]);

  const featureAccess: FeatureAccessMap = {};
  for (const feature of featureConfigs) {
    if (isGlobalAdmin || access.level === 'admin') {
      featureAccess[feature.featureKey] = {
        canView: true,
        canModerate: true,
        canConfigure: true,
        canDelete: true,
      };
      continue;
    }

    const hasFeatureRoleOverrides = (feature.roleAccessByRole?.length ?? 0) > 0;
    
    if (!hasFeatureRoleOverrides) {
      const isDailyAlgo = feature.featureKey === 'daily_algo';
      const isModeration = moderationFeatureKeys.has(feature.featureKey);
      const isStaff = staffFeatureKeys.has(feature.featureKey);

      featureAccess[feature.featureKey] = {
        canView: access.canViewDashboard,
        canModerate: isDailyAlgo
          ? access.canModerateDailyAlgo
          : isModeration || isStaff
            ? access.canModerateContent
            : false,
        canConfigure: access.canManageSettings,
        canDelete: access.canManageSettings,
      };
      continue;
    }

    const permissions = feature.roleAccessByRole?.filter((entry) => roleIds.includes(entry.roleId)) ?? [];
    if (permissions.length === 0) {
      featureAccess[feature.featureKey] = {
        canView: false,
        canModerate: false,
        canConfigure: false,
        canDelete: false,
      };
      continue;
    }

    featureAccess[feature.featureKey] = permissions.reduce<FeatureAccess>((acc, entry) => {
      return {
        canView: acc.canView || entry.canView,
        canModerate: acc.canModerate || entry.canModerate,
        canConfigure: acc.canConfigure || entry.canConfigure,
        canDelete: acc.canDelete || entry.canDelete,
      };
    }, {
      canView: false,
      canModerate: false,
      canConfigure: false,
      canDelete: false,
    });
  }

  logger.info('DashboardAPI', `Resolved feature access for user ${userId} in guild ${guildId}`, { featureAccess });
  return featureAccess;
}

const getGuildState = async (client: Client, guildId: string, access: DashboardAccess, userId?: string): Promise<DashboardState | null> => {
  const guild = await prisma.guild.findUnique({ 
    where: { id: guildId },
    include: { dashboardFeatureConfigs: true }
  });
  if (!guild) return null;

  const last7Days: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    last7Days.push(dateKey);
  }

  const [
    dailyAlgoSubmissionCount,
    runtime,
    persistedAudit,
    sanctions,
    sanctionReports,
    regulationRules,
    dailyStatsTrend,
  ] = await Promise.all([
    prisma.dailyAlgoSubmission.count({ where: { run: { guildId } } }),
    getOrCreateRuntime(guildId),
    prisma.dashboardAuditLog.findMany({
      where: { guildId },
      orderBy: { dateIso: 'desc' },
      take: 160
    }),
    prisma.sanction.findMany({
      where: { guildId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.sanctionReport.findMany({
      where: { guildId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.guildRegulationArticle.findMany({
      where: { guildId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.guildDailyStat.findMany({
      where: {
        guildId,
        dateKey: { in: last7Days }
      }
    }),
  ]);

  const auditTrailFromDb: AuditEntry[] = persistedAudit.map((entry) => ({
    id: entry.id,
    user: entry.user,
    action: entry.action,
    context: entry.context,
    module: entry.module,
    eventType: entry.eventType,
    source: entry.eventType === 'Discord' ? 'discord' : 'dashboard',
    details: interpretMentions(client.guilds.cache.get(guildId) || null, entry.details),
    dateIso: entry.dateIso.toISOString(),
    channelId: entry.channelId
  }));

  const mappedSanctions: SanctionItem[] = sanctions.map((entry) => ({
    id: entry.id,
    type: entry.type as DashboardSanctionType,
    status: entry.status as DashboardSanctionStatus,
    targetUserId: entry.targetUserId,
    targetTag: entry.targetTag ?? `Utilisateur ${entry.targetUserId}`,
    moderatorUserId: entry.moderatorUserId,
    moderatorTag: entry.moderatorTag ?? `Modérateur ${entry.moderatorUserId}`,
    reason: entry.reason,
    durationSeconds: entry.durationSeconds,
    expiresAt: entry.expiresAt?.toISOString() ?? null,
    createdAt: entry.createdAt.toISOString(),
    resolvedAt: entry.resolvedAt?.toISOString() ?? null,
    resolutionNote: entry.resolutionNote ?? null,
  }));

  const mappedSanctionReports: SanctionReportItem[] = sanctionReports.map((entry) => ({
    id: entry.id,
    sanctionId: entry.sanctionId ?? null,
    staffPseudo: entry.staffPseudo,
    incidentAt: entry.incidentAt.toISOString(),
    memberPseudo: entry.memberPseudo,
    memberReference: entry.memberReference,
    sanctionType: entry.sanctionType as DashboardSanctionType,
    sanctionDurationLabel: entry.sanctionDurationLabel ?? null,
    brokenRules: entry.brokenRules,
    detailedReason: entry.detailedReason,
    evidenceLinks: entry.evidenceLinks,
    additionalNotes: entry.additionalNotes ?? null,
    createdByUserId: entry.createdByUserId,
    createdByTag: entry.createdByTag ?? null,
    createdAt: entry.createdAt.toISOString(),
  }));

  const mappedRegulationRules: RegulationRuleItem[] = regulationRules.map((entry) => ({
    id: entry.id,
    title: entry.title,
    description: entry.description,
    emoji: entry.emoji ?? null,
    sortOrder: entry.sortOrder,
    enabled: entry.enabled,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  }));




  const featureConfigs = (guild as any).dashboardFeatureConfigs || [];
  const getFeatureStatus = (key: string, defaultEnabled = true): ModuleStatus => {
    const config = featureConfigs.find((c: any) => c.featureKey === key);
    if (config) return config.enabled ? 'active' : 'inactive';
    return defaultEnabled ? 'active' : 'inactive';
  };

  const modules: ModuleItem[] = [
    {
      id: 'codepolice',
      name: 'Code Police',
      description: MODULE_DESCRIPTIONS.codepolice,
      status: getFeatureStatus('codepolice', guild.codePoliceEnabled),
      uptime: 99.9,
      interactions: 0,
      lastSync: guild.updatedAt.toISOString()
    },
    {
      id: 'daily_algo',
      name: 'Daily Algo',
      description: MODULE_DESCRIPTIONS.dailyalgo,
      status: getFeatureStatus('daily_algo', guild.dailyAlgoEnabled),
      uptime: guild.dailyAlgoEnabled ? 98.8 : 100,
      interactions: dailyAlgoSubmissionCount,
      lastSync: guild.updatedAt.toISOString()
    },
    {
      id: 'tutoring',
      name: 'Tutorat & Formation',
      description: MODULE_DESCRIPTIONS.tutoring,
      status: getFeatureStatus('tutoring'),
      uptime: 100,
      interactions: 0,
      lastSync: guild.updatedAt.toISOString()
    },
    {
      id: 'meetings',
      name: 'Réunions',
      description: MODULE_DESCRIPTIONS.meetings,
      status: getFeatureStatus('meetings'),
      uptime: 100,
      interactions: 0,
      lastSync: guild.updatedAt.toISOString()
    },
    {
      id: 'absences',
      name: 'Absences',
      description: MODULE_DESCRIPTIONS.absences,
      status: getFeatureStatus('absences'),
      uptime: 100,
      interactions: 0,
      lastSync: guild.updatedAt.toISOString()
    },
    {
      id: 'events',
      name: 'Événements & Quiz',
      description: MODULE_DESCRIPTIONS.events,
      status: getFeatureStatus('events'),
      uptime: 100,
      interactions: 0,
      lastSync: guild.updatedAt.toISOString()
    },
    {
      id: 'traduction',
      name: 'Traduction Automatique',
      description: MODULE_DESCRIPTIONS.traduction,
      status: getFeatureStatus('translation', guild.translationEnabled),
      uptime: guild.translationEnabled ? 97.1 : 100,
      interactions: 0,
      lastSync: guild.updatedAt.toISOString()
    },
    {
      id: 'regulation',
      name: 'Règlement',
      description: MODULE_DESCRIPTIONS.regulation,
      status: getFeatureStatus('regulation'),
      uptime: 100,
      interactions: 0,
      lastSync: guild.updatedAt.toISOString()
    },
    {
      id: 'staff_management',
      name: 'Gestion Staff',
      description: MODULE_DESCRIPTIONS.staff_management,
      status: 'active',
      uptime: 100,
      interactions: 0,
      lastSync: guild.updatedAt.toISOString()
    },
    {
      id: 'sanctions',
      name: 'Gestion Sanctions',
      description: MODULE_DESCRIPTIONS.sanctions,
      status: getFeatureStatus('sanctions'),
      uptime: 100,
      interactions: sanctions.length,
      lastSync: guild.updatedAt.toISOString()
    },
    {
      id: 'members',
      name: 'Membres & DC',
      description: MODULE_DESCRIPTIONS.members,
      status: 'active',
      uptime: 100,
      interactions: 0,
      lastSync: guild.updatedAt.toISOString()
    },
    {
      id: 'double_accounts',
      name: 'Doubles Comptes',
      description: MODULE_DESCRIPTIONS.double_accounts,
      status: getFeatureStatus('double_accounts'),
      uptime: 100,
      interactions: 0,
      lastSync: guild.updatedAt.toISOString()
    },
    {
      id: 'logs',
      name: 'Logs Discord',
      description: MODULE_DESCRIPTIONS.logs,
      status: getFeatureStatus('logs'),
      uptime: 100,
      interactions: 0,
      lastSync: guild.updatedAt.toISOString()
    },
    {
      id: 'nickname_moderation',
      name: 'Modération des pseudos',
      description: MODULE_DESCRIPTIONS.nickname_moderation,
      status: getFeatureStatus('nickname_moderation', guild.autoNicknameModerationEnabled),
      uptime: guild.autoNicknameModerationEnabled ? 100 : 100,
      interactions: 0,
      lastSync: guild.updatedAt.toISOString()
    },
    {
      id: 'auto_thread',
      name: 'Auto-Thread',
      description: MODULE_DESCRIPTIONS.auto_thread,
      status: getFeatureStatus('auto_thread', guild.autoThreadEnabled),
      uptime: 100,
      interactions: 0,
      lastSync: guild.updatedAt.toISOString()
    },
    {
      id: 'recruitment',
      name: 'Recrutement',
      description: MODULE_DESCRIPTIONS.recruitment,
      status: getFeatureStatus('recruitment'),
      uptime: 100,
      interactions: 0,
      lastSync: guild.updatedAt.toISOString()
    },
    {
      id: 'tickets',
      name: 'Tickets Support',
      description: MODULE_DESCRIPTIONS.tickets,
      status: getFeatureStatus('tickets'),
      uptime: 100,
      interactions: 0,
      lastSync: guild.updatedAt.toISOString()
    },
    {
      id: 'activity',
      name: 'Journal d\'activité',
      description: MODULE_DESCRIPTIONS.activity,
      status: 'active',
      uptime: 100,
      interactions: auditTrailFromDb.length,
      lastSync: guild.updatedAt.toISOString(),
      isFixed: true,
    },
    {
      id: 'analytics',
      name: 'Analytics',
      description: MODULE_DESCRIPTIONS.analytics,
      status: 'active',
      uptime: 100,
      interactions: 0,
      lastSync: guild.updatedAt.toISOString()
    },
    {
      id: 'profile',
      name: 'Profil',
      description: MODULE_DESCRIPTIONS.profile,
      status: 'active',
      uptime: 100,
      interactions: 0,
      lastSync: guild.updatedAt.toISOString()
    },
    {
      id: 'youtube',
      name: 'YouTube',
      description: MODULE_DESCRIPTIONS.youtube,
      status: guild.youtubeEnabled ? 'active' : 'inactive',
      uptime: 100,
      interactions: 0,
      lastSync: guild.updatedAt.toISOString()
    },
    {
      id: 'digest',
      name: 'Digest',
      description: MODULE_DESCRIPTIONS.digest,
      status: guild.digestEnabled ? 'active' : 'inactive',
      uptime: 100,
      interactions: 0,
      lastSync: guild.updatedAt.toISOString()
    }
  ];


  const discordGuild = client.guilds.cache.get(guildId);
  const currentMember = userId && discordGuild ? await discordGuild.members.fetch(userId).catch(() => null) : null;
  const currentRoleIds = currentMember
    ? currentMember.roles.cache
        .map((role) => role?.id)
        .filter((roleId): roleId is string => !!roleId)
    : [];
  const featureAccess = await resolveFeatureAccessMap(client, guildId, access, userId ?? null, currentRoleIds);
  const discordChannels: DashboardChannel[] = discordGuild
    ? discordGuild.channels.cache
        .filter((channel) => channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement)
        .map((channel) => ({
          id: channel.id,
          name: channel.name,
          mention: `<#${channel.id}>`,
          position: channel.rawPosition ?? 0
        }))
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'fr'))
        .map(({ id, name, mention }) => ({ id, name, mention }))
    : [];

  const discordVoiceChannels: DashboardChannel[] = discordGuild
    ? discordGuild.channels.cache
        .filter((channel) => channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice)
        .map((channel) => ({
          id: channel.id,
          name: channel.name,
          mention: `<#${channel.id}>`,
          position: channel.rawPosition ?? 0
        }))
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'fr'))
        .map(({ id, name, mention }) => ({ id, name, mention }))
    : [];

  const discordCategories: DashboardChannel[] = discordGuild
    ? discordGuild.channels.cache
        .filter((channel) => channel.type === ChannelType.GuildCategory)
        .map((channel) => ({
          id: channel.id,
          name: channel.name,
          mention: `<#${channel.id}>`,
          position: channel.rawPosition ?? 0
        }))
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'fr'))
        .map(({ id, name, mention }) => ({ id, name, mention }))
    : [];


  const discordRoles: DashboardRole[] = discordGuild
    ? discordGuild.roles.cache
        .filter((role) => role.name !== '@everyone' && !role.managed)
        .map((role) => ({
          id: role.id,
          name: role.name,
          mention: `<@&${role.id}>`,
          permissions: role.permissions.toArray(),
          position: role.position
        }))
        .sort((a, b) => b.position - a.position || a.name.localeCompare(b.name, 'fr'))
        .map(({ id, name, mention, permissions, position }) => ({ id, name, mention, permissions, position }))
    : [];

  const trendMap = new Map(dailyStatsTrend.map(s => [s.dateKey, s]));
  const messagesTrend = last7Days.map(dateKey => trendMap.get(dateKey)?.messagesCount ?? 0);
  const voiceTrend = last7Days.map(dateKey => trendMap.get(dateKey)?.voiceMinutes ?? 0);
  const joinsTrend = last7Days.map(dateKey => trendMap.get(dateKey)?.membersJoined ?? 0);
  const leavesTrend = last7Days.map(dateKey => trendMap.get(dateKey)?.membersLeft ?? 0);
  const sanctionsTrend = last7Days.map(dateKey => trendMap.get(dateKey)?.sanctionsCount ?? 0);

  return {
    guildName: getGuildName(client, guildId),
    configChannelId: guild.configChannelId ?? '',
    logChannelId: guild.logChannelId ?? '',
    regulationChannelId: guild.regulationChannelId ?? '',
    regulationMessageId: guild.regulationMessageId ?? null,
    meetingAnnouncementChannelId: guild.meetingAnnouncementChannelId ?? '',
    meetingVoiceChannelId: guild.meetingVoiceChannelId ?? '',
    publicChannelId: guild.publicChannelId ?? '',
    newsChannelId: guild.newsChannelId ?? '',
    dailyAlgoChannelId: guild.dailyAlgoChannelId ?? '',
    baseStaffRoleId: guild.baseStaffRoleId ?? '',
    testStaffRoleId: guild.testStaffRoleId ?? '',
    propagateSanctions: guild.propagateSanctions,
    translationEnabled: guild.translationEnabled,
    codePoliceEnabled: guild.codePoliceEnabled,
    dailyAlgoEnabled: guild.dailyAlgoEnabled,
    githubReleasesEnabled: guild.githubReleasesEnabled,
    digestEnabled: guild.digestEnabled,
    autoThreadEnabled: guild.autoThreadEnabled,
    autoThreadChannels: guild.autoThreadChannels,
    youtubeEnabled: getFeatureStatus('youtube', guild.youtubeEnabled) === 'active',
    recruitmentCategoryId: guild.recruitmentCategoryId ?? '',
    recruitmentLogChannelId: guild.recruitmentLogChannelId ?? '',
    recruitmentAutoRejectEnabled: isRecruitmentAutoRejectEnabled(guildId),
    modules,
    discordChannels,
    discordVoiceChannels,
    discordCategories,
    discordRoles,
    moderatorRoleId: guild.moderatorRoleId ?? '',
    commandRestrictions: runtime.commandRestrictions,
    commandCatalog: COMMAND_CATALOG,
    access: {
      level: access.level === 'admin' ? 'admin' : 'moderator',
      canModerateContent: access.canModerateContent,
      canModerateDailyAlgo: access.canModerateDailyAlgo,
      canManageSettings: access.canManageSettings || Object.values(featureAccess).some(f => f.canConfigure),
    },
    featureAccess,
    notifications: {
      discordChannel: guild.statusCheckChannelId ? `<#${guild.statusCheckChannelId}>` : '#alertes-redaction',
      email: runtime.email,
      emailEnabled: runtime.emailEnabled,
      cloudBackup: runtime.cloudBackup,
      debugLog: runtime.debugLog,
      killSwitchEnabled: runtime.killSwitchEnabled,
      severityByModule: runtime.severityByModule
    },
    auditTrail: auditTrailFromDb.slice(0, 180),
    sanctions: mappedSanctions,
    sanctionReports: mappedSanctionReports,
    regulationRules: mappedRegulationRules,
    messageTemplate: runtime.messageTemplate,
    analytics: {
      activityTrend: messagesTrend,
      messagesTrend,
      voiceTrend,
      joinsTrend,
      leavesTrend,
      sanctionsTrend,
      totalAutomations: modules.reduce((acc, m) => acc + m.interactions, 0),
      healthStatus: 100
    },
    member: currentMember ? {
      id: currentMember.id,
      nickname: currentMember.nickname,
      roles: currentMember.roles.cache.map(role => ({
        id: role.id,
        name: role.name,
        position: role.position,
        managed: role.managed
      }))
    } : null,
  };
};

const splitPath = (pathname: string) => pathname.split('/').filter(Boolean);

let dashboardStateBroadcaster: ((guildId: string, reason: string) => void) | null = null;

export async function notifyDashboardSanctionReportRequired(params: {
  guildId: string;
  sanctionId: string;
  sanctionType: DashboardSanctionType;
  targetTag: string;
  moderatorTag: string;
}) {
  const details = [
    `Sanction ${params.sanctionType} appliquée à ${params.targetTag}.`,
    `Rapport à compléter pour ${params.moderatorTag}.`,
    `ID sanction: ${params.sanctionId}.`,
  ].join(' ');

  await prisma.dashboardAuditLog.create({
    data: {
      guildId: params.guildId,
      user: params.moderatorTag,
      action: 'Rapport de sanction requis',
      context: `Sanction ${params.sanctionType}`,
      module: 'Sanctions',
      eventType: 'Action requise',
      details,
      dateIso: new Date(),
    },
  });

  dashboardStateBroadcaster?.(params.guildId, 'sanction_report_required');
}

function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function parseDiscordMarkdown(text: string, guild?: any): string {
  if (!text) return '';
  let escaped = escapeHtml(text);

  // Bold
  escaped = escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  
  // Italic
  escaped = escaped.replace(/\*(.*?)\*/g, '<em>$1</em>');
  
  // Underline
  escaped = escaped.replace(/__(.*?)__/g, '<u>$1</u>');
  
  // Strikethrough
  escaped = escaped.replace(/~~(.*?)~~/g, '<del>$1</del>');

  // Inline Code
  escaped = escaped.replace(/`(.*?)`/g, '<code class="px-1.5 py-0.5 rounded bg-zinc-800 font-mono text-sm">$1</code>');

  // Block Code (multi-line)
  escaped = escaped.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre class="p-3 my-2 rounded bg-zinc-800 font-mono text-sm overflow-x-auto"><code class="language-${lang || 'plaintext'}">${code}</code></pre>`;
  });

  // Custom Emojis <:name:id> or <a:name:id>
  escaped = escaped.replace(/&lt;:([a-zA-Z0-9_]+):(\d+)&gt;/g, (_, name, id) => {
    return `<img class="inline-block h-[1.375em] w-auto align-middle mx-[0.15em]" src="https://cdn.discordapp.com/emojis/${id}.png?size=48&quality=lossless" alt=":${name}:" title=":${name}:" />`;
  });
  escaped = escaped.replace(/&lt;a:([a-zA-Z0-9_]+):(\d+)&gt;/g, (_, name, id) => {
    return `<img class="inline-block h-[1.375em] w-auto align-middle mx-[0.15em]" src="https://cdn.discordapp.com/emojis/${id}.gif?size=48&quality=lossless" alt=":${name}:" title=":${name}:" />`;
  });

  // Mentions
  if (guild) {
    escaped = escaped.replace(/&lt;@!?(\d+)&gt;/g, (_, id) => {
      const member = guild.members.cache.get(id);
      const user = guild.client.users.cache.get(id);
      const name = member?.displayName || user?.username || 'Utilisateur';
      return `<span class="font-semibold text-sky-400 px-1.5 py-0.5 bg-sky-500/10 rounded hover:bg-sky-500 hover:text-white transition-colors cursor-pointer">@${escapeHtml(name)}</span>`;
    });
    escaped = escaped.replace(/&lt;#(\d+)&gt;/g, (_, id) => {
      const ch = guild.channels.cache.get(id);
      return `<span class="font-semibold text-sky-400 px-1.5 py-0.5 bg-sky-500/10 rounded hover:bg-sky-500 hover:text-white transition-colors cursor-pointer">#${ch ? escapeHtml(ch.name) : 'salon-inconnu'}</span>`;
    });
    escaped = escaped.replace(/&lt;@&amp;(\d+)&gt;/g, (_, id) => {
      const role = guild.roles.cache.get(id);
      return `<span class="font-semibold text-sky-400 px-1.5 py-0.5 bg-sky-500/10 rounded hover:bg-sky-500 hover:text-white transition-colors cursor-pointer">@${role ? escapeHtml(role.name) : 'rôle-inconnu'}</span>`;
    });
  } else {
    escaped = escaped.replace(/&lt;@!?(\d+)&gt;/g, '<span class="font-semibold text-sky-400 px-1.5 py-0.5 bg-sky-500/10 rounded cursor-pointer">@Utilisateur</span>');
    escaped = escaped.replace(/&lt;#(\d+)&gt;/g, '<span class="font-semibold text-sky-400 px-1.5 py-0.5 bg-sky-500/10 rounded cursor-pointer">#salon</span>');
    escaped = escaped.replace(/&lt;@&amp;(\d+)&gt;/g, '<span class="font-semibold text-sky-400 px-1.5 py-0.5 bg-sky-500/10 rounded cursor-pointer">@Rôle</span>');
  }

  return escaped;
}

function extractMediaUrls(content: string): { type: 'image' | 'video' | 'audio', url: string }[] {
  if (!content) return [];
  const urls: { type: 'image' | 'video' | 'audio', url: string }[] = [];
  const regex = /(https?:\/\/[^\s]+)/g;
  const matches = content.match(regex);
  if (matches) {
    for (const url of matches) {
      const cleanUrl = url.split('?')[0];
      if (/\.(gif|jpg|jpeg|png|webp)/i.test(cleanUrl)) {
        urls.push({ type: 'image', url });
      } else if (/\.(mp4|webm|mov|ogg)/i.test(cleanUrl)) {
        urls.push({ type: 'video', url });
      } else if (/\.(mp3|wav|ogg|flac|m4a)/i.test(cleanUrl)) {
        urls.push({ type: 'audio', url });
      } else if (/giphy\.com\/gifs\//i.test(cleanUrl)) {
        const parts = cleanUrl.split('-');
        const id = parts[parts.length - 1];
        if (id) {
          urls.push({ type: 'image', url: `https://media.giphy.com/media/${id}/giphy.gif` });
        }
      }
    }
  }
  return urls;
}

export const startDashboardApi = (client: Client) => {
  const port = Number(process.env.DASHBOARD_API_PORT ?? '8787');
  const wsServer = new WebSocketServer({ noServer: true });
  const strictOAuthConfig = process.env.DASHBOARD_OAUTH_STRICT === 'true';

  const getMissingOAuthConfig = ({ includeSecret = false }: { includeSecret?: boolean } = {}) => {
    const missing: string[] = [];
    if (!DISCORD_CLIENT_ID?.trim()) missing.push('DISCORD_CLIENT_ID');
    if (!DISCORD_REDIRECT_URI?.trim()) missing.push('DISCORD_REDIRECT_URI');
    if (includeSecret && !DISCORD_CLIENT_SECRET?.trim()) missing.push('DISCORD_CLIENT_SECRET');
    return missing;
  };

  const missingOAuthAtStartup = getMissingOAuthConfig({ includeSecret: true });
  if (missingOAuthAtStartup.length > 0) {
    const message = `Configuration OAuth invalide: variables manquantes (${missingOAuthAtStartup.join(', ')})`;
    if (strictOAuthConfig) {
      logger.error('DashboardAPI', message);
      throw new Error(message);
    }

    logger.warn('DashboardAPI', `${message}. Les routes OAuth renverront une erreur tant que ces variables ne sont pas définies.`);
  }

  const broadcastDashboardStateChange = (guildId: string, reason: string) => {
    const payload = JSON.stringify({
      type: 'dashboard_state_changed',
      guildId,
      reason,
      at: new Date().toISOString(),
    });

    wsServer.clients.forEach((socket) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    });
  };

  /** Diffuse un événement de modification de mots bannis avec filtrage par serveur. */
  const broadcastBannedWordsChange = (guildId: string, action: 'added' | 'updated' | 'deleted', word: string) => {
    const payload = JSON.stringify({
      type: 'banned_words_changed',
      guildId,
      action,
      word,
      at: new Date().toISOString(),
    });
    wsServer.clients.forEach((socket) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    });
  };

  dashboardStateBroadcaster = broadcastDashboardStateChange;

  const server = createServer(async (req, res) => {
    // Standard CORS headers for all responses
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, Origin, X-Requested-With, Cache-Control, Pragma');
    res.setHeader('Access-Control-Max-Age', '86400');

    try {
      if (!req.url) {
        json(res, 400, { error: 'Requête invalide' });
        return;
      }

      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host ?? `localhost:${port}`}`);
      const parts = splitPath(url.pathname);

      if (parts[0] === 'api' && parts[1] === 'public' && parts[2] === 'profile' && parts[3] && req.method === 'GET') {
        const userId = parts[3];
        try {
          let snapshot = await getPublicProfileSnapshot(userId);
          let profile = snapshot?.memberProfile;

          if (!snapshot || !profile) {
            // Fallback: Fetch user details directly from Discord
            const discordUser = await client.users.fetch(userId).catch(() => null);
            if (!discordUser) {
              json(res, 404, { error: 'Utilisateur introuvable' });
              return;
            }

            // Try to find a guild where this user is present to get a guildId context
            const sharedGuild = client.guilds.cache.find(g => g.members.cache.has(userId));
            const fallbackGuildId = sharedGuild?.id || client.guilds.cache.first()?.id || '';

            profile = {
              id: `${fallbackGuildId}:${userId}`,
              guildId: fallbackGuildId,
              userId: userId,
              userTag: discordUser.tag,
              username: discordUser.username,
              globalName: discordUser.globalName || null,
              displayName: discordUser.globalName || discordUser.username,
              avatarUrl: discordUser.displayAvatarURL(),
              bannerUrl: null,
              accentColor: discordUser.accentColor || null,
              locale: null,
              isBot: discordUser.bot,
              bio: null,
              isProfilePrivate: false,
              accountCreatedAt: discordUser.createdAt,
              guildJoinedAt: null,
              guildLeftAt: null,
              firstSeenAt: new Date(),
              lastSeenAt: new Date(),
              lastMessageAt: null,
              lastMessageChannelId: null,
              messageCount: 0,
              voiceSessionCount: 0,
              voiceTimeSeconds: 0,
              voiceLastChannelId: null,
              voiceLastJoinedAt: null,
              voiceLastLeftAt: null,
              rolesSnapshot: [],
              isSuspectedDC: false,
              moderatorNote: null,
              createdAt: new Date(),
              updatedAt: new Date(),
            };

            snapshot = {
              memberProfile: profile,
              invite: null,
              eventParticipations: [],
              dailyAlgoProfile: null,
              dailyAlgoParticipations: [],
            };
          }

          const roleDisplay = await resolveProfileRoleDisplay(client, profile.guildId, profile.rolesSnapshot);
          const authUser = verifyAuth(req);
          const viewerGuildAccess = authUser
            ? await resolveDashboardAccess(client, profile.guildId, authUser.userId).catch(() => null)
            : null;
          const canViewPrivate = !profile.isProfilePrivate || authUser?.userId === userId || !!viewerGuildAccess?.level && viewerGuildAccess.level !== 'none';

          const response = canViewPrivate
            ? {
                userId: profile.userId,
                username: profile.username,
                globalName: profile.globalName,
                displayName: profile.displayName || profile.globalName || profile.username,
                avatar: profile.avatarUrl,
                banner: profile.bannerUrl,
                bio: profile.bio,
                isPrivate: profile.isProfilePrivate,
                roles: roleDisplay.roles,
                primaryRole: roleDisplay.primaryRole,
                accountCreatedAt: profile.accountCreatedAt,
                guildJoinedAt: profile.guildJoinedAt,
                guildLeftAt: profile.guildLeftAt,
                lastSeenAt: profile.lastSeenAt,
                messageCount: profile.messageCount,
                voiceTimeSeconds: profile.voiceTimeSeconds,
                invite: snapshot.invite,
                points: snapshot.dailyAlgoProfile?.totalPoints || 0,
                tier: snapshot.dailyAlgoProfile?.tier || 'Débutant',
                streak: snapshot.dailyAlgoProfile?.currentStreak || 0,
                rank: snapshot.dailyAlgoProfile ? snapshot.dailyAlgoProfile.rank - 1 : 0, // 0-indexed for frontend
                recentAlgos: snapshot.dailyAlgoParticipations.map((entry) => ({
                  title: entry.problemTitle,
                  date: entry.submittedAt ? entry.submittedAt.toISOString() : new Date().toISOString(),
                  status: entry.status,
                  points: entry.totalPoints,
                })),
                eventParticipations: snapshot.eventParticipations.map((entry) => ({
                  id: entry.id,
                  eventId: entry.eventId,
                  title: entry.eventTitle,
                  type: entry.eventType,
                  date: entry.createdAt.toISOString(),
                  score: entry.score,
                })),
              }
            : {
                userId: profile.userId,
                username: profile.username,
                globalName: profile.globalName,
                displayName: profile.displayName || profile.globalName || profile.username,
                avatar: profile.avatarUrl,
                banner: profile.bannerUrl,
                bio: null,
                isPrivate: true,
                roles: roleDisplay.roles,
                primaryRole: roleDisplay.primaryRole,
                accountCreatedAt: null,
                guildJoinedAt: null,
                guildLeftAt: profile.guildLeftAt,
                lastSeenAt: null,
                messageCount: null,
                voiceTimeSeconds: null,
                invite: null,
                points: 0,
                tier: 'Débutant',
                streak: 0,
                rank: 0,
                recentAlgos: [],
                eventParticipations: [],
              };

          json(res, 200, response);
        } catch (err) {
          logger.error('PublicAPI', `Error fetching public profile for ${userId}:`, err);
          json(res, 500, { error: 'Erreur interne du serveur' });
        }
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'public' && parts[2] === 'profile' && parts[3] && req.method === 'PATCH') {
        const userId = parts[3];
        const authUser = verifyAuth(req);
        if (!authUser) {
          json(res, 401, { error: 'Non authentifié' });
          return;
        }

        try {
          const snapshot = await getPublicProfileSnapshot(userId);
          if (!snapshot) {
            json(res, 404, { error: 'Profil introuvable' });
            return;
          }

          if (authUser.userId !== userId) {
            json(res, 403, { error: 'Seul le propriétaire du profil peut le modifier' });
            return;
          }

          const body = await readJsonBody<{ bio?: string | null; isProfilePrivate?: boolean }>(req);
          const updatedProfile = await prisma.memberProfile.update({
            where: { id: snapshot.memberProfile.id },
            data: {
              bio: typeof body?.bio === 'string' ? body.bio.trim() : body?.bio === null ? null : snapshot.memberProfile.bio,
              isProfilePrivate: typeof body?.isProfilePrivate === 'boolean'
                ? body.isProfilePrivate
                : snapshot.memberProfile.isProfilePrivate,
            },
          });

          json(res, 200, {
            ok: true,
            profile: {
              bio: updatedProfile.bio,
              isProfilePrivate: updatedProfile.isProfilePrivate,
            },
          });
        } catch (err) {
          logger.error('PublicAPI', `Error updating public profile for ${userId}:`, err);
          json(res, 500, { error: 'Erreur lors de la mise à jour du profil' });
        }
        return;
      }

      // Public activity image (aggregated across guilds)
      if (
        parts[0] === 'api' &&
        parts[1] === 'public' &&
        parts[2] === 'profile' &&
        parts[3] &&
        parts[4] === 'activity-image' &&
        req.method === 'GET'
      ) {
        const userId = parts[3];
        const url = new URL(req.url, `http://${req.headers.host}`);
        const days = parseInt(url.searchParams.get('days') || '14', 10);
        try {
          const since = new Date();
          since.setDate(since.getDate() - days + 1);
          const startKey = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, '0')}-${String(since.getDate()).padStart(2, '0')}`;

          const stats = await prisma.memberDailyStat.findMany({
            where: { userId, dateKey: { gte: startKey } },
            orderBy: { dateKey: 'asc' },
          });

          // Aggregate by dateKey across guilds
          const map: Record<string, { messages: number; voice: number }> = {};
          for (const s of stats) {
            if (!map[s.dateKey]) map[s.dateKey] = { messages: 0, voice: 0 };
            map[s.dateKey].messages += s.messagesCount;
            map[s.dateKey].voice += s.voiceMinutes;
          }

          const dailyData = Object.keys(map)
            .sort()
            .map((date) => ({ date, messages: map[date].messages, voice: map[date].voice }));

          const totalMessages = dailyData.reduce((a, b) => a + b.messages, 0);
          const totalVoice = dailyData.reduce((a, b) => a + b.voice, 0);
          const activeDays = dailyData.length;
          const peakDayMessages = dailyData.reduce((a, b) => Math.max(a, b.messages), 0);

          const { generateMemberStatsImage } = await import('../services/imageService.js');
          const buffer = await generateMemberStatsImage(userId, days, { totalMessages, totalVoice, activeDays, peakDayMessages }, dailyData);

          res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300' });
          res.end(buffer);
        } catch (err) {
          logger.error('PublicAPI', `Error generating activity image for ${parts[3]}:`, err);
          json(res, 500, { error: 'Erreur lors de la génération du graphique' });
        }
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'public' && parts[2] === 'rss' && parts[3] && req.method === 'GET') {
        const guildId = parts[3];
        const category = parts[4] ? decodeURIComponent(parts[4]) : url.searchParams.get('category');
        const subcategory = parts[5] ? decodeURIComponent(parts[5]) : url.searchParams.get('subcategory');
        
        try {
          const guild = await prisma.guild.findUnique({
            where: { id: guildId },
            select: { id: true }
          });
          if (!guild) {
            json(res, 404, { error: 'Guilde introuvable' });
            return;
          }

          const whereClause: any = { guildId, published: true };
          if (category) {
            whereClause.category = { equals: category, mode: 'insensitive' };
          }
          if (subcategory) {
            whereClause.subcategory = { equals: subcategory, mode: 'insensitive' };
          }

          const articles = await prisma.newsArticle.findMany({
            where: whereClause,
            orderBy: { publishedAt: 'desc' }
          });

          const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
          const guildName = discordGuild?.name ?? `Serveur ${guildId}`;
          const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';
          const apiUrl = process.env.VITE_API_URL || '';

          const rssXml = generateRssXml(guildName, guildId, dashboardUrl, apiUrl, articles, category, subcategory);

          res.writeHead(200, {
            'Content-Type': 'application/rss+xml; charset=utf-8',
            'Cache-Control': 'public, max-age=300'
          });
          res.end(rssXml);
        } catch (err: any) {
          logger.error('PublicAPI', `Error generating RSS for guild ${guildId}: ${err.message}`);
          json(res, 500, { error: 'Erreur lors de la génération du flux RSS' });
        }
        return;
      }

      if (parts[0] === 'api' && parts[1] === 'public' && parts[2] === 'transcripts' && parts[3] && req.method === 'GET') {
        const transcriptId = parts[3];
        try {
          const transcript = await prisma.transcript.findUnique({
            where: { id: transcriptId }
          });

          if (!transcript) {
            json(res, 404, { error: 'Transcription introuvable' });
            return;
          }

          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.statusCode = 200;
          res.end(transcript.html);
        } catch (err: any) {
          logger.error('PublicAPI', `Error fetching public transcript ${transcriptId}: ${err.message}`);
          json(res, 500, { error: 'Erreur interne du serveur' });
        }
        return;
      }

      if (url.pathname === '/health') {
        json(res, 200, { ok: true, service: 'kotbo-dashboard-api' });
        return;
      }

      if (url.pathname === '/api/config' && req.method === 'GET') {
        const missingOAuth = getMissingOAuthConfig();
        if (missingOAuth.length > 0) {
          json(res, 500, {
            error: 'Configuration OAuth invalide côté serveur.',
            missing: missingOAuth,
          });
          return;
        }

        json(res, 200, { discordClientId: DISCORD_CLIENT_ID });
        return;
      }


      // --- AUTH ROUTES ---
      if (parts.length >= 2 && parts[0] === 'api' && parts[1] === 'auth') {
        if (parts[2] === 'discord') {
          if (parts[3] === 'login') {
            const missingOAuth = getMissingOAuthConfig();
            if (missingOAuth.length > 0) {
              json(res, 500, {
                error: 'Configuration OAuth invalide côté serveur.',
                missing: missingOAuth,
              });
              return;
            }

            const discordUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URI!)}&response_type=code&scope=identify%20guilds`;
            res.writeHead(302, { Location: discordUrl });
            res.end();
            return;
          }

          if (parts[3] === 'callback') {
            const missingOAuth = getMissingOAuthConfig({ includeSecret: true });
            if (missingOAuth.length > 0) {
              json(res, 500, {
                error: 'Configuration OAuth invalide côté serveur.',
                missing: missingOAuth,
              });
              return;
            }

            const code = url.searchParams.get('code');
            if (!code) {
              res.writeHead(302, { Location: `${DASHBOARD_URL}/login?error=no_code` });
              res.end();
              return;
            }

            try {
              // Exchange code for token
              const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
                method: 'POST',
                body: new URLSearchParams({
                  client_id: DISCORD_CLIENT_ID!,
                  client_secret: DISCORD_CLIENT_SECRET!,
                  grant_type: 'authorization_code',
                  code,
                  redirect_uri: DISCORD_REDIRECT_URI!,
                }),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              });

              const tokenData = await tokenResponse.json() as any;
              if (tokenData.error) throw new Error(tokenData.error_description);

              // Get user info
              const userResponse = await fetch('https://discord.com/api/users/@me', {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
              });
              const userData = await userResponse.json() as any;

              // Create JWT
              const token = jwt.sign({
                userId: userData.id,
                username: userData.username,
                avatar: userData.avatar,
                discordToken: tokenData.access_token
              }, JWT_SECRET, { expiresIn: '7d' });

              res.writeHead(302, { Location: `${DASHBOARD_URL}?token=${token}` });
              res.end();
            } catch (err) {
              logger.error('Auth', 'Discord callback error:', err);
              // Log the error response if available
              if (err instanceof Error) {
                logger.error('Auth', `Message: ${err.message}`);
              }
              res.writeHead(302, { Location: `${DASHBOARD_URL}/login?error=auth_failed` });
              res.end();
            }
            return;
          }
        }
      }
      if (parts[0] === 'api' && parts[1] === 'report-error' && req.method === 'POST') {
        try {
          const payload = await readJsonBody<{
            error: string;
            stack?: string;
            url: string;
            userAgent: string;
            guildId?: string | null;
          }>(req);

          if (!payload || !payload.error) {
            json(res, 400, { error: 'Payload invalide' });
            return;
          }

          const user = verifyAuth(req);
          const userInfo = user
            ? `**Utilisateur:** <@${user.userId}> (${user.username} - ID: ${user.userId})`
            : `**Utilisateur:** Non connecté / Inconnu`;

          const ownerId = process.env.DISCORD_CLIENT_OWNER_ID;
          if (!ownerId) {
            logger.error('DISCORD_CLIENT_OWNER_ID non configuré. Impossible d\'envoyer le rapport d\'erreur.');
            json(res, 500, { error: 'DISCORD_CLIENT_OWNER_ID non configuré' });
            return;
          }

          const owner = await client.users.fetch(ownerId).catch(() => null);
          if (!owner) {
            logger.error(`Impossible de trouver l'owner avec l'ID ${ownerId}`);
            json(res, 500, { error: 'Owner introuvable' });
            return;
          }

          // Format embed for Discord DM
          const embed = new EmbedBuilder()
            .setTitle('🚨 Rapport d\'erreur du Dashboard')
            .setColor(0xFF0000)
            .setTimestamp()
            .addFields(
              { name: '👤 Utilisateur', value: userInfo },
              { name: '🌐 Page / URL', value: `\`${payload.url}\`` },
              { name: '💻 Navigateur', value: `\`${payload.userAgent || 'Inconnu'}\`` },
              { name: '🏰 Serveur sélectionné (Guild ID)', value: `\`${payload.guildId || 'Aucun'}\`` },
              { name: '❌ Erreur', value: `\`\`\`\n${payload.error}\n\`\`\`` }
            );

          if (payload.stack) {
            const truncatedStack = payload.stack.length > 1000 
              ? payload.stack.slice(0, 1000) + '...' 
              : payload.stack;
            embed.addFields({ name: '🥞 Stack Trace', value: `\`\`\`javascript\n${truncatedStack}\n\`\`\`` });
          }

          await owner.send({ embeds: [embed] });
          json(res, 200, { success: true });
        } catch (err: any) {
          logger.error('ReportError', `Erreur lors de la transmission du rapport d'erreur: ${err.message}`);
          json(res, 500, { error: 'Erreur lors de la transmission' });
        }
        return;
      }

      if (parts.length >= 2 && parts[0] === 'api' && parts[1] === 'user') {
        const user = verifyAuth(req);
        if (!user) {
          json(res, 401, { error: 'Non authentifié' });
          return;
        }

        if (parts[2] === 'me') {
          const authHeader = req.headers.authorization;
          const token = authHeader!.split(' ')[1];
          const decoded = jwt.decode(token) as any;
          const isBotAdmin = await resolveAdminAccess(client, decoded.userId);
          json(res, 200, { id: decoded.userId, username: decoded.username, avatar: decoded.avatar, isBotAdmin });
          return;
        }

        if (parts[2] === 'guilds') {
          try {
            const authHeader = req.headers.authorization;
            const token = authHeader?.split(' ')[1];
            if (!token) {
              json(res, 401, { error: 'Token manquant' });
              return;
            }

            const decoded = jwt.decode(token) as any;
            if (!decoded?.discordToken) {
              json(res, 400, { error: 'Token Discord manquant dans le JWT' });
              return;
            }

            // Fetch user guilds from Discord
            const guildsResponse = await fetch('https://discord.com/api/users/@me/guilds', {
              headers: { Authorization: `Bearer ${decoded.discordToken}` },
            });

            if (!guildsResponse.ok) {
              const status = guildsResponse.status;
              const errorText = await guildsResponse.text();
              logger.error('API', `Discord API error (${status}): ${errorText}`);
              json(res, status === 401 ? 401 : 500, { error: 'Erreur lors de la récupération des serveurs depuis Discord' });
              return;
            }

            const userGuilds = await guildsResponse.json() as any[];
            if (!Array.isArray(userGuilds)) {
              logger.error('API', 'Discord did not return an array of guilds', userGuilds);
              json(res, 500, { error: 'Réponse Discord invalide' });
              return;
            }

            const userGuildPermissions = new Map<string, bigint>();
            const userGuildsById = new Map<string, any>();

            for (const guild of userGuilds) {
              userGuildsById.set(guild.id, guild);
              if (guild.permissions === undefined || guild.permissions === null) continue;
              try {
                userGuildPermissions.set(guild.id, BigInt(guild.permissions));
              } catch {
                // Ignore malformed permission values coming from Discord API.
              }
            }

            const isGlobalAdmin = await resolveAdminAccess(client, user.userId);
            const accessibleGuildsList: Array<{
              id: string;
              name: string;
              icon: string | null;
              owner: boolean;
              botPresent: boolean;
              accessLevel: Exclude<DashboardAccessLevel, 'none'>;
            }> = [];

            for (const botGuild of client.guilds.cache.values()) {
              const guildId = botGuild.id;
              const isMember = userGuildsById.has(guildId);
              if (!isMember && !isGlobalAdmin) continue; // For non-global admins, user must be in the guild on Discord

              // Check activation status: if not activated, only owner/global admins can access
              const activated = isGuildActivated(guildId);
              if (!activated && !isGlobalAdmin) continue;

              const perms = userGuildPermissions.get(guildId) ?? BigInt(0);
              const isAdmin = hasDashboardAdminPermission(perms);
              
              let hasAccess = isGlobalAdmin || isAdmin;
              let accessLevel: Exclude<DashboardAccessLevel, 'none'> = (isGlobalAdmin || isAdmin) ? 'admin' : 'moderator';

              if (!hasAccess) {
                try {
                  const access = await resolveDashboardAccess(
                    client,
                    guildId,
                    user.userId,
                    perms,
                  );
                  if (access.canViewDashboard) {
                    hasAccess = true;
                    accessLevel = access.level === 'admin' ? 'admin' : 'moderator';
                  }
                } catch (err) {
                  logger.warn('DashboardAPI', `Failed to resolve access for guild ${guildId}:`, err);
                }
              }

              if (hasAccess) {
                const sourceGuild = userGuildsById.get(guildId);
                accessibleGuildsList.push({
                  id: guildId,
                  name: sourceGuild?.name ?? botGuild.name ?? guildId,
                  icon: sourceGuild ? (sourceGuild.icon ?? null) : (botGuild.icon ?? null),
                  owner: sourceGuild ? !!sourceGuild.owner : false,
                  botPresent: true,
                  accessLevel
                });
              }
            }

            const payload = accessibleGuildsList.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'fr'));
            json(res, 200, { guilds: payload });
          } catch (err) {
            logger.error('API', 'Unexpected error in /api/user/guilds:', err);
            json(res, 500, { error: 'Une erreur interne est survenue' });
          }
          return;
        }
      }


      if (parts.length >= 2 && parts[0] === 'api' && parts[1] === 'admin') {
        const user = verifyAuth(req);
        if (!user) {
          json(res, 401, { error: 'Non authentifié' });
          return;
        }

        const isBotAdmin = await resolveAdminAccess(client, user.userId);
        if (!isBotAdmin) {
          json(res, 403, { error: 'Accès administrateur requis' });
          return;
        }

        if (parts[2] === 'stats') {
          const guildCount = client.guilds.cache.size;
          const userCount = client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0);
          const activeSanctions = await prisma.sanction.count({ where: { status: 'ACTIVE' } });
          const dailyAlgoSubmissions = await prisma.dailyAlgoSubmission.count();

          json(res, 200, {
            guildCount,
            userCount,
            activeSanctions,
            dailyAlgoSubmissions,
            uptime: Math.floor(process.uptime()),
            memoryUsage: process.memoryUsage(),
          });
          return;
        }

        if (parts[2] === 'guilds' && parts.length === 3) {
          const dbGuilds = await prisma.guild.findMany({
            select: {
              id: true,
              activated: true,
              activationCode: true,
            }
          });
          const dbGuildsMap = new Map(dbGuilds.map(g => [g.id, g]));

          const guilds = client.guilds.cache.map(g => {
            const dbGuild = dbGuildsMap.get(g.id);
            return {
              id: g.id,
              name: g.name,
              icon: g.iconURL(),
              memberCount: g.memberCount,
              joinedAt: g.joinedAt,
              activated: dbGuild?.activated ?? false,
              activationCode: dbGuild?.activationCode ?? null,
            };
          });

          json(res, 200, { guilds });
          return;
        }

        if (parts[2] === 'guilds' && parts.length === 5) {
          const guildId = parts[3];
          const guild = client.guilds.cache.get(guildId);
          if (!guild) {
            json(res, 404, { error: 'Serveur introuvable' });
            return;
          }

          if (parts[4] === 'invite' && req.method === 'POST') {
            const channel = guild.channels.cache.find(c => c.type === 0 && c.permissionsFor(guild.members.me!)?.has('CreateInstantInvite'));
            if (!channel) {
              json(res, 400, { error: 'Impossible de créer une invitation (pas de salon textuel ou pas la permission)' });
              return;
            }
            try {
              const invite = await (channel as TextChannel).createInvite({ maxAge: 86400, maxUses: 1 });
              json(res, 200, { url: invite.url });
            } catch (err) {
              json(res, 500, { error: 'Erreur lors de la création de l\'invitation' });
            }
            return;
          }

          if (parts[4] === 'leave' && req.method === 'POST') {
            try {
              await guild.leave();
              json(res, 200, { success: true });
            } catch (err) {
              json(res, 500, { error: 'Impossible de quitter le serveur' });
            }
            return;
          }
        }

        if (parts[2] === 'admins') {
          if (req.method === 'GET' && parts.length === 3) {
            const admins = await prisma.globalAdmin.findMany({
              orderBy: { createdAt: 'desc' }
            });
            const enrichedAdmins = await Promise.all(admins.map(async (admin) => {
              try {
                const discordUser = await client.users.fetch(admin.userId);
                return { ...admin, username: discordUser.username, avatarUrl: discordUser.displayAvatarURL() };
              } catch {
                return { ...admin, username: 'Inconnu', avatarUrl: null };
              }
            }));
            json(res, 200, { admins: enrichedAdmins });
            return;
          }

          if (req.method === 'POST' && parts.length === 3) {
             const body = await readJsonBody<{userId: string}>(req);
             if (!body || !body.userId) {
               json(res, 400, { error: 'ID Discord requis' }); 
               return;
             }
             try {
                const discordUser = await client.users.fetch(body.userId);
                if (!discordUser) throw new Error();
                await prisma.globalAdmin.upsert({
                  where: { userId: body.userId },
                  update: {},
                  create: { userId: body.userId, addedBy: user.userId }
                });
                json(res, 201, { success: true });
             } catch {
                json(res, 400, { error: 'Utilisateur Discord introuvable' });
             }
             return;
          }

          if (req.method === 'DELETE' && parts.length === 4) {
             const targetId = parts[3];
             if (targetId === '457275321171968000') {
               json(res, 403, { error: 'Impossible de supprimer le créateur' }); 
               return;
             }
             await prisma.globalAdmin.delete({ where: { userId: targetId } }).catch(() => {});
             json(res, 200, { success: true });
             return;
          }
        }

        if (parts[2] === 'blacklist') {
          if (req.method === 'GET') {
            const blacklist = await prisma.globalBlacklist.findMany({
              orderBy: { createdAt: 'desc' }
            });
            const enriched = await Promise.all(blacklist.map(async (entry) => {
              try {
                const discordUser = await client.users.fetch(entry.userId);
                return { ...entry, username: discordUser.username, avatarUrl: discordUser.displayAvatarURL() };
              } catch {
                return { ...entry, username: 'Inconnu', avatarUrl: null };
              }
            }));
            json(res, 200, { blacklist: enriched });
            return;
          }

          if (req.method === 'POST') {
             const body = await readJsonBody<{userId: string, reason?: string}>(req);
             if (!body || !body.userId) {
               json(res, 400, { error: 'ID Discord requis' }); return;
             }
             try {
                const discordUser = await client.users.fetch(body.userId);
                if (!discordUser) throw new Error();
                await prisma.globalBlacklist.upsert({
                  where: { userId: body.userId },
                  update: { reason: body.reason },
                  create: { userId: body.userId, reason: body.reason, addedBy: user.userId }
                });

                const blacklist: Set<string> = (global as any).KOTBO_BLACKLIST || new Set();
                blacklist.add(body.userId);
                (global as any).KOTBO_BLACKLIST = blacklist;

                json(res, 201, { success: true });
             } catch (err) {
                logger.error('AdminAPI', 'Error adding to blacklist:', err);
                json(res, 400, { error: 'Utilisateur Discord introuvable' });
             }
             return;
          }

          if (req.method === 'DELETE' && parts.length === 4) {
             const targetId = parts[3];
             await prisma.globalBlacklist.delete({ where: { userId: targetId } }).catch(() => {});
             
             // Update memory cache
             const blacklist: Set<string> = (global as any).KOTBO_BLACKLIST;
             if (blacklist) {
               blacklist.delete(targetId);
             }

             json(res, 200, { success: true });
             return;
          }
        }

        if (parts[2] === 'banned-words') {
          if (req.method === 'GET' && parts.length === 3) {
            const words = await prisma.bannedWord.findMany({
              where: { guildId: null },
              orderBy: [{ word: 'asc' }],
            });
            json(res, 200, { words });
            return;
          }

          if (req.method === 'POST' && parts.length === 3) {
            const body = await readJsonBody<{ words?: Array<{ word: string; category?: string; enabled?: boolean }> }>(req);
            const entries = Array.isArray(body?.words) ? body.words : [];

            if (entries.length === 0) {
              json(res, 400, { error: 'Aucun mot à enregistrer' });
              return;
            }

            const seen = new Map<string, { word: string; category: string; enabled: boolean }>();
            for (const entry of entries) {
              const word = normalizeGlobalBannedWord(entry?.word);
              if (!word) continue;
              seen.set(word, {
                word,
                category: normalizeGlobalBannedWordCategory(entry?.category),
                enabled: typeof entry?.enabled === 'boolean' ? entry.enabled : true,
              });
            }

            if (seen.size === 0) {
              json(res, 400, { error: 'Aucun mot valide à enregistrer' });
              return;
            }

            const created: any[] = [];
            const updated: any[] = [];

            for (const entry of seen.values()) {
              const existing = await prisma.bannedWord.findFirst({ where: { guildId: null, word: entry.word } });
              if (existing) {
                const next = await prisma.bannedWord.update({
                  where: { id: existing.id },
                  data: { category: entry.category, enabled: entry.enabled },
                });
                updated.push(next);
              } else {
                const next = await prisma.bannedWord.create({
                  data: {
                    guildId: null,
                    word: entry.word,
                    category: entry.category,
                    enabled: entry.enabled,
                  },
                });
                created.push(next);
              }
            }

            const words = await prisma.bannedWord.findMany({
              where: { guildId: null },
              orderBy: [{ word: 'asc' }],
            });

            json(res, 200, {
              ok: true,
              createdCount: created.length,
              updatedCount: updated.length,
              words,
            });
            return;
          }

          if (req.method === 'POST' && parts.length === 4 && parts[3] === 'cleanup') {
            try {
              const result = await cleanupGlobalBannedWords();
              json(res, 200, { ok: true, ...result });
            } catch (err) {
              logger.error('BannedWordsAPI', 'POST banned-words cleanup error:', err);
              json(res, 500, { error: 'Erreur lors du nettoyage des mots globaux' });
            }
            return;
          }

          if (parts.length === 4) {
            const wordId = parts[3];

            if (req.method === 'PATCH') {
              const body = await readJsonBody<{ enabled?: boolean; word?: string; category?: string }>(req);
              const hasEnabled = typeof body?.enabled === 'boolean';
              const hasWord = typeof body?.word === 'string';
              const hasCategory = typeof body?.category === 'string';

              if (!hasEnabled && !hasWord && !hasCategory) {
                json(res, 400, { error: 'Au moins un champ doit être fourni' });
                return;
              }

              try {
                const existing = await prisma.bannedWord.findFirst({ where: { id: wordId, guildId: null } });
                if (!existing) {
                  json(res, 404, { error: 'Mot global introuvable' });
                  return;
                }

                const nextWord = hasWord ? normalizeGlobalBannedWord(body.word) : existing.word;
                const nextCategory = hasCategory ? normalizeGlobalBannedWordCategory(body.category) : existing.category;
                const nextEnabled = hasEnabled ? body.enabled : existing.enabled;

                if (!nextWord) {
                  json(res, 400, { error: 'Le mot ne peut pas être vide' });
                  return;
                }

                const duplicate = await prisma.bannedWord.findFirst({
                  where: {
                    guildId: null,
                    word: nextWord,
                    NOT: { id: wordId },
                  },
                });

                if (duplicate) {
                  json(res, 409, { error: 'Ce mot global existe déjà' });
                  return;
                }

                const updated = await prisma.bannedWord.update({
                  where: { id: wordId },
                  data: { word: nextWord, category: nextCategory, enabled: nextEnabled },
                });

                json(res, 200, { ok: true, word: updated });
              } catch (err) {
                logger.error('BannedWordsAPI', 'PATCH global banned-word error:', err);
                json(res, 500, { error: 'Erreur lors de la mise à jour' });
              }
              return;
            }

            if (req.method === 'DELETE') {
              try {
                const existing = await prisma.bannedWord.findFirst({ where: { id: wordId, guildId: null } });
                if (!existing) {
                  json(res, 404, { error: 'Mot global introuvable' });
                  return;
                }

                await prisma.bannedWord.delete({ where: { id: wordId } });
                json(res, 200, { ok: true });
              } catch (err) {
                logger.error('BannedWordsAPI', 'DELETE global banned-word error:', err);
                json(res, 500, { error: 'Erreur lors de la suppression' });
              }
              return;
            }
          }

          json(res, 405, { error: 'Méthode non autorisée' });
          return;
        }

        if (parts[2] === 'config') {
          if (req.method === 'GET') {
             const config = await prisma.botGlobalConfig.findUnique({ where: { key: 'MAINTENANCE_MODE' } });
             json(res, 200, { maintenance: config?.value === 'true' });
             return;
          }

          if (req.method === 'POST') {
             const body = await readJsonBody<{maintenance: boolean}>(req);
             if (!body || typeof body.maintenance !== 'boolean') {
               json(res, 400, { error: 'Valeur maintenance (boolean) requise' }); return;
             }
             await prisma.botGlobalConfig.upsert({
               where: { key: 'MAINTENANCE_MODE' },
               update: { value: body.maintenance ? 'true' : 'false' },
               create: { key: 'MAINTENANCE_MODE', value: body.maintenance ? 'true' : 'false' }
             });
             // Mettre à jour en mémoire globale
             (global as any).KOTBO_MAINTENANCE_MODE = body.maintenance;
             json(res, 200, { success: true });
             return;
          }
        }

        if (parts[2] === 'errors') {
          if (req.method === 'GET') {
             const errors = await prisma.botErrorLog.findMany({
               orderBy: { createdAt: 'desc' },
               take: 50
             });
             json(res, 200, { errors });
             return;
          }

          if (req.method === 'DELETE') {
             await prisma.botErrorLog.deleteMany({});
             json(res, 200, { success: true });
             return;
          }
        }

        if (parts[2] === 'broadcast' && req.method === 'POST') {
          const body = await readJsonBody<{message: string}>(req);
          if (!body || !body.message) {
            json(res, 400, { error: 'Message requis' }); return;
          }
          
          let successCount = 0;
          let failCount = 0;
          
          const guilds = client.guilds.cache;
          for (const [id, guild] of guilds) {
            try {
              const dbGuild = await prisma.guild.findUnique({ where: { id } });
              let targetChannelId = dbGuild?.newsChannelId || dbGuild?.publicChannelId;
              
              let channel;
              if (targetChannelId) {
                channel = guild.channels.cache.get(targetChannelId);
              }
              
              if (!channel || channel.type !== 0) {
                channel = guild.channels.cache.find(c => c.type === 0 && c.permissionsFor(client.user!)?.has('SendMessages'));
              }
              
              if (channel && channel.isTextBased()) {
                const embed = new EmbedBuilder()
                  .setTitle('📢 Annonce Globale Kotbo')
                  .setDescription(body.message)
                  .setColor(COLORS.primary)
                  .setFooter({ text: 'Système d\'annonce globale' })
                  .setTimestamp();
                await channel.send({ embeds: [embed] });
                successCount++;
              } else {
                failCount++;
              }
            } catch {
              failCount++;
            }
          }
          
          json(res, 200, { success: true, successCount, failCount });
          return;
        }
      }

      if (parts.length >= 2 && parts[0] === 'api' && parts[1] === 'admin') {
        const user = verifyAuth(req);
        if (!user) {
          json(res, 401, { error: 'Non authentifié' });
          return;
        }

        const isGlobalAdmin = await resolveAdminAccess(client, user.userId);
        if (!isGlobalAdmin) {
          json(res, 403, { error: 'Accès réservé aux administrateurs globaux Kotbo.' });
          return;
        }

        // GET /api/admin/activation-codes - List all activation codes
        if (parts.length === 3 && parts[2] === 'activation-codes' && req.method === 'GET') {
          try {
            const codes = await prisma.activationCode.findMany({
              orderBy: { createdAt: 'desc' }
            });
            const enrichedCodes = await Promise.all(codes.map(async (c) => {
              let guildName = null;
              if (c.usedByGuildId) {
                guildName = getGuildName(client, c.usedByGuildId);
              }
              return {
                ...c,
                guildName
              };
            }));
            json(res, 200, enrichedCodes);
          } catch (err) {
            logger.error('AdminAPI', 'Erreur lors de la récupération des codes :', err);
            json(res, 500, { error: 'Erreur lors de la récupération des codes d\'activation.' });
          }
          return;
        }

        // POST /api/admin/activation-codes - Generate a new activation code
        if (parts.length === 3 && parts[2] === 'activation-codes' && req.method === 'POST') {
          try {
            const code = `KB-${Math.random().toString(36).substring(2, 6).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
            
            const newCode = await prisma.activationCode.create({
              data: {
                code,
                createdById: user.userId,
                isActive: true
              }
            });

            json(res, 201, newCode);
          } catch (err) {
            logger.error('AdminAPI', 'Erreur lors de la création d\'un code :', err);
            json(res, 500, { error: 'Erreur lors de la création du code d\'activation.' });
          }
          return;
        }

        // DELETE /api/admin/activation-codes/:id - Delete an activation code (and deactivate the guild if used)
        if (parts.length === 4 && parts[2] === 'activation-codes' && req.method === 'DELETE') {
          const codeId = parts[3];
          try {
            const codeRow = await prisma.activationCode.findUnique({
              where: { id: codeId }
            });

            if (!codeRow) {
              json(res, 404, { error: 'Code introuvable.' });
              return;
            }

            if (codeRow.usedByGuildId) {
              await deactivateGuild(codeRow.usedByGuildId);
            }

            await prisma.activationCode.delete({
              where: { id: codeId }
            });

            json(res, 200, { ok: true });
          } catch (err) {
            logger.error('AdminAPI', 'Erreur lors de la suppression du code :', err);
            json(res, 500, { error: 'Erreur lors de la suppression du code d\'activation.' });
          }
          return;
        }

        // POST /api/admin/guilds/:guildId/deactivate - Deactivate a guild
        if (parts.length === 5 && parts[2] === 'guilds' && parts[4] === 'deactivate' && req.method === 'POST') {
          const guildId = parts[3];
          try {
            await deactivateGuild(guildId);
            json(res, 200, { ok: true, message: 'Le serveur a été désactivé.' });
          } catch (err) {
            logger.error('AdminAPI', 'Erreur lors de la désactivation du serveur :', err);
            json(res, 500, { error: 'Erreur lors de la désactivation du serveur.' });
          }
          return;
        }

        // POST /api/admin/guilds/:guildId/activate-auto - Autogenerate and assign an activation code
        if (parts.length === 5 && parts[2] === 'guilds' && parts[4] === 'activate-auto' && req.method === 'POST') {
          const guildId = parts[3];
          try {
            const code = `KB-${Math.random().toString(36).substring(2, 6).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;

            await prisma.activationCode.create({
              data: {
                code,
                createdById: user.userId,
                isActive: true
              }
            });

            await activateGuild(guildId, code);

            json(res, 200, { ok: true, code, message: 'Le serveur a été activé automatiquement.' });
          } catch (err) {
            logger.error('AdminAPI', 'Erreur lors de la génération et affectation du code :', err);
            json(res, 500, { error: 'Erreur lors de l\'activation automatique du serveur.' });
          }
          return;
        }
      }

      if (parts.length >= 2 && parts[0] === 'api' && parts[1] === 'dashboard') {
        if (parts.length === 6 && parts[2] === 'guilds' && parts[4] === 'recruitment' && parts[5] === 'candidatures' && req.method === 'POST') {
          const guildId = parts[3];
          const webhookAuth = await verifyRecruitmentWebhookAuth(req, guildId);
          const webhookUser = webhookAuth.auth;
          if (!webhookUser) {
            logger.warn('RecruitmentAPI', `Webhook auth failed for guild ${guildId}: ${webhookAuth.reason}`);
            json(res, 401, { error: 'Non authentifié', reason: webhookAuth.reason });
            return;
          }

          try {
            const body = await readJsonBody<Record<string, unknown>>(req);
            const payload = body && typeof body === 'object' && 'data' in body
              ? ((body.data as Record<string, unknown>) ?? body)
              : (body ?? {});

            const result = await createCandidature(guildId, payload, {
              autoRejectEnabled: isRecruitmentAutoRejectEnabled(guildId),
            });
            json(res, 201, result);
          } catch (err) {
            logger.error('RecruitmentAPI', 'Error creating candidature:', err);
            json(res, 500, { error: 'Erreur lors de la création de la candidature' });
          }
          return;
        }

        const user = verifyAuth(req);
        if (!user) {
          json(res, 401, { error: 'Non authentifié' });
          return;
        }
        const auditUser = getAuditActor(user);

        if (parts[2] === 'translate' && req.method === 'POST') {
          const body = await readJsonBody<{ text: string; targetLang?: string }>(req);
          if (!body?.text) {
            json(res, 400, { error: 'Texte à traduire requis' });
            return;
          }
          const translatedText = await translate(body.text, body.targetLang || 'fr');
          json(res, 200, { translatedText });
          return;
        }

        if (parts.length === 3 && parts[2] === 'guilds' && req.method === 'GET') {
          const guilds = await prisma.guild.findMany({
            orderBy: { updatedAt: 'desc' },
            select: { id: true, updatedAt: true }
          });

          const payload: Array<{
            id: string;
            name: string;
            updatedAt: string;
            accessLevel: Exclude<DashboardAccessLevel, 'none'>;
            activated: boolean;
          }> = [];

          const isGlobalAdmin = await resolveAdminAccess(client, user.userId);
          for (const guild of guilds) {
            const activated = isGuildActivated(guild.id);
            if (!activated && !isGlobalAdmin) continue;

            const access = await resolveDashboardAccess(client, guild.id, user.userId);
            if (!access.canViewDashboard) continue;

            payload.push({
              id: guild.id,
              name: getGuildName(client, guild.id),
              updatedAt: guild.updatedAt.toISOString(),
              accessLevel: access.level === 'admin' ? 'admin' : 'moderator',
              activated: activated
            });
          }

          json(res, 200, { guilds: payload });
          return;
        }

        if (parts.length >= 4 && parts[2] === 'guilds') {
          const guildId = parts[3];
          const access = await resolveDashboardAccess(client, guildId, user.userId);

          if (!access.canViewDashboard) {
            json(res, 403, { error: 'Accès refusé au dashboard pour ce serveur.' });
            return;
          }

          // Gating check for guild activation (bypassed for owner and global admins)
          const isGlobalAdmin = await resolveAdminAccess(client, user.userId);
          const isActivationRequest = parts.length === 5 && parts[4] === 'activate' && req.method === 'POST';
          if (!isGuildActivated(guildId) && !isActivationRequest && !isGlobalAdmin) {
            json(res, 403, { error: 'Activation requise', needsActivation: true });
            return;
          }


          const isSanctionAction = parts.length === 6
            && parts[4] === 'sanctions'
            && parts[5] === 'reports'
            && req.method === 'POST';

          const isDailyAlgoReviewAction = parts.length === 6
            && parts[4] === 'daily-algo-submissions'
            && req.method === 'PATCH';

          const isStaffAbsenceAction = parts.length === 5
            && parts[4] === 'absences'
            && req.method === 'POST';

          const isMeetingAction = parts[4] === 'meetings'
            && (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE');

          const isNotificationAction = parts[4] === 'notifications';

          const isNewsAction = parts[4] === 'news'
            && (req.method === 'POST' || req.method === 'PATCH' || req.method === 'DELETE');

          if (!access.canManageSettings && req.method !== 'GET' && !isSanctionAction && !isDailyAlgoReviewAction && !isStaffAbsenceAction && !isNotificationAction && !isMeetingAction && !isNewsAction) {
            json(res, 403, { error: 'Action réservée aux administrateurs du dashboard.' });
            return;
          }


          if (isSanctionAction && !access.canModerateContent) {
            json(res, 403, { error: 'Action de rapport de sanction non autorisée.' });
            return;
          }

          if (isNewsAction && !access.canModerateContent) {
            json(res, 403, { error: 'Action de gestion des actualités non autorisée.' });
            return;
          }

          if (isDailyAlgoReviewAction && !access.canModerateDailyAlgo) {
            json(res, 403, { error: 'Action de modération Daily Algo non autorisée.' });
            return;
          }

          if (parts.length === 4 && req.method === 'GET') {
            const state = await getGuildState(client, guildId, access, user.userId);
            if (!state) {
              json(res, 404, { error: 'Guilde introuvable' });
              return;
            }
            json(res, 200, state);
            return;
          }

          // GET /api/dashboard/guilds/:guildId/state - Get guild state (alias for parts.length === 4)
          if (parts.length === 5 && parts[4] === 'state' && req.method === 'GET') {
            const state = await getGuildState(client, guildId, access, user.userId);
            if (!state) {
              json(res, 404, { error: 'Guilde introuvable' });
              return;
            }
            json(res, 200, state);
            return;
          }

          // POST /api/dashboard/guilds/:guildId/activate - Activate a guild with a code
          if (parts.length === 5 && parts[4] === 'activate' && req.method === 'POST') {
            const isGlobalAdmin = await resolveAdminAccess(client, user.userId);
            const canActivate = isGlobalAdmin || access.level === 'admin';
            if (!canActivate) {
              json(res, 403, { error: 'Seuls les administrateurs du serveur ou les administrateurs globaux peuvent activer ce serveur.' });
              return;
            }

            const body = await readJsonBody<{ code?: string }>(req);
            const rawCode = body?.code?.trim() || '';
            if (!rawCode) {
              json(res, 400, { error: 'Le code d\'activation est requis.' });
              return;
            }

            const codeRow = await prisma.activationCode.findUnique({
              where: { code: rawCode.toUpperCase() }
            });

            if (!codeRow) {
              json(res, 404, { error: 'Code d\'activation introuvable.' });
              return;
            }

            if (!codeRow.isActive || codeRow.usedAt) {
              json(res, 400, { error: 'Ce code d\'activation a déjà été utilisé ou est désactivé.' });
              return;
            }

            try {
              await activateGuild(guildId, rawCode);
              json(res, 200, { ok: true, message: 'Le serveur a été activé avec succès.' });
            } catch (err) {
              logger.error('ActivationAPI', 'Erreur lors de l\'activation de la guilde :', err);
              json(res, 500, { error: 'Erreur interne lors de l\'activation du serveur.' });
            }
            return;
          }

          // Linked Accounts Management
          if (parts[4] === 'linked-accounts') {
            const isAdmin = access.level === 'admin';
            const isStaff = isAdmin || access.level === 'moderator';

            if (!isStaff) {
              json(res, 403, { error: 'Accès refusé' });
              return;
            }

            // GET /api/dashboard/guilds/:guildId/linked-accounts
            if (req.method === 'GET') {
              try {
                const linkedAccounts = await prisma.linkedAccount.findMany({
                  where: { guildId },
                  orderBy: { createdAt: 'desc' },
                });

                // Enrich with member profiles
                const enriched = await Promise.all(linkedAccounts.map(async (acc) => {
                  const [p1, p2] = await Promise.all([
                    prisma.memberProfile.findUnique({ where: { guildId_userId: { guildId, userId: acc.user1Id } } }),
                    prisma.memberProfile.findUnique({ where: { guildId_userId: { guildId, userId: acc.user2Id } } }),
                  ]);
                  return {
                    ...acc,
                    user1: p1 ? { tag: p1.username, avatar: p1.avatarUrl } : { tag: acc.user1Id, avatar: null },
                    user2: p2 ? { tag: p2.username, avatar: p2.avatarUrl } : { tag: acc.user2Id, avatar: null },
                  };
                }));

                json(res, 200, enriched);
              } catch (err) {
                logger.error('LinkedAccountsAPI', 'Error fetching linked accounts:', err);
                json(res, 500, { error: 'Erreur lors de la récupération des comptes liés' });
              }
              return;
            }

            // PATCH /api/dashboard/guilds/:guildId/linked-accounts/:id
            if (parts.length === 6 && req.method === 'PATCH') {
              try {
                const id = parts[5];
                const body = await readJsonBody<{ status: 'VALIDATED' | 'REJECTED' }>(req);
                
                if (!body?.status) {
                  json(res, 400, { error: 'Statut requis' });
                  return;
                }

                const link = await prisma.linkedAccount.findUnique({
                  where: { id }
                });

                if (!link) {
                  json(res, 404, { error: 'Lien introuvable' });
                  return;
                }

                const updatedLink = await prisma.linkedAccount.update({
                  where: { id },
                  data: { status: body.status }
                });

                // If validated, send DM
                if (body.status === 'VALIDATED') {
                  const discordGuild = client.guilds.cache.get(guildId);
                  const dmEmbed = new EmbedBuilder()
                    .setColor(COLORS.success)
                    .setTitle('🔗 Comptes liés officiellement')
                    .setDescription(`Vos comptes **<@${link.user1Id}>** et **<@${link.user2Id}>** ont été reliés sur **${discordGuild?.name || 'le serveur'}**.`)
                    .setTimestamp();

                  try {
                    const member1 = await client.users.fetch(link.user1Id).catch(() => null);
                    if (member1) await member1.send({ embeds: [dmEmbed] }).catch(() => null);
                  } catch (e) {}

                  try {
                    const member2 = await client.users.fetch(link.user2Id).catch(() => null);
                    if (member2) await member2.send({ embeds: [dmEmbed] }).catch(() => null);
                  } catch (e) {}
                }

                json(res, 200, updatedLink);
              } catch (err) {
                logger.error('LinkedAccountsAPI', 'Error updating linked account:', err);
                json(res, 500, { error: 'Erreur lors de la mise à jour du compte lié' });
              }
              return;
            }

            // DELETE /api/dashboard/guilds/:guildId/linked-accounts/:id
            if (parts.length === 6 && req.method === 'DELETE') {
              try {
                const id = parts[5];
                const link = await prisma.linkedAccount.findUnique({
                  where: { id }
                });

                if (!link) {
                  json(res, 404, { error: 'Lien introuvable' });
                  return;
                }

                await prisma.linkedAccount.delete({
                  where: { id }
                });

                // Send DM
                const discordGuild = client.guilds.cache.get(guildId);
                const dmEmbed = new EmbedBuilder()
                  .setColor(COLORS.error)
                  .setTitle('🔗 Comptes déliés')
                  .setDescription(`Vos comptes **<@${link.user1Id}>** et **<@${link.user2Id}>** ont été séparés sur **${discordGuild?.name || 'le serveur'}**.`)
                  .setTimestamp();

                try {
                  const member1 = await client.users.fetch(link.user1Id).catch(() => null);
                  if (member1) await member1.send({ embeds: [dmEmbed] }).catch(() => null);
                } catch (e) {}

                try {
                  const member2 = await client.users.fetch(link.user2Id).catch(() => null);
                  if (member2) await member2.send({ embeds: [dmEmbed] }).catch(() => null);
                } catch (e) {}

                json(res, 200, { success: true });
              } catch (err) {
                logger.error('LinkedAccountsAPI', 'Error deleting linked account:', err);
                json(res, 500, { error: 'Erreur lors de la suppression du compte lié' });
              }
              return;
            }
          }

          // ── TICKET SYSTEM API ENDPOINTS ──────────────────────────────────────
          if (parts[4] === 'tickets') {
            const isStaff = access.level === 'admin' || access.level === 'moderator';
            if (!isStaff) {
              json(res, 403, { error: 'Accès refusé. Réservé au staff.' });
              return;
            }

            // GET /api/dashboard/guilds/:guildId/tickets/config
            if (parts.length === 6 && parts[5] === 'config' && req.method === 'GET') {
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
                  ticketAllowOverclaim: true,
                  ticketOverclaimPermission: true,
                }
              });
              json(res, 200, guildConfig || {});
              return;
            }

            // GET /api/dashboard/guilds/:guildId/tickets/transcripts
            if (parts.length === 6 && parts[5] === 'transcripts' && req.method === 'GET') {
              try {
                const transcripts = await prisma.transcript.findMany({
                  where: { guildId },
                  orderBy: { createdAt: 'desc' },
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
                });
                json(res, 200, { transcripts });
              } catch (err: any) {
                logger.error('TicketsAPI', `Error listing transcripts: ${err.message}`);
                json(res, 500, { error: 'Erreur lors de la récupération des transcriptions' });
              }
              return;
            }

            // PATCH /api/dashboard/guilds/:guildId/tickets/config
            if (parts.length === 6 && parts[5] === 'config' && req.method === 'PATCH') {
              if (access.level !== 'admin') {
                json(res, 403, { error: 'Seuls les administrateurs peuvent modifier la configuration.' });
                return;
              }

              try {
                const body = await readJsonBody<any>(req);
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
                    ticketAllowOverclaim: body.ticketAllowOverclaim ?? true,
                    ticketOverclaimPermission: body.ticketOverclaimPermission || 'ANY',
                  }
                });

                json(res, 200, { success: true, config: updated });
              } catch (err: any) {
                logger.error('TicketsAPI', `Error updating ticket config: ${err.message}`);
                json(res, 500, { error: 'Erreur lors de la mise à jour de la configuration' });
              }
              return;
            }

            // POST /api/dashboard/guilds/:guildId/tickets/config/send-embed
            if (parts.length === 7 && parts[5] === 'config' && parts[6] === 'send-embed' && req.method === 'POST') {
              if (access.level !== 'admin') {
                json(res, 403, { error: 'Seuls les administrateurs peuvent envoyer le panel.' });
                return;
              }

              try {
                const { sendTicketSetupEmbed } = await import('../services/ticketService.js');
                await sendTicketSetupEmbed(client, guildId);
                json(res, 200, { success: true });
              } catch (err: any) {
                logger.error('TicketsAPI', `Error sending ticket setup embed: ${err.message}`);
                json(res, 500, { error: err.message || 'Erreur lors de l\'envoi de l\'embed' });
              }
              return;
            }

            // GET /api/dashboard/guilds/:guildId/tickets
            if (parts.length === 5 && req.method === 'GET') {
              try {
                const tickets = await prisma.ticket.findMany({
                  where: { guildId },
                  orderBy: { createdAt: 'desc' },
                });
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
                    ticketAllowOverclaim: true,
                    ticketOverclaimPermission: true,
                  }
                });
                json(res, 200, { tickets, config: guildConfig || {} });
              } catch (err: any) {
                logger.error('TicketsAPI', `Error listing tickets: ${err.message}`);
                json(res, 500, { error: 'Erreur lors de la récupération des tickets' });
              }
              return;
            }

            // GET /api/dashboard/guilds/:guildId/tickets/:ticketId
            if (parts.length === 6 && req.method === 'GET') {
              const ticketId = parts[5];
              try {
                const ticket = await prisma.ticket.findUnique({
                  where: { id: ticketId }
                });

                if (!ticket) {
                  json(res, 404, { error: 'Ticket introuvable' });
                  return;
                }

                let messages: any[] = [];
                if (ticket.channelId) {
                  const discordChannel = client.channels.cache.get(ticket.channelId);
                  if (discordChannel && discordChannel instanceof TextChannel) {
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
                        embeds: m.embeds.map(e => ({
                          title: e.title,
                          description: e.description,
                          htmlDescription: e.description ? parseDiscordMarkdown(e.description, guild) : '',
                          color: e.hexColor,
                          fields: e.fields ? e.fields.map(f => ({
                            name: f.name,
                            value: f.value,
                            htmlValue: f.value ? parseDiscordMarkdown(f.value, guild) : ''
                          })) : [],
                          image: e.image ? { url: e.image.url } : null,
                          thumbnail: e.thumbnail ? { url: e.thumbnail.url } : null,
                          video: e.video ? { url: e.video.url } : null
                        })),
                        createdAt: m.createdAt.toISOString()
                      }));
                      messages.reverse();
                    } catch (fetchErr) {}
                  }
                }

                json(res, 200, { ticket, messages });
              } catch (err: any) {
                logger.error('TicketsAPI', `Error reading ticket details: ${err.stack}`);
                json(res, 500, { error: `Erreur lors de la récupération du ticket: ${err.stack}` });
              }
              return;
            }

            // POST /api/dashboard/guilds/:guildId/tickets/:ticketId/message
            if (parts.length === 7 && parts[6] === 'message' && req.method === 'POST') {
              const ticketId = parts[5];
              try {
                const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
                if (!ticket || !ticket.channelId) {
                  json(res, 404, { error: 'Ticket introuvable ou salon inactif' });
                  return;
                }

                const body = await readJsonBody<{ content: string }>(req);
                if (!body?.content) {
                  json(res, 400, { error: 'Contenu du message requis' });
                  return;
                }

                const discordChannel = client.channels.cache.get(ticket.channelId);
                if (!discordChannel || !(discordChannel instanceof TextChannel)) {
                  json(res, 400, { error: 'Salon Discord introuvable' });
                  return;
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
              } catch (err: any) {
                logger.error('TicketsAPI', `Error sending message to ticket: ${err.message}`);
                json(res, 500, { error: 'Erreur lors de l\'envoi du message' });
              }
              return;
            }

            // POST /api/dashboard/guilds/:guildId/tickets/:ticketId/claim
            if (parts.length === 7 && parts[6] === 'claim' && req.method === 'POST') {
              const ticketId = parts[5];
              try {
                const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
                if (!ticket) {
                  json(res, 404, { error: 'Ticket introuvable' });
                  return;
                }

                const guildConfig = await prisma.guild.findUnique({ where: { id: guildId } });
                if (!guildConfig) {
                  json(res, 404, { error: 'Serveur introuvable' });
                  return;
                }

                const allowOverclaim = guildConfig.ticketAllowOverclaim ?? true;
                const overclaimPermission = guildConfig.ticketOverclaimPermission || 'ANY';

                if (ticket.status === 'CLAIMED') {
                  if (!allowOverclaim || overclaimPermission === 'NONE') {
                    json(res, 400, { error: `Ce ticket est déjà pris en charge par ${ticket.claimedByName || ticket.claimedById}.` });
                    return;
                  }

                  if (ticket.claimedById === user.userId) {
                    json(res, 400, { error: 'Vous prenez déjà en charge ce ticket.' });
                    return;
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
                        return;
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
                    // Update welcome message
                    try {
                      const welcomeMsg = (await ch.messages.fetch({ limit: 50 })).find(m => m.author.id === client.user?.id && m.embeds.length > 0 && m.embeds[0].title?.startsWith('🎫'));
                      if (welcomeMsg) {
                        const oldEmbed = welcomeMsg.embeds[0];
                        if (oldEmbed) {
                          const updatedEmbed = EmbedBuilder.from(oldEmbed)
                            .setColor(COLORS.warning as any)
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
              } catch (err: any) {
                logger.error('TicketsAPI', `Error claiming ticket: ${err.message}`);
                json(res, 500, { error: 'Erreur lors de la prise en charge du ticket' });
              }
              return;
            }

            // POST /api/dashboard/guilds/:guildId/tickets/:ticketId/close
            if (parts.length === 7 && parts[6] === 'close' && req.method === 'POST') {
              const ticketId = parts[5];
              try {
                const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
                if (!ticket) {
                  json(res, 404, { error: 'Ticket introuvable' });
                  return;
                }

                const updated = await prisma.ticket.update({
                  where: { id: ticketId },
                  data: {
                    status: 'CLOSED',
                    closedById: user.userId,
                    closedByName: user.username,
                    closedAt: new Date()
                  }
                });

                if (ticket.channelId) {
                  const ch = client.channels.cache.get(ticket.channelId);
                  if (ch && ch instanceof TextChannel) {
                    await ch.permissionOverwrites.edit(ticket.userId, {
                      ViewChannel: false,
                      SendMessages: false
                    }).catch(() => {});

                    const closeEmbed = new EmbedBuilder()
                      .setTitle('🔒 Ticket Fermé')
                      .setDescription(`Le ticket a été fermé depuis le Dashboard Kotbo par **${user.username}**.`)
                      .setColor(COLORS.danger as any)
                      .setTimestamp();

                    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                      new ButtonBuilder().setCustomId(`ticket:reopen:${ticketId}`).setLabel('Réouvrir').setStyle(ButtonStyle.Success).setEmoji('🔓'),
                      new ButtonBuilder().setCustomId(`ticket:delete:${ticketId}`).setLabel('Supprimer').setStyle(ButtonStyle.Danger).setEmoji('🗑️')
                    );

                    await ch.send({ embeds: [closeEmbed], components: [row] }).catch(() => {});
                  }
                }

                json(res, 200, updated);
              } catch (err: any) {
                logger.error('TicketsAPI', `Error closing ticket: ${err.message}`);
                json(res, 500, { error: 'Erreur' });
              }
              return;
            }

            // POST /api/dashboard/guilds/:guildId/tickets/:ticketId/reopen
            if (parts.length === 7 && parts[6] === 'reopen' && req.method === 'POST') {
              const ticketId = parts[5];
              try {
                const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
                if (!ticket) {
                  json(res, 404, { error: 'Ticket introuvable' });
                  return;
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

                    await ch.send({
                      embeds: [successEmbed('Ticket Réouvert', `Le ticket a été réouvert depuis le Dashboard Kotbo par **${user.username}**.`)]
                    }).catch(() => null);
                  }
                }

                json(res, 200, updated);
              } catch (err: any) {
                logger.error('TicketsAPI', `Error reopening ticket: ${err.message}`);
                json(res, 500, { error: 'Erreur' });
              }
              return;
            }

            // POST /api/dashboard/guilds/:guildId/tickets/:ticketId/delete
            if (parts.length === 7 && parts[6] === 'delete' && req.method === 'POST') {
              const ticketId = parts[5];
              try {
                const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
                if (!ticket) {
                  json(res, 404, { error: 'Ticket introuvable' });
                  return;
                }

                if (!ticket.channelId) {
                  json(res, 200, { success: true });
                  return;
                }

                const ch = client.channels.cache.get(ticket.channelId);
                if (ch && ch instanceof TextChannel) {
                  const { generateTranscript } = await import('../services/transcriptService.js');
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
                  const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';
                  const publicLink = `${dashboardUrl}/transcripts/${transcriptData.id}`;
                  
                  const usersToDm = new Set<string>();
                  if (ticket.userId) usersToDm.add(ticket.userId);
                  if (ticket.claimedById) usersToDm.add(ticket.claimedById);
                  if (ticket.closedById) usersToDm.add(ticket.closedById);
                  if (user.userId) usersToDm.add(user.userId);
                  
                  const dmEmbed = new EmbedBuilder()
                    .setTitle('📄 Transcription de ticket')
                    .setDescription(`Le ticket d'assistance **${ticket.reason}** du serveur **${guildConfig?.guildName || 'Kotbo'}** a été supprimé.\n\nVoici le lien pour consulter la transcription complète :`)
                    .addFields([{ name: 'Lien d\'accès', value: `🌐 [Consulter le transcript](${publicLink})` }])
                    .setColor('#5865F2')
                    .setTimestamp();
                    
                  for (const dmUserId of usersToDm) {
                    try {
                      const dmUser = await client.users.fetch(dmUserId);
                      if (dmUser) await dmUser.send({ embeds: [dmEmbed] });
                    } catch (err) {}
                  }

                  const executorUser = await client.users.fetch(user.userId).catch(() => null);
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
                      await logCh.send({ embeds: [logEmbed] }).catch(() => {});
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
              } catch (err: any) {
                logger.error('TicketsAPI', `Error deleting ticket: ${err.message}`);
                json(res, 500, { error: 'Erreur lors de la suppression' });
              }
              return;
            }
          }

          // GET /api/dashboard/guilds/:guildId/analytics - Full analytics data
          if (parts.length === 5 && parts[4] === 'analytics' && req.method === 'GET') {
            try {
              const periodDays = Math.min(90, Math.max(1, parseInt(url.searchParams.get('period') || '30', 10)));
              const now = new Date();
              const startDate = new Date(now);
              startDate.setDate(startDate.getDate() - periodDays);
              const startDateKey = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;

              let dailyStats: any[] = [];
              const granularity = url.searchParams.get('granularity');
              const use30Min = periodDays === 1 || granularity === '30';

              if (use30Min) {
                const hourlyStats = await prisma.guildHourlyStat.findMany({
                  where: { guildId },
                  orderBy: [
                    { dateKey: 'desc' },
                    { hour: 'desc' }
                  ],
                  take: 24
                });
                hourlyStats.reverse();
                
                for (const h of hourlyStats) {
                  const hourStr = String(h.hour).padStart(2, '0');
                  
                  // Bucket 1: :00
                  dailyStats.push({
                    dateKey: `${h.dateKey} ${hourStr}h00`,
                    messagesCount: Math.round(h.messagesCount / 2),
                    voiceMinutes: Math.round(h.voiceMinutes / 2),
                    voiceSessionsCount: 0,
                    membersJoined: Math.round(h.joinsCount / 2),
                    membersLeft: Math.round(h.leavesCount / 2),
                    totalMembers: 0,
                    onlineMembers: h.onlineMembers,
                    peakOnline: h.onlineMembers,
                    peakVoice: h.voiceMembers,
                    sanctionsCount: 0,
                  });
                  
                  // Bucket 2: :30
                  dailyStats.push({
                    dateKey: `${h.dateKey} ${hourStr}h30`,
                    messagesCount: Math.floor(h.messagesCount / 2),
                    voiceMinutes: Math.floor(h.voiceMinutes / 2),
                    voiceSessionsCount: 0,
                    membersJoined: Math.floor(h.joinsCount / 2),
                    membersLeft: Math.floor(h.leavesCount / 2),
                    totalMembers: 0,
                    onlineMembers: h.onlineMembers,
                    peakOnline: h.onlineMembers,
                    peakVoice: h.voiceMembers,
                    sanctionsCount: 0,
                  });
                }
              } else {
                dailyStats = await prisma.guildDailyStat.findMany({
                  where: { guildId, dateKey: { gte: startDateKey } },
                  orderBy: { dateKey: 'asc' },
                });
              }

              // 2. Channel daily stats (top channels)
              const channelStats = await prisma.channelDailyStat.groupBy({
                by: ['channelId'],
                where: { guildId, dateKey: { gte: startDateKey } },
                _sum: { messagesCount: true },
                orderBy: { _sum: { messagesCount: 'desc' } },
                take: 15,
              });

              const discordGuild = client.guilds.cache.get(guildId);
              const topChannels = channelStats.map(ch => {
                const discordChannel = discordGuild?.channels.cache.get(ch.channelId);
                return {
                  channelId: ch.channelId,
                  channelName: discordChannel?.name ?? `canal-${ch.channelId.slice(-4)}`,
                  messagesCount: ch._sum.messagesCount ?? 0,
                };
              });

              // 3. Top members by messages
              const topMessageMembers = await prisma.memberProfile.findMany({
                where: { guildId, isBot: false, messageCount: { gt: 0 } },
                orderBy: { messageCount: 'desc' },
                take: 15,
                select: {
                  userId: true, displayName: true, username: true, globalName: true,
                  avatarUrl: true, messageCount: true, lastMessageAt: true,
                },
              });

              // 4. Top members by voice time
              const topVoiceMembers = await prisma.memberProfile.findMany({
                where: { guildId, isBot: false, voiceTimeSeconds: { gt: 0 } },
                orderBy: { voiceTimeSeconds: 'desc' },
                take: 15,
                select: {
                  userId: true, displayName: true, username: true, globalName: true,
                  avatarUrl: true, voiceTimeSeconds: true, voiceSessionCount: true,
                },
              });

              // 5. Member growth stats
              const totalMembers = discordGuild?.memberCount ?? 0;
              const onlineNow = discordGuild?.members.cache.filter(m => m.presence?.status === 'online').size ?? 0;
              const idleNow = discordGuild?.members.cache.filter(m => m.presence?.status === 'idle').size ?? 0;
              const dndNow = discordGuild?.members.cache.filter(m => m.presence?.status === 'dnd').size ?? 0;
              const voiceNow = discordGuild?.members.cache.filter(m => !!m.voice?.channelId).size ?? 0;
              const botsCount = discordGuild?.members.cache.filter(m => m.user.bot).size ?? 0;

              // 6. Sanctions stats
              const sanctions = await prisma.sanction.findMany({
                where: { guildId, createdAt: { gte: startDate } },
                select: { type: true, status: true, moderatorUserId: true, moderatorTag: true, targetUserId: true, targetTag: true, createdAt: true },
              });

              const sanctionsByType = {
                WARN: sanctions.filter(s => s.type === 'WARN').length,
                KICK: sanctions.filter(s => s.type === 'KICK').length,
                TIMEOUT: sanctions.filter(s => s.type === 'TIMEOUT').length,
                TEMP_BAN: sanctions.filter(s => s.type === 'TEMP_BAN').length,
                BAN: sanctions.filter(s => s.type === 'BAN').length,
              };

              // Top moderators with avatars
              const modCounts = new Map<string, { count: number; tag: string }>();
              for (const s of sanctions) {
                const existing = modCounts.get(s.moderatorUserId) ?? { count: 0, tag: s.moderatorTag ?? 'Inconnu' };
                existing.count++;
                modCounts.set(s.moderatorUserId, existing);
              }
              const topModerators = await Promise.all(
                [...modCounts.entries()]
                  .sort((a, b) => b[1].count - a[1].count)
                  .slice(0, 10)
                  .map(async ([userId, data]) => {
                    const profile = await prisma.memberProfile.findUnique({
                      where: { guildId_userId: { guildId, userId } },
                      select: { avatarUrl: true },
                    });
                    return { userId, moderatorTag: data.tag, count: data.count, avatarUrl: profile?.avatarUrl };
                  })
              );

              // Most sanctioned members with avatars
              const targetCounts = new Map<string, { count: number; tag: string }>();
              for (const s of sanctions) {
                const existing = targetCounts.get(s.targetUserId) ?? { count: 0, tag: s.targetTag ?? 'Inconnu' };
                existing.count++;
                targetCounts.set(s.targetUserId, existing);
              }
              const mostSanctioned = await Promise.all(
                [...targetCounts.entries()]
                  .sort((a, b) => b[1].count - a[1].count)
                  .slice(0, 10)
                  .map(async ([userId, data]) => {
                    const profile = await prisma.memberProfile.findUnique({
                      where: { guildId_userId: { guildId, userId } },
                      select: { avatarUrl: true },
                    });
                    return { userId, tag: data.tag, count: data.count, avatarUrl: profile?.avatarUrl };
                  })
              );

              const activeSanctions = await prisma.sanction.count({ where: { guildId, status: 'ACTIVE' } });

              // 7. Staff activity
              const staffActivities = await prisma.staffActivity.findMany({
                where: { guildId, activityDate: { gte: startDate } },
                include: { staffMember: { select: { userId: true, displayName: true, username: true, avatarUrl: true, grade: true } } },
              });

              const staffAgg = new Map<string, { messages: number; voiceMinutes: number; name: string; grade: string; avatarUrl: string | null }>();
              for (const a of staffActivities) {
                const key = a.staffUserId;
                const existing = staffAgg.get(key) ?? { messages: 0, voiceMinutes: 0, name: a.staffMember.displayName ?? a.staffMember.username ?? 'Inconnu', grade: a.staffMember.grade, avatarUrl: a.staffMember.avatarUrl };
                existing.messages += a.messageCount;
                existing.voiceMinutes += a.voiceMinutes;
                staffAgg.set(key, existing);
              }
              const staffLeaderboard = [...staffAgg.entries()]
                .map(([id, data]) => ({ staffId: id, ...data, score: data.messages + data.voiceMinutes * 2 }))
                .sort((a, b) => b.score - a.score)
                .slice(0, 15);

              // 8. Staff absences
              const activeAbsences = await prisma.staffAbsence.count({ where: { guildId, status: { in: ['PENDING', 'APPROVED', 'ACKNOWLEDGED'] } } });
              const totalStaff = await prisma.staffMember.count({ where: { guildId } });

              // 9. Meetings
              const meetings = await prisma.staffMeeting.findMany({
                where: { guildId, scheduledAt: { gte: startDate } },
                include: { _count: { select: { presences: true } }, presences: { where: { status: 'PRESENT' }, select: { id: true } } },
              });
              const avgMeetingAttendance = meetings.length > 0
                ? Math.round(meetings.reduce((sum, m) => sum + m.presences.length, 0) / meetings.length * 10) / 10
                : 0;

              // 10. Recruitment pipeline
              const candidatures = await prisma.recruitmentCandidature.groupBy({
                by: ['status'],
                where: { guildId },
                _count: true,
              });
              const recruitmentPipeline = candidatures.map(c => ({ status: c.status, count: c._count }));

              // 11. Daily Algo participation
              const algoRuns = await prisma.dailyAlgoRun.findMany({
                where: { guildId, createdAt: { gte: startDate } },
                include: { _count: { select: { submissions: true } } },
              });
              const algoAvgParticipation = algoRuns.length > 0
                ? Math.round(algoRuns.reduce((sum, r) => sum + r._count.submissions, 0) / algoRuns.length * 10) / 10
                : 0;

              // 12. Invitations (top inviters)
              const invites = await prisma.memberInvite.groupBy({
                by: ['inviterId'],
                where: { guildId, inviterId: { not: null }, joinedAt: { gte: startDate } },
                _count: true,
                orderBy: { _count: { inviterId: 'desc' } },
                take: 10,
              });
              const topInviters = await Promise.all(invites.map(async inv => {
                const invProfile = inv.inviterId ? await prisma.memberProfile.findUnique({
                  where: { guildId_userId: { guildId, userId: inv.inviterId } },
                  select: { displayName: true, username: true },
                }) : null;
                return {
                  inviterId: inv.inviterId,
                  tag: invProfile?.displayName ?? invProfile?.username ?? 'Inconnu',
                  count: inv._count,
                };
              }));

              // 13. Role distribution
              const memberProfiles = await prisma.memberProfile.findMany({
                where: { guildId, isBot: false, guildLeftAt: null },
                select: { rolesSnapshot: true },
              });
              const roleCounts = new Map<string, number>();
              for (const mp of memberProfiles) {
                for (const roleId of mp.rolesSnapshot) {
                  roleCounts.set(roleId, (roleCounts.get(roleId) ?? 0) + 1);
                }
              }
              const roleDistribution = [...roleCounts.entries()]
                .map(([roleId, count]) => {
                  const discordRole = discordGuild?.roles.cache.get(roleId);
                  return {
                    roleId,
                    roleName: discordRole?.name ?? `Rôle ${roleId.slice(-4)}`,
                    color: discordRole?.hexColor ?? '#99AAB5',
                    count,
                  };
                })
                .filter(r => r.roleName !== '@everyone')
                .sort((a, b) => b.count - a.count)
                .slice(0, 20);

              // 14. Inactive members (>30d no message)
              const thirtyDaysAgo = new Date();
              thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
              const inactiveMembers = await prisma.memberProfile.count({
                where: {
                  guildId,
                  isBot: false,
                  guildLeftAt: null,
                  OR: [
                    { lastMessageAt: null },
                    { lastMessageAt: { lt: thirtyDaysAgo } },
                  ],
                },
              });

              // 15. Average member age
              const memberWithJoinDates = await prisma.memberProfile.findMany({
                where: { guildId, isBot: false, guildLeftAt: null, guildJoinedAt: { not: null } },
                select: { guildJoinedAt: true },
              });
              const avgTenureDays = memberWithJoinDates.length > 0
                ? Math.round(memberWithJoinDates.reduce((sum, m) => {
                    return sum + (now.getTime() - (m.guildJoinedAt?.getTime() ?? now.getTime())) / 86400000;
                  }, 0) / memberWithJoinDates.length)
                : 0;



              // 18. Recent sanctions with avatars
              const recentSanctionsList = await prisma.sanction.findMany({
                where: { guildId },
                orderBy: { createdAt: 'desc' },
                take: 20,
              });

              const recentSanctions = await Promise.all(recentSanctionsList.map(async s => {
                const [targetProfile, modProfile] = await Promise.all([
                  prisma.memberProfile.findUnique({
                    where: { guildId_userId: { guildId, userId: s.targetUserId } },
                    select: { avatarUrl: true }
                  }),
                  prisma.memberProfile.findUnique({
                    where: { guildId_userId: { guildId, userId: s.moderatorUserId } },
                    select: { avatarUrl: true }
                  })
                ]);
                return {
                  id: s.id,
                  type: s.type,
                  targetUserId: s.targetUserId,
                  targetTag: s.targetTag ?? 'Inconnu',
                  targetAvatarUrl: targetProfile?.avatarUrl,
                  moderatorUserId: s.moderatorUserId,
                  moderatorTag: s.moderatorTag ?? 'Inconnu',
                  moderatorAvatarUrl: modProfile?.avatarUrl,
                  reason: s.reason,
                  createdAt: s.createdAt.toISOString(),
                };
              }));

              // 19. Retention rate calculation
              const sevenDaysAgo = new Date();
              sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
              const joinedInRange = await prisma.memberProfile.count({
                where: {
                  guildId,
                  isBot: false,
                  guildJoinedAt: { gte: startDate, lte: sevenDaysAgo }
                }
              });
              const stayedInRange = await prisma.memberProfile.count({
                where: {
                  guildId,
                  isBot: false,
                  guildJoinedAt: { gte: startDate, lte: sevenDaysAgo },
                  guildLeftAt: null
                }
              });
              const retentionRate = joinedInRange > 0 ? Math.round((stayedInRange / joinedInRange) * 100) : 0;


              // Aggregate totals from daily stats
              const totalMessages = dailyStats.reduce((sum, d) => sum + d.messagesCount, 0);
              const totalVoiceMinutes = dailyStats.reduce((sum, d) => sum + d.voiceMinutes, 0);
              const totalJoins = dailyStats.reduce((sum, d) => sum + d.membersJoined, 0);
              const totalLeaves = dailyStats.reduce((sum, d) => sum + d.membersLeft, 0);

              // Compute week-over-week comparison
              const halfPeriod = Math.floor(periodDays / 2);
              const midDate = new Date(now);
              midDate.setDate(midDate.getDate() - halfPeriod);
              const midDateKey = `${midDate.getFullYear()}-${String(midDate.getMonth() + 1).padStart(2, '0')}-${String(midDate.getDate()).padStart(2, '0')}`;
              const recentStats = dailyStats.filter(d => d.dateKey >= midDateKey);
              const olderStats = dailyStats.filter(d => d.dateKey < midDateKey);
              const recentMessages = recentStats.reduce((s, d) => s + d.messagesCount, 0);
              const olderMessages = olderStats.reduce((s, d) => s + d.messagesCount, 0);
              const messagesTrend = olderMessages > 0 ? Math.round((recentMessages - olderMessages) / olderMessages * 100) : 0;

              // Resolve clan/server tag and calculate growth
              let clanTag: string | null = null;
              let clanTaggedMembersCount = 0;
              let taggedMembersList: any[] = [];
              if (discordGuild) {
                try {
                  const { Routes } = await import('discord.js');
                  const rawGuild = await client.rest.get(Routes.guild(guildId)) as any;
                  if (rawGuild.clan && rawGuild.clan.tag) {
                    clanTag = rawGuild.clan.tag;
                  }
                } catch (err) {
                  logger.debug('AnalyticsAPI', 'Error fetching raw guild clan info (non-critical): ' + String(err));
                }

                if (!clanTag) {
                  clanTag = (discordGuild as any).clan?.tag || (discordGuild as any).clanTag;
                }

                try {
                  const allMembers = await getGuildMembers(discordGuild);
                  
                  // If tag is still unresolved, scan members' primaryGuild
                  if (!clanTag) {
                    for (const [_, m] of allMembers) {
                      const primaryGuild = (m.user as any).primaryGuild;
                      if (primaryGuild && primaryGuild.identityGuildId === guildId && primaryGuild.tag) {
                        clanTag = primaryGuild.tag;
                        break;
                      }
                    }
                  }

                  if (clanTag) {
                    const tagLower = clanTag.toLowerCase();
                    const taggedMembers = allMembers.filter(m => {
                      const hasNativeTag = (m.user as any).clan?.tag === clanTag || 
                                           (m.user as any).primaryGuild?.tag === clanTag;
                      
                      const hasNicknameTag = m.nickname?.toLowerCase().includes(`[${tagLower}]`) || 
                                             m.nickname?.toLowerCase().includes(`(${tagLower})`) ||
                                             m.nickname?.toLowerCase().startsWith(`${tagLower} `) ||
                                             m.nickname?.toLowerCase().startsWith(`${tagLower} |`) ||
                                             m.user.username.toLowerCase().includes(`[${tagLower}]`) || 
                                             m.user.username.toLowerCase().includes(`(${tagLower})`) ||
                                             m.user.displayName?.toLowerCase().includes(`[${tagLower}]`) || 
                                             m.user.displayName?.toLowerCase().includes(`(${tagLower})`);
                                             
                      return hasNativeTag || hasNicknameTag;
                    });

                    clanTaggedMembersCount = taggedMembers.size;
                    taggedMembersList = Array.from(taggedMembers.values());
                  }
                } catch (fetchErr) {
                  logger.error('AnalyticsAPI', 'Error fetching guild members for tag analytics:', fetchErr);
                }
              }

              const analyticsPayload = {
                period: periodDays,
                clanTag,
                clanTaggedMembersCount,
                // Live stats
                live: {
                  totalMembers,
                  onlineMembers: onlineNow,
                  idleMembers: idleNow,
                  dndMembers: dndNow,
                  offlineMembers: totalMembers - onlineNow - idleNow - dndNow - botsCount,
                  voiceConnected: voiceNow,
                  botsCount,
                  humansCount: totalMembers - botsCount,
                },
                // Summary KPIs (renamed to totals for frontend)
                totals: {
                  messages: totalMessages,
                  voiceMinutes: totalVoiceMinutes,
                  joins: totalJoins,
                  leaves: totalLeaves,
                  netGrowth: totalJoins - totalLeaves,
                  activeDays: dailyStats.length,
                  sanctions: sanctions.length,
                  warns: sanctionsByType.WARN,
                  kicks: sanctionsByType.KICK,
                  bans: sanctionsByType.BAN + sanctionsByType.TEMP_BAN,
                  timeouts: sanctionsByType.TIMEOUT,
                  retentionRate,
                  activeAbsences,
                  totalStaff,
                  inactiveMembers,
                  avgTenureDays,
                  algoAvgParticipation,
                  avgMeetingAttendance,
                  messagesTrend,
                },
                // Legacy support for summary
                summary: {
                  totalMessages,
                  totalVoiceMinutes,
                  totalJoins,
                  totalLeaves,
                  messagesTrend,
                },
                // Daily trend data
                dailyTrend: dailyStats.map(d => {
                  const datePart = d.dateKey.split(' ')[0];
                  const trendDate = new Date(datePart + 'T23:59:59.999Z');
                  const count = clanTag 
                    ? taggedMembersList.filter(m => m.joinedAt && m.joinedAt <= trendDate).size 
                    : 0;
                  return {
                    dateKey: d.dateKey,
                    messages: d.messagesCount,
                    voiceMinutes: d.voiceMinutes,
                    voiceSessions: d.voiceSessionsCount,
                    membersJoined: d.membersJoined,
                    membersLeft: d.membersLeft,
                    totalMembers: d.totalMembers,
                    onlineMembers: d.onlineMembers,
                    peakOnline: d.peakOnline,
                    peakVoice: d.peakVoice,
                    sanctions: d.sanctionsCount,
                    taggedMembersCount: count,
                  };
                }),
                // Rankings
                topChannels,
                topMessageMembers: topMessageMembers.map(m => ({
                  userId: m.userId,
                  name: m.displayName ?? m.globalName ?? m.username ?? 'Inconnu',
                  avatarUrl: m.avatarUrl,
                  messageCount: m.messageCount,
                  lastMessageAt: m.lastMessageAt?.toISOString() ?? null,
                })),
                topVoiceMembers: topVoiceMembers.map(m => ({
                  userId: m.userId,
                  name: m.displayName ?? m.globalName ?? m.username ?? 'Inconnu',
                  avatarUrl: m.avatarUrl,
                  voiceTimeSeconds: m.voiceTimeSeconds,
                  voiceSessionCount: m.voiceSessionCount,
                })),
                topInviters,
                // Flattened Moderation for frontend
                topModerators,
                topSanctionedMembers: mostSanctioned.map(s => ({
                  userId: s.userId,
                  targetUserId: s.userId, // Duplicate for compatibility
                  targetTag: s.tag,
                  count: s.count,
                })),
                recentSanctions,
                // Moderation object for deeper components
                moderation: {
                  totals: {
                    warns: sanctionsByType.WARN,
                    kicks: sanctionsByType.KICK,
                    bans: sanctionsByType.BAN + sanctionsByType.TEMP_BAN,
                    timeouts: sanctionsByType.TIMEOUT,
                  },
                  topModerators: topModerators,
                  topSanctionedMembers: mostSanctioned.map(s => ({
                    userId: s.userId,
                    targetUserId: s.userId,
                    targetTag: s.tag,
                    count: s.count,
                    avatarUrl: s.avatarUrl,
                  })),
                  recentSanctions,
                  activeSanctions,
                },
                // Staff
                staff: {
                  leaderboard: staffLeaderboard,
                  activeAbsences,
                  totalStaff,
                  meetings: meetings.length,
                  avgMeetingAttendance,
                },
                // Recruitment
                recruitmentPipeline,
                // Roles
                roleDistribution,
                // Recent Joins \u0026 Leaves
                recentJoins: await prisma.memberProfile.findMany({
                  where: { guildId, guildJoinedAt: { not: null } },
                  orderBy: { guildJoinedAt: 'desc' },
                  take: 20,
                  select: {
                    userId: true,
                    displayName: true,
                    username: true,
                    globalName: true,
                    avatarUrl: true,
                    guildJoinedAt: true,
                  }
                }).then(list => list.map(m => ({
                  userId: m.userId,
                  name: m.displayName ?? m.globalName ?? m.username ?? 'Inconnu',
                  avatarUrl: m.avatarUrl,
                  date: m.guildJoinedAt?.toISOString()
                }))),
                recentLeaves: await prisma.memberProfile.findMany({
                  where: { guildId, guildLeftAt: { not: null } },
                  orderBy: { guildLeftAt: 'desc' },
                  take: 20,
                  select: {
                    userId: true,
                    displayName: true,
                    username: true,
                    globalName: true,
                    avatarUrl: true,
                    guildLeftAt: true,
                  }
                }).then(list => list.map(m => ({
                  userId: m.userId,
                  name: m.displayName ?? m.globalName ?? m.username ?? 'Inconnu',
                  avatarUrl: m.avatarUrl,
                  date: m.guildLeftAt?.toISOString()
                }))),
              };

              json(res, 200, analyticsPayload);
            } catch (err) {
              logger.error('AnalyticsAPI', 'Error computing analytics:', err);
              json(res, 500, { error: 'Erreur lors du calcul des analytics' });
            }
            return;
          }

          // GET /api/dashboard/guilds/:guildId/analytics/members/:userId - Member detailed analytics
          if (parts.length === 6 && parts[4] === 'analytics' && parts[5] === 'members' && req.method === 'GET') {
            const userId = url.searchParams.get('userId');
            if (!userId) {
              json(res, 400, { error: 'userId requis' });
              return;
            }
            try {
              const periodDays = Math.min(90, Math.max(7, parseInt(url.searchParams.get('period') || '30', 10)));
              const now = new Date();
              const startDate = new Date(now);
              startDate.setDate(startDate.getDate() - periodDays);
              const startDateKey = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;

              const dailyStats = await prisma.memberDailyStat.findMany({
                where: { guildId, userId, dateKey: { gte: startDateKey } },
                orderBy: { dateKey: 'asc' },
              });

              const totalMessages = dailyStats.reduce((s, d) => s + d.messagesCount, 0);
              const totalVoice = dailyStats.reduce((s, d) => s + d.voiceMinutes, 0);
              const activeDays = dailyStats.length;

              json(res, 200, {
                userId,
                period: periodDays,
                totalMessages,
                totalVoiceMinutes: totalVoice,
                activeDays,
                dailyTrend: dailyStats.map(d => ({
                  dateKey: d.dateKey,
                  messages: d.messagesCount,
                  voiceMinutes: d.voiceMinutes,
                })),
              });
            } catch (err) {
              logger.error('AnalyticsAPI', 'Error computing member analytics:', err);
              json(res, 500, { error: 'Erreur analytics membre' });
            }
            return;
          }

          // GET /api/dashboard/guilds/:guildId/analytics/correlation - Messages vs Voice correlation
          if (parts.length === 6 && parts[4] === 'analytics' && parts[5] === 'correlation' && req.method === 'GET') {
            try {
              const periodDays = parseInt(url.searchParams.get('period') || '30', 10);
              const startDate = new Date();
              startDate.setDate(startDate.getDate() - periodDays);
              const startDateKey = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;

              const memberStats = await prisma.memberDailyStat.groupBy({
                by: ['userId'],
                where: { guildId, dateKey: { gte: startDateKey } },
                _sum: { messagesCount: true, voiceMinutes: true },
              });

              const scatterData = memberStats
                .filter(m => (m._sum.messagesCount ?? 0) > 0 || (m._sum.voiceMinutes ?? 0) > 0)
                .map(m => ({
                  userId: m.userId,
                  messages: m._sum.messagesCount ?? 0,
                  voice: m._sum.voiceMinutes ?? 0,
                }));

              json(res, 200, { data: scatterData });
            } catch (err) {
              logger.error('AnalyticsAPI', 'Error computing correlation:', err);
              json(res, 500, { error: 'Erreur analytics correlation' });
            }
            return;
          }

          // GET /api/dashboard/guilds/:guildId/analytics/invites - Active invitation codes
          if (parts.length === 6 && parts[4] === 'analytics' && parts[5] === 'invites' && req.method === 'GET') {
            try {
              const discordGuild = client.guilds.cache.get(guildId);
              if (!discordGuild) {
                json(res, 404, { error: 'Serveur Discord introuvable' });
                return;
              }

              // Fetch active invites from Discord
              const activeInvites = await discordGuild.invites.fetch().catch(() => new Map());
              const invitesArray = [...activeInvites.values()];

              // Determine period for trend (days)
              const periodDays = parseInt(url.searchParams.get('days') || url.searchParams.get('period') || '30', 10);
              const startDate = new Date();
              startDate.setDate(startDate.getDate() - periodDays + 1); // include today

              // Fetch member invite joins from DB for the period and bucket by code
              const memberJoins = await prisma.memberInvite.findMany({
                where: {
                  guildId,
                  joinedAt: { gte: startDate },
                  inviteCode: { not: null }
                },
                select: { inviteCode: true, joinedAt: true }
              });

              // Build date labels for the period (ascending)
              const labels: string[] = [];
              for (let i = 0; i < periodDays; i++) {
                const d = new Date(startDate);
                d.setDate(startDate.getDate() + i);
                const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                labels.push(key);
              }

              // map: code -> dateKey -> count
              const joinMap = new Map<string, Map<string, number>>();
              for (const j of memberJoins) {
                const code = j.inviteCode ?? 'unknown';
                const d = new Date(j.joinedAt as any);
                const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                if (!joinMap.has(code)) joinMap.set(code, new Map());
                const dm = joinMap.get(code)!;
                dm.set(dateKey, (dm.get(dateKey) ?? 0) + 1);
              }

              const formattedInvites: any[] = [];
              for (const inv of invitesArray) {
                const inviterId = inv.inviter?.id ?? null;
                let createdBy = inv.inviter?.tag || 'Inconnu';
                // Try to resolve guild member display name for nicer UI
                if (inviterId) {
                  const member = discordGuild.members.cache.get(inviterId) ?? await discordGuild.members.fetch(inviterId).catch(() => null);
                  if (member) createdBy = member.displayName || member.user?.tag || createdBy;
                }

                const code = inv.code ?? 'unknown';
                const dm = joinMap.get(code) ?? new Map();
                const counts = labels.map(l => dm.get(l) ?? 0);
                const totalJoined = counts.reduce((s, v) => s + v, 0);

                formattedInvites.push({
                  code: inv.code,
                  inviterId,
                  inviterTag: inv.inviter?.tag || 'Inconnu',
                  inviterAvatarUrl: inv.inviter?.displayAvatarURL ? inv.inviter.displayAvatarURL({ size: 64 }) : null,
                  createdBy,
                  uses: inv.uses || 0,
                  maxUses: inv.maxUses,
                  expiresAt: inv.expiresAt ? inv.expiresAt.toISOString() : null,
                  createdAt: inv.createdAt ? inv.createdAt.toISOString() : null,
                  trend: {
                    labels,
                    counts,
                    totalJoined,
                  }
                });
              }

              // Also include codes that exist in DB but are not active in Discord anymore
              for (const [code, dm] of joinMap.entries()) {
                if (formattedInvites.find(f => f.code === code)) continue;
                const counts = labels.map(l => dm.get(l) ?? 0);
                const totalJoined = counts.reduce((s, v) => s + v, 0);
                formattedInvites.push({
                  code,
                  inviterId: null,
                  inviterTag: 'Inconnu',
                  inviterAvatarUrl: null,
                  createdBy: 'Inconnu',
                  uses: 0,
                  maxUses: null,
                  expiresAt: null,
                  createdAt: null,
                  trend: { labels, counts, totalJoined }
                });
              }

              formattedInvites.sort((a, b) => (b.uses || 0) - (a.uses || 0));

              json(res, 200, formattedInvites);
            } catch (err) {
              logger.error('AnalyticsAPI', 'Error computing invites analytics:', err);
              json(res, 500, { error: 'Erreur analytics invites' });
            }
            return;
          }

          // GET /api/dashboard/guilds/:guildId/analytics/heatmap - Hourly activity heatmap
          if (parts.length === 6 && parts[4] === 'analytics' && parts[5] === 'heatmap' && req.method === 'GET') {
            try {
              const days = Math.min(90, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10)));
              const startDate = url.searchParams.get('startDate');
              const endDate = url.searchParams.get('endDate');
              const { getHourlyHeatmapData } = await import('../services/dashboardAnalyticsService.js');
              const heatmapData = await getHourlyHeatmapData(guildId, { days, startDate, endDate });
              json(res, 200, heatmapData);
            } catch (err) {
              logger.error('AnalyticsAPI', 'Error computing heatmap:', err);
              json(res, 500, { error: 'Erreur heatmap analytics' });
            }
            return;
          }

          // GET /api/dashboard/guilds/:guildId/analytics/weekly-comparison - Week over week comparison
          if (parts.length === 6 && parts[4] === 'analytics' && parts[5] === 'weekly-comparison' && req.method === 'GET') {
            try {
              const { getWeekOverWeekComparison } = await import('../services/dashboardAnalyticsService.js');
              const offset = Math.min(12, Math.max(1, parseInt(url.searchParams.get('offset') || '1', 10)));
              const rawMode = url.searchParams.get('mode') || 'week';
              const mode = (rawMode === 'month' ? 'month' : 'week') as 'week' | 'month';
              const comparisonData = await getWeekOverWeekComparison(guildId, { offset, mode });
              json(res, 200, comparisonData);
            } catch (err) {
              logger.error('AnalyticsAPI', 'Error computing weekly comparison:', err);
              json(res, 500, { error: 'Erreur comparaison semaine/semaine' });
            }
            return;
          }

          // GET /api/dashboard/guilds/:guildId/analytics/growth-retention - Growth and retention metrics
          if (parts.length === 6 && parts[4] === 'analytics' && parts[5] === 'growth-retention' && req.method === 'GET') {
            try {
              const days = Math.min(365, Math.max(7, parseInt(url.searchParams.get('days') || '90', 10)));
              const startDate = url.searchParams.get('startDate');
              const endDate = url.searchParams.get('endDate');
              const { getGrowthAndRetention } = await import('../services/dashboardAnalyticsService.js');
              const growthData = await getGrowthAndRetention(guildId, { days, startDate, endDate });
              json(res, 200, growthData);
            } catch (err) {
              logger.error('AnalyticsAPI', 'Error computing growth/retention:', err);
              json(res, 500, { error: 'Erreur growth/retention analytics' });
            }
            return;
          }

          // GET /api/dashboard/guilds/:guildId/analytics/daily-algo - Daily Algo analytics
          if (parts.length === 6 && parts[4] === 'analytics' && parts[5] === 'daily-algo' && req.method === 'GET') {
            try {
              const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get('days') || '30', 10)));
              const startDate = url.searchParams.get('startDate');
              const endDate = url.searchParams.get('endDate');
              const { getDailyAlgoAnalytics } = await import('../services/dashboardAnalyticsService.js');
              const algoData = await getDailyAlgoAnalytics(guildId, { days, startDate, endDate });
              json(res, 200, algoData);
            } catch (err) {
              logger.error('AnalyticsAPI', 'Error computing daily algo analytics:', err);
              json(res, 500, { error: 'Erreur daily algo analytics' });
            }
            return;
          }

          // GET /api/dashboard/guilds/:guildId/recruitment/candidatures - Get recruitment candidatures
          if (parts.length === 6 && parts[4] === 'recruitment' && parts[5] === 'candidatures' && req.method === 'GET') {
            try {
              const candidatures = await getCandidatures(guildId);
              json(res, 200, { candidatures });
              return;
            } catch (err) {
              logger.error('RecruitmentAPI', 'Error getting candidatures:', err);
              json(res, 500, { error: 'Erreur lors de la récupération des candidatures' });
            }
            return;
          }

          // PATCH /api/dashboard/guilds/:guildId/recruitment/config - Update recruitment configuration
          if (parts.length === 6 && parts[4] === 'recruitment' && parts[5] === 'config' && req.method === 'PATCH') {
            const body = await readJsonBody<{
              recruitmentCategoryId?: string | null;
              recruitmentLogChannelId?: string | null;
              recruitmentAutoRejectEnabled?: boolean;
            }>(req);

            const recruitmentCategoryId = body?.recruitmentCategoryId?.trim() || null;
            const recruitmentLogChannelId = body?.recruitmentLogChannelId?.trim() || null;

            await prisma.guild.update({
              where: { id: guildId },
              data: {
                recruitmentCategoryId,
                recruitmentLogChannelId,
              }
            });

            if (typeof body?.recruitmentAutoRejectEnabled === 'boolean') {
              recruitmentAutoRejectEnabledByGuild.set(guildId, body.recruitmentAutoRejectEnabled);
            }

            json(res, 200, {
              ok: true,
              recruitmentCategoryId,
              recruitmentLogChannelId,
              recruitmentAutoRejectEnabled: isRecruitmentAutoRejectEnabled(guildId),
            });
            return;
          }

          // PATCH /api/dashboard/guilds/:guildId/recruitment/candidatures/:id - Update candidature workflow
          if (parts.length === 7 && parts[4] === 'recruitment' && parts[5] === 'candidatures' && req.method === 'PATCH') {
            const candidatureId = parts[6];

            const candidature = await prisma.recruitmentCandidature.findFirst({
              where: { id: candidatureId, guildId },
              select: { id: true }
            });

            if (!candidature) {
              json(res, 404, { error: 'Candidature introuvable pour ce serveur.' });
              return;
            }

            const body = await readJsonBody<{
              action?: string;
              status?: string;
              notes?: string;
              reason?: string;
              discordUserId?: string;
              tutorUserId?: string;
            }>(req);

            const action = body?.action;

            try {
              if (action === 'status_update') {
                const nextStatus = body?.status;
                if (!nextStatus || !['PENDING', 'ORAL', 'APPROVED', 'REJECTED', 'AUTO_REJECTED'].includes(nextStatus)) {
                  json(res, 400, { error: 'Statut candidature invalide.' });
                  return;
                }

                await updateCandidatureStatus(candidatureId, nextStatus as any, body?.notes);
                json(res, 200, { ok: true });
                return;
              }

              if (action === 'approve') {
                const discordUserId = body?.discordUserId?.trim();
                if (!discordUserId) {
                  json(res, 400, { error: 'discordUserId est requis pour valider une candidature.' });
                  return;
                }

                await approveCandidature(client, guildId, candidatureId, discordUserId, user.userId);
                json(res, 200, { ok: true });
                return;
              }

              if (action === 'reject') {
                await rejectCandidature(client, guildId, candidatureId, body?.reason?.trim(), user.userId);
                json(res, 200, { ok: true });
                return;
              }

              if (action === 'oral_pass') {
                await completeOral(client, guildId, candidatureId, 'PASSED', body?.reason?.trim(), user.userId);
                json(res, 200, { ok: true });
                return;
              }

              if (action === 'oral_fail') {
                await completeOral(client, guildId, candidatureId, 'FAILED', body?.reason?.trim(), user.userId);
                json(res, 200, { ok: true });
                return;
              }

              if (action === 'assign_tutor') {
                const tutorUserId = body?.tutorUserId?.trim();
                if (!tutorUserId) {
                  json(res, 400, { error: 'tutorUserId est requis pour assigner un tuteur.' });
                  return;
                }

                await assignTutor(candidatureId, tutorUserId);
                json(res, 200, { ok: true });
                return;
              }

              json(res, 400, { error: 'Action de candidature non reconnue.' });
            } catch (err) {
              logger.error('RecruitmentAPI', 'Error updating candidature:', err);
              json(res, 500, { error: err instanceof Error ? err.message : 'Erreur lors de la mise à jour de la candidature' });
            }
            return;
          }

          // DELETE /api/dashboard/guilds/:guildId/recruitment/candidatures/:id - Delete candidature
          if (parts.length === 7 && parts[4] === 'recruitment' && parts[5] === 'candidatures' && req.method === 'DELETE') {
            const candidatureId = parts[6];

            const candidature = await prisma.recruitmentCandidature.findFirst({
              where: { id: candidatureId, guildId },
              select: { id: true }
            });

            if (!candidature) {
              json(res, 404, { error: 'Candidature introuvable pour ce serveur.' });
              return;
            }

            try {
              await deleteRecruitmentCandidature(candidatureId);
              json(res, 200, { ok: true });
            } catch (err) {
              logger.error('RecruitmentAPI', 'Error deleting candidature:', err);
              json(res, 500, { error: 'Erreur lors de la suppression de la candidature' });
            }
            return;
          }

          // GET /api/dashboard/guilds/:guildId/recruitment/tutors - Get eligible tutors
          if (parts.length === 6 && parts[4] === 'recruitment' && parts[5] === 'tutors' && req.method === 'GET') {
            try {
              const tutors = await getEligibleTutors(guildId);
              json(res, 200, { tutors });
              return;
            } catch (err) {
              logger.error('RecruitmentAPI', 'Error getting eligible tutors:', err);
              json(res, 500, { error: 'Erreur lors de la récupération des tuteurs éligibles' });
            }
            return;
          }

          // GET /api/dashboard/guilds/:guildId/detections - List suspected DC detections
          if (parts.length === 5 && parts[4] === 'detections' && req.method === 'GET') {
            try {
              if (!access.canManageSettings && !featureAccess.double_accounts?.canView) {
                json(res, 403, { error: 'Accès refusé. Le module Détections n’est pas accessible.' });
                return;
              }

              const discordGuild = client.guilds.cache.get(guildId);
              let discordMembers: Map<string, any> = new Map();

              if (discordGuild) {
                const allServerMembers = await discordGuild.members.fetch({ limit: 1000 }).catch(() => null);
                if (allServerMembers) {
                  for (const member of allServerMembers.values()) {
                    discordMembers.set(member.id, member);
                  }
                }
              }

              const suspiciousMembers = await prisma.memberProfile.findMany({
                where: { guildId, isSuspectedDC: true },
                orderBy: [{ lastSeenAt: 'desc' }, { guildJoinedAt: 'desc' }],
                take: 200,
                select: {
                  userId: true,
                  username: true,
                  displayName: true,
                  userTag: true,
                  avatarUrl: true,
                  isBot: true,
                  accountCreatedAt: true,
                  guildJoinedAt: true,
                  guildLeftAt: true,
                  lastSeenAt: true,
                  messageCount: true,
                  isSuspectedDC: true,
                },
              });

              const detections = suspiciousMembers.map((member) => {
                const discordMember = discordMembers.get(member.userId) ?? null;
                const accountCreatedAt = member.accountCreatedAt?.toISOString() ?? null;
                const guildJoinedAt = discordMember?.joinedAt?.toISOString() ?? member.guildJoinedAt?.toISOString() ?? null;
                const createdTs = member.accountCreatedAt?.getTime() ?? null;
                const joinedTs = discordMember?.joinedTimestamp ?? member.guildJoinedAt?.getTime() ?? null;
                const accountAgeMs = createdTs !== null && joinedTs !== null ? Math.max(0, joinedTs - createdTs) : null;

                return {
                  id: member.userId,
                  username: member.username ?? null,
                  displayName: member.displayName ?? member.userTag ?? member.username ?? null,
                  avatarUrl: member.avatarUrl ?? discordMember?.user.displayAvatarURL({ size: 256 }) ?? null,
                  isBot: member.isBot,
                  accountCreatedAt,
                  guildJoinedAt,
                  guildLeftAt: member.guildLeftAt?.toISOString() ?? null,
                  lastSeenAt: member.lastSeenAt?.toISOString() ?? null,
                  messageCount: member.messageCount ?? 0,
                  isOnServer: !!discordMember,
                  presenceStatus: discordMember?.presence?.status ?? (discordMember ? null : 'left'),
                  accountAgeMs,
                  accountAgeLabel: accountAgeMs !== null
                    ? formatDurationFr(accountAgeMs)
                    : 'Inconnue',
                };
              });

              json(res, 200, {
                total: detections.length,
                detections,
              });
            } catch (err) {
              logger.error('MembersAPI', 'Error fetching suspected detections:', err);
              json(res, 500, { error: 'Erreur lors du chargement des détections' });
            }
            return;
          }

          // POST /api/dashboard/guilds/:guildId/detections/scan - Trigger a rescan of guild members for young accounts
          if (parts.length === 6 && parts[4] === 'detections' && parts[5] === 'scan' && req.method === 'POST') {
            try {
              if (!access.canManageSettings && !featureAccess.double_accounts?.canModerate) {
                json(res, 403, { error: 'Accès refusé. Vous n’avez pas les permissions nécessaires pour lancer un scan.' });
                return;
              }

              const discordGuild = client.guilds.cache.get(guildId);
              if (!discordGuild) {
                json(res, 404, { error: 'Serveur Discord introuvable ou inaccessible par le bot' });
                return;
              }

              let thresholdMs: number | undefined = undefined;
              const body = await readJsonBody<{ thresholdDays?: number }>(req).catch(() => null);
              if (body && body.thresholdDays !== undefined) {
                const days = Number(body.thresholdDays);
                if (Number.isNaN(days) || days < 1 || days > 30 || !Number.isInteger(days)) {
                  json(res, 400, { error: 'Le seuil de jours doit être un entier compris entre 1 et 30.' });
                  return;
                }
                thresholdMs = days * 24 * 60 * 60 * 1000;
              }

              const result = await scanGuildMembersForYoungAccounts(discordGuild, thresholdMs);

              json(res, 200, {
                success: true,
                scannedCount: result.scannedCount,
                flaggedCount: result.flaggedCount,
              });
            } catch (err) {
              logger.error('MembersAPI', 'Error scanning suspected detections:', err);
              json(res, 500, { error: 'Erreur lors du scan des détections' });
            }
            return;
          }

          // GET /api/dashboard/guilds/:guildId/members/search - Search members from Discord + database
          if (parts.length === 6 && parts[4] === 'members' && parts[5] === 'search' && req.method === 'GET') {
            try {
              const searchQuery = (url.searchParams.get('q') ?? '').trim().toLowerCase();
              const limit = Math.min(Number(url.searchParams.get('limit') ?? '24'), 100);
              const page = Math.max(Number(url.searchParams.get('page') ?? '1'), 1);
              const sortBy = url.searchParams.get('sortBy') ?? 'lastSeenAt';
              const sortOrder = url.searchParams.get('sortOrder') ?? 'desc';
              const serverStatus = url.searchParams.get('serverStatus') ?? 'on_server';
              const botFilter = url.searchParams.get('botFilter') ?? 'human';

              // Validate sortBy to prevent injection
              const validSortFields = ['lastSeenAt', 'messageCount', 'guildJoinedAt'];
              const finalSortBy = validSortFields.includes(sortBy) ? sortBy : 'lastSeenAt';

              // Fetch all server members from Discord
              const discordGuild = client.guilds.cache.get(guildId);
              let discordMembers: Map<string, any> = new Map();

              if (discordGuild) {
                try {
                  const allServerMembers = await discordGuild.members.fetch({ limit: 1000 }).catch(() => null);
                  if (allServerMembers) {
                    for (const member of allServerMembers.values()) {
                      discordMembers.set(member.id, member);
                    }
                  }
                } catch (err) {
                  logger.debug('MembersAPI', 'Could not fetch Discord members:', String(err));
                }
              }

              // Fetch all members from database for enrichment
              const allDbMembers = await prisma.memberProfile.findMany({
                where: { guildId },
                select: {
                  userId: true,
                  username: true,
                  displayName: true,
                  globalName: true,
                  userTag: true,
                  avatarUrl: true,
                  isBot: true,
                  lastSeenAt: true,
                  guildJoinedAt: true,
                  messageCount: true,
                  guildLeftAt: true,
                },
              });

              // Create map for quick lookup
              const dbMemberMap = new Map(allDbMembers.map(m => [m.userId, m]));

              // Build FULL list of members (both on server and left)
              let allMembers: any[] = [];

              // Add Discord members
              for (const [userId, discordMember] of discordMembers.entries()) {
                const dbMember = dbMemberMap.get(userId);
                allMembers.push({
                  id: userId,
                  username: dbMember?.username || discordMember.user.username,
                  displayName: dbMember?.displayName || discordMember.displayName || discordMember.user.globalName || discordMember.user.username,
                  avatarUrl: dbMember?.avatarUrl || discordMember.user.displayAvatarURL({ size: 256 }),
                  isBot: discordMember.user.bot,
                  lastSeenAt: dbMember?.lastSeenAt?.toISOString() ?? null,
                  messageCount: dbMember?.messageCount || 0,
                  guildJoinedAt: discordMember.joinedAt?.toISOString() ?? dbMember?.guildJoinedAt?.toISOString() ?? null,
                  guildLeftAt: null,
                  isOnServer: true,
                  presenceStatus: discordMember.presence?.status ?? null,
                });
              }

              // Add Left members (from DB but not on Discord)
              for (const dbMember of allDbMembers) {
                if (!discordMembers.has(dbMember.userId)) {
                  allMembers.push({
                    id: dbMember.userId,
                    username: dbMember.username || 'Utilisateur inconnu',
                    displayName: dbMember.displayName || dbMember.globalName || dbMember.userTag || dbMember.username || 'Utilisateur inconnu',
                    avatarUrl: dbMember.avatarUrl,
                    isBot: dbMember.isBot || false,
                    lastSeenAt: dbMember.lastSeenAt?.toISOString() ?? null,
                    messageCount: dbMember.messageCount || 0,
                    guildJoinedAt: dbMember.guildJoinedAt?.toISOString() ?? null,
                    guildLeftAt: dbMember.guildLeftAt?.toISOString() ?? null,
                      isOnServer: false,
                      presenceStatus: 'left',
                  });
                }
              }

              // Calculate Global Stats (before filtering, but after building full list)
              const onServerCount = allMembers.filter(m => m.isOnServer).length;
              const leftCount = allMembers.filter(m => !m.isOnServer).length;
              const botCount = allMembers.filter(m => m.isBot).length;

              // Apply Filters
              // 1. Filter by server status
              if (serverStatus === 'on_server') {
                allMembers = allMembers.filter(m => m.isOnServer);
              } else if (serverStatus === 'left') {
                allMembers = allMembers.filter(m => !m.isOnServer);
              }

              // 2. Filter by search query
              if (searchQuery) {
                allMembers = allMembers.filter(member =>
                  member.username?.toLowerCase().includes(searchQuery) ||
                  member.displayName?.toLowerCase().includes(searchQuery) ||
                  member.id.includes(searchQuery)
                );
              }

              // 3. Filter by bot status
              if (botFilter === 'human') {
                allMembers = allMembers.filter(m => !m.isBot);
              } else if (botFilter === 'bot') {
                allMembers = allMembers.filter(m => m.isBot);
              }

              // Sort members
              const finalSortOrder = sortOrder === 'asc' ? 1 : -1;
              if (sortBy === 'messageCount') {
                allMembers.sort((a, b) => (a.messageCount - b.messageCount) * finalSortOrder);
              } else if (sortBy === 'guildJoinedAt') {
                allMembers.sort((a, b) => {
                  const dateA = a.guildJoinedAt ? new Date(a.guildJoinedAt).getTime() : 0;
                  const dateB = b.guildJoinedAt ? new Date(b.guildJoinedAt).getTime() : 0;
                  return (dateA - dateB) * finalSortOrder;
                });
              } else {
                // lastSeenAt (default)
                allMembers.sort((a, b) => {
                  const dateA = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
                  const dateB = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
                  return (dateA - dateB) * finalSortOrder;
                });
              }
              
              // Paginate
              const totalFound = allMembers.length;
              const totalPages = Math.ceil(totalFound / limit);
              const skip = (page - 1) * limit;
              const paginatedMembers = allMembers.slice(skip, skip + limit);

              // Clean up response
              const members = paginatedMembers.map(m => {
                const { _sortKey, ...member } = m;
                return member;
              });

              json(res, 200, {
                members,
                totalFound,
                totalPages,
                onServerCount,
                leftCount,
                botCount,
              });
            } catch (err) {
              logger.error('MembersAPI', 'Error searching members:', err);
              json(res, 500, { error: 'Erreur lors de la recherche de membres', details: String(err) });
            }
            return;
          }

          if (parts.length === 6 && parts[4] === 'members' && req.method === 'GET') {
            try {
              const memberCase = await buildMemberCaseData(client, guildId, parts[5], user);
              if (!memberCase) {
                json(res, 404, { error: 'Membre introuvable sur ce serveur.' });
                return;
              }

              json(res, 200, memberCase);
            } catch (err) {
              logger.error('MembersAPI', `Error building member case for ${parts[5]}:`, err);
              json(res, 500, { error: 'Erreur lors de la construction du dossier membre', details: String(err) });
            }
            return;
          }

          if (parts.length === 7 && parts[4] === 'members' && parts[6] === 'link' && req.method === 'POST') {
            try {
              const u1Id = parts[5].startsWith('!') ? parts[5].substring(1) : parts[5];
              const body = await readJsonBody<{ targetAccountId?: string; reason?: string }>(req);
              const u2Id = body?.targetAccountId;
              const reason = body?.reason;

              if (!u2Id) {
                json(res, 400, { error: 'L\'ID du compte cible est requis.' });
                return;
              }

              if (u1Id === u2Id) {
                json(res, 400, { error: 'Impossible de lier un compte à lui-même.' });
                return;
              }

              const dbGuild = await prisma.guild.findUnique({ where: { id: guildId } });
              const isStaffDb = await prisma.staffMember.findUnique({ where: { guildId_userId: { guildId: guildId, userId: user.userId } } });
              const isAdmin = access.level === 'admin';
              
              // Only dashboard users can call this, so they are already staff or admin usually (access.level !== 'none').
              // But just in case, verify if they are staff via db or mod perms
              const isStaff = isAdmin || !!isStaffDb || access.level === 'moderator';

              if (!isStaff) {
                json(res, 403, { error: 'Accès refusé' });
                return;
              }

              if (!isAdmin && !reason) {
                json(res, 400, { error: 'En tant que membre du staff, tu dois obligatoirement fournir une raison pour lier ces comptes.' });
                return;
              }

              await altAccountService.linkAccounts({
                guildId,
                user1Id: u1Id,
                user2Id: u2Id,
                type: 'MANUAL',
                status: 'VALIDATED',
                reason: reason || 'Action Administrateur (Dashboard)',
                linkedByUserId: user.userId,
                metadata: { linkedBy: user.userId, source: 'dashboard', at: new Date().toISOString() }
              });

              const discordGuild = client.guilds.cache.get(guildId);
              const dmEmbed = new EmbedBuilder()
                .setColor(COLORS.success)
                .setTitle('🔗 Comptes liés officiellement')
                .setDescription(`Vos comptes **<@${u1Id}>** et **<@${u2Id}>** ont été reliés sur **${discordGuild?.name || 'le serveur'}**.`)
                .addFields({ name: 'Raison / Notes', value: reason || 'Liaison validée par le staff.', inline: false })
                .setTimestamp();

              try {
                const member1 = await client.users.fetch(u1Id).catch(() => null);
                if (member1) await member1.send({ embeds: [dmEmbed] }).catch(() => null);
              } catch (e) {}

              try {
                const member2 = await client.users.fetch(u2Id).catch(() => null);
                if (member2) await member2.send({ embeds: [dmEmbed] }).catch(() => null);
              } catch (e) {}

              json(res, 200, { success: true });
            } catch (err) {
              logger.error('MembersAPI', `Error linking accounts for ${parts[5]}:`, err);
              json(res, 500, { error: 'Erreur lors de la liaison des comptes', details: String(err) });
            }
            return;
          }

          if (parts.length === 8 && parts[4] === 'members' && parts[6] === 'link' && req.method === 'DELETE') {
            try {
              const u1Id = parts[5].startsWith('!') ? parts[5].substring(1) : parts[5];
              const u2Id = parts[7];

              const isStaffDb = await prisma.staffMember.findUnique({ where: { guildId_userId: { guildId: guildId, userId: user.userId } } });
              const isAdmin = access.level === 'admin';
              const isStaff = isAdmin || !!isStaffDb || access.level === 'moderator';

              if (!isStaff) {
                json(res, 403, { error: 'Accès refusé' });
                return;
              }

              await altAccountService.unlinkAccounts(guildId, u1Id, u2Id);
              
              const discordGuild = client.guilds.cache.get(guildId);
              const dmEmbed = new EmbedBuilder()
                .setColor(COLORS.error)
                .setTitle('🔗 Comptes déliés')
                .setDescription(`Vos comptes **<@${u1Id}>** et **<@${u2Id}>** ont été séparés sur **${discordGuild?.name || 'le serveur'}**.`)
                .setTimestamp();

              try {
                const member1 = await client.users.fetch(u1Id).catch(() => null);
                if (member1) await member1.send({ embeds: [dmEmbed] }).catch(() => null);
              } catch (e) {}

              try {
                const member2 = await client.users.fetch(u2Id).catch(() => null);
                if (member2) await member2.send({ embeds: [dmEmbed] }).catch(() => null);
              } catch (e) {}

              json(res, 200, { success: true });
            } catch (err) {
              logger.error('MembersAPI', `Error unlinking accounts for ${parts[5]}:`, err);
              json(res, 500, { error: 'Erreur lors de la suppression de la liaison', details: String(err) });
            }
            return;
          }

          if (parts.length === 7 && parts[4] === 'members' && parts[6] === 'actions' && req.method === 'POST') {
            if (!access.canModerateContent) {
              json(res, 403, { error: 'Action de modération non autorisée.' });
              return;
            }

            const userId = parts[5].startsWith('!') ? parts[5].substring(1) : parts[5];
            const body = await readJsonBody<{
              type?: MemberCaseQuickAction;
              reason?: string;
              durationMs?: number | null;
            }>(req);

            const action = body?.type;
            const reason = body?.reason?.trim() || 'Action lancée depuis le profil membre.';
            const discordGuild = client.guilds.cache.get(guildId);
            if (!discordGuild) {
              json(res, 404, { error: 'Serveur Discord introuvable.' });
              return;
            }

            const targetUser = await client.users.fetch(userId).catch(() => null);
            const targetMember = await discordGuild.members.fetch(userId).catch(() => null);
            const moderator = { id: user.userId, tag: user.username ?? `Utilisateur ${user.userId}` };
            const target = {
              id: userId,
              tag: targetUser?.tag ?? targetMember?.user.tag ?? `Utilisateur ${userId}`,
            };

            if (!action || !['WARN', 'KICK', 'TIMEOUT', 'BAN'].includes(action)) {
              json(res, 400, { error: 'Type d’action invalide.' });
              return;
            }

            if (action === 'WARN') {
              const sanction = await registerWarnSanction({ guildId, target, moderator, reason });

              await pushAudit(guildId, {
                user: auditUser,
                action: 'Warn depuis le profil membre',
                context: getGuildName(client, guildId),
                module: 'Sanctions',
                eventType: 'Manuel',
                details: `Warn appliqué à ${target.tag} (${target.id}). Raison: ${reason}`,
                channelId: null,
              });

              broadcastDashboardStateChange(guildId, 'member_warned');
              json(res, 200, { ok: true, sanctionId: sanction.id });
              return;
            }

            if (action === 'KICK') {
              if (!targetMember) {
                json(res, 404, { error: 'Le membre doit être présent sur le serveur pour être expulsé.' });
                return;
              }
              if (!targetMember.kickable) {
                json(res, 400, { error: 'Le bot ne peut pas exclure ce membre.' });
                return;
              }

              await targetMember.kick(`${reason} | Modération: ${user.username ?? user.userId}`);
              const sanction = await registerKickSanction({ guildId, target, moderator, reason });

              await pushAudit(guildId, {
                user: auditUser,
                action: 'Kick depuis le profil membre',
                context: getGuildName(client, guildId),
                module: 'Sanctions',
                eventType: 'Manuel',
                details: `Kick appliqué à ${target.tag} (${target.id}). Raison: ${reason}`,
                channelId: null,
              });

              broadcastDashboardStateChange(guildId, 'member_kicked');
              json(res, 200, { ok: true, sanctionId: sanction.id });
              return;
            }

            if (action === 'TIMEOUT') {
              if (!targetMember) {
                json(res, 404, { error: 'Le membre doit être présent sur le serveur pour un timeout.' });
                return;
              }
              if (!targetMember.moderatable) {
                json(res, 400, { error: 'Le bot ne peut pas appliquer de timeout à ce membre.' });
                return;
              }

              const durationMs = Number(body?.durationMs ?? 0);
              if (!Number.isFinite(durationMs) || durationMs <= 0) {
                json(res, 400, { error: 'Une durée valide en millisecondes est requise pour le timeout.' });
                return;
              }

              const sanction = await registerTimeoutSanction({
                guildId,
                target,
                moderator,
                reason,
                durationMs,
                member: targetMember,
              });

              await pushAudit(guildId, {
                user: auditUser,
                action: 'Timeout depuis le profil membre',
                context: getGuildName(client, guildId),
                module: 'Sanctions',
                eventType: 'Manuel',
                details: `Timeout appliqué à ${target.tag} (${target.id}) pour ${Math.floor(durationMs / 1000)}s. Raison: ${reason}`,
                channelId: null,
              });

              broadcastDashboardStateChange(guildId, 'member_timeout');
              json(res, 200, { ok: true, sanctionId: sanction.id });
              return;
            }

            if (action === 'BAN') {
              if (targetMember && !targetMember.bannable) {
                json(res, 400, { error: 'Le bot ne peut pas bannir ce membre.' });
                return;
              }

              await runGuildBan(discordGuild, userId, `${reason} | Modération: ${user.username ?? user.userId}`);
              const sanction = await registerBanSanction({ guildId, target, moderator, reason });

              await pushAudit(guildId, {
                user: auditUser,
                action: 'Ban depuis le profil membre',
                context: getGuildName(client, guildId),
                module: 'Sanctions',
                eventType: 'Manuel',
                details: `Ban appliqué à ${target.tag} (${target.id}). Raison: ${reason}`,
                channelId: null,
              });

              broadcastDashboardStateChange(guildId, 'member_banned');
              json(res, 200, { ok: true, sanctionId: sanction.id });
              return;
            }
          }

          if (parts.length === 7 && parts[4] === 'members' && parts[6] === 'note' && req.method === 'PATCH') {
            const userId = parts[5].startsWith('!') ? parts[5].substring(1) : parts[5];
            const body = await readJsonBody<{ note: string }>(req);

            try {
              const profile = await prisma.memberProfile.upsert({
                where: { guildId_userId: { guildId, userId } },
                update: { moderatorNote: body?.note ?? null },
                create: {
                  guildId,
                  userId,
                  moderatorNote: body?.note ?? null,
                },
              });

              await pushAudit(guildId, {
                user: auditUser,
                action: 'Mise à jour note modérateur',
                context: getGuildName(client, guildId),
                module: 'Members',
                eventType: 'Manuel',
                details: `Note mise à jour pour l'utilisateur ${userId}.`,
                channelId: null,
              });

              json(res, 200, { ok: true, note: profile.moderatorNote });
            } catch (err) {
              logger.error('MembersAPI', `Error updating note for ${userId}:`, err);
              json(res, 500, { error: 'Erreur lors de la mise à jour de la note' });
            }
            return;
          }

          // --- INVITATIONS ENDPOINTS ---
          if (parts[4] === 'invitations') {
            if (!access.canViewDashboard) {
              json(res, 403, { error: 'Accès refusé' });
              return;
            }

            const auditUser = user.username ?? `User${user.userId}`;

            // GET /api/dashboard/guilds/:guildId/invitations
            if (parts.length === 5 && req.method === 'GET') {
              try {
                const dbInvites = await prisma.guildInvite.findMany({
                  where: { guildId },
                  orderBy: { createdAt: 'desc' }
                });
                const dbSuspended = await prisma.suspendedInviter.findMany({
                  where: { guildId },
                  orderBy: { createdAt: 'desc' }
                });
                const inviteUsage = await prisma.memberInvite.groupBy({
                  by: ['inviteCode'],
                  where: { guildId, inviteCode: { not: null } },
                  _count: { _all: true, leftAt: true },
                  _max: { joinedAt: true }
                });
                const inviterUsage = await prisma.memberInvite.groupBy({
                  by: ['inviterId', 'inviterTag'],
                  where: { guildId, inviterId: { not: null } },
                  _count: { _all: true, leftAt: true },
                  _max: { joinedAt: true }
                });
                const totalJoined = await prisma.memberInvite.count({ where: { guildId } });
                const totalLeft = await prisma.memberInvite.count({ where: { guildId, leftAt: { not: null } } });

                json(res, 200, {
                  invitations: dbInvites,
                  suspendedInviters: dbSuspended,
                  inviteUsage,
                  inviterUsage,
                  summary: { totalJoined, totalLeft }
                });
              } catch (err) {
                logger.error('InvitationsAPI', 'Error fetching invitations:', err);
                json(res, 500, { error: 'Erreur lors de la récupération des invitations' });
              }
              return;
            }

            // GET /api/dashboard/guilds/:guildId/invitations/suspended-inviters
            if (parts.length === 6 && parts[5] === 'suspended-inviters' && req.method === 'GET') {
              try {
                const dbSuspended = await prisma.suspendedInviter.findMany({
                  where: { guildId },
                  orderBy: { createdAt: 'desc' }
                });
                json(res, 200, { suspendedInviters: dbSuspended });
              } catch (err) {
                logger.error('InvitationsAPI', 'Error fetching suspended inviters:', err);
                json(res, 500, { error: 'Erreur lors de la récupération des créateurs suspendus' });
              }
              return;
            }

            // POST /api/dashboard/guilds/:guildId/invitations/suspended-inviters
            if (parts.length === 6 && parts[5] === 'suspended-inviters' && req.method === 'POST') {
              if (!access.canModerateContent) {
                json(res, 403, { error: 'Accès refusé : Action de modération requise.' });
                return;
              }
              const body = await readJsonBody<{ userId: string; userTag?: string; reason?: string; cascade?: boolean }>(req);
              if (!body || !body.userId) {
                json(res, 400, { error: 'userId est requis' });
                return;
              }

              try {
                let tag = body.userTag || '';
                if (!tag) {
                  const discordUser = await client.users.fetch(body.userId).catch(() => null);
                  if (discordUser) tag = discordUser.tag;
                }

                const suspended = await prisma.suspendedInviter.upsert({
                  where: {
                    guildId_userId: { guildId, userId: body.userId }
                  },
                  update: {
                    userTag: tag || undefined,
                    reason: body.reason || null
                  },
                  create: {
                    guildId,
                    userId: body.userId,
                    userTag: tag || `Utilisateur ${body.userId}`,
                    reason: body.reason || null
                  }
                });

                let cascadeResult = null;
                if (body.cascade) {
                  const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
                  if (discordGuild) {
                    const joins = await prisma.memberInvite.findMany({
                      where: { guildId, inviterId: body.userId, leftAt: null }
                    });

                    let purgedCount = 0;
                    let failedCount = 0;

                    for (const join of joins) {
                      const member = await discordGuild.members.fetch(join.userId).catch(() => null);
                      if (member) {
                        try {
                          await member.kick(`[Purge Sécurité] Expulsion en cascade (créateur ${body.userId})`);
                          purgedCount++;
                          await prisma.memberInvite.updateMany({
                            where: { guildId, inviterId: body.userId, userId: join.userId },
                            data: { leftAt: new Date() }
                          }).catch(() => null);
                        } catch (e) {
                          failedCount++;
                        }
                      }
                    }

                    cascadeResult = { purgedCount, failedCount };
                  }
                }

                await pushAudit(guildId, {
                  user: auditUser,
                  action: "Suspension créateur invitations",
                  context: getGuildName(client, guildId),
                  module: 'Invitations',
                  eventType: 'Manuel',
                  details: `Créateur suspendu : ${tag || body.userId} (${body.userId}). Raison : ${body.reason || 'Aucune'}${body.cascade ? ' | Purge en cascade déclenchée.' : ''}`,
                  channelId: null
                });

                json(res, 201, { suspended, cascade: cascadeResult });
              } catch (err) {
                logger.error('InvitationsAPI', 'Error suspending inviter:', err);
                json(res, 500, { error: 'Erreur lors de la suspension du créateur d\'invitations' });
              }
              return;
            }

            // POST /api/dashboard/guilds/:guildId/invitations/inviters/:userId/purge
            if (parts.length === 8 && parts[5] === 'inviters' && parts[7] === 'purge' && req.method === 'POST') {
              if (!access.canModerateContent) {
                json(res, 403, { error: 'Accès refusé : Action de modération requise.' });
                return;
              }

              const inviterId = parts[6];
              try {
                const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
                if (!discordGuild) {
                  json(res, 404, { error: 'Serveur Discord introuvable' });
                  return;
                }

                const joins = await prisma.memberInvite.findMany({
                  where: { guildId, inviterId, leftAt: null }
                });

                let purgedCount = 0;
                let failedCount = 0;

                for (const join of joins) {
                  const member = await discordGuild.members.fetch(join.userId).catch(() => null);
                  if (member) {
                    try {
                      await member.kick(`[Purge Sécurité] Expulsion en cascade des membres invités par : ${inviterId}`);
                      purgedCount++;
                      await prisma.memberInvite.updateMany({
                        where: { guildId, inviterId, userId: join.userId },
                        data: { leftAt: new Date() }
                      }).catch(() => null);
                    } catch (e) {
                      failedCount++;
                    }
                  }
                }

                await pushAudit(guildId, {
                  user: auditUser,
                  action: 'Purge membres créateur invitation',
                  context: getGuildName(client, guildId),
                  module: 'Invitations',
                  eventType: 'Manuel',
                  details: `Purge cascade pour le créateur ${inviterId}. Membres exclus : ${purgedCount}, Échecs : ${failedCount}.`,
                  channelId: null
                });

                json(res, 200, { ok: true, purgedCount, failedCount });
              } catch (err) {
                logger.error('InvitationsAPI', 'Error purging inviter members:', err);
                json(res, 500, { error: 'Erreur lors de la purge en cascade du créateur' });
              }
              return;
            }

            // DELETE /api/dashboard/guilds/:guildId/invitations/suspended-inviters/:userId
            if (parts.length === 7 && parts[5] === 'suspended-inviters' && req.method === 'DELETE') {
              if (!access.canModerateContent) {
                json(res, 403, { error: 'Accès refusé : Action de modération requise.' });
                return;
              }
              const userId = parts[6];
              try {
                await prisma.suspendedInviter.delete({
                  where: {
                    guildId_userId: { guildId, userId }
                  }
                });

                await pushAudit(guildId, {
                  user: auditUser,
                  action: "Restauration créateur invitations",
                  context: getGuildName(client, guildId),
                  module: 'Invitations',
                  eventType: 'Manuel',
                  details: `Créateur d'invitations réhabilité : ${userId}`,
                  channelId: null
                });

                json(res, 200, { ok: true });
              } catch (err) {
                logger.error('InvitationsAPI', 'Error removing suspended inviter:', err);
                json(res, 500, { error: 'Erreur lors de la réhabilitation du créateur d\'invitations' });
              }
              return;
            }

            // GET /api/dashboard/guilds/:guildId/invitations/:code
            if (parts.length === 6 && req.method === 'GET') {
              const code = parts[5];
              try {
                const invite = await prisma.guildInvite.findUnique({
                  where: { code }
                });
                if (!invite || invite.guildId !== guildId) {
                  json(res, 404, { error: 'Invitation introuvable' });
                  return;
                }
                const joins = await prisma.memberInvite.findMany({
                  where: { inviteCode: code, guildId },
                  orderBy: { joinedAt: 'desc' }
                });

                const userIds = [...new Set(joins.map((j) => j.userId))];
                const profiles = userIds.length
                  ? await prisma.memberProfile.findMany({
                    where: { guildId, userId: { in: userIds } },
                    select: { userId: true, displayName: true, username: true, avatarUrl: true, isBot: true, guildLeftAt: true }
                  })
                  : [];
                const profileMap = new Map(profiles.map((p) => [p.userId, p]));
                const enrichedJoins = joins.map((join) => {
                  const profile = profileMap.get(join.userId);
                  return {
                    ...join,
                    userTag: profile?.displayName ?? profile?.username ?? `Utilisateur ${join.userId}`,
                    avatarUrl: profile?.avatarUrl ?? null,
                    isBot: profile?.isBot ?? false,
                    guildLeftAt: profile?.guildLeftAt ?? null
                  };
                });

                const daysRaw = Number(url.searchParams.get('days') || '30');
                const days = Number.isFinite(daysRaw) ? Math.min(Math.max(daysRaw, 1), 365) : 30;
                const now = new Date();
                const startDate = new Date(now);
                startDate.setDate(startDate.getDate() - (days - 1));
                startDate.setHours(0, 0, 0, 0);

                const trendJoins = await prisma.memberInvite.findMany({
                  where: { guildId, inviteCode: code, joinedAt: { gte: startDate } },
                  select: { joinedAt: true }
                });

                const countsByDate = new Map<string, number>();
                for (const entry of trendJoins) {
                  const dateKey = entry.joinedAt.toISOString().split('T')[0];
                  countsByDate.set(dateKey, (countsByDate.get(dateKey) ?? 0) + 1);
                }

                const labels: string[] = [];
                const counts: number[] = [];
                for (let i = 0; i < days; i++) {
                  const d = new Date(startDate);
                  d.setDate(startDate.getDate() + i);
                  const key = d.toISOString().split('T')[0];
                  labels.push(key);
                  counts.push(countsByDate.get(key) ?? 0);
                }

                const totalJoined = joins.length;
                const totalLeft = joins.filter((j) => j.leftAt).length;

                json(res, 200, {
                  invite,
                  joins: enrichedJoins,
                  trend: { labels, counts, totalJoined, totalLeft, totalStayed: totalJoined - totalLeft }
                });
              } catch (err) {
                logger.error('InvitationsAPI', 'Error fetching single invitation details:', err);
                json(res, 500, { error: 'Erreur lors de la récupération du détail de l\'invitation' });
              }
              return;
            }

            // PUT /api/dashboard/guilds/:guildId/invitations/:code/suspend
            if (parts.length === 7 && parts[6] === 'suspend' && req.method === 'PUT') {
              if (!access.canModerateContent) {
                json(res, 403, { error: 'Accès refusé : Action de modération requise.' });
                return;
              }
              const code = parts[5];
              const body = await readJsonBody<{ suspended: boolean }>(req);

              try {
                const invite = await prisma.guildInvite.findUnique({ where: { code } });
                if (!invite || invite.guildId !== guildId) {
                  json(res, 404, { error: 'Invitation introuvable' });
                  return;
                }

                const updated = await prisma.guildInvite.update({
                  where: { code },
                  data: { isSuspended: !!body?.suspended }
                });

                await pushAudit(guildId, {
                  user: auditUser,
                  action: body?.suspended ? "Suspension invitation" : "Restauration invitation",
                  context: getGuildName(client, guildId),
                  module: 'Invitations',
                  eventType: 'Manuel',
                  details: `Invitation ${code} ${body?.suspended ? 'suspendue' : 'restaurée'}.`,
                  channelId: null
                });

                json(res, 200, { ok: true, invite: updated });
              } catch (err) {
                logger.error('InvitationsAPI', 'Error toggling invite suspension:', err);
                json(res, 500, { error: 'Erreur lors de la modification du statut de suspension' });
              }
              return;
            }

            // POST /api/dashboard/guilds/:guildId/invitations/:code/purge
            if (parts.length === 7 && parts[6] === 'purge' && req.method === 'POST') {
              if (!access.canModerateContent) {
                json(res, 403, { error: 'Accès refusé : Action de modération requise.' });
                return;
              }
              const code = parts[5];

              try {
                const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
                if (!discordGuild) {
                  json(res, 404, { error: 'Serveur Discord introuvable' });
                  return;
                }

                const joins = await prisma.memberInvite.findMany({
                  where: { inviteCode: code, leftAt: null }
                });

                let purgedCount = 0;
                let failedCount = 0;

                for (const join of joins) {
                  const member = await discordGuild.members.fetch(join.userId).catch(() => null);
                  if (member) {
                    try {
                      await member.kick(`[Purge Sécurité] Expulsion en masse des membres liés au code : ${code}`);
                      purgedCount++;
                      
                      await prisma.memberInvite.updateMany({
                        where: { inviteCode: code, userId: join.userId },
                        data: { leftAt: new Date() }
                      }).catch(() => null);
                    } catch (e) {
                      failedCount++;
                    }
                  }
                }

                await pushAudit(guildId, {
                  user: auditUser,
                  action: "Purge membres invitation",
                  context: getGuildName(client, guildId),
                  module: 'Invitations',
                  eventType: 'Manuel',
                  details: `Purge effectuée pour le code ${code}. Membres exclus avec succès : ${purgedCount}, Échecs : ${failedCount}.`,
                  channelId: null
                });

                json(res, 200, { ok: true, purgedCount, failedCount });
              } catch (err) {
                logger.error('InvitationsAPI', 'Error purging members on invitation:', err);
                json(res, 500, { error: 'Erreur lors de la purge en masse de l\'invitation' });
              }
              return;
            }

            // DELETE /api/dashboard/guilds/:guildId/invitations/:code
            if (parts.length === 6 && req.method === 'DELETE') {
              if (!access.canModerateContent) {
                json(res, 403, { error: 'Accès refusé : Action de modération requise.' });
                return;
              }
              const code = parts[5];

              try {
                const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
                if (discordGuild) {
                  const invites = await discordGuild.invites.fetch().catch(() => null);
                  const targetInvite = invites?.find(inv => inv.code === code);
                  if (targetInvite) {
                    await targetInvite.delete("Suppression depuis le Dashboard").catch(e => {
                      logger.warn('DashboardAPI', `Impossible de supprimer l'invitation ${code} de Discord :`, e);
                    });
                  }
                }

                const updated = await prisma.guildInvite.update({
                  where: { code },
                  data: { isDeleted: true }
                }).catch(() => null);

                await pushAudit(guildId, {
                  user: auditUser,
                  action: "Suppression invitation",
                  context: getGuildName(client, guildId),
                  module: 'Invitations',
                  eventType: 'Manuel',
                  details: `Invitation ${code} supprimée de Discord et marquée supprimée en BDD.`,
                  channelId: null
                });

                json(res, 200, { ok: true });
              } catch (err) {
                logger.error('InvitationsAPI', 'Error deleting invitation:', err);
                json(res, 500, { error: 'Erreur lors de la suppression de l\'invitation' });
              }
              return;
            }
          }

          if (parts.length === 5 && parts[4] === 'leadership' && req.method === 'GET') {
            try {
              const metrics = await getStaffAlertsAndProgression(guildId);
              json(res, 200, { metrics });
            } catch (err) {
              logger.error('StaffAPI', 'Error getting leadership metrics:', err);
              json(res, 500, { error: 'Erreur lors de la récupération des métriques leadership' });
            }
            return;
          }

          if (parts.length === 5 && parts[4] === 'absences' && req.method === 'GET') {
            try {
              const absences = await getAbsences(guildId);
              json(res, 200, { absences });
            } catch (err) {
              logger.error('StaffAPI', 'Error getting absences:', err);
              json(res, 500, { error: 'Erreur lors de la récupération des absences' });
            }
            return;
          }

          if (parts.length === 6 && parts[4] === 'absences' && parts[5] === 'calendar-data' && req.method === 'GET') {
            const startStr = url.searchParams.get('start');
            const endStr = url.searchParams.get('end');
            const staffIdsStr = url.searchParams.get('staffIds');

            if (!startStr || !endStr) {
              json(res, 400, { error: 'start et end sont obligatoires' });
              return;
            }

            try {
              const start = new Date(startStr);
              const end = new Date(endStr);
              const staffIds = staffIdsStr ? staffIdsStr.split(',') : undefined;

              const data = await getStaffCalendarData(guildId, start, end, staffIds);
              json(res, 200, data);
            } catch (err) {
              logger.error('StaffAPI', `Error getting calendar data for guild ${guildId}:`, err);
              json(res, 500, { error: 'Erreur lors de la récupération des données du calendrier' });
            }
            return;
          }

          if (parts.length === 6 && parts[4] === 'absences' && parts[5] === 'config' && req.method === 'GET') {
            try {
              const config = await prisma.dashboardFeatureConfig.findUnique({
                where: { guildId_featureKey: { guildId, featureKey: 'absences' } },
                include: { roleAccess: true, roleAccessByRole: true, notificationTargets: true }
              });
              json(res, 200, { config });
            } catch (err) {
              logger.error('StaffAPI', 'Error getting absence config:', err);
              json(res, 500, { error: 'Erreur lors de la récupération de la configuration' });
            }
            return;
          }

          if (parts.length === 6 && parts[4] === 'absences' && parts[5] === 'config' && req.method === 'POST') {
            if (!access.canManageSettings) {
              json(res, 403, { error: 'Accès refusé' });
              return;
            }

            const body = await readJsonBody<{
              managerRoleLevels: number[];
              webhookUrl?: string | null;
              channelId?: string | null;
              notificationRoleId?: string | null;
              notifyViaDiscordChannel?: boolean;
            }>(req);

            try {
              const currentConfig = await prisma.dashboardFeatureConfig.findUnique({
                where: { guildId_featureKey: { guildId, featureKey: 'absences' } }
              });

              const currentMetadata = (currentConfig?.metadata as Record<string, any>) || {};
              const updatedMetadata = {
                ...currentMetadata,
                webhookUrl: body.webhookUrl !== undefined ? body.webhookUrl : currentMetadata.webhookUrl
              };

              const config = await prisma.dashboardFeatureConfig.upsert({
                where: { guildId_featureKey: { guildId, featureKey: 'absences' } },
                update: {
                  featureName: 'Absences Staff',
                  channelId: body.channelId !== undefined ? body.channelId : undefined,
                  notificationRoleId: body.notificationRoleId !== undefined ? body.notificationRoleId : undefined,
                  notifyViaDiscordChannel: body.notifyViaDiscordChannel !== undefined ? body.notifyViaDiscordChannel : undefined,
                  metadata: updatedMetadata,
                },
                create: {
                  guildId,
                  featureKey: 'absences',
                  featureName: 'Absences Staff',
                  channelId: body.channelId ?? null,
                  notificationRoleId: body.notificationRoleId ?? null,
                  notifyViaDiscordChannel: body.notifyViaDiscordChannel ?? true,
                  metadata: updatedMetadata,
                }
              });

              // Update role access
              await prisma.dashboardRoleAccess.deleteMany({
                where: { featureConfigId: config.id }
              });

              if (body.managerRoleLevels && body.managerRoleLevels.length > 0) {
                await prisma.dashboardRoleAccess.createMany({
                  data: body.managerRoleLevels.map(level => ({
                    guildId,
                    featureConfigId: config.id,
                    staffRoleLevel: level,
                    canModerate: true,
                    canView: true
                  }))
                });
              }

              json(res, 200, { ok: true });
            } catch (err) {
              logger.error('StaffAPI', 'Error updating absence config:', err);
              json(res, 500, { error: 'Erreur lors de la mise à jour de la configuration' });
            }
            return;
          }

          // GET /api/dashboard/guilds/:guildId/notifications/features
          if (parts.length === 6 && parts[4] === 'notifications' && parts[5] === 'features' && req.method === 'GET') {
            try {
              const { getOrCreateFeatureConfigs } = await import('../services/dashboardManagementService.js');
              const features = await getOrCreateFeatureConfigs(guildId);
              json(res, 200, { features });
            } catch (err) {
              logger.error('NotificationsAPI', 'Error getting feature configs:', err);
              json(res, 500, { error: 'Erreur lors de la récupération des configurations des modules' });
            }
            return;
          }

          // PATCH /api/dashboard/guilds/:guildId/notifications/features/:featureKey
          if (parts.length === 7 && parts[4] === 'notifications' && parts[5] === 'features' && req.method === 'PATCH') {
            if (!access.canManageSettings) {
              json(res, 403, { error: 'Accès refusé' });
              return;
            }
            const featureKey = parts[6];
            const body = await readJsonBody<any>(req);
            try {
              const { updateFeatureConfig } = await import('../services/dashboardManagementService.js');
              const config = await updateFeatureConfig(guildId, featureKey, body);
              json(res, 200, { config });
            } catch (err) {
              logger.error('NotificationsAPI', `Error updating feature config ${featureKey}:`, err);
              json(res, 500, { error: 'Erreur lors de la mise à jour de la configuration du module' });
            }
            return;
          }

          if (parts.length === 5 && parts[4] === 'absences' && req.method === 'POST') {
            const body = await readJsonBody<{
              staffUserId: string;
              type: string;
              startDate: string;
              endDate?: string;
              reason: string;
              superiorUserId: string;
              message?: string;
              confirmIndefinite?: boolean;
            }>(req);

            if (!body?.staffUserId || !body?.type || !body?.startDate || !body?.reason || !body?.superiorUserId) {
              json(res, 400, { error: 'staffUserId, type, startDate, reason et superiorUserId sont obligatoires' });
              return;
            }

            // Permettre aux staff de créer une absence pour eux-mêmes même s'ils ne sont pas admin
            if (!access.canManageSettings && body.staffUserId !== user.userId) {
              json(res, 403, { error: 'Vous ne pouvez créer des absences que pour vous-même.' });
              return;
            }

            const staffMember = await getStaffMember(guildId, body.staffUserId);
            if (!staffMember) {
              json(res, 404, { error: 'Le staff ciblé est introuvable' });
              return;
            }

            const superiorStaff = await getStaffMember(guildId, body.superiorUserId);
            if (!superiorStaff) {
              json(res, 400, { error: 'Le supérieur indiqué ne fait pas partie du staff' });
              return;
            }

            const startDate = new Date(body.startDate);
            const endDate = body.endDate ? new Date(body.endDate) : undefined;

            if (Number.isNaN(startDate.getTime()) || (endDate && Number.isNaN(endDate.getTime()))) {
              json(res, 400, { error: 'Date invalide' });
              return;
            }

            if (endDate && endDate < startDate) {
              json(res, 400, { error: 'La date de fin doit être postérieure ou égale à la date de début' });
              return;
            }

            if (!endDate && !body.confirmIndefinite) {
              json(res, 400, { error: 'Confirmez explicitement l\'absence indéterminée' });
              return;
            }

            try {
              const absence = await createAbsence({
                guildId,
                staffMemberId: staffMember.id,
                startDate,
                endDate,
                reason: body.reason,
                type: body.type,
                message: body.message,
                superiorUserId: body.superiorUserId,
              });

              await pushAudit(guildId, {
                user: auditUser,
                action: 'Création absence',
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Absence ${absence.id} créée pour ${body.staffUserId} (${body.type})`,
                channelId: null,
              });

              json(res, 201, { absence });
            } catch (err) {
              logger.error('StaffAPI', 'Error creating absence:', err);
              json(res, 500, { error: err instanceof Error ? err.message : 'Erreur lors de la création de l\'absence' });
            }
            return;
          }

          if (parts.length === 6 && parts[4] === 'absences' && req.method === 'PATCH') {
            const absenceId = parts[5];
            const body = await readJsonBody<{
              status: 'ACKNOWLEDGED' | 'APPROVED' | 'REJECTED' | 'CANCELED' | 'ENDED';
              note?: string;
            }>(req);

            if (!body?.status) {
              json(res, 400, { error: 'status est obligatoire' });
              return;
            }

            const allowedStatuses = new Set(['ACKNOWLEDGED', 'APPROVED', 'REJECTED', 'CANCELED', 'ENDED']);
            if (!allowedStatuses.has(body.status)) {
              json(res, 400, { error: 'Status absence invalide' });
              return;
            }

            try {
              const absence = await updateAbsenceStatus(absenceId, body.status, user.userId, body.note);

              await pushAudit(guildId, {
                user: auditUser,
                action: `Décision absence (${body.status})`,
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Absence ${absenceId} mise au statut ${body.status}`,
                channelId: null,
              });

              json(res, 200, { absence });
            } catch (err) {
              logger.error('StaffAPI', 'Error updating absence status:', err);
              json(res, 500, { error: 'Erreur lors de la mise à jour de l\'absence' });
            }
            return;
          }

          if (parts.length === 6 && parts[4] === 'absences' && req.method === 'DELETE') {
            const absenceId = parts[5];
            try {
              const absence = await prisma.staffAbsence.findUnique({
                where: { id: absenceId },
                include: { staffMember: true }
              });

              if (!absence) {
                json(res, 404, { error: 'Absence introuvable' });
                return;
              }

              const isOwner = absence.staffMember.userId === user.userId;
              if (!isOwner && !access.canManageSettings) {
                json(res, 403, { error: 'Vous ne pouvez supprimer que vos propres absences.' });
                return;
              }

              await deleteAbsence(guildId, absenceId);

              await pushAudit(guildId, {
                user: auditUser,
                action: 'Suppression absence',
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Absence ${absenceId} supprimée`,
                channelId: null,
              });

              json(res, 200, { ok: true });
            } catch (err) {
              logger.error('StaffAPI', 'Error deleting absence:', err);
              json(res, 500, { error: 'Erreur lors de la suppression de l\'absence' });
            }
            return;
          }

          if (parts.length === 5 && parts[4] === 'meetings' && req.method === 'GET') {
            try {
              const meetings = await getMeetings(guildId);
              json(res, 200, { meetings });
            } catch (err) {
              logger.error('StaffAPI', 'Error getting meetings:', err);
              json(res, 500, { error: 'Erreur lors de la récupération des réunions' });
            }
            return;
          }

          if (parts.length === 5 && parts[4] === 'meetings' && req.method === 'POST') {
            const body = await readJsonBody<{
              title: string;
              description?: string;
              scheduledAt: string;
            }>(req);

            if (!body?.title || !body?.scheduledAt) {
              json(res, 400, { error: 'title et scheduledAt sont obligatoires' });
              return;
            }

            const scheduledAt = new Date(body.scheduledAt);
            if (Number.isNaN(scheduledAt.getTime())) {
              json(res, 400, { error: 'Date de réunion invalide' });
              return;
            }

            try {
              const meeting = await createMeeting(
                client,
                guildId,
                user.userId,
                body.title,
                body.description || '',
                scheduledAt
              );

              await pushAudit(guildId, {
                user: auditUser,
                action: 'Création réunion',
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Réunion "${body.title}" planifiée pour le ${scheduledAt.toLocaleString('fr-FR')}`,
                channelId: null,
              });

              json(res, 201, { meeting });
            } catch (err: any) {
              logger.error('StaffAPI', 'Error creating meeting:', err);
              json(res, err.message?.includes('Configurez') ? 400 : 500, { error: err.message || 'Erreur lors de la création de la réunion' });
            }
            return;
          }

          if (parts.length === 6 && parts[4] === 'meetings' && req.method === 'PATCH') {
            const meetingId = parts[5];
            const body = await readJsonBody<{
              title?: string;
              description?: string;
              scheduledAt?: string;
              endedAt?: string;
              status?: 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELED';
            }>(req);

            try {
              const data: any = {};
              if (body?.title) data.title = body.title;
              if (body?.description !== undefined) data.description = body.description;
              if (body?.scheduledAt) data.scheduledAt = new Date(body.scheduledAt);
              if (body?.endedAt) data.endedAt = new Date(body.endedAt);
              if (body?.status) data.status = body.status;

              const meeting = await updateMeeting(client, guildId, meetingId, data);

              await pushAudit(guildId, {
                user: auditUser,
                action: 'Mise à jour réunion',
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Réunion ${meetingId} mise à jour. Statut: ${meeting.status}`,
                channelId: null,
              });

              json(res, 200, { meeting });
            } catch (err: any) {
              logger.error('StaffAPI', `Error updating meeting ${meetingId}: ${err.message}`, err.stack);
              json(res, 500, { error: 'Erreur lors de la mise à jour de la réunion', details: err.message });
            }
            return;
          }

          if (parts.length === 6 && parts[4] === 'meetings' && req.method === 'DELETE') {
            const meetingId = parts[5];
            const url = new URL(req.url!, `http://${req.headers.host}`);
            const deleteEvent = url.searchParams.get('deleteEvent') === 'true';
            const deleteMessage = url.searchParams.get('deleteMessage') === 'true';
            const deleteNotifications = url.searchParams.get('deleteNotifications') === 'true';

            try {
              await deleteMeeting(client, guildId, meetingId, { deleteEvent, deleteMessage, deleteNotifications });

              await pushAudit(guildId, {
                user: auditUser,
                action: 'Suppression réunion',
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Réunion ${meetingId} supprimée (Event: ${deleteEvent}, Msg: ${deleteMessage}, Notif: ${deleteNotifications}).`,
                channelId: null,
              });

              json(res, 200, { ok: true });
            } catch (err: any) {
              logger.error('StaffAPI', 'Error deleting meeting:', err);
              json(res, 500, { error: 'Erreur lors de la suppression de la réunion' });
            }
            return;
          }

          if (parts.length === 6 && parts[4] === 'modules' && req.method === 'PUT') {
            const moduleId = parts[5];
            const body = (await readJsonBody<{ status: ModuleStatus }> (req)) ?? { status: 'inactive' };

            const updates: Record<string, unknown> = {};
            if (moduleId === 'codepolice') updates.codePoliceEnabled = body.status === 'active';
            if (moduleId === 'dailyalgo' || moduleId === 'daily_algo') updates.dailyAlgoEnabled = body.status === 'active';
            if (moduleId === 'traduction' || moduleId === 'translation') updates.translationEnabled = body.status === 'active';
            if (moduleId === 'sanctions') updates.sanctionSyncEnabled = body.status === 'active';
            if (moduleId === 'nickname_moderation') updates.autoNicknameModerationEnabled = body.status === 'active';
            if (moduleId === 'auto_thread') updates.autoThreadEnabled = body.status === 'active';

            if (Object.keys(updates).length > 0) {
              await prisma.guild.update({ where: { id: guildId }, data: updates });
            }

            const normalizedKey = moduleId === 'dailyalgo'
              ? 'daily_algo'
              : moduleId === 'traduction'
                ? 'translation'
                : moduleId;
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

            if (moduleId === 'auto_thread') {
              const { invalidateAutoThreadCache } = await import('../events/autoThread.js');
              invalidateAutoThreadCache(guildId);
            }

            json(res, 200, { ok: true });
            return;
          }

          if (parts.length === 5 && parts[4] === 'presets' && req.method === 'POST') {
            const body = await readJsonBody<{ presetKey?: string }>(req);
            const presetKey = (body?.presetKey ?? '').trim() as DashboardPresetKey;

            if (!presetKey || !Object.keys(PRESET_LABELS).includes(presetKey)) {
              json(res, 400, { error: 'Preset invalide.' });
              return;
            }

            const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
            if (!discordGuild) {
              json(res, 404, { error: 'Serveur introuvable.' });
              return;
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
              return;
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

            const { applyPresetToFeatureAccess } = await import('../services/dashboardManagementService.js');
            await applyPresetToFeatureAccess(guildId, presetKey, { adminRoleIds, modRoleIds });

            await prisma.$transaction([
              prisma.guild.update({ where: { id: guildId }, data: moduleUpdates }),
              prisma.dashboardSettings.update({ where: { guildId }, data: { commandRestrictions } }),
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

            broadcastDashboardStateChange(guildId, 'preset_applied');
            json(res, 200, { ok: true });
            return;
          }



          if (parts.length === 6 && parts[4] === 'sanctions' && req.method === 'DELETE' && parts[5] !== 'reports') {
            if (access.level !== 'admin') {
              json(res, 403, { error: 'Seuls les administrateurs peuvent supprimer une infraction.' });
              return;
            }

            const sanctionId = parts[5];
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
              return;
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

            broadcastDashboardStateChange(guildId, 'sanction_deleted');
            json(res, 200, { ok: true });
            return;
          }

          if (parts.length === 6 && parts[4] === 'sanctions' && parts[5] === 'reports' && req.method === 'POST') {
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
              return;
            }

            if (!incidentAt || Number.isNaN(incidentAt.getTime())) {
              json(res, 400, { error: 'Date/heure de l\'incident invalide.' });
              return;
            }

            if (evidenceLinks.length === 0) {
              json(res, 400, { error: 'Au moins un lien de preuve valide est obligatoire.' });
              return;
            }

            const sanction = await prisma.sanction.findFirst({ where: { id: sanctionId, guildId } });
            if (!sanction) {
              json(res, 404, { error: 'Sanction liée introuvable sur ce serveur.' });
              return;
            }

            if (sanction.moderatorUserId !== user.userId) {
              json(res, 403, { error: 'Seule la personne qui a appliqué la sanction peut créer ce rapport.' });
              return;
            }

            const existingReport = await prisma.sanctionReport.findFirst({ where: { guildId, sanctionId } });
            if (existingReport) {
              json(res, 409, { error: 'Un rapport existe déjà pour cette sanction.' });
              return;
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
              return;
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
            return;
          }

          if (parts.length === 7 && parts[4] === 'sanctions' && parts[5] === 'reports' && req.method === 'PATCH') {
            const reportId = parts[6];
            const existingReport = await prisma.sanctionReport.findFirst({
              where: { id: reportId, guildId }
            });

            if (!existingReport) {
              json(res, 404, { error: 'Rapport introuvable.' });
              return;
            }

            if (existingReport.createdByUserId !== user.userId && access.level !== 'admin') {
              json(res, 403, { error: 'Seul l\'auteur du rapport ou un administrateur peut le modifier.' });
              return;
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
              : existingReport.evidenceLinks;

            const updatedAdditionalNotes = body?.additionalNotes !== undefined
              ? body.additionalNotes?.trim() || null
              : existingReport.additionalNotes;

            if (!updatedBrokenRules || !updatedDetailedReason) {
              json(res, 400, { error: 'Les champs de contenu du rapport sont obligatoires.' });
              return;
            }

            if (Array.isArray(updatedEvidenceLinks) && updatedEvidenceLinks.length === 0) {
              json(res, 400, { error: 'Au moins un lien de preuve valide est obligatoire.' });
              return;
            }

            await prisma.sanctionReport.update({
              where: { id: reportId },
              data: {
                brokenRules: updatedBrokenRules,
                detailedReason: updatedDetailedReason,
                evidenceLinks: updatedEvidenceLinks as any,
                additionalNotes: updatedAdditionalNotes,
              }
            });

            await pushAudit(guildId, {
              user: auditUser,
              action: 'Modification rapport sanction',
              context: getGuildName(client, guildId),
              module: 'Sanctions',
              eventType: 'Manuel',
              details: `Rapport ${reportId} modifié par ${user.username ?? user.userId}.`,
              channelId: null
            });

            broadcastDashboardStateChange(guildId, 'sanction_report_updated');
            json(res, 200, { ok: true });
            return;
          }


          // ---------------------------------------------------------------
          // GET  /api/dashboard/guilds/:guildId/nickname-moderation
          // PATCH /api/dashboard/guilds/:guildId/nickname-moderation
          // Gère uniquement le flag `enabled`. Les mots bannis sont gérés
          // par les endpoints /banned-words ci-dessous.
          // ---------------------------------------------------------------
          if (parts.length === 5 && parts[4] === 'nickname-moderation') {
            if (req.method === 'GET') {
              try {
                const guild = await prisma.guild.findUnique({
                  where: { id: guildId },
                  select: { autoNicknameModerationEnabled: true },
                });
                if (!guild) {
                  json(res, 404, { error: 'Serveur introuvable' });
                  return;
                }
                json(res, 200, { enabled: guild.autoNicknameModerationEnabled });
              } catch (err) {
                logger.error('NicknameAPI', 'GET nickname-moderation error:', err);
                json(res, 500, { error: 'Erreur lors de la récupération de la configuration' });
              }
              return;
            }

            if (req.method === 'PATCH') {
              const body = await readJsonBody<{ enabled?: boolean }>(req);
              if (!body || !Object.prototype.hasOwnProperty.call(body, 'enabled')) {
                json(res, 400, { error: 'Payload invalide — champ `enabled` requis' });
                return;
              }

              try {
                await prisma.guild.update({
                  where: { id: guildId },
                  data: { autoNicknameModerationEnabled: !!body.enabled },
                });

                const { invalidateNicknameModerationCache } = await import('../events/nicknameModeration.js');
                invalidateNicknameModerationCache(guildId);

                await pushAudit(guildId, {
                  user: auditUser,
                  action: 'Mise à jour modération pseudos',
                  context: getGuildName(client, guildId),
                  module: 'Modération des pseudos',
                  eventType: 'Manuel',
                  details: `Activé: ${body.enabled}`,
                  channelId: null,
                });

                json(res, 200, { ok: true });
              } catch (err) {
                logger.error('NicknameAPI', 'PATCH nickname-moderation error:', err);
                json(res, 500, { error: 'Erreur lors de la mise à jour' });
              }
              return;
            }
          }

          // ---------------------------------------------------------------
          // GET  /api/dashboard/guilds/:guildId/auto-thread
          // PATCH /api/dashboard/guilds/:guildId/auto-thread
          // ---------------------------------------------------------------
          if (parts.length === 5 && parts[4] === 'auto-thread') {
            if (req.method === 'GET') {
              try {
                const guild = await prisma.guild.findUnique({
                  where: { id: guildId },
                  select: { autoThreadEnabled: true, autoThreadChannels: true },
                });
                if (!guild) {
                  json(res, 404, { error: 'Serveur introuvable' });
                  return;
                }
                json(res, 200, { enabled: guild.autoThreadEnabled, channels: guild.autoThreadChannels });
              } catch (err) {
                logger.error('AutoThreadAPI', 'GET auto-thread error:', err);
                json(res, 500, { error: 'Erreur lors de la récupération de la configuration' });
              }
              return;
            }

            if (req.method === 'PATCH') {
              const body = await readJsonBody<{ enabled?: boolean; channels?: string[] }>(req);
              if (!body) {
                json(res, 400, { error: 'Payload settings invalide' });
                return;
              }

              const data: any = {};
              if (Object.prototype.hasOwnProperty.call(body, 'enabled')) {
                data.autoThreadEnabled = !!body.enabled;
              }
              if (Object.prototype.hasOwnProperty.call(body, 'channels')) {
                data.autoThreadChannels = body.channels;
              }

              try {
                await prisma.guild.update({
                  where: { id: guildId },
                  data,
                });

                const { invalidateAutoThreadCache } = await import('../events/autoThread.js');
                invalidateAutoThreadCache(guildId);

                // Sync with DashboardFeatureConfig
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
              return;
            }
          }

          // ---------------------------------------------------------------
          // CRUD /api/dashboard/guilds/:guildId/banned-words
          // Service partagé : utilisable par automod pseudos, messages, etc.
          // ---------------------------------------------------------------

          // GET  /banned-words  → mots globaux + mots du serveur
          if (parts.length === 5 && parts[4] === 'banned-words' && req.method === 'GET') {
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
            return;
          }

          // POST /banned-words  → ajouter un mot personnalisé au serveur
          if (parts.length === 5 && parts[4] === 'banned-words' && req.method === 'POST') {
            const body = await readJsonBody<{ word: string; category?: string }>(req);
            if (!body?.word || typeof body.word !== 'string' || !body.word.trim()) {
              json(res, 400, { error: 'Champ `word` requis' });
              return;
            }

            const cleanWord = body.word.trim().toLowerCase().slice(0, 100);
            const category = ['custom', 'racism', 'threat', 'sexual', 'lgbtphobia', 'hate', 'insult'].includes(body.category ?? '')
              ? body.category!
              : 'custom';

            try {
              const created = await prisma.bannedWord.create({
                data: { guildId, word: cleanWord, category },
              });

              // Invalider le cache pour ce serveur
              const { invalidateBannedWordsCache } = await import('../services/bannedWordsService.js');
              invalidateBannedWordsCache(guildId);

              // Notifier tous les dashboards connectés en temps réel
              broadcastBannedWordsChange(guildId, 'added', cleanWord);

              await pushAudit(guildId, {
                user: auditUser,
                action: 'Ajout mot banni',
                context: getGuildName(client, guildId),
                module: 'Mots bannis',
                eventType: 'Manuel',
                details: `Mot "${cleanWord}" ajouté (catégorie: ${category})`,
                channelId: null,
              });

              json(res, 201, { ok: true, id: created.id });
            } catch (err: any) {
              if (err?.code === 'P2002') {
                json(res, 409, { error: 'Ce mot existe déjà sur ce serveur' });
              } else {
                logger.error('BannedWordsAPI', 'POST banned-words error:', err);
                json(res, 500, { error: 'Erreur lors de l\'ajout du mot' });
              }
            }
            return;
          }

          // PATCH /banned-words/:wordId  → activer/désactiver un mot du serveur
          if (parts.length === 6 && parts[4] === 'banned-words' && req.method === 'PATCH') {
            const wordId = parts[5];
            const body = await readJsonBody<{ enabled: boolean }>(req);
            if (!body || typeof body.enabled !== 'boolean') {
              json(res, 400, { error: 'Champ `enabled` requis (boolean)' });
              return;
            }

            try {
              const existing = await prisma.bannedWord.findFirst({
                where: { id: wordId, guildId },
              });
              if (!existing) {
                json(res, 404, { error: 'Mot introuvable' });
                return;
              }

              await prisma.bannedWord.update({ where: { id: wordId }, data: { enabled: body.enabled } });

              // Invalider le cache pour ce serveur
              const { invalidateBannedWordsCache } = await import('../services/bannedWordsService.js');
              invalidateBannedWordsCache(guildId);

              // Notifier tous les dashboards connectés
              broadcastBannedWordsChange(guildId, 'updated', existing.word);

              json(res, 200, { ok: true });
            } catch (err) {
              logger.error('BannedWordsAPI', 'PATCH banned-words error:', err);
              json(res, 500, { error: 'Erreur lors de la mise à jour' });
            }
            return;
          }

          // DELETE /banned-words/:wordId  → supprimer un mot personnalisé du serveur
          if (parts.length === 6 && parts[4] === 'banned-words' && req.method === 'DELETE') {
            const wordId = parts[5];
            try {
              const existing = await prisma.bannedWord.findFirst({
                where: { id: wordId, guildId },
              });
              if (!existing) {
                json(res, 404, { error: 'Mot introuvable ou non modifiable' });
                return;
              }

              await prisma.bannedWord.delete({ where: { id: wordId } });

              // Invalider le cache pour ce serveur
              const { invalidateBannedWordsCache } = await import('../services/bannedWordsService.js');
              invalidateBannedWordsCache(guildId);

              // Notifier tous les dashboards connectés
              broadcastBannedWordsChange(guildId, 'deleted', existing.word);

              await pushAudit(guildId, {
                user: auditUser,
                action: 'Suppression mot banni',
                context: getGuildName(client, guildId),
                module: 'Mots bannis',
                eventType: 'Manuel',
                details: `Mot "${existing.word}" supprimé`,
                channelId: null,
              });

              json(res, 200, { ok: true });
            } catch (err) {
              logger.error('BannedWordsAPI', 'DELETE banned-words error:', err);
              json(res, 500, { error: 'Erreur lors de la suppression' });
            }
            return;
          }

          if (parts.length === 5 && parts[4] === 'notifications' && req.method === 'PUT') {
            const body = await readJsonBody<NotificationSettings>(req);
            if (!body) {
              json(res, 400, { error: 'Payload notifications invalide' });
              return;
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
            return;
          }

          if (parts.length === 5 && parts[4] === 'settings' && (req.method === 'PATCH' || req.method === 'PUT')) {
            const body = await readJsonBody<{
              discordChannel?: string;
              logChannelId?: string | null;
              moderatorRoleId?: string | null;
              regulationChannelId?: string | null;
              propagateSanctions?: boolean;
              messageTemplate?: string;

              // Additional settings fields
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
              githubReleasesEnabled?: boolean;
              digestEnabled?: boolean;
              youtubeEnabled?: boolean;
              autoThreadEnabled?: boolean;
            }>(req);

            if (!body) {
              json(res, 400, { error: 'Payload settings invalide' });
              return;
            }

            const data: any = {};
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
            }
            if (Object.prototype.hasOwnProperty.call(body, 'propagateSanctions')) {
              data.propagateSanctions = !!body.propagateSanctions;
              data.sanctionSyncEnabled = !!body.propagateSanctions;
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

            // Sync with DashboardFeatureConfig
            const syncFeature = async (featureKey: string, featureName: string, enabled?: boolean, channelId?: string | null, secondaryChannelId?: string | null) => {
              const updateData: any = {};
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
            await syncFeature('dashboard', 'Vue d\'ensemble', undefined, data.publicChannelId, undefined);
            await syncFeature('news', 'Actualités & RSS', undefined, data.newsChannelId, undefined);
            await syncFeature('sanctions', 'Sanctions', data.propagateSanctions, undefined, undefined);
            await syncFeature('auto_thread', 'Auto-Thread', data.autoThreadEnabled, undefined, undefined);
            
            if (body.youtubeEnabled !== undefined) {
              await syncFeature('youtube', 'YouTube', body.youtubeEnabled, undefined, undefined);
            }

            const runtime = await getOrCreateRuntime(guildId);
            if (typeof body.messageTemplate === 'string') {
              await prisma.dashboardSettings.update({
                where: { guildId },
                data: { messageTemplate: body.messageTemplate }
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
            return;
          }

          if (parts.length === 6 && parts[4] === 'regulation' && parts[5] === 'articles' && req.method === 'POST') {
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
              return;
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

            broadcastDashboardStateChange(guildId, 'regulation_article_created');
            json(res, 201, { ok: true, articleId: article.id });
            return;
          }

          if (parts.length === 7 && parts[4] === 'regulation' && parts[5] === 'articles' && parts[6] === 'reorder' && req.method === 'PATCH') {
            const body = await readJsonBody<{ articleIds?: unknown }>(req);
            const requestedIds = Array.isArray(body?.articleIds)
              ? body.articleIds.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
              : [];

            if (requestedIds.length === 0) {
              json(res, 400, { error: 'La liste des articles à réordonner est invalide.' });
              return;
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

            broadcastDashboardStateChange(guildId, 'regulation_articles_reordered');
            json(res, 200, { ok: true });
            return;
          }

          if (parts.length === 7 && parts[4] === 'regulation' && parts[5] === 'articles' && req.method === 'PATCH') {
            const articleId = parts[6];
            const existingArticle = await prisma.guildRegulationArticle.findFirst({
              where: { id: articleId, guildId },
            });

            if (!existingArticle) {
              json(res, 404, { error: 'Article de règlement introuvable.' });
              return;
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
              return;
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

            broadcastDashboardStateChange(guildId, 'regulation_article_updated');
            json(res, 200, { ok: true });
            return;
          }

          if (parts.length === 7 && parts[4] === 'regulation' && parts[5] === 'articles' && req.method === 'DELETE') {
            const articleId = parts[6];
            const article = await prisma.guildRegulationArticle.findFirst({ where: { id: articleId, guildId } });

            if (!article) {
              json(res, 404, { error: 'Article de règlement introuvable.' });
              return;
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

            broadcastDashboardStateChange(guildId, 'regulation_article_deleted');
            json(res, 200, { ok: true });
            return;
          }

          if (parts.length === 6 && parts[4] === 'regulation' && parts[5] === 'publish' && req.method === 'POST') {
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

              broadcastDashboardStateChange(guildId, 'regulation_published');
              json(res, 200, { ok: true, mode: result.mode, messageId: result.messageId });
              return;
            } catch (error) {
              logger.error('DashboardAPI', `Erreur lors de la publication du règlement pour la guilde ${guildId}:`, error);
              json(res, 400, {
                error: error instanceof Error ? error.message : 'Impossible de publier le règlement.',
              });
              return;
            }
          }

          // GET /api/dashboard/guilds/:guildId/news
          if (parts.length === 5 && parts[4] === 'news' && req.method === 'GET') {
            try {
              const articles = await prisma.newsArticle.findMany({
                where: { guildId },
                orderBy: { publishedAt: 'desc' },
              });
              json(res, 200, articles);
            } catch (err: any) {
              logger.error('DashboardAPI', `Error listing news for guild ${guildId}: ${err.message}`);
              json(res, 500, { error: 'Erreur lors de la récupération des actualités' });
            }
            return;
          }

          // POST /api/dashboard/guilds/:guildId/news
          if (parts.length === 5 && parts[4] === 'news' && req.method === 'POST') {
            try {
              const body = await readJsonBody<{
                title: string;
                content: string;
                summary?: string;
                imageUrl?: string;
                category?: string;
                subcategory?: string;
                published?: boolean;
              }>(req);

              if (!body || !body.title || !body.content) {
                json(res, 400, { error: 'Le titre et le contenu sont requis.' });
                return;
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
                await publishNewsArticle(client, guildId, article.id).catch(err => {
                  logger.error('DashboardAPI', `Failed to send news notification to Discord for article ${article.id}:`, err);
                });
              }

              json(res, 201, article);
            } catch (err: any) {
              logger.error('DashboardAPI', `Error creating news for guild ${guildId}: ${err.message}`);
              json(res, 500, { error: 'Erreur lors de la création de l\'actualité' });
            }
            return;
          }

          // PATCH /api/dashboard/guilds/:guildId/news/:articleId
          if (parts.length === 6 && parts[4] === 'news' && req.method === 'PATCH') {
            const articleId = parts[5];
            try {
              const existing = await prisma.newsArticle.findUnique({
                where: { id: articleId },
              });

              if (!existing || existing.guildId !== guildId) {
                json(res, 404, { error: 'Actualité introuvable' });
                return;
              }

              const body = await readJsonBody<{
                title?: string;
                content?: string;
                summary?: string;
                imageUrl?: string;
                category?: string;
                subcategory?: string;
                published?: boolean;
              }>(req);

              if (!body) {
                json(res, 400, { error: 'Données manquantes' });
                return;
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
                await publishNewsArticle(client, guildId, updated.id).catch(err => {
                  logger.error('DashboardAPI', `Failed to send news notification to Discord for article ${updated.id}:`, err);
                });
              }

              json(res, 200, updated);
            } catch (err: any) {
              logger.error('DashboardAPI', `Error updating news article ${articleId}: ${err.message}`);
              json(res, 500, { error: 'Erreur lors de la modification de l\'actualité' });
            }
            return;
          }

          // DELETE /api/dashboard/guilds/:guildId/news/:articleId
          if (parts.length === 6 && parts[4] === 'news' && req.method === 'DELETE') {
            const articleId = parts[5];
            try {
              const existing = await prisma.newsArticle.findUnique({
                where: { id: articleId },
              });

              if (!existing || existing.guildId !== guildId) {
                json(res, 404, { error: 'Actualité introuvable' });
                return;
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
            } catch (err: any) {
              logger.error('DashboardAPI', `Error deleting news article ${articleId}: ${err.message}`);
              json(res, 500, { error: 'Erreur lors de la suppression de l\'actualité' });
            }
            return;
          }

          // GET /api/dashboard/guilds/:guildId/news/category-configs
          if (parts.length === 6 && parts[4] === 'news' && parts[5] === 'category-configs' && req.method === 'GET') {
            try {
              const configs = await prisma.newsCategoryConfig.findMany({
                where: { guildId },
                orderBy: { category: 'asc' },
              });
              json(res, 200, configs);
            } catch (err: any) {
              logger.error('DashboardAPI', `Error listing news category configs for guild ${guildId}: ${err.message}`);
              json(res, 500, { error: 'Erreur lors de la récupération de la configuration des catégories' });
            }
            return;
          }

          // POST /api/dashboard/guilds/:guildId/news/category-configs
          if (parts.length === 6 && parts[4] === 'news' && parts[5] === 'category-configs' && req.method === 'POST') {
            try {
              const body = await readJsonBody<{
                category: string;
                subcategory?: string;
                channelId: string;
              }>(req);

              if (!body || !body.category || !body.channelId) {
                json(res, 400, { error: 'La catégorie et le salon Discord sont requis.' });
                return;
              }

              const category = body.category.trim();
              const subcategory = (body.subcategory || '').trim();
              const channelId = body.channelId.trim();

              const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
              if (!discordGuild) {
                json(res, 404, { error: 'Serveur introuvable' });
                return;
              }
              const channel = await discordGuild.channels.fetch(channelId).catch(() => null);
              if (!channel) {
                json(res, 400, { error: 'Le salon Discord spécifié est introuvable ou inaccessible.' });
                return;
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
            } catch (err: any) {
              logger.error('DashboardAPI', `Error saving news category config for guild ${guildId}: ${err.message}`);
              json(res, 500, { error: 'Erreur lors de l\'enregistrement de la configuration de catégorie' });
            }
            return;
          }

          // DELETE /api/dashboard/guilds/:guildId/news/category-configs/:id
          if (parts.length === 7 && parts[4] === 'news' && parts[5] === 'category-configs' && req.method === 'DELETE') {
            const configId = parts[6];
            try {
              const existing = await prisma.newsCategoryConfig.findUnique({
                where: { id: configId },
              });

              if (!existing || existing.guildId !== guildId) {
                json(res, 404, { error: 'Configuration de catégorie introuvable' });
                return;
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
            } catch (err: any) {
              logger.error('DashboardAPI', `Error deleting news category config ${configId}: ${err.message}`);
              json(res, 500, { error: 'Erreur lors de la suppression de la configuration de catégorie' });
            }
            return;
          }

          if (parts.length === 5 && parts[4] === 'command-access' && req.method === 'PUT') {
            const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
            const member = discordGuild ? await discordGuild.members.fetch(user.userId).catch(() => null) : null;
            const roleIds = member?.roles.cache.map((role) => role.id) ?? [];
            const featureAccess = await resolveFeatureAccessMap(client, guildId, access, user.userId, roleIds);

            if (!featureAccess.commands?.canConfigure && !access.canManageSettings) {
              json(res, 403, { error: 'Accès refusé. Permissions insuffisantes.' });
              return;
            }

            const body = await readJsonBody<{ commandRestrictions?: unknown }>(req);
            if (!body) {
              json(res, 400, { error: 'Payload de restrictions invalide' });
              return;
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
            return;
          }

          if (parts.length === 5 && parts[4] === 'template' && req.method === 'PUT') {
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
            return;
          }

          if (parts.length === 5 && parts[4] === 'daily-algo-problems' && req.method === 'GET') {
            const problems = await prisma.dailyAlgoProblem.findMany({
              orderBy: [
                { usedAt: { sort: 'asc', nulls: 'first' } },
                { createdAt: 'desc' },
              ]
            });
            json(res, 200, problems);
            return;
          }

          if (parts.length === 6 && parts[4] === 'daily-algo-submissions' && parts[5] === 'global-leaderboard' && req.method === 'GET') {
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
              const totalPoints = finalScore !== null
                ? Math.round((finalScore + (submission.speedBonusPoints ?? 0)) * 10) / 10
                : null;

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

            // Sort by totalPoints desc, then speedRank or submittedAt
            submissions.sort((a, b) => {
              if ((b.totalPoints ?? 0) !== (a.totalPoints ?? 0)) return (b.totalPoints ?? 0) - (a.totalPoints ?? 0);
              return new Date(a.submittedAt).getTime() - new Date(b.submittedAt).getTime();
            });

            json(res, 200, { dateKey, submissions });
            return;
          }

          if (parts.length === 6 && parts[4] === 'daily-algo-submissions' && parts[5] === 'today' && req.method === 'GET') {
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
              return;
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
              const totalPoints = finalScore !== null
                ? Math.round((finalScore + (submission.speedBonusPoints ?? 0)) * 10) / 10
                : null;

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
            return;
          }

          if (parts.length === 6 && parts[4] === 'daily-algo-submissions' && parts[5] === 'history' && req.method === 'GET') {
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
                  finalScore: resolveDailyAlgoFinalScore(submission),
                  id: submission.id,
                  authorName: submission.authorName,
                  totalPoints: 0,
                  scoreFinal: null,
                  speedBonusPoints: submission.speedBonusPoints,
                  speedRank: submission.speedRank,
                }))
                .map((entry) => ({
                  ...entry,
                  totalPoints: entry.finalScore !== null
                    ? Math.round(((entry.finalScore + (entry.speedBonusPoints ?? 0)) * 10)) / 10
                    : null,
                  scoreFinal: entry.finalScore,
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
            return;
          }

          if (parts.length === 6 && parts[4] === 'daily-algo-submissions' && req.method === 'GET') {
            const submissionId = parts[5];
            try {
              const submission = await prisma.dailyAlgoSubmission.findUnique({
                where: { id: submissionId }
              });

              if (!submission) {
                json(res, 404, { error: 'Soumission introuvable' });
                return;
              }

              const finalScore = resolveDailyAlgoFinalScore(submission);
              const totalPoints = finalScore !== null
                ? Math.round((finalScore + (submission.speedBonusPoints ?? 0)) * 10) / 10
                : null;

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
            return;
          }

          if (parts.length === 6 && parts[4] === 'daily-algo-submissions' && req.method === 'PATCH') {
            const submissionId = parts[5];
            const body = await readJsonBody<{
              action?: 'approve' | 'reject';
              feedback?: string;
              scores?: {
                correctness?: number;
                comments?: number;
                compactness?: number;
                optimization?: number;
                readability?: number;
              };
            }>(req);

            if (!body?.action || !['approve', 'reject'].includes(body.action)) {
              json(res, 400, { error: 'Action Daily Algo invalide.' });
              return;
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
                return;
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
                return;
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
              return;
            }

            await pushAudit(guildId, {
              user: auditUser,
              action: body.action === 'approve' ? 'Validation soumission Daily Algo' : 'Rejet soumission Daily Algo',
              context: getGuildName(client, guildId),
              module: 'Daily Algo',
              eventType: 'Manuel',
              details: body.action === 'approve'
                ? `Soumission ${submissionId} validée avec notation.`
                : `Soumission ${submissionId} rejetée.`,
              channelId: null,
            });

            broadcastDashboardStateChange(guildId, 'daily_algo_submission_reviewed');
            json(res, 200, { ok: true });
            return;
          }

          if (parts.length === 5 && parts[4] === 'daily-algo-problems' && req.method === 'POST') {
            const MAIN_GUILD_ID = '1477350874740424986';
            const isBotAdmin = await resolveAdminAccess(client, user.userId);
            
            // On vérifie si c'est le serveur principal OU si c'est l'admin du bot
            if (guildId !== MAIN_GUILD_ID && !isBotAdmin) {
              json(res, 403, { error: 'Seul le serveur principal peut ajouter des exercices.' });
              return;
            }

            const body = await readJsonBody<{ title: string; description: string; solution: string; difficulty: string; language: string }>(req);
            if (!body || !body.title || !body.description || !body.solution) {
              json(res, 400, { error: 'Payload invalide : champs manquants' });
              return;
            }

            const problem = await prisma.dailyAlgoProblem.create({
              data: {
                title: body.title,
                description: body.description,
                solution: body.solution,
                difficulty: body.difficulty || 'moyen',
                language: body.language || 'fr',
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

            json(res, 201, problem);
            return;
          }

          if (parts.length === 6 && parts[4] === 'daily-algo-runs' && parts[5] === 'schedule' && req.method === 'GET') {
            try {
              const daysBack = Number(url.searchParams.get('daysBack') ?? '7');
              const daysForward = Number(url.searchParams.get('daysForward') ?? '21');
              const runs = await getDailyAlgoScheduleRuns(guildId, daysBack, daysForward);
              json(res, 200, { runs });
            } catch (err) {
              logger.error('DashboardAPI', 'Erreur lors de la récupération du planning Daily Algo:', err);
              json(res, 500, { error: 'Erreur lors de la récupération du planning Daily Algo' });
            }
            return;
          }

          if (parts.length === 7 && parts[4] === 'daily-algo-runs' && parts[5] === 'schedule' && parts[6] === 'ensure' && req.method === 'POST') {
            try {
              const body = await readJsonBody<{ daysForward?: unknown }>(req);
              const parsedDaysForward = Number(body?.daysForward ?? url.searchParams.get('daysForward') ?? '21');
              const daysForward = Number.isFinite(parsedDaysForward) ? parsedDaysForward : 21;
              const result = await ensureDailyAlgoScheduleRuns(guildId, daysForward);
              json(res, 200, { ok: true, ...result });
            } catch (err) {
              logger.error('DashboardAPI', 'Erreur lors de la génération du planning Daily Algo:', err);
              json(res, 500, { error: err instanceof Error ? err.message : 'Erreur lors de la génération du planning Daily Algo' });
            }
            return;
          }

          if (parts.length === 5 && parts[4] === 'import' && req.method === 'POST') {
            const body = await readJsonBody<DashboardState>(req);
            if (!body) {
              json(res, 400, { error: 'Payload import invalide' });
              return;
            }

            const runtime = await getOrCreateRuntime(guildId);
            await prisma.dashboardSettings.update({
              where: { guildId },
              data: {
                email: body.notifications?.email ?? runtime.email,
                emailEnabled: !!body.notifications?.emailEnabled,
                cloudBackup: !!body.notifications?.cloudBackup,
                debugLog: !!body.notifications?.debugLog,
                killSwitchEnabled: !!body.notifications?.killSwitchEnabled,
                severityByModule: body.notifications?.severityByModule ?? runtime.severityByModule,
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
            return;
          }
        }
      }

      // --- LOGS EVENT CONFIGS ROUTES ---
      if (parts.length >= 4 && parts[0] === 'api' && parts[1] === 'dashboard' && parts[2] === 'guilds' && parts[4] === 'logs') {
        const user = verifyAuth(req);
        if (!user) {
          json(res, 401, { error: 'Non authentifié' });
          return;
        }

        const guildId = parts[3];
        const access = await resolveDashboardAccess(client, guildId, user.userId);
        const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        const member = discordGuild ? await discordGuild.members.fetch(user.userId).catch(() => null) : null;
        const roleIds = member
          ? member.roles.cache
              .map((role) => role?.id)
              .filter((roleId): roleId is string => !!roleId)
          : [];
        const featureAccess = await resolveFeatureAccessMap(client, guildId, access, user.userId, roleIds);

        const isGetMethod = req.method === 'GET';
        if (!isGetMethod && !access.canManageSettings && !featureAccess.logs?.canConfigure) {
          json(res, 403, { error: 'Accès refusé. Seuls les administrateurs peuvent modifier les logs.' });
          return;
        }

        if (isGetMethod && !access.canViewDashboard) {
           json(res, 403, { error: 'Accès refusé. Vous n\'avez pas accès au dashboard.' });
           return;
        }

        const auditUser = user.username ?? `User${user.userId}`;

        // GET /api/dashboard/guilds/:guildId/logs/event-configs
        if (parts.length === 6 && parts[5] === 'event-configs' && req.method === 'GET') {
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
          return;
        }

        // PUT /api/dashboard/guilds/:guildId/logs/event-configs
        if (parts.length === 6 && parts[5] === 'event-configs' && req.method === 'PUT') {
          const body = await readJsonBody<{
            configs: Array<{
              eventType: string;
              enabled: boolean;
              channelId: string | null;
            }>;
          }>(req);

          if (!body?.configs || !Array.isArray(body.configs)) {
            json(res, 400, { error: 'Format invalide. Liste de configurations attendue.' });
            return;
          }

          try {
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
          return;
        }
      }

      // --- STAFF MANAGEMENT ROUTES ---
      if (parts.length >= 3 && parts[0] === 'api' && parts[1] === 'dashboard') {
        const user = verifyAuth(req);
        if (!user) {
          json(res, 401, { error: 'Non authentifié' });
          return;
        }

        // GET /api/dashboard/.../users/:userId/profile - User profile
        const usersIdx = parts.indexOf('users');
        if (usersIdx !== -1 && parts[usersIdx + 2] === 'profile' && req.method === 'GET') {
          const userId = parts[usersIdx + 1];
          if (!userId) {
            json(res, 400, { error: 'userId manquant' });
            return;
          }

          try {
            const guildId = url.searchParams.get('guildId');
            if (!guildId) {
              json(res, 400, { error: 'guildId manquant' });
              return;
            }

            const accessLevel = await resolveDashboardAccess(client, guildId, user.userId);
            if (accessLevel.level === 'none') {
              json(res, 403, { error: 'Accès refusé' });
              return;
            }

            const requesterStaff = await getStaffMember(guildId, user.userId);
            if (!requesterStaff) {
              json(res, 403, { error: "Accès refusé. Vous devez faire partie de l'équipe staff pour voir ce profil." });
              return;
            }

            const snapshot = await getStaffProfileSnapshot(guildId, userId);
            if (!snapshot) {
              json(res, 404, { error: 'Membre du staff introuvable' });
              return;
            }

            const publicProfileRoleDisplay = snapshot.publicProfile
              ? await resolveProfileRoleDisplay(client, snapshot.publicProfile.guildId, snapshot.publicProfile.rolesSnapshot)
              : null;

            const isHighStaff = accessLevel.canManageSettings
              || ['admin', 'moderator'].includes(accessLevel.level)
              || (snapshot.staffMember.grade ?? '').toLowerCase().includes('direction');

            const accessibleTools: string[] = [];
            if (isHighStaff) {
              accessibleTools.push('Générateur Daily Algo');
              accessibleTools.push('Audit Code Police');
              accessibleTools.push('Management Staff');
              accessibleTools.push('Éditeur de Règlement');
            }

            const isOwnProfile = userId === user.userId;
            const isManagerOrAdmin = accessLevel.canManageSettings || ['admin', 'moderator'].includes(accessLevel.level);
            const canSeeSensitive = isOwnProfile || isManagerOrAdmin;

            json(res, 200, {
              staffMember: snapshot.staffMember,
              publicProfile: snapshot.publicProfile
                ? {
                    ...snapshot.publicProfile,
                    roles: publicProfileRoleDisplay?.roles ?? [],
                    primaryRole: publicProfileRoleDisplay?.primaryRole ?? null,
                  }
                : null,
              apiKeys: isOwnProfile
                ? snapshot.apiKeys.map((k) => ({
                    id: k.id,
                    displayKey: k.displayKey,
                    name: k.name,
                    permissions: k.permissions,
                    lastUsedAt: k.lastUsedAt,
                  }))
                : [],
              activeBlacklist: canSeeSensitive ? snapshot.activeBlacklist : null,
              blacklistHistory: canSeeSensitive ? snapshot.blacklistHistory : [],
              warnings: canSeeSensitive ? snapshot.warnings : [],
              testingPeriods: canSeeSensitive ? snapshot.testingPeriods : [],
              activities: snapshot.activities,
              absences: canSeeSensitive ? snapshot.absences : [],
              notesWritten: canSeeSensitive ? snapshot.notesWritten : [],
              notesAbout: canSeeSensitive ? snapshot.notesAbout : [],
              gradeHistory: canSeeSensitive ? snapshot.gradeHistory : [],
              stats: {
                ...snapshot.stats,
                activeWarnings: canSeeSensitive ? snapshot.stats.activeWarnings : 0,
                sanctionsIssued: canSeeSensitive ? snapshot.stats.sanctionsIssued : 0,
              },
              isBlacklisted: canSeeSensitive ? !!snapshot.activeBlacklist : false,
              blacklistReason: canSeeSensitive ? snapshot.activeBlacklist?.reason : null,
              blacklistEndDate: canSeeSensitive ? snapshot.activeBlacklist?.endDate : null,
              accessibleTools,
            });
          } catch (err) {
            logger.error('StaffAPI', 'Error getting user profile:', err);
            json(res, 500, { error: 'Erreur lors de la récupération du profil' });
          }
          return;
        }

        // GET /api/dashboard/.../users/:userId/staff-stats - Staff statistics
        if (usersIdx !== -1 && parts[usersIdx + 2] === 'staff-stats' && req.method === 'GET') {
          const userId = parts[usersIdx + 1];
          if (!userId) {
            json(res, 400, { error: 'userId manquant' });
            return;
          }

          try {
            const staffMember = await prisma.staffMember.findFirst({
              where: { userId },
              include: {
                warnings: { where: { isActive: true } },
                activities: { orderBy: { activityDate: 'desc' }, take: 30 },
              },
            });

            if (!staffMember) {
              json(res, 404, { error: 'Membre du staff introuvable' });
              return;
            }

            const stats = {
              totalMessages: staffMember.activities.reduce((sum, a) => sum + a.messageCount, 0),
              totalVoiceMinutes: staffMember.activities.reduce((sum, a) => sum + a.voiceMinutes, 0),
              activeWarnings: staffMember.warnings.length,
              joinedStaffAt: staffMember.joinedStaffAt,
              currentRoleStartedAt: staffMember.currentRoleStartedAt,
              activities: staffMember.activities,
            };

            json(res, 200, { stats });
          } catch (err) {
            logger.error('StaffAPI', 'Error getting staff stats:', err);
            json(res, 500, { error: 'Erreur lors de la récupération des statistiques' });
          }
          return;
        }

        // POST/GET API Keys routes
        if (parts[4] === 'api-keys') {
          const guildId = parts[3] ?? null;
          if (!guildId) {
            json(res, 400, { error: 'guildId manquant' });
            return;
          }

          const accessLevel = await resolveDashboardAccess(client, guildId, user.userId);
          if (accessLevel.level === 'none') {
            json(res, 403, { error: 'Accès refusé' });
            return;
          }

          // POST /api/dashboard/guilds/:guildId/api-keys - Create API key
          if (req.method === 'POST') {
            const body = await readJsonBody<{
              name?: string;
              permissions?: string[];
            }>(req);

            try {
              const { fullKey, displayKey } = generateAPIKey();
              const keyHash = hashAPIKey(fullKey);

              const apiKey = await createAPIKey(
                guildId,
                user.userId,
                keyHash,
                displayKey,
                body?.name || 'Mon clé API',
                body?.permissions || ['daily_algo:create_exercise']
              );

              await pushAudit(guildId, {
                user: user.username ?? `User${user.userId}`,
                action: 'Création clé API',
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Clé API créée: ${displayKey}`,
                channelId: null
              });

              json(res, 201, {
                id: apiKey.id,
                fullKey, // Important: retourner la clé complète une seule fois
                displayKey: apiKey.displayKey,
                name: apiKey.name,
                permissions: apiKey.permissions,
              });
            } catch (err) {
              logger.error('StaffAPI', 'Error creating API key:', err);
              json(res, 500, { error: 'Erreur lors de la création de la clé API' });
            }
            return;
          }

          // GET /api/dashboard/guilds/:guildId/api-keys - List API keys
          if (req.method === 'GET') {
            try {
              const keys = await getAPIKeys(guildId, user.userId);
              json(res, 200, { keys });
            } catch (err) {
              logger.error('StaffAPI', 'Error getting API keys:', err);
              json(res, 500, { error: 'Erreur lors de la récupération des clés API' });
            }
            return;
          }

          // DELETE /api/dashboard/guilds/:guildId/api-keys/:keyId - Delete API key
          if (parts[5] && req.method === 'DELETE') {
            const keyId = parts[5];
            try {
              const key = await prisma.aPIKey.findUnique({ where: { id: keyId } });
              if (!key) {
                json(res, 404, { error: 'Clé API introuvable' });
                return;
              }
              const requesterStaff = await getStaffMember(guildId, user.userId);
              if (!requesterStaff || (key.createdByUserId !== requesterStaff.id && accessLevel.level !== 'admin')) {
                json(res, 403, { error: 'Non autorisé à supprimer cette clé API' });
                return;
              }

              await deleteAPIKey(keyId);

              await pushAudit(guildId, {
                user: user.username ?? `User${user.userId}`,
                action: 'Suppression clé API',
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Clé API supprimée: ${keyId}`,
                channelId: null
              });

              json(res, 200, { ok: true });
            } catch (err) {
              logger.error('StaffAPI', 'Error deleting API key:', err);
              json(res, 500, { error: 'Erreur lors de la suppression de la clé API' });
            }
            return;
          }
        }

        // ADMIN+ STAFF MANAGEMENT ROUTES
        if (parts[4] === 'staff') {
          const guildId = parts[3] ?? null;
          if (!guildId) {
            json(res, 400, { error: 'guildId manquant' });
            return;
          }

          const accessLevel = await resolveDashboardAccess(client, guildId, user.userId);
          const isModerator = accessLevel.level === 'admin' || accessLevel.level === 'moderator';

          const isMentorReportPost = parts[5] === 'mentor-reports' && req.method === 'POST';
          if (req.method !== 'GET' && accessLevel.level !== 'admin' && !isMentorReportPost) {
            json(res, 403, { error: 'Accès admin requis' });
            return;
          }

          if (!isModerator) {
            json(res, 403, { error: 'Accès modérateur requis' });
            return;
          }

          // GET /api/dashboard/guilds/:guildId/staff/algo-schedule - Get daily algo schedule
          if (parts[5] === 'algo-schedule' && req.method === 'GET' && !parts[6]) {
            try {
              const rangeDays = Number(url.searchParams.get('range') || '14');
              const runs = await prisma.dailyAlgoRun.findMany({
                where: { guildId },
                include: { problem: true },
                orderBy: { createdAt: 'desc' }, // Use createdAt or find a better way to sort by date
                take: rangeDays
              });
              json(res, 200, { runs });
            } catch (err) {
              logger.error('StaffAPI', 'Error getting algo schedule:', err);
              json(res, 500, { error: 'Erreur lors de la récupération du planning Daily Algo' });
            }
            return;
          }

          // POST /api/dashboard/guilds/:guildId/staff/algo-ensure - Trigger schedule generation
          if (parts[5] === 'algo-ensure' && req.method === 'POST') {
             try {
                // Here we would normally trigger the generation service
                // For now, we return success to allow the UI to proceed
                json(res, 200, { ok: true, message: 'Génération de planning demandée' });
             } catch (err) {
                logger.error('StaffAPI', 'Error triggering algo ensure:', err);
                json(res, 500, { error: 'Erreur lors de la génération du planning' });
             }
             return;
          }

          // GET /api/dashboard/guilds/:guildId/staff/alerts - Get leadership metrics and alerts
          if (parts[5] === 'alerts' && req.method === 'GET' && !parts[6]) {
            try {
              const metrics = await getStaffAlertsAndProgression(guildId);
              json(res, 200, { metrics });
            } catch (err) {
              logger.error('StaffAPI', 'Error getting staff alerts:', err);
              json(res, 500, { error: 'Erreur lors de la récupération des alertes' });
            }
            return;
          }

          // GET /api/dashboard/guilds/:guildId/staff/discord-members - Search Discord members
          if (parts[5] === 'discord-members' && req.method === 'GET' && !parts[6]) {
            try {
              const rawQuery = (url.searchParams.get('q') ?? url.searchParams.get('query') ?? '').trim();
              const staffOnly = url.searchParams.get('staffOnly') === 'true';
              const parsedLimit = Number(url.searchParams.get('limit') ?? '12');
              const limit = Number.isFinite(parsedLimit)
                ? Math.min(25, Math.max(1, Math.trunc(parsedLimit)))
                : 12;

              const discordGuild = client.guilds.cache.get(guildId)
                ?? await client.guilds.fetch(guildId).catch(() => null);

              if (!discordGuild) {
                json(res, 404, { error: 'Serveur Discord introuvable' });
                return;
              }

              const mentionMatch = rawQuery.match(/<@!?(\d{15,25})>/);
              const directId = mentionMatch?.[1] ?? (/^\d{15,25}$/.test(rawQuery) ? rawQuery : null);

              let candidates = [] as Array<{
                id: string;
                username: string;
                displayName: string | null;
                userTag: string | null;
                avatarUrl: string | null;
              }>;

              if (directId) {
                const member = await discordGuild.members.fetch(directId).catch(() => null);
                if (member && !member.user.bot) {
                  candidates = [{
                    id: member.user.id,
                    username: member.user.username,
                    displayName: member.displayName ?? null,
                    userTag: member.user.tag ?? null,
                    avatarUrl: member.displayAvatarURL() || null,
                  }];
                }
              } else if (rawQuery) {
                const query = rawQuery.replace(/^@+/, '').trim();
                const members = await discordGuild.members.search({ query, limit }).catch(() => null);

                candidates = members
                  ? members
                    .filter((member) => !member.user.bot)
                    .map((member) => ({
                      id: member.user.id,
                      username: member.user.username,
                      displayName: member.displayName ?? null,
                      userTag: member.user.tag ?? null,
                      avatarUrl: member.displayAvatarURL() || null,
                    }))
                  : [];
              }

              if (staffOnly) {
                const staffMembers = await prisma.staffMember.findMany({
                  where: { guildId },
                  select: { userId: true }
                });
                const staffUserIds = new Set(staffMembers.map(m => m.userId));
                candidates = candidates.filter(c => staffUserIds.has(c.id));
              }

              const members = candidates
                .sort((a, b) => (a.displayName || a.username).localeCompare((b.displayName || b.username), 'fr'))
                .slice(0, limit);

              json(res, 200, { members });
            } catch (err) {
              logger.error('StaffAPI', 'Error searching Discord members:', err);
              json(res, 500, { error: 'Erreur lors de la recherche des membres Discord' });
            }
            return;
          }

          // GET /api/dashboard/guilds/:guildId/staff/members - List staff members
          if (parts[5] === 'members' && req.method === 'GET' && !parts[6]) {
            try {
              const members = await prisma.staffMember.findMany({
                where: { guildId },
                include: {
                  warnings: { where: { isActive: true } },
                  blacklistEntries: { where: { isActive: true } },
                  testingPeriods: { where: { status: 'ONGOING' } },
                },
                orderBy: { grade: 'asc' },
              });

              json(res, 200, { members });
            } catch (err) {
              logger.error('StaffAPI', 'Error listing staff members:', err);
              json(res, 500, { error: 'Erreur lors de la récupération des membres staff' });
            }
            return;
          }

          // POST /api/dashboard/guilds/:guildId/staff/members - Add staff member
          if (parts[5] === 'members' && req.method === 'POST' && !parts[6]) {
            const body = await readJsonBody<{
              userId: string;
              grade: string;
              userTag?: string;
              username?: string;
              displayName?: string;
              avatarUrl?: string;
              createTestingPeriod?: boolean;
            }>(req);

            if (!body?.userId || !body?.grade) {
              json(res, 400, { error: 'userId et grade sont obligatoires' });
              return;
            }

            try {
              const member = await addStaffMember(
                guildId,
                body.userId,
                body.grade as any,
                body.userTag,
                body.username,
                body.displayName,
                body.avatarUrl
              );

              // Créer une période de test initiale si demandé
              if (body.createTestingPeriod !== false) {
                await createTestingPeriod(guildId, body.userId);
              }

              await pushAudit(guildId, {
                user: user.username ?? `User${user.userId}`,
                action: 'Ajout membre staff',
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Nouveau membre staff: ${body.username || body.userId} (${body.grade}) (Tutorat: ${body.createTestingPeriod !== false ? 'OUI' : 'NON'})`,
                channelId: null
              });

              json(res, 201, { member });
            } catch (err) {
              logger.error('StaffAPI', 'Error adding staff member:', err);
              json(res, 500, { error: 'Erreur lors de l\'ajout du membre staff' });
            }
            return;
          }

          // GET /api/dashboard/guilds/:guildId/staff/members/:userId - Get staff member details
          if (parts[5] === 'members' && parts[6] && req.method === 'GET') {
            const staffUserId = parts[6];
            try {
              const stats = await getStaffMemberStats(guildId, staffUserId);
              json(res, 200, stats);
            } catch (err) {
              logger.error('StaffAPI', 'Error getting staff member details:', err);
              json(res, 500, { error: 'Erreur lors de la récupération des détails' });
            }
            return;
          }

          // PATCH /api/dashboard/guilds/:guildId/staff/members/:userId - Update staff member
          if (parts[5] === 'members' && parts[6] && req.method === 'PATCH') {
            const staffUserId = parts[6];
            const body = await readJsonBody<{
              grade?: string;
              action?: string; // promote, demote, remove
            }>(req);

            try {
              if (body?.grade) {
                await updateStaffGrade(guildId, staffUserId, body.grade as any);

                await pushAudit(guildId, {
                  user: user.username ?? `User${user.userId}`,
                  action: 'Changement de grade staff',
                  context: getGuildName(client, guildId),
                  module: 'Staff Management',
                  eventType: 'Manuel',
                  details: `Grade changé pour ${staffUserId}: ${body.grade}`,
                  channelId: null
                });
              }

              if (body?.action === 'remove') {
                await removeStaffMember(guildId, staffUserId);

                await pushAudit(guildId, {
                  user: user.username ?? `User${user.userId}`,
                  action: 'Retrait member staff',
                  context: getGuildName(client, guildId),
                  module: 'Staff Management',
                  eventType: 'Manuel',
                  details: `Membre staff retiré: ${staffUserId}`,
                  channelId: null
                });
              }

              json(res, 200, { ok: true });
            } catch (err) {
              logger.error('StaffAPI', 'Error updating staff member:', err);
              json(res, 500, { error: 'Erreur lors de la mise à jour du membre staff' });
            }
            return;
          }

          // POST /api/dashboard/guilds/:guildId/staff/members/:userId/tutor - Toggle tutor status
          if (parts[5] === 'members' && parts[6] && parts[7] === 'tutor' && req.method === 'POST') {
            const staffUserId = parts[6];

            try {
              const member = await toggleTutorStatus(guildId, staffUserId);

              await pushAudit(guildId, {
                user: user.username ?? `User${user.userId}`,
                action: member.isTutor ? 'Activation tuteur' : 'Désactivation tuteur',
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Statut tuteur modifié pour ${staffUserId}: ${member.isTutor ? 'ON' : 'OFF'}`,
                channelId: null
              });

              json(res, 200, { member });
            } catch (err) {
              logger.error('StaffAPI', 'Error toggling tutor status:', err);
              json(res, 500, { error: 'Erreur lors de la modification du statut tuteur' });
            }
            return;
          }

          // GET /api/dashboard/guilds/:guildId/staff/:staffUserId/notes - Get manager notes
          if (/^\d+$/.test(parts[5]) && parts[6] === 'notes' && req.method === 'GET') {
            const staffUserId = parts[5];
            try {
              const notes = await getManagerNotes(guildId, staffUserId);
              json(res, 200, { notes });
            } catch (err) {
              logger.error('StaffAPI', 'Error getting manager notes:', err);
              json(res, 500, { error: 'Erreur lors de la récupération des notes' });
            }
            return;
          }

          // POST /api/dashboard/guilds/:guildId/staff/:staffUserId/notes - Create manager note
          if (/^\d+$/.test(parts[5]) && parts[6] === 'notes' && req.method === 'POST') {
            const staffUserId = parts[5];
            const body = await readJsonBody<{ content: string }>(req);

            if (!body?.content) {
              json(res, 400, { error: 'Le contenu de la note est requis' });
              return;
            }

            try {
              const note = await createManagerNote(guildId, staffUserId, user.userId, body.content);

              await pushAudit(guildId, {
                user: user.username ?? `User${user.userId}`,
                action: 'Ajout note manager',
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Note ajoutée pour le membre ${staffUserId}`,
                channelId: null
              });

              json(res, 201, { note });
            } catch (err) {
              logger.error('StaffAPI', 'Error creating manager note:', err);
              json(res, 500, { error: 'Erreur lors de la création de la note' });
            }
            return;
          }

          // DELETE /api/dashboard/guilds/:guildId/staff/:staffUserId/notes/:noteId - Delete manager note
          if (/^\d+$/.test(parts[5]) && parts[6] === 'notes' && parts[7] && req.method === 'DELETE') {
            const noteId = parts[7];
            try {
              await deleteManagerNote(noteId);

              await pushAudit(guildId, {
                user: user.username ?? `User${user.userId}`,
                action: 'Suppression note manager',
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Note supprimée: ${noteId}`,
                channelId: null
              });

              json(res, 200, { ok: true });
            } catch (err) {
              logger.error('StaffAPI', 'Error deleting manager note:', err);
              json(res, 500, { error: 'Erreur lors de la suppression de la note' });
            }
            return;
          }

          // POST /api/dashboard/guilds/:guildId/staff/warnings - Issue warning
          if (parts[5] === 'warnings' && req.method === 'GET' && !parts[6]) {
            try {
              const warnings = await prisma.staffWarning.findMany({
                where: { guildId },
                include: {
                  staffMember: true,
                },
                orderBy: { createdAt: 'desc' },
              });

              const formattedWarnings = await Promise.all(warnings.map(async (w) => {
                const issuedBy = await client.users.fetch(w.issuedByUserId).catch(() => null);
                return {
                  id: w.id,
                  staffUserId: w.staffMember.userId,
                  staffDisplayName: w.staffMember.displayName || w.staffMember.username,
                  staffAvatarUrl: w.staffMember.avatarUrl,
                  reason: w.reason,
                  issuedByTag: issuedBy?.tag || w.issuedByUserId,
                  createdAt: w.createdAt.toISOString(),
                  expiresAt: w.expiresAt?.toISOString() || null,
                  isActive: w.isActive,
                };
              }));

              json(res, 200, { warnings: formattedWarnings });
            } catch (err) {
              logger.error('StaffAPI', 'Error fetching staff warnings:', err);
              json(res, 500, { error: 'Erreur lors de la récupération des avertissements staff' });
            }
            return;
          }

          if (parts[5] === 'warnings' && req.method === 'POST') {
            const body = await readJsonBody<{
              staffUserId: string;
              reason: string;
              expiresAt?: string;
            }>(req);

            if (!body?.staffUserId || !body?.reason) {
              json(res, 400, { error: 'staffUserId et reason sont obligatoires' });
              return;
            }

            try {
              const warning = await issueStaffWarning(
                guildId,
                body.staffUserId,
                user.userId,
                body.reason,
                body.expiresAt ? new Date(body.expiresAt) : undefined
              );

              await pushAudit(guildId, {
                user: user.username ?? `User${user.userId}`,
                action: 'Avertissement staff',
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Avertissement généré: ${body.reason}`,
                channelId: null
              });

              json(res, 201, { warning });
            } catch (err) {
              logger.error('StaffAPI', 'Error issuing warning:', err);
              json(res, 500, { error: 'Erreur lors de la génération de l\'avertissement' });
            }
            return;
          }

          // DELETE /api/dashboard/guilds/:guildId/staff/warnings/:warningId - Delete warning
          if (parts[5] === 'warnings' && parts[6] && req.method === 'DELETE') {
            const warningId = parts[6];
            try {
              const warning = await prisma.staffWarning.findFirst({
                where: { id: warningId, guildId },
                include: { staffMember: true }
              });

              if (!warning) {
                json(res, 404, { error: 'Avertissement introuvable' });
                return;
              }

              await prisma.staffWarning.delete({
                where: { id: warningId },
              });

              await pushAudit(guildId, {
                user: user.username ?? `User${user.userId}`,
                action: 'Suppression avertissement staff',
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Avertissement supprimé pour ${warning.staffMember.username || warning.staffMember.userId}: ${warning.reason}`,
                channelId: null
              });

              json(res, 200, { ok: true });
            } catch (err) {
              logger.error('StaffAPI', 'Error deleting staff warning:', err);
              json(res, 500, { error: 'Erreur lors de la suppression de l\'avertissement' });
            }
            return;
          }

          // POST /api/dashboard/guilds/:guildId/staff/blacklist - Blacklist staff member
          if (parts[5] === 'blacklist' && req.method === 'POST') {
            const body = await readJsonBody<{
              staffUserId: string;
              reason: string;
              endDate?: string;
            }>(req);

            if (!body?.staffUserId || !body?.reason) {
              json(res, 400, { error: 'staffUserId et reason sont obligatoires' });
              return;
            }

            try {
              const blacklist = await blacklistStaff(
                guildId,
                body.staffUserId,
                user.userId,
                body.reason,
                body.endDate ? new Date(body.endDate) : undefined
              );

              await pushAudit(guildId, {
                user: user.username ?? `User${user.userId}`,
                action: 'Blacklist staff',
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Blacklist appliquée: ${body.reason}`,
                channelId: null
              });

              json(res, 201, { blacklist });
            } catch (err) {
              logger.error('StaffAPI', 'Error blacklisting staff:', err);
              json(res, 500, { error: 'Erreur lors de la blacklist' });
            }
            return;
          }

          // DELETE /api/dashboard/guilds/:guildId/staff/blacklist/:userId - Remove from staff blacklist
          if (parts[5] === 'blacklist' && parts[6] && req.method === 'DELETE') {
            const targetUserId = parts[6];
            try {
              const linkedUserIds = await altAccountService.getAllLinkedUserIds(guildId, targetUserId);
              const members = await prisma.staffMember.findMany({
                where: { guildId, userId: { in: linkedUserIds } }
              });

              if (members.length === 0) {
                json(res, 404, { error: 'Membre staff introuvable' });
                return;
              }

              await prisma.staffBlacklist.updateMany({
                where: {
                  guildId,
                  staffUserId: { in: members.map((member) => member.id) },
                  isActive: true
                },
                data: {
                  isActive: false
                }
              });

              // Si le grade est 'Blacklisted', on peut supprimer les profils staff fictifs
              await Promise.all(
                members
                  .filter((member) => member.grade === 'Blacklisted')
                  .map((member) => prisma.staffMember.delete({ where: { id: member.id } }).catch(() => null))
              );

              await pushAudit(guildId, {
                user: user.username ?? `User${user.userId}`,
                action: 'Retrait blacklist staff',
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Blacklist retirée pour ${members.map((member) => member.username || member.userId).join(', ')}`,
                channelId: null
              });

              json(res, 200, { ok: true });
            } catch (err) {
              logger.error('StaffAPI', 'Error removing from staff blacklist:', err);
              json(res, 500, { error: 'Erreur lors du retrait de la blacklist' });
            }
            return;
          }

          // GET /api/dashboard/guilds/:guildId/staff/roles - List staff roles
          if (parts[5] === 'roles' && req.method === 'GET' && !parts[6]) {
            try {
              const roles = await getStaffRoles(guildId);
              json(res, 200, { roles });
            } catch (err) {
              logger.error('StaffAPI', 'Error getting staff roles:', err);
              json(res, 500, { error: 'Erreur lors de la récupération des rôles staff' });
            }
            return;
          }

          // POST /api/dashboard/guilds/:guildId/staff/roles - Create staff role
          if (parts[5] === 'roles' && req.method === 'POST' && !parts[6]) {
            const body = await readJsonBody<{
              name: string;
              level: number;
              discordRoleId?: string;
              color?: string;
            }>(req);

            if (!body?.name || typeof body?.level !== 'number') {
              json(res, 400, { error: 'name et level sont obligatoires' });
              return;
            }

            try {
              const role = await createStaffRole(
                guildId,
                body.name,
                body.level,
                body.discordRoleId,
                body.color
              );

              await pushAudit(guildId, {
                user: user.username ?? `User${user.userId}`,
                action: 'Création rôle staff',
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Nouveau rôle staff: ${body.name}`,
                channelId: null
              });

              json(res, 201, { role });
            } catch (err) {
              logger.error('StaffAPI', 'Error creating staff role:', err);
              json(res, 500, { error: 'Erreur lors de la création du rôle staff' });
            }
            return;
          }

          // PATCH /api/dashboard/guilds/:guildId/staff/roles/order - Reorder staff roles
          if (parts[5] === 'roles' && parts[6] === 'order' && req.method === 'PATCH') {
            const body = await readJsonBody<{
              orderedRoleIds: string[];
            }>(req);

            if (!Array.isArray(body?.orderedRoleIds)) {
              json(res, 400, { error: 'orderedRoleIds doit être un tableau' });
              return;
            }

            try {
              await reorderStaffRoles(guildId, body.orderedRoleIds);

              await pushAudit(guildId, {
                user: user.username ?? `User${user.userId}`,
                action: 'Réorganisation rôles staff',
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Ordre mis à jour pour ${body.orderedRoleIds.length} rôle(s)`,
                channelId: null
              });

              json(res, 200, { success: true });
            } catch (err) {
              logger.error('StaffAPI', 'Error reordering staff roles:', err);
              json(res, 500, { error: 'Erreur lors du réordonnancement des rôles staff' });
            }
            return;
          }

          // DELETE /api/dashboard/guilds/:guildId/staff/roles/:roleId - Delete staff role
          if (parts[5] === 'roles' && parts[6] && req.method === 'DELETE') {
            const roleId = parts[6];
            try {
              const deleted = await deleteStaffRole(guildId, roleId);
              if (!deleted) {
                json(res, 404, { error: 'Rôle staff introuvable' });
                return;
              }

              await pushAudit(guildId, {
                user: user.username ?? `User${user.userId}`,
                action: 'Suppression rôle staff',
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Rôle staff supprimé: ${deleted.name} (${roleId})`,
                channelId: null
              });

              json(res, 200, { ok: true });
            } catch (err) {
              logger.error('StaffAPI', 'Error deleting staff role:', err);
              json(res, 500, { error: 'Erreur lors de la suppression du rôle staff' });
            }
            return;
          }

          // GET/PATCH /api/dashboard/guilds/:guildId/staff/config - Staff global config
          if (parts[5] === 'config' && !parts[6]) {
            if (req.method === 'GET') {
              try {
                const guild = await prisma.guild.findUnique({
                  where: { id: guildId },
                  select: {
                    baseStaffRoleId: true,
                    testStaffRoleId: true,
                    meetingAnnouncementChannelId: true,
                    meetingVoiceChannelId: true,
                    warnsToDemote: true,
                    warnsToBlacklist: true,
                    blacklistPermanentByDefault: true,
                    actionMode: true,
                    demoteRemoveAllRoles: true,
                  },
                });

                if (!guild) {
                  json(res, 404, { error: 'Serveur introuvable' });
                  return;
                }

                json(res, 200, { config: guild });
              } catch (err) {
                logger.error('StaffAPI', 'Error getting staff config:', err);
                json(res, 500, { error: 'Erreur lors de la récupération de la configuration staff' });
              }
              return;
            }

            if (req.method === 'PATCH') {
              const body = await readJsonBody<{
                baseStaffRoleId?: string | null;
                testStaffRoleId?: string | null;
                meetingAnnouncementChannelId?: string | null;
                meetingVoiceChannelId?: string | null;
                warnsToDemote?: number;
                warnsToBlacklist?: number;
                blacklistPermanentByDefault?: boolean;
                actionMode?: string;
                demoteRemoveAllRoles?: boolean;
              }>(req);

              try {
                const data: any = {};

                if (Object.prototype.hasOwnProperty.call(body ?? {}, 'baseStaffRoleId')) {
                  data.baseStaffRoleId = extractDiscordSnowflake(body?.baseStaffRoleId ?? null);
                }
                if (Object.prototype.hasOwnProperty.call(body ?? {}, 'testStaffRoleId')) {
                  data.testStaffRoleId = extractDiscordSnowflake(body?.testStaffRoleId ?? null);
                }
                if (Object.prototype.hasOwnProperty.call(body ?? {}, 'meetingAnnouncementChannelId')) {
                  data.meetingAnnouncementChannelId = extractDiscordSnowflake(body?.meetingAnnouncementChannelId ?? null);
                }
                if (Object.prototype.hasOwnProperty.call(body ?? {}, 'meetingVoiceChannelId')) {
                  data.meetingVoiceChannelId = extractDiscordSnowflake(body?.meetingVoiceChannelId ?? null);
                }


                if (Object.prototype.hasOwnProperty.call(body ?? {}, 'warnsToDemote')) {
                  data.warnsToDemote = Number(body?.warnsToDemote) || 0;
                }
                if (Object.prototype.hasOwnProperty.call(body ?? {}, 'warnsToBlacklist')) {
                  data.warnsToBlacklist = Number(body?.warnsToBlacklist) || 0;
                }
                if (Object.prototype.hasOwnProperty.call(body ?? {}, 'blacklistPermanentByDefault')) {
                  data.blacklistPermanentByDefault = !!body?.blacklistPermanentByDefault;
                }
                if (Object.prototype.hasOwnProperty.call(body ?? {}, 'actionMode')) {
                  data.actionMode = body?.actionMode || 'MANUAL';
                }
                if (Object.prototype.hasOwnProperty.call(body ?? {}, 'demoteRemoveAllRoles')) {
                  data.demoteRemoveAllRoles = !!body?.demoteRemoveAllRoles;
                }

                const updatedGuild = await prisma.guild.update({
                  where: { id: guildId },
                  data,
                  select: {
                    baseStaffRoleId: true,
                    testStaffRoleId: true,
                    meetingAnnouncementChannelId: true,
                    meetingVoiceChannelId: true,
                    warnsToDemote: true,
                    warnsToBlacklist: true,
                    blacklistPermanentByDefault: true,
                    actionMode: true,
                    demoteRemoveAllRoles: true,
                  },
                });

                await pushAudit(guildId, {
                  user: user.username ?? `User${user.userId}`,
                  action: 'Mise à jour config staff',
                  context: getGuildName(client, guildId),
                  module: 'Staff Management',
                  eventType: 'Manuel',
                  details: `Configuration staff mise à jour (Rôles: ${updatedGuild.baseStaffRoleId ?? 'aucun'}/${updatedGuild.testStaffRoleId ?? 'aucun'}, Sanctions: ${updatedGuild.warnsToDemote} warns p. démo / ${updatedGuild.warnsToBlacklist} warns p. bl, Mode: ${updatedGuild.actionMode})`,
                  channelId: null,
                });

                json(res, 200, { config: updatedGuild });
              } catch (err) {
                logger.error('StaffAPI', 'Error updating staff config:', err);
                json(res, 500, { error: 'Erreur lors de la mise à jour de la configuration staff' });
              }
              return;
            }
          }

          // GET /api/dashboard/guilds/:guildId/staff/polls - List polls
          if (parts[5] === 'polls' && req.method === 'GET' && !parts[6]) {
            try {
              const polls = await getPolls(guildId);
              json(res, 200, { polls });
            } catch (err) {
              logger.error('StaffAPI', 'Error getting polls:', err);
              json(res, 500, { error: 'Erreur lors de la récupération des sondages' });
            }
            return;
          }

          // POST /api/dashboard/guilds/:guildId/staff/polls - Create poll
          if (parts[5] === 'polls' && req.method === 'POST' && !parts[6]) {
            const body = await readJsonBody<{
              title: string;
              description?: string;
              options: string[];
              closesAt?: string;
              isAnonymous?: boolean;
            }>(req);

            if (!body?.title || !Array.isArray(body?.options) || body.options.length < 2) {
              json(res, 400, { error: 'title et au moins 2 options sont obligatoires' });
              return;
            }

            try {
              const author = await getStaffMember(guildId, user.userId);
              if (!author) {
                json(res, 403, { error: 'Le créateur doit être membre du staff' });
                return;
              }

              const poll = await createPoll(
                guildId,
                author.id,
                body.title.trim(),
                body.description?.trim() || '',
                body.options.map((opt) => opt.trim()).filter(Boolean),
                body.isAnonymous ?? true,
                body.closesAt ? new Date(body.closesAt) : undefined
              );

              await pushAudit(guildId, {
                user: user.username ?? `User${user.userId}`,
                action: 'Création sondage staff',
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Sondage créé: ${poll.title}`,
                channelId: null
              });

              json(res, 201, { poll });
            } catch (err) {
              logger.error('StaffAPI', 'Error creating poll:', err);
              json(res, 500, { error: 'Erreur lors de la création du sondage' });
            }
            return;
          }

          // POST /api/dashboard/guilds/:guildId/staff/polls/vote - Cast vote
          if (parts[5] === 'polls' && parts[6] === 'vote' && req.method === 'POST') {
            const body = await readJsonBody<{
              pollId: string;
              optionId: string;
            }>(req);

            if (!body?.pollId || !body?.optionId) {
              json(res, 400, { error: 'pollId et optionId sont obligatoires' });
              return;
            }

            try {
              const voter = await getStaffMember(guildId, user.userId);
              if (!voter) {
                json(res, 403, { error: 'Le votant doit être membre du staff' });
                return;
              }

              const poll = await prisma.staffPoll.findFirst({
                where: { id: body.pollId, guildId },
                include: { options: true },
              });

              if (!poll) {
                json(res, 404, { error: 'Sondage introuvable' });
                return;
              }

              if (poll.status !== 'OPEN') {
                json(res, 400, { error: 'Ce sondage est fermé' });
                return;
              }

              if (poll.closesAt && poll.closesAt.getTime() <= Date.now()) {
                json(res, 400, { error: 'Ce sondage est expiré' });
                return;
              }

              const optionExists = poll.options.some((option) => option.id === body.optionId);
              if (!optionExists) {
                json(res, 400, { error: 'Option de vote invalide' });
                return;
              }

              const vote = await castPollVote(body.pollId, voter.id, body.optionId);
              json(res, 200, { vote });
            } catch (err) {
              logger.error('StaffAPI', 'Error casting poll vote:', err);
              json(res, 500, { error: 'Erreur lors du vote' });
            }
            return;
          }

          // PATCH /api/dashboard/guilds/:guildId/staff/polls/:pollId/close - Close poll
          if (parts[5] === 'polls' && parts[6] && parts[7] === 'close' && req.method === 'PATCH') {
            const pollId = parts[6];

            try {
              const result = await prisma.staffPoll.updateMany({
                where: { id: pollId, guildId },
                data: { status: 'CLOSED' },
              });

              if (result.count === 0) {
                json(res, 404, { error: 'Sondage introuvable' });
                return;
              }

              await pushAudit(guildId, {
                user: user.username ?? `User${user.userId}`,
                action: 'Clôture sondage staff',
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Sondage clôturé: ${pollId}`,
                channelId: null
              });

              json(res, 200, { ok: true });
            } catch (err) {
              logger.error('StaffAPI', 'Error closing poll:', err);
              json(res, 500, { error: 'Erreur lors de la clôture du sondage' });
            }
            return;
          }

          // POST /api/dashboard/guilds/:guildId/testing-periods - Create testing period
          if (parts[5] === 'testing-periods' && req.method === 'POST' && !parts[6]) {
            const body = await readJsonBody<{
              staffUserId: string;
              mentorId?: string;
            }>(req);

            if (!body?.staffUserId) {
              json(res, 400, { error: 'staffUserId est obligatoire' });
              return;
            }

            try {
              const period = await createTestingPeriod(guildId, body.staffUserId, body.mentorId);
              json(res, 201, { period });
            } catch (err) {
              logger.error('StaffAPI', 'Error creating testing period:', err);
              json(res, 500, { error: 'Erreur lors de la création de la période de test' });
            }
            return;
          }

          // PATCH /api/dashboard/guilds/:guildId/testing-periods/:periodId - End testing period
          if (parts[5] === 'testing-periods' && parts[6] && req.method === 'PATCH') {
            const periodId = parts[6];
            const body = await readJsonBody<{
              status: 'PASSED' | 'FAILED';
              notes?: string;
              force?: boolean;
            }>(req);

            if (!body?.status) {
              json(res, 400, { error: 'status est obligatoire' });
              return;
            }

            try {
              // Vérification de la durée minimum si validation
              if (body.status === 'PASSED') {
                const period = await prisma.testingPeriod.findUnique({
                  where: { id: periodId },
                  select: { startDate: true, guildId: true }
                });

                if (period) {
                  const config = await tutoringService.getTutoringConfig(period.guildId);
                  const minDays = config.minTestDays || 14;
                  const diffMs = Date.now() - period.startDate.getTime();
                  const diffDays = diffMs / (1000 * 60 * 60 * 24);

                  if (diffDays < minDays && !body.force) {
                    json(res, 403, { 
                      error: `La période de test est trop courte (${Math.floor(diffDays)}j / ${minDays}j).`,
                      canForce: accessLevel.level === 'admin'
                    });
                    return;
                  }

                  if (body.force && accessLevel.level !== 'admin') {
                    json(res, 403, { error: 'Seuls les administrateurs peuvent forcer une validation précoce.' });
                    return;
                  }
                }
              }

              const period = await endTestingPeriod(periodId, body.status, body.notes);

              await pushAudit(guildId, {
                user: user.username ?? `User${user.userId}`,
                action: `Fin période de test (${body.status})${body.force ? ' [FORCÉ]' : ''}`,
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Période de test: ${periodId} - ${body.status}${body.force ? ' (Bypass durée minimum)' : ''}`,
                channelId: null
              });

              json(res, 200, { period });
            } catch (err) {
              logger.error('StaffAPI', 'Error ending testing period:', err);
              json(res, 500, { error: 'Erreur lors de la fin de la période de test' });
            }
            return;
          }

          // POST /api/dashboard/guilds/:guildId/mentor-reports - Add mentor report
          if (parts[5] === 'mentor-reports' && req.method === 'POST') {
            if (accessLevel.level !== 'admin' && !accessLevel.canManageTutoring) {
              json(res, 403, { error: 'Accès tuteur ou admin requis' });
              return;
            }
            const body = await readJsonBody<{
              testingPeriodId: string;
              type: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
              content: string;
            }>(req);

            if (!body?.testingPeriodId || !body?.type || !body?.content) {
              json(res, 400, { error: 'testingPeriodId, type et content sont obligatoires' });
              return;
            }

            try {
              const report = await addMentorReport(
                body.testingPeriodId,
                user.userId,
                body.type,
                body.content
              );

              await pushAudit(guildId, {
                user: user.username ?? `User${user.userId}`,
                action: 'Rapport tuteur',
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Rapport ${body.type}: ${body.testingPeriodId}`,
                channelId: null
              });

              json(res, 201, { report });
            } catch (err) {
              logger.error('StaffAPI', 'Error adding mentor report:', err);
              json(res, 500, { error: 'Erreur lors de l\'ajout du rapport tuteur' });
            }
            return;
          }
        }

        // TUTOR OR ADMIN MENTOR REPORTS ROUTES
        if (parts[4] === 'mentor-reports') {
          const guildId = parts[3] ?? null;
          if (!guildId) {
            json(res, 400, { error: 'guildId manquant' });
            return;
          }

          const accessLevel = await resolveDashboardAccess(client, guildId, user.userId);
          if (accessLevel.level !== 'admin' && !accessLevel.canManageTutoring) {
            json(res, 403, { error: 'Accès tuteur ou admin requis' });
            return;
          }

          // POST /api/dashboard/guilds/:guildId/mentor-reports - Add mentor report
          if (req.method === 'POST') {
            const body = await readJsonBody<{
              testingPeriodId: string;
              type: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
              content: string;
            }>(req);

            if (!body?.testingPeriodId || !body?.type || !body?.content) {
              json(res, 400, { error: 'testingPeriodId, type et content sont obligatoires' });
              return;
            }

            try {
              const report = await addMentorReport(
                body.testingPeriodId,
                user.userId,
                body.type,
                body.content
              );

              await pushAudit(guildId, {
                user: user.username ?? `User${user.userId}`,
                action: 'Rapport tuteur',
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Rapport ${body.type}: ${body.testingPeriodId}`,
                channelId: null
              });

              json(res, 201, { report });
            } catch (err) {
              logger.error('StaffAPI', 'Error adding mentor report:', err);
              json(res, 500, { error: 'Erreur lors de l\'ajout du rapport tuteur' });
            }
            return;
          }
        }

        // NOTIFICATIONS ROUTES
        if (parts[4] === 'notifications') {
          const guildId = parts[3] ?? null;
          if (!guildId) {
            json(res, 400, { error: 'guildId manquant' });
            return;
          }

          // GET /api/dashboard/guilds/:guildId/notifications
          if (req.method === 'GET' && !parts[5]) {
            try {
              const notifs = await getNotifications(guildId, user.userId);
              json(res, 200, { notifications: notifs });
            } catch (err) {
              logger.error('StaffAPI', 'Error getting notifications:', err);
              json(res, 500, { error: 'Erreur récupération notifications' });
            }
            return;
          }

          // PATCH /api/dashboard/guilds/:guildId/notifications/:id/read
          if (req.method === 'PATCH' && parts[5] && parts[6] === 'read') {
            try {
              await markNotificationRead(parts[5], user.userId);
              json(res, 200, { ok: true });
            } catch (err) {
              logger.error('StaffAPI', 'Error marking notification as read:', err);
              json(res, 500, { error: 'Erreur update notification' });
            }
            return;
          }

          // POST /api/dashboard/guilds/:guildId/notifications/mark-all-read
          if (req.method === 'POST' && parts[5] === 'mark-all-read') {
            try {
              await markAllNotificationsRead(guildId, user.userId);
              json(res, 200, { ok: true });
            } catch (err) {
              logger.error('StaffAPI', 'Error marking all as read:', err);
              json(res, 500, { error: 'Erreur update notifications' });
            }
            return;
          }
        }

        // TUTORING ROUTES
        if (parts[4] === 'tutoring') {
          const guildId = parts[3] ?? null;
          if (!guildId) {
            json(res, 400, { error: 'guildId manquant' });
            return;
          }

          // GET /api/dashboard/guilds/:guildId/tutoring/config
          if (req.method === 'GET' && parts[5] === 'config') {
            try {
              const config = await tutoringService.getTutoringConfig(guildId);
              json(res, 200, { config });
            } catch (err) {
              logger.error('TutoringAPI', 'Error getting config:', err);
              json(res, 500, { error: 'Erreur récupération config tutorat' });
            }
            return;
          }

          // PATCH /api/dashboard/guilds/:guildId/tutoring/config
          if (req.method === 'PATCH' && parts[5] === 'config') {
            const accessLevel = await resolveDashboardAccess(client, guildId, user.userId);
            if (!accessLevel.canManageTutoring) {
              json(res, 403, { error: 'Accès tutorat requis' });
              return;
            }

            const body = await readJsonBody<any>(req);
            try {
              const config = await tutoringService.updateTutoringConfig(guildId, body);
              
              await pushAudit(guildId, {
                user: user.username ?? `User${user.userId}`,
                action: 'Mise à jour config tutorat',
                context: getGuildName(client, guildId),
                module: 'Tutoring',
                eventType: 'Manuel',
                details: `Intervalle: ${body.reportIntervalDays}j, Rappels: ${body.reminderDaysBefore}j, Min Test: ${body.minTestDays}j`,
                channelId: null
              });

              json(res, 200, { config });
            } catch (err) {
              logger.error('TutoringAPI', 'Error updating config:', err);
              json(res, 500, { error: 'Erreur mise à jour config tutorat' });
            }
            return;
          }

          // GET /api/dashboard/guilds/:guildId/tutoring/items
          if (req.method === 'GET' && parts[5] === 'items') {
            try {
              const items = await tutoringService.getTutoringItems(guildId);
              json(res, 200, { items });
            } catch (err) {
              logger.error('TutoringAPI', 'Error getting items:', err);
              json(res, 500, { error: 'Erreur récupération items tutorat' });
            }
            return;
          }

          // POST /api/dashboard/guilds/:guildId/tutoring/items
          if (req.method === 'POST' && parts[5] === 'items') {
            const accessLevel = await resolveDashboardAccess(client, guildId, user.userId);
            if (!accessLevel.canManageTutoring) {
              json(res, 403, { error: 'Accès tutorat requis' });
              return;
            }

            const body = await readJsonBody<any>(req);
            try {
              const item = await tutoringService.upsertTutoringItem(guildId, body);
              
              await pushAudit(guildId, {
                user: user.username ?? `User${user.userId}`,
                action: body.id ? 'Mise à jour item tutorat' : 'Création item tutorat',
                context: getGuildName(client, guildId),
                module: 'Tutoring',
                eventType: 'Manuel',
                details: `Item: ${body.title}`,
                channelId: null
              });

              json(res, 201, { item });
            } catch (err) {
              logger.error('TutoringAPI', 'Error upserting item:', err);
              json(res, 500, { error: 'Erreur sauvegarde item tutorat' });
            }
            return;
          }

          // DELETE /api/dashboard/guilds/:guildId/tutoring/items/:itemId
          if (req.method === 'DELETE' && parts[5] === 'items' && parts[6]) {
            const accessLevel = await resolveDashboardAccess(client, guildId, user.userId);
            if (!accessLevel.canManageTutoring) {
              json(res, 403, { error: 'Accès tutorat requis' });
              return;
            }

            try {
              await tutoringService.deleteTutoringItem(parts[6]);
              json(res, 200, { ok: true });
            } catch (err) {
              logger.error('TutoringAPI', 'Error deleting item:', err);
              json(res, 500, { error: 'Erreur suppression item tutorat' });
            }
            return;
          }

          // POST /api/dashboard/guilds/:guildId/tutoring/periods - Create tutoring / testing period
          if (req.method === 'POST' && parts[5] === 'periods' && !parts[6]) {
            const accessLevel = await resolveDashboardAccess(client, guildId, user.userId);
            if (accessLevel.level !== 'admin' && !accessLevel.canManageTutoring) {
              json(res, 403, { error: 'Accès admin ou tutorat requis' });
              return;
            }

            const body = await readJsonBody<{
              staffUserId: string;
              mentorId?: string;
              plannedDurationDays?: number;
              targetGrade?: string;
            }>(req);

            if (!body?.staffUserId) {
              json(res, 400, { error: 'staffUserId est obligatoire' });
              return;
            }

            try {
              const { createTestingPeriod } = await import('../services/staffManagementService.js');
              const period = await createTestingPeriod(
                guildId,
                body.staffUserId,
                body.mentorId || undefined,
                body.plannedDurationDays ? Number(body.plannedDurationDays) : 14,
                body.targetGrade || undefined
              );

              await pushAudit(guildId, {
                user: user.username ?? `User${user.userId}`,
                action: 'Création tutorat',
                context: getGuildName(client, guildId),
                module: 'Tutoring',
                eventType: 'Manuel',
                details: `Période de test créée pour ${body.staffUserId} (Tuteur: ${body.mentorId || 'aucun'}, Grade cible: ${body.targetGrade || 'aucun'})`,
                channelId: null
              });

              json(res, 201, { period });
            } catch (err: any) {
              logger.error('TutoringAPI', 'Error creating period:', err);
              json(res, 500, { error: err.message || 'Erreur création tutorat' });
            }
            return;
          }

          // DELETE /api/dashboard/guilds/:guildId/tutoring/periods/:periodId
          if (req.method === 'DELETE' && parts[5] === 'periods' && parts[6]) {
            const accessLevel = await resolveDashboardAccess(client, guildId, user.userId);
            if (accessLevel.level !== 'admin' && !accessLevel.canManageTutoring) {
              json(res, 403, { error: 'Accès admin ou tutorat requis' });
              return;
            }

            try {
              await tutoringService.deleteTestingPeriod(parts[6]);
              
              await pushAudit(guildId, {
                user: user.username ?? `User${user.userId}`,
                action: 'Suppression tutorat',
                context: getGuildName(client, guildId),
                module: 'Tutoring',
                eventType: 'Manuel',
                details: `Période de test supprimée: ${parts[6]}`,
                channelId: null
              });

              json(res, 200, { ok: true });
            } catch (err) {
              logger.error('TutoringAPI', 'Error deleting period:', err);
              json(res, 500, { error: 'Erreur suppression tutorat' });
            }
            return;
          }

          // GET /api/dashboard/guilds/:guildId/tutoring/tutor-dashboard
          if (req.method === 'GET' && parts[5] === 'tutor-dashboard') {
            try {
              const accessLevel = await resolveDashboardAccess(client, guildId, user.userId);
              const fetchAll = accessLevel.level === 'admin';
              const apprentices = await tutoringService.getTutorDashboard(guildId, user.userId, fetchAll);
              json(res, 200, { apprentices });
            } catch (err) {
              logger.error('TutoringAPI', 'Error getting tutor dashboard:', err);
              json(res, 500, { error: 'Erreur récupération dashboard tuteur' });
            }
            return;
          }

          // GET /api/dashboard/guilds/:guildId/tutoring/apprentice-progress
          if (req.method === 'GET' && parts[5] === 'apprentice-progress') {
            try {
              const progress = await tutoringService.getApprenticeProgress(guildId, user.userId);
              json(res, 200, { progress });
            } catch (err) {
              logger.error('TutoringAPI', 'Error getting apprentice progress:', err);
              json(res, 500, { error: 'Erreur récupération progression apprenti' });
            }
            return;
          }

          // PATCH /api/dashboard/guilds/:guildId/tutoring/checklist
          if (req.method === 'PATCH' && parts[5] === 'checklist') {
            const body = await readJsonBody<{
              testingPeriodId: string;
              itemId: string;
              state: TutoringItemState;
            }>(req);

            if (!body?.testingPeriodId || !body?.itemId || !body?.state) {
              json(res, 400, { error: 'Données manquantes' });
              return;
            }

            try {
              const progress = await tutoringService.updateChecklistProgress(
                body.testingPeriodId,
                body.itemId,
                body.state,
                user.userId
              );
              json(res, 200, { progress });
            } catch (err) {
              logger.error('TutoringAPI', 'Error updating checklist:', err);
              json(res, 500, { error: 'Erreur mise à jour checklist' });
            }
            return;
          }

          // POST /api/dashboard/guilds/:guildId/tutoring/logs
          if (req.method === 'POST' && parts[5] === 'logs') {
            const body = await readJsonBody<{
              testingPeriodId: string;
              content: string;
            }>(req);

            if (!body?.testingPeriodId || !body?.content) {
              json(res, 400, { error: 'Données manquantes' });
              return;
            }

            try {
              const log = await tutoringService.addApprenticeLog(body.testingPeriodId, body.content);
              json(res, 201, { log });
            } catch (err) {
              logger.error('TutoringAPI', 'Error adding log:', err);
              json(res, 500, { error: 'Erreur ajout carnet de bord' });
            }
            return;
          }
        }
        // GET /api/dashboard/guilds/:guildId/analytics
        if (parts[4] === 'analytics') {
          const guildId = parts[3] ?? null;
          if (!guildId) {
            json(res, 400, { error: 'guildId manquant' });
            return;
          }

          if (req.method === 'GET') {
            try {
              const accessLevel = await resolveDashboardAccess(client, guildId, user.userId);
              if (accessLevel.level === 'none') {
                json(res, 403, { error: 'Accès refusé' });
                return;
              }

              if (parts[5] === 'invites') {
                json(res, 200, { data: [] }); // TODO: implémenter invite analytics
                return;
              }

              if (parts[5] === 'members') {
                json(res, 200, { data: [] }); // TODO: implémenter member detailed analytics
                return;
              }

              if (parts[5] === 'interactions') {
                const url = new URL(req.url, `http://${req.headers.host}`);
                const days = parseInt(url.searchParams.get('period') || '30', 10);
                const startDate = url.searchParams.get('startDate') || undefined;
                const endDate = url.searchParams.get('endDate') || undefined;

                const data = await import('../services/dashboardAnalyticsService.js').then(m => m.getGlobalInteractions(guildId, { days, startDate, endDate }));
                json(res, 200, data);
                return;
              }

              const url = new URL(req.url, `http://${req.headers.host}`);
              const days = parseInt(url.searchParams.get('period') || '30', 10);
              const startDate = url.searchParams.get('startDate');
              const endDate = url.searchParams.get('endDate');
              
              const data = await import('../services/dashboardAnalyticsService.js').then(m => m.getDashboardAnalytics(guildId, { days, startDate, endDate }));
              
              const discordGuild = client.guilds.cache.get(guildId);
              if (discordGuild) {
                const members = discordGuild.members.cache;
                const onlineCount = members.filter(m => m.presence?.status && m.presence.status !== 'offline').size;
                
                (data as any).live = {
                  onlineMembers: onlineCount,
                  totalMembers: discordGuild.memberCount
                };

                // Fetch raw guild object to get clan details if available
                let clanTag: string | null = null;
                try {
                  const { Routes } = await import('discord.js');
                  const rawGuild = await client.rest.get(Routes.guild(guildId)) as any;
                  if (rawGuild.clan && rawGuild.clan.tag) {
                    clanTag = rawGuild.clan.tag;
                  }
                } catch (err) {
                  logger.debug('AnalyticsAPI', 'Error fetching raw guild clan info (non-critical): ' + String(err));
                }

                // If not found in REST raw guild, fallback to guild property or cache
                if (!clanTag) {
                  clanTag = (discordGuild as any).clan?.tag || (discordGuild as any).clanTag;
                }

                // Fetch all members to find tag if not yet resolved, and to calculate growth
                try {
                  const allMembers = await getGuildMembers(discordGuild);
                  
                  // If tag is still unresolved, scan members' primaryGuild
                  if (!clanTag) {
                    for (const [_, m] of allMembers) {
                      const primaryGuild = (m.user as any).primaryGuild;
                      if (primaryGuild && primaryGuild.identityGuildId === guildId && primaryGuild.tag) {
                        clanTag = primaryGuild.tag;
                        break;
                      }
                    }
                  }

                  if (clanTag) {
                    (data as any).clanTag = clanTag;
                    
                    const tagLower = clanTag.toLowerCase();
                    const taggedMembers = allMembers.filter(m => {
                      const hasNativeTag = (m.user as any).clan?.tag === clanTag || 
                                           (m.user as any).primaryGuild?.tag === clanTag;
                      
                      // Exact matching to avoid false positives (e.g. usernames containing the word)
                      const hasNicknameTag = m.nickname?.toLowerCase().includes(`[${tagLower}]`) || 
                                             m.nickname?.toLowerCase().includes(`(${tagLower})`) ||
                                             m.nickname?.toLowerCase().startsWith(`${tagLower} `) ||
                                             m.nickname?.toLowerCase().startsWith(`${tagLower} |`) ||
                                             m.user.username.toLowerCase().includes(`[${tagLower}]`) || 
                                             m.user.username.toLowerCase().includes(`(${tagLower})`) ||
                                             m.user.displayName?.toLowerCase().includes(`[${tagLower}]`) || 
                                             m.user.displayName?.toLowerCase().includes(`(${tagLower})`);
                                             
                      return hasNativeTag || hasNicknameTag;
                    });

                    (data as any).clanTaggedMembersCount = taggedMembers.size;

                    // Enrich dailyTrend with taggedMembersCount
                    if (data.dailyTrend && Array.isArray(data.dailyTrend)) {
                      data.dailyTrend = data.dailyTrend.map((entry: any) => {
                        const trendDate = new Date(entry.dateKey + 'T23:59:59.999Z');
                        const count = taggedMembers.filter(m => m.joinedAt && m.joinedAt <= trendDate).size;
                        return {
                          ...entry,
                          taggedMembersCount: count
                        };
                      });
                    }
                  }
                } catch (fetchErr) {
                  logger.error('AnalyticsAPI', 'Error fetching guild members for clan tag analytics:', fetchErr);
                }

                // Enrich popular channels with names
                if (data.topChannels) {
                  data.topChannels = data.topChannels.map((tc: any) => {
                    const channel = discordGuild.channels.cache.get(tc.channelId);
                    return {
                      ...tc,
                      channelName: channel?.name || 'salon-inconnu'
                    };
                  });
                }
              }

              json(res, 200, data);
            } catch (err) {
              logger.error('AnalyticsAPI', 'Error getting analytics:', err);
              json(res, 500, { error: 'Erreur récupération analytics' });
            }
            return;
          }
        }

        // EVENTS ROUTES
        if (parts[4] === 'events') {
          const guildId = parts[3] ?? null;
          if (!guildId) {
            json(res, 400, { error: 'guildId manquant' });
            return;
          }

          const accessLevel = await resolveDashboardAccess(client, guildId, user.userId);
          if (accessLevel.level === 'none') {
            json(res, 403, { error: 'Accès refusé' });
            return;
          }

          // GET /api/dashboard/guilds/:guildId/events
          if (req.method === 'GET' && !parts[5]) {
            try {
              const events = await getEvents(guildId);
              json(res, 200, { events });
            } catch (err) {
              logger.error('EventsAPI', err);
              json(res, 500, { error: 'Erreur récupération événements' });
            }
            return;
          }

          // POST /api/dashboard/guilds/:guildId/events
          if (req.method === 'POST' && !parts[5]) {
            try {
              const body = await readJsonBody<any>(req);
              const event = await createEvent(guildId, body);
              json(res, 201, { event });
            } catch (err) {
              logger.error('EventsAPI', err);
              json(res, 500, { error: 'Erreur création événement' });
            }
            return;
          }

          // Routes avec :eventId
          if (parts[5]) {
            const eventId = parts[5];

            // GET /api/dashboard/guilds/:guildId/events/:eventId
            if (req.method === 'GET' && !parts[6]) {
              try {
                const event = await getEvent(eventId);
                json(res, 200, { event });
              } catch (err) {
                logger.error('EventsAPI', err);
                json(res, 500, { error: 'Erreur récupération événement' });
              }
              return;
            }

            // DELETE /api/dashboard/guilds/:guildId/events/:eventId
            if (req.method === 'DELETE' && !parts[6]) {
              try {
                await deleteEvent(client, eventId);
                json(res, 200, { success: true });
              } catch (err) {
                logger.error('EventsAPI', err);
                json(res, 500, { error: 'Erreur suppression événement' });
              }
              return;
            }

            // POST /api/dashboard/guilds/:guildId/events/:eventId/publish
            if (req.method === 'POST' && parts[6] === 'publish') {
              try {
                const event = await publishEvent(client, eventId);
                json(res, 200, { event });
              } catch (err) {
                logger.error('EventsAPI', err);
                json(res, 500, { error: (err as Error).message });
              }
              return;
            }

            // POST /api/dashboard/guilds/:guildId/events/:eventId/next
            if (req.method === 'POST' && parts[6] === 'next') {
              try {
                const result = await nextQuestion(client, eventId);
                json(res, 200, result);
              } catch (err) {
                logger.error('EventsAPI', err);
                json(res, 500, { error: (err as Error).message });
              }
              return;
            }

            // POST /api/dashboard/guilds/:guildId/events/:eventId/prev
            if (req.method === 'POST' && parts[6] === 'prev') {
              try {
                const result = await prevQuestion(client, eventId);
                json(res, 200, result);
              } catch (err) {
                logger.error('EventsAPI', err);
                json(res, 500, { error: (err as Error).message });
              }
              return;
            }

            // POST /api/dashboard/guilds/:guildId/events/:eventId/finish
            if (req.method === 'POST' && parts[6] === 'finish') {
              try {
                const result = await finishEvent(client, eventId);
                json(res, 200, result);
              } catch (err) {
                logger.error('EventsAPI', err);
                json(res, 500, { error: (err as Error).message });
              }
              return;
            }

            // PATCH /api/dashboard/guilds/:guildId/events/:eventId
            if (req.method === 'PATCH' && !parts[6]) {
              try {
                const body = await readJsonBody<any>(req);
                const currentEvent = await prisma.event.findUnique({ where: { id: eventId } });
                
                // Si l'événement est en cours, on évite de supprimer/recréer les questions car ça casse tout
                const isLive = currentEvent?.status === 'ONGOING';
                
                const event = await prisma.event.update({
                  where: { id: eventId },
                  data: {
                    title: body.title,
                    description: body.description,
                    channelId: body.channelId,
                    questions: (body.questions && !isLive) ? {
                      deleteMany: {},
                      create: body.questions.map((q: any, i: number) => ({
                        text: q.text,
                        options: q.options,
                        correctOptionIndex: q.correctOptionIndex,
                        sortOrder: i,
                        imageUrl: q.imageUrl
                      }))
                    } : undefined
                  },
                  include: { questions: true }
                });

                // Si c'est en live et qu'on a des questions, on les met à jour individuellement si possible
                if (isLive && body.questions) {
                   const existingQuestions = await prisma.eventQuizQuestion.findMany({
                     where: { eventId },
                     orderBy: { sortOrder: 'asc' }
                   });

                   for (let i = 0; i < Math.min(existingQuestions.length, body.questions.length); i++) {
                     const q = body.questions[i];
                     if (i < existingQuestions.length) {
                       await prisma.eventQuizQuestion.update({
                         where: { id: existingQuestions[i].id },
                         data: {
                           text: q.text,
                           options: q.options,
                           correctOptionIndex: q.correctOptionIndex,
                           imageUrl: q.imageUrl
                         }
                       });
                     }
                   }
                }

                json(res, 200, { event });
              } catch (err) {
                logger.error('EventsAPI', err);
                json(res, 500, { error: (err as Error).message });
              }
              return;
            }

            // GET /api/dashboard/guilds/:guildId/events/:eventId/stats
            if (req.method === 'GET' && parts[6] === 'stats') {
              try {
                const stats = await getEventStats(eventId);
                json(res, 200, { stats });
              } catch (err) {
                logger.error('EventsAPI', err);
                json(res, 500, { error: 'Erreur récupération stats' });
              }
              return;
            }
          }
        }

        // ADMIN+ TESTING PERIOD ROUTES
        if (parts[4] === 'testing-periods') {
          const guildId = parts[3] ?? null;
          if (!guildId) {
            json(res, 400, { error: 'guildId manquant' });
            return;
          }

          const accessLevel = await resolveDashboardAccess(client, guildId, user.userId);
          if (accessLevel.level !== 'admin' && !accessLevel.canManageTutoring) {
            json(res, 403, { error: 'Accès tuteur ou admin requis' });
            return;
          }

          // GET /api/dashboard/guilds/:guildId/testing-periods - List testing periods
          if (req.method === 'GET' && !parts[5]) {
            try {
              const periods = await prisma.testingPeriod.findMany({
                where: { guildId },
                orderBy: { createdAt: 'desc' },
                include: {
                  staffMember: true,
                  mentor: true,
                  reports: {
                    orderBy: { createdAt: 'desc' },
                    include: { author: true },
                  },
                },
              });

              json(res, 200, { periods });
            } catch (err) {
              logger.error('StaffAPI', 'Error getting testing periods:', err);
              json(res, 500, { error: 'Erreur lors de la récupération des périodes de test' });
            }
            return;
          }

          // POST /api/dashboard/guilds/:guildId/testing-periods - Create testing period
          if (req.method === 'POST' && !parts[5]) {
            if (accessLevel.level !== 'admin') {
              json(res, 403, { error: 'Seuls les administrateurs peuvent créer une période de test' });
              return;
            }
            const body = await readJsonBody<{
              staffUserId: string;
              mentorId?: string;
            }>(req);

            if (!body?.staffUserId) {
              json(res, 400, { error: 'staffUserId est obligatoire' });
              return;
            }

            try {
              const period = await createTestingPeriod(guildId, body.staffUserId, body.mentorId);
              json(res, 201, { period });
            } catch (err) {
              logger.error('StaffAPI', 'Error creating testing period:', err);
              json(res, 500, { error: 'Erreur lors de la création de la période de test' });
            }
            return;
          }

          // PATCH /api/dashboard/guilds/:guildId/testing-periods/:periodId - End testing period
          if (req.method === 'PATCH' && parts[5]) {
            const periodId = parts[5];
            const body = await readJsonBody<{
              status: 'PASSED' | 'FAILED';
              notes?: string;
              force?: boolean;
            }>(req);

            if (!body?.status) {
              json(res, 400, { error: 'status est obligatoire' });
              return;
            }

            try {
              // Vérification de la durée minimum si validation
              if (body.status === 'PASSED') {
                const period = await prisma.testingPeriod.findUnique({
                  where: { id: periodId },
                  select: { startDate: true, guildId: true }
                });

                if (period) {
                  const config = await tutoringService.getTutoringConfig(period.guildId);
                  const minDays = config.minTestDays || 14;
                  const diffMs = Date.now() - period.startDate.getTime();
                  const diffDays = diffMs / (1000 * 60 * 60 * 24);

                  if (diffDays < minDays && !body.force) {
                    json(res, 403, { 
                      error: `La période de test est trop courte (${Math.floor(diffDays)}j / ${minDays}j).`,
                      canForce: accessLevel.level === 'admin'
                    });
                    return;
                  }

                  if (body.force && accessLevel.level !== 'admin') {
                    json(res, 403, { error: 'Seuls les administrateurs peuvent forcer une validation précoce.' });
                    return;
                  }
                }
              }

              const period = await endTestingPeriod(periodId, body.status, body.notes);

              await pushAudit(guildId, {
                user: user.username ?? `User${user.userId}`,
                action: `Fin période de test (${body.status})${body.force ? ' [FORCÉ]' : ''}`,
                context: getGuildName(client, guildId),
                module: 'Staff Management',
                eventType: 'Manuel',
                details: `Période de test: ${periodId} - ${body.status}${body.force ? ' (Bypass durée minimum)' : ''}`,
                channelId: null
              });

              json(res, 200, { period });
            } catch (err) {
              logger.error('StaffAPI', 'Error ending testing period:', err);
              json(res, 500, { error: 'Erreur lors de la fin de la période de test' });
            }
            return;
          }
        }
      }

      // GET /api/dashboard/guilds/:guildId/staff/resignations
      // Accessible to admins (all resignations) OR to the current user (only their own)
      if (req.method === 'GET' && parts[4] === 'staff' && parts[5] === 'resignations' && !parts[6]) {
        try {
          // Admins see all; non-admins see only their own
          const isAdmin = accessLevel.level === 'admin';
          const staffMemberFilter = isAdmin ? {} : { userId: user.userId };

          const resignations = await prisma.staffResignation.findMany({
            where: {
              guildId,
              ...(isAdmin ? {} : {
                staffMember: { userId: user.userId }
              })
            },
            orderBy: [
              { status: 'asc' }, // PENDING first
              { createdAt: 'desc' }
            ],
            include: {
              staffMember: {
                select: { userId: true, username: true, displayName: true, avatarUrl: true, grade: true }
              }
            }
          });
          json(res, 200, {
            resignations: resignations.map(r => ({
              id: r.id,
              guildId: r.guildId,
              staffUserId: r.staffUserId,
              reason: r.reason,
              status: r.status,
              decisionByUserId: r.decisionByUserId,
              decisionNote: r.decisionNote,
              decidedAt: r.decidedAt?.toISOString() ?? null,
              ticketChannelId: r.ticketChannelId,
              createdAt: r.createdAt.toISOString(),
              updatedAt: r.updatedAt.toISOString(),
              staffMember: r.staffMember
            }))
          });
        } catch (err) {
          logger.error('ResignationsAPI', 'Error fetching resignations:', err);
          json(res, 500, { error: 'Erreur lors du chargement des demandes' });
        }
        return;
      }

      // POST /api/dashboard/guilds/:guildId/staff/resignations - Submit resignation from dashboard
      if (req.method === 'POST' && parts[4] === 'staff' && parts[5] === 'resignations' && !parts[6]) {
        const body = await readJsonBody<{ reason: string }>(req);

        if (!body?.reason?.trim()) {
          json(res, 400, { error: 'Le motif est obligatoire' });
          return;
        }

        try {
          const staffMember = await prisma.staffMember.findFirst({
            where: { guildId, userId: user.userId }
          });

          if (!staffMember) {
            json(res, 403, { error: 'Vous ne faites pas partie du staff' });
            return;
          }

          // Check for existing pending resignation
          const existingPending = await prisma.staffResignation.findFirst({
            where: { guildId, staffUserId: staffMember.id, status: 'PENDING' }
          });

          if (existingPending) {
            json(res, 409, { error: 'Une demande de démission est déjà en cours', resignation: existingPending });
            return;
          }

          const reason = body.reason.trim().slice(0, 500);
          const resignation = await prisma.staffResignation.create({
            data: {
              guildId,
              staffUserId: staffMember.id,
              reason,
              status: 'PENDING'
            }
          });

          // Notify managers via dashboard notification + Discord DM
          const managers = await prisma.staffMember.findMany({
            where: {
              guildId,
              grade: { in: ['Manager', 'Admin', 'Administrateur', 'Fondateur', 'Direction'] }
            }
          });

          if (managers.length > 0) {
            await Promise.all(managers.map(async (m: { userId: string }) => {
              await createNotification(
                guildId,
                m.userId,
                '🔔 Demande de démission',
                `${staffMember.username ?? user.userId} a soumis une demande de démission via le dashboard.\nMotif : ${reason}`,
                'WARNING',
                '/staff-management?tab=resignations',
                true
              ).catch(() => null);

              // Discord DM to managers
              try {
                const managerUser = await client.users.fetch(m.userId).catch(() => null);
                if (managerUser) {
                  const embed = new EmbedBuilder()
                    .setTitle('🔔 Nouvelle demande de démission')
                    .setDescription(
                      `**${staffMember.username ?? user.userId}** a soumis une demande de démission via le dashboard.\n\n` +
                      `**Motif :**\n> ${reason}\n\n` +
                      `Rendez-vous sur le dashboard pour traiter cette demande.`
                    )
                    .setColor(COLORS.warning)
                    .setTimestamp()
                    .setFooter({ text: `Référence : ${resignation.id}` });
                  await managerUser.send({ embeds: [embed] }).catch(() => null);
                }
              } catch { /* silent fail */ }
            }));
          }

          json(res, 201, { resignation });
        } catch (err) {
          logger.error('ResignationsAPI', 'Error creating resignation:', err);
          json(res, 500, { error: 'Erreur lors de la soumission' });
        }
        return;
      }

      // PATCH /api/dashboard/guilds/:guildId/staff/resignations/:resignationId
      if (req.method === 'PATCH' && parts[4] === 'staff' && parts[5] === 'resignations' && parts[6] && !parts[7]) {
        if (accessLevel.level !== 'admin') {
          json(res, 403, { error: 'Accès refusé' });
          return;
        }
        const resignationId = parts[6];
        const body = await readJsonBody<{ action: 'APPROVED' | 'REJECTED'; note?: string }>(req);

        if (!body?.action || !['APPROVED', 'REJECTED'].includes(body.action)) {
          json(res, 400, { error: 'action doit être APPROVED ou REJECTED' });
          return;
        }

        try {
          const resignation = await prisma.staffResignation.findFirst({
            where: { id: resignationId, guildId },
            include: { staffMember: { select: { userId: true, username: true, displayName: true } } }
          });

          if (!resignation) {
            json(res, 404, { error: 'Demande introuvable' });
            return;
          }

          if (resignation.status !== 'PENDING') {
            json(res, 409, { error: 'Cette demande a déjà été traitée' });
            return;
          }

          const updated = await prisma.staffResignation.update({
            where: { id: resignationId },
            data: {
              status: body.action,
              decisionByUserId: user.userId,
              decisionNote: body.note ?? null,
              decidedAt: new Date()
            }
          });

          // Notif dashboard au staff membre concerné
          await createNotification(
            guildId,
            resignation.staffMember.userId,
            body.action === 'APPROVED' ? '✅ Démission approuvée' : '❌ Démission refusée',
            body.action === 'APPROVED'
              ? `Votre demande de démission a été approuvée.${body.note ? `\nNote : ${body.note}` : ''}`
              : `Votre demande de démission a été refusée.${body.note ? `\nMotif : ${body.note}` : ''}`,
            body.action === 'APPROVED' ? 'SUCCESS' : 'ERROR',
            '/profile',
            true
          ).catch(() => null);

          // MP Discord au staff membre concerné
          try {
            const discordUser = await client.users.fetch(resignation.staffMember.userId).catch(() => null);
            if (discordUser) {
              const dmEmbed = new EmbedBuilder()
                .setTitle(body.action === 'APPROVED' ? '✅ Démission approuvée' : '❌ Démission refusée')
                .setDescription(
                  body.action === 'APPROVED'
                    ? `Votre demande de démission a été **approuvée** par la direction.${body.note ? `\n\n📝 **Note :** ${body.note}` : ''}`
                    : `Votre demande de démission a été **refusée** par la direction.${body.note ? `\n\n📝 **Motif :** ${body.note}` : ''}`
                )
                .setColor(body.action === 'APPROVED' ? COLORS.success : COLORS.error)
                .setTimestamp();
              await discordUser.send({ embeds: [dmEmbed] }).catch(() => null);
            }
          } catch {
            // Silent fail si le MP n'est pas possible
          }

          await logAuditEntry(guildId, {
            user: user.username ?? `User${user.userId}`,
            action: `Démission ${body.action === 'APPROVED' ? 'approuvée' : 'refusée'}`,
            context: getGuildName(client, guildId),
            module: 'Staff Management',
            eventType: 'Manuel',
            details: `Résignation ${resignationId} de ${resignation.staffMember.username ?? resignation.staffMember.userId} → ${body.action}${body.note ? ` (${body.note})` : ''}`,
            channelId: null
          });

          json(res, 200, { resignation: updated });
        } catch (err) {
          logger.error('ResignationsAPI', 'Error updating resignation:', err);
          json(res, 500, { error: 'Erreur lors du traitement de la demande' });
        }
        return;
      }

      // POST /api/dashboard/guilds/:guildId/staff/resignations/:resignationId/ticket
      if (req.method === 'POST' && parts[4] === 'staff' && parts[5] === 'resignations' && parts[6] && parts[7] === 'ticket') {
        if (accessLevel.level !== 'admin') {
          json(res, 403, { error: 'Accès refusé' });
          return;
        }
        const resignationId = parts[6];

        try {
          const resignation = await prisma.staffResignation.findFirst({
            where: { id: resignationId, guildId },
            include: { staffMember: { select: { userId: true, username: true, displayName: true } } }
          });

          if (!resignation) {
            json(res, 404, { error: 'Demande introuvable' });
            return;
          }

          if (resignation.status !== 'PENDING') {
            json(res, 409, { error: 'Impossible d\'ouvrir un ticket : la demande est déjà traitée' });
            return;
          }

          if (resignation.ticketChannelId) {
            json(res, 409, { error: 'Un ticket est déjà ouvert pour cette demande', ticketChannelId: resignation.ticketChannelId });
            return;
          }

          const guildConfig = await prisma.guild.findUnique({
            where: { id: guildId },
            select: { ticketCategoryId: true, ticketStaffRoleId: true }
          });

          const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
          if (!discordGuild) {
            json(res, 503, { error: 'Serveur Discord non disponible' });
            return;
          }

          // Créer le salon de ticket pour la discussion
          const targetDiscordUser = await client.users.fetch(resignation.staffMember.userId).catch(() => null);
          const staffName = resignation.staffMember.displayName ?? resignation.staffMember.username ?? resignation.staffMember.userId;
          const channelName = `demission-${staffName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 30)}`;

          const permissionOverwrites: any[] = [
            {
              id: discordGuild.id, // @everyone
              deny: [PermissionFlagsBits.ViewChannel]
            }
          ];

          if (guildConfig?.ticketStaffRoleId) {
            permissionOverwrites.push({
              id: guildConfig.ticketStaffRoleId,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
            });
          }

          if (targetDiscordUser) {
            permissionOverwrites.push({
              id: targetDiscordUser.id,
              allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
            });
          }

          const ticketChannel = await discordGuild.channels.create({
            name: channelName,
            type: ChannelType.GuildText,
            parent: guildConfig?.ticketCategoryId ?? undefined,
            permissionOverwrites,
            reason: `Discussion de démission pour ${staffName}`
          }).catch(() => null);

          if (!ticketChannel) {
            json(res, 500, { error: 'Impossible de créer le salon Discord' });
            return;
          }

          // Envoyer le message d'intro dans le salon
          if (ticketChannel instanceof TextChannel) {
            const introEmbed = new EmbedBuilder()
              .setTitle('📝 Discussion — Demande de démission')
              .setDescription(
                `Ce salon a été créé pour discuter de la demande de démission de **${staffName}**.\n\n` +
                `**Motif fourni :**\n> ${resignation.reason}\n\n` +
                `Merci d'utiliser ce canal pour toute discussion avant de prendre une décision finale.`
              )
              .setColor(COLORS.info)
              .setTimestamp()
              .setFooter({ text: `Référence : ${resignation.id}` });

            await ticketChannel.send({ content: targetDiscordUser ? `<@${targetDiscordUser.id}>` : '', embeds: [introEmbed] }).catch(() => null);
          }

          // Enregistrer le ticketChannelId en BDD
          await prisma.staffResignation.update({
            where: { id: resignationId },
            data: { ticketChannelId: ticketChannel.id }
          });

          json(res, 201, { ticketChannelId: ticketChannel.id, channelName: ticketChannel.name });
        } catch (err) {
          logger.error('ResignationsAPI', 'Error creating resignation ticket:', err);
          json(res, 500, { error: 'Erreur lors de la création du ticket' });
        }
        return;
      }

      json(res, 404, { error: 'Route introuvable' });

    } catch (error) {
      logger.error('DashboardAPI', error);
      json(res, 500, { error: 'Erreur interne API dashboard' });
    }
  });

  wsServer.on('connection', (socket) => {
    socket.send(
      JSON.stringify({
        type: 'dashboard_ws_connected',
        at: new Date().toISOString(),
      }),
    );
  });

  // Diffuser les messages des salons de tickets en temps réel
  client.on('messageCreate', async (msg) => {
    if (msg.author.bot && msg.author.id !== client.user?.id) return;
    try {
      const ticket = await prisma.ticket.findFirst({
        where: { channelId: msg.channelId }
      });
      if (!ticket) return;

      const payload = JSON.stringify({
        type: 'new_ticket_message',
        ticketId: ticket.id,
        message: {
          id: msg.id,
          authorId: msg.author.id,
          authorName: msg.member?.displayName || msg.author.displayName || msg.author.username,
          authorAvatar: msg.author.displayAvatarURL(),
          isStaff: msg.author.bot,
          content: msg.content,
          htmlContent: parseDiscordMarkdown(msg.content, msg.guild),
          mediaUrls: extractMediaUrls(msg.content),
          stickers: msg.stickers ? msg.stickers.map(s => ({ id: s.id, name: s.name, url: s.url })) : [],
          attachments: msg.attachments.map(a => ({ url: a.url, contentType: a.contentType })),
          embeds: msg.embeds.map(e => ({
            title: e.title,
            description: e.description,
            htmlDescription: e.description ? parseDiscordMarkdown(e.description, msg.guild) : '',
            color: e.hexColor,
            fields: e.fields ? e.fields.map(f => ({
              name: f.name,
              value: f.value,
              htmlValue: f.value ? parseDiscordMarkdown(f.value, msg.guild) : ''
            })) : [],
            image: e.image ? { url: e.image.url } : null,
            thumbnail: e.thumbnail ? { url: e.thumbnail.url } : null,
            video: e.video ? { url: e.video.url } : null
          })),
          createdAt: msg.createdAt.toISOString()
        }
      });

      wsServer.clients.forEach((socket) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(payload);
        }
      });
    } catch (err) {
      logger.error('DashboardWS', 'Erreur lors de la diffusion du message live du ticket:', err);
    }
  });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url) {
      socket.destroy();
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host ?? `localhost:${port}`}`);
    if (url.pathname !== '/api/dashboard/ws') {
      socket.destroy();
      return;
    }

    const token = url.searchParams.get('token');
    if (!token) {
      socket.destroy();
      return;
    }

    try {
      jwt.verify(token, JWT_SECRET);
      wsServer.handleUpgrade(req, socket, head, (ws) => {
        wsServer.emit('connection', ws, req);
      });
    } catch {
      socket.destroy();
    }
  });

  server.listen(port, () => {
    logger.success('DashboardAPI', `API dashboard active sur http://localhost:${port}`);
  });

  return server;
};
