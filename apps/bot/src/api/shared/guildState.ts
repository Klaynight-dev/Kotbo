/** Etat complet d une guilde et acces par fonctionnalite. */
import { ChannelType, PermissionFlagsBits, type Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { cache } from '../../utils/cache.js';
import { logger } from '../../utils/logger.js';
import { isStaffServerGuild } from '../../services/staff/staffServerService.js';
import { parseEvidenceLinks } from '../evidence.js';
import type {
  DashboardSanctionType,
  DashboardSanctionStatus,
  DashboardRole,
  SanctionItem,
  SanctionReportItem,
  
  
  
  
  
  
  
  
  
  
} from '@kotbo/contracts';
import { getOrCreateDefaultTables } from '../../services/moderation/sanctionTableService.js';
import {
  COMMAND_CATALOG,
  
  
} from '../../utils/commandAccess.js';
import { commands } from '../../commands.js';
import {
  MODULE_REGISTRY,
  canonicalModuleKey,
  getModuleDependents,
  normalizePlanKey,
  planForMemberCount,
  planIncludesModule,
} from '@kotbo/contracts';
import { getModuleStates } from '../../services/core/moduleGate.js';
import { canFinishOnboardingWithoutPayment, isOnboardingFeatureEnabled } from '../../services/core/onboardingGate.js';
import { getGuildName, getOrCreateRuntime, isRecruitmentAutoRejectEnabled, resolveAdminAccess } from './core.js';
import type { AuditEntry, CommandCatalogEntry, DashboardAccess, DashboardChannel, DashboardState, FeatureAccess, FeatureAccessMap, ModuleItem, ModuleStatus, RegulationRuleItem } from './core.js';
import { interpretMentions } from './markdown.js';

export async function resolveFeatureAccessMap(
  client: Client,
  guildId: string,
  access: DashboardAccess,
  userId: string | null,
  roleIds: string[],
): Promise<FeatureAccessMap> {
  const { getOrCreateFeatureConfigs } = await import('../../services/core/dashboardManagementService.js');
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

  const featureAccess: FeatureAccessMap = Object.create(null);
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

  return featureAccess;
}

/**
 * Droits par fonctionnalite du membre courant, roles Discord resolus au passage.
 *
 * Les routes n ont que l identifiant de l utilisateur : sans les roles, tous les
 * acces configures par role seraient ignores et la fonction rendrait un refus.
 * Un membre introuvable (parti du serveur) repart avec zero role, donc refuse
 * partout ou une regle existe.
 */
export async function resolveMemberFeatureAccess(
  client: Client,
  guildId: string,
  access: DashboardAccess,
  userId: string,
): Promise<FeatureAccessMap> {
  const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  const member = discordGuild ? await discordGuild.members.fetch(userId).catch(() => null) : null;
  const roleIds = member
    ? member.roles.cache
        .map((role) => role?.id)
        .filter((roleId): roleId is string => !!roleId)
    : [];

  return resolveFeatureAccessMap(client, guildId, access, userId, roleIds);
}

const COMMAND_CATEGORIES: Record<string, string> = {
  // Administration
  setup: 'Administration',
  config: 'Administration',
  admin: 'Administration',
  status: 'Administration',
  activate: 'Administration',
  link: 'Administration',
  staffserver: 'Administration',
  channelhealth: 'Administration',
  absent: 'Administration',
  meeting: 'Administration',
  demission: 'Administration',

  // Modération
  sanction: 'Modération',
  dc: 'Modération',
  rescan: 'Modération',
  casier: 'Modération',
  note: 'Modération',
  transcript: 'Modération',
  clear: 'Modération',
  channel: 'Modération',
  signal: 'Modération',
  role: 'Modération',

  // Économie
  buy: 'Économie',
  daily: 'Économie',
  coins: 'Économie',
  dice: 'Économie',
  economyInfo: 'Économie',
  games: 'Économie',
  giveCoins: 'Économie',
  giveItem: 'Économie',
  guess: 'Économie',
  items: 'Économie',
  removeCoins: 'Économie',
  removeItem: 'Économie',
  richest: 'Économie',
  rps: 'Économie',
  roulette: 'Économie',
  shop: 'Économie',
  spawnItem: 'Économie',
  use: 'Économie',
  work: 'Économie',
  market: 'Économie',

  // Utilitaire
  ping: 'Utilitaire',
  info: 'Utilitaire',
  epoch: 'Utilitaire',
  devutils: 'Utilitaire',
  help: 'Utilitaire',
  post: 'Utilitaire',
  stats: 'Utilitaire',
  invites: 'Utilitaire',
  serverstats: 'Utilitaire',
  event: 'Utilitaire',
  ticket: 'Utilitaire',
  suggest: 'Utilitaire',
  suggestionConfig: 'Utilitaire',
  dashboard: 'Utilitaire',

  // Profil & Commu
  profile: 'Communauté',
  profil: 'Communauté',
  rank: 'Communauté',
  leaderboard: 'Communauté',
  rep: 'Communauté',
  quests: 'Communauté',
  giveaway: 'Communauté',

  // Fun / Autre
  excuse: 'Fun',
  dailyAlgo: 'Fun',
  ctf: 'Fun',
  say: 'Fun'
};

/**
 * Le catalogue ne depend que de `commands`, fige au demarrage du processus.
 * Le reconstruire a chaque lecture d etat serialisait toutes les definitions de
 * commandes (`toJSON()` deroule chaque option) pour un resultat identique.
 */
let richCommandCatalog: CommandCatalogEntry[] | null = null;

export function buildRichCommandCatalog(): CommandCatalogEntry[] {
  if (richCommandCatalog) return richCommandCatalog;

  const catalogMap = new Map(COMMAND_CATALOG.map(c => [c.name, c]));

  richCommandCatalog = commands.map(cmd => {
    const serialized = typeof (cmd.data as any).toJSON === 'function' ? (cmd.data as any).toJSON() : cmd.data;
    const name = serialized.name;
    const staticMeta = catalogMap.get(name);
    
    // Titre/label convivial
    let label = staticMeta?.label || (name.charAt(0).toUpperCase() + name.slice(1));
    if (name === 'dailyAlgo') label = 'Daily Algo';
    if (name === 'devutils') label = 'Outils Dev';
    if (name === 'serverstats') label = 'Stats Serveur';
    if (name === 'suggestionConfig') label = 'Config Suggestions';
    if (name === 'staffserver') label = 'Serveur Staff';
    if (name === 'channelhealth') label = 'Santé Salons';
    if (name === 'economyInfo') label = 'Éco Infos';
    if (name === 'giveCoins') label = 'Donner pièces';
    if (name === 'giveItem') label = 'Donner objet';
    if (name === 'removeCoins') label = 'Retirer pièces';
    if (name === 'removeItem') label = 'Retirer objet';
    if (name === 'spawnItem') label = 'Générer objet';
    
    // Détermination de l'accès par défaut si non spécifié statiquement
    let defaultAccess = staticMeta?.defaultAccess;
    if (!defaultAccess) {
      const perms = serialized.default_member_permissions;
      if (perms) {
        const adminFlag = BigInt(perms) & BigInt(PermissionFlagsBits.Administrator);
        const manageGuildFlag = BigInt(perms) & BigInt(PermissionFlagsBits.ManageGuild);
        if (adminFlag) {
          defaultAccess = 'administration';
        } else if (manageGuildFlag) {
          defaultAccess = 'modération';
        } else {
          defaultAccess = 'tout_le_monde';
        }
      } else {
        defaultAccess = 'tout_le_monde';
      }
    }
    
    const category = COMMAND_CATEGORIES[name] || 'Autre';

    return {
      name,
      label,
      description: serialized.description || staticMeta?.description || '',
      defaultAccess: defaultAccess as any,
      category,
      options: serialized.options || []
    };
  });

  return richCommandCatalog;
}

/**
 * Nombre total de soumissions Daily Algo du serveur.
 *
 * Ce compteur ne sert qu a afficher un nombre d interactions sur la page des
 * modules, mais il se compte par jointure sur une table qui grossit sans borne :
 * le recalculer a chaque lecture d etat coutait de plus en plus cher a mesure
 * que le serveur vieillissait. Une minute de retard sur un compteur d affichage
 * est sans consequence, et `cache.invalidateGuild` le purge comme le reste
 * grace au prefixe `guild:<id>:`.
 */
const DAILY_ALGO_COUNT_TTL_SECONDS = 60;

async function countDailyAlgoSubmissions(guildId: string): Promise<number> {
  const cacheKey = `guild:${guildId}:daily-algo-submission-count`;
  const cached = await cache.get<number>(cacheKey);
  if (typeof cached === 'number') return cached;

  const count = await prisma.dailyAlgoSubmission.count({ where: { run: { guildId } } });
  await cache.set(cacheKey, count, DAILY_ALGO_COUNT_TTL_SECONDS);
  return count;
}

export const getGuildState = async (
  client: Client,
  guildId: string,
  access: DashboardAccess,
  userId?: string,
  options: { overview?: boolean } = {},
): Promise<DashboardState | null> => {
  const overview = options.overview === true;
  const { ensureDashboardSchemaPatches } = await import('../../utils/schemaPatches.js');
  await ensureDashboardSchemaPatches();

  const guild = await prisma.guild.findUnique({ 
    where: { id: guildId },
    include: {
      // `dashboardFeatureConfigs` n est pas lu ici : resolveFeatureAccessMap les
      // recharge lui-meme avec les relations dont il a besoin. Les inclure
      // ramenait toute la table de configuration a chaque lecture d etat.
      levelConfig: true,
      autoModConfig: { select: { adminLockEnabled: true } }
    }
  });
  if (!guild) return null;

  const last7Days: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    last7Days.push(dateKey);
  }

  // Une lecture de l'accueil ne doit jamais effectuer d'initialisation. Les
  // tables par défaut sont créées sur le chargement complet / à l'activation.
  if (!overview) {
    await getOrCreateDefaultTables(guildId).catch((err) => {
      logger.error('DashboardAPI', `Failed to seed default sanction tables for guild ${guildId}:`, err);
    });
  }

  const [
    dailyAlgoSubmissionCount,
    runtime,
    persistedDashboardAudit,
    persistedDiscordAudit,
    sanctions,
    sanctionReports,
    regulationRules,
    dailyStatsTrend,
    sanctionTables,
    declaredStaffRoles,
  ] = await Promise.all([
    countDailyAlgoSubmissions(guildId),
    getOrCreateRuntime(guildId),
    prisma.dashboardAuditLog.findMany({
      where: { guildId, eventType: { not: 'Discord' } },
      orderBy: { dateIso: 'desc' },
      take: overview ? 15 : 300
    }),
    prisma.dashboardAuditLog.findMany({
      where: { guildId, eventType: 'Discord' },
      orderBy: { dateIso: 'desc' },
      take: overview ? 15 : 500
    }),
    overview
      ? Promise.resolve([])
      : prisma.sanction.findMany({
          where: { guildId },
          orderBy: { createdAt: 'desc' },
          take: 200,
        }),
    overview
      ? Promise.resolve([])
      : prisma.sanctionReport.findMany({
          where: { guildId },
          orderBy: { createdAt: 'desc' },
          take: 200,
        }),
    overview
      ? Promise.resolve([])
      : prisma.guildRegulationArticle.findMany({
          where: { guildId },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        }),
    prisma.guildDailyStat.findMany({
      where: {
        guildId,
        dateKey: { in: last7Days }
      }
    }),
    overview
      ? Promise.resolve([])
      : prisma.sanctionTable.findMany({
          where: { guildId },
          include: {
            tiers: {
              orderBy: { level: 'asc' }
            }
          }
        }),
    overview
      ? Promise.resolve([] as Array<{ discordRoleId: string | null }>)
      : prisma.staffRole.findMany({
          where: { guildId, enabled: true, discordRoleId: { not: null } },
          select: { discordRoleId: true },
        }),
  ]);

  const persistedAudit = [...persistedDashboardAudit, ...persistedDiscordAudit].sort(
    (a, b) => b.dateIso.getTime() - a.dateIso.getTime()
  );

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
    archivedAt: entry.archivedAt?.toISOString() ?? null,
    archiveReason: entry.archiveReason ?? null,
    appealable: entry.appealable,
    appealLockReason: entry.appealLockReason ?? null,
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
    evidenceLinks: parseEvidenceLinks(entry.evidenceLinks),
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

  // Etat des modules : le registre fait la liste, la garde d execution donne
  // la valeur. La page affiche donc exactement ce que le bot applique, alors
  // qu un tableau code en dur ici avait fini par decrire d autres modules que
  // ceux reellement branches.
  const moduleStates = await getModuleStates(guildId);

  // Compteurs propres a quelques modules, faute de mesure generique.
  const interactionsByModule: Record<string, number> = {
    daily_algo: dailyAlgoSubmissionCount,
    sanctions: sanctions.length,
    activity: auditTrailFromDb.length,
  };

  // L'offre du serveur : `moduleStates` a deja eteint ce qu'elle ne comprend
  // pas, mais la page a besoin de distinguer « eteint par choix » de
  // « verrouille faute d abonnement » - ce ne sont pas les memes boutons.
  const guildPlan = normalizePlanKey(guild.plan);
  // Offre a proposer devant un cadenas. Les offres payantes portant le meme
  // catalogue, ce n est plus « la premiere qui contient ce module » mais celle
  // qui correspond a la taille du serveur : c est la seule souscriptible.
  const purchasablePlan = planForMemberCount(client.guilds.cache.get(guildId)?.memberCount ?? null);

  /**
   * Ce serveur a-t-il un tableau de bord, ou seulement un tunnel ?
   *
   * Ce n'est pas `activated` qui repond : un serveur s'active tout seul en
   * arrivant (`activateGuildSelfServe`), en offre FREE. S'y fier revenait a
   * traiter comme installe quelqu'un qui vient a peine d'inviter le bot, et a
   * lui servir la coquille complete - barre laterale, en-tete, cinquante pages
   * verrouillees - au lieu de la configuration guidee qu'il attendait.
   *
   * Ce n'est plus l'offre non plus. La deduire de « FREE, sans abonnement, sans
   * acces accorde, sans code » faisait disparaitre le tunnel de tout serveur
   * qu'un geste commercial avait servi sans qu'il l'ait jamais traverse - et
   * comme ces gestes appartiennent aux administrateurs du bot, leurs serveurs y
   * echappaient toujours. Une seule chose repond desormais : le parcours a-t-il
   * ete mene a son terme (`onboardingCompletedAt`). Qui regarde la page n'entre
   * pas dans la reponse.
   *
   * Sans facturation sur l'instance en production, jamais : une installation
   * auto-hebergee n'a pas d'offre a vendre, et le tunnel s'ouvrirait sur un
   * ecran de mise en service qui n'a rien a proposer, sauf si ENABLE_ONBOARDING
   * est actif. En developpement, on presente le tunnel pour initialiser le
   * serveur.
   */
  const onboardingRequired = isOnboardingFeatureEnabled() && !guild.onboardingCompletedAt;

  /**
   * Le dernier ecran du tunnel a-t-il autre chose a proposer que Stripe ?
   *
   * Un serveur deja servi - offre posee a la main, abonnement en cours, code de
   * partenariat - traverse le tunnel comme les autres, mais on ne peut pas lui
   * reclamer un paiement qu'on lui avait justement epargne : il le termine par
   * un simple « Acceder au tableau de bord ».
   */
  const onboardingCanFinishWithoutPayment = canFinishOnboardingWithoutPayment(guild);

  const modules: ModuleItem[] = MODULE_REGISTRY.map((definition) => {
    const requires = (definition.requires ?? []).map(canonicalModuleKey);
    const lockedByPlan = !definition.core && !planIncludesModule(guildPlan, definition.key);
    // Un module peut etre allume dans sa propre ligne et neanmoins inerte
    // parce qu il depend d un module eteint : la page doit le dire, sinon
    // l administrateur bascule un interrupteur qui ne change rien.
    const blockedBy = requires.filter((requirement) => moduleStates[requirement] === false);
    const enabled = moduleStates[definition.key] !== false;

    return {
      id: definition.key,
      name: definition.name,
      description: definition.description,
      status: (enabled ? 'active' : 'inactive') as ModuleStatus,
      uptime: enabled ? 100 : 0,
      interactions: interactionsByModule[definition.key] ?? 0,
      lastSync: guild.updatedAt.toISOString(),
      isFixed: definition.core === true,
      category: definition.category,
      icon: definition.icon,
      requires,
      dependents: getModuleDependents(definition.key),
      blockedBy,
      settingsPath: definition.paths?.[0],
      lockedByPlan,
      requiredPlan: lockedByPlan ? purchasablePlan : null,
    };
  });

  let discordGuild = client.guilds.cache.get(guildId) ?? null;
  if (!discordGuild) {
    discordGuild = await client.guilds.fetch(guildId).catch(() => null);
  }
  if (discordGuild && discordGuild.channels.cache.size === 0) {
    await discordGuild.channels.fetch().catch(() => null);
  }
  const currentMember = userId && discordGuild ? await discordGuild.members.fetch(userId).catch(() => null) : null;
  const currentRoleIds = currentMember
    ? currentMember.roles.cache
        .map((role) => role?.id)
        .filter((roleId): roleId is string => !!roleId)
    : [];
  const featureAccess = await resolveFeatureAccessMap(client, guildId, access, userId ?? null, currentRoleIds);

  const allChannels = discordGuild ? Array.from(discordGuild.channels.cache.values()) : [];
  const allRoles = discordGuild ? Array.from(discordGuild.roles.cache.values()) : [];

  const textChannelTypes = new Set([
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.GuildVoice,
    ChannelType.GuildForum,
    ChannelType.GuildMedia,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ]);

  const channelTypeLabel = (type: ChannelType): DashboardChannel['type'] => {
    switch (type) {
      case ChannelType.GuildAnnouncement: return 'announcement';
      case ChannelType.GuildVoice: return 'voice';
      case ChannelType.GuildForum: return 'forum';
      case ChannelType.GuildMedia: return 'media';
      case ChannelType.PublicThread:
      case ChannelType.PrivateThread:
      case ChannelType.AnnouncementThread:
        return 'thread';
      default: return 'text';
    }
  };

  const discordChannels: DashboardChannel[] = overview ? [] : allChannels
    .filter((channel) => textChannelTypes.has(channel.type))
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      mention: `<#${channel.id}>`,
      position: 'rawPosition' in channel ? channel.rawPosition : 0,
      type: channelTypeLabel(channel.type),
    }))
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'fr'))
    .map(({ id, name, mention, type }) => ({ id, name, mention, type }));

  const discordVoiceChannels: DashboardChannel[] = overview ? [] : allChannels
    .filter((channel) => channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice)
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      mention: `<#${channel.id}>`,
      position: channel.rawPosition ?? 0
    }))
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'fr'))
    .map(({ id, name, mention }) => ({ id, name, mention }));

  const discordCategories: DashboardChannel[] = overview ? [] : allChannels
    .filter((channel) => channel.type === ChannelType.GuildCategory)
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      mention: `<#${channel.id}>`,
      position: channel.rawPosition ?? 0
    }))
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'fr'))
    .map(({ id, name, mention }) => ({ id, name, mention }));

  const discordRoles: DashboardRole[] = overview ? [] : allRoles
    .filter((role) => role.name !== '@everyone' && !role.managed)
    .map((role) => ({
          id: role.id,
          name: role.name,
          mention: `<@&${role.id}>`,
          permissions: role.permissions.toArray(),
          position: role.position,
          // `hexColor` vaut #000000 quand le role n'a pas de couleur : on le
          // laisse tel quel, le dashboard sait afficher la pastille neutre.
          color: role.hexColor
    }))
    .sort((a, b) => b.position - a.position || a.name.localeCompare(a.name, 'fr'))
    .map(({ id, name, mention, permissions, position, color }) => ({ id, name, mention, permissions, position, color }));

  // Roles Discord qui donnent effectivement acces au dashboard : ceux rattaches
  // a un grade de la hierarchie staff, plus le role moderateur, qui ouvre
  // l'acces sans passer par elle. Poser une regle sur un autre role n'aurait
  // aucun effet, l'interface n'a donc pas a les proposer.
  const staffRoleIds = overview ? [] : [...new Set(
    [
      ...declaredStaffRoles.map((role) => role.discordRoleId),
      guild.moderatorRoleId,
    ].filter((roleId): roleId is string => !!roleId),
  )];

  const trendMap = new Map(dailyStatsTrend.map(s => [s.dateKey, s]));
  const messagesTrend = last7Days.map(dateKey => trendMap.get(dateKey)?.messagesCount ?? 0);
  const voiceTrend = last7Days.map(dateKey => trendMap.get(dateKey)?.voiceMinutes ?? 0);
  const joinsTrend = last7Days.map(dateKey => trendMap.get(dateKey)?.membersJoined ?? 0);
  const leavesTrend = last7Days.map(dateKey => trendMap.get(dateKey)?.membersLeft ?? 0);
  const sanctionsTrend = last7Days.map(dateKey => trendMap.get(dateKey)?.sanctionsCount ?? 0);
  const isStaffServer = await isStaffServerGuild(guildId);

  return {
    guildName: getGuildName(client, guildId),
    plan: guildPlan,
    onboardingRequired,
    onboardingCanFinishWithoutPayment,
    configChannelId: guild.configChannelId ?? '',
    logChannelId: guild.logChannelId ?? '',
    logIgnoredChannelIds: guild.logIgnoredChannelIds ?? [],
    regulationChannelId: guild.regulationChannelId ?? '',
    regulationMessageId: guild.regulationMessageId ?? null,
    regulationVerificationEnabled: guild.regulationVerificationEnabled,
    regulationRoleId: guild.regulationRoleId,
    regulationLockEnabled: guild.regulationLockEnabled,
    meetingAnnouncementChannelId: guild.meetingAnnouncementChannelId ?? '',
    meetingVoiceChannelId: guild.meetingVoiceChannelId ?? '',
    publicChannelId: guild.publicChannelId ?? '',
    newsChannelId: guild.newsChannelId ?? '',
    digestChannelId: guild.digestChannelId ?? '',
    dailyAlgoChannelId: guild.dailyAlgoChannelId ?? '',
    baseStaffRoleId: guild.baseStaffRoleId ?? '',
    testStaffRoleId: guild.testStaffRoleId ?? '',
    propagateSanctions: guild.propagateSanctions,
    crossServerSanctionsEnabled: guild.crossServerSanctionsEnabled,
    sanctionReportEnabled: guild.sanctionReportEnabled,
    sanctionReportSkipBots: guild.sanctionReportSkipBots,
    translationEnabled: guild.translationEnabled,
    codePoliceEnabled: guild.codePoliceEnabled,
    dailyAlgoEnabled: guild.dailyAlgoEnabled,
    analyticsEnabled: guild.analyticsEnabled,
    dailyAlgoTimezone: guild.dailyAlgoTimezone,
    dailyAlgoParticipationPoints: guild.dailyAlgoParticipationPoints,
    dailyAlgoWeekendMultiplier: guild.dailyAlgoWeekendMultiplier,
    dailyAlgoWeeklyRewardsEnabled: guild.dailyAlgoWeeklyRewardsEnabled,
    dailyAlgoWeekRole1Id: guild.dailyAlgoWeekRole1Id ?? '',
    dailyAlgoWeekRole2Id: guild.dailyAlgoWeekRole2Id ?? '',
    dailyAlgoWeekRole3Id: guild.dailyAlgoWeekRole3Id ?? '',
    dailyAlgoWeekRoleRotate: guild.dailyAlgoWeekRoleRotate,
    dailyAlgoWeekXp1: guild.dailyAlgoWeekXp1,
    dailyAlgoWeekXp2: guild.dailyAlgoWeekXp2,
    dailyAlgoWeekXp3: guild.dailyAlgoWeekXp3,
    dailyAlgoWeekParticipationXp: guild.dailyAlgoWeekParticipationXp,
    dailyAlgoWeekAnnouncementChannelId: guild.dailyAlgoWeekAnnouncementChannelId ?? '',
    dailyAlgoSanctionType: guild.dailyAlgoSanctionType,
    dailyAlgoSanctionWeight: guild.dailyAlgoSanctionWeight,
    dailyAlgoSanctionDurationMinutes: guild.dailyAlgoSanctionDurationMinutes,
    clanPointsFromDailyAlgo: guild.clanPointsFromDailyAlgo,
    clanPointsFromDailyAlgoRate: guild.clanPointsFromDailyAlgoRate,
    clanPointsDailyAlgoTop1: guild.clanPointsDailyAlgoTop1,
    clanPointsDailyAlgoTop2: guild.clanPointsDailyAlgoTop2,
    clanPointsDailyAlgoTop3: guild.clanPointsDailyAlgoTop3,
    githubReleasesEnabled: guild.githubReleasesEnabled,
    digestEnabled: guild.digestEnabled,
    autoThreadEnabled: guild.autoThreadEnabled,
    autoThreadChannels: guild.autoThreadChannels,
    autoThreadBotsEnabled: guild.autoThreadBotsEnabled,
    funEnabled: guild.funEnabled,
    economyEnabled: guild.economyEnabled,
    levelingEnabled: guild.levelConfig?.enabled ?? false,
    adminLockEnabled: guild.autoModConfig?.adminLockEnabled ?? false,
    isStaffServer,
    funCountingChannelId: guild.funCountingChannelId ?? '',
    funOneWordStoryChannelId: guild.funOneWordStoryChannelId ?? '',
    funGuessNumberChannelId: guild.funGuessNumberChannelId ?? '',
    funWordChainChannelId: guild.funWordChainChannelId ?? '',
    funEmojiRiddleChannelId: guild.funEmojiRiddleChannelId ?? '',
    funNeverSayChannelId: guild.funNeverSayChannelId ?? '',
    funEmojiOnlyChannelId: guild.funEmojiOnlyChannelId ?? '',
    funPunitiveMode: guild.funPunitiveMode,
    youtubeEnabled: moduleStates.youtube !== false,
    twitchEnabled: moduleStates.twitch !== false,
    socialNetworksEnabled: moduleStates.social_networks !== false,
    recruitmentCategoryId: guild.recruitmentCategoryId ?? '',
    recruitmentLogChannelId: guild.recruitmentLogChannelId ?? '',
    recruitmentAutoRejectEnabled: isRecruitmentAutoRejectEnabled(guildId),
    modules,
    moduleStates,
    discordChannels,
    discordVoiceChannels,
    discordCategories,
    discordRoles,
    staffRoleIds,
    moderatorRoleId: guild.moderatorRoleId ?? '',
    commandRestrictions: runtime.commandRestrictions,
    sidebarFavorites: runtime.sidebarFavorites,
    commandCatalog: overview ? [] : buildRichCommandCatalog(),
    access: {
      level: access.level === 'admin' ? 'admin' : 'moderator',
      canModerateContent: access.canModerateContent,
      canModerateDailyAlgo: access.canModerateDailyAlgo,
      // Ce drapeau vaut "administrateur", pas "configure quelque chose quelque
      // part". Le relever des qu'une fonctionnalite est configurable annulait
      // tout le systeme de droits par role : les pages le lisent en `||` apres
      // leur propre `featureAccess.<cle>.canConfigure`, donc un role autorise a
      // configurer un seul module deverrouillait les boutons d'edition de
      // toutes les autres pages. Le serveur, lui, a toujours refuse - il lit le
      // vrai droit, jamais cette copie envoyee au navigateur.
      canManageSettings: access.canManageSettings,
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
    auditTrail: auditTrailFromDb,
    sanctions: mappedSanctions,
    sanctionReports: mappedSanctionReports,
    sanctionTables: (sanctionTables || []).map((table) => ({
      id: table.id,
      name: table.name,
      tiers: (table.tiers || []).map((tier) => ({
        id: tier.id,
        level: tier.level,
        action: tier.action,
        durationSeconds: tier.durationSeconds,
        customReason: tier.customReason,
      })),
    })),
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
