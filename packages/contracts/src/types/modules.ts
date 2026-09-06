/**
 * Registre des modules Kotbo - source de vérité unique.
 *
 * Avant ce fichier, un module existait à trois endroits sans lien entre eux :
 * le tableau affiché par le dashboard (`api/shared/guildState.ts`), la liste
 * `defaultFeatures` de `dashboardManagementService`, et les colonnes booléennes
 * de `Guild`.
 * Les trois divergeaient - clés différentes (`traduction` / `translation`),
 * modules présents dans l'une et absents des autres - et surtout aucune n'était
 * consultée par le bot au moment d'exécuter la fonctionnalité. Éteindre un
 * module ne faisait donc que changer la couleur d'une pastille.
 *
 * Tout part maintenant d'ici : l'état affiché, l'état écrit en base, la garde
 * runtime du bot, le filtrage des routes API et la navigation du dashboard.
 * Ajouter un module, c'est ajouter une entrée dans `MODULE_REGISTRY` - les cinq
 * couches suivent.
 *
 * Ce paquet ne dépend de rien (ni Prisma, ni discord.js) : le dashboard
 * l'importe tel quel.
 */

export type ModuleCategory =
  | 'core'
  | 'moderation'
  | 'staff'
  | 'community'
  | 'content'
  | 'integrations'
  | 'cross_server';

export interface ModuleCategoryMeta {
  key: ModuleCategory;
  label: string;
  description: string;
  icon: string;
}

export const MODULE_CATEGORIES: ModuleCategoryMeta[] = [
  {
    key: 'core',
    label: 'Cœur',
    description: "Fondations du bot et du dashboard. Toujours actives.",
    icon: 'LayoutGrid',
  },
  {
    key: 'moderation',
    label: 'Modération & Sécurité',
    description: 'Sanctions, journaux, filtrage automatique et protection du serveur.',
    icon: 'ShieldCheck',
  },
  {
    key: 'staff',
    label: 'Gestion du staff',
    description: "Recrutement, hiérarchie, réunions, absences et suivi de l'équipe.",
    icon: 'Users',
  },
  {
    key: 'community',
    label: 'Communauté & Engagement',
    description: 'Progression, économie, jeux, événements et interactions des membres.',
    icon: 'Sparkles',
  },
  {
    key: 'content',
    label: 'Contenu & Communication',
    description: 'Règlement, accueil, actualités, réponses automatiques et publication.',
    icon: 'MessageSquare',
  },
  {
    key: 'integrations',
    label: 'Intégrations',
    description: 'Services externes branchés sur le serveur.',
    icon: 'Network',
  },
  {
    key: 'cross_server',
    label: 'Cross-serveur',
    description: 'Ponts entre plusieurs serveurs Discord.',
    icon: 'ArrowLeftRight',
  },
];

export interface ModuleDefinition {
  /** Clé canonique, celle stockée dans `DashboardFeatureConfig.featureKey`. */
  key: string;
  name: string;
  description: string;
  category: ModuleCategory;
  /** Nom d'icône Papicon utilisé par le dashboard. */
  icon: string;
  /**
   * Module indispensable : le toggle est verrouillé côté API comme côté page.
   * Éteindre la page « Modules » ou le journal d'activité rendrait le serveur
   * inadministrable, ou masquerait la trace de la manœuvre.
   */
  core?: boolean;
  /**
   * État retenu tant qu'aucune ligne `DashboardFeatureConfig` n'existe. Les
   * modules qui demandent une configuration préalable (une clé d'API, un salon)
   * démarrent éteints pour ne pas produire d'erreurs silencieuses.
   */
  defaultEnabled: boolean;
  /**
   * Colonnes booléennes de `Guild` tenues au même état que le module. Elles
   * restent la lecture rapide de nombreux services ; les écrire en même temps
   * évite l'incohérence « la page dit actif, le bot dit inactif ».
   */
  guildFields?: string[];
  /**
   * Colonne de `Guild` qui portait l'état avant ce registre. Sert de valeur par
   * défaut à la première lecture, pour qu'un serveur configuré de longue date
   * retrouve son état réel plutôt que `defaultEnabled`.
   */
  legacyField?: string;
  /** Clés historiques encore présentes en base ou dans d'anciennes URL. */
  aliases?: string[];
  /**
   * Modules nécessaires au fonctionnement de celui-ci. Éteindre un parent
   * éteint ses dépendants ; rallumer un dépendant rallume ses parents.
   */
  requires?: string[];
  /** Segments d'URL `/api/dashboard/guilds/:id/<segment>` rattachés au module. */
  apiSegments?: string[];
  /** Routes du dashboard rattachées au module. */
  paths?: string[];
  /** Préfixes de `customId` des boutons, menus et modals du module. */
  interactionPrefixes?: string[];
}

/**
 * `guildFields` liste toutes les colonnes à écrire ; `legacyField` désigne
 * celle qui fait foi en lecture. Les sanctions en portent deux (synchronisation
 * et rapports) que la page n'a jamais distinguées : elles vont ensemble.
 */
export const MODULE_REGISTRY: ModuleDefinition[] = [
  // ─────────────────────────── Cœur ───────────────────────────
  {
    key: 'dashboard',
    name: "Vue d'ensemble",
    description: "Page d'accueil du dashboard et widgets de synthèse.",
    category: 'core',
    icon: 'LayoutGrid',
    core: true,
    defaultEnabled: true,
    paths: ['/'],
  },
  {
    key: 'modules',
    name: 'Modules',
    description: 'Activation et configuration des modules du bot.',
    category: 'core',
    icon: 'Grid',
    core: true,
    defaultEnabled: true,
    apiSegments: ['modules', 'presets'],
    paths: ['/modules'],
  },
  {
    key: 'settings',
    name: 'Paramètres',
    description: 'Réglages généraux du serveur, salons système et rôles de base.',
    category: 'core',
    icon: 'Settings',
    core: true,
    defaultEnabled: true,
    apiSegments: ['settings'],
    paths: ['/settings'],
  },
  {
    key: 'commands',
    name: 'Commandes',
    description: 'Permissions et restrictions des commandes Discord.',
    category: 'core',
    icon: 'Code',
    core: true,
    defaultEnabled: true,
    apiSegments: ['command-access'],
    paths: ['/command-access'],
  },
  {
    key: 'activity',
    name: "Journal d'activité",
    description: "Trace horodatée des actions du staff sur le dashboard et Discord.",
    category: 'core',
    icon: 'ListChecks',
    core: true,
    defaultEnabled: true,
    paths: ['/activity'],
  },
  {
    key: 'members',
    name: 'Membres',
    description: 'Recherche, fiches membres et actions de modération individuelles.',
    category: 'core',
    icon: 'Users',
    core: true,
    defaultEnabled: true,
    apiSegments: ['members'],
    paths: ['/members'],
  },
  {
    key: 'profile',
    name: 'Profil',
    description: 'Profil personnel des membres et préférences de compte.',
    category: 'core',
    icon: 'User',
    core: true,
    defaultEnabled: true,
    paths: ['/profile'],
  },
  {
    key: 'inbox',
    name: 'Inbox',
    description: 'Boîte de réception des notifications du staff.',
    category: 'core',
    icon: 'Bell',
    core: true,
    defaultEnabled: true,
    paths: ['/inbox'],
  },

  // ──────────────────── Modération & Sécurité ────────────────────
  {
    key: 'sanctions',
    name: 'Sanctions',
    description: 'Avertissements, mutes, bans, casier et rapports de sanction.',
    category: 'moderation',
    icon: 'Gavel',
    defaultEnabled: true,
    guildFields: ['sanctionSyncEnabled', 'sanctionReportEnabled'],
    legacyField: 'sanctionReportEnabled',
    apiSegments: ['sanctions', 'sanction-tables'],
    paths: ['/security/sanctions'],
    interactionPrefixes: ['sanction_modal:', 'sanction:'],
  },
  {
    key: 'automod',
    name: 'AutoMod',
    description: 'Filtrage automatique : spam, liens, majuscules, mentions, mots bannis.',
    category: 'moderation',
    icon: 'ShieldAlert',
    defaultEnabled: true,
    apiSegments: ['automod', 'banned-words'],
    paths: ['/automod'],
    interactionPrefixes: ['adminlock:', 'adminlock_modal:'],
  },
  {
    key: 'logs',
    name: 'Logs Discord',
    description: "Journaux d'événements Discord : messages, salons, rôles, membres.",
    category: 'moderation',
    icon: 'FileText',
    defaultEnabled: true,
    apiSegments: ['logs', 'message-logs', 'audit-events'],
    paths: ['/logs'],
  },
  {
    key: 'nickname_moderation',
    name: 'Modération des pseudos',
    description: 'Détection et renommage automatique des pseudos non conformes.',
    category: 'moderation',
    icon: 'Type',
    defaultEnabled: false,
    guildFields: ['autoNicknameModerationEnabled'],
    legacyField: 'autoNicknameModerationEnabled',
    apiSegments: ['nickname-moderation'],
    paths: ['/security/filters/nicknames', '/nickname-moderation'],
  },
  {
    key: 'double_accounts',
    name: 'Doubles comptes',
    description: 'Détection des comptes multiples et rapprochement des identités.',
    category: 'moderation',
    icon: 'UserCheck',
    defaultEnabled: true,
    apiSegments: ['linked-accounts', 'detections'],
    paths: ['/security/accounts'],
    interactionPrefixes: ['dc_'],
  },
  {
    key: 'raid_protection',
    name: 'Protection anti-raid',
    description: "Détection des vagues d'arrivées et verrouillage automatique du serveur.",
    category: 'moderation',
    icon: 'Siren',
    defaultEnabled: true,
    apiSegments: ['raid-protection'],
    paths: ['/security/raid-protection'],
    interactionPrefixes: ['rprot:'],
  },
  {
    key: 'ban_appeals',
    name: 'Appels de bannissement',
    description: 'Formulaire public de contestation et traitement des demandes.',
    category: 'moderation',
    icon: 'Gavel',
    defaultEnabled: false,
    apiSegments: ['ban-appeals'],
    paths: ['/security/sanctions/appeals'],
    interactionPrefixes: ['appeal:', 'appeal_modal:', 'banhygiene:'],
  },
  {
    key: 'codepolice',
    name: 'Code Police',
    description: 'Vérification de la syntaxe et des bonnes pratiques sur les extraits de code.',
    category: 'moderation',
    icon: 'Code',
    defaultEnabled: false,
    guildFields: ['codePoliceEnabled'],
    legacyField: 'codePoliceEnabled',
    aliases: ['code_police'],
    apiSegments: ['code-police'],
    paths: ['/code-police'],
  },
  {
    key: 'security_verification',
    name: 'Vérification de sécurité',
    description: "Captcha et parcours de vérification à l'arrivée des membres.",
    category: 'moderation',
    icon: 'ScanFace',
    defaultEnabled: false,
    guildFields: ['verificationEnabled'],
    legacyField: 'verificationEnabled',
    apiSegments: ['verification'],
    paths: ['/security/verification'],
    interactionPrefixes: ['secverif_', 'vcaptcha:', 'verif_threshold_trigger:'],
  },

  // ───────────────────── Gestion du staff ─────────────────────
  {
    key: 'recruitment',
    name: 'Recrutement',
    description: 'Candidatures staff, formulaires et suivi des entretiens.',
    category: 'staff',
    icon: 'UserPlus',
    defaultEnabled: true,
    apiSegments: ['recruitment', 'recruitment-forms'],
    paths: ['/recruitment'],
    interactionPrefixes: ['recruit:'],
  },
  {
    key: 'staff_directory',
    name: 'Annuaire staff',
    description: "Liste, fiches et statistiques des membres de l'équipe.",
    category: 'staff',
    icon: 'BookOpen',
    defaultEnabled: true,
    apiSegments: ['staff'],
    paths: ['/staff-management'],
  },
  {
    key: 'staff_roles',
    name: 'Hiérarchie & rôles staff',
    description: 'Niveaux, promotions et synchronisation des rôles du staff.',
    category: 'staff',
    icon: 'Network',
    defaultEnabled: true,
    requires: ['staff_directory'],
    apiSegments: ['staff-roles', 'staff-hierarchies'],
    paths: ['/staff-management/roles'],
  },
  {
    key: 'tutoring',
    name: 'Tutorat & formation',
    description: "Périodes d'essai, mentorat et suivi des nouveaux staff.",
    category: 'staff',
    icon: 'GraduationCap',
    defaultEnabled: true,
    requires: ['staff_directory'],
    apiSegments: ['tutoring'],
    paths: ['/tutoring'],
  },
  {
    key: 'meetings',
    name: 'Réunions',
    description: "Planification, convocations et comptes rendus des réunions d'équipe.",
    category: 'staff',
    icon: 'CalendarDays',
    defaultEnabled: true,
    apiSegments: ['meetings'],
    paths: ['/planning'],
    interactionPrefixes: ['meeting_rsvp:', 'meeting_excuse_modal:'],
  },
  {
    key: 'absences',
    name: 'Absences',
    description: 'Déclaration et suivi des congés et indisponibilités du staff.',
    category: 'staff',
    icon: 'CalendarOff',
    defaultEnabled: true,
    apiSegments: ['absences'],
    paths: ['/planning/absences'],
  },
  {
    key: 'polls',
    name: 'Sondages staff',
    description: "Consultations internes à l'équipe avec vote et clôture.",
    category: 'staff',
    icon: 'ChartBar',
    defaultEnabled: true,
    apiSegments: ['staff-polls'],
    paths: ['/staff-management/polls'],
  },
  {
    key: 'discipline',
    name: 'Discipline staff',
    description: "Avertissements internes, blacklist et sanctions de l'équipe.",
    category: 'staff',
    icon: 'AlertTriangle',
    defaultEnabled: true,
    requires: ['staff_directory'],
    apiSegments: ['discipline'],
    paths: ['/staff-management/discipline'],
  },
  {
    key: 'evaluations',
    name: 'Évaluations',
    description: "Bilans périodiques et notation des membres de l'équipe.",
    category: 'staff',
    icon: 'Star',
    defaultEnabled: true,
    requires: ['staff_directory'],
    apiSegments: ['evaluations'],
    paths: ['/evaluations'],
  },

  // ────────────────── Communauté & Engagement ──────────────────
  {
    key: 'leveling',
    name: 'Leveling & XP',
    description: "Expérience texte et vocale, niveaux et rôles de récompense.",
    category: 'community',
    icon: 'TrendingUp',
    defaultEnabled: false,
    apiSegments: ['leveling'],
    paths: ['/leveling'],
  },
  {
    key: 'seasons',
    name: 'Saisons',
    description: 'Classements compétitifs à durée limitée et récompenses de fin de saison.',
    category: 'community',
    icon: 'Trophy',
    defaultEnabled: false,
    requires: ['leveling'],
    apiSegments: ['seasons'],
    paths: ['/seasons'],
  },
  {
    key: 'prestige',
    name: 'Prestige',
    description: "Points de prestige, paliers, séries d'activité et décroissance sur inactivité.",
    category: 'community',
    icon: 'Crown',
    defaultEnabled: false,
    // Les points de prestige dérivent de l'XP réellement accordée : sans le
    // module de niveaux, plus rien n'alimente le classement.
    requires: ['leveling'],
    apiSegments: ['ranked'],
    paths: ['/prestige'],
  },
  {
    key: 'clans',
    name: 'Clans',
    description: "Équipes de membres, points collectifs et classement inter-clans.",
    category: 'community',
    icon: 'Medal',
    defaultEnabled: false,
    guildFields: ['clansEnabled'],
    legacyField: 'clansEnabled',
    requires: ['leveling'],
    apiSegments: ['clans'],
    paths: ['/clans'],
    interactionPrefixes: ['clan:', 'bet:'],
  },
  {
    key: 'drops',
    name: 'Drops',
    description: "Cadeaux aléatoires posés dans les salons : XP, points de clan ou pièces à ramasser.",
    category: 'community',
    icon: 'ArrowDownBox',
    defaultEnabled: false,
    guildFields: ['dropsEnabled'],
    legacyField: 'dropsEnabled',
    // Volontairement sans `requires` : un serveur peut ne faire tomber que des
    // pièces, sans module de niveaux ni clans. Chaque type de drop a son propre
    // interrupteur sur la page.
    apiSegments: ['drops'],
    paths: ['/drops'],
    interactionPrefixes: ['drop_claim:'],
  },
  {
    key: 'economy',
    name: 'Économie & RPG',
    description: 'Monnaie, boutique, objets, jeux de hasard et aventures textuelles.',
    category: 'community',
    icon: 'Coins',
    defaultEnabled: false,
    guildFields: ['economyEnabled'],
    legacyField: 'economyEnabled',
    apiSegments: ['economy', 'rpg', 'shop'],
    paths: ['/economy'],
    interactionPrefixes: ['rpg:', 'rpg_'],
  },
  {
    key: 'marketplace',
    name: 'Marché entre membres',
    description: "Place de marché où les membres s'échangent objets et monnaie.",
    category: 'community',
    icon: 'ShoppingBag',
    defaultEnabled: false,
    requires: ['economy'],
    apiSegments: ['marketplace'],
    paths: ['/marketplace'],
  },
  {
    key: 'quests',
    name: 'Quêtes',
    description: 'Objectifs quotidiens et hebdomadaires récompensés.',
    category: 'community',
    icon: 'Target',
    defaultEnabled: false,
    apiSegments: ['quests'],
    paths: ['/quests'],
  },
  {
    key: 'reputation',
    name: 'Réputation',
    description: 'Points de reconnaissance attribués entre membres.',
    category: 'community',
    icon: 'Heart',
    defaultEnabled: false,
    apiSegments: ['reputation'],
    paths: ['/reputation'],
  },
  {
    key: 'fun',
    name: 'Salons fun',
    description: 'Comptage, histoire à un mot, nombre mystère et mini-jeux de salon.',
    category: 'community',
    icon: 'Smile',
    defaultEnabled: false,
    guildFields: ['funEnabled'],
    legacyField: 'funEnabled',
    apiSegments: ['fun'],
    paths: ['/fun'],
  },
  {
    key: 'daily_algo',
    name: 'Daily Algo',
    description: "Défi d'algorithmique quotidien, soumissions et classement hebdomadaire.",
    category: 'community',
    icon: 'FlaskConical',
    defaultEnabled: false,
    guildFields: ['dailyAlgoEnabled'],
    legacyField: 'dailyAlgoEnabled',
    aliases: ['dailyalgo'],
    apiSegments: [
      'daily-algo-problems',
      'daily-algo-runs',
      'daily-algo-weeks',
      'daily-algo-submissions',
    ],
    paths: ['/dailyalgo'],
  },
  {
    key: 'tickets',
    name: 'Tickets support',
    description: "Système d'assistance avec catégories, prise en charge et transcriptions.",
    category: 'community',
    icon: 'Card',
    defaultEnabled: true,
    apiSegments: ['tickets', 'transcripts'],
    paths: ['/tickets'],
    interactionPrefixes: ['ticket:', 'modal:ticket:', 'satisfaction:', 'satskip:', 'satcomment:', 'satcomment_modal:'],
  },
  {
    key: 'giveaways',
    name: 'Giveaways',
    description: 'Concours et tirages au sort avec participation par bouton.',
    category: 'community',
    icon: 'Gift',
    defaultEnabled: true,
    apiSegments: ['giveaways'],
    paths: ['/giveaways'],
    interactionPrefixes: ['giveaway_join:', 'giveaway_val_approve:', 'giveaway_val_reroll:'],
  },
  {
    key: 'events',
    name: 'Événements & quiz',
    description: 'Organisation de quiz et événements communautaires.',
    category: 'community',
    icon: 'Sparkles',
    defaultEnabled: true,
    apiSegments: ['events'],
    paths: ['/events'],
  },
  {
    key: 'suggestions',
    name: 'Suggestions',
    description: 'Boîte à idées avec votes et réponses du staff.',
    category: 'community',
    icon: 'Lightbulb',
    defaultEnabled: true,
    apiSegments: ['suggestions'],
    paths: ['/suggestions'],
    interactionPrefixes: ['suggest_vote:'],
  },
  {
    key: 'starboard',
    name: 'Starlight',
    description: 'Mise en avant des messages plébiscités dans un salon dédié.',
    category: 'community',
    icon: 'Star',
    // Sans salon de highlights, le module n'a nulle part où publier : il
    // démarre éteint plutôt que de tourner à vide.
    defaultEnabled: false,
    apiSegments: ['starboard'],
    paths: ['/starboard'],
  },

  // ─────────────── Contenu & Communication ───────────────
  {
    key: 'regulation',
    name: 'Règlement',
    description: 'Rédaction, publication et validation du règlement du serveur.',
    category: 'content',
    icon: 'Paper',
    defaultEnabled: true,
    apiSegments: ['regulation'],
    paths: ['/regulation'],
  },
  {
    key: 'welcome_goodbye',
    name: 'Accueil & départ',
    description: "Messages de bienvenue et d'au revoir, menu et fil d'accueil.",
    category: 'content',
    icon: 'DoorOpen',
    defaultEnabled: true,
    apiSegments: ['welcome', 'announcement', 'welcome-thread'],
    paths: ['/welcome'],
    interactionPrefixes: ['wpage:'],
  },
  {
    key: 'reaction_roles',
    name: 'Rôles par réaction',
    description: 'Attribution de rôles via des boutons cliquables.',
    category: 'content',
    icon: 'MousePointer',
    defaultEnabled: true,
    apiSegments: ['reaction-roles'],
    paths: ['/reaction-roles'],
    interactionPrefixes: ['role_toggle:'],
  },
  {
    key: 'auto_responses',
    name: 'Auto-réponses',
    description: 'Réponses automatiques déclenchées par des mots-clés.',
    category: 'content',
    icon: 'MessageCircle',
    defaultEnabled: true,
    apiSegments: ['auto-responses'],
    paths: ['/auto-responses'],
  },
  {
    key: 'auto_thread',
    name: 'Auto-thread & salons',
    description: 'Fils automatiques, messages sticky, salons statistiques et vocaux temporaires.',
    category: 'content',
    icon: 'GitBranch',
    defaultEnabled: false,
    guildFields: ['autoThreadEnabled'],
    legacyField: 'autoThreadEnabled',
    apiSegments: ['auto-thread', 'channels-management'],
    paths: ['/channels-management'],
  },
  {
    key: 'news',
    name: 'Actualités & RSS',
    description: "Publication d'articles par le staff et génération de flux RSS.",
    category: 'content',
    icon: 'Newspaper',
    defaultEnabled: true,
    apiSegments: ['news'],
    paths: ['/news'],
  },
  {
    key: 'embed_builder',
    name: "Créateur d'embeds",
    description: "Composition et envoi d'embeds personnalisés.",
    category: 'content',
    icon: 'Palette',
    defaultEnabled: true,
    apiSegments: ['embeds'],
    paths: ['/embed-builder'],
  },
  {
    key: 'translation',
    name: 'Traduction automatique',
    description: 'Traduction à la demande des messages vers la langue configurée.',
    category: 'content',
    icon: 'Languages',
    defaultEnabled: false,
    guildFields: ['translationEnabled'],
    legacyField: 'translationEnabled',
    aliases: ['traduction'],
    paths: ['/translation'],
  },
  {
    key: 'digest',
    name: 'Digest',
    description: "Résumés automatiques de l'activité du serveur.",
    category: 'content',
    icon: 'StickyNote',
    defaultEnabled: false,
    guildFields: ['digestEnabled'],
    legacyField: 'digestEnabled',
    apiSegments: ['digest'],
    paths: ['/digest'],
  },
  {
    key: 'custom_forms',
    name: 'Formulaires personnalisés',
    description: 'Formulaires sur mesure et collecte des réponses.',
    category: 'content',
    icon: 'ClipboardList',
    defaultEnabled: true,
    apiSegments: ['custom-forms'],
    paths: ['/custom-forms'],
  },

  // ───────────────────── Intégrations ─────────────────────
  {
    key: 'analytics',
    name: 'Analytics',
    description: "Collecte et restitution des statistiques d'activité du serveur.",
    category: 'integrations',
    icon: 'TrendingUp',
    defaultEnabled: true,
    guildFields: ['analyticsEnabled'],
    legacyField: 'analyticsEnabled',
    apiSegments: ['analytics', 'pulse', 'predictions', 'ghost-members'],
    paths: ['/analytics', '/pulse'],
  },
  {
    key: 'youtube',
    name: 'YouTube',
    description: 'Notifications automatiques des nouvelles vidéos.',
    category: 'integrations',
    icon: 'Play',
    defaultEnabled: false,
    guildFields: ['youtubeEnabled'],
    legacyField: 'youtubeEnabled',
    requires: ['social_networks'],
    paths: ['/social-networks'],
  },
  {
    key: 'twitch',
    name: 'Twitch',
    description: 'Notifications automatiques des passages en live.',
    category: 'integrations',
    icon: 'Monitor',
    defaultEnabled: false,
    requires: ['social_networks'],
    paths: ['/social-networks'],
  },
  {
    key: 'social_networks',
    name: 'Réseaux sociaux',
    description: 'Gestion des comptes YouTube et Twitch suivis par le serveur.',
    category: 'integrations',
    icon: 'Share2',
    defaultEnabled: true,
    apiSegments: ['social-follows'],
    paths: ['/social-networks'],
  },
  {
    key: 'workflows',
    name: 'Automatisations',
    description: 'Enchaînements déclencheur → action configurés sans code.',
    category: 'integrations',
    icon: 'Workflow',
    defaultEnabled: true,
    apiSegments: ['workflows'],
    // `/workflows` reste déclaré : la page a été renommée en « Déclencheurs »
    // mais l'ancienne URL est toujours routée, et un favori doit tomber sur
    // l'écran « module désactivé » plutôt que sur une erreur d'API.
    paths: ['/triggers', '/workflows'],
  },
  {
    key: 'channel_health',
    name: 'Santé des salons',
    description: "Détection des salons inactifs ou surchargés et suggestions d'archivage.",
    category: 'integrations',
    icon: 'HeartPulse',
    defaultEnabled: true,
    requires: ['analytics'],
    apiSegments: ['channel-health'],
    paths: ['/channel-health'],
  },

  // ───────────────────── Cross-serveur ─────────────────────
  {
    key: 'channel_links',
    name: 'Liens de salons',
    description: 'Synchronisation de messages entre les salons de plusieurs serveurs.',
    category: 'cross_server',
    icon: 'Link2',
    defaultEnabled: false,
    apiSegments: ['channel-links'],
    paths: ['/channel-links'],
  },
  {
    key: 'staff_server',
    name: 'Serveur staff',
    description: "Serveur dédié à l'équipe, hiérarchie et rôles synchronisés.",
    category: 'cross_server',
    icon: 'Home',
    defaultEnabled: false,
    apiSegments: ['staff-server'],
    paths: ['/staff-server-links'],
    interactionPrefixes: ['staffserver:'],
  },
];

export type ModuleKey = string;

const BY_KEY = new Map<string, ModuleDefinition>(MODULE_REGISTRY.map((m) => [m.key, m]));

/** Alias historique → clé canonique. Construit une fois au chargement. */
const CANONICAL_BY_ALIAS = new Map<string, string>();
for (const mod of MODULE_REGISTRY) {
  CANONICAL_BY_ALIAS.set(mod.key, mod.key);
  for (const alias of mod.aliases ?? []) CANONICAL_BY_ALIAS.set(alias, mod.key);
}

/**
 * Ramène une clé - historique, venue d'une URL ou d'une vieille ligne en base -
 * à celle qui fait foi. Une clé inconnue est renvoyée telle quelle : le
 * registre ne doit pas faire disparaître une fonctionnalité qu'il ignore.
 */
export function canonicalModuleKey(key: string): string {
  return CANONICAL_BY_ALIAS.get(key) ?? key;
}

export function getModuleDefinition(key: string): ModuleDefinition | undefined {
  return BY_KEY.get(canonicalModuleKey(key));
}

export function isCoreModule(key: string): boolean {
  return getModuleDefinition(key)?.core === true;
}

/** Modules qui déclarent `key` dans leur `requires` (transitivement). */
export function getModuleDependents(key: string): string[] {
  const canonical = canonicalModuleKey(key);
  const found = new Set<string>();
  const walk = (target: string) => {
    for (const mod of MODULE_REGISTRY) {
      if (!mod.requires?.map(canonicalModuleKey).includes(target)) continue;
      if (found.has(mod.key)) continue;
      found.add(mod.key);
      walk(mod.key);
    }
  };
  walk(canonical);
  return [...found];
}

/** Modules dont `key` a besoin (transitivement). */
export function getModuleRequirements(key: string): string[] {
  const found = new Set<string>();
  const walk = (target: string) => {
    const mod = getModuleDefinition(target);
    for (const requirement of mod?.requires ?? []) {
      const canonical = canonicalModuleKey(requirement);
      if (found.has(canonical)) continue;
      found.add(canonical);
      walk(canonical);
    }
  };
  walk(canonicalModuleKey(key));
  return [...found];
}

/**
 * Index segment d'API → module. Un même segment n'appartient qu'à un module :
 * une collision serait une erreur de registre, on garde donc le premier déclaré
 * et le test unitaire du registre vérifie l'absence de doublon.
 */
const MODULE_BY_API_SEGMENT = new Map<string, string>();
for (const mod of MODULE_REGISTRY) {
  for (const segment of mod.apiSegments ?? []) {
    if (!MODULE_BY_API_SEGMENT.has(segment)) MODULE_BY_API_SEGMENT.set(segment, mod.key);
  }
}

export function getModuleForApiSegment(segment: string | undefined): string | undefined {
  if (!segment) return undefined;
  return MODULE_BY_API_SEGMENT.get(segment);
}

/**
 * Module propriétaire d'un `customId` d'interaction. Les préfixes sont testés du
 * plus long au plus court : `modal:ticket:` doit l'emporter sur un éventuel
 * `modal:`, sans quoi le premier module déclaré gagnerait par hasard.
 */
const INTERACTION_PREFIXES: Array<{ prefix: string; moduleKey: string }> = MODULE_REGISTRY
  .flatMap((mod) => (mod.interactionPrefixes ?? []).map((prefix) => ({ prefix, moduleKey: mod.key })))
  .sort((a, b) => b.prefix.length - a.prefix.length);

export function getModuleForCustomId(customId: string | undefined): string | undefined {
  if (!customId) return undefined;
  return INTERACTION_PREFIXES.find((entry) => customId.startsWith(entry.prefix))?.moduleKey;
}

/** Module propriétaire d'une route du dashboard, préfixe le plus long d'abord. */
const MODULE_PATHS: Array<{ path: string; moduleKey: string }> = MODULE_REGISTRY
  .flatMap((mod) => (mod.paths ?? []).map((path) => ({ path, moduleKey: mod.key })))
  .filter((entry) => entry.path !== '/')
  .sort((a, b) => b.path.length - a.path.length);

export function getModuleForPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return MODULE_PATHS.find(
    (entry) => path === entry.path || path.startsWith(`${entry.path}/`),
  )?.moduleKey;
}

/** Toutes les colonnes `Guild` miroir, tous modules confondus. */
export const ALL_MODULE_GUILD_FIELDS = [
  ...new Set(MODULE_REGISTRY.flatMap((mod) => mod.guildFields ?? [])),
];

/** État par défaut de chaque module, avant toute écriture en base. */
export function defaultModuleStates(): Record<string, boolean> {
  const states: Record<string, boolean> = {};
  for (const mod of MODULE_REGISTRY) states[mod.key] = mod.core ? true : mod.defaultEnabled;
  return states;
}
