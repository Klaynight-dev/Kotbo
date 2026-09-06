import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import {
  json,
  verifyAuth,
  resolveAdminAccess,
  resolveDashboardAccess,
  resolveFeatureAccessMap,
  checkRateLimit,
  dashboardWriteRateLimiter,
  dashboardSensitiveRateLimiter,
} from '../shared.js';
import { getModuleDefinition, getModuleForApiSegment } from '@kotbo/contracts';
import { WIZARD_CONFIG_SEGMENTS, isGuildInOnboarding } from '../../services/core/onboardingGate.js';
import { isGuildActivated } from '../../utils/activation.js';
import { isModuleEnabled } from '../../services/core/moduleGate.js';
import { trackDashboardVisit } from '../../services/analytics/ghostActivityTracker.js';
import { cache } from '../../utils/cache.js';

// Sub-routers imports
import { handleGeneralRoutes, handleGuildGeneralRoutes } from './dashboard/general.js';
import { handleAnalyticsRoutes } from './dashboard/analytics.js';
import { handleRecruitmentWebhookRoute, handleRecruitmentRoutes } from './dashboard/recruitment.js';
import { handleRecruitmentFormRoutes } from './dashboard/recruitmentForms.js';
import { handleCustomFormRoutes } from './dashboard/customForms.js';
import { handleBanAppealRoutes } from './dashboard/banAppeals.js';
import { handleAdminLockRoutes } from './dashboard/adminLock.js';
import { handleMembersRoutes } from './dashboard/members.js';
import { handleLeadershipRoutes, handleGuildLeadershipRoutes } from './dashboard/leadership.js';
import { handleModulesRoutes } from './dashboard/modules.js';
import { handleEventsRoutes } from './dashboard/events.js';
import { handleGeneralistModulesRoutes } from './dashboard/generalistModules.js';
import { handleBackupRoutes } from './dashboard/backups.js';
import { handleScheduleRoutes } from './dashboard/schedules.js';
import { handleMigrationRoutes } from './dashboard/migration.js';
import { handleCampaignRoutes } from './dashboard/campaigns.js';
import { handleSetupRoutes } from './dashboard/setup.js';
import { handleMCPKeyRoutes } from './dashboard/mcp.js';
import { handleCustomBotRoutes } from './dashboard/customBot.js';
import { handleChannelLinkRoutes } from './dashboard/channelLinks.js';
import { handleStaffServerRoutes } from './dashboard/staffServer.js';
import { handleChannelHealthRoutes } from './dashboard/channelHealth.js';
import { handlePulseRoutes } from './dashboard/pulse.js';
import { handleHomeWidgetsRoutes } from './dashboard/homeWidgets.js';
import { handleReputationRoutes } from './dashboard/reputation.js';
import { handleSatisfactionRoutes } from './dashboard/satisfaction.js';
import { handleSeasonRoutes } from './dashboard/seasons.js';
import { handleRankedRoutes } from './dashboard/ranked.js';
import { handlePredictionRoutes } from './dashboard/predictions.js';
import { handleEvaluationRoutes } from './dashboard/evaluations.js';
import { handleMarketplaceRoutes } from './dashboard/marketplace.js';
import { handleQuestRoutes } from './dashboard/quests.js';
import { handleWidgetRoutes } from './dashboard/widget.js';
import { handleMessageLogRoutes } from './dashboard/messageLogs.js';
import { handleRaidProtectionRoutes } from './dashboard/raidProtection.js';
import { handleClansRoutes } from './dashboard/clans.js';
import { handleDropsRoutes } from './dashboard/drops.js';
import { handleGhostMembersRoutes } from './dashboard/ghostMembers.js';
import { handleAuditEventRoutes } from './dashboard/auditEvents.js';
import { handleWorkflowRoutes } from './dashboard/workflows.js';
import { handleSimulationRoutes } from './dashboard/simulation.js';

/**
 * Ce qu'un serveur non activé peut atteindre : sa mise en place, et rien
 * d'autre.
 *
 * La promesse faite à l'installation est « montez votre serveur, payez
 * ensuite » : la garde d'activation ne peut donc pas fermer les pages qui
 * servent précisément à le monter. Elle reste fermée sur tout le reste - un
 * serveur non activé configure, il n'exploite pas. L'essai gratuit ne change
 * rien à cette frontière : il commence à l'activation, pas avant.
 *
 * Ces segments écrivent réellement sur le serveur Discord (salons, rôles,
 * reprise d'un ancien bot). Ce n'est pas un trou : `resolveDashboardAccess`
 * a déjà vérifié plus haut que la personne administre ce serveur. Ce qu'on
 * ouvre ici, c'est le droit de préparer - pas celui d'entrer.
 *
 * Toute addition à cette liste ouvre une porte à qui n'a pas payé : n'y
 * mettre qu'un segment dont la page sert à *arriver* sur Kotbo.
 */
const ONBOARDING_SEGMENTS = new Set([
  // Reprise depuis un autre bot : détection, plan, application.
  'migration',
  // Pose de la structure : salons, rôles, catégories.
  'server-template',
  // Parcours de prise en main : ce qui est fait, ce qu'il reste.
  'setup',
  // Le paiement lui-même. Sans lui, la garde se refermerait sur sa propre
  // sortie : un serveur non activé n'aurait aucun moyen d'ouvrir la page de
  // règlement qui l'activerait.
  'billing',
  // La clôture du parcours quand il n'y a rien à payer. Même raison : c'est
  // l'autre sortie, et elle ne donne accès à rien d'autre.
  'onboarding',
]);

export async function handleDashboardRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client
): Promise<boolean> {
  const method = req.method;

  // 1. Check if the path belongs to api/dashboard
  if (parts[0] !== 'api' || parts[1] !== 'dashboard') {
    return false;
  }

  // 2. Bypass authentication for recruitment webhook (POST /api/dashboard/guilds/:guildId/recruitment/candidatures)
  if (parts.length === 6 && parts[2] === 'guilds' && parts[4] === 'recruitment' && parts[5] === 'candidatures' && method === 'POST') {
    if (await handleRecruitmentWebhookRoute(req, res, parts, client)) {
      return true;
    }
  }

  // 3. Enforce authentication for all other dashboard routes
  const user = await verifyAuth(req);
  if (!user) {
    json(res, 401, { error: 'Non authentifié' });
    return true;
  }

  // 4. Try general, non-guild-specific routes first (translate, list guilds, staff profile snapshots)
  if (await handleGeneralRoutes(req, res, parts, url, client, user)) {
    return true;
  }
  if (await handleLeadershipRoutes(req, res, parts, url, client, user)) {
    return true;
  }

  // 5. Check if it's a guild-specific route (/api/dashboard/guilds/:guildId/...)
  if (parts.length >= 4 && parts[2] === 'guilds') {
    const guildId = parts[3];

    // Check dashboard access
    const access = await resolveDashboardAccess(client, guildId, user.userId);
    if (!access.canViewDashboard) {
      json(res, 403, { error: 'Accès refusé au dashboard pour ce serveur.' });
      return true;
    }

    // Ghost Analyzer : consulter le dashboard d'un serveur est un signe de vie,
    // même pour un membre qui n'écrit jamais. Débounce à une visite par heure.
    trackDashboardVisit(guildId, user.userId);

    // Check guild activation (bypassed for owner and global admins, and during activation requests)
    const isGlobalAdmin = await resolveAdminAccess(client, user.userId);
    const isActivationRequest = parts.length === 5 && parts[4] === 'activate' && method === 'POST';
    const isGuildOnboarding = await isGuildInOnboarding(guildId);
    const isOnboardingRequest = ONBOARDING_SEGMENTS.has(parts[4] ?? '')
      || (isGuildOnboarding && WIZARD_CONFIG_SEGMENTS.has(parts[4] ?? ''));
    if (!isGuildActivated(guildId) && !isActivationRequest && !isOnboardingRequest && !isGlobalAdmin) {
      json(res, 403, { error: 'Activation requise', needsActivation: true });
      return true;
    }

    // Garde des modules : les routes d'un module éteint sont fermées, lecture
    // comprise. Sans elle, la page d'un module désactivé continuerait de se
    // charger et de s'enregistrer pour qui connaît son URL, alors même que le
    // bot n'exécute plus rien derrière.
    const routeModuleKey = getModuleForApiSegment(parts[4]);
    if (routeModuleKey && !(await isModuleEnabled(guildId, routeModuleKey))) {
      /**
       * Exception : le parcours de configuration.
       *
       * Il demande de régler la modération et l'accueil *avant* de payer -
       * c'est tout l'intérêt, on voit ce qu'on achète. Or ces modules ne
       * figurent pas dans l'offre FREE : cette garde refusait leurs écritures,
       * et le parcours butait à l'écran 5 sur un serveur qui n'avait, par
       * construction, encore rien pris.
       *
       * Ouvrir l'écriture n'ouvre pas le service : `moduleGate` continue
       * d'éteindre ces modules au runtime tant que l'offre ne les comprend
       * pas. La ligne est écrite, elle ne s'applique pas, et le paiement la
       * révèle sans qu'aucun traitement n'ait à repasser derrière.
       */
      const forWizard = WIZARD_CONFIG_SEGMENTS.has(parts[4] ?? '')
        && isGuildOnboarding;

      if (!forWizard) {
        json(res, 403, {
          error: `Le module « ${getModuleDefinition(routeModuleKey)?.name ?? routeModuleKey} » est désactivé sur ce serveur.`,
          code: 'module_disabled',
          moduleKey: routeModuleKey,
        });
        return true;
      }
    }

    // Gating check for write actions
    const isSanctionAction = (parts.length === 6 || parts.length === 7)
      && parts[4] === 'sanctions'
      && parts[5] === 'reports'
      && (method === 'POST' || method === 'PATCH');

    const isDailyAlgoReviewAction = parts.length === 6
      && parts[4] === 'daily-algo-submissions'
      && method === 'PATCH';

    const isStaffAbsenceAction = parts.length === 5
      && parts[4] === 'absences'
      && method === 'POST';

    const isMeetingAction = parts[4] === 'meetings'
      && (method === 'POST' || method === 'PATCH' || method === 'DELETE');

    const isNotificationAction = parts[4] === 'notifications';

    const isNewsAction = parts[4] === 'news'
      && (method === 'POST' || method === 'PATCH' || method === 'DELETE');

    // La fiche membre est un outil de modération : la note interne et les
    // actions de modération doivent rester accessibles sans droit de
    // configuration, sinon l'onglet « Notes Modérateur » renvoie une erreur
    // d'enregistrement à tous les modérateurs (issue #215). Le niveau d'accès
    // exact est revérifié dans handleMembersRoutes.
    const isMemberModerationAction = parts.length === 7
      && parts[4] === 'members'
      && ((parts[6] === 'note' && method === 'PATCH') || (parts[6] === 'actions' && method === 'POST'));

    // Les giveaways ont leurs propres rôles gestionnaires (onglet Configuration
    // de la page Concours) : lancer ou clôturer un tirage ne demande pas les
    // droits d'administration du dashboard. Le réglage de ces rôles, lui, reste
    // sous ce garde-fou. L'autorisation exacte est refaite dans
    // handleGeneralistModulesRoutes.
    const isGiveawayManagerAction = parts[4] === 'giveaways'
      && parts[5] !== 'config'
      && method !== 'GET';

    if (!access.canManageSettings && method !== 'GET' && !isSanctionAction && !isDailyAlgoReviewAction && !isStaffAbsenceAction && !isNotificationAction && !isMeetingAction && !isNewsAction && !isMemberModerationAction && !isGiveawayManagerAction) {
      json(res, 403, { error: 'Action réservée aux administrateurs du dashboard.' });
      return true;
    }

    if (isMemberModerationAction && access.level !== 'admin' && access.level !== 'moderator') {
      json(res, 403, { error: 'Action de modération non autorisée.' });
      return true;
    }

    if (isNewsAction && !access.canModerateContent) {
      json(res, 403, { error: 'Action de gestion des actualités non autorisée.' });
      return true;
    }

    if (isDailyAlgoReviewAction && !access.canModerateDailyAlgo) {
      json(res, 403, { error: 'Action de modération Daily Algo non autorisée.' });
      return true;
    }

    // Rate limiting des écritures.
    //
    // Point de passage unique : toutes les routes de guilde transitent par ici,
    // donc un seul garde-fou couvre les réglages, les clans, le Daily Algo et le
    // reste, sans avoir à y penser route par route.
    //
    // La clé est « membre + serveur » et non l'IP : deux administrateurs derrière
    // la même sortie réseau ne doivent pas se pénaliser mutuellement.
    if (method !== 'GET') {
      const rateKey = `${user.userId}:${guildId}`;

      // Plafond large : aucun usage humain ne l'atteint. Il sert a arreter net une
      // page qui partirait en boucle de requetes.
      if (!checkRateLimit(dashboardWriteRateLimiter, rateKey, 60, 60 * 1000)) {
        json(res, 429, { error: 'Trop de modifications en peu de temps. Réessayez dans une minute.' });
        return true;
      }

      // Actions coûteuses ou irréversibles : enregistrement de réglages, clôture
      // de semaine Daily Algo, mise en route d'un module (qui crée des salons
      // Discord), remises à zéro et distributions de clans.
      const isSensitiveWrite =
        (parts[4] === 'settings' && (method === 'PATCH' || method === 'PUT'))
        || (parts[4] === 'daily-algo-weeks' && parts[5] === 'close')
        || (parts[4] === 'tickets' && parts[5] === 'config' && parts[6] === 'setup')
        || (parts[4] === 'leveling' && parts[5] === 'level-up-channel')
        // Créer un emoji ajoute un asset permanent au serveur Discord :
        // rien ne le retire ensuite depuis le dashboard.
        || parts[4] === 'emojis'
        // Le prestige crée un salon d'annonce, et jusqu'à trente rôles d'un
        // coup : même catégorie que les mises en route ci-dessus.
        || (parts[4] === 'ranked' && parts[5] === 'announce-channel')
        || (parts[4] === 'ranked' && parts[5] === 'tier-roles' && parts[6] === 'provision')
        || (parts[4] === 'clans'
          && ['distribute', 'clear', 'reset-season', 'reset-all', 'rollback-season'].includes(parts[5] ?? ''));

      if (isSensitiveWrite && !checkRateLimit(dashboardSensitiveRateLimiter, rateKey, 10, 60 * 1000)) {
        json(res, 429, { error: 'Trop d\'enregistrements successifs. Réessayez dans une minute.' });
        return true;
      }
    }

    // Dispatch to guild-specific sub-routers
    if (await handleGuildGeneralRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleAnalyticsRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleRecruitmentRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleRecruitmentFormRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleCustomFormRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleBanAppealRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleAdminLockRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleRaidProtectionRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (['linked-accounts', 'detections', 'members', 'invitations'].includes(parts[4])) {
      const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      const member = discordGuild ? await discordGuild.members.fetch(user.userId).catch(() => null) : null;
      const roleIds = member ? member.roles.cache.map((r) => r.id) : [];
      const featureAccess = await resolveFeatureAccessMap(client, guildId, access, user.userId, roleIds);
      if (await handleMembersRoutes(req, res, parts, url, client, user, guildId, access, featureAccess)) {
        if (method !== 'GET') await cache.invalidateGuild(guildId);
        return true;
      }
    }
    if (await handleGuildLeadershipRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleModulesRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleGeneralistModulesRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleEventsRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleBackupRoutes(req, res, parts, url, client, user)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleScheduleRoutes(req, res, parts, url, client, user)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleMigrationRoutes(req, res, parts, url, client, user)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleCampaignRoutes(req, res, parts, url, client, user)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleSetupRoutes(req, res, parts, url, client, user)) {
      return true;
    }
    if (await handleMCPKeyRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleCustomBotRoutes(req, res, parts, url, client, user)) {
      return true;
    }
    if (await handleChannelLinkRoutes(req, res, parts, url, client, user, guildId)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleStaffServerRoutes(req, res, parts, url, client, user, guildId)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleChannelHealthRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handlePulseRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleHomeWidgetsRoutes(req, res, parts, url, client, user, guildId, access)) {
      return true;
    }
    if (await handleReputationRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleSatisfactionRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleSeasonRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleRankedRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handlePredictionRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleEvaluationRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleMarketplaceRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleQuestRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleWidgetRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleMessageLogRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleGhostMembersRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleAuditEventRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleWorkflowRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (await handleSimulationRoutes(req, res, parts, url, client, user, guildId, access)) {
      if (method !== 'GET') await cache.invalidateGuild(guildId);
      return true;
    }
    if (parts[4] === 'clans') {
      if (await handleClansRoutes(req, res, parts, client, user, guildId, access)) {
        if (method !== 'GET') await cache.invalidateGuild(guildId);
        return true;
      }
    }
    if (parts[4] === 'drops') {
      if (await handleDropsRoutes(req, res, parts, client, user, guildId, access)) {
        if (method !== 'GET') await cache.invalidateGuild(guildId);
        return true;
      }
    }
  }

  return false;
}
