/**
 * Point d'entree de l'enregistrement des outils MCP.
 *
 * Les definitions d'outils vivent dans ./tools/*.ts, un module par section
 * de permission. Ce fichier ne fait qu'assembler le contexte partage et les
 * appeler dans l'ordre d'origine (l'ordre d'enregistrement est significatif).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Client } from 'discord.js';
import prisma from '../../utils/db.js';
import type { McpKeyPermission } from '@prisma/client';
import { oauthSecuritySchemes, type McpToolConfig, type McpToolHandler, type McpToolContext, type ToolSecurityScheme, err } from './toolkit.js';
import { registerReadStatsTools } from './tools/read-stats.js';
import { registerReadMembersTools } from './tools/read-members.js';
import { registerReadSanctionsTools } from './tools/read-sanctions.js';
import { registerReadStaffTools } from './tools/read-staff.js';
import { registerReadTicketsTools } from './tools/read-tickets.js';
import { registerWriteSanctionsTools } from './tools/write-sanctions.js';
import { registerReadWorkflowsTools } from './tools/read-workflows.js';
import { registerWriteWorkflowsTools } from './tools/write-workflows.js';
import { registerReadServerNavigationTools } from './tools/read-server-navigation.js';
import { registerWriteMessagesTools } from './tools/write-messages.js';
import { registerWriteTicketsTools } from './tools/write-tickets.js';
import { registerReadCommunityTools } from './tools/read-community.js';
import { registerReadEconomyTools } from './tools/read-economy.js';
import { registerReadClanBetsTools } from './tools/read-clan-bets.js';
import { registerWriteClanBetsTools } from './tools/write-clan-bets.js';
import { registerReadModerationTools } from './tools/read-moderation.js';
import { registerReadAnalyticsTools } from './tools/read-analytics.js';
import { registerWriteCommunityTools } from './tools/write-community.js';
import { registerWriteCommunity2Tools } from './tools/write-community-2.js';
import { registerWriteMembersTools } from './tools/write-members.js';
import { registerWriteMembersAltAccountsTools } from './tools/write-members-alt-accounts.js';
import { registerWriteStaffLeadershipTools } from './tools/write-staff-leadership.js';
import { registerWriteCommunityNewTools } from './tools/write-community-new.js';
import { registerWriteTicketsNewTools } from './tools/write-tickets-new.js';
import { registerWriteMembersNewTools } from './tools/write-members-new.js';
import { registerReadServerAssetsTools } from './tools/read-server-assets.js';
import { registerReadMembersVoicePinsThreadsTools } from './tools/read-members-voice-pins-threads.js';
import { registerWriteServerAssetsTools } from './tools/write-server-assets.js';
import { registerSystemSafetyNewTools } from './tools/system-safety-new.js';
import { registerWriteChannelsTools } from './tools/write-channels.js';
import { registerReadStats2Tools } from './tools/read-stats-2.js';
import { registerWriteMembers2Tools } from './tools/write-members-2.js';
import { registerWriteWelcomeThreadTools } from './tools/write-welcome-thread.js';
import { registerDashboardAccessTools } from './tools/dashboard-access.js';

export function registerMcpTools(
  mcpServer: McpServer,
  guildId: string,
  permissions: McpKeyPermission[],
  client: Client,
  options: { listAllTools?: boolean; wwwAuthenticate?: string; securitySchemes?: ToolSecurityScheme[] } = {}
) {
  // Vue NON GÉNÉRIQUE de `mcpServer.registerTool` - ne pas remplacer par un
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

  const ctx: McpToolContext = { server, guildId, client, permissions, has, shouldRegister, guard, audit, toolMeta };

  registerReadStatsTools(ctx);
  registerReadMembersTools(ctx);
  registerReadSanctionsTools(ctx);
  registerReadStaffTools(ctx);
  registerReadTicketsTools(ctx);
  registerWriteSanctionsTools(ctx);
  registerReadWorkflowsTools(ctx);
  registerWriteWorkflowsTools(ctx);
  registerReadServerNavigationTools(ctx);
  registerWriteMessagesTools(ctx);
  registerWriteTicketsTools(ctx);
  registerReadCommunityTools(ctx);
  registerReadClanBetsTools(ctx);
  registerReadEconomyTools(ctx);
  registerReadModerationTools(ctx);
  registerReadAnalyticsTools(ctx);
  registerWriteCommunityTools(ctx);
  registerWriteCommunity2Tools(ctx);
  registerWriteClanBetsTools(ctx);
  registerWriteMembersTools(ctx);
  registerWriteMembersAltAccountsTools(ctx);
  registerWriteStaffLeadershipTools(ctx);
  registerWriteCommunityNewTools(ctx);
  registerWriteTicketsNewTools(ctx);
  registerWriteMembersNewTools(ctx);
  registerReadServerAssetsTools(ctx);
  registerReadMembersVoicePinsThreadsTools(ctx);
  registerWriteServerAssetsTools(ctx);
  registerSystemSafetyNewTools(ctx);
  registerWriteChannelsTools(ctx);
  registerReadStats2Tools(ctx);
  registerWriteMembers2Tools(ctx);
  registerWriteWelcomeThreadTools(ctx);
  registerDashboardAccessTools(ctx);
}
