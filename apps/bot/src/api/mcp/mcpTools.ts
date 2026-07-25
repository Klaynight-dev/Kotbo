import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { APIMessageTopLevelComponent, NewsChannel } from 'discord.js';
import { z } from 'zod';
import { Client, TextChannel, ForumChannel, ThreadChannel, ChannelType, EmbedBuilder, ContainerBuilder, TextDisplayBuilder, MessageFlags, ComponentType, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, type Message, type Guild, type APIEmbed, type GuildForumTagData } from 'discord.js';
import type { McpKeyPermission, SanctionType, SanctionStatus } from '@prisma/client';
import { LinkedAccountType, LinkedAccountStatus, Prisma } from '@prisma/client';
import pLimit from 'p-limit';
import prisma from '../../utils/db.js';
import {
  registerWarnSanction,
  registerKickSanction,
  registerBanSanction,
  registerTimeoutSanction,
} from '../../services/moderation/sanctionService.js';
import { closeTicket } from '../../services/features/ticketService.js';
import { adminDeleteShopItem } from '../../services/features/economyService.js';
import { getPredictionData } from '../../services/analytics/predictionService.js';
import { getPulseDashboardData } from '../../services/analytics/pulseService.js';
import { getHourlyHeatmapData } from '../../services/analytics/dashboardAnalyticsService.js';
import {
  getModuleStatsSummary,
  getModuleActivationStats,
  getModuleUsageStats,
  getModulePerformanceStats,
  KOTBO_MODULES,
  setModuleActivation,
} from '../../services/analytics/moduleStatsService.js';

// Services Kotbo additionnels pour les outils MCP
import { createCustomEvent } from '../../services/features/eventService.js';
import { createCustomForm, deleteCustomForm } from '../../services/features/customFormService.js';
import {
  getSeasonsDashboardData,
  createSeason,
  startSeason,
  endSeason,
  getSeasonLeaderboard,
} from '../../services/progression/seasonService.js';
import {
  getEvaluationsDashboardData,
  generateStaffEvaluation,
  generateAllStaffEvaluations,
  updateEvaluationNote,
} from '../../services/staff/staffEvaluationService.js';
import { guardAdminGrant, roleGrantsAdministrator } from '../../services/moderation/adminLockService.js';
import {
  getChannelHealthDashboardData,
  analyzeGuildChannelHealth,
  resolveHealthAlert,
  upsertChannelHealthConfig,
  createSplitChannel,
  archiveChannel,
} from '../../services/analytics/channelHealthService.js';
import {
  pushWidgetForUser,
  clearWidgetForUser,
  refreshAllStaffWidgets,
} from '../../services/integrations/widgetService.js';
import {
  generateTranscriptFromMessages,
  resolveMentionsToText,
  embedToApiShape,
} from '../../services/features/transcriptService.js';
import { sanitizeCustomCss, sanitizeFormTheme } from '../../utils/formCustomization.js';
import { embedToV2 } from '../../utils/patchV2.js';
import { getCallPermissionConfig, updateCallPermissionConfig, getAbsences, createAbsence, updateAbsenceStatus, deleteAbsence, getMeetings, createMeeting, updateMeeting, deleteMeeting, getNotifications, markNotificationRead, markAllNotificationsRead, getPolls, createPoll, castPollVote, getCalls, createCall, updateCall, deleteCall, getTasks, createTask, updateTask, deleteTask, createManagerNote, deleteManagerNote, getStaffAlertsAndProgression, getStaffCalendarData } from '../../services/staff/staffLeadershipService.js';
import { addStaffMember, removeStaffMember } from '../../services/staff/staffManagementService.js';
import {
  getStaffRoles,
  createStaffRole,
  reorderStaffRoles,
  deleteStaffRole,
  updateStaffRole,
  createAPIKey,
  getAPIKeys,
  deleteAPIKey,
  generateAPIKey,
  hashAPIKey,
  getStaffHierarchies,
  createStaffHierarchy,
  updateStaffHierarchy,
  deleteStaffHierarchy,
  addMemberToHierarchy,
  removeMemberFromHierarchy,
  syncStaffHierarchyMemberships,
  importRoleMembers,
} from '../../services/staff/staffManagementService.js';
import { addXp } from '../../services/progression/levelingService.js';
import { createGiveaway, endGiveaway, rerollGiveaway } from '../../services/features/giveawayService.js';
import { linkAccounts, unlinkAccounts, getAllLinkedUserIds } from '../../services/moderation/altAccountService.js';
import {
  decideAppeal,
  requestAppealInfo,
  getAppealConfig,
  upsertAppealConfig,
  ensureDefaultAppealForm,
  getAppealDetail,
} from '../../services/moderation/banAppealService.js';

// Helpers annotés explicitement en `CallToolResult` (le type de retour attendu
// par `registerTool`), plutôt qu'en union de types anonymes inférés. Cela donne
// un point d'ancrage stable au vérificateur ; le vrai gain mémoire vient
// toutefois du wrapper non générique dans `registerMcpTools` (voir plus bas).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type McpToolHandler = (args: any) => CallToolResult | Promise<CallToolResult>;
type ToolSecurityScheme = { type: 'noauth' } | { type: 'oauth2'; scopes: string[] };

const ok = (data: unknown): CallToolResult => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

const err = (msg: string, meta?: Record<string, unknown>): CallToolResult => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
  isError: true,
  ...(meta ? { _meta: meta } : {}),
});

// Renvoie une "erreur" structurée listant les candidats possibles quand une
// recherche par nom est ambiguë, pour que l'agent (ou l'utilisateur) puisse
// préciser sans avoir à connaître les IDs à l'avance.
const ambiguous = (raw: string, kind: string, candidates: unknown[]): CallToolResult => ({
  content: [
    {
      type: 'text' as const,
      text: JSON.stringify(
        {
          error: `Plusieurs ${kind} correspondent à « ${raw} ».`,
          hint: "Rappelle le même outil en reprenant le nom exact (ou l'ID) d'un des candidats ci-dessous.",
          candidates,
        },
        null,
        2
      ),
    },
  ],
  isError: true,
});

const MENTION_USER = /^<@!?(\d+)>$/;
const MENTION_CHANNEL = /^<#(\d+)>$/;
const SNOWFLAKE = /^\d{16,20}$/;

type MemberResolution =
  | { ok: true; userId: string; label: string }
  | { ok: false; response: ReturnType<typeof err> };

// Accepte un ID Discord, une mention <@id>, ou un nom (username / displayName /
// globalName / tag) et le résout vers un userId unique. En cas d'ambiguïté ou
// d'absence de résultat, renvoie une réponse d'erreur exploitable directement.
async function resolveMember(guildId: string, raw: string): Promise<MemberResolution> {
  const input = raw.trim();

  const mention = input.match(MENTION_USER);
  const directId = mention ? mention[1] : SNOWFLAKE.test(input) ? input : null;
  if (directId) {
    return { ok: true, userId: directId, label: directId };
  }

  const name = input.replace(/^@/, '');
  const matches = await prisma.memberProfile.findMany({
    where: {
      guildId,
      OR: [
        { username: { contains: name, mode: 'insensitive' } },
        { displayName: { contains: name, mode: 'insensitive' } },
        { globalName: { contains: name, mode: 'insensitive' } },
        { userTag: { contains: name, mode: 'insensitive' } },
      ],
    },
    take: 10,
    orderBy: { lastSeenAt: 'desc' },
    select: { userId: true, username: true, displayName: true, globalName: true, userTag: true },
  });

  const lower = name.toLowerCase();
  const exact = matches.filter(
    (m) =>
      m.username?.toLowerCase() === lower ||
      m.displayName?.toLowerCase() === lower ||
      m.globalName?.toLowerCase() === lower ||
      m.userTag?.toLowerCase() === lower
  );

  const pick = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null;
  if (pick) {
    return { ok: true, userId: pick.userId, label: pick.displayName ?? pick.username ?? pick.userId };
  }

  if (matches.length === 0) {
    return {
      ok: false,
      response: err(`Aucun membre ne correspond à « ${raw} ». Vérifie l'orthographe ou utilise search_members.`),
    };
  }

  return {
    ok: false,
    response: ambiguous(
      raw,
      'membres',
      matches.map((m) => ({
        userId: m.userId,
        username: m.username,
        displayName: m.displayName,
      }))
    ),
  };
}

type ChannelResolution =
  | { ok: true; channel: TextChannel | NewsChannel }
  | { ok: false; response: ReturnType<typeof err> };

// Accepte un ID de salon, une mention <#id>, ou un nom de salon (avec ou sans #)
// et le résout vers un salon textuel unique.
function resolveChannel(guildId: string, client: Client, raw: string): ChannelResolution {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { ok: false, response: err('Serveur Discord introuvable') };

  const input = raw.trim();
  const mention = input.match(MENTION_CHANNEL);
  const directId = mention ? mention[1] : SNOWFLAKE.test(input) ? input : null;
  if (directId) {
    const ch = guild.channels.cache.get(directId);
    if (!ch) return { ok: false, response: err('Salon introuvable') };
    if (!ch.isTextBased()) return { ok: false, response: err("Ce salon n'est pas un salon textuel") };
    return { ok: true, channel: ch as TextChannel | NewsChannel };
  }

  const name = input.replace(/^#/, '').toLowerCase();
  const textChannels = guild.channels.cache.filter((c) => c.isTextBased());

  let matches = textChannels.filter((c) => c.name.toLowerCase() === name);
  if (matches.size === 0) matches = textChannels.filter((c) => c.name.toLowerCase().includes(name));

  if (matches.size === 0) {
    return { ok: false, response: err(`Aucun salon ne correspond à « ${raw} ».`) };
  }
  if (matches.size > 1) {
    return {
      ok: false,
      response: ambiguous(
        raw,
        'salons',
        matches.map((c) => ({ id: c.id, name: c.name })).slice(0, 10)
      ),
    };
  }

  return { ok: true, channel: matches.first() as TextChannel | NewsChannel };
}

type ForumResolution =
  | { ok: true; forum: ForumChannel }
  | { ok: false; response: ReturnType<typeof err> };

function resolveForum(guildId: string, client: Client, raw: string): ForumResolution {
  const guild = client.guilds.cache.get(guildId);
  if (!guild) return { ok: false, response: err('Serveur Discord introuvable') };

  const input = raw.trim();
  const mention = input.match(MENTION_CHANNEL);
  const directId = mention ? mention[1] : SNOWFLAKE.test(input) ? input : null;
  if (directId) {
    const channel = guild.channels.cache.get(directId);
    if (!channel) return { ok: false, response: err('Forum introuvable') };
    if (channel.type !== ChannelType.GuildForum) {
      return { ok: false, response: err("Ce salon n'est pas un forum Discord") };
    }
    return { ok: true, forum: channel };
  }

  const name = input.replace(/^#/, '').toLowerCase();
  const forums = guild.channels.cache.filter((channel): channel is ForumChannel => channel.type === ChannelType.GuildForum);
  let matches = forums.filter((forum) => forum.name.toLowerCase() === name);
  if (matches.size === 0) matches = forums.filter((forum) => forum.name.toLowerCase().includes(name));

  if (matches.size === 0) return { ok: false, response: err(`Aucun forum ne correspond à « ${raw} ».`) };
  if (matches.size > 1) {
    return {
      ok: false,
      response: ambiguous(raw, 'forums', matches.map((forum) => ({ id: forum.id, name: forum.name })).slice(0, 10)),
    };
  }
  return { ok: true, forum: matches.first()! };
}

type ForumPostResolution =
  | { ok: true; post: ThreadChannel }
  | { ok: false; response: ReturnType<typeof err> };

async function resolveForumPost(forum: ForumChannel, raw: string): Promise<ForumPostResolution> {
  const input = raw.trim();
  const mention = input.match(MENTION_CHANNEL);
  const directId = mention ? mention[1] : SNOWFLAKE.test(input) ? input : null;
  if (directId) {
    const post = await forum.threads.fetch(directId).catch(() => null);
    if (!post || post.parentId !== forum.id) return { ok: false, response: err('Article de forum introuvable') };
    return { ok: true, post };
  }

  const [active, archived] = await Promise.all([
    forum.threads.fetchActive().catch(() => null),
    forum.threads.fetchArchived({ limit: 100 }).catch(() => null),
  ]);
  const posts = new Map<string, ThreadChannel>();
  for (const post of active?.threads.values() ?? []) posts.set(post.id, post);
  for (const post of archived?.threads.values() ?? []) posts.set(post.id, post);

  const name = input.toLowerCase();
  let matches = [...posts.values()].filter((post) => post.name.toLowerCase() === name);
  if (matches.length === 0) matches = [...posts.values()].filter((post) => post.name.toLowerCase().includes(name));
  if (matches.length === 0) return { ok: false, response: err(`Aucun article ne correspond à « ${raw} ».`) };
  if (matches.length > 1) {
    return {
      ok: false,
      response: ambiguous(raw, 'articles de forum', matches.slice(0, 10).map((post) => ({ id: post.id, name: post.name }))),
    };
  }
  return { ok: true, post: matches[0]! };
}

function resolveForumTagIds(forum: ForumChannel, values: string[]):
  | { ok: true; ids: string[] }
  | { ok: false; response: ReturnType<typeof err> } {
  const ids: string[] = [];
  for (const raw of values) {
    const input = raw.trim();
    const byId = forum.availableTags.find((tag) => tag.id === input);
    const exact = forum.availableTags.filter((tag) => tag.name.toLowerCase() === input.toLowerCase());
    const tag = byId ?? (exact.length === 1 ? exact[0] : null);
    if (!tag) {
      return {
        ok: false,
        response: err(`Tag de forum introuvable : « ${raw} ».`, {
          availableTags: forum.availableTags.map((item) => ({ id: item.id, name: item.name })),
        }),
      };
    }
    if (!ids.includes(tag.id)) ids.push(tag.id);
  }
  return { ok: true, ids };
}

const mcpEmbedSchema = z.object({
  title: z.string().max(256).optional(),
  description: z.string().max(4096).optional(),
  color: z.number().int().min(0).max(0xffffff).optional().describe('Couleur décimale entre 0 et 16777215'),
  url: z.string().url().optional(),
  thumbnail_url: z.string().url().optional(),
  image_url: z.string().url().optional(),
  footer: z.string().max(2048).optional(),
  fields: z.array(z.object({
    name: z.string().min(1).max(256),
    value: z.string().min(1).max(1024),
    inline: z.boolean().default(false),
  })).max(25).optional(),
}).superRefine((embed, context) => {
  const totalCharacters =
    (embed.title?.length ?? 0) +
    (embed.description?.length ?? 0) +
    (embed.footer?.length ?? 0) +
    (embed.fields ?? []).reduce((total, field) => total + field.name.length + field.value.length, 0);
  if (totalCharacters > 6000) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Discord limite le total title + description + fields + footer à 6000 caractères par message.',
    });
  }
  if (totalCharacters === 0 && !embed.url && !embed.thumbnail_url && !embed.image_url) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Un embed doit contenir au moins un texte, une URL, une miniature ou une image.',
    });
  }
});

type McpEmbedInput = z.infer<typeof mcpEmbedSchema>;

function buildApiEmbed(input: McpEmbedInput): APIEmbed {
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.color !== undefined ? { color: input.color } : {}),
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.thumbnail_url !== undefined ? { thumbnail: { url: input.thumbnail_url } } : {}),
    ...(input.image_url !== undefined ? { image: { url: input.image_url } } : {}),
    ...(input.footer !== undefined ? { footer: { text: input.footer } } : {}),
    ...(input.fields !== undefined ? { fields: input.fields } : {}),
  };
}

function buildV2MessageComponents(content: string | null | undefined, embed: McpEmbedInput | null | undefined) {
  const components: Array<TextDisplayBuilder | ContainerBuilder> = [];
  if (content) components.push(new TextDisplayBuilder().setContent(content));
  if (embed) components.push(embedToV2(buildApiEmbed(embed)));
  return components;
}

function serializeDiscordMessage(message: Message, guild?: Guild) {
  return {
    id: message.id,
    authorId: message.author.id,
    authorName: message.author.username,
    content: message.content ? resolveMentionsToText(message.content, guild) : '',
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString() ?? null,
    format: message.flags.has(MessageFlags.IsComponentsV2) ? 'v2' : 'v1',
    embeds: message.embeds.map((embed) => embedToApiShape(embed, guild)),
    components: message.components.map((component) => component.toJSON()),
    attachments: [...message.attachments.values()].map((attachment) => ({
      id: attachment.id,
      name: attachment.name,
      url: attachment.url,
      contentType: attachment.contentType,
      size: attachment.size,
    })),
  };
}

type StaffMemberResolution =
  | { ok: true; staffMember: { id: string; userId: string; label: string } }
  | { ok: false; response: ReturnType<typeof err> };

async function resolveStaffMemberRecord(guildId: string, client: Client, raw: string): Promise<StaffMemberResolution> {
  const resolved = await resolveMember(guildId, raw);
  if (!resolved.ok) return resolved;

  const staffMember = await prisma.staffMember.findUnique({
    where: { guildId_userId: { guildId, userId: resolved.userId } },
    select: { id: true, userId: true, username: true, displayName: true },
  });

  if (!staffMember) {
    return { ok: false, response: err('Membre du staff introuvable') };
  }

  return {
    ok: true,
    staffMember: {
      id: staffMember.id,
      userId: staffMember.userId,
      label: staffMember.displayName ?? staffMember.username ?? staffMember.userId,
    },
  };
}

const MAX_EVIDENCE_MESSAGES = 200;
const MAX_SCAN_MESSAGES = 400;
const EVIDENCE_CHANNEL_CONCURRENCY = 5;

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
    })),
    embeds: msg.embeds.map((embed) => embedToApiShape(embed, guild)),
  };
}

function parseEvidenceLinks(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => /^https?:\/\//i.test(entry));
}

const oauthSecuritySchemes = [
  { type: 'oauth2', scopes: ['mcp'] },
] satisfies ToolSecurityScheme[];

// Forme du `config` accepté par `registerTool`, sans les génériques du SDK.
type McpToolConfig = {
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

export function registerMcpTools(
  mcpServer: McpServer,
  guildId: string,
  permissions: McpKeyPermission[],
  client: Client,
  options: { listAllTools?: boolean; wwwAuthenticate?: string; securitySchemes?: ToolSecurityScheme[] } = {}
) {
  // Vue NON GÉNÉRIQUE de `mcpServer.registerTool` — ne pas remplacer par un
  // appel direct au SDK.
  //
  // La signature réelle est :
  //   registerTool<OutputArgs extends ZodRawShapeCompat | AnySchema,
  //                InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined>
  // avec `AnySchema = z3.ZodTypeAny | z4.$ZodType` (Zod v3 ET v4).
  //
  // `OutputArgs` n'a pas de valeur par défaut et aucun outil ici ne passe
  // `outputSchema` : TypeScript devait donc le résoudre depuis sa contrainte,
  // puis calculer `ShapeOutput<InputArgs>` pour chacun des ~240 appels de ce
  // fichier. Comme tous les handlers sont typés `(args: any)` via
  // `McpToolHandler`, le résultat de cette inférence était intégralement jeté :
  // on payait >9 Go de RAM de typecheck pour rien, ce qui faisait tomber `tsgo`
  // en OOM (et `tsc` culminait à ~13 Go).
  //
  // Ce wrapper conserve exactement le même comportement à l'exécution.
  const server = {
    registerTool: (name: string, config: McpToolConfig, cb: McpToolHandler) =>
      mcpServer.registerTool(name, config as never, cb as never),
  };

  const has = (p: McpKeyPermission) => permissions.includes(p);
  const shouldRegister = (p: McpKeyPermission) => options.listAllTools || has(p);
  const toolMeta = {
    securitySchemes: options.securitySchemes ?? oauthSecuritySchemes,
  };
  const guard = (permission: McpKeyPermission, handler: McpToolHandler): McpToolHandler => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return async (args: any) => {
      if (!has(permission)) {
        return err(`Autorisation MCP requise: permission ${permission}.`, {
          'mcp/www_authenticate': [
            options.wwwAuthenticate ?? 'Bearer error="insufficient_scope", error_description="Autorisation MCP Kotbo requise"',
          ],
        });
      }

      return handler(args);
    };
  };

  // Journalise une action MCP dans l'audit log du dashboard.
  const audit = (keyName: string | undefined, action: string, context: string, details: string) =>
    prisma.dashboardAuditLog
      .create({
        data: {
          guildId,
          user: `MCP[${keyName ?? 'agent'}]`,
          action,
          context,
          module: 'MCP',
          eventType: 'Action',
          details,
          dateIso: new Date(),
        },
      })
      .catch(() => undefined);

  // ── READ_STATS ────────────────────────────────────────────────────────────

  if (shouldRegister('READ_STATS')) {
    server.registerTool(
      'get_guild_stats',
      {
        description: 'Récupère les statistiques du serveur Discord (membres, messages, sanctions) sur une période donnée.',
        inputSchema: { period_days: z.number().int().min(1).max(90).default(30).describe('Nombre de jours à analyser (1-90)') },
        _meta: toolMeta,
      },
      guard('READ_STATS', async ({ period_days }) => {
        const since = new Date();
        since.setDate(since.getDate() - period_days);
        const sinceKey = since.toISOString().slice(0, 10);

        const stats = await prisma.guildDailyStat.findMany({
          where: { guildId, dateKey: { gte: sinceKey } },
          orderBy: { dateKey: 'asc' },
        });

        const discordGuild = client.guilds.cache.get(guildId);

        const totals = stats.reduce(
          (acc: { messages: number; voiceMinutes: number; joins: number; leaves: number; sanctions: number }, s) => ({
            messages: acc.messages + s.messagesCount,
            voiceMinutes: acc.voiceMinutes + s.voiceMinutes,
            joins: acc.joins + s.membersJoined,
            leaves: acc.leaves + s.membersLeft,
            sanctions: acc.sanctions + s.sanctionsCount,
          }),
          { messages: 0, voiceMinutes: 0, joins: 0, leaves: 0, sanctions: 0 }
        );

        return ok({
          guildId,
          currentMemberCount: discordGuild?.memberCount ?? null,
          period: { from: sinceKey, days: period_days },
          totals,
          trend: stats.map((s) => ({
            date: s.dateKey,
            messages: s.messagesCount,
            voiceMinutes: s.voiceMinutes,
            joins: s.membersJoined,
            leaves: s.membersLeft,
            sanctions: s.sanctionsCount,
          })),
        });
      })
    );
  }

  // ── READ_MEMBERS ──────────────────────────────────────────────────────────

  if (shouldRegister('READ_MEMBERS')) {
    server.registerTool(
      'get_recent_messages',
      {
        description: "Récupère les messages récents d'un salon Discord (lecture en direct via l'API Discord).",
        inputSchema: {
          channel: z.string().describe('Nom du salon (ex: « general », avec ou sans #), mention <#id> ou ID'),
          limit: z.number().int().min(1).max(100).default(20).describe('Nombre de messages (1-100)'),
        },
        _meta: toolMeta,
      },
      guard('READ_MEMBERS', async ({ channel, limit }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        const messages = await resolved.channel.messages.fetch({ limit }).catch(() => null);
        if (!messages) return err('Impossible de lire les messages (permissions insuffisantes)');

        return ok(
          messages.map((m) => ({
            id: m.id,
            authorId: m.author.id,
            authorName: m.author.username,
            content: m.content,
            createdAt: m.createdAt.toISOString(),
          }))
        );
      })
    );

    server.registerTool(
      'list_forum_posts',
      {
        description:
          'Liste les articles actifs et, sur demande, archivés d’un forum Discord avec leurs tags. Requiert READ_MEMBERS.',
        inputSchema: {
          forum: z.string().describe('Nom, mention ou ID du forum'),
          include_archived: z.boolean().default(true),
          limit: z.number().int().min(1).max(100).default(50),
        },
        _meta: toolMeta,
      },
      guard('READ_MEMBERS', async ({ forum, include_archived, limit }) => {
        const resolved = resolveForum(guildId, client, forum);
        if (!resolved.ok) return resolved.response;

        const active = await resolved.forum.threads.fetchActive().catch(() => null);
        if (!active) return err('Impossible de lire les articles actifs du forum (permissions insuffisantes ?)');
        const archived = include_archived
          ? await resolved.forum.threads.fetchArchived({ limit }).catch(() => null)
          : null;

        const posts = new Map<string, ThreadChannel>();
        for (const post of active.threads.values()) posts.set(post.id, post);
        for (const post of archived?.threads.values() ?? []) posts.set(post.id, post);
        const tagNames = new Map(resolved.forum.availableTags.map((tag) => [tag.id, tag.name]));

        return ok({
          forum: {
            id: resolved.forum.id,
            name: resolved.forum.name,
            topic: resolved.forum.topic,
            tags: resolved.forum.availableTags,
          },
          posts: [...posts.values()]
            .sort((a, b) => (b.createdTimestamp ?? 0) - (a.createdTimestamp ?? 0))
            .slice(0, limit)
            .map((post) => ({
              id: post.id,
              name: post.name,
              ownerId: post.ownerId,
              createdAt: post.createdAt?.toISOString() ?? null,
              archived: post.archived,
              locked: post.locked,
              messageCount: post.messageCount,
              appliedTags: post.appliedTags.map((id) => ({ id, name: tagNames.get(id) ?? null })),
            })),
        });
      })
    );

    server.registerTool(
      'read_forum_post',
      {
        description:
          'Lit le contenu et les réponses d’un article de forum Discord, embeds et composants v2 inclus. Requiert READ_MEMBERS.',
        inputSchema: {
          forum: z.string().describe('Nom, mention ou ID du forum'),
          post: z.string().describe('Titre, mention ou ID de l’article'),
          limit: z.number().int().min(1).max(100).default(50),
          before_message_id: z.string().optional().describe('Pagination : messages antérieurs à cet ID'),
        },
        _meta: toolMeta,
      },
      guard('READ_MEMBERS', async ({ forum, post, limit, before_message_id }) => {
        const resolvedForum = resolveForum(guildId, client, forum);
        if (!resolvedForum.ok) return resolvedForum.response;
        const resolvedPost = await resolveForumPost(resolvedForum.forum, post);
        if (!resolvedPost.ok) return resolvedPost.response;

        const [starterMessage, messages] = await Promise.all([
          // Dans un forum, l’ID du fil est aussi celui du premier message.
          // On le récupère séparément pour ne jamais perdre le contenu de
          // l’article quand il possède plus de `limit` réponses.
          resolvedPost.post.messages.fetch(resolvedPost.post.id).catch(() => null),
          resolvedPost.post.messages
            .fetch({ limit, ...(before_message_id ? { before: before_message_id } : {}) })
            .catch(() => null),
        ]);
        if (!messages) return err('Impossible de lire cet article (permissions insuffisantes ?)');
        const tagNames = new Map(resolvedForum.forum.availableTags.map((tag) => [tag.id, tag.name]));

        return ok({
          post: {
            id: resolvedPost.post.id,
            name: resolvedPost.post.name,
            forumId: resolvedForum.forum.id,
            ownerId: resolvedPost.post.ownerId,
            archived: resolvedPost.post.archived,
            locked: resolvedPost.post.locked,
            appliedTags: resolvedPost.post.appliedTags.map((id) => ({ id, name: tagNames.get(id) ?? null })),
          },
          starterMessage: starterMessage
            ? serializeDiscordMessage(starterMessage, resolvedForum.forum.guild)
            : null,
          messages: messages
            .filter((message) => message.id !== resolvedPost.post.id)
            .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
            .map((message) => serializeDiscordMessage(message, resolvedForum.forum.guild)),
        });
      })
    );

    server.registerTool(
      'get_member_profile',
      {
        description: "Récupère le profil d'un membre du serveur (activité, historique, informations Discord).",
        inputSchema: { member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre') },
        _meta: toolMeta,
      },
      guard('READ_MEMBERS', async ({ member }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        const member_id = resolved.userId;

        const [profile, discordMember] = await Promise.all([
          prisma.memberProfile.findUnique({
            where: { guildId_userId: { guildId, userId: member_id } },
          }),
          client.guilds.cache.get(guildId)?.members.fetch(member_id).catch(() => null),
        ]);

        if (!profile && !discordMember) return err('Membre introuvable');

        return ok({
          userId: member_id,
          profile: profile
            ? {
                messageCount: profile.messageCount,
                voiceTimeSeconds: profile.voiceTimeSeconds,
                joinedAt: profile.guildJoinedAt?.toISOString(),
                lastSeenAt: profile.lastSeenAt.toISOString(),
                lastMessageAt: profile.lastMessageAt?.toISOString(),
                isSuspectedDC: profile.isSuspectedDC,
                moderatorNote: profile.moderatorNote,
              }
            : null,
          discord: discordMember
            ? {
                username: discordMember.user.username,
                displayName: discordMember.displayName,
                avatarUrl: discordMember.displayAvatarURL(),
                roles: discordMember.roles.cache.map((r) => ({ id: r.id, name: r.name })),
                joinedAt: discordMember.joinedAt?.toISOString(),
              }
            : null,
        });
      })
    );

    server.registerTool(
      'search_members',
      {
        description: "Recherche des membres par nom d'utilisateur ou nom d'affichage.",
        inputSchema: {
          query: z.string().describe('Terme de recherche (username, displayName ou userId)'),
          limit: z.number().int().min(1).max(50).default(20),
        },
        _meta: toolMeta,
      },
      guard('READ_MEMBERS', async ({ query, limit }) => {
        const members = await prisma.memberProfile.findMany({
          where: {
            guildId,
            OR: [
              { userId: query },
              { username: { contains: query, mode: 'insensitive' } },
              { displayName: { contains: query, mode: 'insensitive' } },
            ],
          },
          take: limit,
          orderBy: { lastSeenAt: 'desc' },
          select: {
            userId: true,
            username: true,
            displayName: true,
            messageCount: true,
            lastSeenAt: true,
            guildJoinedAt: true,
          },
        });

        const enriched = members.map((m) => ({
          userId: m.userId,
          username: m.username,
          displayName: m.displayName,
          messageCount: m.messageCount,
          lastSeenAt: m.lastSeenAt.toISOString(),
          joinedAt: m.guildJoinedAt?.toISOString() ?? null,
        }));

        return ok(enriched);
      })
    );
  }

  // ── READ_SANCTIONS ────────────────────────────────────────────────────────

  if (shouldRegister('READ_SANCTIONS')) {
    server.registerTool(
      'get_sanctions',
      {
        description: 'Liste les sanctions du serveur avec filtres optionnels.',
        inputSchema: {
          member: z.string().optional().describe('Filtrer par membre : nom, surnom, @mention ou ID'),
          type: z.enum(['WARN', 'KICK', 'TIMEOUT', 'TEMP_BAN', 'BAN', 'SOFTBAN']).optional(),
          status: z.enum(['ACTIVE', 'RESOLVED', 'FAILED']).optional(),
          limit: z.number().int().min(1).max(100).default(50),
          offset: z.number().int().min(0).default(0),
        },
        _meta: toolMeta,
      },
      guard('READ_SANCTIONS', async ({ member, type, status, limit, offset }) => {
        let member_id: string | undefined;
        if (member) {
          const resolved = await resolveMember(guildId, member);
          if (!resolved.ok) return resolved.response;
          member_id = resolved.userId;
        }

        const [sanctions, total] = await Promise.all([
          prisma.sanction.findMany({
            where: {
              guildId,
              ...(member_id ? { targetUserId: member_id } : {}),
              ...(type ? { type: type as SanctionType } : {}),
              ...(status ? { status: status as SanctionStatus } : {}),
            },
            orderBy: { createdAt: 'desc' },
            take: limit,
            skip: offset,
          }),
          prisma.sanction.count({
            where: {
              guildId,
              ...(member_id ? { targetUserId: member_id } : {}),
              ...(type ? { type: type as SanctionType } : {}),
              ...(status ? { status: status as SanctionStatus } : {}),
            },
          }),
        ]);

        return ok({
          total,
          sanctions: sanctions.map((s) => ({
            id: s.id,
            type: s.type,
            status: s.status,
            targetUserId: s.targetUserId,
            targetTag: s.targetTag,
            moderatorUserId: s.moderatorUserId,
            moderatorTag: s.moderatorTag,
            reason: s.reason,
            durationSeconds: s.durationSeconds,
            expiresAt: s.expiresAt?.toISOString(),
            createdAt: s.createdAt.toISOString(),
            resolvedAt: s.resolvedAt?.toISOString(),
          })),
        });
      })
    );

    server.registerTool(
      'get_sanction_history',
      {
        description: "Récupère l'historique complet des sanctions pour un membre spécifique.",
        inputSchema: { member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre') },
        _meta: toolMeta,
      },
      guard('READ_SANCTIONS', async ({ member }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        const member_id = resolved.userId;

        const [sanctions, reports] = await Promise.all([
          prisma.sanction.findMany({
            where: { guildId, targetUserId: member_id },
            orderBy: { createdAt: 'desc' },
          }),
          prisma.sanctionReport.findMany({
            where: { guildId, memberReference: member_id },
            orderBy: { createdAt: 'desc' },
          }),
        ]);

        const byType: Record<string, number> = {};
        for (const s of sanctions) {
          byType[s.type] = (byType[s.type] ?? 0) + 1;
        }

        return ok({
          memberId: member_id,
          summary: {
            total: sanctions.length,
            active: sanctions.filter((s) => s.status === 'ACTIVE').length,
            byType,
          },
          sanctions: sanctions.map((s) => ({
            id: s.id,
            type: s.type,
            status: s.status,
            reason: s.reason,
            moderatorTag: s.moderatorTag,
            durationSeconds: s.durationSeconds,
            createdAt: s.createdAt.toISOString(),
          })),
          reports: reports.map((r) => ({
            id: r.id,
            sanctionId: r.sanctionId,
            brokenRules: r.brokenRules,
            detailedReason: r.detailedReason,
            evidenceLinks: r.evidenceLinks,
            createdAt: r.createdAt.toISOString(),
          })),
        });
      })
    );

    server.registerTool(
      'get_sanction_reports',
      {
        description: 'Liste les rapports de sanction (preuves documentées) du serveur. Requiert READ_SANCTIONS.',
        inputSchema: {
          sanction_id: z.string().optional().describe('Filtrer par ID de sanction liée'),
          limit: z.number().int().min(1).max(100).default(50),
        },
        _meta: toolMeta,
      },
      guard('READ_SANCTIONS', async ({ sanction_id, limit }) => {
        const reports = await prisma.sanctionReport.findMany({
          where: { guildId, ...(sanction_id ? { sanctionId: sanction_id } : {}) },
          orderBy: { createdAt: 'desc' },
          take: limit,
        });
        return ok(reports);
      })
    );

    server.registerTool(
      'get_sanction_discord_evidence',
      {
        description:
          'Recherche les messages Discord d\'un membre sanctionné dans tous les salons accessibles, pour constituer des preuves. Requiert READ_SANCTIONS.',
        inputSchema: {
          sanction_id: z.string().describe('ID de la sanction concernée'),
          limit: z.number().int().min(1).max(200).default(50).describe('Nombre max de messages à retourner'),
        },
        _meta: toolMeta,
      },
      guard('READ_SANCTIONS', async ({ sanction_id, limit }) => {
        const sanction = await prisma.sanction.findFirst({ where: { id: sanction_id, guildId } });
        if (!sanction) return err('Sanction introuvable');

        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        const me = guild.members.me;
        const searchableChannels = [...guild.channels.cache.values()].filter((channel): channel is TextChannel => {
          if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) return false;
          return Boolean(me && channel.permissionsFor(me).has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ReadMessageHistory,
          ]));
        });

        const concurrencyLimit = pLimit(EVIDENCE_CHANNEL_CONCURRENCY);
        let failedChannelCount = 0;
        const fetchedChannels = await Promise.all(
          searchableChannels.map((channel) => concurrencyLimit(async () => {
            try {
              const { messages, truncated } = await fetchUserMessagesInChannel(channel, sanction.targetUserId, limit);
              return { channelId: channel.id, channelName: channel.name, rawMessages: messages, truncated };
            } catch {
              failedChannelCount++;
              return null;
            }
          })),
        );

        const successfulChannels = fetchedChannels.filter((c): c is NonNullable<typeof c> => c !== null);
        const newestMessages = successfulChannels
          .flatMap((channel) => channel.rawMessages.map((message) => ({ channel, message })))
          .sort((a, b) => b.message.createdTimestamp - a.message.createdTimestamp)
          .slice(0, limit);

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

        return ok({
          sanctionId: sanction.id,
          targetTag: sanction.targetTag,
          targetUserId: sanction.targetUserId,
          channels,
          messageCount: newestMessages.length,
          searchedChannelCount: searchableChannels.length,
          failedChannelCount,
        });
      })
    );
  }

  // ── READ_STAFF ────────────────────────────────────────────────────────────

  if (shouldRegister('READ_STAFF')) {
    server.registerTool(
      'get_staff_list',
      {
        description: 'Récupère la liste des membres du staff du serveur.',
        inputSchema: {
          include_inactive: z.boolean().default(false).describe('Inclure les membres inactifs'),
        },
        _meta: toolMeta,
      },
      guard('READ_STAFF', async ({ include_inactive }) => {
        const staffMembers = await prisma.staffMember.findMany({
          where: {
            guildId,
            ...(include_inactive ? {} : {}),
          },
          include: {
            absences: {
              where: { status: { in: ['PENDING', 'APPROVED'] } },
              select: { id: true, startDate: true, endDate: true, type: true },
            },
          },
          orderBy: { joinedStaffAt: 'desc' },
        });

        return ok(
          staffMembers.map((s) => ({
            id: s.id,
            userId: s.userId,
            username: s.username,
            displayName: s.displayName,
            grade: s.grade,
            joinedStaffAt: s.joinedStaffAt.toISOString(),
            isCurrentlyAbsent: s.absences.length > 0,
            absences: s.absences.map((a) => ({
              type: a.type,
              from: a.startDate.toISOString(),
              until: a.endDate?.toISOString() ?? null,
            })),
          }))
        );
      })
    );

    server.registerTool(
      'get_staff_member',
      {
        description: "Récupère le profil détaillé d'un membre du staff.",
        inputSchema: { member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre du staff') },
        _meta: toolMeta,
      },
      guard('READ_STAFF', async ({ member }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        const member_id = resolved.userId;

        const staff = await prisma.staffMember.findUnique({
          where: { guildId_userId: { guildId, userId: member_id } },
          include: {
            warnings: { orderBy: { createdAt: 'desc' }, take: 10 },
            activities: { orderBy: { activityDate: 'desc' }, take: 30 },
          },
        });

        if (!staff) return err('Membre du staff introuvable');

        return ok({
          id: staff.id,
          userId: staff.userId,
          username: staff.username,
          displayName: staff.displayName,
          avatarUrl: staff.avatarUrl,
          grade: staff.grade,
          joinedStaffAt: staff.joinedStaffAt.toISOString(),
          warnings: staff.warnings.map((w) => ({
            reason: w.reason,
            type: w.type,
            issuedAt: w.createdAt.toISOString(),
            expiresAt: w.expiresAt?.toISOString(),
          })),
          recentActivity: staff.activities.map((a) => ({
            date: a.activityDate.toISOString(),
            messageCount: a.messageCount,
            voiceMinutes: a.voiceMinutes,
          })),
        });
      })
    );

    server.registerTool(
      'get_staff_evaluations',
      {
        description: 'Récupère les évaluations de performance du staff (scores activité, modération, présence). Requiert READ_STAFF.',
        inputSchema: {
          member: z.string().optional().describe('Filtrer par membre staff : nom, mention ou ID'),
        },
        _meta: toolMeta,
      },
      guard('READ_STAFF', async ({ member }) => {
        try {
          if (member) {
            const resolved = await resolveMember(guildId, member);
            if (!resolved.ok) return resolved.response;
            const evaluations = await prisma.staffEvaluation.findMany({
              where: { guildId, staffUserId: resolved.userId },
              orderBy: { periodEnd: 'desc' },
              take: 20,
            });
            return ok({ staffUserId: resolved.userId, evaluations });
          }
          const data = await getEvaluationsDashboardData(guildId);
          return ok(data);
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_call_permission_config',
      {
        description: 'Récupère la configuration des permissions pour planifier des appels staff (mode EVERYONE ou RESTRICTED). Requiert READ_STAFF.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STAFF', async () => {
        try {
          const config = await getCallPermissionConfig(guildId);
          return ok(config);
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_staff_absences',
      {
        description: 'Liste les absences staff du serveur.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STAFF', async () => {
        try {
          return ok(await getAbsences(guildId));
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_staff_meetings',
      {
        description: 'Liste les réunions staff du serveur.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STAFF', async () => {
        try {
          return ok(await getMeetings(guildId));
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_staff_notifications',
      {
        description: 'Liste les notifications staff d’un membre donné.',
        inputSchema: {
          member: z.string().describe('Nom, mention ou ID Discord du membre'),
        },
        _meta: toolMeta,
      },
      guard('READ_STAFF', async ({ member }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        try {
          return ok(await getNotifications(guildId, resolved.userId));
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_staff_polls',
      {
        description: 'Liste les sondages staff du serveur.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STAFF', async () => {
        try {
          return ok(await getPolls(guildId));
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_staff_calls',
      {
        description: 'Liste les appels staff planifiés.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STAFF', async () => {
        try {
          return ok(await getCalls(guildId));
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_staff_tasks',
      {
        description: 'Liste les tâches staff du serveur.',
        inputSchema: {
          assignee: z.string().optional().describe('Filtrer par membre assigné'),
        },
        _meta: toolMeta,
      },
      guard('READ_STAFF', async ({ assignee }) => {
        try {
          let assigneeId: string | null | undefined;
          if (assignee) {
            const resolvedAssignee = await resolveMember(guildId, assignee);
            assigneeId = resolvedAssignee.ok ? resolvedAssignee.userId : null;
          }
          if (assignee && !assigneeId) return err('Membre introuvable');
          return ok(await getTasks(guildId, assigneeId ?? undefined));
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_staff_roles',
      {
        description: 'Liste les rôles staff configurés.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STAFF', async () => {
        try {
          return ok(await getStaffRoles(guildId));
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_staff_hierarchies',
      {
        description: 'Liste les hiérarchies staff configurées.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STAFF', async () => {
        try {
          return ok(await getStaffHierarchies(guildId));
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_staff_api_keys',
      {
        description: 'Liste les clés API staff actives du serveur.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STAFF', async () => {
        try {
          return ok(await getAPIKeys(guildId));
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_staff_alerts',
      {
        description: 'Récupère les alertes et la progression du staff.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STAFF', async () => {
        try {
          return ok(await getStaffAlertsAndProgression(guildId));
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_staff_calendar_data',
      {
        description: 'Récupère les données de calendrier staff sur une période donnée.',
        inputSchema: {
          start: z.string().describe('Date de début ISO'),
          end: z.string().describe('Date de fin ISO'),
          staff_ids: z.array(z.string()).optional().describe('Filtre optionnel sur les membres staff'),
        },
        _meta: toolMeta,
      },
      guard('READ_STAFF', async ({ start, end, staff_ids }) => {
        const startDate = new Date(start);
        const endDate = new Date(end);
        if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
          return err('Période invalide');
        }

        try {
          return ok(await getStaffCalendarData(guildId, startDate, endDate, staff_ids));
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
  }

  // ── READ_TICKETS ──────────────────────────────────────────────────────────

  if (shouldRegister('READ_TICKETS')) {
    server.registerTool(
      'get_tickets',
      {
        description: 'Liste les tickets de support du serveur.',
        inputSchema: {
          status: z.enum(['OPEN', 'CLAIMED', 'CLOSED']).optional(),
          limit: z.number().int().min(1).max(50).default(20),
          offset: z.number().int().min(0).default(0),
        },
        _meta: toolMeta,
      },
      guard('READ_TICKETS', async ({ status, limit, offset }) => {
        const [tickets, total] = await Promise.all([
          prisma.ticket.findMany({
            where: {
              guildId,
              ...(status ? { status: status as 'OPEN' | 'CLAIMED' | 'CLOSED' } : {}),
            },
            orderBy: { createdAt: 'desc' },
            take: limit,
            skip: offset,
          }),
          prisma.ticket.count({
            where: {
              guildId,
              ...(status ? { status: status as 'OPEN' | 'CLAIMED' | 'CLOSED' } : {}),
            },
          }),
        ]);

        return ok({
          total,
          tickets: tickets.map((t) => ({
            id: t.id,
            userId: t.userId,
            status: t.status,
            reason: t.reason,
            description: t.description,
            claimedById: t.claimedById,
            createdAt: t.createdAt.toISOString(),
            closedAt: t.closedAt?.toISOString() ?? null,
          })),
        });
      })
    );
  }

  // ── WRITE_SANCTIONS ───────────────────────────────────────────────────────

  if (shouldRegister('WRITE_SANCTIONS')) {
    server.registerTool(
      'apply_sanction',
      {
        description: 'Applique une sanction à un membre du serveur Discord. Requiert la permission WRITE_SANCTIONS.',
        inputSchema: {
          member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre à sanctionner'),
          type: z.enum(['WARN', 'KICK', 'TIMEOUT', 'TEMP_BAN', 'BAN', 'SOFTBAN']),
          reason: z.string().min(1).max(512).describe('Raison de la sanction'),
          duration_seconds: z
            .number()
            .int()
            .positive()
            .max(2332800)
            .optional()
            .describe('Durée en secondes (obligatoire pour TIMEOUT et TEMP_BAN, max 27 jours)'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_SANCTIONS', async ({ member, type, reason, duration_seconds, key_name }) => {
        if ((type === 'TIMEOUT' || type === 'TEMP_BAN') && !duration_seconds) {
          return err(`duration_seconds est obligatoire pour le type ${type}`);
        }

        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        const member_id = resolved.userId;

        const discordGuild = client.guilds.cache.get(guildId);
        if (!discordGuild) return err('Serveur Discord introuvable');

        const target = await discordGuild.members.fetch(member_id).catch(() => null);
        if (!target) return err('Membre introuvable sur le serveur Discord');

        const actorTag = `MCP[${key_name ?? 'agent'}]`;
        const actor = { id: 'mcp_agent', tag: actorTag };
        const targetData = { id: member_id, tag: target.user.tag ?? target.user.username };

        try {
          let sanction;

          if (type === 'WARN') {
            sanction = await registerWarnSanction({ guildId, target: targetData, moderator: actor, reason, client });
          } else if (type === 'KICK') {
            sanction = await registerKickSanction({ guildId, target: targetData, moderator: actor, reason, client });
          } else if (type === 'TIMEOUT') {
            sanction = await registerTimeoutSanction({
              guildId,
              target: targetData,
              moderator: actor,
              reason,
              durationMs: duration_seconds! * 1000,
              member: target,
              client,
            });
          } else if (type === 'BAN' || type === 'TEMP_BAN') {
            sanction = await registerBanSanction({
              guildId,
              target: targetData,
              moderator: actor,
              reason,
              client,
              ...(duration_seconds ? { temporaryDurationMs: duration_seconds * 1000 } : {}),
            });
          } else {
            return err(`Type de sanction non supporté via MCP : ${type}`);
          }

          await prisma.dashboardAuditLog.create({
            data: {
              guildId,
              user: actorTag,
              action: `Sanction MCP - ${type}`,
              context: `Cible: ${targetData.tag} (${member_id})`,
              module: 'MCP',
              eventType: 'Action',
              details: `Type: ${type} | Cible: ${targetData.tag} | Raison: ${reason}`,
              dateIso: new Date(),
            },
          });

          return ok({ ok: true, sanctionId: sanction?.id ?? null, type, targetId: member_id });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return err(`Erreur lors de l'application de la sanction : ${msg}`);
        }
      })
    );

    server.registerTool(
      'revoke_sanction',
      {
        description:
          "Lève une sanction active d'un membre : déban et/ou retrait du timeout. Requiert la permission WRITE_SANCTIONS.",
        inputSchema: {
          member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre'),
          type: z
            .enum(['BAN', 'TIMEOUT'])
            .optional()
            .describe('Type de sanction à lever (si omis, lève tout ce qui est actif)'),
          reason: z.string().max(512).optional().describe('Raison de la levée (audit)'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_SANCTIONS', async ({ member, type, reason, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        const userId = resolved.userId;

        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        const motif = reason ?? 'Levée via MCP';
        const actions: string[] = [];

        if (!type || type === 'BAN') {
          const ban = await guild.bans.fetch(userId).catch(() => null);
          if (ban) {
            const done = await guild.members.unban(userId, motif).then(() => true).catch(() => false);
            if (done) actions.push('unban');
          }
        }

        if (!type || type === 'TIMEOUT') {
          const target = await guild.members.fetch(userId).catch(() => null);
          if (target?.isCommunicationDisabled()) {
            const done = await target.timeout(null, motif).then(() => true).catch(() => false);
            if (done) actions.push('untimeout');
          }
        }

        if (actions.length === 0) {
          return err('Aucune sanction active à lever pour ce membre (ni ban ni timeout en cours).');
        }

        const revokedTypes: SanctionType[] = actions.includes('unban')
          ? (['BAN', 'TEMP_BAN'] as SanctionType[])
          : [];
        if (actions.includes('untimeout')) revokedTypes.push('TIMEOUT' as SanctionType);

        await prisma.sanction.updateMany({
          where: { guildId, targetUserId: userId, status: 'ACTIVE', type: { in: revokedTypes } },
          data: { status: 'RESOLVED' as SanctionStatus, resolvedAt: new Date() },
        });

        await audit(
          key_name,
          'Levée de sanction MCP',
          `Cible: ${resolved.label} (${userId})`,
          `Actions: ${actions.join(', ')} | Raison: ${motif}`
        );

        return ok({ ok: true, userId, actions });
      })
    );

    server.registerTool(
      'decide_ban_appeal',
      {
        description: 'Tranche une demande d\'appel de bannissement (Accepter, Refuser ou Refuser Définitivement). Requiert WRITE_SANCTIONS.',
        inputSchema: {
          appeal_id: z.string().describe('ID unique de la demande d\'appel'),
          decision: z.enum(['ACCEPTED', 'DENIED', 'DENIED_PERMANENT']).describe('La décision à appliquer'),
          reason: z.string().optional().describe('Raison de la décision (transmise au membre)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_SANCTIONS', async ({ appeal_id, decision, reason, key_name }) => {
        try {
          const staffUserId = 'mcp_agent';
          const staffTag = `MCP[${key_name ?? 'agent'}]`;

          const res = await decideAppeal(client, {
            appealId: appeal_id,
            guildId,
            decision,
            staffUserId,
            staffTag,
            reason,
          });

          if (!res.ok) return err(res.error || 'Erreur inconnue');

          await audit(key_name, 'Appel de ban tranché', `ID: ${appeal_id} | Décision: ${decision}`, reason || '(sans raison)');
          return ok({ ok: true, appealId: appeal_id, status: res.appeal.status });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'request_ban_appeal_info',
      {
        description: 'Demande des informations complémentaires à l\'auteur d\'un appel par MP. Met l\'appel en statut NEEDS_INFO. Requiert WRITE_SANCTIONS.',
        inputSchema: {
          appeal_id: z.string().describe('ID unique de la demande d\'appel'),
          question: z.string().min(1).max(1000).describe('La question à poser au membre'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_SANCTIONS', async ({ appeal_id, question, key_name }) => {
        try {
          const staffUserId = 'mcp_agent';
          const staffTag = `MCP[${key_name ?? 'agent'}]`;

          const res = await requestAppealInfo(client, {
            appealId: appeal_id,
            guildId,
            question,
            staffUserId,
            staffTag,
          });

          if (!res.ok) return err(res.error || 'Erreur inconnue');

          await audit(key_name, 'Infos d\'appel demandées', `ID: ${appeal_id}`, question);
          return ok({ ok: true, appealId: appeal_id, status: res.appeal.status });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'blacklist_ban_appeal',
      {
        description: 'Ajoute un membre banni à la liste noire des appels pour lui interdire définitivement d\'en soumettre un. Requiert WRITE_SANCTIONS.',
        inputSchema: {
          user_id: z.string().describe('ID Discord du membre à blacklister'),
          reason: z.string().optional().describe('Motif du blacklist'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_SANCTIONS', async ({ user_id, reason, key_name }) => {
        try {
          const staffUserId = 'mcp_agent';
          const staffTag = `MCP[${key_name ?? 'agent'}]`;

          const blacklist = await prisma.banAppealBlacklist.upsert({
            where: { guildId_userId: { guildId, userId: user_id } },
            create: {
              guildId,
              userId: user_id,
              reason: reason || 'Ajouté via MCP',
              addedByUserId: staffUserId,
              addedByTag: staffTag,
            },
            update: {
              reason: reason || 'Ajouté via MCP',
              addedByUserId: staffUserId,
              addedByTag: staffTag,
            },
          });

          await audit(key_name, 'Membre blacklisté des appels', `ID: ${user_id}`, reason || '(sans motif)');
          return ok({ ok: true, blacklist });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'unblacklist_ban_appeal',
      {
        description: 'Retire un membre de la liste noire des appels de bannissement. Requiert WRITE_SANCTIONS.',
        inputSchema: {
          user_id: z.string().describe('ID Discord du membre à retirer de la liste noire'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_SANCTIONS', async ({ user_id, key_name }) => {
        try {
          const deleted = await prisma.banAppealBlacklist.deleteMany({
            where: { guildId, userId: user_id },
          });

          await audit(key_name, 'Membre retiré de la blacklist des appels', `ID: ${user_id}`, '');
          return ok({ ok: true, count: deleted.count });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_ban_appeal_blacklist',
      {
        description: 'Liste les membres blacklistés des appels de bannissement. Requiert READ_MODERATION.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_MODERATION', async () => {
        try {
          const entries = await prisma.banAppealBlacklist.findMany({
            where: { guildId },
            orderBy: { createdAt: 'desc' },
          });
          return ok({ entries, count: entries.length });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_sanction',
      {
        description: 'Supprime une entrée de sanction de la base de données (sans lever la sanction Discord). Requiert WRITE_SANCTIONS.',
        inputSchema: {
          sanction_id: z.string().describe('ID de la sanction à supprimer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_SANCTIONS', async ({ sanction_id, key_name }) => {
        try {
          const sanction = await prisma.sanction.findFirst({
            where: { id: sanction_id, guildId },
            select: { id: true, type: true, targetTag: true, targetUserId: true },
          });
          if (!sanction) return err('Sanction introuvable');

          await prisma.sanction.delete({ where: { id: sanction.id } });
          await audit(
            key_name,
            'Suppression sanction MCP',
            sanction.targetTag ?? sanction.targetUserId,
            `ID: ${sanction.id} | Type: ${sanction.type}`
          );
          return ok({ ok: true, sanctionId: sanction.id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_ban_appeal_config',
      {
        description: 'Met à jour la configuration des appels de bannissement sur le serveur. Requiert WRITE_SANCTIONS.',
        inputSchema: {
          enabled: z.boolean().optional().describe('Activer ou désactiver les appels'),
          form_id: z.string().nullable().optional().describe('ID du formulaire personnalisé à lier'),
          staff_channel_id: z.string().nullable().optional().describe('Salon staff qui reçoit les demandes'),
          invite_channel_id: z.string().nullable().optional().describe('Salon d\'invitation de retour pour les appels acceptés'),
          cooldown_days: z.number().int().min(0).optional().describe('Jours de cooldown avant de pouvoir soumettre un nouvel appel'),
          welcome_text: z.string().nullable().optional().describe('Texte d\'accueil sur la page publique'),
          accept_message: z.string().nullable().optional().describe('DM envoyé en cas d\'acceptation'),
          deny_message: z.string().nullable().optional().describe('DM envoyé en cas de refus'),
          notify_on_ban_dm: z.boolean().optional().describe("Envoyer automatiquement le lien public de l'appel par DM lors d'un bannissement définitif"),
          create_default_form: z.boolean().optional().describe('Crée automatiquement le formulaire d\'appel par défaut si absent'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_SANCTIONS', async ({ enabled, form_id, staff_channel_id, invite_channel_id, cooldown_days, welcome_text, accept_message, deny_message, notify_on_ban_dm, create_default_form, key_name }) => {
        try {
          const updateData: any = {};
          if (enabled !== undefined) updateData.enabled = enabled;
          if (form_id !== undefined) updateData.formId = form_id;
          if (staff_channel_id !== undefined) updateData.staffChannelId = staff_channel_id;
          if (invite_channel_id !== undefined) updateData.inviteChannelId = invite_channel_id;
          if (cooldown_days !== undefined) updateData.cooldownDays = cooldown_days;
          if (welcome_text !== undefined) updateData.welcomeText = welcome_text;
          if (accept_message !== undefined) updateData.acceptMessage = accept_message;
          if (deny_message !== undefined) updateData.denyMessage = deny_message;
          if (notify_on_ban_dm !== undefined) updateData.notifyOnBanDM = notify_on_ban_dm;

          if (form_id) {
            const form = await prisma.customForm.findFirst({ where: { id: form_id, guildId }, select: { id: true } });
            if (!form) return err('Formulaire introuvable sur ce serveur');
          }

          await upsertAppealConfig(guildId, updateData);

          if (create_default_form) {
            await ensureDefaultAppealForm(guildId);
          }

          const config = await getAppealConfig(guildId);

          await audit(key_name, 'Configuration appels mise à jour', '', JSON.stringify(updateData));
          return ok(config);
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'create_sanction_report',
      {
        description: 'Crée un rapport de sanction documenté avec preuves. Requiert WRITE_SANCTIONS.',
        inputSchema: {
          sanction_id: z.string().describe('ID de la sanction liée'),
          incident_at: z.string().describe('Date/heure de l\'incident (ISO 8601)'),
          broken_rules: z.string().describe('Règles enfreintes'),
          detailed_reason: z.string().describe('Motif détaillé'),
          evidence_links: z.array(z.string().url()).min(1).describe('Liens de preuves (URLs https)'),
          additional_notes: z.string().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_SANCTIONS', async ({ sanction_id, incident_at, broken_rules, detailed_reason, evidence_links, additional_notes, key_name }) => {
        try {
          const sanction = await prisma.sanction.findFirst({ where: { id: sanction_id, guildId } });
          if (!sanction) return err('Sanction introuvable');

          const existingReport = await prisma.sanctionReport.findFirst({ where: { guildId, sanctionId: sanction_id } });
          if (existingReport) return err('Un rapport existe déjà pour cette sanction');

          const parsedDate = new Date(incident_at);
          if (Number.isNaN(parsedDate.getTime())) return err('Date d\'incident invalide');

          const report = await prisma.sanctionReport.create({
            data: {
              guildId,
              sanctionId: sanction_id,
              staffPseudo: sanction.moderatorTag ?? 'MCP Agent',
              incidentAt: parsedDate,
              memberPseudo: sanction.targetTag ?? sanction.targetUserId,
              memberReference: sanction.targetUserId,
              sanctionType: sanction.type,
              sanctionDurationLabel: sanction.durationSeconds ? `${sanction.durationSeconds}s` : null,
              brokenRules: broken_rules,
              detailedReason: detailed_reason,
              evidenceLinks: evidence_links,
              additionalNotes: additional_notes ?? null,
              createdByUserId: 'mcp_agent',
              createdByTag: `MCP[${key_name ?? 'agent'}]`,
            },
          });

          const { announceSanctionReportToStaff } = await import('../../services/moderation/sanctionService.js');
          await announceSanctionReportToStaff(client, report).catch(() => null);

          await audit(key_name, 'Création rapport sanction MCP', sanction.targetTag ?? sanction.targetUserId, `Rapport ${report.id}`);
          return ok({ ok: true, reportId: report.id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_sanction_report',
      {
        description: 'Met à jour un rapport de sanction existant. Requiert WRITE_SANCTIONS.',
        inputSchema: {
          report_id: z.string().describe('ID du rapport'),
          broken_rules: z.string().optional(),
          detailed_reason: z.string().optional(),
          evidence_links: z.array(z.string().url()).optional(),
          additional_notes: z.string().nullable().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_SANCTIONS', async ({ report_id, broken_rules, detailed_reason, evidence_links, additional_notes, key_name }) => {
        try {
          const existing = await prisma.sanctionReport.findFirst({ where: { id: report_id, guildId } });
          if (!existing) return err('Rapport introuvable');

          const report = await prisma.sanctionReport.update({
            where: { id: report_id },
            data: {
              ...(broken_rules !== undefined ? { brokenRules: broken_rules } : {}),
              ...(detailed_reason !== undefined ? { detailedReason: detailed_reason } : {}),
              ...(evidence_links !== undefined ? { evidenceLinks: parseEvidenceLinks(evidence_links) } : {}),
              ...(additional_notes !== undefined ? { additionalNotes: additional_notes } : {}),
            },
          });

          await audit(key_name, 'Mise à jour rapport sanction MCP', report_id, '');
          return ok({ ok: true, report });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'import_sanction_discord_transcripts',
      {
        description:
          'Génère des transcriptions HTML à partir de messages Discord sélectionnés, pour les joindre comme preuves à une sanction. Requiert WRITE_SANCTIONS.',
        inputSchema: {
          sanction_id: z.string().describe('ID de la sanction concernée'),
          selections: z.array(z.object({
            channel: z.string().describe('Salon (nom, mention ou ID)'),
            message_ids: z.array(z.string()).min(1).describe('IDs des messages à transcrire'),
          })).min(1),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_SANCTIONS', async ({ sanction_id, selections, key_name }) => {
        try {
          const sanction = await prisma.sanction.findFirst({ where: { id: sanction_id, guildId } });
          if (!sanction) return err('Sanction introuvable');

          const totalMessages = selections.reduce((sum: number, s: { message_ids: string[] }) => sum + s.message_ids.length, 0);
          if (totalMessages > MAX_EVIDENCE_MESSAGES) {
            return err(`Maximum ${MAX_EVIDENCE_MESSAGES} messages par import`);
          }

          const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';
          const results: Array<{ channelId: string; channelName: string; url: string; count: number }> = [];
          const errors: Array<{ channel: string; error: string }> = [];

          for (const selection of selections) {
            const resolved = resolveChannel(guildId, client, selection.channel);
            if (!resolved.ok) {
              errors.push({ channel: selection.channel, error: 'Salon introuvable' });
              continue;
            }

            try {
              const fetched = await Promise.all(
                selection.message_ids.map((id: string) => resolved.channel.messages.fetch(id).catch(() => null)),
              );
              const validMessages = fetched.filter(
                (msg): msg is Message<true> => msg !== null && msg.author.id === sanction.targetUserId,
              );

              if (validMessages.length === 0) {
                errors.push({ channel: selection.channel, error: 'Aucun message valide' });
                continue;
              }

              validMessages.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
              const transcript = await generateTranscriptFromMessages(resolved.channel, validMessages);
              results.push({
                channelId: resolved.channel.id,
                channelName: resolved.channel.name,
                url: `${dashboardUrl}${transcript.url}`,
                count: transcript.count,
              });
            } catch {
              errors.push({ channel: selection.channel, error: 'Erreur de transcription' });
            }
          }

          await audit(key_name, 'Import preuves Discord MCP', sanction_id, `${results.length} transcription(s)`);
          return ok({ results, errors });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
  }

  // ── READ_STATS : navigation du serveur ────────────────────────────────────

  if (shouldRegister('READ_STATS')) {
    server.registerTool(
      'list_channels',
      {
        description:
          'Liste les salons du serveur (nom, type, ID). Pratique pour retrouver un salon par son nom plutôt que par ID.',
        inputSchema: {
          query: z.string().optional().describe('Filtre optionnel sur le nom du salon'),
          type: z.enum(['text', 'forum', 'voice', 'category', 'all']).default('all').describe('Type de salon à lister'),
        },
        _meta: toolMeta,
      },
      guard('READ_STATS', async ({ query, type }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        const kindOf = (c: { type: ChannelType; isTextBased: () => boolean; isVoiceBased: () => boolean }) =>
          c.type === ChannelType.GuildCategory
            ? 'category'
            : c.type === ChannelType.GuildForum
              ? 'forum'
              : c.isVoiceBased()
                ? 'voice'
                : c.isTextBased()
                  ? 'text'
                  : 'other';

        let channels = [...guild.channels.cache.values()];
        if (query) {
          const q = query.toLowerCase();
          channels = channels.filter((c) => c.name.toLowerCase().includes(q));
        }
        if (type !== 'all') channels = channels.filter((c) => kindOf(c) === type);

        return ok(
          channels
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((c) => ({
              id: c.id,
              name: c.name,
              type: kindOf(c),
              parentId: c.parentId,
              ...(c.type === ChannelType.GuildForum
                ? { availableTags: c.availableTags.map((tag) => ({ id: tag.id, name: tag.name, moderated: tag.moderated, emoji: tag.emoji })) }
                : {}),
            }))
        );
      })
    );

    server.registerTool(
      'get_widget_subscriptions',
      {
        description: 'Liste les abonnements au widget Discord de profil staff pour ce serveur. Requiert READ_STATS.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STATS', async () => {
        try {
          const subscriptions = await prisma.widgetSubscription.findMany({
            where: { guildId },
            orderBy: { createdAt: 'desc' },
          });
          return ok({ subscriptions, activeCount: subscriptions.filter((s) => s.enabled).length });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'list_roles',
      {
        description: 'Liste les rôles du serveur (nom, ID, couleur, position, mentionnable).',
        inputSchema: { query: z.string().optional().describe('Filtre optionnel sur le nom du rôle') },
        _meta: toolMeta,
      },
      guard('READ_STATS', async ({ query }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        let roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id);
        if (query) {
          const q = query.toLowerCase();
          roles = roles.filter((r) => r.name.toLowerCase().includes(q));
        }

        return ok(
          roles
            .sort((a, b) => b.position - a.position)
            .map((r) => ({
              id: r.id,
              name: r.name,
              color: r.hexColor,
              position: r.position,
              mentionable: r.mentionable,
              memberCount: r.members.size,
            }))
        );
      })
    );

    server.registerTool(
      'get_server_info',
      {
        description: 'Informations générales du serveur Discord (nom, membres, salons, rôles, boosts).',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STATS', async () => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        return ok({
          id: guild.id,
          name: guild.name,
          description: guild.description,
          memberCount: guild.memberCount,
          channelCount: guild.channels.cache.size,
          roleCount: guild.roles.cache.size,
          ownerId: guild.ownerId,
          boostTier: guild.premiumTier,
          boostCount: guild.premiumSubscriptionCount ?? 0,
          iconUrl: guild.iconURL(),
          createdAt: guild.createdAt.toISOString(),
        });
      })
    );
  }

  // ── WRITE_MESSAGES ────────────────────────────────────────────────────────

  if (shouldRegister('WRITE_MESSAGES')) {
    server.registerTool(
      'send_message',
      {
        description:
          'Envoie un message Discord en tant que bot, au format embed legacy v1 ou Components v2. Requiert WRITE_MESSAGES.',
        inputSchema: {
          channel: z.string().describe('Nom du salon (ex: « general »), mention <#id> ou ID'),
          content: z.string().max(4000).optional().describe('Texte (2000 max en v1, 4000 max par Text Display en v2)'),
          embed: mcpEmbedSchema.optional().describe('Embed structuré ; rendu en embed classique avec v1, en Container avec v2'),
          format: z.enum(['v1', 'v2']).default('v2').describe('v1 = content/embed legacy ; v2 = Components v2'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ channel, content, embed, format, key_name }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;
        if (!content && !embed) return err('Renseigne content ou embed.');
        if (format === 'v1' && (content?.length ?? 0) > 2000) return err('Le contenu v1 est limité à 2000 caractères.');

        const sent = await (async () => {
          if (format === 'v1') {
            // Le prototype TextChannel#send est patché globalement par Kotbo pour convertir
            // les embeds en v2. L’API REST directe est volontaire ici afin de garantir un
            // véritable message legacy quand l’appelant choisit explicitement v1.
            const raw = await client.rest.post(`/channels/${resolved.channel.id}/messages`, {
              body: {
                ...(content !== undefined ? { content } : {}),
                ...(embed ? { embeds: [buildApiEmbed(embed)] } : {}),
                allowed_mentions: { parse: [] },
              },
            }) as { id: string };
            return resolved.channel.messages.fetch(raw.id);
          }

          return resolved.channel.send({
            components: buildV2MessageComponents(content, embed),
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: { parse: [] },
          });
        })().catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          return msg;
        });
        if (typeof sent === 'string') return err(`Impossible d'envoyer le message : ${sent}`);

        await audit(
          key_name,
          'Message envoyé MCP',
          `Salon: #${resolved.channel.name} (${resolved.channel.id})`,
          `${format.toUpperCase()} — ${(content ?? embed?.title ?? embed?.description ?? '').slice(0, 200)}`
        );

        return ok({
          ok: true,
          messageId: sent.id,
          channelId: resolved.channel.id,
          channelName: resolved.channel.name,
          format,
        });
      })
    );

    server.registerTool(
      'edit_bot_message',
      {
        description:
          'Édite uniquement un message appartenant à Kotbo. Préserve automatiquement le format v1/v2 ; une conversion explicite v1 vers v2 est irréversible. Requiert WRITE_MESSAGES.',
        inputSchema: {
          channel: z.string().describe('Nom du salon ou article, mention <#id> ou ID'),
          message_id: z.string().describe('ID du message à éditer'),
          content: z.string().max(4000).nullable().optional().describe('Nouveau texte ; null ou chaîne vide le supprime'),
          embed: mcpEmbedSchema.nullable().optional().describe('Nouvel embed ; null le supprime'),
          format: z.enum(['auto', 'v1', 'v2']).default('auto').describe('auto conserve le format actuel'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ channel, message_id, content, embed, format, key_name }) => {
        if (content === undefined && embed === undefined) return err('Renseigne content et/ou embed à modifier.');
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        const message = await resolved.channel.messages.fetch(message_id).catch(() => null);
        if (!message) return err(`Message ${message_id} introuvable dans #${resolved.channel.name}.`);
        if (!client.user || message.author.id !== client.user.id) {
          return err('Kotbo peut supprimer les messages d’autres membres, mais ne peut éditer que ses propres messages.');
        }

        const currentFormat = message.flags.has(MessageFlags.IsComponentsV2) ? 'v2' : 'v1';
        const targetFormat = format === 'auto' ? currentFormat : format;
        if (currentFormat === 'v2' && targetFormat === 'v1') {
          return err('Discord interdit de reconvertir un message Components v2 en embed/content v1. Utilise format=v2 ou auto.');
        }
        if (targetFormat === 'v1' && (content?.length ?? 0) > 2000) {
          return err('Le contenu v1 est limité à 2000 caractères.');
        }

        if (targetFormat === 'v1') {
          await client.rest.patch(`/channels/${resolved.channel.id}/messages/${message.id}`, {
            body: {
              ...(content !== undefined ? { content: content ?? '' } : {}),
              ...(embed !== undefined ? { embeds: embed ? [buildApiEmbed(embed)] : [] } : {}),
              allowed_mentions: { parse: [] },
            },
          });
        } else {
          let components: APIMessageTopLevelComponent[];
          if (currentFormat === 'v2') {
            // Sur un message v2, content pilote les Text Displays de premier
            // niveau et embed pilote les Containers. Les autres composants
            // (boutons, galeries, etc.) sont conservés.
            components = message.components.map((component) => component.toJSON());
            if (content !== undefined) {
              components = components.filter((component) => component.type !== ComponentType.TextDisplay);
              if (content) components.unshift(new TextDisplayBuilder().setContent(content).toJSON());
            }
            if (embed !== undefined) {
              components = components.filter((component) => component.type !== ComponentType.Container);
              if (embed) components.push(embedToV2(buildApiEmbed(embed)).toJSON());
            }
          } else {
            const existingEmbed = message.embeds[0]?.toJSON();
            const nextContent = content !== undefined ? content : message.content;
            const nextEmbed = embed !== undefined ? embed : existingEmbed;
            components = [
              ...(nextContent ? [new TextDisplayBuilder().setContent(nextContent).toJSON()] : []),
              ...(nextEmbed ? [embedToV2('thumbnail_url' in nextEmbed ? buildApiEmbed(nextEmbed) : nextEmbed).toJSON()] : []),
            ];
          }
          if (components.length === 0) return err('Un message Components v2 doit conserver au moins un composant.');
          await message.edit({
            // Discord exige d’effacer les champs legacy dans la même requête
            // lorsqu’un message v1 reçoit IS_COMPONENTS_V2 pour la première fois.
            ...(currentFormat === 'v1' ? { content: null, embeds: [] } : {}),
            components,
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: { parse: [] },
          });
        }

        const updated = await resolved.channel.messages.fetch({ message: message.id, force: true }).catch(() => message);
        await audit(
          key_name,
          'Message édité MCP',
          `#${resolved.channel.name}`,
          `MessageID: ${message.id} — ${currentFormat} → ${targetFormat}`,
        );
        return ok({ ok: true, message: serializeDiscordMessage(updated, message.guild ?? undefined) });
      })
    );

    server.registerTool(
      'delete_messages',
      {
        description:
          'Supprime un ou plusieurs messages dans un salon Discord. ' +
          'Mode 1 (message_id) : supprime un message précis, appartenant à Kotbo ou à un autre membre (Gérer les messages requis dans ce second cas). ' +
          'Mode 2 (bulk) : supprime les N derniers messages du salon (max 100, < 14 jours). ' +
          'Requiert la permission WRITE_MESSAGES.',
        inputSchema: {
          channel: z.string().describe('Nom du salon, mention <#id> ou ID'),
          message_id: z.string().optional().describe('ID du message à supprimer (mode suppression unique)'),
          count: z.number().int().min(1).max(100).optional().describe('Nombre de messages récents à supprimer en bulk (max 100)'),
          user_filter: z.string().optional().describe('Limiter le bulk uniquement aux messages de ce membre (nom, mention ou ID)'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ channel, message_id, count, user_filter, key_name }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        const ch = resolved.channel;

        // ── Mode 1 : suppression d'un message unique ──
        if (message_id) {
          const msg = await ch.messages.fetch(message_id).catch(() => null);
          if (!msg) return err(`Message ${message_id} introuvable dans #${ch.name}.`);

          const deleted = await msg.delete().then(() => true).catch(() => false);
          if (!deleted) return err('Impossible de supprimer le message (permissions insuffisantes ?).');

          const ownedByBot = msg.author.id === client.user?.id;
          await audit(
            key_name,
            'Suppression message MCP',
            `#${ch.name}`,
            `MessageID: ${message_id} — auteur: ${msg.author.id} — messageKotbo: ${ownedByBot}`,
          );
          return ok({
            ok: true,
            deleted: 1,
            messageId: message_id,
            channelId: ch.id,
            authorId: msg.author.id,
            ownedByBot,
          });
        }

        // ── Mode 2 : bulk delete ──
        const bulkCount = count ?? 10;

        // Résoudre l'éventuel filtre utilisateur
        let filterUserId: string | null = null;
        if (user_filter) {
          const ru = await resolveMember(guildId, user_filter);
          if (!ru.ok) return ru.response;
          filterUserId = ru.userId;
        }

        // Récupérer les messages (on prend plus pour compenser les anciens > 14 jours)
        const fetched = await ch.messages.fetch({ limit: Math.min(bulkCount * 3, 100) }).catch(() => null);
        if (!fetched) return err('Impossible de récupérer les messages (permissions insuffisantes ?).');

        const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
        const candidates = fetched
          .filter(m => m.createdTimestamp > twoWeeksAgo)
          .filter(m => !filterUserId || m.author.id === filterUserId)
          .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
          .first(bulkCount);

        if (candidates.length === 0) {
          return err('Aucun message éligible à la suppression (trop anciens ou filtre trop restrictif).');
        }

        let deletedCount = 0;
        if (candidates.length === 1) {
          // bulkDelete ne fonctionne pas pour 1 seul message
          const deleted = await candidates[0]!.delete().then(() => true).catch(() => false);
          deletedCount = deleted ? 1 : 0;
        } else {
          const result = await ch.bulkDelete(candidates, true).catch(() => null);
          deletedCount = result?.size ?? 0;
        }

        const filterLabel = filterUserId ? ` (filtre: <@${filterUserId}>)` : '';
        await audit(key_name, 'Suppression bulk MCP', `#${ch.name}${filterLabel}`, `${deletedCount} message(s) supprimé(s)`);
        return ok({ ok: true, deleted: deletedCount, channelId: ch.id, channelName: ch.name });
      })
    );

    server.registerTool(
      'create_forum_post',
      {
        description:
          'Crée un article dans un forum Discord avec contenu v1 ou Components v2 et tags optionnels. Requiert WRITE_MESSAGES.',
        inputSchema: {
          forum: z.string().describe('Nom, mention ou ID du forum'),
          title: z.string().min(1).max(100).describe('Titre de l’article'),
          content: z.string().max(4000).optional(),
          embed: mcpEmbedSchema.optional(),
          format: z.enum(['v1', 'v2']).default('v2'),
          tags: z.array(z.string()).max(5).default([]).describe('Noms ou IDs des tags à appliquer'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ forum, title, content, embed, format, tags, key_name }) => {
        const resolved = resolveForum(guildId, client, forum);
        if (!resolved.ok) return resolved.response;
        if (!content && !embed) return err('Renseigne content ou embed pour le premier message de l’article.');
        if (format === 'v1' && (content?.length ?? 0) > 2000) return err('Le contenu v1 est limité à 2000 caractères.');
        const resolvedTags = resolveForumTagIds(resolved.forum, tags);
        if (!resolvedTags.ok) return resolvedTags.response;

        const message = format === 'v1'
          ? {
              ...(content !== undefined ? { content } : {}),
              ...(embed ? { embeds: [buildApiEmbed(embed)] } : {}),
              allowedMentions: { parse: [] as never[] },
            }
          : {
              components: buildV2MessageComponents(content, embed),
              flags: MessageFlags.IsComponentsV2 as const,
              allowedMentions: { parse: [] as never[] },
            };

        const post = await resolved.forum.threads.create({
          name: title,
          message,
          appliedTags: resolvedTags.ids,
          reason: `Article créé via MCP${key_name ? ` (${key_name})` : ''}`,
        }).catch((error) => error instanceof Error ? error : new Error(String(error)));
        if (post instanceof Error) return err(`Impossible de créer l’article : ${post.message}`);

        await audit(key_name, 'Article forum créé MCP', `#${resolved.forum.name}`, `${post.name} (${post.id})`);
        return ok({
          ok: true,
          forumId: resolved.forum.id,
          postId: post.id,
          title: post.name,
          format,
          appliedTagIds: post.appliedTags,
        });
      })
    );

    server.registerTool(
      'reply_forum_post',
      {
        description: 'Répond à un article de forum en tant que Kotbo, au format v1 ou v2. Requiert WRITE_MESSAGES.',
        inputSchema: {
          forum: z.string().describe('Nom, mention ou ID du forum'),
          post: z.string().describe('Titre, mention ou ID de l’article'),
          content: z.string().max(4000).optional(),
          embed: mcpEmbedSchema.optional(),
          format: z.enum(['v1', 'v2']).default('v2'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ forum, post, content, embed, format, key_name }) => {
        const resolvedForum = resolveForum(guildId, client, forum);
        if (!resolvedForum.ok) return resolvedForum.response;
        const resolvedPost = await resolveForumPost(resolvedForum.forum, post);
        if (!resolvedPost.ok) return resolvedPost.response;
        if (!content && !embed) return err('Renseigne content ou embed.');
        if (format === 'v1' && (content?.length ?? 0) > 2000) return err('Le contenu v1 est limité à 2000 caractères.');

        const sent = format === 'v1'
          ? await (async () => {
              const raw = await client.rest.post(`/channels/${resolvedPost.post.id}/messages`, {
                body: {
                  ...(content !== undefined ? { content } : {}),
                  ...(embed ? { embeds: [buildApiEmbed(embed)] } : {}),
                  allowed_mentions: { parse: [] },
                },
              }) as { id: string };
              return resolvedPost.post.messages.fetch(raw.id);
            })().catch(() => null)
          : await resolvedPost.post.send({
              components: buildV2MessageComponents(content, embed),
              flags: MessageFlags.IsComponentsV2,
              allowedMentions: { parse: [] },
            }).catch(() => null);
        if (!sent) return err('Impossible de répondre à cet article (permissions insuffisantes ?).');

        await audit(key_name, 'Réponse forum MCP', resolvedPost.post.name, `MessageID: ${sent.id}`);
        return ok({ ok: true, postId: resolvedPost.post.id, messageId: sent.id, format });
      })
    );

    server.registerTool(
      'update_forum_post',
      {
        description:
          'Modifie le titre, l’état (archivé/verrouillé) et les tags appliqués à un article de forum. Requiert WRITE_MESSAGES.',
        inputSchema: {
          forum: z.string().describe('Nom, mention ou ID du forum'),
          post: z.string().describe('Titre, mention ou ID de l’article'),
          title: z.string().min(1).max(100).optional(),
          archived: z.boolean().optional(),
          locked: z.boolean().optional(),
          set_tags: z.array(z.string()).max(5).optional().describe('Remplace tous les tags par cette liste'),
          add_tags: z.array(z.string()).max(5).optional(),
          remove_tags: z.array(z.string()).max(5).optional(),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ forum, post, title, archived, locked, set_tags, add_tags, remove_tags, key_name }) => {
        if (title === undefined && archived === undefined && locked === undefined && set_tags === undefined && !add_tags?.length && !remove_tags?.length) {
          return err('Aucune modification demandée.');
        }
        if (set_tags !== undefined && (add_tags?.length || remove_tags?.length)) {
          return err('Utilise soit set_tags, soit add_tags/remove_tags, pas les deux modes à la fois.');
        }

        const resolvedForum = resolveForum(guildId, client, forum);
        if (!resolvedForum.ok) return resolvedForum.response;
        const resolvedPost = await resolveForumPost(resolvedForum.forum, post);
        if (!resolvedPost.ok) return resolvedPost.response;

        let nextTags = [...resolvedPost.post.appliedTags];
        if (set_tags !== undefined) {
          const tags = resolveForumTagIds(resolvedForum.forum, set_tags);
          if (!tags.ok) return tags.response;
          nextTags = tags.ids;
        } else {
          if (add_tags?.length) {
            const tags = resolveForumTagIds(resolvedForum.forum, add_tags);
            if (!tags.ok) return tags.response;
            nextTags = [...new Set([...nextTags, ...tags.ids])];
          }
          if (remove_tags?.length) {
            const tags = resolveForumTagIds(resolvedForum.forum, remove_tags);
            if (!tags.ok) return tags.response;
            const removed = new Set(tags.ids);
            nextTags = nextTags.filter((id) => !removed.has(id));
          }
        }
        if (nextTags.length > 5) return err('Discord limite un article à 5 tags appliqués.');

        const updated = await resolvedPost.post.edit({
          ...(title !== undefined ? { name: title } : {}),
          ...(archived !== undefined ? { archived } : {}),
          ...(locked !== undefined ? { locked } : {}),
          ...((set_tags !== undefined || add_tags?.length || remove_tags?.length) ? { appliedTags: nextTags } : {}),
          reason: `Article modifié via MCP${key_name ? ` (${key_name})` : ''}`,
        }).catch(() => null);
        if (!updated) return err('Impossible de modifier l’article (permission Gérer les fils requise selon l’action).');

        await audit(key_name, 'Article forum modifié MCP', `#${resolvedForum.forum.name}`, `${updated.name} (${updated.id})`);
        return ok({
          ok: true,
          postId: updated.id,
          title: updated.name,
          archived: updated.archived,
          locked: updated.locked,
          appliedTagIds: updated.appliedTags,
        });
      })
    );

    server.registerTool(
      'delete_forum_post',
      {
        description: 'Supprime définitivement un article de forum Discord et ses réponses. Requiert WRITE_MESSAGES.',
        inputSchema: {
          forum: z.string().describe('Nom, mention ou ID du forum'),
          post: z.string().describe('Titre, mention ou ID de l’article'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ forum, post, key_name }) => {
        const resolvedForum = resolveForum(guildId, client, forum);
        if (!resolvedForum.ok) return resolvedForum.response;
        const resolvedPost = await resolveForumPost(resolvedForum.forum, post);
        if (!resolvedPost.ok) return resolvedPost.response;
        const snapshot = { id: resolvedPost.post.id, name: resolvedPost.post.name };
        const deleted = await resolvedPost.post.delete(`Article supprimé via MCP${key_name ? ` (${key_name})` : ''}`)
          .then(() => true)
          .catch(() => false);
        if (!deleted) return err('Impossible de supprimer l’article (permission Gérer les fils requise).');

        await audit(key_name, 'Article forum supprimé MCP', `#${resolvedForum.forum.name}`, `${snapshot.name} (${snapshot.id})`);
        return ok({ ok: true, deleted: true, postId: snapshot.id, title: snapshot.name });
      })
    );

    server.registerTool(
      'manage_forum_tags',
      {
        description:
          'Crée, renomme, configure ou supprime un tag disponible dans un forum. Les articles utilisant un tag supprimé le perdent. Requiert WRITE_MESSAGES.',
        inputSchema: {
          forum: z.string().describe('Nom, mention ou ID du forum'),
          action: z.enum(['create', 'update', 'delete']),
          tag: z.string().optional().describe('Nom ou ID du tag existant (update/delete)'),
          name: z.string().min(1).max(20).optional().describe('Nom du nouveau tag (create) ou nouveau nom (update)'),
          moderated: z.boolean().optional().describe('Réserve l’application/retrait aux membres avec Gérer les fils'),
          emoji_id: z.string().nullable().optional().describe('ID d’emoji personnalisé, null pour le retirer'),
          emoji_name: z.string().nullable().optional().describe('Emoji Unicode, null pour le retirer'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ forum, action, tag, name, moderated, emoji_id, emoji_name, key_name }) => {
        const resolved = resolveForum(guildId, client, forum);
        if (!resolved.ok) return resolved.response;
        if (emoji_id && emoji_name) return err('Renseigne emoji_id ou emoji_name, jamais les deux.');

        const current: GuildForumTagData[] = resolved.forum.availableTags.map((item) => ({
          id: item.id,
          name: item.name,
          moderated: item.moderated,
          emoji: item.emoji,
        }));
        let next = [...current];

        if (action === 'create') {
          if (!name) return err('name est requis pour créer un tag.');
          if (current.some((item) => item.name.toLowerCase() === name.toLowerCase())) return err(`Le tag « ${name} » existe déjà.`);
          next.push({
            name,
            moderated: moderated ?? false,
            ...((emoji_id !== undefined || emoji_name !== undefined)
              ? { emoji: { id: emoji_id ?? null, name: emoji_name ?? null } }
              : {}),
          });
        } else {
          if (!tag) return err('tag est requis pour modifier ou supprimer un tag.');
          const matches = current.filter((item) => item.id === tag || item.name.toLowerCase() === tag.toLowerCase());
          if (matches.length !== 1) return err(matches.length === 0 ? `Tag « ${tag} » introuvable.` : `Tag « ${tag} » ambigu.`);
          const target = matches[0]!;
          if (action === 'delete') {
            next = current.filter((item) => item.id !== target.id);
          } else {
            next = current.map((item) => item.id === target.id
              ? {
                  ...item,
                  ...(name !== undefined ? { name } : {}),
                  ...(moderated !== undefined ? { moderated } : {}),
                  ...((emoji_id !== undefined || emoji_name !== undefined)
                    ? { emoji: { id: emoji_id ?? null, name: emoji_name ?? null } }
                    : {}),
                }
              : item);
          }
        }

        const updated = await resolved.forum.setAvailableTags(
          next,
          `Tags forum modifiés via MCP${key_name ? ` (${key_name})` : ''}`,
        ).catch(() => null);
        if (!updated) return err('Impossible de modifier les tags du forum (permission Gérer les salons requise).');

        await audit(key_name, 'Tags forum modifiés MCP', `#${resolved.forum.name}`, `${action}: ${tag ?? name ?? ''}`);
        return ok({
          ok: true,
          forumId: updated.id,
          tags: updated.availableTags.map((item) => ({ id: item.id, name: item.name, moderated: item.moderated, emoji: item.emoji })),
        });
      })
    );
  }

  // ── WRITE_TICKETS ─────────────────────────────────────────────────────────

  if (shouldRegister('WRITE_TICKETS')) {
    server.registerTool(
      'reply_ticket',
      {
        description: "Envoie un message dans le salon d'un ticket en tant que bot. Requiert WRITE_TICKETS.",
        inputSchema: {
          ticket_id: z.string().describe('ID du ticket (issu de get_tickets)'),
          content: z.string().min(1).max(2000).describe('Contenu du message'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_TICKETS', async ({ ticket_id, content, key_name }) => {
        const ticket = await prisma.ticket.findFirst({ where: { id: ticket_id, guildId } });
        if (!ticket) return err('Ticket introuvable');
        if (!ticket.channelId) return err("Ce ticket n'a pas de salon associé");

        const channel = client.guilds.cache.get(guildId)?.channels.cache.get(ticket.channelId);
        if (!channel || !channel.isTextBased()) return err('Salon du ticket introuvable');

        const sent = await (channel as TextChannel | NewsChannel).send({ content }).catch(() => null);
        if (!sent) return err("Impossible d'envoyer le message dans le ticket");

        await audit(key_name, 'Réponse ticket MCP', `Ticket: ${ticket.id}`, content.slice(0, 200));

        return ok({ ok: true, ticketId: ticket.id, messageId: sent.id });
      })
    );

    server.registerTool(
      'close_ticket',
      {
        description:
          'Ferme un ticket : marque le ticket comme fermé en base et renomme son salon (préfixe « fermer- »). Requiert WRITE_TICKETS.',
        inputSchema: {
          ticket_id: z.string().describe('ID du ticket (issu de get_tickets)'),
          reason: z.string().max(512).optional().describe('Raison de la fermeture'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_TICKETS', async ({ ticket_id, reason, key_name }) => {
        const ticket = await prisma.ticket.findFirst({ where: { id: ticket_id, guildId } });
        if (!ticket) return err('Ticket introuvable');
        if (ticket.status === 'CLOSED') return err('Ce ticket est déjà fermé');

        const closerName = `MCP[${key_name ?? 'agent'}]`;

        // Envoyer un message de contexte dans le salon avant la fermeture
        if (ticket.channelId && reason) {
          const channel = client.guilds.cache.get(guildId)?.channels.cache.get(ticket.channelId);
          if (channel?.isTextBased()) {
            await (channel as TextChannel | NewsChannel)
              .send({ content: `🤖 Raison de fermeture (IA) : ${reason}` })
              .catch(() => null);
          }
        }

        // Utiliser la vraie fonction closeTicket qui gère tout :
        // - Update BDD (status CLOSED, closedBy, closedAt)
        // - Retrait des permissions de l'opener
        // - Envoi de l'embed de fermeture avec boutons Réouvrir/Supprimer
        // - Renommage du salon (ticket- → fermer-)
        // - Log dans le salon de logs
        // - Envoi du sondage de satisfaction
        await closeTicket(client, ticket.id, client.user?.id ?? 'mcp_agent', closerName);

        await audit(key_name, 'Fermeture ticket MCP', `Ticket: ${ticket.id}`, reason ?? '(sans raison)');

        return ok({ ok: true, ticketId: ticket.id, status: 'CLOSED' });
      })
    );
  }

  // ── READ_COMMUNITY ────────────────────────────────────────────────────────

  if (shouldRegister('READ_COMMUNITY')) {
    server.registerTool(
      'get_leaderboard',
      {
        description: 'Classement des membres par XP/niveau, nombre de messages ou temps vocal.',
        inputSchema: {
          by: z.enum(['xp', 'messages', 'voice']).default('xp').describe('Critère du classement'),
          limit: z.number().int().min(1).max(50).default(10),
        },
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async ({ by, limit }) => {
        if (by === 'xp') {
          const rows = await prisma.memberLevel.findMany({
            where: { guildId },
            orderBy: { xp: 'desc' },
            take: limit,
          });
          const profiles = await prisma.memberProfile.findMany({
            where: { guildId, userId: { in: rows.map((r) => r.userId) } },
            select: { userId: true, username: true, displayName: true },
          });
          const nameOf = new Map(profiles.map((p) => [p.userId, p.displayName ?? p.username ?? p.userId]));
          return ok(
            rows.map((r, i) => ({
              rank: i + 1,
              userId: r.userId,
              name: nameOf.get(r.userId) ?? r.userId,
              level: r.level,
              xp: r.xp,
            }))
          );
        }

        const field = by === 'voice' ? 'voiceTimeSeconds' : 'messageCount';
        const rows = await prisma.memberProfile.findMany({
          where: { guildId },
          orderBy: { [field]: 'desc' },
          take: limit,
          select: { userId: true, username: true, displayName: true, messageCount: true, voiceTimeSeconds: true },
        });
        return ok(
          rows.map((r, i) => ({
            rank: i + 1,
            userId: r.userId,
            name: r.displayName ?? r.username ?? r.userId,
            messageCount: r.messageCount,
            voiceTimeSeconds: r.voiceTimeSeconds,
          }))
        );
      })
    );

    server.registerTool(
      'get_suggestions',
      {
        description: 'Liste les suggestions de la communauté avec filtre optionnel par statut.',
        inputSchema: {
          status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'IMPLEMENTED']).optional(),
          limit: z.number().int().min(1).max(50).default(20),
        },
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async ({ status, limit }) => {
        const suggestions = await prisma.suggestion.findMany({
          where: { guildId, ...(status ? { status } : {}) },
          orderBy: { createdAt: 'desc' },
          take: limit,
        });
        return ok(
          suggestions.map((s) => ({
            id: s.id,
            content: s.content,
            status: s.status,
            author: s.username,
            authorId: s.userId,
            upvotes: s.upvoters.length,
            downvotes: s.downvoters.length,
            response: s.responseText,
            createdAt: s.createdAt.toISOString(),
          }))
        );
      })
    );

    server.registerTool(
      'get_events',
      {
        description: 'Liste les événements du serveur.',
        inputSchema: {
          status: z.string().optional().describe('Filtre optionnel sur le statut (ex: DRAFT, SCHEDULED, ACTIVE, ENDED)'),
          limit: z.number().int().min(1).max(50).default(20),
        },
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async ({ status, limit }) => {
        const events = await prisma.event.findMany({
          where: { guildId, ...(status ? { status: status as never } : {}) },
          orderBy: { createdAt: 'desc' },
          take: limit,
          include: { _count: { select: { participants: true } } },
        });
        return ok(
          events.map((e) => ({
            id: e.id,
            title: e.title,
            description: e.description,
            type: e.type,
            status: e.status,
            triggerType: e.triggerType,
            triggerValue: e.triggerValue,
            participants: e._count.participants,
            createdAt: e.createdAt.toISOString(),
          }))
        );
      })
    );

    server.registerTool(
      'get_giveaways',
      {
        description: 'Liste les giveaways du serveur.',
        inputSchema: {
          active_only: z.boolean().default(false).describe('Ne retourner que les giveaways en cours'),
          limit: z.number().int().min(1).max(50).default(20),
        },
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async ({ active_only, limit }) => {
        const giveaways = await prisma.giveaway.findMany({
          where: { guildId, ...(active_only ? { ended: false } : {}) },
          orderBy: { endsAt: 'desc' },
          take: limit,
        });
        return ok(
          giveaways.map((g) => ({
            id: g.id,
            prize: g.prize,
            description: g.description,
            winnerCount: g.winnerCount,
            ended: g.ended,
            endsAt: g.endsAt.toISOString(),
            participants: g.participants.length,
            winners: g.winners,
          }))
        );
      })
    );

    server.registerTool(
      'get_reputation_leaderboard',
      {
        description: 'Classement des membres par points de réputation.',
        inputSchema: {
          limit: z.number().int().min(1).max(50).default(10),
        },
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async ({ limit }) => {
        const votes = await prisma.reputationVote.groupBy({
          by: ['receiverId'],
          where: { guildId },
          _count: { id: true },
          orderBy: { _count: { id: 'desc' } },
          take: limit,
        });

        const userIds = votes.map((v) => v.receiverId);
        const profiles = await prisma.memberProfile.findMany({
          where: { guildId, userId: { in: userIds } },
          select: { userId: true, username: true, displayName: true },
        });
        const nameOf = new Map(profiles.map((p) => [p.userId, p.displayName ?? p.username ?? p.userId]));

        return ok(
          votes.map((v, i) => ({
            rank: i + 1,
            userId: v.receiverId,
            name: nameOf.get(v.receiverId) ?? v.receiverId,
            reputationPoints: v._count.id,
          }))
        );
      })
    );

    server.registerTool(
      'get_quest_definitions',
      {
        description: 'Liste les quêtes disponibles sur le serveur (quotidiennes, hebdomadaires, etc.).',
        inputSchema: {
          enabled_only: z.boolean().default(true).describe('Ne retourner que les quêtes actives'),
        },
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async ({ enabled_only }) => {
        const quests = await prisma.questDefinition.findMany({
          where: { guildId, ...(enabled_only ? { enabled: true } : {}) },
          orderBy: { createdAt: 'desc' },
        });
        return ok(
          quests.map((q) => ({
            id: q.id,
            name: q.name,
            description: q.description,
            type: q.type,
            frequency: q.frequency,
            target: q.target,
            rewardCoins: q.rewardCoins,
            rewardXp: q.rewardXp,
            enabled: q.enabled,
          }))
        );
      })
    );

    server.registerTool(
      'get_member_quests',
      {
        description: "Récupère la progression des quêtes d'un membre spécifique.",
        inputSchema: {
          member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre'),
        },
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async ({ member }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        const progress = await prisma.questProgress.findMany({
          where: { guildId, userId: resolved.userId },
          include: { quest: { select: { name: true, description: true, type: true, frequency: true, target: true } } },
          orderBy: { updatedAt: 'desc' },
          take: 20,
        });

        return ok(
          progress.map((p) => ({
            questName: p.quest.name,
            questType: p.quest.type,
            frequency: p.quest.frequency,
            current: p.current,
            target: p.target,
            status: p.status,
            dateKey: p.dateKey,
            claimedAt: p.claimedAt?.toISOString() ?? null,
          }))
        );
      })
    );

    server.registerTool(
      'get_custom_forms',
      {
        description: 'Liste les formulaires personnalisés du serveur. Requiert READ_COMMUNITY.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async () => {
        try {
          const forms = await prisma.customForm.findMany({
            where: { guildId },
            orderBy: { createdAt: 'desc' },
          });
          return ok(forms);
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_custom_form',
      {
        description: 'Récupère les détails d\'un formulaire personnalisé par son ID. Requiert READ_COMMUNITY.',
        inputSchema: {
          form_id: z.string().describe('ID du formulaire'),
        },
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async ({ form_id }) => {
        try {
          const form = await prisma.customForm.findFirst({
            where: { id: form_id, guildId },
          });
          if (!form) return err('Formulaire introuvable');
          return ok(form);
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_custom_form_submissions',
      {
        description: 'Récupère les soumissions de réponses pour un formulaire personnalisé. Requiert READ_COMMUNITY.',
        inputSchema: {
          form_id: z.string().describe('ID du formulaire'),
          limit: z.number().int().min(1).max(100).default(50),
        },
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async ({ form_id, limit }) => {
        try {
          const submissions = await prisma.customFormSubmission.findMany({
            where: { formId: form_id, guildId },
            orderBy: { createdAt: 'desc' },
            take: limit,
          });
          return ok(submissions);
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_scheduled_tasks',
      {
        description: 'Liste les tâches planifiées automatiques (Cron). Requiert READ_COMMUNITY.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async () => {
        try {
          const tasks = await prisma.scheduledTask.findMany({
            where: { guildId },
            orderBy: { createdAt: 'desc' },
          });
          return ok(tasks);
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_seasons',
      {
        description: 'Récupère les saisons de leveling (actives, à venir, terminées) et le classement en cours. Requiert READ_COMMUNITY.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async () => {
        try {
          const data = await getSeasonsDashboardData(guildId);
          return ok(data);
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_season_leaderboard',
      {
        description: 'Récupère le classement d\'une saison de leveling spécifique. Requiert READ_COMMUNITY.',
        inputSchema: {
          season_id: z.string().describe('ID de la saison'),
          limit: z.number().int().min(1).max(100).default(20),
        },
        _meta: toolMeta,
      },
      guard('READ_COMMUNITY', async ({ season_id, limit }) => {
        try {
          const leaderboard = await getSeasonLeaderboard(guildId, season_id, limit);
          return ok({ seasonId: season_id, leaderboard });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_module_activation_stats',
      {
        description: 'Récupère l’état d’activation des modules Kotbo.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STATS', async () => {
        try {
          return ok(await getModuleActivationStats(guildId));
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_module_usage_stats',
      {
        description: 'Récupère les statistiques d’utilisation des modules Kotbo.',
        inputSchema: {
          module_name: z.string().optional().describe('Nom du module Kotbo'),
          start_date: z.string().optional().describe('Date de début ISO'),
          end_date: z.string().optional().describe('Date de fin ISO'),
          period_days: z.number().int().min(1).max(365).optional().describe('Fenêtre temporelle en jours'),
        },
        _meta: toolMeta,
      },
      guard('READ_STATS', async ({ module_name, start_date, end_date, period_days }) => {
        try {
          const data = await getModuleUsageStats({
            guildId,
            moduleName: module_name ? (KOTBO_MODULES.includes(module_name as never) ? (module_name as never) : undefined) : undefined,
            startDate: start_date,
            endDate: end_date,
            periodDays: period_days,
          });
          return ok(data);
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_module_performance_stats',
      {
        description: 'Récupère les performances des modules Kotbo.',
        inputSchema: {
          module_name: z.string().optional().describe('Nom du module Kotbo'),
          start_date: z.string().optional().describe('Date de début ISO'),
          end_date: z.string().optional().describe('Date de fin ISO'),
          period_days: z.number().int().min(1).max(365).optional().describe('Fenêtre temporelle en jours'),
        },
        _meta: toolMeta,
      },
      guard('READ_STATS', async ({ module_name, start_date, end_date, period_days }) => {
        try {
          const data = await getModulePerformanceStats({
            guildId,
            moduleName: module_name ? (KOTBO_MODULES.includes(module_name as never) ? (module_name as never) : undefined) : undefined,
            startDate: start_date,
            endDate: end_date,
            periodDays: period_days,
          });
          return ok(data);
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_module_stats_summary',
      {
        description: 'Récupère un résumé global des statistiques modules.',
        inputSchema: {
          period_days: z.number().int().min(1).max(365).default(30),
        },
        _meta: toolMeta,
      },
      guard('READ_STATS', async ({ period_days }) => {
        try {
          return ok(await getModuleStatsSummary({ guildId, periodDays: period_days }));
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
  }

  // ── READ_ECONOMY ──────────────────────────────────────────────────────────

  if (shouldRegister('READ_ECONOMY')) {
    server.registerTool(
      'get_economy_config',
      {
        description: "Récupère la configuration de l'économie du serveur (monnaie, récompenses, paramètres RPG).",
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_ECONOMY', async () => {
        const config = await prisma.economyConfig.findUnique({ where: { guildId } });
        if (!config) return err("Aucune configuration d'économie trouvée pour ce serveur.");

        return ok({
          currencyName: config.currencyName,
          currencyEmoji: config.currencyEmoji,
          dailyRewardMin: config.dailyRewardMin,
          dailyRewardMax: config.dailyRewardMax,
          maxEnergy: config.maxEnergy,
          energyRecoveryPerHour: config.energyRecoveryPerHour,
        });
      })
    );

    server.registerTool(
      'get_rpg_profile',
      {
        description: "Récupère le profil RPG d'un membre (solde, niveau, stats, équipement).",
        inputSchema: {
          member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre'),
        },
        _meta: toolMeta,
      },
      guard('READ_ECONOMY', async ({ member }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        const profile = await prisma.rpgProfile.findUnique({
          where: { guildId_userId: { guildId, userId: resolved.userId } },
          include: {
            rpgGuild: { select: { name: true, level: true } },
            inventory: { include: { item: { select: { name: true, type: true } } }, take: 30 },
          },
        });

        if (!profile) return err('Aucun profil RPG trouvé pour ce membre.');

        const equipIds = [profile.weaponId, profile.armorId, profile.potionId].filter(Boolean) as string[];
        const equipItems = equipIds.length > 0
          ? await prisma.rpgItem.findMany({ where: { id: { in: equipIds } }, select: { id: true, name: true, type: true, atkBonus: true, defBonus: true, hpRestore: true } })
          : [];
        const equipOf = new Map(equipItems.map((i) => [i.id, i]));

        const weapon = profile.weaponId ? equipOf.get(profile.weaponId) : null;
        const armor = profile.armorId ? equipOf.get(profile.armorId) : null;
        const potion = profile.potionId ? equipOf.get(profile.potionId) : null;

        return ok({
          userId: resolved.userId,
          balance: profile.balance,
          level: profile.level,
          xp: profile.xp,
          health: profile.health,
          maxHealth: profile.maxHealth,
          energy: profile.energy,
          attack: profile.attack,
          defense: profile.defense,
          speed: profile.speed,
          isTraveling: profile.isTraveling,
          travelDestination: profile.travelDestination,
          weapon: weapon ? { name: weapon.name, atkBonus: weapon.atkBonus } : null,
          armor: armor ? { name: armor.name, defBonus: armor.defBonus } : null,
          potion: potion ? { name: potion.name, hpRestore: potion.hpRestore } : null,
          guild: profile.rpgGuild ? { name: profile.rpgGuild.name, level: profile.rpgGuild.level } : null,
          inventory: profile.inventory.map((i) => ({
            itemName: i.item.name,
            itemType: i.item.type,
            quantity: i.quantity,
          })),
        });
      })
    );

    server.registerTool(
      'get_rpg_leaderboard',
      {
        description: 'Classement économique par solde, niveau RPG ou XP RPG.',
        inputSchema: {
          by: z.enum(['balance', 'level', 'xp']).default('balance').describe('Critère du classement'),
          limit: z.number().int().min(1).max(50).default(10),
        },
        _meta: toolMeta,
      },
      guard('READ_ECONOMY', async ({ by, limit }) => {
        const rows = await prisma.rpgProfile.findMany({
          where: { guildId },
          orderBy: { [by]: 'desc' },
          take: limit,
          select: { userId: true, balance: true, level: true, xp: true },
        });

        const profiles = await prisma.memberProfile.findMany({
          where: { guildId, userId: { in: rows.map((r) => r.userId) } },
          select: { userId: true, username: true, displayName: true },
        });
        const nameOf = new Map(profiles.map((p) => [p.userId, p.displayName ?? p.username ?? p.userId]));

        return ok(
          rows.map((r, i) => ({
            rank: i + 1,
            userId: r.userId,
            name: nameOf.get(r.userId) ?? r.userId,
            balance: r.balance,
            level: r.level,
            xp: r.xp,
          }))
        );
      })
    );

    server.registerTool(
      'get_shop_items',
      {
        description: 'Liste les objets disponibles dans la boutique RPG.',
        inputSchema: {
          type: z.string().optional().describe("Filtre par type d'objet (WEAPON, ARMOR, POTION, etc.)"),
          purchasable_only: z.boolean().default(true).describe('Ne retourner que les objets achetables'),
        },
        _meta: toolMeta,
      },
      guard('READ_ECONOMY', async ({ type, purchasable_only }) => {
        const items = await prisma.rpgItem.findMany({
          where: {
            guildId,
            ...(type ? { type } : {}),
            ...(purchasable_only ? { purchasable: true } : {}),
          },
          orderBy: { price: 'asc' },
        });

        return ok(
          items.map((item) => ({
            id: item.id,
            name: item.name,
            description: item.description,
            type: item.type,
            price: item.price,
            purchasable: item.purchasable,
            atkBonus: item.atkBonus,
            defBonus: item.defBonus,
            hpRestore: item.hpRestore,
            energyRestore: item.energyRestore,
          }))
        );
      })
    );

    server.registerTool(
      'get_marketplace_listings',
      {
        description: 'Liste les offres actives du marché (ventes et enchères entre joueurs).',
        inputSchema: {
          type: z.enum(['FIXED_PRICE', 'AUCTION']).optional().describe("Type d'offre"),
          limit: z.number().int().min(1).max(50).default(20),
        },
        _meta: toolMeta,
      },
      guard('READ_ECONOMY', async ({ type, limit }) => {
        const listings = await prisma.marketplaceListing.findMany({
          where: {
            guildId,
            status: 'ACTIVE',
            ...(type ? { type } : {}),
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
        });

        const itemIds = [...new Set(listings.map((l) => l.itemId))];
        const sellerIds = [...new Set(listings.map((l) => l.sellerId))];

        const [items, profiles] = await Promise.all([
          prisma.rpgItem.findMany({
            where: { id: { in: itemIds } },
            select: { id: true, name: true, type: true },
          }),
          prisma.memberProfile.findMany({
            where: { guildId, userId: { in: sellerIds } },
            select: { userId: true, username: true, displayName: true },
          }),
        ]);

        const itemOf = new Map(items.map((i) => [i.id, i]));
        const nameOf = new Map(profiles.map((p) => [p.userId, p.displayName ?? p.username ?? p.userId]));

        return ok(
          listings.map((l) => {
            const item = itemOf.get(l.itemId);
            return {
              id: l.id,
              type: l.type,
              status: l.status,
              itemName: item?.name ?? l.itemId,
              itemType: item?.type ?? null,
              quantity: l.quantity,
              price: l.price,
              currentBid: l.currentBid,
              sellerName: nameOf.get(l.sellerId) ?? l.sellerId,
              expiresAt: l.expiresAt?.toISOString() ?? null,
              createdAt: l.createdAt.toISOString(),
            };
          })
        );
      })
    );
  }

  // ── READ_MODERATION ───────────────────────────────────────────────────────

  if (shouldRegister('READ_MODERATION')) {
    server.registerTool(
      'get_automod_config',
      {
        description: "Récupère la configuration complète de l'AutoMod du serveur.",
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_MODERATION', async () => {
        const config = await prisma.autoModConfig.findUnique({ where: { guildId } });
        if (!config) return err("Aucune configuration AutoMod trouvée.");

        return ok({
          discordAutoModEnabled: config.discordAutoModEnabled,
          spamEnabled: config.spamEnabled,
          linksEnabled: config.linksEnabled,
          capsEnabled: config.capsEnabled,
          emojisEnabled: config.emojisEnabled,
          mentionsEnabled: config.mentionsEnabled,
          ghostPingEnabled: config.ghostPingEnabled,
          antiEveryoneEnabled: config.antiEveryoneEnabled,
          customWordsEnabled: config.customWordsEnabled,
          profanityEnabled: config.profanityEnabled,
          inviteFilterEnabled: config.inviteFilterEnabled,
          antiBotEnabled: config.antiBotEnabled,
          bypassRoles: config.bypassRoles,
          bypassChannels: config.bypassChannels,
        });
      })
    );

    server.registerTool(
      'get_banned_words',
      {
        description: 'Liste les mots bannis configurés sur le serveur.',
        inputSchema: {
          category: z.string().optional().describe('Filtre par catégorie'),
          enabled_only: z.boolean().default(true),
        },
        _meta: toolMeta,
      },
      guard('READ_MODERATION', async ({ category, enabled_only }) => {
        const words = await prisma.bannedWord.findMany({
          where: {
            guildId,
            ...(category ? { category } : {}),
            ...(enabled_only ? { enabled: true } : {}),
          },
          orderBy: { category: 'asc' },
        });

        return ok(
          words.map((w) => ({
            id: w.id,
            word: w.word,
            category: w.category,
            enabled: w.enabled,
          }))
        );
      })
    );

    server.registerTool(
      'get_auto_responses',
      {
        description: 'Liste les réponses automatiques configurées sur le serveur.',
        inputSchema: {
          enabled_only: z.boolean().default(true),
        },
        _meta: toolMeta,
      },
      guard('READ_MODERATION', async ({ enabled_only }) => {
        const responses = await prisma.autoResponse.findMany({
          where: { guildId, ...(enabled_only ? { enabled: true } : {}) },
          orderBy: { createdAt: 'desc' },
        });

        return ok(
          responses.map((r) => ({
            id: r.id,
            triggerType: r.triggerType,
            trigger: r.trigger,
            response: r.response,
            matchType: r.matchType,
            enabled: r.enabled,
            deleteTrigger: r.deleteTrigger,
            allowedChannelIds: r.allowedChannelIds,
            bannedChannelIds: r.bannedChannelIds,
            allowedRoleIds: r.allowedRoleIds,
            bannedRoleIds: r.bannedRoleIds,
            reactions: r.reactions,
            actions: r.actions,
            closeTicket: r.closeTicket,
            rejectForm: r.rejectForm,
            formId: r.formId,
            formQuestionLabel: r.formQuestionLabel,
            ticketTypeId: r.ticketTypeId,
            ticketQuestionLabel: r.ticketQuestionLabel,
          }))
        );
      })
    );

    server.registerTool(
      'get_code_police_rules',
      {
        description: 'Liste les règles CodePolice (détection de code brut dans les messages).',
        inputSchema: {
          enabled_only: z.boolean().default(true),
        },
        _meta: toolMeta,
      },
      guard('READ_MODERATION', async ({ enabled_only }) => {
        const rules = await prisma.codePoliceRule.findMany({
          where: { guildId, ...(enabled_only ? { enabled: true } : {}) },
          orderBy: { category: 'asc' },
        });

        return ok(
          rules.map((r) => ({
            id: r.id,
            key: r.key,
            category: r.category,
            matchType: r.matchType,
            language: r.language,
            label: r.label,
            severity: r.severity,
            enabled: r.enabled,
          }))
        );
      })
    );

    server.registerTool(
      'get_ban_appeals',
      {
        description: 'Liste les demandes d\'appel de bannissement (Ban Appeals) reçues sur le serveur. Requiert READ_MODERATION.',
        inputSchema: {
          status: z.enum(['PENDING', 'NEEDS_INFO', 'ACCEPTED', 'DENIED', 'DENIED_PERMANENT']).optional().describe('Filtre par statut de la demande'),
          limit: z.number().int().min(1).max(200).default(50),
        },
        _meta: toolMeta,
      },
      guard('READ_MODERATION', async ({ status, limit }) => {
        try {
          const appeals = await prisma.banAppeal.findMany({
            where: { guildId, ...(status ? { status } : {}) },
            orderBy: { createdAt: 'desc' },
            take: limit,
          });
          return ok(appeals);
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_ban_appeal',
      {
        description: 'Récupère les détails d\'un appel de bannissement spécifique avec son historique et ses sanctions liées. Requiert READ_MODERATION.',
        inputSchema: {
          appeal_id: z.string().describe('ID unique de la demande d\'appel'),
        },
        _meta: toolMeta,
      },
      guard('READ_MODERATION', async ({ appeal_id }) => {
        try {
          const detail = await getAppealDetail(appeal_id, guildId);
          if (!detail) return err('Appel introuvable');
          return ok(detail);
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_ban_appeal_config',
      {
        description: 'Récupère la configuration actuelle des appels de bannissement sur le serveur. Requiert READ_MODERATION.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_MODERATION', async () => {
        try {
          const config = await getAppealConfig(guildId);
          return ok(config);
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
  }

  // ── READ_ANALYTICS ────────────────────────────────────────────────────────

  if (shouldRegister('READ_ANALYTICS')) {
    server.registerTool(
      'get_channel_analytics',
      {
        description: "Statistiques d'activité par salon sur une période donnée (messages, auteurs uniques, vocal).",
        inputSchema: {
          period_days: z.number().int().min(1).max(90).default(7).describe('Nombre de jours à analyser'),
          limit: z.number().int().min(1).max(50).default(20).describe('Nombre de salons à retourner'),
        },
        _meta: toolMeta,
      },
      guard('READ_ANALYTICS', async ({ period_days, limit }) => {
        const since = new Date();
        since.setDate(since.getDate() - period_days);
        const sinceKey = since.toISOString().slice(0, 10);

        const stats = await prisma.channelDailyStat.groupBy({
          by: ['channelId'],
          where: { guildId, dateKey: { gte: sinceKey } },
          _sum: { messagesCount: true, uniqueAuthors: true, voiceMinutes: true },
          orderBy: { _sum: { messagesCount: 'desc' } },
          take: limit,
        });

        const guild = client.guilds.cache.get(guildId);
        return ok(
          stats.map((s) => {
            const ch = guild?.channels.cache.get(s.channelId);
            return {
              channelId: s.channelId,
              channelName: ch?.name ?? null,
              totalMessages: s._sum.messagesCount ?? 0,
              totalUniqueAuthors: s._sum.uniqueAuthors ?? 0,
              totalVoiceMinutes: s._sum.voiceMinutes ?? 0,
            };
          })
        );
      })
    );

    server.registerTool(
      'get_hourly_activity',
      {
        description: "Activité horaire du serveur (heatmap) pour visualiser les pics d'activité.",
        inputSchema: {
          days: z.number().int().min(1).max(30).default(7).describe('Nombre de jours à analyser'),
        },
        _meta: toolMeta,
      },
      guard('READ_ANALYTICS', async ({ days }) => {
        const data = await getHourlyHeatmapData(guildId, { days });
        return ok(data);
      })
    );

    server.registerTool(
      'get_pulse_dashboard',
      {
        description:
          'Score de santé du serveur (Pulse) avec détails par catégorie : activité, modération, croissance, engagement.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_ANALYTICS', async () => {
        const data = await getPulseDashboardData(guildId);
        return ok(data);
      })
    );

    server.registerTool(
      'get_member_daily_stats',
      {
        description: "Statistiques quotidiennes d'un membre spécifique (messages, vocal par jour).",
        inputSchema: {
          member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre'),
          period_days: z.number().int().min(1).max(30).default(7),
        },
        _meta: toolMeta,
      },
      guard('READ_ANALYTICS', async ({ member, period_days }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        const since = new Date();
        since.setDate(since.getDate() - period_days);
        const sinceKey = since.toISOString().slice(0, 10);

        const stats = await prisma.memberDailyStat.findMany({
          where: { guildId, userId: resolved.userId, dateKey: { gte: sinceKey } },
          orderBy: { dateKey: 'asc' },
        });

        return ok({
          userId: resolved.userId,
          name: resolved.label,
          period: { from: sinceKey, days: period_days },
          daily: stats.map((s) => ({
            date: s.dateKey,
            messages: s.messagesCount,
            voiceMinutes: s.voiceMinutes,
          })),
          totals: stats.reduce(
            (acc: { messages: number; voiceMinutes: number }, s) => ({
              messages: acc.messages + s.messagesCount,
              voiceMinutes: acc.voiceMinutes + s.voiceMinutes,
            }),
            { messages: 0, voiceMinutes: 0 }
          ),
        });
      })
    );

    server.registerTool(
      'get_prediction_data',
      {
        description: "Prédictions d'activité du serveur (tendances, projections de croissance, prévisions de churn).",
        inputSchema: {
          days: z.number().int().min(7).max(90).default(30).describe("Nombre de jours d'historique pour les prédictions"),
        },
        _meta: toolMeta,
      },
      guard('READ_ANALYTICS', async ({ days }) => {
        const data = await getPredictionData(guildId, days);
        return ok(data);
      })
    );

    server.registerTool(
      'get_channel_health',
      {
        description: 'Récupère la configuration et les alertes de santé des salons (Channel Health). Requiert READ_ANALYTICS.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_ANALYTICS', async () => {
        try {
          const data = await getChannelHealthDashboardData(guildId);
          return ok(data);
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'analyze_channel_health',
      {
        description: 'Lance une analyse de santé des salons (surcharge, sous-utilisation, morts). Requiert READ_ANALYTICS.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_ANALYTICS', async () => {
        try {
          const summary = await analyzeGuildChannelHealth(client, guildId);
          return ok(summary ?? { channels: [], overloaded: [], underused: [], dead: [], healthy: [] });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
  }

  // ── WRITE_COMMUNITY ───────────────────────────────────────────────────────

  if (shouldRegister('WRITE_COMMUNITY')) {
    server.registerTool(
      'respond_suggestion',
      {
        description:
          "Répond à une suggestion communautaire et met à jour son statut. Requiert la permission WRITE_COMMUNITY.",
        inputSchema: {
          suggestion_id: z.string().describe('ID de la suggestion (issu de get_suggestions)'),
          status: z.enum(['APPROVED', 'REJECTED', 'IMPLEMENTED']).describe('Nouveau statut'),
          response: z.string().min(1).max(1000).describe('Texte de réponse'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ suggestion_id, status, response, key_name }) => {
        const suggestion = await prisma.suggestion.findFirst({ where: { id: suggestion_id, guildId } });
        if (!suggestion) return err('Suggestion introuvable');

        await prisma.suggestion.update({
          where: { id: suggestion.id },
          data: {
            status,
            responseText: response,
            respondedById: 'mcp_agent',
            respondedAt: new Date(),
          },
        });

        if (suggestion.channelId && suggestion.messageId) {
          const channel = client.guilds.cache.get(guildId)?.channels.cache.get(suggestion.channelId);
          if (channel?.isTextBased()) {
            const statusEmoji = status === 'APPROVED' ? '✅' : status === 'REJECTED' ? '❌' : '🚀';
            await (channel as TextChannel | NewsChannel)
              .send({ content: `${statusEmoji} **Réponse à la suggestion de ${suggestion.username} :**\n${response}` })
              .catch(() => null);
          }
        }

        await audit(key_name, 'Réponse suggestion MCP', `Suggestion: ${suggestion.id}`, `${status} — ${response.slice(0, 200)}`);

        return ok({ ok: true, suggestionId: suggestion.id, status });
      })
    );

    server.registerTool(
      'update_event_status',
      {
        description: "Met à jour le statut d'un événement du serveur. Requiert la permission WRITE_COMMUNITY.",
        inputSchema: {
          event_id: z.string().describe("ID de l'événement (issu de get_events)"),
          status: z.enum(['DRAFT', 'SCHEDULED', 'ACTIVE', 'ENDED', 'CANCELLED']).describe('Nouveau statut'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ event_id, status, key_name }) => {
        const event = await prisma.event.findFirst({ where: { id: event_id, guildId } });
        if (!event) return err('Événement introuvable');

        await prisma.event.update({ where: { id: event.id }, data: { status } });

        await audit(key_name, 'Modification événement MCP', `Événement: ${event.title}`, `Statut: ${status}`);

        return ok({ ok: true, eventId: event.id, title: event.title, status });
      })
    );

    server.registerTool(
      'create_giveaway_message',
      {
        description:
          "Annonce un giveaway existant dans un salon Discord. Requiert la permission WRITE_COMMUNITY.",
        inputSchema: {
          giveaway_id: z.string().describe('ID du giveaway (issu de get_giveaways)'),
          channel: z.string().describe('Nom du salon, mention <#id> ou ID'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ giveaway_id, channel, key_name }) => {
        const giveaway = await prisma.giveaway.findFirst({ where: { id: giveaway_id, guildId } });
        if (!giveaway) return err('Giveaway introuvable');

        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        const msg = await resolved.channel
          .send({
            content: `🎉 **GIVEAWAY** 🎉\n\n**${giveaway.prize}**${giveaway.description ? `\n${giveaway.description}` : ''}\n\n🏆 ${giveaway.winnerCount} gagnant(s)\n⏰ Fin : <t:${Math.floor(giveaway.endsAt.getTime() / 1000)}:R>\n\nParticipants : ${giveaway.participants.length}`,
          })
          .catch(() => null);

        if (!msg) return err("Impossible d'envoyer le message dans ce salon");

        await audit(key_name, 'Annonce giveaway MCP', `Giveaway: ${giveaway.prize}`, `Salon: #${resolved.channel.name}`);

        return ok({ ok: true, giveawayId: giveaway.id, messageId: msg.id, channelName: resolved.channel.name });
      })
    );

    server.registerTool(
      'create_season',
      {
        description: 'Crée une nouvelle saison de leveling. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          name: z.string().describe('Nom de la saison'),
          start_date: z.string().describe('Date de début (ISO 8601)'),
          end_date: z.string().describe('Date de fin (ISO 8601)'),
          top_role_id: z.string().optional().describe('Rôle attribué au #1 du classement'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ name, start_date, end_date, top_role_id, key_name }) => {
        try {
          const season = await createSeason(guildId, {
            name,
            startDate: new Date(start_date),
            endDate: new Date(end_date),
            topRoleId: top_role_id,
          });
          await audit(key_name, 'Création saison MCP', name, `ID: ${season.id}`);
          return ok({ ok: true, season });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'start_season',
      {
        description: 'Démarre une saison de leveling (met fin aux autres saisons actives). Requiert WRITE_COMMUNITY.',
        inputSchema: {
          season_id: z.string().describe('ID de la saison à démarrer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ season_id, key_name }) => {
        try {
          const success = await startSeason(guildId, season_id);
          if (!success) return err('Impossible de démarrer la saison');
          await audit(key_name, 'Démarrage saison MCP', season_id, '');
          return ok({ ok: true, seasonId: season_id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'end_season',
      {
        description: 'Termine une saison active, fige le classement et distribue les récompenses. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          season_id: z.string().describe('ID de la saison à terminer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ season_id, key_name }) => {
        try {
          const success = await endSeason(client, guildId, season_id);
          if (!success) return err('Impossible de terminer la saison');
          await audit(key_name, 'Fin de saison MCP', season_id, '');
          return ok({ ok: true, seasonId: season_id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_channel_health_config',
      {
        description: 'Met à jour la configuration du module Channel Health. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          enabled: z.boolean().optional(),
          alert_channel: z.string().nullable().optional().describe('Salon d\'alertes (nom, mention ou ID)'),
          split_mode: z.boolean().optional(),
          archive_mode: z.boolean().optional(),
          analysis_period_days: z.number().int().optional(),
          overload_msg_per_hour: z.number().optional(),
          underused_msg_per_day: z.number().optional(),
          dead_msg_per_week: z.number().optional(),
          weekly_digest_enabled: z.boolean().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ enabled, alert_channel, split_mode, archive_mode, analysis_period_days, overload_msg_per_hour, underused_msg_per_day, dead_msg_per_week, weekly_digest_enabled, key_name }) => {
        try {
          const updatePayload: Record<string, unknown> = {};
          if (enabled !== undefined) updatePayload.enabled = enabled;
          if (split_mode !== undefined) updatePayload.splitMode = split_mode;
          if (archive_mode !== undefined) updatePayload.archiveMode = archive_mode;
          if (analysis_period_days !== undefined) updatePayload.analysisPeriodDays = analysis_period_days;
          if (overload_msg_per_hour !== undefined) updatePayload.overloadMsgPerHour = overload_msg_per_hour;
          if (underused_msg_per_day !== undefined) updatePayload.underusedMsgPerDay = underused_msg_per_day;
          if (dead_msg_per_week !== undefined) updatePayload.deadMsgPerWeek = dead_msg_per_week;
          if (weekly_digest_enabled !== undefined) updatePayload.weeklyDigestEnabled = weekly_digest_enabled;

          if (alert_channel !== undefined) {
            if (alert_channel === null) {
              updatePayload.alertChannelId = null;
            } else {
              const resolved = resolveChannel(guildId, client, alert_channel);
              if (!resolved.ok) return resolved.response;
              updatePayload.alertChannelId = resolved.channel.id;
            }
          }

          const config = await upsertChannelHealthConfig(guildId, updatePayload);
          await audit(key_name, 'Config Channel Health MCP', '', JSON.stringify(updatePayload));
          return ok(config);
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'resolve_channel_health_alert',
      {
        description: 'Marque une alerte Channel Health comme appliquée ou ignorée. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          alert_id: z.string().describe('ID de l\'alerte'),
          action: z.enum(['APPLIED', 'DISMISSED']).describe('Action à enregistrer'),
          note: z.string().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ alert_id, action, note, key_name }) => {
        try {
          const success = await resolveHealthAlert(alert_id, action, 'mcp_agent', note);
          if (!success) return err('Alerte introuvable');
          await audit(key_name, 'Résolution alerte Channel Health MCP', alert_id, action);
          return ok({ ok: true, alertId: alert_id, action });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'split_overloaded_channel',
      {
        description: 'Crée un salon jumeau pour alléger un salon surchargé (Channel Health). Requiert WRITE_COMMUNITY.',
        inputSchema: {
          channel: z.string().describe('Salon surchargé (nom, mention ou ID)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ channel, key_name }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        try {
          const newChannelId = await createSplitChannel(client, guildId, resolved.channel.id);
          if (!newChannelId) return err('Impossible de créer le salon jumeau');
          await audit(key_name, 'Split salon MCP', resolved.channel.name, `Nouveau salon: ${newChannelId}`);
          return ok({ ok: true, sourceChannelId: resolved.channel.id, newChannelId });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'archive_inactive_channel',
      {
        description: 'Archive un salon inactif via Channel Health. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          channel: z.string().describe('Salon à archiver (nom, mention ou ID)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ channel, key_name }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        try {
          const success = await archiveChannel(client, guildId, resolved.channel.id);
          if (!success) return err('Impossible d\'archiver le salon');
          await audit(key_name, 'Archivage salon MCP', resolved.channel.name, resolved.channel.id);
          return ok({ ok: true, channelId: resolved.channel.id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
  }

  if (shouldRegister('WRITE_COMMUNITY')) {
    server.registerTool(
      'set_module_activation',
      {
        description: 'Active ou désactive un module Kotbo.',
        inputSchema: {
          module_name: z.string().describe('Nom du module Kotbo'),
          enabled: z.boolean().describe('État cible'),
          config: z.record(z.unknown()).optional().describe('Configuration associée au module'),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ module_name, enabled, config }) => {
        const normalizedModule = module_name.trim();
        if (!KOTBO_MODULES.includes(normalizedModule as never)) {
          return err(`Module Kotbo inconnu : ${module_name}`);
        }

        try {
          await setModuleActivation(guildId, normalizedModule as never, enabled, config);

          if (normalizedModule === 'leveling') {
            await prisma.levelConfig.upsert({
              where: { guildId },
              create: { guildId, enabled },
              update: { enabled },
            });
          }

          const updates: Record<string, unknown> = {};
          if (normalizedModule === 'codePolice') updates.codePoliceEnabled = enabled;
          if (normalizedModule === 'dailyAlgo') updates.dailyAlgoEnabled = enabled;
          if (normalizedModule === 'translation') updates.translationEnabled = enabled;
          if (normalizedModule === 'sanction') {
            updates.sanctionSyncEnabled = enabled;
            updates.sanctionReportEnabled = enabled;
          }
          if (normalizedModule === 'nicknameModeration') updates.autoNicknameModerationEnabled = enabled;
          if (normalizedModule === 'autoThread') updates.autoThreadEnabled = enabled;
          if (normalizedModule === 'fun') updates.funEnabled = enabled;

          if (Object.keys(updates).length > 0) {
            await prisma.guild.update({ where: { id: guildId }, data: updates });
          }

          await prisma.dashboardFeatureConfig.upsert({
            where: { guildId_featureKey: { guildId, featureKey: normalizedModule } },
            create: {
              guildId,
              featureKey: normalizedModule,
              featureName: normalizedModule,
              enabled,
              loggingEnabled: true,
              userActivityTracking: true,
              notifyViaDiscordChannel: true,
              metadata: config ?? {},
            },
            update: {
              enabled,
              metadata: config ?? {},
            },
          });

          return ok({ ok: true, moduleName: normalizedModule, enabled });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
  }

  // ── WRITE_MEMBERS ─────────────────────────────────────────────────────────

  if (shouldRegister('WRITE_MEMBERS')) {
    server.registerTool(
      'set_member_note',
      {
        description: "Définit ou met à jour la note de modération sur le profil d'un membre. Requiert WRITE_MEMBERS.",
        inputSchema: {
          member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre'),
          note: z.string().max(1000).describe('Note de modération (vide pour effacer)'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, note, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        await prisma.memberProfile.upsert({
          where: { guildId_userId: { guildId, userId: resolved.userId } },
          update: { moderatorNote: note || null },
          create: { guildId, userId: resolved.userId, moderatorNote: note || null, lastSeenAt: new Date() },
        });

        await audit(key_name, 'Note modérateur MCP', `Membre: ${resolved.label} (${resolved.userId})`, note.slice(0, 200) || '(note effacée)');

        return ok({ ok: true, userId: resolved.userId, note: note || null });
      })
    );

    server.registerTool(
      'add_role',
      {
        description: "Ajoute un rôle Discord à un membre. Requiert la permission WRITE_MEMBERS.",
        inputSchema: {
          member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre'),
          role: z.string().describe('Nom ou ID du rôle à ajouter'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, role, key_name }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        const target = await guild.members.fetch(resolved.userId).catch(() => null);
        if (!target) return err('Membre introuvable sur le serveur Discord');

        const roleId = SNOWFLAKE.test(role) ? role : null;
        const discordRole = roleId
          ? guild.roles.cache.get(roleId)
          : guild.roles.cache.find((r) => r.name.toLowerCase() === role.toLowerCase());

        if (!discordRole) return err(`Rôle « ${role} » introuvable`);

        if (target.roles.cache.has(discordRole.id)) {
          return err(`${resolved.label} a déjà le rôle ${discordRole.name}`);
        }

        if (roleGrantsAdministrator(discordRole.permissions.bitfield)) {
          const guardResult = await guardAdminGrant({
            client,
            guild,
            actorId: null,
            requestedVia: 'MCP',
            type: 'MEMBER_ROLE_GRANT',
            permissionBits: discordRole.permissions.bitfield,
            targetRoleId: discordRole.id,
            targetRoleName: discordRole.name,
            targetMemberId: resolved.userId,
            requestReason: `via MCP (clé: ${key_name ?? 'agent'})`,
          });
          if (guardResult.blocked) {
            await audit(key_name, 'Ajout rôle MCP — bloqué (Admin Lock)', `Membre: ${resolved.label}`, `Rôle: ${discordRole.name} — demande ${guardResult.requestId}`);
            return ok({
              ok: true,
              pendingApproval: true,
              requestId: guardResult.requestId,
              message: "Ce rôle donne ADMINISTRATOR : une demande d'approbation a été envoyée au propriétaire du serveur / rôles sécurité.",
            });
          }
        }

        await target.roles.add(discordRole).catch((e) => {
          throw new Error(`Impossible d'ajouter le rôle : ${e instanceof Error ? e.message : String(e)}`);
        });

        await audit(key_name, 'Ajout rôle MCP', `Membre: ${resolved.label}`, `Rôle: ${discordRole.name}`);

        return ok({ ok: true, userId: resolved.userId, roleName: discordRole.name, roleId: discordRole.id });
      })
    );

    server.registerTool(
      'remove_role',
      {
        description: "Retire un rôle Discord d'un membre. Requiert la permission WRITE_MEMBERS.",
        inputSchema: {
          member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre'),
          role: z.string().describe('Nom ou ID du rôle à retirer'),
          key_name: z.string().optional().describe("Nom de la clé MCP (pour l'audit)"),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, role, key_name }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        const target = await guild.members.fetch(resolved.userId).catch(() => null);
        if (!target) return err('Membre introuvable sur le serveur Discord');

        const roleId = SNOWFLAKE.test(role) ? role : null;
        const discordRole = roleId
          ? guild.roles.cache.get(roleId)
          : guild.roles.cache.find((r) => r.name.toLowerCase() === role.toLowerCase());

        if (!discordRole) return err(`Rôle « ${role} » introuvable`);

        if (!target.roles.cache.has(discordRole.id)) {
          return err(`${resolved.label} n'a pas le rôle ${discordRole.name}`);
        }

        await target.roles.remove(discordRole).catch((e) => {
          throw new Error(`Impossible de retirer le rôle : ${e instanceof Error ? e.message : String(e)}`);
        });

        await audit(key_name, 'Retrait rôle MCP', `Membre: ${resolved.label}`, `Rôle: ${discordRole.name}`);

        return ok({ ok: true, userId: resolved.userId, roleName: discordRole.name, roleId: discordRole.id });
      })
    );

    server.registerTool(
      'get_member_level',
      {
        description: "Récupère le niveau et l'XP d'un membre dans le système de leveling.",
        inputSchema: {
          member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre'),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        const level = await prisma.memberLevel.findUnique({
          where: { guildId_userId: { guildId, userId: resolved.userId } },
        });

        if (!level) return err('Aucune donnée de niveau pour ce membre.');

        const rewards = await prisma.levelRoleReward.findMany({
          where: { guildId, level: { lte: level.level } },
          orderBy: { level: 'asc' },
        });

        return ok({
          userId: resolved.userId,
          name: resolved.label,
          level: level.level,
          xp: level.xp,
          lastXpGain: level.lastXpGain?.toISOString() ?? null,
          unlockedRewards: rewards.map((r) => ({ level: r.level, roleId: r.roleId })),
        });
      })
    );

    server.registerTool(
      'get_invite_stats',
      {
        description: "Statistiques d'invitations d'un membre (nombre d'invités, codes utilisés).",
        inputSchema: {
          member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre'),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        const [invites, invited] = await Promise.all([
          prisma.guildInvite.findMany({
            where: { guildId, inviterId: resolved.userId },
            select: { code: true, uses: true, createdAt: true },
          }),
          prisma.memberInvite.findMany({
            where: { guildId, inviterId: resolved.userId },
            select: { userId: true, joinedAt: true, leftAt: true },
          }),
        ]);

        const active = invited.filter((i) => !i.leftAt).length;
        const left = invited.filter((i) => i.leftAt).length;

        return ok({
          userId: resolved.userId,
          name: resolved.label,
          totalInvited: invited.length,
          activeInvited: active,
          leftInvited: left,
          inviteCodes: invites.map((i) => ({
            code: i.code,
            usedCount: i.uses,
            createdAt: i.createdAt.toISOString(),
          })),
        });
      })
    );
  }

  // ── WRITE_MEMBERS — Double-compte (Alt account linking) ──────────────────
  if (shouldRegister('WRITE_MEMBERS')) {
    // link_accounts — Lier deux comptes comme doubles comptes
    server.registerTool(
      'link_accounts',
      {
        description: "Lie deux membres Discord en tant que doubles comptes (main / alt). Requiert WRITE_MEMBERS.",
        inputSchema: {
          member1: z.string().describe('Nom, surnom, @mention ou ID Discord du premier compte'),
          member2: z.string().describe('Nom, surnom, @mention ou ID Discord du deuxième compte'),
          reason: z.string().optional().describe('Raison de la liaison (recommandé)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member1, member2, reason, key_name }) => {
        const r1 = await resolveMember(guildId, member1);
        if (!r1.ok) return r1.response;
        const r2 = await resolveMember(guildId, member2);
        if (!r2.ok) return r2.response;

        if (r1.userId === r2.userId) {
          return err('Impossible de lier un compte à lui-même.');
        }

        try {
          // Vérifier que les deux membres existent bien en base
          const [p1, p2] = await Promise.all([
            prisma.memberProfile.findFirst({ where: { guildId, userId: r1.userId }, select: { userId: true } }),
            prisma.memberProfile.findFirst({ where: { guildId, userId: r2.userId }, select: { userId: true } }),
          ]);

          if (!p1) return err(`Membre introuvable en base : ${r1.label} (${r1.userId}). Le membre n'a peut-être jamais rejoint le serveur.`);
          if (!p2) return err(`Membre introuvable en base : ${r2.label} (${r2.userId}). Le membre n'a peut-être jamais rejoint le serveur.`);

          const link = await linkAccounts({
            guildId,
            user1Id: r1.userId,
            user2Id: r2.userId,
            type: LinkedAccountType.MANUAL,
            status: LinkedAccountStatus.VALIDATED,
            reason: reason || `Liaison manuelle via MCP par ${key_name ?? 'agent'}`,
            linkedByUserId: 'mcp_agent',
            metadata: { linkedBy: key_name ?? 'mcp_agent', at: new Date().toISOString() },
          });

          if (!link) {
            return err(`La liaison n'a pas pu être créée (IDs identiques après normalisation ? ${r1.userId} / ${r2.userId})`);
          }

          await audit(key_name, 'Liaison comptes MCP', `${r1.label} ↔ ${r2.label}`, `IDs: ${r1.userId} / ${r2.userId}`);
          return ok({ ok: true, linkId: link.id, user1Id: r1.userId, user1Label: r1.label, user2Id: r2.userId, user2Label: r2.label });
        } catch (e) {
          return err(`Erreur lors de la liaison : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // get_linked_accounts — Lister les comptes liés à un membre
    server.registerTool(
      'get_linked_accounts',
      {
        description: "Liste tous les comptes liés (doubles comptes) d'un membre. Requiert WRITE_MEMBERS.",
        inputSchema: {
          member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre'),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        try {
          const linkedIds = await getAllLinkedUserIds(guildId, resolved.userId);
          const others = linkedIds.filter(id => id !== resolved.userId);

          if (others.length === 0) {
            return ok({ userId: resolved.userId, label: resolved.label, linkedAccounts: [] });
          }

          // Enrichir avec les profils
          const profiles = await prisma.memberProfile.findMany({
            where: { guildId, userId: { in: others } },
            select: { userId: true, username: true, displayName: true },
          });
          const profileMap = new Map(profiles.map(p => [p.userId, p]));

          return ok({
            userId: resolved.userId,
            label: resolved.label,
            linkedAccounts: others.map(id => ({
              userId: id,
              username: profileMap.get(id)?.username ?? null,
              displayName: profileMap.get(id)?.displayName ?? null,
            })),
          });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // unlink_accounts — Supprimer le lien entre deux comptes
    server.registerTool(
      'unlink_accounts',
      {
        description: "Supprime le lien entre deux comptes doubles. Requiert WRITE_MEMBERS.",
        inputSchema: {
          member1: z.string().describe('Nom, surnom, @mention ou ID Discord du premier compte'),
          member2: z.string().describe('Nom, surnom, @mention ou ID Discord du deuxième compte'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member1, member2, key_name }) => {
        const r1 = await resolveMember(guildId, member1);
        if (!r1.ok) return r1.response;
        const r2 = await resolveMember(guildId, member2);
        if (!r2.ok) return r2.response;

        try {
          const result = await unlinkAccounts(guildId, r1.userId, r2.userId);

          if (result.count === 0) {
            return err(`Aucun lien trouvé entre ${r1.label} et ${r2.label}.`);
          }

          await audit(key_name, 'Suppression liaison MCP', `${r1.label} ↔ ${r2.label}`, `IDs: ${r1.userId} / ${r2.userId}`);
          return ok({ ok: true, removed: result.count, user1: r1.userId, user2: r2.userId });
        } catch (e) {
          return err(`Erreur lors de la suppression du lien : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
  }

  // ── WRITE_MEMBERS — Leadership / planning staff ──────────────────────────
  if (shouldRegister('WRITE_MEMBERS')) {
    server.registerTool(
      'create_staff_absence',
      {
        description: 'Crée une absence staff.',
        inputSchema: {
          staff_member: z.string().describe('Membre staff absent'),
          superior_member: z.string().describe('Supérieur qui traite l’absence'),
          start_date: z.string().describe('Date de début ISO'),
          end_date: z.string().optional().describe('Date de fin ISO'),
          reason: z.string().describe('Motif'),
          type: z.string().describe('Type d’absence'),
          message: z.string().optional().describe('Message complémentaire'),
          notify_on_mention: z.boolean().optional().describe('Notifier lors des mentions'),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ staff_member, superior_member, start_date, end_date, reason, type, message, notify_on_mention }) => {
        const staff = await resolveStaffMemberRecord(guildId, client, staff_member);
        if (!staff.ok) return staff.response;
        const superior = await resolveStaffMemberRecord(guildId, client, superior_member);
        if (!superior.ok) return superior.response;

        const startDate = new Date(start_date);
        const parsedEndDate = end_date ? new Date(end_date) : undefined;
        if (Number.isNaN(startDate.getTime()) || (parsedEndDate && Number.isNaN(parsedEndDate.getTime()))) {
          return err('Dates invalides');
        }

        try {
          const absence = await createAbsence({
            guildId,
            staffMemberId: staff.staffMember.id,
            startDate,
            endDate: parsedEndDate,
            reason,
            type,
            message,
            superiorUserId: superior.staffMember.userId,
            notifyOnMention: notify_on_mention,
          });
          return ok({ ok: true, absence });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_staff_absence_status',
      {
        description: 'Met à jour le statut d’une absence staff.',
        inputSchema: {
          absence_id: z.string().describe('ID de l’absence'),
          status: z.enum(['ACKNOWLEDGED', 'APPROVED', 'REJECTED', 'CANCELED', 'ENDED']),
          note: z.string().optional().describe('Note de décision'),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ absence_id, status, note }) => {
        try {
          const absence = await updateAbsenceStatus(guildId, absence_id, status, 'mcp_agent', note);
          return ok({ ok: true, absence });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_staff_absence',
      {
        description: 'Supprime une absence staff.',
        inputSchema: { absence_id: z.string().describe('ID de l’absence') },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ absence_id }) => {
        try {
          await deleteAbsence(guildId, absence_id);
          return ok({ ok: true, absenceId: absence_id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'create_staff_meeting',
      {
        description: 'Crée une réunion staff.',
        inputSchema: {
          creator_member: z.string().describe('Membre staff créateur'),
          title: z.string().describe('Titre de la réunion'),
          description: z.string().optional().describe('Description'),
          scheduled_at: z.string().describe('Date de réunion ISO'),
          ended_at: z.string().optional().describe('Date de fin ISO'),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ creator_member, title, description, scheduled_at, ended_at }) => {
        const creator = await resolveStaffMemberRecord(guildId, client, creator_member);
        if (!creator.ok) return creator.response;

        const scheduledAt = new Date(scheduled_at);
        const parsedEndedAt = ended_at ? new Date(ended_at) : undefined;
        if (Number.isNaN(scheduledAt.getTime()) || (parsedEndedAt && Number.isNaN(parsedEndedAt.getTime()))) {
          return err('Dates de réunion invalides');
        }

        try {
          const meeting = await createMeeting(client, guildId, creator.staffMember.userId, title, description ?? '', scheduledAt, parsedEndedAt);
          return ok({ ok: true, meeting });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_staff_meeting',
      {
        description: 'Met à jour une réunion staff.',
        inputSchema: {
          meeting_id: z.string().describe('ID de la réunion'),
          title: z.string().optional(),
          description: z.string().optional(),
          scheduled_at: z.string().optional(),
          ended_at: z.string().optional(),
          status: z.enum(['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELED']).optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ meeting_id, title, description, scheduled_at, ended_at, status }) => {
        try {
          const data: { title?: string; description?: string; scheduledAt?: Date; endedAt?: Date; status?: 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELED' } = {};
          if (title !== undefined) data.title = title;
          if (description !== undefined) data.description = description;
          if (scheduled_at !== undefined) data.scheduledAt = new Date(scheduled_at);
          if (ended_at !== undefined) data.endedAt = new Date(ended_at);
          if (status !== undefined) data.status = status;
          const meeting = await updateMeeting(client, guildId, meeting_id, data);
          return ok({ ok: true, meeting });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_staff_meeting',
      {
        description: 'Supprime une réunion staff.',
        inputSchema: {
          meeting_id: z.string().describe('ID de la réunion'),
          delete_event: z.boolean().optional(),
          delete_message: z.boolean().optional(),
          delete_notifications: z.boolean().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ meeting_id, delete_event, delete_message, delete_notifications }) => {
        try {
          await deleteMeeting(client, guildId, meeting_id, {
            deleteEvent: delete_event ?? false,
            deleteMessage: delete_message ?? false,
            deleteNotifications: delete_notifications ?? false,
          });
          return ok({ ok: true, meetingId: meeting_id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'mark_staff_notification_read',
      {
        description: 'Marque une notification staff comme lue.',
        inputSchema: {
          member: z.string().describe('Membre concerné'),
          notification_id: z.string().describe('ID de la notification'),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, notification_id }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        try {
          await markNotificationRead(notification_id, resolved.userId);
          return ok({ ok: true, notificationId: notification_id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'mark_all_staff_notifications_read',
      {
        description: 'Marque toutes les notifications staff comme lues.',
        inputSchema: { member: z.string().describe('Membre concerné') },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        try {
          await markAllNotificationsRead(guildId, resolved.userId);
          return ok({ ok: true, userId: resolved.userId });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'create_staff_poll',
      {
        description: 'Crée un sondage staff.',
        inputSchema: {
          creator_member: z.string().describe('Créateur staff'),
          title: z.string().describe('Titre'),
          description: z.string().optional(),
          options: z.array(z.string()).min(2).describe('Options de vote'),
          closes_at: z.string().optional().describe('Date de clôture ISO'),
          is_anonymous: z.boolean().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ creator_member, title, description, options, closes_at, is_anonymous }) => {
        const creator = await resolveStaffMemberRecord(guildId, client, creator_member);
        if (!creator.ok) return creator.response;

        try {
          const poll = await createPoll(
            guildId,
            creator.staffMember.id,
            title.trim(),
            description?.trim() || '',
            options.map((option: string) => option.trim()).filter(Boolean),
            is_anonymous ?? true,
            closes_at ? new Date(closes_at) : undefined
          );
          return ok({ ok: true, poll });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'vote_staff_poll',
      {
        description: 'Vote sur un sondage staff.',
        inputSchema: {
          member: z.string().describe('Votant'),
          poll_id: z.string().describe('ID du sondage'),
          option_id: z.string().describe('ID de l’option'),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, poll_id, option_id }) => {
        const voter = await resolveStaffMemberRecord(guildId, client, member);
        if (!voter.ok) return voter.response;

        try {
          const vote = await castPollVote(poll_id, voter.staffMember.id, option_id);
          return ok({ ok: true, vote });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'close_staff_poll',
      {
        description: 'Ferme un sondage staff.',
        inputSchema: { poll_id: z.string().describe('ID du sondage') },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ poll_id }) => {
        try {
          const result = await prisma.staffPoll.updateMany({ where: { id: poll_id, guildId }, data: { status: 'CLOSED' } });
          if (result.count === 0) return err('Sondage introuvable');
          return ok({ ok: true, pollId: poll_id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'create_staff_task',
      {
        description: 'Crée une tâche staff.',
        inputSchema: {
          creator_member: z.string().describe('Créateur staff'),
          assignee: z.string().describe('Assigné'),
          title: z.string().describe('Titre'),
          description: z.string().optional(),
          priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
          due_date: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ creator_member, assignee, title, description, priority, due_date }) => {
        const creator = await resolveStaffMemberRecord(guildId, client, creator_member);
        if (!creator.ok) return creator.response;
        const assigneeMember = await resolveStaffMemberRecord(guildId, client, assignee);
        if (!assigneeMember.ok) return assigneeMember.response;

        try {
          const task = await createTask(
            guildId,
            creator.staffMember.userId,
            title.trim(),
            description?.trim() || null,
            priority,
            due_date ? new Date(due_date) : null,
            assigneeMember.staffMember.id
          );
          return ok({ ok: true, task });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_staff_task',
      {
        description: 'Met à jour une tâche staff.',
        inputSchema: {
          task_id: z.string().describe('ID de la tâche'),
          title: z.string().optional(),
          description: z.string().nullable().optional(),
          status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED']).optional(),
          priority: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
          due_date: z.string().nullable().optional(),
          assignee: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ task_id, title, description, status, priority, due_date, assignee }) => {
        try {
          const updateData: { title?: string; description?: string | null; status?: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED'; priority?: 'LOW' | 'MEDIUM' | 'HIGH'; dueDate?: Date | null; assigneeId?: string } = {};
          if (title !== undefined) updateData.title = title;
          if (description !== undefined) updateData.description = description;
          if (status !== undefined) updateData.status = status;
          if (priority !== undefined) updateData.priority = priority;
          if (due_date !== undefined) updateData.dueDate = due_date ? new Date(due_date) : null;
          if (assignee !== undefined) {
            const assigneeMember = await resolveStaffMemberRecord(guildId, client, assignee);
            if (!assigneeMember.ok) return assigneeMember.response;
            updateData.assigneeId = assigneeMember.staffMember.id;
          }
          const task = await updateTask(task_id, updateData);
          return ok({ ok: true, task });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_staff_task',
      {
        description: 'Supprime une tâche staff.',
        inputSchema: { task_id: z.string().describe('ID de la tâche') },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ task_id }) => {
        try {
          await deleteTask(task_id);
          return ok({ ok: true, taskId: task_id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'create_staff_call',
      {
        description: 'Crée un appel staff.',
        inputSchema: {
          creator_member: z.string().describe('Créateur staff'),
          title: z.string().describe('Titre'),
          scheduled_at: z.string().describe('Date ISO'),
          description: z.string().optional(),
          channel_mode: z.string().default('CREATE_NEW'),
          channel_type: z.string().optional(),
          discord_channel_id: z.string().optional(),
          is_temp_channel: z.boolean().optional(),
          invitees: z.array(z.string()).optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ creator_member, title, description, scheduled_at, channel_mode, channel_type, discord_channel_id, is_temp_channel, invitees }) => {
        const creator = await resolveStaffMemberRecord(guildId, client, creator_member);
        if (!creator.ok) return creator.response;

        const scheduledAt = new Date(scheduled_at);
        if (Number.isNaN(scheduledAt.getTime())) return err('Date d’appel invalide');

        try {
          const call = await createCall(
            client,
            guildId,
            creator.staffMember.userId,
            title.trim(),
            description?.trim() || null,
            scheduledAt,
            channel_mode,
            channel_type || null,
            discord_channel_id || null,
            is_temp_channel !== false,
            invitees || []
          );
          return ok({ ok: true, call });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_staff_call',
      {
        description: 'Met à jour un appel staff.',
        inputSchema: {
          call_id: z.string().describe('ID de l’appel'),
          title: z.string().optional(),
          description: z.string().nullable().optional(),
          scheduled_at: z.string().optional(),
          ended_at: z.string().optional(),
          status: z.enum(['SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELED']).optional(),
          invitees: z.array(z.string()).optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ call_id, title, description, scheduled_at, ended_at, status, invitees }) => {
        try {
          const data: { title?: string; description?: string | null; scheduledAt?: Date; endedAt?: Date; status?: 'SCHEDULED' | 'ACTIVE' | 'COMPLETED' | 'CANCELED'; invitees?: string[] } = {};
          if (title !== undefined) data.title = title;
          if (description !== undefined) data.description = description;
          if (scheduled_at !== undefined) data.scheduledAt = new Date(scheduled_at);
          if (ended_at !== undefined) data.endedAt = new Date(ended_at);
          if (status !== undefined) data.status = status;
          if (invitees !== undefined) data.invitees = invitees;
          const call = await updateCall(client, guildId, call_id, data);
          return ok({ ok: true, call });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_staff_call',
      {
        description: 'Supprime un appel staff.',
        inputSchema: { call_id: z.string().describe('ID de l’appel') },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ call_id }) => {
        try {
          await deleteCall(client, guildId, call_id);
          return ok({ ok: true, callId: call_id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_call_permissions',
      {
        description: 'Met à jour la configuration des permissions d’appel staff.',
        inputSchema: {
          mode: z.enum(['EVERYONE', 'RESTRICTED']),
          allowed_role_ids: z.array(z.string()).default([]),
          allowed_user_ids: z.array(z.string()).default([]),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ mode, allowed_role_ids, allowed_user_ids }) => {
        try {
          const config = await updateCallPermissionConfig(guildId, {
            mode,
            allowedRoleIds: allowed_role_ids,
            allowedUserIds: allowed_user_ids,
          });
          return ok({ ok: true, config });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'create_staff_role',
      {
        description: 'Crée un rôle staff.',
        inputSchema: {
          name: z.string(),
          level: z.number().int(),
          discord_role_id: z.string().optional(),
          color: z.string().optional(),
          hierarchy_id: z.string().optional(),
          is_responsable: z.boolean().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ name, level, discord_role_id, color, hierarchy_id, is_responsable }) => {
        try {
          const role = await createStaffRole(guildId, name, level, discord_role_id, color, hierarchy_id, is_responsable);
          return ok({ ok: true, role });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_staff_role',
      {
        description: 'Met à jour un rôle staff.',
        inputSchema: {
          role_id: z.string(),
          name: z.string().optional(),
          level: z.number().int().optional(),
          discord_role_id: z.string().nullable().optional(),
          color: z.string().nullable().optional(),
          hierarchy_id: z.string().nullable().optional(),
          is_responsable: z.boolean().optional(),
          sort_order: z.number().int().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ role_id, ...body }) => {
        try {
          const role = await updateStaffRole(guildId, role_id, body);
          if (!role) return err('Rôle staff introuvable');
          return ok({ ok: true, role });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'reorder_staff_roles',
      {
        description: 'Réordonne les rôles staff.',
        inputSchema: { ordered_role_ids: z.array(z.string()).min(1) },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ ordered_role_ids }) => {
        try {
          await reorderStaffRoles(guildId, ordered_role_ids);
          return ok({ ok: true, count: ordered_role_ids.length });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_staff_role',
      {
        description: 'Supprime un rôle staff.',
        inputSchema: { role_id: z.string() },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ role_id }) => {
        try {
          const deleted = await deleteStaffRole(guildId, role_id);
          if (!deleted) return err('Rôle staff introuvable');
          return ok({ ok: true, role: deleted });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'create_staff_hierarchy',
      {
        description: 'Crée une hiérarchie staff.',
        inputSchema: {
          name: z.string(),
          description: z.string().optional(),
          color: z.string().optional(),
          icon: z.string().optional(),
          discord_role_id: z.string().optional(),
          responsable_user_id: z.string().optional(),
          parent_hierarchy_id: z.string().nullable().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ name, description, color, icon, discord_role_id, responsable_user_id, parent_hierarchy_id }) => {
        try {
          const hierarchy = await createStaffHierarchy(guildId, name, description, color, icon, discord_role_id, responsable_user_id, parent_hierarchy_id ?? null);
          return ok({ ok: true, hierarchy });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_staff_hierarchy',
      {
        description: 'Met à jour une hiérarchie staff.',
        inputSchema: {
          hierarchy_id: z.string(),
          name: z.string().optional(),
          description: z.string().nullable().optional(),
          color: z.string().nullable().optional(),
          icon: z.string().nullable().optional(),
          discord_role_id: z.string().nullable().optional(),
          responsable_user_id: z.string().nullable().optional(),
          parent_hierarchy_id: z.string().nullable().optional(),
          enabled: z.boolean().optional(),
          sort_order: z.number().int().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ hierarchy_id, ...body }) => {
        try {
          const hierarchy = await updateStaffHierarchy(guildId, hierarchy_id, body);
          if (!hierarchy) return err('Hiérarchie introuvable');
          return ok({ ok: true, hierarchy });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_staff_hierarchy',
      {
        description: 'Supprime une hiérarchie staff.',
        inputSchema: { hierarchy_id: z.string() },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ hierarchy_id }) => {
        try {
          const deleted = await deleteStaffHierarchy(guildId, hierarchy_id);
          if (!deleted) return err('Hiérarchie introuvable');
          return ok({ ok: true, hierarchy: deleted });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'add_staff_member_to_hierarchy',
      {
        description: 'Ajoute ou met à jour le grade d’un membre dans une hiérarchie staff.',
        inputSchema: {
          member: z.string(),
          hierarchy_id: z.string().optional(),
          grade: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, hierarchy_id, grade }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        try {
          const result = await addMemberToHierarchy(guildId, resolved.userId, hierarchy_id ?? null, grade ?? null);
          return ok({ ok: true, result });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'remove_staff_member_from_hierarchy',
      {
        description: 'Retire un membre d’une hiérarchie staff.',
        inputSchema: {
          member: z.string(),
          hierarchy_id: z.string(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, hierarchy_id }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;
        try {
          const result = await removeMemberFromHierarchy(guildId, resolved.userId, hierarchy_id);
          return ok({ ok: true, result });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'import_staff_role_members',
      {
        description: 'Importe les membres d’un rôle Discord dans une hiérarchie staff.',
        inputSchema: {
          hierarchy_id: z.string(),
          discord_role_id: z.string(),
          grade: z.string(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ hierarchy_id, discord_role_id, grade }) => {
        try {
          const result = await importRoleMembers(guildId, hierarchy_id, discord_role_id, grade);
          return ok({ ok: true, result });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'sync_staff_hierarchies',
      {
        description: 'Synchronise les appartenances hiérarchiques staff depuis les rôles Discord.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async () => {
        try {
          const result = await syncStaffHierarchyMemberships(guildId);
          return ok({ ok: true, result });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'create_staff_api_key',
      {
        description: 'Crée une clé API staff.',
        inputSchema: {
          creator_member: z.string(),
          name: z.string().optional(),
          permissions: z.array(z.string()).optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ creator_member, name, permissions }) => {
        const creator = await resolveStaffMemberRecord(guildId, client, creator_member);
        if (!creator.ok) return creator.response;

        try {
          const { fullKey, displayKey } = generateAPIKey();
          const keyHash = hashAPIKey(fullKey);
          const apiKey = await createAPIKey(
            guildId,
            creator.staffMember.userId,
            keyHash,
            displayKey,
            name ?? 'Mon clé API',
            permissions ?? ['daily_algo:create_exercise']
          );
          return ok({ ok: true, apiKey, fullKey });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_staff_api_key',
      {
        description: 'Désactive une clé API staff.',
        inputSchema: { key_id: z.string() },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ key_id }) => {
        try {
          const key = await deleteAPIKey(key_id);
          return ok({ ok: true, key });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'create_manager_note',
      {
        description: 'Crée une note manager sur un membre staff.',
        inputSchema: {
          member: z.string(),
          creator_member: z.string(),
          content: z.string().describe('Contenu de la note'),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, creator_member, content }) => {
        const target = await resolveMember(guildId, member);
        if (!target.ok) return target.response;
        const creator = await resolveMember(guildId, creator_member);
        if (!creator.ok) return creator.response;

        try {
          const note = await createManagerNote(guildId, target.userId, creator.userId, content);
          return ok({ ok: true, note });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_manager_note',
      {
        description: 'Supprime une note manager.',
        inputSchema: { note_id: z.string() },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ note_id }) => {
        try {
          await deleteManagerNote(note_id);
          return ok({ ok: true, noteId: note_id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
  }

  // ── WRITE_COMMUNITY (NEW) ──────────────────────────────────────────────────
  if (shouldRegister('WRITE_COMMUNITY')) {
    // 1. create_custom_event
    server.registerTool(
      'create_custom_event',
      {
        description: 'Crée un événement personnalisé (base de données et optionnellement sur Discord avec annonce).',
        inputSchema: {
          title: z.string().describe("Titre de l'événement"),
          description: z.string().optional().describe("Description de l'événement"),
          start_time: z.string().describe("Date/heure de début (format ISO, ex: 2026-06-30T18:00:00Z)"),
          end_time: z.string().optional().describe("Date/heure de fin (format ISO)"),
          location: z.string().default('Discord').describe("Lieu de l'événement"),
          announcement_channel: z.string().optional().describe("Nom ou ID du salon d'annonce"),
          form_id: z.string().optional().describe("ID du formulaire d'inscription lié"),
          create_discord_event: z.boolean().default(true).describe("Créer un événement Discord officiel natif"),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ title, description, start_time, end_time, location, announcement_channel, form_id, create_discord_event, key_name }) => {
        let announceChId: string | undefined;
        if (announcement_channel) {
          const resolved = resolveChannel(guildId, client, announcement_channel);
          if (resolved.ok) announceChId = resolved.channel.id;
        }

        try {
          const event = await createCustomEvent(client, guildId, {
            title,
            description,
            announcementChannelId: announceChId,
            formId: form_id,
            startTime: start_time,
            endTime: end_time,
            createDiscordEvent: create_discord_event,
            location,
          });

          // Publier l'annonce s'il y a un salon
          if (event && announceChId) {
            const { publishCustomEventAnnouncement } = await import('../../services/features/eventService.js');
            await publishCustomEventAnnouncement(client, event.id).catch(() => null);
          }

          await audit(key_name, 'Création événement MCP', title, `Type: CUSTOM | Début: ${start_time}`);
          return ok({ ok: true, eventId: event?.id ?? null, title });
        } catch (e) {
          return err(`Erreur lors de la création de l'événement: ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 2. create_custom_form
    server.registerTool(
      'create_custom_form',
      {
        description: 'Crée un formulaire de A à Z avec questions structurées.',
        inputSchema: {
          name: z.string().describe('Nom du formulaire'),
          description: z.string().optional().describe('Description du formulaire'),
          is_recruitment: z.boolean().default(false).describe("Indique s'il s'agit d'un formulaire de recrutement"),
          requires_discord_auth: z.boolean().default(false).describe('Exiger une connexion Discord pour soumettre'),
          theme: z.record(z.unknown()).optional().describe('Thème visuel (couleurs, bannière, police…)'),
          custom_css: z.string().nullable().optional().describe('CSS personnalisé (sanitisé côté serveur)'),
          hierarchy_id: z.string().optional().describe("ID de la hiérarchie staff (ex: Modération, Animation) à associer si formulaire de recrutement : détermine le rôle attribué à l'embauche"),
          questions: z.array(z.object({
            id: z.string().optional().describe('Identifiant unique de la question (généré automatiquement si omis)'),
            label: z.string().describe('Intitulé de la question'),
            type: z.enum(['text', 'paragraph', 'select', 'checkbox', 'discord_connect']).default('text'),
            required: z.boolean().default(true),
            placeholder: z.string().optional(),
            options: z.array(z.string()).optional().describe("Options (obligatoire si type == 'select')"),
          })).default([]).describe('Liste des questions'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ name, description, is_recruitment, requires_discord_auth, theme, custom_css, hierarchy_id, questions, key_name }) => {
        try {
          if (hierarchy_id) {
            const hierarchy = await prisma.staffHierarchy.findFirst({ where: { id: hierarchy_id, guildId } });
            if (!hierarchy) return err('Hiérarchie introuvable pour ce serveur');
          }

          const mappedFields = questions.map((q: any, i: number) => ({
            id: q.id || q.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30) || `field_${i}`,
            label: q.label,
            type: q.type === 'text' ? 'short_text'
                : q.type === 'select' ? 'dropdown'
                : q.type === 'checkbox' ? 'checkboxes'
                : q.type === 'discord_connect' ? 'discord_connect'
                : 'paragraph',
            required: q.required ?? true,
            description: q.placeholder || undefined,
            options: q.options || undefined,
            sectionIndex: 0,
          }));

          const form = await createCustomForm(guildId, {
            name,
            description,
            isRecruitment: is_recruitment,
            requiresDiscordAuth: requires_discord_auth,
            theme: sanitizeFormTheme(theme),
            customCss: sanitizeCustomCss(custom_css),
            hierarchyId: hierarchy_id,
            structure: {
              title: name,
              description: description || undefined,
              fields: mappedFields,
            },
          });

          await audit(key_name, 'Création formulaire MCP', name, `Questions: ${questions.length}`);
          return ok({ ok: true, formId: form.id, name, fieldsCreated: mappedFields.length });
        } catch (e) {
          return err(`Erreur lors de la création du formulaire: ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 3. create_announcement
    server.registerTool(
      'create_announcement',
      {
        description: 'Envoie une annonce structurée sous forme d\'Embed Discord dans un salon.',
        inputSchema: {
          channel: z.string().describe('Salon cible (nom, mention ou ID)'),
          title: z.string().describe('Titre de l\'annonce'),
          description: z.string().describe('Contenu de l\'annonce (markdown autorisé)'),
          color: z.string().default('#5865F2').describe('Couleur hexadécimale de l\'embed (ex: #ff0000)'),
          mention: z.enum(['none', 'everyone', 'here', 'role']).default('none').describe('Mention à inclure'),
          role_mention: z.string().optional().describe('Nom ou ID du rôle à mentionner (si mention == "role")'),
          image_url: z.string().optional().describe('URL d\'une image à intégrer dans l\'embed'),
          thumbnail_url: z.string().optional().describe('URL d\'une miniature à intégrer dans l\'embed'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ channel, title, description, color, mention, role_mention, image_url, thumbnail_url, key_name }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        const embed = new EmbedBuilder()
          .setTitle(title)
          .setDescription(description)
          .setColor(color.startsWith('#') ? (color as any) : `#${color}`)
          .setTimestamp();

        if (image_url) embed.setImage(image_url);
        if (thumbnail_url) embed.setThumbnail(thumbnail_url);

        let content = '';
        if (mention === 'everyone') content = '@everyone';
        else if (mention === 'here') content = '@here';
        else if (mention === 'role' && role_mention) {
          const guild = client.guilds.cache.get(guildId);
          const role = guild?.roles.cache.find(r => r.id === role_mention || r.name.toLowerCase() === role_mention.toLowerCase());
          if (role) content = `<@&${role.id}>`;
        }

        try {
          const sent = await resolved.channel.send({ content, embeds: [embed] });
          if (resolved.channel.type === ChannelType.GuildAnnouncement) {
            await sent.crosspost().catch(() => null);
          }

          await audit(key_name, 'Annonce MCP', title, `Salon: #${resolved.channel.name}`);
          return ok({ ok: true, messageId: sent.id, channelId: resolved.channel.id });
        } catch (e) {
          return err(`Erreur lors de l'envoi de l'annonce : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 4. create_giveaway / create_giveway
    const giveawayInputSchema = {
      channel: z.string().describe('Salon cible'),
      prize: z.string().describe('Lot à gagner'),
      winner_count: z.number().int().min(1).default(1).describe('Nombre de gagnants'),
      duration_minutes: z.number().int().min(1).describe('Durée en minutes avant le tirage'),
      description: z.string().optional().describe('Description ou règles'),
      rpg_xp: z.number().int().default(0).describe('XP RPG offerte aux gagnants'),
      rpg_coins: z.number().int().default(0).describe('Pièces RPG offertes aux gagnants'),
      rpg_item_id: z.string().optional().describe('ID de l\'objet RPG offert aux gagnants'),
      key_name: z.string().optional(),
    };

    const giveawayHandler = guard('WRITE_COMMUNITY', async ({ channel, prize, winner_count, duration_minutes, description, rpg_xp, rpg_coins, rpg_item_id, key_name }) => {
      const resolved = resolveChannel(guildId, client, channel);
      if (!resolved.ok) return resolved.response;

      try {
        const giveaway = await createGiveaway(
          client,
          guildId,
          resolved.channel.id,
          prize,
          winner_count,
          duration_minutes,
          description,
          rpg_xp,
          rpg_coins,
          rpg_item_id || null
        );

        await audit(key_name, 'Création giveaway MCP', prize, `Salon: #${resolved.channel.name}`);
        return ok({ ok: true, giveawayId: giveaway.id, prize });
      } catch (e) {
        return err(`Erreur lors du lancement du giveaway : ${e instanceof Error ? e.message : String(e)}`);
      }
    });

    server.registerTool(
      'create_giveaway',
      {
        description: 'Lance un tirage au sort (giveaway) sur Discord.',
        inputSchema: giveawayInputSchema,
        _meta: toolMeta,
      },
      giveawayHandler
    );

    server.registerTool(
      'create_giveway',
      {
        description: 'Lance un tirage au sort (giveaway) sur Discord (alias).',
        inputSchema: giveawayInputSchema,
        _meta: toolMeta,
      },
      giveawayHandler
    );

    // 5. cancel_giveaway / reroll_giveaway
    server.registerTool(
      'cancel_giveaway',
      {
        description: 'Annule/Met fin à un giveaway actif sans tirer de gagnants ou en forçant le tirage immédiat.',
        inputSchema: {
          giveaway_id: z.string().describe('ID du giveaway'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ giveaway_id, key_name }) => {
        try {
          await endGiveaway(client, giveaway_id, guildId);
          await audit(key_name, 'Annulation giveaway MCP', giveaway_id, '');
          return ok({ ok: true, giveawayId: giveaway_id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'reroll_giveaway',
      {
        description: 'Tire un nouveau gagnant pour un giveaway déjà terminé.',
        inputSchema: {
          giveaway_id: z.string().describe('ID du giveaway'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ giveaway_id, key_name }) => {
        try {
          await rerollGiveaway(client, giveaway_id, guildId);
          await audit(key_name, 'Reroll giveaway MCP', giveaway_id, '');
          return ok({ ok: true, giveawayId: giveaway_id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 6. create_rpg_adventure / create_quest_definition
    server.registerTool(
      'create_quest_definition',
      {
        description: 'Crée une nouvelle définition de quête pour le système communautaire.',
        inputSchema: {
          name: z.string().describe('Nom de la quête'),
          description: z.string().describe('Description des objectifs'),
          type: z.enum(['SEND_MESSAGES', 'VOICE_MINUTES', 'REACT_MESSAGES', 'WIN_GAME', 'EARN_COINS', 'GIVE_REP', 'CREATE_THREADS', 'REPLY_MESSAGES']),
          frequency: z.enum(['DAILY', 'WEEKLY']),
          target: z.number().int().describe('Nombre de répétitions requises pour valider la quête'),
          reward_coins: z.number().int().default(0),
          reward_xp: z.number().int().default(0),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ name, description, type, frequency, target, reward_coins, reward_xp, key_name }) => {
        try {
          const quest = await prisma.questDefinition.create({
            data: {
              guildId,
              name,
              description,
              type,
              frequency,
              target,
              rewardCoins: reward_coins,
              rewardXp: reward_xp,
              enabled: true,
            }
          });

          await audit(key_name, 'Création quête MCP', name, `Target: ${target} | XP: ${reward_xp}`);
          return ok({ ok: true, questId: quest.id, name });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 7. create_auto_response
    server.registerTool(
      'create_auto_response',
      {
        description: 'Configure un déclencheur de réponse automatique (Auto-Response).',
        inputSchema: {
          trigger: z.string().describe('Le mot-clé ou la phrase déclencheuse'),
          response: z.string().describe('La réponse textuelle ou JSON embed à envoyer'),
          trigger_type: z.enum(['MESSAGE', 'FORM', 'TICKET']).default('MESSAGE'),
          match_type: z.enum(['EXACT', 'CONTAINS', 'REGEX']).default('CONTAINS'),
          role_to_add: z.string().optional().describe('ID du rôle à attribuer au déclenchement'),
          role_to_remove: z.string().optional().describe('ID du rôle à retirer au déclenchement'),
          delete_trigger: z.boolean().default(false).describe('Supprimer le message déclencheur (si MESSAGE)'),
          allowed_channels: z.array(z.string()).optional().describe('Liste des IDs de salons autorisés (vide = tous)'),
          banned_channels: z.array(z.string()).optional().describe('Liste des IDs de salons interdits'),
          allowed_roles: z.array(z.string()).optional().describe('Liste des IDs de rôles autorisés (vide = tous)'),
          banned_roles: z.array(z.string()).optional().describe('Liste des IDs de rôles interdits'),
          reactions: z.array(z.string()).optional().describe('Liste des émojis à ajouter en réaction'),
          actions: z.string().optional().describe('Actions complexes au format JSON (ex: { "sendDm": "...", "timeoutSeconds": 300 })'),
          close_ticket: z.boolean().default(false).describe('Fermer le ticket (si TICKET)'),
          reject_form: z.boolean().default(false).describe('Rejeter le formulaire (si FORM)'),
          form_id: z.string().optional().describe('ID du formulaire (si FORM)'),
          form_question_label: z.string().optional().describe('Label ou question du formulaire (si FORM)'),
          ticket_type_id: z.string().optional().describe('ID du type de ticket (si TICKET)'),
          ticket_question_label: z.string().optional().describe('Label ou question du ticket (si TICKET)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ trigger, response, trigger_type, match_type, role_to_add, role_to_remove, delete_trigger, allowed_channels, banned_channels, allowed_roles, banned_roles, reactions, actions, close_ticket, reject_form, form_id, form_question_label, ticket_type_id, ticket_question_label, key_name }) => {
        try {
          let parsedActions: any = null;
          if (actions) {
            try {
              parsedActions = JSON.parse(actions);
            } catch {
              return err('Le paramètre "actions" doit être une chaîne JSON valide.');
            }
          }

          const autoRes = await prisma.autoResponse.create({
            data: {
              guildId,
              trigger,
              response,
              triggerType: trigger_type,
              matchType: match_type,
              roleIdToAdd: role_to_add || null,
              roleIdToRemove: role_to_remove || null,
              deleteTrigger: delete_trigger,
              allowedChannelIds: allowed_channels || [],
              bannedChannelIds: banned_channels || [],
              allowedRoleIds: allowed_roles || [],
              bannedRoleIds: banned_roles || [],
              reactions: reactions || [],
              actions: parsedActions,
              closeTicket: close_ticket,
              rejectForm: reject_form,
              formId: form_id || null,
              formQuestionLabel: form_question_label || null,
              ticketTypeId: ticket_type_id || null,
              ticketQuestionLabel: ticket_question_label || null,
              enabled: true,
            }
          });

          await audit(key_name, 'Création AutoResponse MCP', trigger, `Type: ${trigger_type}`);
          return ok({ ok: true, autoResponseId: autoRes.id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 8. create_scheduled_task
    server.registerTool(
      'create_scheduled_task',
      {
        description: 'Crée une tâche planifiée automatique récurrente.',
        inputSchema: {
          name: z.string().describe('Nom de la tâche'),
          type: z.enum(['CHANNEL_RESET', 'SERVER_BACKUP', 'DATA_EXPORT']),
          cron: z.string().describe('Expression Cron standard (ex: "0 0 * * *" pour tous les minuits)'),
          target_id: z.string().optional().describe('ID Discord cible (ex: salon)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ name, type, cron, target_id, key_name }) => {
        try {
          const task = await prisma.scheduledTask.create({
            data: {
              guildId,
              name,
              type,
              cron,
              targetId: target_id || null,
              enabled: true,
            }
          });

          await audit(key_name, 'Création tâche planifiée MCP', name, `Cron: ${cron}`);
          return ok({ ok: true, taskId: task.id, name });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_custom_form',
      {
        description: 'Met à jour un formulaire personnalisé existant. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          form_id: z.string().describe('ID du formulaire à modifier'),
          name: z.string().optional().describe('Nouveau nom du formulaire'),
          description: z.string().optional().describe('Nouvelle description'),
          is_recruitment: z.boolean().optional().describe("Indique s'il s'agit d'un formulaire de recrutement"),
          is_active: z.boolean().optional().describe("Activer ou désactiver le formulaire"),
          requires_discord_auth: z.boolean().optional().describe('Exiger une connexion Discord pour soumettre'),
          theme: z.record(z.unknown()).nullable().optional().describe('Thème visuel (null pour effacer)'),
          custom_css: z.string().nullable().optional().describe('CSS personnalisé (null pour effacer)'),
          hierarchy_id: z.string().nullable().optional().describe("ID de la hiérarchie staff à associer (null pour dissocier) : détermine le rôle attribué à l'embauche pour ce formulaire de recrutement"),
          questions: z.array(z.object({
            id: z.string().optional().describe('Identifiant unique de la question (généré automatiquement si omis)'),
            label: z.string().describe('Intitulé de la question'),
            type: z.enum(['text', 'paragraph', 'select', 'checkbox', 'discord_connect']).default('text'),
            required: z.boolean().default(true),
            placeholder: z.string().optional(),
            options: z.array(z.string()).optional(),
          })).optional().describe('Nouvelle liste complète des questions (si fournie, remplace l\'ancienne)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ form_id, name, description, is_recruitment, is_active, requires_discord_auth, theme, custom_css, hierarchy_id, questions, key_name }) => {
        try {
          const existing = await prisma.customForm.findFirst({ where: { id: form_id, guildId } });
          if (!existing) return err('Formulaire introuvable');

          if (hierarchy_id) {
            const hierarchy = await prisma.staffHierarchy.findFirst({ where: { id: hierarchy_id, guildId } });
            if (!hierarchy) return err('Hiérarchie introuvable pour ce serveur');
          }

          const updateData: any = {};
          if (name !== undefined) updateData.name = name;
          if (description !== undefined) updateData.description = description;
          if (is_recruitment !== undefined) updateData.isRecruitment = is_recruitment;
          if (is_active !== undefined) updateData.isActive = is_active;
          if (requires_discord_auth !== undefined) updateData.requiresDiscordAuth = requires_discord_auth;
          if (hierarchy_id !== undefined) updateData.hierarchyId = hierarchy_id;
          if (theme !== undefined) {
            updateData.theme = theme === null
              ? Prisma.JsonNull
              : ((sanitizeFormTheme(theme) ?? Prisma.JsonNull) as Prisma.InputJsonValue);
          }
          if (custom_css !== undefined) updateData.customCss = sanitizeCustomCss(custom_css);

          if (questions !== undefined) {
            const mappedFields = questions.map((q: any, i: number) => ({
              id: q.id || q.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30) || `field_${i}`,
              label: q.label,
              type: q.type === 'text' ? 'short_text'
                  : q.type === 'select' ? 'dropdown'
                  : q.type === 'checkbox' ? 'checkboxes'
                  : q.type === 'discord_connect' ? 'discord_connect'
                  : 'paragraph',
              required: q.required ?? true,
              description: q.placeholder || undefined,
              options: q.options || undefined,
              sectionIndex: 0,
            }));
            updateData.structure = {
              title: name || (existing as any).name,
              description: description || (existing as any).description || undefined,
              fields: mappedFields,
            };
          }

          const prismaData: Record<string, unknown> = { ...updateData };
          if (updateData.structure) {
            prismaData.structure = updateData.structure as Prisma.InputJsonValue;
          }
          await prisma.customForm.updateMany({
            where: { id: form_id, guildId },
            data: prismaData,
          });
          await audit(key_name, 'Mise à jour formulaire MCP', name || (existing as any).name, `ID: ${form_id}`);
          return ok({ ok: true, formId: form_id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_custom_form',
      {
        description: 'Supprime un formulaire personnalisé. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          form_id: z.string().describe('ID du formulaire à supprimer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ form_id, key_name }) => {
        try {
          const existing = await prisma.customForm.findFirst({ where: { id: form_id, guildId } });
          if (!existing) return err('Formulaire introuvable');

          await deleteCustomForm(form_id, guildId);
          await audit(key_name, 'Suppression formulaire MCP', existing.name, `ID: ${form_id}`);
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_custom_event',
      {
        description: 'Met à jour un événement existant. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          event_id: z.string().describe('ID de l\'événement à modifier'),
          title: z.string().optional().describe('Nouveau titre'),
          description: z.string().optional().describe('Nouvelle description'),
          start_time: z.string().optional().describe('Nouvelle date/heure de début (format ISO)'),
          end_time: z.string().optional().describe('Nouvelle date/heure de fin (format ISO)'),
          location: z.string().optional().describe('Nouveau lieu ou lien de l\'événement'),
          announcement_channel: z.string().optional().describe('Nouveau salon d\'annonce'),
          form_id: z.string().optional().describe('Nouveau formulaire lié'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ event_id, title, description, start_time, end_time, location, announcement_channel, form_id, key_name }) => {
        try {
          const existing = await prisma.event.findFirst({ where: { id: event_id, guildId } });
          if (!existing) return err('Événement introuvable');

          const updateData: any = {};
          if (title !== undefined) updateData.title = title;
          if (description !== undefined) updateData.description = description;
          if (start_time !== undefined) updateData.startDate = new Date(start_time);
          if (end_time !== undefined) updateData.endDate = new Date(end_time);
          if (location !== undefined) updateData.location = location;
          if (announcement_channel !== undefined) {
            const resolvedAnn = resolveChannel(guildId, client, announcement_channel);
            if (resolvedAnn.ok) {
              updateData.announcementChannelId = resolvedAnn.channel.id;
            }
          }
          if (form_id !== undefined) updateData.formId = form_id || null;

          await prisma.event.update({
            where: { id: event_id },
            data: updateData,
          });

          await audit(key_name, 'Mise à jour événement MCP', title || existing.title, `ID: ${event_id}`);
          return ok({ ok: true, eventId: event_id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_event',
      {
        description: 'Supprime un événement du serveur. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          event_id: z.string().describe('ID de l\'événement à supprimer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ event_id, key_name }) => {
        try {
          const existing = await prisma.event.findFirst({ where: { id: event_id, guildId } });
          if (!existing) return err('Événement introuvable');

          await prisma.event.delete({ where: { id: event_id } });
          await audit(key_name, 'Suppression événement MCP', existing.title, `ID: ${event_id}`);
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_giveaway',
      {
        description: 'Met à jour un giveaway actif. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          giveaway_id: z.string().describe('ID du giveaway à modifier'),
          prize: z.string().optional().describe('Nouveau lot'),
          description: z.string().optional().describe('Nouvelle description'),
          duration_minutes: z.number().int().min(1).optional().describe('Ajuster le temps restant en minutes à partir de maintenant'),
          winner_count: z.number().int().min(1).optional().describe('Nombre de gagnants'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ giveaway_id, prize, description, duration_minutes, winner_count, key_name }) => {
        try {
          const existing = await prisma.giveaway.findFirst({ where: { id: giveaway_id, guildId } });
          if (!existing) return err('Giveaway introuvable');
          if (existing.ended) return err('Impossible de modifier un giveaway terminé');

          const updateData: any = {};
          if (prize !== undefined) updateData.prize = prize;
          if (description !== undefined) updateData.description = description;
          if (duration_minutes !== undefined) {
            const endsAt = new Date();
            endsAt.setMinutes(endsAt.getMinutes() + duration_minutes);
            updateData.endsAt = endsAt;
          }
          if (winner_count !== undefined) updateData.winnerCount = winner_count;

          await prisma.giveaway.update({
            where: { id: giveaway_id },
            data: updateData,
          });

          await audit(key_name, 'Mise à jour giveaway MCP', prize || existing.prize, `ID: ${giveaway_id}`);
          return ok({ ok: true, giveawayId: giveaway_id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_giveaway',
      {
        description: 'Supprime un giveaway. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          giveaway_id: z.string().describe('ID du giveaway à supprimer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ giveaway_id, key_name }) => {
        try {
          const existing = await prisma.giveaway.findFirst({ where: { id: giveaway_id, guildId } });
          if (!existing) return err('Giveaway introuvable');

          await prisma.giveaway.delete({ where: { id: giveaway_id } });
          await audit(key_name, 'Suppression giveaway MCP', existing.prize, `ID: ${giveaway_id}`);
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_quest_definition',
      {
        description: 'Met à jour une quête existante. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          quest_id: z.string().describe('ID de la quête à modifier'),
          name: z.string().optional(),
          description: z.string().optional(),
          type: z.enum(['SEND_MESSAGES', 'VOICE_MINUTES', 'REACT_MESSAGES', 'WIN_GAME', 'EARN_COINS', 'GIVE_REP', 'CREATE_THREADS', 'REPLY_MESSAGES']).optional(),
          frequency: z.enum(['DAILY', 'WEEKLY']).optional(),
          target: z.number().int().min(1).optional().describe('Objectif quantitatif'),
          reward_coins: z.number().int().optional(),
          reward_xp: z.number().int().optional(),
          enabled: z.boolean().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ quest_id, name, description, type, frequency, target, reward_coins, reward_xp, enabled, key_name }) => {
        try {
          const existing = await prisma.questDefinition.findFirst({ where: { id: quest_id, guildId } });
          if (!existing) return err('Quête introuvable');

          const updateData: any = {};
          if (name !== undefined) updateData.name = name;
          if (description !== undefined) updateData.description = description;
          if (type !== undefined) updateData.type = type;
          if (frequency !== undefined) updateData.frequency = frequency;
          if (target !== undefined) updateData.target = target;
          if (reward_coins !== undefined) updateData.rewardCoins = reward_coins;
          if (reward_xp !== undefined) updateData.rewardXp = reward_xp;
          if (enabled !== undefined) updateData.enabled = enabled;

          await prisma.questDefinition.update({
            where: { id: quest_id },
            data: updateData,
          });

          await audit(key_name, 'Mise à jour quête MCP', name || existing.name, `ID: ${quest_id}`);
          return ok({ ok: true, questId: quest_id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_quest_definition',
      {
        description: 'Supprime une définition de quête. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          quest_id: z.string().describe('ID de la quête à supprimer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ quest_id, key_name }) => {
        try {
          const existing = await prisma.questDefinition.findFirst({ where: { id: quest_id, guildId } });
          if (!existing) return err('Quête introuvable');

          await prisma.questDefinition.delete({ where: { id: quest_id } });
          await audit(key_name, 'Suppression quête MCP', existing.name, `ID: ${quest_id}`);
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_auto_response',
      {
        description: 'Met à jour un déclencheur de réponse automatique existant. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          auto_response_id: z.string().describe('ID de la réponse automatique à modifier'),
          trigger: z.string().optional(),
          response: z.string().optional(),
          trigger_type: z.enum(['MESSAGE', 'FORM', 'TICKET']).optional(),
          match_type: z.enum(['EXACT', 'CONTAINS', 'REGEX']).optional(),
          role_to_add: z.string().optional(),
          role_to_remove: z.string().optional(),
          delete_trigger: z.boolean().optional(),
          enabled: z.boolean().optional(),
          allowed_channels: z.array(z.string()).optional(),
          banned_channels: z.array(z.string()).optional(),
          allowed_roles: z.array(z.string()).optional(),
          banned_roles: z.array(z.string()).optional(),
          reactions: z.array(z.string()).optional().describe('Liste des émojis à ajouter en réaction'),
          actions: z.string().optional().describe('Actions complexes au format JSON'),
          close_ticket: z.boolean().optional().describe('Fermer le ticket (si TICKET)'),
          reject_form: z.boolean().optional().describe('Rejeter le formulaire (si FORM)'),
          form_id: z.string().optional().describe('ID du formulaire (si FORM)'),
          form_question_label: z.string().optional().describe('Label ou question du formulaire (si FORM)'),
          ticket_type_id: z.string().optional().describe('ID du type de ticket (si TICKET)'),
          ticket_question_label: z.string().optional().describe('Label ou question du ticket (si TICKET)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ auto_response_id, trigger, response, trigger_type, match_type, role_to_add, role_to_remove, delete_trigger, enabled, allowed_channels, banned_channels, allowed_roles, banned_roles, reactions, actions, close_ticket, reject_form, form_id, form_question_label, ticket_type_id, ticket_question_label, key_name }) => {
        try {
          const existing = await prisma.autoResponse.findFirst({ where: { id: auto_response_id, guildId } });
          if (!existing) return err('Réponse automatique introuvable');

          const updateData: any = {};
          if (trigger !== undefined) updateData.trigger = trigger;
          if (response !== undefined) updateData.response = response;
          if (trigger_type !== undefined) updateData.triggerType = trigger_type;
          if (match_type !== undefined) updateData.matchType = match_type;
          if (role_to_add !== undefined) updateData.roleIdToAdd = role_to_add || null;
          if (role_to_remove !== undefined) updateData.roleIdToRemove = role_to_remove || null;
          if (delete_trigger !== undefined) updateData.deleteTrigger = delete_trigger;
          if (enabled !== undefined) updateData.enabled = enabled;
          if (allowed_channels !== undefined) updateData.allowedChannelIds = allowed_channels;
          if (banned_channels !== undefined) updateData.bannedChannelIds = banned_channels;
          if (allowed_roles !== undefined) updateData.allowedRoleIds = allowed_roles;
          if (banned_roles !== undefined) updateData.bannedRoleIds = banned_roles;
          if (reactions !== undefined) updateData.reactions = reactions;
          if (close_ticket !== undefined) updateData.closeTicket = close_ticket;
          if (reject_form !== undefined) updateData.rejectForm = reject_form;
          if (form_id !== undefined) updateData.formId = form_id || null;
          if (form_question_label !== undefined) updateData.formQuestionLabel = form_question_label || null;
          if (ticket_type_id !== undefined) updateData.ticketTypeId = ticket_type_id || null;
          if (ticket_question_label !== undefined) updateData.ticketQuestionLabel = ticket_question_label || null;
          if (actions !== undefined) {
            if (actions === '') {
              updateData.actions = null;
            } else {
              try {
                updateData.actions = JSON.parse(actions);
              } catch {
                return err('Le paramètre "actions" doit être une chaîne JSON valide.');
              }
            }
          }

          await prisma.autoResponse.update({
            where: { id: auto_response_id },
            data: updateData,
          });

          await audit(key_name, 'Mise à jour AutoResponse MCP', trigger || existing.trigger, `ID: ${auto_response_id}`);
          return ok({ ok: true, autoResponseId: auto_response_id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_auto_response',
      {
        description: 'Supprime un déclencheur de réponse automatique. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          auto_response_id: z.string().describe('ID de la réponse automatique à supprimer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ auto_response_id, key_name }) => {
        try {
          const existing = await prisma.autoResponse.findFirst({ where: { id: auto_response_id, guildId } });
          if (!existing) return err('Réponse automatique introuvable');

          await prisma.autoResponse.delete({ where: { id: auto_response_id } });
          await audit(key_name, 'Suppression AutoResponse MCP', existing.trigger, `ID: ${auto_response_id}`);
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_scheduled_task',
      {
        description: 'Met à jour une tâche planifiée existante. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          task_id: z.string().describe('ID de la tâche à modifier'),
          name: z.string().optional(),
          type: z.enum(['CHANNEL_RESET', 'SERVER_BACKUP', 'DATA_EXPORT']).optional(),
          cron: z.string().optional().describe('Expression Cron standard'),
          target_id: z.string().optional().describe('ID Discord cible (ex: salon)'),
          enabled: z.boolean().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ task_id, name, type, cron, target_id, enabled, key_name }) => {
        try {
          const existing = await prisma.scheduledTask.findFirst({ where: { id: task_id, guildId } });
          if (!existing) return err('Tâche planifiée introuvable');

          const updateData: any = {};
          if (name !== undefined) updateData.name = name;
          if (type !== undefined) updateData.type = type;
          if (cron !== undefined) updateData.cron = cron;
          if (target_id !== undefined) updateData.targetId = target_id || null;
          if (enabled !== undefined) updateData.enabled = enabled;

          await prisma.scheduledTask.update({
            where: { id: task_id },
            data: updateData,
          });

          await audit(key_name, 'Mise à jour tâche planifiée MCP', name || existing.name, `ID: ${task_id}`);
          return ok({ ok: true, taskId: task_id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_scheduled_task',
      {
        description: 'Supprime une tâche planifiée. Requiert WRITE_COMMUNITY.',
        inputSchema: {
          task_id: z.string().describe('ID de la tâche à supprimer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_COMMUNITY', async ({ task_id, key_name }) => {
        try {
          const existing = await prisma.scheduledTask.findFirst({ where: { id: task_id, guildId } });
          if (!existing) return err('Tâche planifiée introuvable');

          await prisma.scheduledTask.delete({ where: { id: task_id } });
          await audit(key_name, 'Suppression tâche planifiée MCP', existing.name, `ID: ${task_id}`);
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
  }

  // ── WRITE_TICKETS (NEW) ────────────────────────────────────────────────────
  if (shouldRegister('WRITE_TICKETS')) {
    // 1. create_ticket
    server.registerTool(
      'create_ticket',
      {
        description: 'Crée un ticket d\'assistance privé pour un membre et y ajoute des membres optionnels.',
        inputSchema: {
          opener: z.string().describe('ID Discord, mention, ou nom du créateur/bénéficiaire du ticket'),
          reason: z.string().describe('Sujet court du ticket'),
          description: z.string().describe('Description détaillée du problème'),
          extra_members: z.array(z.string()).default([]).describe('Membres supplémentaires à ajouter au salon (ID, mention, username)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_TICKETS', async ({ opener, reason, description, extra_members, key_name }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        const resolvedOpener = await resolveMember(guildId, opener);
        if (!resolvedOpener.ok) return resolvedOpener.response;

        // Récupérer le membre Discord opener
        const openerMember = await guild.members.fetch(resolvedOpener.userId).catch(() => null);
        if (!openerMember) return err('Créateur du ticket introuvable sur Discord');

        // Récupérer la config du ticket
        const guildConfig = await prisma.guild.findUnique({
          where: { id: guildId },
          select: {
            ticketCategoryId: true,
            ticketLogChannelId: true,
            ticketStaffRoleId: true,
            ticketEmbedColor: true,
          }
        });

        // Configurer les permissions
        const permissionOverwrites: any[] = [
          {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel]
          },
          {
            id: resolvedOpener.userId,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.EmbedLinks,
              PermissionFlagsBits.AttachFiles
            ]
          }
        ];

        // Ajouter les membres supplémentaires
        const extraResolved: string[] = [];
        for (const rawMem of extra_members) {
          const resolved = await resolveMember(guildId, rawMem);
          if (resolved.ok) {
            permissionOverwrites.push({
              id: resolved.userId,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.EmbedLinks,
                PermissionFlagsBits.AttachFiles
              ]
            });
            extraResolved.push(resolved.label);
          }
        }

        // Ajouter le rôle staff si configuré
        const staffRoleId = guildConfig?.ticketStaffRoleId;
        if (staffRoleId) {
          permissionOverwrites.push({
            id: staffRoleId,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.EmbedLinks,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.ManageMessages
            ]
          });
        }

        try {
          const cleanedUsername = openerMember.user.username.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'membre';
          const chName = `ticket-${cleanedUsername}`;

          const ticketChannel = await guild.channels.create({
            name: chName,
            type: ChannelType.GuildText,
            parent: guildConfig?.ticketCategoryId || null,
            permissionOverwrites,
            reason: `Ticket créé via MCP pour ${openerMember.user.tag}`
          });

          // Créer le ticket en base de données
          const ticket = await prisma.ticket.create({
            data: {
              guildId,
              channelId: ticketChannel.id,
              userId: resolvedOpener.userId,
              username: openerMember.user.username,
              reason,
              description,
              status: 'OPEN'
            }
          });

          // Envoyer l'embed de bienvenue
          const welcomeEmbed = new EmbedBuilder()
            .setTitle(`🎫 Ticket d'Assistance · ${reason}`)
            .setDescription(`Bonjour <@${resolvedOpener.userId}> !\nUn membre du personnel va prendre en charge votre demande.\n\n**Description :**\n${description}\n\n${extraResolved.length > 0 ? `**Membres ajoutés :** ${extraResolved.map(m => `\`${m}\``).join(', ')}` : ''}`)
            .setColor(guildConfig?.ticketEmbedColor as any || 0x5865F2)
            .setTimestamp()
            .setFooter({ text: `Kotbo · Ticket ID: ${ticket.id}` });

          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`ticket:claim:${ticket.id}`).setLabel('Prendre en charge').setStyle(ButtonStyle.Primary).setEmoji('🛠️'),
            new ButtonBuilder().setCustomId(`ticket:info:${ticket.id}`).setLabel('Infos Membre').setStyle(ButtonStyle.Secondary).setEmoji('🔍'),
            new ButtonBuilder().setCustomId(`ticket:close:${ticket.id}`).setLabel('Fermer').setStyle(ButtonStyle.Danger).setEmoji('🔒')
          );

          await ticketChannel.send({
            content: `${staffRoleId ? `<@&${staffRoleId}> ` : ''}<@${resolvedOpener.userId}> 🔔 Bienvenue dans votre ticket d'assistance.`,
            embeds: [welcomeEmbed],
            components: [row]
          });

          await audit(key_name, 'Création ticket MCP', ticket.id, `Cible: ${openerMember.user.tag} | Salon: #${ticketChannel.name}`);
          return ok({ ok: true, ticketId: ticket.id, channelId: ticketChannel.id, channelName: ticketChannel.name });
        } catch (e) {
          return err(`Erreur lors de la création du ticket : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 2. get_ticket_system_config
    server.registerTool(
      'get_ticket_system_config',
      {
        description: 'Récupère la configuration globale du système de tickets sur le serveur.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('WRITE_TICKETS', async () => {
        const guild = await prisma.guild.findUnique({
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
            ticketAllowOverclaim: true,
            ticketInactivityEnabled: true,
            ticketInactivityHours: true,
          }
        });
        return ok(guild);
      })
    );

    // 3. update_ticket_system_config
    server.registerTool(
      'update_ticket_system_config',
      {
        description: 'Met à jour la configuration générale du système de tickets.',
        inputSchema: {
          category_id: z.string().optional().describe('Catégorie Discord où ranger les salons de tickets'),
          log_channel_id: z.string().optional().describe('Salon de logs des tickets'),
          staff_role_id: z.string().optional().describe('Rôle du staff par défaut pour gérer les tickets'),
          channel_id: z.string().optional().describe('Salon d\'ouverture des tickets (contenant le panel)'),
          mode: z.enum(['CHANNEL', 'DM', 'THREAD']).optional().describe('Mode de tickets (salon dédié, messages privés ou fil de discussion)'),
          embed_title: z.string().optional(),
          embed_desc: z.string().optional(),
          embed_button_text: z.string().optional(),
          embed_color: z.string().optional().describe('Couleur hexadécimale'),
          inactivity_enabled: z.boolean().optional(),
          inactivity_hours: z.number().int().min(1).optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_TICKETS', async ({ category_id, log_channel_id, staff_role_id, channel_id, mode, embed_title, embed_desc, embed_button_text, embed_color, inactivity_enabled, inactivity_hours, key_name }) => {
        try {
          await prisma.guild.update({
            where: { id: guildId },
            data: {
              ...(category_id !== undefined ? { ticketCategoryId: category_id || null } : {}),
              ...(log_channel_id !== undefined ? { ticketLogChannelId: log_channel_id || null } : {}),
              ...(staff_role_id !== undefined ? { ticketStaffRoleId: staff_role_id || null } : {}),
              ...(channel_id !== undefined ? { ticketChannelId: channel_id || null } : {}),
              ...(mode !== undefined ? { ticketMode: mode } : {}),
              ...(embed_title !== undefined ? { ticketEmbedTitle: embed_title } : {}),
              ...(embed_desc !== undefined ? { ticketEmbedDesc: embed_desc } : {}),
              ...(embed_button_text !== undefined ? { ticketEmbedButtonText: embed_button_text } : {}),
              ...(embed_color !== undefined ? { ticketEmbedColor: embed_color } : {}),
              ...(inactivity_enabled !== undefined ? { ticketInactivityEnabled: inactivity_enabled } : {}),
              ...(inactivity_hours !== undefined ? { ticketInactivityHours: inactivity_hours } : {}),
            }
          });

          await audit(key_name, 'Configuration tickets MCP', 'Mise à jour des paramètres globaux', '');
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur de mise à jour: ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 4. create_ticket_type
    server.registerTool(
      'create_ticket_type',
      {
        description: 'Ajoute un nouveau type/sujet de ticket pour le sélecteur d\'ouverture de tickets.',
        inputSchema: {
          id: z.string().describe('ID unique du type (ex: "recrut")'),
          label: z.string().describe('Nom du bouton/menu (ex: "Recrutement")'),
          description: z.string().describe('Courte description de ce type de ticket'),
          category_id: z.string().optional().describe('Catégorie spécifique pour ranger ce type de ticket'),
          staff_role_id: z.string().optional().describe('Rôle staff spécifique pour ce type de ticket'),
          emoji: z.string().optional().describe('Emoji du type'),
          fields: z.array(z.object({
            id: z.string().describe('ID unique de l\'input/question'),
            label: z.string().describe('Intitulé de la question'),
            placeholder: z.string().optional().describe('Texte d\'aide / placeholder'),
            style: z.enum(['SHORT', 'PARAGRAPH']).default('SHORT').describe('Type d\'input (SHORT ou PARAGRAPH)'),
            required: z.boolean().default(true),
            max_length: z.number().int().optional(),
            min_length: z.number().int().optional(),
          })).optional().describe('Champs personnalisés du formulaire modal (max 5 champs)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_TICKETS', async ({ id, label, description, category_id, staff_role_id, emoji, fields, key_name }) => {
        try {
          const guild = await prisma.guild.findUnique({ where: { id: guildId }, select: { ticketTypes: true } });
          const currentTypes: any[] = Array.isArray(guild?.ticketTypes) ? (guild.ticketTypes as any[]) : [];

          // Enlever si ID existe déjà pour mise à jour
          const filtered = currentTypes.filter(t => t.id !== id);
          filtered.push({
            id,
            label,
            description,
            categoryId: category_id || null,
            staffRoleId: staff_role_id || null,
            emoji: emoji || null,
            fields: fields || null,
          });

          await prisma.guild.update({
            where: { id: guildId },
            data: { ticketTypes: filtered }
          });

          await audit(key_name, 'Configuration tickets MCP', `Nouveau type de ticket: ${label}`, `ID: ${id}`);
          return ok({ ok: true, ticketTypes: filtered });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 5. setup_ticket_system_message
    server.registerTool(
      'setup_ticket_system_message',
      {
        description: 'Envoie l\'embed d\'ouverture officiel avec les boutons/sélecteurs dans le salon de support.',
        inputSchema: {
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_TICKETS', async ({ key_name }) => {
        try {
          const { sendTicketSetupEmbed } = await import('../../services/features/ticketService.js');
          await sendTicketSetupEmbed(client, guildId);

          await audit(key_name, 'Configuration tickets MCP', 'Embed d\'ouverture de tickets envoyé', '');
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur d'envoi du panel : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_ticket_type',
      {
        description: 'Supprime un type/sujet de ticket configuré. Requiert WRITE_TICKETS.',
        inputSchema: {
          id: z.string().describe('ID unique du type de ticket à supprimer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_TICKETS', async ({ id, key_name }) => {
        try {
          const guild = await prisma.guild.findUnique({ where: { id: guildId }, select: { ticketTypes: true } });
          const currentTypes: any[] = Array.isArray(guild?.ticketTypes) ? (guild.ticketTypes as any[]) : [];

          const filtered = currentTypes.filter(t => t.id !== id);

          await prisma.guild.update({
            where: { id: guildId },
            data: { ticketTypes: filtered }
          });

          await audit(key_name, 'Configuration tickets MCP', `Type de ticket supprimé: ${id}`, `ID: ${id}`);
          return ok({ ok: true, ticketTypes: filtered });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
  }

  // ── WRITE_MEMBERS (NEW) ────────────────────────────────────────────────────
  if (shouldRegister('WRITE_MEMBERS')) {
    // 1. rename_member
    server.registerTool(
      'rename_member',
      {
        description: 'Renomme (change le pseudo) d\'un membre sur le serveur Discord.',
        inputSchema: {
          member: z.string().describe('Nom, mention ou ID du membre'),
          nickname: z.string().describe('Le nouveau pseudo (vide pour réinitialiser)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, nickname, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        const guild = client.guilds.cache.get(guildId);
        const discordMember = await guild?.members.fetch(resolved.userId).catch(() => null);
        if (!discordMember) return err('Membre introuvable sur le serveur Discord');

        try {
          await discordMember.setNickname(nickname || null, `Renommé via MCP par l'IA`);
          await audit(key_name, 'Modification pseudo MCP', resolved.label, `Pseudo appliqué: "${nickname || '(pseudo réinitialisé)'}"`);
          return ok({ ok: true, userId: resolved.userId, nickname: nickname || null });
        } catch (e) {
          return err(`Impossible de renommer le membre : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 2. manage_member_roles
    server.registerTool(
      'manage_member_roles',
      {
        description: 'Attribue ou retire des rôles Discord en masse pour un membre.',
        inputSchema: {
          member: z.string().describe('Nom, mention ou ID du membre'),
          roles: z.array(z.string()).describe('Liste des rôles à attribuer ou retirer (nom ou ID)'),
          action: z.enum(['add', 'remove']).describe('Action à réaliser : ajouter ou retirer les rôles'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, roles, action, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        const guild = client.guilds.cache.get(guildId);
        const discordMember = await guild?.members.fetch(resolved.userId).catch(() => null);
        if (!discordMember) return err('Membre introuvable');

        const resolvedRoles = [];
        for (const rawRole of roles) {
          const rId = SNOWFLAKE.test(rawRole) ? rawRole : null;
          const role = rId ? guild?.roles.cache.get(rId) : guild?.roles.cache.find(r => r.name.toLowerCase() === rawRole.toLowerCase());
          if (role) resolvedRoles.push(role);
        }

        if (resolvedRoles.length === 0) return err('Aucun rôle valide trouvé');

        try {
          if (action === 'add') {
            if (!guild) return err('Serveur Discord introuvable');

            const allowedRoles: typeof resolvedRoles = [];
            const pendingRequestIds: string[] = [];
            for (const role of resolvedRoles) {
              if (roleGrantsAdministrator(role.permissions.bitfield)) {
                const guardResult = await guardAdminGrant({
                  client,
                  guild,
                  actorId: null,
                  requestedVia: 'MCP',
                  type: 'MEMBER_ROLE_GRANT',
                  permissionBits: role.permissions.bitfield,
                  targetRoleId: role.id,
                  targetRoleName: role.name,
                  targetMemberId: resolved.userId,
                  requestReason: `via MCP (clé: ${key_name ?? 'agent'})`,
                });
                if (guardResult.blocked) {
                  pendingRequestIds.push(guardResult.requestId);
                  continue;
                }
              }
              allowedRoles.push(role);
            }

            if (allowedRoles.length > 0) await discordMember.roles.add(allowedRoles);

            await audit(
              key_name,
              'Ajout rôles MCP',
              resolved.label,
              `Rôles ajoutés: ${allowedRoles.map(r => r.name).join(', ') || '(aucun)'}${pendingRequestIds.length > 0 ? ` | En attente d'approbation (Admin Lock): ${pendingRequestIds.length}` : ''}`
            );
            return ok({
              ok: true,
              userId: resolved.userId,
              roles: allowedRoles.map(r => ({ id: r.id, name: r.name })),
              ...(pendingRequestIds.length > 0
                ? { pendingApproval: { requestIds: pendingRequestIds, count: pendingRequestIds.length, message: "Certains rôles donnent ADMINISTRATOR : des demandes d'approbation ont été envoyées." } }
                : {}),
            });
          } else {
            await discordMember.roles.remove(resolvedRoles);
            await audit(key_name, 'Retrait rôles MCP', resolved.label, `Rôles modifiés: ${resolvedRoles.map(r => r.name).join(', ')}`);
            return ok({ ok: true, userId: resolved.userId, roles: resolvedRoles.map(r => ({ id: r.id, name: r.name })) });
          }
        } catch (e) {
          return err(`Erreur lors de l'assignation de rôles : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 3. promote_staff / demote_staff
    server.registerTool(
      'promote_staff',
      {
        description: 'Ajoute un membre au staff de Kotbo en BDD et attribue ses rôles de modération.',
        inputSchema: {
          member: z.string().describe('Nom, mention ou ID du membre'),
          grade: z.string().describe('Grade global (ex: "Modérateur", "Administrateur", "Direction")'),
          display_name: z.string().optional().describe('Nom d\'affichage dans l\'organigramme staff'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, grade, display_name, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        const guild = client.guilds.cache.get(guildId);
        const discordMember = await guild?.members.fetch(resolved.userId).catch(() => null);
        if (!discordMember) return err('Membre introuvable sur Discord');

        try {
          const staffRecord = await addStaffMember(
            guildId,
            resolved.userId,
            grade,
            discordMember.user.tag,
            discordMember.user.username,
            display_name || discordMember.displayName,
            discordMember.displayAvatarURL()
          );

          // Synchroniser les rôles Discord correspondants
          const { syncStaffDiscordRoles } = await import('../../services/staff/staffManagementService.js');
          await syncStaffDiscordRoles(guildId, resolved.userId, grade).catch(() => null);

          await audit(key_name, 'Promotion Staff MCP', resolved.label, `Grade appliqué: ${grade}`);
          return ok({ ok: true, userId: resolved.userId, grade, staffId: staffRecord?.id ?? null });
        } catch (e) {
          return err(`Erreur lors de la promotion staff : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'demote_staff',
      {
        description: 'Retire un membre du staff de Kotbo en BDD et retire ses rôles de modération.',
        inputSchema: {
          member: z.string().describe('Nom, mention ou ID du membre'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        try {
          // removeStaffMember retire deja les roles Discord du staff (role de
          // base, role de test et roles de grade) : rien a synchroniser ensuite.
          await removeStaffMember(guildId, resolved.userId);

          await audit(key_name, 'Destitution Staff MCP', resolved.label, 'Membre retiré du staff');
          return ok({ ok: true, userId: resolved.userId });
        } catch (e) {
          return err(`Erreur lors de la destitution staff : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'generate_staff_evaluation',
      {
        description: 'Génère une évaluation de performance pour un ou tous les membres staff. Requiert WRITE_MEMBERS.',
        inputSchema: {
          member: z.string().optional().describe('Membre staff cible (nom, mention ou ID). Omis = tous les staff.'),
          period_days: z.number().int().min(7).max(365).default(30).describe('Période analysée en jours'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, period_days, key_name }) => {
        try {
          if (member) {
            const resolved = await resolveMember(guildId, member);
            if (!resolved.ok) return resolved.response;
            const evaluation = await generateStaffEvaluation(guildId, resolved.userId, period_days);
            await audit(key_name, 'Évaluation staff MCP', resolved.label, `Score: ${evaluation.overallScore}`);
            return ok({ ok: true, evaluation });
          }
          const evaluations = await generateAllStaffEvaluations(guildId, period_days);
          await audit(key_name, 'Évaluations staff MCP (batch)', '', `${evaluations.length} évaluation(s)`);
          return ok({ ok: true, count: evaluations.length, evaluations });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_staff_evaluation_note',
      {
        description: 'Ajoute ou met à jour la note manager sur une évaluation staff. Requiert WRITE_MEMBERS.',
        inputSchema: {
          evaluation_id: z.string().describe('ID de l\'évaluation'),
          manager_note: z.string().describe('Note du manager'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ evaluation_id, manager_note, key_name }) => {
        try {
          const existing = await prisma.staffEvaluation.findFirst({ where: { id: evaluation_id, guildId } });
          if (!existing) return err('Évaluation introuvable');
          const updated = await updateEvaluationNote(evaluation_id, manager_note);
          await audit(key_name, 'Note évaluation staff MCP', evaluation_id, manager_note.slice(0, 200));
          return ok({ ok: true, evaluation: updated });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_call_permission_config',
      {
        description: 'Configure qui peut planifier des appels staff (EVERYONE ou RESTRICTED par rôles/membres). Requiert WRITE_MEMBERS.',
        inputSchema: {
          mode: z.enum(['EVERYONE', 'RESTRICTED']).describe('Mode de permission'),
          allowed_role_ids: z.array(z.string()).optional().describe('Rôles autorisés (mode RESTRICTED)'),
          allowed_user_ids: z.array(z.string()).optional().describe('Membres autorisés (mode RESTRICTED)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ mode, allowed_role_ids, allowed_user_ids, key_name }) => {
        try {
          const config = await updateCallPermissionConfig(guildId, {
            mode,
            allowedRoleIds: allowed_role_ids ?? [],
            allowedUserIds: allowed_user_ids ?? [],
          });
          await audit(key_name, 'Config permissions appels MCP', mode, `Rôles: ${config.allowedRoleIds.length}, Membres: ${config.allowedUserIds.length}`);
          return ok({ ok: true, config });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'activate_widget',
      {
        description: 'Active le widget Discord de profil staff pour un membre. Requiert WRITE_MEMBERS.',
        inputSchema: {
          member: z.string().describe('Membre staff (nom, mention ou ID)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        try {
          await prisma.widgetSubscription.upsert({
            where: { guildId_userId: { guildId, userId: resolved.userId } },
            update: { enabled: true },
            create: { guildId, userId: resolved.userId, enabled: true },
          });
          const result = await pushWidgetForUser(guildId, resolved.userId);
          await audit(key_name, 'Activation widget MCP', resolved.label, result.ok ? 'OK' : 'Échec push');
          return ok({ ok: true, userId: resolved.userId, pushResult: result });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'deactivate_widget',
      {
        description: 'Désactive le widget Discord de profil staff pour un membre. Requiert WRITE_MEMBERS.',
        inputSchema: {
          member: z.string().describe('Membre staff (nom, mention ou ID)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        try {
          await prisma.widgetSubscription.updateMany({
            where: { guildId, userId: resolved.userId },
            data: { enabled: false },
          });
          const result = await clearWidgetForUser(resolved.userId);
          await audit(key_name, 'Désactivation widget MCP', resolved.label, '');
          return ok({ ok: true, userId: resolved.userId, clearResult: result });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'refresh_widget',
      {
        description: 'Rafraîchit le widget Discord de profil staff pour un membre. Requiert WRITE_MEMBERS.',
        inputSchema: {
          member: z.string().describe('Membre staff (nom, mention ou ID)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        try {
          const result = await pushWidgetForUser(guildId, resolved.userId);
          await audit(key_name, 'Refresh widget MCP', resolved.label, result.ok ? 'OK' : 'Échec');
          return ok({ ok: true, userId: resolved.userId, pushResult: result });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'refresh_all_widgets',
      {
        description: 'Rafraîchit les widgets Discord de tous les staff abonnés actifs du serveur. Requiert WRITE_MEMBERS.',
        inputSchema: {
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ key_name }) => {
        try {
          const result = await refreshAllStaffWidgets(guildId);
          await audit(key_name, 'Refresh widgets MCP (global)', guildId, `${result.success ?? 0} succès`);
          return ok({ ok: true, ...result });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 4. get_nickname_moderation_config / update_nickname_moderation_config
    server.registerTool(
      'get_nickname_moderation_config',
      {
        description: 'Récupère les réglages de modération automatique de pseudos.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async () => {
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
          }
        });
        return ok(guild);
      })
    );

    server.registerTool(
      'update_nickname_moderation_config',
      {
        description: 'Met à jour la configuration de modération automatique de pseudos.',
        inputSchema: {
          enabled: z.boolean().optional(),
          on_join: z.boolean().optional(),
          on_update: z.boolean().optional(),
          check_invisible: z.boolean().optional(),
          check_global: z.boolean().optional(),
          check_custom: z.boolean().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ enabled, on_join, on_update, check_invisible, check_global, check_custom, key_name }) => {
        try {
          await prisma.guild.update({
            where: { id: guildId },
            data: {
              ...(enabled !== undefined ? { autoNicknameModerationEnabled: enabled } : {}),
              ...(on_join !== undefined ? { nickModOnJoin: on_join } : {}),
              ...(on_update !== undefined ? { nickModOnUpdate: on_update } : {}),
              ...(check_invisible !== undefined ? { nickModCheckInvisible: check_invisible } : {}),
              ...(check_global !== undefined ? { nickModCheckGlobal: check_global } : {}),
              ...(check_custom !== undefined ? { nickModCheckCustom: check_custom } : {}),
            }
          });

          await audit(key_name, 'Configuration pseudos MCP', 'Mise à jour des paramètres de modération de pseudos', '');
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 5. add_blocked_nickname_word / remove_blocked_nickname_word
    server.registerTool(
      'add_blocked_nickname_word',
      {
        description: 'Ajoute un mot interdit/regex dans la blacklist de pseudos du serveur.',
        inputSchema: {
          word: z.string().describe('Le mot ou le motif regex interdit'),
          category: z.string().default('custom').describe('Catégorie du mot (ex: racist, toxic, custom)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ word, category, key_name }) => {
        try {
          const bw = await prisma.bannedWord.create({
            data: {
              guildId,
              word,
              category,
              enabled: true
            }
          });

          await audit(key_name, 'Blacklist pseudos MCP', word, `Catégorie: ${category}`);
          return ok({ ok: true, wordId: bw.id, word });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'remove_blocked_nickname_word',
      {
        description: 'Supprime un mot de la blacklist de pseudos du serveur.',
        inputSchema: {
          word: z.string().describe('Le mot exact à enlever de la blacklist'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ word, key_name }) => {
        try {
          await prisma.bannedWord.deleteMany({
            where: { guildId, word }
          });

          await audit(key_name, 'Whitelist pseudos MCP', word, 'Retiré de la blacklist');
          return ok({ ok: true, word });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 6. run_nickname_rescan
    server.registerTool(
      'run_nickname_rescan',
      {
        description: 'Exécute un scan massif des pseudos des membres du serveur et renomme ceux non conformes.',
        inputSchema: {
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ key_name }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        try {
          const { scanAndModeratePseudos } = await import('../../services/moderation/nicknameModerationService.js');
          const scanRes = await scanAndModeratePseudos(guild);

          await audit(key_name, 'Rescan pseudos MCP', 'Scan manuel déclenché par l\'IA', `Scannés: ${scanRes.scannedCount} | Renommés: ${scanRes.renamedCount}`);
          return ok(scanRes);
        } catch (e) {
          return err(`Erreur rescan: ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 7. get_leveling_config / update_leveling_config
    server.registerTool(
      'get_leveling_config',
      {
        description: 'Récupère la configuration du système de progression et leveling (XP).',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async () => {
        const config = await prisma.levelConfig.findUnique({
          where: { guildId },
          select: {
            enabled: true,
            xpMin: true,
            xpMax: true,
            cooldownSeconds: true,
            vocalXpPerMin: true,
            levelUpChannelId: true,
            levelUpMessage: true,
            stackRewards: true,
            ignoredChannels: true,
            ignoredRoles: true,
          }
        });
        return ok(config);
      })
    );

    server.registerTool(
      'update_leveling_config',
      {
        description: 'Met à jour les paramètres de progression/gains d\'XP du serveur.',
        inputSchema: {
          enabled: z.boolean().optional(),
          xp_min: z.number().int().min(1).optional(),
          xp_max: z.number().int().min(1).optional(),
          cooldown: z.number().int().min(0).optional(),
          vocal_xp: z.number().int().min(0).optional(),
          announce_channel: z.string().optional().describe('ID salon, "DM", ou vide (même salon)'),
          announce_message: z.string().optional().describe('Message (ex: "Félicitations {user} ! Tu passes au niveau **{level}** ! 🎉")'),
          stack_rewards: z.boolean().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ enabled, xp_min, xp_max, cooldown, vocal_xp, announce_channel, announce_message, stack_rewards, key_name }) => {
        try {
          await prisma.levelConfig.update({
            where: { guildId },
            data: {
              ...(enabled !== undefined ? { enabled } : {}),
              ...(xp_min !== undefined ? { xpMin: xp_min } : {}),
              ...(xp_max !== undefined ? { xpMax: xp_max } : {}),
              ...(cooldown !== undefined ? { cooldownSeconds: cooldown } : {}),
              ...(vocal_xp !== undefined ? { vocalXpPerMin: vocal_xp } : {}),
              ...(announce_channel !== undefined ? { levelUpChannelId: announce_channel || null } : {}),
              ...(announce_message !== undefined ? { levelUpMessage: announce_message } : {}),
              ...(stack_rewards !== undefined ? { stackRewards: stack_rewards } : {}),
            }
          });

          await audit(key_name, 'Configuration progression MCP', 'Mise à jour de la config de progression', '');
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 8. create_level_role_reward / remove_level_role_reward
    server.registerTool(
      'create_level_role_reward',
      {
        description: 'Configure ou met à jour un rôle Discord offert à un niveau spécifique.',
        inputSchema: {
          level: z.number().int().min(1).describe('Niveau requis'),
          role: z.string().describe('Nom ou ID du rôle Discord'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ level, role, key_name }) => {
        const guild = client.guilds.cache.get(guildId);
        const rId = SNOWFLAKE.test(role) ? role : null;
        const discordRole = rId ? guild?.roles.cache.get(rId) : guild?.roles.cache.find(r => r.name.toLowerCase() === role.toLowerCase());
        if (!discordRole) return err(`Rôle "${role}" introuvable`);

        try {
          const reward = await prisma.levelRoleReward.upsert({
            where: { guildId_level: { guildId, level } },
            update: { roleId: discordRole.id },
            create: { guildId, level, roleId: discordRole.id }
          });

          await audit(key_name, 'Configuration progression MCP', `Récompense niveau ${level}`, `Rôle: ${discordRole.name}`);
          return ok({ ok: true, rewardId: reward.id, level, roleName: discordRole.name });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'remove_level_role_reward',
      {
        description: 'Supprime la récompense de rôle pour un niveau.',
        inputSchema: {
          level: z.number().int().min(1).describe('Niveau requis'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ level, key_name }) => {
        try {
          await prisma.levelRoleReward.deleteMany({
            where: { guildId, level }
          });

          await audit(key_name, 'Configuration progression MCP', `Suppression récompense niveau ${level}`, '');
          return ok({ ok: true, level });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 9. update_economy_config
    server.registerTool(
      'update_economy_config',
      {
        description: 'Configure le système d\'économie RPG de Kotbo.',
        inputSchema: {
          currency_name: z.string().optional().describe('Nom de la monnaie (ex: "Kotcoins")'),
          currency_emoji: z.string().optional().describe('Emoji de la monnaie'),
          daily_min: z.number().int().min(0).optional(),
          daily_max: z.number().int().min(0).optional(),
          max_energy: z.number().int().min(1).optional(),
          energy_recovery_per_hour: z.number().int().min(0).optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ currency_name, currency_emoji, daily_min, daily_max, max_energy, energy_recovery_per_hour, key_name }) => {
        try {
          await prisma.economyConfig.upsert({
            where: { guildId },
            update: {
              ...(currency_name !== undefined ? { currencyName: currency_name } : {}),
              ...(currency_emoji !== undefined ? { currencyEmoji: currency_emoji } : {}),
              ...(daily_min !== undefined ? { dailyRewardMin: daily_min } : {}),
              ...(daily_max !== undefined ? { dailyRewardMax: daily_max } : {}),
              ...(max_energy !== undefined ? { maxEnergy: max_energy } : {}),
              ...(energy_recovery_per_hour !== undefined ? { energyRecoveryPerHour: energy_recovery_per_hour } : {}),
            },
            create: {
              guildId,
              currencyName: currency_name || 'Pièces',
              currencyEmoji: currency_emoji || '🪙',
              dailyRewardMin: daily_min || 50,
              dailyRewardMax: daily_max || 150,
              maxEnergy: max_energy || 100,
              energyRecoveryPerHour: energy_recovery_per_hour || 10,
            }
          });

          await audit(key_name, 'Configuration économie MCP', 'Mise à jour des paramètres d\'économie', '');
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 10. create_rpg_shop_item
    server.registerTool(
      'create_rpg_shop_item',
      {
        description: 'Crée un nouvel objet dans la boutique RPG.',
        inputSchema: {
          id: z.string().describe('ID unique de l\'objet (ex: "iron_sword")'),
          name: z.string().describe('Nom de l\'objet'),
          description: z.string().describe('Description de ses effets'),
          type: z.enum(['WEAPON', 'ARMOR', 'POTION', 'USABLE', 'MATERIAL', 'QUEST']),
          price: z.number().int().min(0).describe('Prix d\'achat'),
          purchasable: z.boolean().default(true),
          atk_bonus: z.number().int().default(0),
          def_bonus: z.number().int().default(0),
          hp_restore: z.number().int().default(0),
          energy_restore: z.number().int().default(0),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, name, description, type, price, purchasable, atk_bonus, def_bonus, hp_restore, energy_restore, key_name }) => {
        try {
          const existing = await prisma.rpgItem.findUnique({
            where: { id }
          });

          if (existing && existing.guildId !== guildId) {
            return err("Cet objet existe déjà et appartient à un autre serveur ou est un objet global.");
          }

          const item = await prisma.rpgItem.upsert({
            where: { id },
            update: {
              name,
              description,
              type,
              price,
              purchasable,
              atkBonus: atk_bonus,
              defBonus: def_bonus,
              hpRestore: hp_restore,
              energyRestore: energy_restore,
            },
            create: {
              guildId,
              id,
              name,
              description,
              type,
              price,
              purchasable,
              atkBonus: atk_bonus,
              defBonus: def_bonus,
              hpRestore: hp_restore,
              energyRestore: energy_restore,
            }
          });

          await audit(key_name, 'Configuration économie MCP', `Nouvel objet boutique RPG : ${name}`, `Type: ${type} | Prix: ${price}`);
          return ok({ ok: true, itemId: item.id, name });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_rpg_shop_item',
      {
        description: 'Supprime un objet de la boutique RPG. Requiert WRITE_MEMBERS.',
        inputSchema: {
          id: z.string().describe('ID unique de l\'objet à supprimer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ id, key_name }) => {
        try {
          const { item, unequippedCount } = await adminDeleteShopItem(guildId, id);

          await audit(key_name, 'Configuration économie MCP', `Objet boutique RPG supprimé: ${item.name}`, `ID: ${id}${unequippedCount > 0 ? ` | Déséquipé de ${unequippedCount} profil(s)` : ''}`);
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'create_role',
      {
        description: 'Crée un nouveau rôle sur le serveur Discord. Requiert WRITE_MEMBERS.',
        inputSchema: {
          name: z.string().describe('Nom du rôle'),
          color: z.string().optional().describe('Couleur hexadécimale (ex: "#FF0000")'),
          hoist: z.boolean().optional().describe('Afficher les membres ayant ce rôle séparément des autres'),
          mentionable: z.boolean().optional().describe('Permettre à tout le monde de mentionner ce rôle'),
          permissions: z.array(z.string()).optional().describe('Liste de permissions Discord à accorder (ex: ["ManageGuild","KickMembers","BanMembers"])'),
          reason: z.string().optional().describe('Raison de la création (pour l\'audit Discord)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ name, color, hoist, mentionable, permissions, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          let permBits: bigint | undefined;
          if (permissions && permissions.length > 0) {
            permBits = 0n;
            for (const p of permissions) {
              const bit = (PermissionFlagsBits as any)[p];
              if (bit === undefined) return err(`Permission inconnue : « ${p} ». Exemples valides : ViewChannel, SendMessages, Administrator, ManageGuild…`);
              permBits |= bit;
            }
          }

          if (permBits !== undefined && roleGrantsAdministrator(permBits)) {
            const guardResult = await guardAdminGrant({
              client,
              guild,
              actorId: null,
              requestedVia: 'MCP',
              type: 'ROLE_CREATE',
              permissionBits: permBits,
              targetRoleName: name,
              pendingRoleCreatePayload: {
                name,
                color: color || undefined,
                hoist: hoist ?? false,
                mentionable: mentionable ?? false,
                reason: reason || 'Créé via MCP (approuvé)',
              },
              requestReason: `via MCP (clé: ${key_name ?? 'agent'})`,
            });
            if (guardResult.blocked) {
              await audit(key_name, 'Création rôle MCP — bloquée (Admin Lock)', name, `Demande ${guardResult.requestId}`);
              return ok({
                ok: true,
                pendingApproval: true,
                requestId: guardResult.requestId,
                message: "Ce rôle inclut ADMINISTRATOR : une demande d'approbation a été envoyée, le rôle ne sera créé qu'après validation.",
              });
            }
          }

          const role = await guild.roles.create({
            name,
            color: color || undefined,
            hoist: hoist ?? false,
            mentionable: mentionable ?? false,
            permissions: permBits !== undefined ? permBits : undefined,
            reason: reason || 'Créé via MCP',
          });

          await audit(key_name, 'Création rôle MCP', name, `ID: ${role.id}`);
          return ok({ ok: true, roleId: role.id, name: role.name });
        } catch (e) {
          return err(`Erreur lors de la création du rôle : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_role',
      {
        description: 'Met à jour les propriétés d\'un rôle existant sur le serveur Discord. Requiert WRITE_MEMBERS.',
        inputSchema: {
          role: z.string().describe('Nom ou ID du rôle à modifier'),
          name: z.string().optional().describe('Nouveau nom du rôle'),
          color: z.string().optional().describe('Nouvelle couleur hexadécimale (ex: "#00FF00")'),
          hoist: z.boolean().optional().describe('Afficher les membres ayant ce rôle séparément'),
          mentionable: z.boolean().optional().describe('Rendre le rôle mentionnable'),
          reason: z.string().optional().describe('Raison de la modification'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ role, name, color, hoist, mentionable, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const roleId = SNOWFLAKE.test(role) ? role : null;
          const discordRole = roleId
            ? guild.roles.cache.get(roleId)
            : guild.roles.cache.find((r) => r.name.toLowerCase() === role.toLowerCase());

          if (!discordRole) return err(`Rôle « ${role} » introuvable`);

          const updated = await discordRole.edit({
            name: name !== undefined ? name : undefined,
            color: color !== undefined ? color : undefined,
            hoist: hoist !== undefined ? hoist : undefined,
            mentionable: mentionable !== undefined ? mentionable : undefined,
            reason: reason || 'Modifié via MCP',
          });

          await audit(key_name, 'Mise à jour rôle MCP', discordRole.name, `ID: ${discordRole.id}`);
          return ok({ ok: true, roleId: discordRole.id, name: updated.name });
        } catch (e) {
          return err(`Erreur lors de la modification du rôle : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_role',
      {
        description: 'Supprime un rôle existant sur le serveur Discord. Requiert WRITE_MEMBERS.',
        inputSchema: {
          role: z.string().describe('Nom ou ID du rôle à supprimer'),
          reason: z.string().optional().describe('Raison de la suppression'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ role, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const roleId = SNOWFLAKE.test(role) ? role : null;
          const discordRole = roleId
            ? guild.roles.cache.get(roleId)
            : guild.roles.cache.find((r) => r.name.toLowerCase() === role.toLowerCase());

          if (!discordRole) return err(`Rôle « ${role} » introuvable`);

          await discordRole.delete(reason || 'Supprimé via MCP');

          await audit(key_name, 'Suppression rôle MCP', discordRole.name, `ID: ${discordRole.id}`);
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur lors de la suppression du rôle : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

  }

  // ── READ_STATS — Permissions, invitations, emojis, stickers, webhooks, réglages ──
  if (shouldRegister('READ_STATS')) {

    server.registerTool(
      'get_role_permissions',
      {
        description: 'Retourne la liste des permissions globales d\'un rôle. Requiert READ_STATS.',
        inputSchema: {
          role: z.string().describe('Nom ou ID du rôle'),
        },
        _meta: toolMeta,
      },
      guard('READ_STATS', async ({ role }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        const roleId = SNOWFLAKE.test(role) ? role : null;
        const discordRole = roleId
          ? guild.roles.cache.get(roleId)
          : guild.roles.cache.find((r) => r.name.toLowerCase() === role.toLowerCase());

        if (!discordRole) return err(`Rôle « ${role} » introuvable`);

        const permNames = Object.entries(PermissionFlagsBits)
          .filter(([, bit]) => discordRole.permissions.has(bit))
          .map(([name]) => name);

        return ok({
          roleId: discordRole.id,
          name: discordRole.name,
          bitfield: discordRole.permissions.bitfield.toString(),
          permissions: permNames,
        });
      })
    );

    server.registerTool(
      'get_invites',
      {
        description: 'Liste les invitations actives du serveur. Requiert READ_STATS.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STATS', async () => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const invites = await guild.invites.fetch();
          return ok(
            invites.map((inv) => ({
              code: inv.code,
              url: inv.url,
              channelId: inv.channel?.id ?? null,
              channelName: inv.channel?.name ?? null,
              inviterId: inv.inviter?.id ?? null,
              inviterTag: inv.inviter?.tag ?? null,
              uses: inv.uses,
              maxUses: inv.maxUses,
              maxAge: inv.maxAge,
              temporary: inv.temporary,
              createdAt: inv.createdAt?.toISOString() ?? null,
              expiresAt: inv.expiresAt?.toISOString() ?? null,
            }))
          );
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_emojis',
      {
        description: 'Liste les emojis personnalisés du serveur. Requiert READ_STATS.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STATS', async () => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        const emojis = await guild.emojis.fetch();
        return ok(
          emojis.map((e) => ({
            id: e.id,
            name: e.name,
            animated: e.animated,
            url: e.url,
            creatorId: e.author?.id ?? null,
          }))
        );
      })
    );

    server.registerTool(
      'get_stickers',
      {
        description: 'Liste les stickers personnalisés du serveur. Requiert READ_STATS.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STATS', async () => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        const stickers = await guild.stickers.fetch();
        return ok(
          stickers.map((s) => ({
            id: s.id,
            name: s.name,
            description: s.description,
            tags: s.tags,
            format: s.format,
            url: s.url,
          }))
        );
      })
    );

    server.registerTool(
      'get_webhooks',
      {
        description: 'Liste les webhooks du serveur ou d\'un salon spécifique. Requiert READ_STATS.',
        inputSchema: {
          channel: z.string().optional().describe('Nom, mention <#id> ou ID du salon (optionnel — si omis, liste tous les webhooks du serveur)'),
        },
        _meta: toolMeta,
      },
      guard('READ_STATS', async ({ channel }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          let webhooks;
          if (channel) {
            const resolved = resolveChannel(guildId, client, channel);
            if (!resolved.ok) return resolved.response;
            webhooks = await resolved.channel.fetchWebhooks();
          } else {
            webhooks = await guild.fetchWebhooks();
          }

          return ok(
            webhooks.map((w) => ({
              id: w.id,
              name: w.name,
              channelId: w.channelId,
              creatorId: w.owner?.id ?? null,
              creatorTag: w.owner && 'tag' in w.owner ? w.owner.tag : (w.owner?.username ?? null),
              url: w.url,
              avatar: w.avatarURL(),
            }))
          );
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_guild_settings',
      {
        description: 'Retourne les réglages globaux du serveur Discord (icône, bannière, vérification, AFK, vanity URL, etc.). Requiert READ_STATS.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_STATS', async () => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        return ok({
          name: guild.name,
          icon: guild.iconURL({ size: 512 }),
          banner: guild.bannerURL({ size: 512 }),
          splash: guild.splashURL({ size: 512 }),
          verificationLevel: guild.verificationLevel,
          defaultMessageNotifications: guild.defaultMessageNotifications,
          explicitContentFilter: guild.explicitContentFilter,
          afkChannelId: guild.afkChannelId,
          afkChannelName: guild.afkChannel?.name ?? null,
          afkTimeout: guild.afkTimeout,
          systemChannelId: guild.systemChannelId,
          systemChannelName: guild.systemChannel?.name ?? null,
          rulesChannelId: guild.rulesChannelId,
          rulesChannelName: guild.rulesChannel?.name ?? null,
          vanityURLCode: guild.vanityURLCode,
          preferredLocale: guild.preferredLocale,
          premiumTier: guild.premiumTier,
          premiumSubscriptionCount: guild.premiumSubscriptionCount,
          description: guild.description,
          features: guild.features,
        });
      })
    );
  }

  // ── READ_MEMBERS — Vocal, messages épinglés, threads ──────────────────
  if (shouldRegister('READ_MEMBERS')) {

    server.registerTool(
      'get_voice_state',
      {
        description: 'Retourne l\'état vocal d\'un membre (salon, mute, deafen, stream, caméra). Requiert READ_MEMBERS.',
        inputSchema: {
          member: z.string().describe('Nom, @mention ou ID du membre'),
        },
        _meta: toolMeta,
      },
      guard('READ_MEMBERS', async ({ member }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        const rm = await resolveMember(guildId, member);
        if (!rm.ok) return rm.response;

        const guildMember = await guild.members.fetch(rm.userId).catch(() => null);
        if (!guildMember) return err(`Membre « ${member} » introuvable sur le serveur`);

        const vs = guildMember.voice;
        if (!vs.channel) return ok({ connected: false, userId: rm.userId });

        return ok({
          connected: true,
          userId: rm.userId,
          channelId: vs.channel.id,
          channelName: vs.channel.name,
          serverMute: vs.serverMute,
          serverDeaf: vs.serverDeaf,
          selfMute: vs.selfMute,
          selfDeaf: vs.selfDeaf,
          streaming: vs.streaming,
          selfVideo: vs.selfVideo,
        });
      })
    );

    server.registerTool(
      'get_pinned_messages',
      {
        description: 'Liste les messages épinglés d\'un salon. Requiert READ_MEMBERS.',
        inputSchema: {
          channel: z.string().describe('Nom, mention <#id> ou ID du salon'),
        },
        _meta: toolMeta,
      },
      guard('READ_MEMBERS', async ({ channel }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        try {
          const pins = await resolved.channel.messages.fetchPinned();
          return ok(
            pins.map((m) => ({
              id: m.id,
              authorId: m.author.id,
              authorTag: m.author.tag,
              content: m.content.slice(0, 500),
              createdAt: m.createdAt.toISOString(),
              embeds: m.embeds.length,
              attachments: m.attachments.size,
            }))
          );
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'get_threads',
      {
        description: 'Liste les threads actifs et archivés d\'un salon. Requiert READ_MEMBERS.',
        inputSchema: {
          channel: z.string().describe('Nom, mention <#id> ou ID du salon parent'),
          include_archived: z.boolean().default(false).describe('Inclure les threads archivés'),
        },
        _meta: toolMeta,
      },
      guard('READ_MEMBERS', async ({ channel, include_archived }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        try {
          const active = await resolved.channel.threads.fetchActive();
          const threads = [...active.threads.values()].map((t) => ({
            id: t.id,
            name: t.name,
            archived: t.archived,
            locked: t.locked,
            memberCount: t.memberCount,
            messageCount: t.messageCount,
            createdAt: t.createdAt?.toISOString() ?? null,
            autoArchiveDuration: t.autoArchiveDuration,
          }));

          if (include_archived) {
            const archived = await resolved.channel.threads.fetchArchived();
            for (const t of archived.threads.values()) {
              threads.push({
                id: t.id,
                name: t.name,
                archived: t.archived,
                locked: t.locked,
                memberCount: t.memberCount,
                messageCount: t.messageCount,
                createdAt: t.createdAt?.toISOString() ?? null,
                autoArchiveDuration: t.autoArchiveDuration,
              });
            }
          }

          return ok(threads);
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
  }

  // ── WRITE_MEMBERS — Permissions rôle, vocal, invitations, emojis, stickers, webhooks, serveur ──
  if (shouldRegister('WRITE_MEMBERS')) {

    server.registerTool(
      'update_role_permissions',
      {
        description: 'Ajoute ou retire des permissions globales sur un rôle existant. Requiert WRITE_MEMBERS.',
        inputSchema: {
          role: z.string().describe('Nom ou ID du rôle à modifier'),
          allow: z.array(z.string()).default([]).describe('Permissions à ajouter (ex: ["ManageGuild","KickMembers"])'),
          deny: z.array(z.string()).default([]).describe('Permissions à retirer (ex: ["BanMembers"])'),
          reason: z.string().optional().describe('Raison de la modification'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ role, allow, deny, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const roleId = SNOWFLAKE.test(role) ? role : null;
          const discordRole = roleId
            ? guild.roles.cache.get(roleId)
            : guild.roles.cache.find((r) => r.name.toLowerCase() === role.toLowerCase());

          if (!discordRole) return err(`Rôle « ${role} » introuvable`);

          let bits = discordRole.permissions.bitfield;
          for (const p of allow) {
            const bit = (PermissionFlagsBits as Record<string, bigint>)[p];
            if (bit === undefined) return err(`Permission inconnue : « ${p} »`);
            bits |= bit;
          }
          for (const p of deny) {
            const bit = (PermissionFlagsBits as Record<string, bigint>)[p];
            if (bit === undefined) return err(`Permission inconnue : « ${p} »`);
            bits &= ~bit;
          }

          if (roleGrantsAdministrator(bits) && !roleGrantsAdministrator(discordRole.permissions.bitfield)) {
            const guardResult = await guardAdminGrant({
              client,
              guild,
              actorId: null,
              requestedVia: 'MCP',
              type: 'ROLE_PERMISSION_EDIT',
              permissionBits: bits,
              targetRoleId: discordRole.id,
              targetRoleName: discordRole.name,
              requestReason: `via MCP (clé: ${key_name ?? 'agent'})`,
            });
            if (guardResult.blocked) {
              await audit(key_name, 'Permissions rôle MCP — bloquées (Admin Lock)', discordRole.name, `Demande ${guardResult.requestId}`);
              return ok({
                ok: true,
                pendingApproval: true,
                requestId: guardResult.requestId,
                message: "Cette modification accorderait ADMINISTRATOR : une demande d'approbation a été envoyée.",
              });
            }
          }

          await discordRole.setPermissions(bits, reason || 'Permissions modifiées via MCP');

          const newPerms = Object.entries(PermissionFlagsBits)
            .filter(([, bit]) => discordRole.permissions.has(bit))
            .map(([name]) => name);

          await audit(key_name, 'Permissions rôle MCP', discordRole.name, `allow: [${allow}] | deny: [${deny}]`);
          return ok({ ok: true, roleId: discordRole.id, name: discordRole.name, permissions: newPerms });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // ── Contrôle vocal ──────────────────────────────────────────────────────

    server.registerTool(
      'move_member_voice',
      {
        description: 'Déplace un membre vers un autre salon vocal. Requiert WRITE_MEMBERS.',
        inputSchema: {
          member: z.string().describe('Nom, @mention ou ID du membre'),
          channel: z.string().describe('Nom ou ID du salon vocal de destination'),
          reason: z.string().optional().describe('Raison du déplacement'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, channel, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const rm = await resolveMember(guildId, member);
          if (!rm.ok) return rm.response;

          const guildMember = await guild.members.fetch(rm.userId).catch(() => null);
          if (!guildMember) return err(`Membre « ${member} » introuvable`);
          if (!guildMember.voice.channel) return err(`Le membre n'est pas connecté en vocal`);

          const chId = SNOWFLAKE.test(channel) ? channel : null;
          const targetChannel = chId
            ? guild.channels.cache.get(chId)
            : guild.channels.cache.find((c) => c.name.toLowerCase() === channel.toLowerCase() && c.isVoiceBased());

          if (!targetChannel || !targetChannel.isVoiceBased()) return err(`Salon vocal « ${channel} » introuvable`);

          await guildMember.voice.setChannel(targetChannel, reason || 'Déplacé via MCP');

          await audit(key_name, 'Déplacement vocal MCP', rm.label, `Vers #${targetChannel.name}`);
          return ok({ ok: true, userId: rm.userId, channelId: targetChannel.id, channelName: targetChannel.name });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'set_member_voice_mute',
      {
        description: 'Mute ou démute un membre côté serveur en vocal. Requiert WRITE_MEMBERS.',
        inputSchema: {
          member: z.string().describe('Nom, @mention ou ID du membre'),
          muted: z.boolean().describe('true pour mute, false pour démute'),
          reason: z.string().optional().describe('Raison'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, muted, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const rm = await resolveMember(guildId, member);
          if (!rm.ok) return rm.response;

          const guildMember = await guild.members.fetch(rm.userId).catch(() => null);
          if (!guildMember) return err(`Membre « ${member} » introuvable`);
          if (!guildMember.voice.channel) return err(`Le membre n'est pas connecté en vocal`);

          await guildMember.voice.setMute(muted, reason || 'Via MCP');

          await audit(key_name, muted ? 'Mute vocal MCP' : 'Démute vocal MCP', rm.label, '');
          return ok({ ok: true, userId: rm.userId, muted });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'set_member_voice_deafen',
      {
        description: 'Rend sourd ou annule la surdité serveur d\'un membre en vocal. Requiert WRITE_MEMBERS.',
        inputSchema: {
          member: z.string().describe('Nom, @mention ou ID du membre'),
          deafened: z.boolean().describe('true pour deafen, false pour annuler'),
          reason: z.string().optional().describe('Raison'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, deafened, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const rm = await resolveMember(guildId, member);
          if (!rm.ok) return rm.response;

          const guildMember = await guild.members.fetch(rm.userId).catch(() => null);
          if (!guildMember) return err(`Membre « ${member} » introuvable`);
          if (!guildMember.voice.channel) return err(`Le membre n'est pas connecté en vocal`);

          await guildMember.voice.setDeaf(deafened, reason || 'Via MCP');

          await audit(key_name, deafened ? 'Deafen vocal MCP' : 'Undeafen vocal MCP', rm.label, '');
          return ok({ ok: true, userId: rm.userId, deafened });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'disconnect_member_voice',
      {
        description: 'Déconnecte un membre du salon vocal. Requiert WRITE_MEMBERS.',
        inputSchema: {
          member: z.string().describe('Nom, @mention ou ID du membre'),
          reason: z.string().optional().describe('Raison de la déconnexion'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const rm = await resolveMember(guildId, member);
          if (!rm.ok) return rm.response;

          const guildMember = await guild.members.fetch(rm.userId).catch(() => null);
          if (!guildMember) return err(`Membre « ${member} » introuvable`);
          if (!guildMember.voice.channel) return err(`Le membre n'est pas connecté en vocal`);

          await guildMember.voice.disconnect(reason || 'Déconnecté via MCP');

          await audit(key_name, 'Déconnexion vocale MCP', rm.label, '');
          return ok({ ok: true, userId: rm.userId });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // ── Invitations ─────────────────────────────────────────────────────────

    server.registerTool(
      'create_invite',
      {
        description: 'Crée un lien d\'invitation pour un salon. Requiert WRITE_MEMBERS.',
        inputSchema: {
          channel: z.string().describe('Nom, mention <#id> ou ID du salon'),
          max_uses: z.number().int().min(0).default(0).describe('Nombre max d\'utilisations (0 = illimité)'),
          max_age: z.number().int().min(0).default(86400).describe('Durée de vie en secondes (0 = permanent, défaut 24h)'),
          temporary: z.boolean().default(false).describe('Membership temporaire (le membre est expulsé quand il se déconnecte)'),
          reason: z.string().optional().describe('Raison (pour l\'audit)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ channel, max_uses, max_age, temporary, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const chId = SNOWFLAKE.test(channel) ? channel : null;
          const mentionMatch = channel.match(MENTION_CHANNEL);
          const resolvedId = mentionMatch ? mentionMatch[1] : chId;
          const ch = resolvedId
            ? guild.channels.cache.get(resolvedId)
            : guild.channels.cache.find((c) => c.name.toLowerCase() === channel.replace(/^#/, '').toLowerCase());

          if (!ch) return err(`Salon « ${channel} » introuvable`);
          if (!('createInvite' in ch)) return err(`Le salon « ${channel} » n'accepte pas d'invitation.`);

          const invite = await ch.createInvite({
            maxUses: max_uses,
            maxAge: max_age,
            temporary,
            reason: reason || 'Créé via MCP',
          });

          await audit(key_name, 'Création invitation MCP', `#${ch.name}`, `Code: ${invite.code}`);
          return ok({
            ok: true,
            code: invite.code,
            url: invite.url,
            channelId: ch.id,
            channelName: ch.name,
            maxUses: invite.maxUses,
            maxAge: invite.maxAge,
            temporary: invite.temporary,
            expiresAt: invite.expiresAt?.toISOString() ?? null,
          });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_invite',
      {
        description: 'Révoque une invitation active du serveur. Requiert WRITE_MEMBERS.',
        inputSchema: {
          code: z.string().describe('Code de l\'invitation à révoquer'),
          reason: z.string().optional().describe('Raison de la révocation'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ code, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const invites = await guild.invites.fetch();
          const invite = invites.find((i) => i.code === code);
          if (!invite) return err(`Invitation « ${code} » introuvable ou déjà expirée`);

          await invite.delete(reason || 'Révoqué via MCP');

          await audit(key_name, 'Suppression invitation MCP', code, `Salon: ${invite.channel?.name ?? '?'}`);
          return ok({ ok: true, code });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // ── Emojis & stickers ───────────────────────────────────────────────────

    server.registerTool(
      'create_emoji',
      {
        description: 'Crée un emoji personnalisé sur le serveur. Requiert WRITE_MEMBERS.',
        inputSchema: {
          name: z.string().describe('Nom de l\'emoji (sans les deux-points)'),
          image_url: z.string().describe('URL de l\'image (PNG, JPG, GIF — max 256 Ko)'),
          reason: z.string().optional().describe('Raison de la création'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ name, image_url, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const emoji = await guild.emojis.create({ attachment: image_url, name, reason: reason || 'Créé via MCP' });

          await audit(key_name, 'Création emoji MCP', name, `ID: ${emoji.id}`);
          return ok({ ok: true, emojiId: emoji.id, name: emoji.name, url: emoji.url });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_emoji',
      {
        description: 'Renomme un emoji personnalisé. Requiert WRITE_MEMBERS.',
        inputSchema: {
          emoji: z.string().describe('Nom ou ID de l\'emoji à modifier'),
          name: z.string().describe('Nouveau nom de l\'emoji'),
          reason: z.string().optional().describe('Raison de la modification'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ emoji, name, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const emojis = await guild.emojis.fetch();
          const target = SNOWFLAKE.test(emoji)
            ? emojis.get(emoji)
            : emojis.find((e) => e.name?.toLowerCase() === emoji.toLowerCase());

          if (!target) return err(`Emoji « ${emoji} » introuvable`);

          const updated = await target.edit({ name, reason: reason || 'Modifié via MCP' });

          await audit(key_name, 'Modification emoji MCP', `${emoji} → ${name}`, `ID: ${target.id}`);
          return ok({ ok: true, emojiId: updated.id, name: updated.name });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_emoji',
      {
        description: 'Supprime un emoji personnalisé du serveur. Requiert WRITE_MEMBERS.',
        inputSchema: {
          emoji: z.string().describe('Nom ou ID de l\'emoji à supprimer'),
          reason: z.string().optional().describe('Raison de la suppression'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ emoji, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const emojis = await guild.emojis.fetch();
          const target = SNOWFLAKE.test(emoji)
            ? emojis.get(emoji)
            : emojis.find((e) => e.name?.toLowerCase() === emoji.toLowerCase());

          if (!target) return err(`Emoji « ${emoji} » introuvable`);

          const emojiName = target.name;
          await target.delete(reason || 'Supprimé via MCP');

          await audit(key_name, 'Suppression emoji MCP', emojiName ?? emoji, `ID: ${target.id}`);
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'create_sticker',
      {
        description: 'Crée un sticker personnalisé sur le serveur. Requiert WRITE_MEMBERS.',
        inputSchema: {
          name: z.string().describe('Nom du sticker'),
          image_url: z.string().describe('URL de l\'image (PNG, APNG, Lottie — max 512 Ko)'),
          tags: z.string().describe('Emoji associé / tags (ex: "wave")'),
          description: z.string().optional().describe('Description du sticker'),
          reason: z.string().optional().describe('Raison de la création'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ name, image_url, tags, description, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const sticker = await guild.stickers.create({
            file: image_url,
            name,
            tags,
            description: description || '',
            reason: reason || 'Créé via MCP',
          });

          await audit(key_name, 'Création sticker MCP', name, `ID: ${sticker.id}`);
          return ok({ ok: true, stickerId: sticker.id, name: sticker.name, url: sticker.url });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_sticker',
      {
        description: 'Modifie un sticker personnalisé du serveur. Requiert WRITE_MEMBERS.',
        inputSchema: {
          sticker: z.string().describe('Nom ou ID du sticker à modifier'),
          name: z.string().optional().describe('Nouveau nom'),
          tags: z.string().optional().describe('Nouveau tag emoji'),
          description: z.string().optional().describe('Nouvelle description'),
          reason: z.string().optional().describe('Raison de la modification'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ sticker, name, tags, description, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const stickers = await guild.stickers.fetch();
          const target = SNOWFLAKE.test(sticker)
            ? stickers.get(sticker)
            : stickers.find((s) => s.name.toLowerCase() === sticker.toLowerCase());

          if (!target) return err(`Sticker « ${sticker} » introuvable`);

          const updated = await target.edit({
            name: name ?? undefined,
            tags: tags ?? undefined,
            description: description ?? undefined,
            reason: reason || 'Modifié via MCP',
          });

          await audit(key_name, 'Modification sticker MCP', target.name, `ID: ${target.id}`);
          return ok({ ok: true, stickerId: updated.id, name: updated.name });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_sticker',
      {
        description: 'Supprime un sticker personnalisé du serveur. Requiert WRITE_MEMBERS.',
        inputSchema: {
          sticker: z.string().describe('Nom ou ID du sticker à supprimer'),
          reason: z.string().optional().describe('Raison de la suppression'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ sticker, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const stickers = await guild.stickers.fetch();
          const target = SNOWFLAKE.test(sticker)
            ? stickers.get(sticker)
            : stickers.find((s) => s.name.toLowerCase() === sticker.toLowerCase());

          if (!target) return err(`Sticker « ${sticker} » introuvable`);

          const stickerName = target.name;
          await target.delete(reason || 'Supprimé via MCP');

          await audit(key_name, 'Suppression sticker MCP', stickerName, `ID: ${target.id}`);
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_thread',
      {
        description: 'Supprime un thread. Requiert WRITE_MEMBERS.',
        inputSchema: {
          thread: z.string().describe('ID du thread à supprimer'),
          reason: z.string().optional().describe('Raison de la suppression'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ thread, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const threadChannel = guild.channels.cache.get(thread);
          if (!threadChannel?.isThread()) return err(`Thread « ${thread} » introuvable`);

          const threadName = threadChannel.name;
          await threadChannel.delete(reason || 'Supprimé via MCP');

          await audit(key_name, 'Suppression thread MCP', threadName, `ID: ${thread}`);
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // ── Webhooks ────────────────────────────────────────────────────────────

    server.registerTool(
      'create_webhook',
      {
        description: 'Crée un webhook dans un salon. Requiert WRITE_MEMBERS.',
        inputSchema: {
          channel: z.string().describe('Nom, mention <#id> ou ID du salon'),
          name: z.string().describe('Nom du webhook'),
          reason: z.string().optional().describe('Raison de la création'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ channel, name, reason, key_name }) => {
        try {
          const resolved = resolveChannel(guildId, client, channel);
          if (!resolved.ok) return resolved.response;

          const webhook = await resolved.channel.createWebhook({ name, reason: reason || 'Créé via MCP' });

          await audit(key_name, 'Création webhook MCP', name, `ID: ${webhook.id} dans #${resolved.channel.name}`);
          return ok({ ok: true, webhookId: webhook.id, name: webhook.name, url: webhook.url, channelId: resolved.channel.id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_webhook',
      {
        description: 'Modifie un webhook existant (nom ou salon). Requiert WRITE_MEMBERS.',
        inputSchema: {
          webhook: z.string().describe('ID du webhook à modifier'),
          name: z.string().optional().describe('Nouveau nom'),
          channel: z.string().optional().describe('Nom ou ID du nouveau salon'),
          reason: z.string().optional().describe('Raison de la modification'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ webhook, name, channel, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const webhooks = await guild.fetchWebhooks();
          const target = webhooks.get(webhook);
          if (!target) return err(`Webhook « ${webhook} » introuvable`);

          const editData: { name?: string; channel?: string; reason?: string } = {};
          if (name) editData.name = name;
          if (channel) {
            const resolved = resolveChannel(guildId, client, channel);
            if (!resolved.ok) return resolved.response;
            editData.channel = resolved.channel.id;
          }

          const updated = await target.edit({ ...editData, reason: reason || 'Modifié via MCP' });

          await audit(key_name, 'Modification webhook MCP', target.name ?? webhook, `ID: ${webhook}`);
          return ok({ ok: true, webhookId: updated.id, name: updated.name, channelId: updated.channelId });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_webhook',
      {
        description: 'Supprime un webhook. Requiert WRITE_MEMBERS.',
        inputSchema: {
          webhook: z.string().describe('ID du webhook à supprimer'),
          reason: z.string().optional().describe('Raison de la suppression'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ webhook, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const webhooks = await guild.fetchWebhooks();
          const target = webhooks.get(webhook);
          if (!target) return err(`Webhook « ${webhook} » introuvable`);

          const webhookName = target.name;
          await target.delete(reason || 'Supprimé via MCP');

          await audit(key_name, 'Suppression webhook MCP', webhookName ?? webhook, `ID: ${webhook}`);
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // ── Réglages globaux du serveur ─────────────────────────────────────────

    server.registerTool(
      'update_guild_settings',
      {
        description: 'Modifie les réglages globaux du serveur Discord. Requiert WRITE_MEMBERS.',
        inputSchema: {
          name: z.string().optional().describe('Nouveau nom du serveur'),
          icon_url: z.string().optional().describe('URL de la nouvelle icône'),
          banner_url: z.string().optional().describe('URL de la nouvelle bannière (niveau de boost requis)'),
          splash_url: z.string().optional().describe('URL du nouveau splash d\'invitation'),
          verification_level: z.enum(['0', '1', '2', '3', '4']).optional().describe('Niveau de vérification (0=Aucun, 1=Faible, 2=Moyen, 3=Élevé, 4=Très élevé)'),
          afk_channel: z.string().optional().describe('Nom ou ID du salon AFK'),
          afk_timeout: z.enum(['60', '300', '900', '1800', '3600']).optional().describe('Timeout AFK en secondes'),
          default_message_notifications: z.enum(['0', '1']).optional().describe('Notifications par défaut (0=Tous les messages, 1=Seulement les mentions)'),
          system_channel: z.string().optional().describe('Nom ou ID du salon système'),
          preferred_locale: z.string().optional().describe('Locale du serveur (ex: "fr", "en-US")'),
          description: z.string().optional().describe('Description du serveur'),
          reason: z.string().optional().describe('Raison de la modification'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ name, icon_url, banner_url, splash_url, verification_level, afk_channel, afk_timeout, default_message_notifications, system_channel, preferred_locale, description, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const editData: Record<string, any> = {};
          if (name !== undefined) editData.name = name;
          if (icon_url !== undefined) editData.icon = icon_url;
          if (banner_url !== undefined) editData.banner = banner_url;
          if (splash_url !== undefined) editData.splash = splash_url;
          if (verification_level !== undefined) editData.verificationLevel = parseInt(verification_level, 10);
          if (default_message_notifications !== undefined) editData.defaultMessageNotifications = parseInt(default_message_notifications, 10);
          if (preferred_locale !== undefined) editData.preferredLocale = preferred_locale;
          if (description !== undefined) editData.description = description;
          if (afk_timeout !== undefined) editData.afkTimeout = parseInt(afk_timeout, 10);

          if (afk_channel !== undefined) {
            const ch = SNOWFLAKE.test(afk_channel)
              ? guild.channels.cache.get(afk_channel)
              : guild.channels.cache.find((c) => c.name.toLowerCase() === afk_channel.toLowerCase() && c.isVoiceBased());
            if (!ch) return err(`Salon AFK « ${afk_channel} » introuvable`);
            editData.afkChannel = ch.id;
          }

          if (system_channel !== undefined) {
            const ch = SNOWFLAKE.test(system_channel)
              ? guild.channels.cache.get(system_channel)
              : guild.channels.cache.find((c) => c.name.toLowerCase() === system_channel.toLowerCase() && c.isTextBased());
            if (!ch) return err(`Salon système « ${system_channel} » introuvable`);
            editData.systemChannel = ch.id;
          }

          if (Object.keys(editData).length === 0) return err('Aucune modification spécifiée');

          await guild.edit({ ...editData, reason: reason || 'Modifié via MCP' });

          const changes = Object.keys(editData).join(', ');
          await audit(key_name, 'Réglages serveur MCP', changes, `Modifié : ${changes}`);
          return ok({ ok: true, modified: Object.keys(editData) });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 11. admin_reset_economy
    server.registerTool(
      'admin_reset_economy',
      {
        description: 'Réinitialise l\'économie du serveur. Requiert une validation staff si déclenché directement.',
        inputSchema: {
          component: z.enum(['all', 'profiles', 'items', 'config', 'guilds']).default('all'),
          approved_by_staff: z.boolean().default(false).describe('Indique si un bouton Discord a déjà approuvé cette demande'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ component, approved_by_staff, key_name }) => {
        if (!approved_by_staff) {
          return err('Action critique rejetée. Utilisez request_staff_approval pour soumettre le reset à la validation humaine du staff.');
        }

        try {
          const { adminResetGuildEconomy } = await import('../../services/features/economyService.js');
          await adminResetGuildEconomy(guildId, component);

          await audit(key_name, 'Réinitialisation Économie MCP', `Reset de component: ${component}`, 'Action validée par le staff');
          return ok({ ok: true, message: `L'économie (${component}) a été réinitialisée avec succès.` });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 12. admin_adjust_coins
    server.registerTool(
      'admin_adjust_coins',
      {
        description: 'Crédite ou débite des pièces RPG à un membre.',
        inputSchema: {
          member: z.string().describe('Nom, mention ou ID du membre'),
          amount: z.number().int().describe('Nombre de pièces (positif pour ajouter, négatif pour retirer)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, amount, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        try {
          const profile = await prisma.rpgProfile.upsert({
            where: { guildId_userId: { guildId, userId: resolved.userId } },
            update: { balance: { increment: amount } },
            create: { guildId, userId: resolved.userId, balance: Math.max(0, amount) }
          });

          await audit(key_name, 'Ajustement monnaie MCP', resolved.label, `Montant: ${amount}`);
          return ok({ ok: true, userId: resolved.userId, newBalance: profile.balance });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 13. admin_adjust_xp
    server.registerTool(
      'admin_adjust_xp',
      {
        description: 'Crédite ou retire de l\'XP de leveling/progression à un membre.',
        inputSchema: {
          member: z.string().describe('Nom, mention ou ID du membre'),
          amount: z.number().int().describe('Montant d\'XP (positif pour ajouter, négatif pour retirer)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ member, amount, key_name }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        try {
          await addXp(guildId, resolved.userId, amount, client);
          const currentLevel = await prisma.memberLevel.findUnique({
            where: { guildId_userId: { guildId, userId: resolved.userId } },
            select: { level: true, xp: true }
          });

          await audit(key_name, 'Ajustement XP MCP', resolved.label, `XP: ${amount}`);
          return ok({ ok: true, userId: resolved.userId, level: currentLevel?.level, xp: currentLevel?.xp });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 14. add_automod_regex_rule / remove_automod_regex_rule
    server.registerTool(
      'add_automod_regex_rule',
      {
        description: 'Ajoute un filtre regex ou un mot banni à l\'AutoMod.',
        inputSchema: {
          word: z.string().describe('Le mot ou le motif regex banni'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ word, key_name }) => {
        try {
          const config = await prisma.autoModConfig.findUnique({ where: { guildId } });
          const currentWords = config?.customWords || [];
          if (!currentWords.includes(word)) {
            currentWords.push(word);
            await prisma.autoModConfig.update({
              where: { guildId },
              data: { customWords: currentWords }
            });
          }

          await audit(key_name, 'AutoMod règle MCP', word, 'Règle regex ajoutée');
          return ok({ ok: true, word });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'remove_automod_regex_rule',
      {
        description: 'Retire une règle de mot banni/regex de l\'AutoMod.',
        inputSchema: {
          word: z.string().describe('La règle à retirer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ word, key_name }) => {
        try {
          const config = await prisma.autoModConfig.findUnique({ where: { guildId } });
          const currentWords = config?.customWords || [];
          const filtered = currentWords.filter(w => w !== word);
          await prisma.autoModConfig.update({
            where: { guildId },
            data: { customWords: filtered }
          });

          await audit(key_name, 'AutoMod règle MCP', word, 'Règle regex retirée');
          return ok({ ok: true, word });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
  }

  // ── SYSTEM & SAFETY (NEW) ──────────────────────────────────────────────────
  if (shouldRegister('WRITE_MESSAGES')) {
    // 1. request_staff_approval
    server.registerTool(
      'request_staff_approval',
      {
        description: 'Soumet une action critique (comme réinitialiser l\'économie ou bannir) à l\'approbation manuelle du Staff via un bouton Discord.',
        inputSchema: {
          action_name: z.string().describe('Nom court de l\'action (ex: "reset_economy", "ban_member")'),
          details: z.string().describe('Détails textuels décrivant l\'action demandée par l\'IA'),
          channel: z.string().optional().describe('Salon où envoyer la demande (défaut: salon de logs)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ action_name, details, channel, key_name }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        // Récupérer le salon de logs
        let targetChannel: TextChannel | NewsChannel | null = null;
        if (channel) {
          const resolved = resolveChannel(guildId, client, channel);
          if (resolved.ok) targetChannel = resolved.channel;
        }

        if (!targetChannel) {
          const config = await prisma.guild.findUnique({ where: { id: guildId }, select: { logChannelId: true } });
          const ch = config?.logChannelId ? guild.channels.cache.get(config.logChannelId) : null;
          if (ch instanceof TextChannel) targetChannel = ch;
        }

        if (!targetChannel) {
          // Fallback sur le premier salon texte disponible si aucun salon de log configuré
          const fallback = guild.channels.cache.find(c => c instanceof TextChannel && c.permissionsFor(guild.members.me!).has(PermissionFlagsBits.SendMessages));
          if (fallback instanceof TextChannel) targetChannel = fallback;
        }

        if (!targetChannel) return err('Aucun salon textuel trouvé pour envoyer la demande.');

        try {
          const { randomBytes } = await import('crypto');
          const requestId = `mcp_approve:${randomBytes(8).toString('hex')}`;
          
          // Stocker temporairement la demande d'approbation en base (si une table existe, ou en log)
          // Pour éviter de surcharger le schema, on crée un log d'audit spécifique en statut PENDING
          await prisma.dashboardAuditLog.create({
            data: {
              guildId,
              user: `MCP[${key_name || 'agent'}]`,
              action: `Demande d'approbation : ${action_name}`,
              context: requestId,
              module: 'MCP',
              eventType: 'Action',
              details: `PENDING - Détails : ${details}`,
              dateIso: new Date(),
            }
          });

          const embed = new EmbedBuilder()
            .setTitle(`⚠️ Demande d'autorisation critique · IA`)
            .setDescription(`L'agent IA demande l'autorisation d'exécuter l'action suivante :\n\n**Action :** \`${action_name}\`\n**Détails :**\n${details}`)
            .setColor(0xd97757) // Orange
            .setTimestamp()
            .setFooter({ text: `ID Demande : ${requestId}` });

          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`mcp_approve:ok:${requestId}`).setLabel('Approuver').setStyle(ButtonStyle.Success).setEmoji('✅'),
            new ButtonBuilder().setCustomId(`mcp_approve:no:${requestId}`).setLabel('Rejeter').setStyle(ButtonStyle.Danger).setEmoji('❌')
          );

          await targetChannel.send({
            content: '🔔 **Alerte Staff :** Une action IA requiert votre validation.',
            embeds: [embed],
            components: [row]
          });

          return ok({ ok: true, pendingApproval: true, requestId, message: "La demande d'approbation a été envoyée au staff." });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 2. generate_server_digest
    server.registerTool(
      'generate_server_digest',
      {
        description: 'Publie un digest/récapitulatif rédigé par l\'IA dans un salon textuel.',
        inputSchema: {
          channel: z.string().describe('Salon cible'),
          title: z.string().default('Récapitulatif Hebdomadaire'),
          content: z.string().describe('Texte du digest/récapitulatif rédigé par l\'IA'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ channel, title, content, key_name }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        const embed = new EmbedBuilder()
          .setTitle(title)
          .setDescription(content)
          .setColor(0x5865F2)
          .setTimestamp();

        try {
          const sent = await resolved.channel.send({ embeds: [embed] });
          await audit(key_name, 'Publication Digest MCP', title, `Salon: #${resolved.channel.name}`);
          return ok({ ok: true, messageId: sent.id });
        } catch (e) {
          return err(`Erreur d'envoi : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // ── Messages épinglés & threads ─────────────────────────────────────────

    server.registerTool(
      'pin_message',
      {
        description: 'Épingle un message dans un salon. Requiert WRITE_MESSAGES.',
        inputSchema: {
          channel: z.string().describe('Nom, mention <#id> ou ID du salon'),
          message_id: z.string().describe('ID du message à épingler'),
          reason: z.string().optional().describe('Raison'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ channel, message_id, reason, key_name }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        try {
          const msg = await resolved.channel.messages.fetch(message_id);
          await msg.pin(reason || 'Épinglé via MCP');

          await audit(key_name, 'Épinglage message MCP', `#${resolved.channel.name}`, `Message: ${message_id}`);
          return ok({ ok: true, messageId: message_id, channelId: resolved.channel.id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'unpin_message',
      {
        description: 'Désépingle un message d\'un salon. Requiert WRITE_MESSAGES.',
        inputSchema: {
          channel: z.string().describe('Nom, mention <#id> ou ID du salon'),
          message_id: z.string().describe('ID du message à désépingler'),
          reason: z.string().optional().describe('Raison'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ channel, message_id, reason, key_name }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        try {
          const msg = await resolved.channel.messages.fetch(message_id);
          await msg.unpin(reason || 'Désépinglé via MCP');

          await audit(key_name, 'Désépinglage message MCP', `#${resolved.channel.name}`, `Message: ${message_id}`);
          return ok({ ok: true, messageId: message_id, channelId: resolved.channel.id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'create_thread',
      {
        description: 'Crée un thread dans un salon (à partir d\'un message existant ou non). Requiert WRITE_MESSAGES.',
        inputSchema: {
          channel: z.string().describe('Nom, mention <#id> ou ID du salon parent'),
          name: z.string().describe('Nom du thread'),
          message_id: z.string().optional().describe('ID du message à partir duquel créer le thread (optionnel)'),
          auto_archive_duration: z.enum(['60', '1440', '4320', '10080']).default('1440').describe('Durée avant archivage auto (en minutes) : 60, 1440, 4320, 10080'),
          reason: z.string().optional().describe('Raison de la création'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ channel, name, message_id, auto_archive_duration, reason, key_name }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;

        try {
          const duration = parseInt(auto_archive_duration, 10) as 60 | 1440 | 4320 | 10080;

          let thread;
          if (message_id) {
            const msg = await resolved.channel.messages.fetch(message_id);
            thread = await msg.startThread({
              name,
              autoArchiveDuration: duration,
              reason: reason || 'Créé via MCP',
            });
          } else {
            thread = await resolved.channel.threads.create({
              name,
              autoArchiveDuration: duration,
              reason: reason || 'Créé via MCP',
            });
          }

          await audit(key_name, 'Création thread MCP', name, `ID: ${thread.id} dans #${resolved.channel.name}`);
          return ok({ ok: true, threadId: thread.id, name: thread.name, channelId: resolved.channel.id });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'archive_thread',
      {
        description: 'Archive ou désarchive un thread. Requiert WRITE_MESSAGES.',
        inputSchema: {
          thread: z.string().describe('ID du thread'),
          archived: z.boolean().default(true).describe('true pour archiver, false pour désarchiver'),
          reason: z.string().optional().describe('Raison'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ thread, archived, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const threadChannel = guild.channels.cache.get(thread);
          if (!threadChannel?.isThread()) return err(`Thread « ${thread} » introuvable`);

          await threadChannel.setArchived(archived, reason || 'Via MCP');

          await audit(key_name, archived ? 'Archivage thread MCP' : 'Désarchivage thread MCP', threadChannel.name, `ID: ${thread}`);
          return ok({ ok: true, threadId: thread, archived });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'lock_thread',
      {
        description: 'Verrouille ou déverrouille un thread. Requiert WRITE_MESSAGES.',
        inputSchema: {
          thread: z.string().describe('ID du thread'),
          locked: z.boolean().default(true).describe('true pour verrouiller, false pour déverrouiller'),
          reason: z.string().optional().describe('Raison'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MESSAGES', async ({ thread, locked, reason, key_name }) => {
        try {
          const guild = client.guilds.cache.get(guildId);
          if (!guild) return err('Serveur Discord introuvable');

          const threadChannel = guild.channels.cache.get(thread);
          if (!threadChannel?.isThread()) return err(`Thread « ${thread} » introuvable`);

          await threadChannel.setLocked(locked, reason || 'Via MCP');

          await audit(key_name, locked ? 'Verrouillage thread MCP' : 'Déverrouillage thread MCP', threadChannel.name, `ID: ${thread}`);
          return ok({ ok: true, threadId: thread, locked });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
  }

  // ── WRITE_MEMBERS — Gestion des salons ────────────────────────────────────
  if (shouldRegister('WRITE_MEMBERS')) {

    // create_category — Créer une catégorie
    server.registerTool(
      'create_category',
      {
        description: 'Crée une catégorie sur le serveur Discord. Requiert WRITE_MEMBERS.',
        inputSchema: {
          name: z.string().describe('Nom de la catégorie'),
          position: z.number().int().min(0).optional().describe('Position (0 = en haut)'),
          private: z.boolean().default(false).describe('Si true, la catégorie est cachée au rôle @everyone'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ name, position, private: isPrivate, key_name }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur introuvable.');
        try {
          const permissionOverwrites = isPrivate ? [
            { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
          ] : [];
          const cat = await guild.channels.create({
            name,
            type: ChannelType.GuildCategory,
            position,
            permissionOverwrites,
          });
          await audit(key_name, 'Création catégorie MCP', name, `ID: ${cat.id}`);
          return ok({ ok: true, categoryId: cat.id, name: cat.name });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // create_channel — Créer un salon textuel, vocal ou d'annonce
    server.registerTool(
      'create_channel',
      {
        description: 'Crée un salon Discord (texte, vocal, annonces, forum, stage). Requiert WRITE_MEMBERS.',
        inputSchema: {
          name: z.string().describe('Nom du salon'),
          type: z.enum(['text', 'voice', 'announcement', 'forum', 'stage']).default('text').describe('Type de salon'),
          category: z.string().optional().describe('Nom ou ID de la catégorie parente'),
          topic: z.string().optional().describe('Sujet du salon (salons textuels uniquement, max 1024 car.)'),
          private: z.boolean().default(false).describe('Si true, caché au @everyone'),
          nsfw: z.boolean().default(false).describe('Marquer le salon comme NSFW'),
          slowmode: z.number().int().min(0).max(21600).default(0).describe('Délai de lenteur en secondes (0 = désactivé)'),
          user_limit: z.number().int().min(0).max(99).optional().describe('Limite d\'utilisateurs (salons vocaux, 0 = illimité)'),
          bitrate: z.number().int().min(8000).max(384000).optional().describe('Bitrate en bps pour les salons vocaux (ex: 64000)'),
          position: z.number().int().min(0).optional().describe('Position dans la catégorie'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ name, type, category, topic, private: isPrivate, nsfw, slowmode, user_limit, bitrate, position, key_name }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur introuvable.');

        // Résoudre la catégorie parente
        let parentId: string | undefined;
        if (category) {
          const cat = guild.channels.cache.find(c =>
            c.type === ChannelType.GuildCategory &&
            (c.id === category || c.name.toLowerCase() === category.toLowerCase())
          );
          if (!cat) return err(`Catégorie introuvable : « ${category} ». Vérifiez le nom ou l'ID.`);
          parentId = cat.id;
        }

        const channelTypeMap: Record<string, number> = {
          text: ChannelType.GuildText,
          voice: ChannelType.GuildVoice,
          announcement: ChannelType.GuildAnnouncement,
          forum: ChannelType.GuildForum,
          stage: ChannelType.GuildStageVoice,
        };

        const permissionOverwrites = isPrivate ? [
          { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
        ] : [];

        try {
          const ch = await guild.channels.create({
            name,
            type: channelTypeMap[type] as any,
            parent: parentId,
            topic: topic?.slice(0, 1024),
            nsfw,
            rateLimitPerUser: slowmode,
            userLimit: user_limit,
            bitrate,
            position,
            permissionOverwrites,
          });
          await audit(key_name, 'Création salon MCP', `#${name} (${type})`, `ID: ${ch.id}${parentId ? ` | catégorie: ${parentId}` : ''}`);
          return ok({ ok: true, channelId: ch.id, name: ch.name, type });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // edit_channel — Modifier un salon existant
    server.registerTool(
      'edit_channel',
      {
        description: 'Modifie les propriétés d\'un salon existant (nom, sujet, catégorie, lenteur…). Requiert WRITE_MEMBERS.',
        inputSchema: {
          channel: z.string().describe('Nom, mention <#id> ou ID du salon à modifier'),
          name: z.string().optional().describe('Nouveau nom'),
          topic: z.string().optional().describe('Nouveau sujet (max 1024 car.)'),
          category: z.string().optional().describe('Nouvelle catégorie (nom ou ID), "" pour retirer'),
          nsfw: z.boolean().optional(),
          slowmode: z.number().int().min(0).max(21600).optional().describe('Délai de lenteur en secondes'),
          user_limit: z.number().int().min(0).max(99).optional().describe('Limite d\'utilisateurs (vocaux)'),
          bitrate: z.number().int().min(8000).max(384000).optional().describe('Bitrate bps (vocaux)'),
          position: z.number().int().min(0).optional(),
          reason: z.string().optional(),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ channel, name, topic, category, nsfw, slowmode, user_limit, bitrate, position, reason, key_name }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;
        const ch = resolved.channel as any;

        const guild = client.guilds.cache.get(guildId)!;
        let parentId: string | null | undefined = undefined;
        if (category !== undefined) {
          if (category === '') {
            parentId = null; // retirer de la catégorie
          } else {
            const cat = guild.channels.cache.find(c =>
              c.type === ChannelType.GuildCategory &&
              (c.id === category || c.name.toLowerCase() === category.toLowerCase())
            );
            if (!cat) return err(`Catégorie introuvable : « ${category} ».`);
            parentId = cat.id;
          }
        }

        const options: Record<string, unknown> = {};
        if (name !== undefined) options.name = name;
        if (topic !== undefined) options.topic = topic.slice(0, 1024);
        if (parentId !== undefined) options.parent = parentId;
        if (nsfw !== undefined) options.nsfw = nsfw;
        if (slowmode !== undefined) options.rateLimitPerUser = slowmode;
        if (user_limit !== undefined) options.userLimit = user_limit;
        if (bitrate !== undefined) options.bitrate = bitrate;
        if (position !== undefined) options.position = position;

        try {
          await ch.edit(options, reason);
          await audit(key_name, 'Modification salon MCP', `#${ch.name}`, JSON.stringify(options).slice(0, 200));
          return ok({ ok: true, channelId: ch.id, updates: Object.keys(options) });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // set_channel_permissions — Gérer les permissions d'un salon
    server.registerTool(
      'set_channel_permissions',
      {
        description:
          'Définit ou supprime des permissions sur un salon pour un rôle ou un membre. ' +
          'Utilise allow/deny comme listes de permissions Discord (ex: ["ViewChannel","SendMessages"]). ' +
          'Requiert WRITE_MEMBERS.',
        inputSchema: {
          channel: z.string().describe('Nom, mention <#id> ou ID du salon'),
          target: z.string().describe('Nom ou ID du rôle OU @mention/nom/ID du membre concerné'),
          target_type: z.enum(['role', 'member']).default('role'),
          allow: z.array(z.string()).default([]).describe('Permissions à autoriser (ex: ["ViewChannel","SendMessages"])'),
          deny: z.array(z.string()).default([]).describe('Permissions à refuser (ex: ["SendMessages"])'),
          reset: z.boolean().default(false).describe('Si true, supprime la surcharge de permission existante'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ channel, target, target_type, allow, deny, reset, key_name }) => {
        const resolved = resolveChannel(guildId, client, channel);
        if (!resolved.ok) return resolved.response;
        const ch = resolved.channel as any;

        const guild = client.guilds.cache.get(guildId)!;

        // Résoudre la cible (rôle ou membre)
        let targetId: string;
        if (target_type === 'role') {
          const SNOWFLAKE_RE = /^\d{16,20}$/;
          const role = SNOWFLAKE_RE.test(target)
            ? guild.roles.cache.get(target)
            : guild.roles.cache.find(r => r.name.toLowerCase() === target.toLowerCase());
          if (!role) return err(`Rôle introuvable : « ${target} ». Vérifiez le nom ou l'ID.`);
          targetId = role.id;
        } else {
          const rm = await resolveMember(guildId, target);
          if (!rm.ok) return rm.response;
          targetId = rm.userId;
        }

        try {
          if (reset) {
            await ch.permissionOverwrites.delete(targetId);
            await audit(key_name, 'Reset permissions salon MCP', `#${ch.name}`, `Cible: ${target}`);
            return ok({ ok: true, reset: true, channelId: ch.id, targetId });
          }

          // Construire l'objet de surcharge : { ViewChannel: true, SendMessages: false, ... }
          const overwrite: Record<string, boolean> = {};
          for (const p of allow) {
            if ((PermissionFlagsBits as any)[p] !== undefined) overwrite[p] = true;
          }
          for (const p of deny) {
            if ((PermissionFlagsBits as any)[p] !== undefined) overwrite[p] = false;
          }

          if (Object.keys(overwrite).length === 0) {
            return err('Aucune permission valide reconnue. Exemples valides : ViewChannel, SendMessages, Connect, Speak, ManageMessages…');
          }

          await ch.permissionOverwrites.edit(targetId, overwrite);

          await audit(key_name, 'Permissions salon MCP', `#${ch.name}`, `Cible: ${target} | allow: [${allow}] | deny: [${deny}]`);
          return ok({ ok: true, channelId: ch.id, targetId, allow, deny });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // delete_channel — Supprimer un salon ou une catégorie
    server.registerTool(
      'delete_channel',
      {
        description: 'Supprime un salon ou une catégorie Discord. Requiert WRITE_MEMBERS.',
        inputSchema: {
          channel: z.string().describe('Nom, mention <#id> ou ID du salon / catégorie à supprimer'),
          reason: z.string().optional().describe('Raison de la suppression (visible dans les logs Discord)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ channel, reason, key_name }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur introuvable.');

        const SNOWFLAKE_RE = /^\d{16,20}$/;
        const MENTION_CH = /^<#(\d+)>$/;
        const mentionMatch = channel.match(MENTION_CH);
        const rawId = mentionMatch ? mentionMatch[1] : SNOWFLAKE_RE.test(channel) ? channel : null;

        const ch = rawId
          ? guild.channels.cache.get(rawId)
          : guild.channels.cache.find(c => c.name.toLowerCase() === channel.replace(/^#/, '').toLowerCase());

        if (!ch) return err(`Salon/catégorie introuvable : « ${channel} ».`);

        try {
          const savedName = ch.name;
          const savedId = ch.id;
          await (ch as any).delete(reason ?? 'Suppression via MCP');
          await audit(key_name, 'Suppression salon MCP', `#${savedName}`, `ID: ${savedId}${reason ? ` | ${reason}` : ''}`);
          return ok({ ok: true, deletedId: savedId, name: savedName });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
  }

  if (shouldRegister('READ_STATS')) {
    // 3. search_audit_logs
    server.registerTool(
      'search_audit_logs',
      {
        description: 'Fouille les logs d\'audit du dashboard pour identifier les actions passées.',
        inputSchema: {
          query: z.string().optional().describe('Terme de recherche optionnel'),
          limit: z.number().int().min(1).max(100).default(20),
        },
        _meta: toolMeta,
      },
      guard('READ_STATS', async ({ query, limit }) => {
        try {
          const logs = await prisma.dashboardAuditLog.findMany({
            where: {
              guildId,
              ...(query ? {
                OR: [
                  { action: { contains: query, mode: 'insensitive' } },
                  { details: { contains: query, mode: 'insensitive' } },
                  { user: { contains: query, mode: 'insensitive' } },
                  { module: { contains: query, mode: 'insensitive' } },
                ]
              } : {})
            },
            orderBy: { dateIso: 'desc' },
            take: limit,
          });

          return ok(logs.map(l => ({
            id: l.id,
            user: l.user,
            action: l.action,
            module: l.module,
            details: l.details,
            timestamp: l.dateIso.toISOString(),
          })));
        } catch (e) {
          return err(`Erreur de recherche : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
  }

  // ── OVERVIEW LAYOUT (MCP) ──────────────────────────────────────────────────

  if (shouldRegister('WRITE_MEMBERS')) {
    server.registerTool(
      'get_overview_layout',
      {
        description: 'Récupère la disposition (layout Bento) de la page d\'accueil du dashboard pour un utilisateur donné. Retourne la liste des modules visibles avec leurs tailles.',
        inputSchema: {
          user_id: z.string().describe('ID Discord de l\'utilisateur dont on veut voir le layout'),
          key_name: z.string().optional().describe('Nom de la clé MCP pour audit'),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ user_id, key_name }) => {
        try {
          const settings = await prisma.dashboardUserSettings.findUnique({
            where: { guildId_userId: { guildId, userId: user_id } },
          });

          if (!settings || !settings.bentoLayout) {
            return ok({
              userId: user_id,
              layout: null,
              message: 'Aucun layout personnalisé. L\'utilisateur utilise le layout par défaut.',
              defaultModules: ['liveStats', 'analytics', 'system', 'channels', 'moderation', 'members', 'notifications', 'staff', 'audit', 'actions'],
            });
          }

          return ok({
            userId: user_id,
            layout: settings.bentoLayout,
          });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'update_overview_layout',
      {
        description:
          'Modifie la disposition (layout Bento) de la page d\'accueil du dashboard pour un utilisateur. ' +
          'Chaque module est un objet { id, colSpan (1-3), rowSpan (1-3), visible (true/false) }. ' +
          'Modules disponibles : liveStats, analytics, system, channels, moderation, members, notifications, staff, audit, actions, notes, serverInfo, botHosting, news, quickGuide, clockWeather, economy, leveling, tickets, invites, events, polls.',
        inputSchema: {
          user_id: z.string().describe('ID Discord de l\'utilisateur cible'),
          layout: z.array(z.object({
            id: z.string().describe('Identifiant du module'),
            colSpan: z.number().int().min(1).max(3).default(1).describe('Nombre de colonnes (1-3)'),
            rowSpan: z.number().int().min(1).max(3).default(1).describe('Nombre de lignes (1-3)'),
            visible: z.boolean().default(true).describe('Module visible ou masqué'),
          })).describe('Liste ordonnée des modules avec leur configuration'),
          key_name: z.string().optional().describe('Nom de la clé MCP pour audit'),
        },
        _meta: toolMeta,
      },
      guard('WRITE_MEMBERS', async ({ user_id, layout, key_name }) => {
        try {
          const validModules = new Set([
            'liveStats', 'analytics', 'system', 'channels', 'moderation', 'members',
            'notifications', 'staff', 'audit', 'actions', 'notes', 'serverInfo',
            'botHosting', 'news', 'quickGuide', 'clockWeather', 'economy', 'leveling',
            'tickets', 'invites', 'events', 'polls',
          ]);

          const sanitized = layout
            .filter((m: any) => validModules.has(m.id))
            .map((m: any) => ({
              id: m.id,
              colSpan: Math.max(1, Math.min(3, m.colSpan ?? 1)),
              rowSpan: Math.max(1, Math.min(3, m.rowSpan ?? 1)),
              visible: m.visible !== false,
            }));

          await prisma.dashboardUserSettings.upsert({
            where: { guildId_userId: { guildId, userId: user_id } },
            create: { guildId, userId: user_id, bentoLayout: sanitized },
            update: { bentoLayout: sanitized },
          });

          await audit(key_name, 'Layout Overview MCP - Mise à jour', `Utilisateur: ${user_id}`, `${sanitized.length} module(s) configuré(s)`);

          return ok({
            ok: true,
            userId: user_id,
            modulesCount: sanitized.length,
            visibleCount: sanitized.filter((m: any) => m.visible).length,
          });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
  }
}
