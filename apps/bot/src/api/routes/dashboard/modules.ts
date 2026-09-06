/**
 * Repartiteur des routes `/<guildId>/<moduleKey>/...` du dashboard.
 *
 * Chaque module vit dans ./modules/<moduleKey>.ts. Les branches testaient
 * toutes `moduleKey`, donc mutuellement exclusives : le switch est
 * equivalent a la chaine de `if` d origine, et l ordre des routes est
 * preserve a l interieur de chaque sous-routeur.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Client } from 'discord.js';
import type { AuthClaims, DashboardAccess } from '../../shared.js';
import type { ModuleRouteContext } from './modules/_shared.js';
import { handleModuleToggleRoutes } from './modules/modules.js';
import { handlePresetsRoutes } from './modules/presets.js';
import { handleSanctionsRoutes } from './modules/sanctions.js';
import { handleNicknameModerationRoutes } from './modules/nickname-moderation.js';
import { handleAutoThreadRoutes } from './modules/auto-thread.js';
import { handleChannelsManagementRoutes } from './modules/channels-management.js';
import { handleBannedWordsRoutes } from './modules/banned-words.js';
import { handleNotificationsRoutes } from './modules/notifications.js';
import { handleManagementRoutes } from './modules/management.js';
import { handleSettingsRoutes } from './modules/settings.js';
import { handleRegulationRoutes } from './modules/regulation.js';
import { handleNewsRoutes } from './modules/news.js';
import { handleCommandAccessRoutes } from './modules/command-access.js';
import { handleSocialFollowsRoutes } from './modules/social-follows.js';
import { handleTemplateRoutes } from './modules/template.js';
import { handleDailyAlgoProblemsRoutes } from './modules/daily-algo-problems.js';
import { handleInvitationsRoutes } from './modules/invitations.js';
import { handleDailyAlgoRunsRoutes } from './modules/daily-algo-runs.js';
import { handleDailyAlgoWeeksRoutes } from './modules/daily-algo-weeks.js';
import { handleDailyAlgoSubmissionsRoutes } from './modules/daily-algo-submissions.js';
import { handleImportRoutes } from './modules/import.js';
import { handleLogsRoutes } from './modules/logs.js';
import { handleTicketsRoutes } from './modules/tickets.js';
import { handleServerTemplateRoutes } from './modules/server-template.js';
import { handleStarboardRoutes } from './modules/starboard.js';

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
  const moduleKey = parts[4];

  const ctx: ModuleRouteContext = { req, res, parts, url, client, user, guildId, access, method, auditUser, moduleKey };

  switch (moduleKey) {
    case 'modules': return handleModuleToggleRoutes(ctx);
    case 'presets': return handlePresetsRoutes(ctx);
    case 'sanctions': return handleSanctionsRoutes(ctx);
    case 'nickname-moderation': return handleNicknameModerationRoutes(ctx);
    case 'auto-thread': return handleAutoThreadRoutes(ctx);
    case 'channels-management': return handleChannelsManagementRoutes(ctx);
    case 'banned-words': return handleBannedWordsRoutes(ctx);
    case 'notifications': return handleNotificationsRoutes(ctx);
    case 'management': return handleManagementRoutes(ctx);
    case 'settings': return handleSettingsRoutes(ctx);
    case 'regulation': return handleRegulationRoutes(ctx);
    case 'news': return handleNewsRoutes(ctx);
    case 'command-access': return handleCommandAccessRoutes(ctx);
    case 'social-follows': return handleSocialFollowsRoutes(ctx);
    case 'template': return handleTemplateRoutes(ctx);
    case 'daily-algo-problems': return handleDailyAlgoProblemsRoutes(ctx);
    case 'invitations': return handleInvitationsRoutes(ctx);
    case 'daily-algo-runs': return handleDailyAlgoRunsRoutes(ctx);
    case 'daily-algo-weeks': return handleDailyAlgoWeeksRoutes(ctx);
    case 'daily-algo-submissions': return handleDailyAlgoSubmissionsRoutes(ctx);
    case 'import': return handleImportRoutes(ctx);
    case 'logs': return handleLogsRoutes(ctx);
    case 'tickets': return handleTicketsRoutes(ctx);
    case 'server-template': return handleServerTemplateRoutes(ctx);
    case 'starboard': return handleStarboardRoutes(ctx);
    default: return false;
  }
}
