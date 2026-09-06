/** Routes dashboard du module `modules`. */
import { getModuleActivationStats, getModulePerformanceStats, getModuleStatsSummary, getModuleUsageStats, KOTBO_MODULES, type KotboModule } from '../../../../services/analytics/moduleStatsService.js';
import { CoreModuleError, PlanLockedError, setDashboardModuleStatus } from '../../../../services/core/moduleActivationService.js';
import { logger } from '../../../../utils/logger.js';
import { getGuildName, json, type ModuleStatus, pushAudit, readJsonBody } from '../../../shared.js';
import { type ModuleRouteContext } from './_shared.js';

export async function handleModuleToggleRoutes(ctx: ModuleRouteContext): Promise<boolean> {
  const { req, res, parts, url, client, guildId, method, auditUser, moduleKey } = ctx;

  // PUT /api/dashboard/guilds/:guildId/modules/:moduleId
  if (moduleKey === 'modules' && parts.length === 6 && method === 'PUT') {
    const moduleId = parts[5];
    try {
      const body = (await readJsonBody<{ status: ModuleStatus }>(req)) ?? { status: 'inactive' };

      const result = await setDashboardModuleStatus(guildId, moduleId, body.status === 'active');

      // La cascade fait partie du journal : sans elle, un module éteint « tout
      // seul » n'aurait aucune trace expliquant pourquoi.
      const cascade = [
        ...result.enabledRequirements.map((key) => `${key} activé (dépendance)`),
        ...result.disabledDependents.map((key) => `${key} désactivé (dépendant)`),
      ];

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Mise à jour module',
        context: getGuildName(client, guildId),
        module: result.moduleKey,
        eventType: 'Manuel',
        details: `Statut changé vers ${body.status}.${cascade.length > 0 ? ` En cascade : ${cascade.join(', ')}.` : ''}`,
        channelId: null
      });

      json(res, 200, { ok: true, ...result });
    } catch (err) {
      if (err instanceof CoreModuleError) {
        json(res, 400, { error: err.message, code: 'core_module' });
        return true;
      }
      // 402 et non 400 : ce n'est pas une requete malformee, c'est un module
      // qui se vend. Le dashboard s'en sert pour ouvrir la page des offres
      // plutot que d'afficher une erreur que l'administrateur ne peut pas
      // corriger lui-meme.
      if (err instanceof PlanLockedError) {
        json(res, 402, {
          error: err.message,
          code: 'plan_locked',
          moduleKey: err.moduleKey,
          currentPlan: err.currentPlan,
          requiredPlan: err.requiredPlan,
        });
        return true;
      }
      logger.error('ModulesAPI', 'Error updating module:', err);
      json(res, 500, { error: 'Erreur lors de la mise à jour du module' });
    }
    return true;
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

  return false;
}
