/** Outils MCP - write community 2 (permission WRITE_COMMUNITY). */
import {
  resolveModuleKey,
  setDashboardModuleStatus,
} from '../../../services/core/moduleActivationService.js';
import prisma from '../../../utils/db.js';
import { z } from 'zod';
import { type McpToolContext, err, ok } from '../toolkit.js';

export function registerWriteCommunity2Tools(ctx: McpToolContext) {
  const { server, guildId, shouldRegister, guard, toolMeta } = ctx;

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
        // La bascule passe par le service du dashboard : lui seul ecrit la cle
        // canonique que la garde d'execution relit, propage les dependances et
        // invalide son cache. L'ecriture directe qui vivait ici enregistrait le
        // nom recu tel quel, sous une cle que personne ne lit.
        const moduleKey = resolveModuleKey(module_name);
        if (!moduleKey) {
          return err(`Module sans equivalent dans le registre des modules : ${module_name}`);
        }

        try {
          const result = await setDashboardModuleStatus(guildId, moduleKey, enabled);

          if (config) {
            await prisma.dashboardFeatureConfig.update({
              where: { guildId_featureKey: { guildId, featureKey: result.moduleKey } },
              data: { metadata: config },
            });
          }

          return ok({
            ok: true,
            moduleName: result.moduleKey,
            enabled: result.enabled,
            enabledRequirements: result.enabledRequirements,
            disabledDependents: result.disabledDependents,
          });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
  }
}
