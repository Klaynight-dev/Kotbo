import type { Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';
import { getDeclaredModuleStates } from './moduleGate.js';

export const defaultFeatures = [
  // ─── Tableau de bord ───
  {
    featureKey: 'dashboard',
    featureName: "Vue d'ensemble",
    description: "Page d'accueil du tableau de bord",
    category: 'dashboard',
  },
  {
    featureKey: 'analytics',
    featureName: 'Analytics',
    description: 'Statistiques et graphiques du serveur',
    category: 'dashboard',
  },
  {
    featureKey: 'inbox',
    featureName: 'Inbox / Notifications',
    description: 'Boîte de réception et notifications',
    category: 'dashboard',
  },
  // ─── Modération ───
  {
    featureKey: 'content',
    featureName: 'Contenu',
    description: 'Gestion du contenu et messages',
    category: 'moderation',
  },
  {
    featureKey: 'daily_algo',
    featureName: 'Daily Algo',
    description: 'Défis algorithmiques quotidiens',
    category: 'moderation',
  },
  {
    featureKey: 'members',
    featureName: 'Membres',
    description: 'Recherche et gestion des membres',
    category: 'moderation',
  },
  {
    featureKey: 'sanctions',
    featureName: 'Sanctions',
    description: 'Gestion des sanctions et avertissements',
    category: 'moderation',
  },
  {
    featureKey: 'double_accounts',
    featureName: 'Doubles Comptes',
    description: 'Détection et gestion des doubles comptes',
    category: 'moderation',
  },
  {
    featureKey: 'logs',
    featureName: 'Logs Discord',
    description: 'Journaux de logs Discord',
    category: 'moderation',
  },
  {
    featureKey: 'nickname_moderation',
    featureName: 'Modération des pseudos',
    description: 'Renommage automatique des pseudos non conformes',
    category: 'moderation',
  },
  {
    featureKey: 'auto_thread',
    featureName: 'Auto-Thread',
    description: 'Création automatique de fils de discussion sur les messages',
    category: 'moderation',
  },
  {
    featureKey: 'activity',
    featureName: "Journal d'activité",
    description: "Suivi de l'activité utilisateur",
    category: 'moderation',
    isFixed: true, // Cannot be disabled
  },
  // ─── Gestion Staff ───
  {
    featureKey: 'recruitment',
    featureName: 'Recrutement',
    description: 'Gestion des candidatures staff',
    category: 'staff',
  },
  {
    featureKey: 'staff_directory',
    featureName: 'Annuaire Staff',
    description: 'Liste et profils des membres staff',
    category: 'staff',
  },
  {
    featureKey: 'staff_roles',
    featureName: 'Hiérarchie & Rôles',
    description: 'Gestion des rôles et niveaux staff',
    category: 'staff',
  },
  {
    featureKey: 'tutoring',
    featureName: 'Tutorat & Formation',
    description: "Périodes d'essai et mentorat",
    category: 'staff',
  },
  {
    featureKey: 'meetings',
    featureName: 'Réunions',
    description: 'Planification et suivi des réunions',
    category: 'staff',
  },
  {
    featureKey: 'absences',
    featureName: 'Absences',
    description: 'Gestion des absences du staff',
    category: 'staff',
  },
  {
    featureKey: 'polls',
    featureName: 'Sondages',
    description: 'Sondages internes au staff',
    category: 'staff',
  },
  {
    featureKey: 'discipline',
    featureName: 'Discipline',
    description: 'Avertissements et blacklist staff',
    category: 'staff',
  },
  {
    featureKey: 'events',
    featureName: 'Événements & Quiz',
    description: 'Organisation de quiz et événements communautaires',
    category: 'staff',
  },
  {
    featureKey: 'tickets',
    featureName: 'Tickets',
    description: 'Tickets de support, transcripts et blacklist',
    category: 'staff',
  },
  // ─── Gestion ───
  {
    featureKey: 'regulation',
    featureName: 'Règlement',
    description: 'Configuration du règlement serveur',
    category: 'management',
  },
  {
    featureKey: 'news',
    featureName: 'Actualités & RSS',
    description: "Publication d'articles par le staff et génération de flux RSS",
    category: 'management',
  },
  // ─── Configuration ───
  {
    featureKey: 'modules',
    featureName: 'Modules',
    description: 'Activation/désactivation des modules bot',
    category: 'config',
  },
  {
    featureKey: 'commands',
    featureName: 'Commandes',
    description: 'Accès et permissions des commandes',
    category: 'config',
  },
  {
    featureKey: 'settings',
    featureName: 'Paramètres',
    description: 'Paramètres généraux du serveur',
    category: 'config',
  },
  {
    featureKey: 'channel_health',
    featureName: 'Santé des salons',
    description: "Analyse d'activité et recommandations sur les salons",
    category: 'config',
  },
  // ─── Intégrations ───
  {
    featureKey: 'youtube',
    featureName: 'YouTube',
    description: 'Intégration YouTube et notifications',
    category: 'integrations',
  },
  {
    featureKey: 'twitch',
    featureName: 'Twitch',
    description: 'Intégration Twitch et notifications de live',
    category: 'integrations',
  },
  {
    featureKey: 'digest',
    featureName: 'Digest',
    description: 'Digest de nouvelles et flux RSS',
    category: 'integrations',
  },
  {
    featureKey: 'social_networks',
    featureName: 'Réseaux Sociaux',
    description: 'Configuration des flux YouTube et Twitch suivis',
    category: 'management',
  },
  {
    featureKey: 'profile',
    featureName: 'Profil',
    description: 'Gestion du profil utilisateur et préférences',
    category: 'dashboard',
  },
  // ─── Fonctionnalités Générales ───
  {
    featureKey: 'leveling',
    featureName: 'Leveling & XP',
    description: "Système d'expérience textuelle/vocale, niveaux et rôles récompenses",
    category: 'management',
  },
  {
    featureKey: 'giveaways',
    featureName: 'Giveaways',
    description: 'Organisation de concours et tirages au sort avec boutons',
    category: 'management',
  },
  {
    featureKey: 'welcome_goodbye',
    featureName: 'Accueil & Départ',
    description: 'Messages personnalisés de bienvenue et de départ dans des salons dédiés',
    category: 'management',
  },
  {
    featureKey: 'reaction_roles',
    featureName: 'Reaction Roles',
    description: 'Attribution automatique de rôles via des boutons cliquables',
    category: 'management',
  },
  {
    featureKey: 'auto_responses',
    featureName: 'Auto-Réponses',
    description: 'Réponses automatiques du bot déclenchées par des mots-clés',
    category: 'management',
  },
  {
    featureKey: 'automod',
    featureName: 'AutoMod',
    description: 'Modération automatique (anti-spam, anti-liens, majuscules, mentions, émojis)',
    category: 'moderation',
  },
  {
    featureKey: 'raid_protection',
    featureName: 'Protection anti-raid',
    description: "Vue d'ensemble sécurité et seuils anti-raid",
    category: 'moderation',
  },
  {
    featureKey: 'suggestions',
    featureName: 'Suggestions',
    description: 'Système de suggestions avec votes et modération via dashboard',
    category: 'management',
  },
  {
    featureKey: 'embed_builder',
    featureName: "Créateur d'Embeds",
    description: "Création et édition d'embeds personnalisés sur le serveur",
    category: 'management',
  },
  {
    featureKey: 'economy',
    featureName: 'Économie',
    description: 'Monnaie, boutique, marketplace et quêtes',
    category: 'management',
  },
  {
    featureKey: 'prestige',
    featureName: 'Prestige',
    description: 'Paliers de prestige et récompenses de fin de progression',
    category: 'management',
  },
  {
    featureKey: 'fun',
    featureName: 'Salons Fun',
    description: 'Comptage, histoire à un mot et devine le nombre',
    category: 'management',
  },
  {
    featureKey: 'workflows',
    featureName: 'Automatisations',
    description: 'Déclencheurs et workflows personnalisés',
    category: 'management',
  },
  // ─── Cross-Serveur ───
  {
    featureKey: 'channel_links',
    featureName: 'Liens de salons',
    description: 'Reliez des salons entre serveurs pour synchroniser les messages',
    category: 'cross_server',
  },
  {
    featureKey: 'staff_server',
    featureName: 'Serveurs Staff',
    description: 'Liez un serveur staff pour synchroniser la hiérarchie et les rôles',
    category: 'cross_server',
  },
];

export async function getOrCreateFeatureConfigs(guildId: string) {
  // 1. Fetch all existing configs with their relations first
  const existingConfigs = await prisma.dashboardFeatureConfig.findMany({
    where: { guildId },
    include: {
      roleAccess: {
        orderBy: { staffRoleLevel: 'asc' },
      },
      roleAccessByRole: {
        orderBy: { roleId: 'asc' },
      },
      notificationTargets: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  const existingKeys = new Set(existingConfigs.map(c => c.featureKey));
  const missingFeatures = defaultFeatures.filter(f => !existingKeys.has(f.featureKey));

  // 2. If none missing, return them immediately (saves a redundant findMany)
  if (missingFeatures.length === 0) {
    return existingConfigs;
  }

  // La ligne cree ici devient l'etat qui fait foi pour la garde de lecture :
  // l'ecrire a `true` allumait, a la premiere ouverture du Centre de gestion,
  // tous les modules qui demarrent eteints - niveaux, economie, Daily Algo,
  // auto-thread... On reprend donc l'etat deja declare ailleurs (table propre au
  // module, colonne historique, defaut du registre). L'offre commerciale et la
  // cascade des dependances restent hors de cette valeur : elles s'appliquent a
  // la lecture, et les figer ici gelerait l'offre du jour dans la base.
  const declaredStates = await getDeclaredModuleStates(guildId).catch(() => ({} as Record<string, boolean>));

  // 3. Initialize missing features in parallel
  //
  // Plusieurs requetes du dashboard tombent ici en meme temps sur une guilde a
  // qui il manque des lignes : le chargement de l etat et l appel de la page
  // ouverte partent ensemble, voient les memes fonctionnalites absentes et les
  // creent toutes les deux. La violation d unicite qui en resulte ne signale
  // pas une erreur, seulement que l autre requete a gagne la course.
  await Promise.all(missingFeatures.map(async (feature) => {
    try {
      await prisma.dashboardFeatureConfig.create({
        data: {
          guildId,
          featureKey: feature.featureKey,
          featureName: feature.featureName,
          enabled: declaredStates[feature.featureKey] ?? true,
          loggingEnabled: true,
          userActivityTracking: true,
          notifyViaDiscordChannel: true,
          notifyViaDM: false,
          roleAccess: {
            create: [
              { guildId, staffRoleLevel: 0, canView: true },
              { guildId, staffRoleLevel: 1, canView: true, canModerate: true },
              { guildId, staffRoleLevel: 2, canView: true, canModerate: true, canConfigure: true, canDelete: true },
            ],
          },
        },
      });
    } catch (err) {
      if ((err as { code?: string })?.code !== 'P2002') throw err;
    }
  }));

  // 4. Fetch again to return everything (only happens once when missing)
  return prisma.dashboardFeatureConfig.findMany({
    where: { guildId },
    include: {
      roleAccess: { orderBy: { staffRoleLevel: 'asc' } },
      roleAccessByRole: { orderBy: { roleId: 'asc' } },
      notificationTargets: true,
    },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Configuration d'une fonctionnalite - jamais son activation. `enabled` n'y
 * figure pas : l'ecrire ici changeait la colonne sans propager la cascade des
 * dependances, sans verifier l'offre, sans toucher la table propre au module et
 * sans purger le cache d'etats. Voir `setDashboardModuleStatus`.
 */
export async function updateFeatureConfig(
  guildId: string,
  featureKey: string,
  data: {
    channelId?: string | null;
    secondaryChannelId?: string | null;
    requiredRoleId?: string | null;
    notificationRoleId?: string | null;
    notifyViaDiscordChannel?: boolean;
    notifyViaDM?: boolean;
    loggingEnabled?: boolean;
    userActivityTracking?: boolean;
    metadata?: Record<string, unknown>;
  }
) {
  return prisma.dashboardFeatureConfig.update({
    where: {
      guildId_featureKey: { guildId, featureKey },
    },
    data: {
      ...data,
      metadata: data.metadata ? (data.metadata as Prisma.InputJsonValue) : undefined,
    },
    include: {
      roleAccess: true,
      notificationTargets: true,
    },
  });
}

export async function updateRoleAccess(
  guildId: string,
  featureConfigId: string,
  roleAccessConfigs: Array<{
    roleId: string;
    canView?: boolean;
    canModerate?: boolean;
    canConfigure?: boolean;
    canDelete?: boolean;
  }>
) {
  // Le vidage et la reecriture dans une seule transaction : separes, une
  // creation qui echoue laissait la fonctionnalite sans aucune regle, donc
  // ouverte a tout le staff, et rien ne disait que la matrice venait d'etre
  // perdue. C'est l'endroit ou un etat intermediaire coute le plus cher.
  await prisma.$transaction([
    prisma.dashboardFeatureRoleAccess.deleteMany({ where: { featureConfigId } }),
    ...roleAccessConfigs.map((config) =>
      prisma.dashboardFeatureRoleAccess.create({
        data: {
          guildId,
          featureConfigId,
          roleId: config.roleId,
          canView: config.canView ?? false,
          canModerate: config.canModerate ?? false,
          canConfigure: config.canConfigure ?? false,
          canDelete: config.canDelete ?? false,
        },
      })
    ),
  ]);

  return prisma.dashboardFeatureConfig.findUnique({
    where: { id: featureConfigId },
    include: {
      roleAccess: { orderBy: { staffRoleLevel: 'asc' } },
      roleAccessByRole: { orderBy: { roleId: 'asc' } },
      notificationTargets: true,
    },
  });
}

export async function applyPresetToFeatureAccess(
  guildId: string,
  presetKey: 'general' | 'gaming' | 'dev',
  roleIds: { adminRoleIds: string[]; modRoleIds: string[] }
) {
  const configs = await getOrCreateFeatureConfigs(guildId);
  
  const updates = configs.map(async (config) => {
    const featureKey = config.featureKey;
    
    // Clear existing per-role access for this feature to avoid conflicts
    await prisma.dashboardFeatureRoleAccess.deleteMany({
      where: { featureConfigId: config.id }
    });

    const roleAccessToCreate = [];

    // Default mapping based on preset
    for (const adminId of roleIds.adminRoleIds) {
      roleAccessToCreate.push({
        guildId,
        featureConfigId: config.id,
        roleId: adminId,
        canView: true,
        canModerate: true,
        canConfigure: true,
        canDelete: true
      });
    }

    for (const modId of roleIds.modRoleIds) {
      // Don't add if already added as admin
      if (roleIds.adminRoleIds.includes(modId)) continue;

      const isRestricted = ['settings', 'commands', 'discipline'].includes(featureKey);
      
      roleAccessToCreate.push({
        guildId,
        featureConfigId: config.id,
        roleId: modId,
        canView: true,
        canModerate: !isRestricted,
        canConfigure: false,
        canDelete: false
      });
    }

    if (roleAccessToCreate.length > 0) {
      await prisma.dashboardFeatureRoleAccess.createMany({
        data: roleAccessToCreate
      });
    }
  });

  await Promise.all(updates);
}
