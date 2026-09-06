/**
 * Contrat de la "fiche membre" (member case) echangee entre le bot et le
 * dashboard.
 *
 * Ces types etaient definis trois fois : une fois cote bot dans
 * `apps/bot/src/api/shared.ts`, et deux fois a la main cote dashboard
 * (`pages/Logs.svelte` et `lib/components/MemberCaseModal.svelte`). Les copies
 * du dashboard avaient deja diverge (champs `id`, `moderatorNote`,
 * `isOnServer` et `inviterAvatarUrl` manquants).
 *
 * Types purs, sans dependance a Prisma ni a discord.js, pour rester importables
 * depuis le bundle navigateur du dashboard.
 */

export type DashboardSanctionType = 'WARN' | 'KICK' | 'TIMEOUT' | 'TEMP_BAN' | 'BAN' | 'SOFTBAN';
export type DashboardSanctionStatus = 'ACTIVE' | 'RESOLVED' | 'FAILED';

export type DashboardRole = {
  id: string;
  name: string;
  mention: string;
  permissions: string[];
  position?: number;
  color?: string;
};

export type SanctionItem = {
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
  /** Non nul = sanction archivee : desactivee mais conservee. */
  archivedAt: string | null;
  archiveReason: string | null;
  /** false = contestation verrouillee : le membre ne peut plus faire appel. */
  appealable: boolean;
  appealLockReason: string | null;
};

export type SanctionReportItem = {
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

export type MemberCaseQuickAction = 'WARN' | 'KICK' | 'TIMEOUT' | 'BAN' | 'REQUEST_VERIFICATION';

export type MemberCaseLogEntry = {
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

export type MemberCaseChannelMessage = {
  id: string;
  channelId: string;
  channelName: string;
  content: string;
  dateIso: string;
};

export type MemberCaseChannelSummary = {
  channelId: string;
  channelName: string;
  count: number;
  lastMessageAt: string | null;
  recentMessages: MemberCaseChannelMessage[];
};

export type MemberCaseInviteInfo = {
  code: string | null;
  inviterId: string | null;
  inviterTag: string | null;
  inviterAvatarUrl: string | null;
  joinedAt: string | null;
};

export type MemberCaseProfile = {
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
  isOnServer: boolean;
};

export type LinkedAccountItem = {
  userId: string;
  userTag: string | null;
  avatarUrl: string | null;
  type: string;
  status: string;
};

export type MemberCaseInteractionNode = {
  id: string;
  label: string;
  type: 'user' | 'target';
  avatar?: string | null;
};

export type MemberCaseInteractionEdge = {
  from: string;
  to: string;
  type: 'mention' | 'reply' | 'reaction';
  count: number;
};

export type MemberCaseInteractionGraph = {
  nodes: MemberCaseInteractionNode[];
  edges: MemberCaseInteractionEdge[];
};

export type CrossServerSanctionEntry = {
  type: DashboardSanctionType;
  status: DashboardSanctionStatus;
  durationSeconds: number | null;
  reason: string;
  createdAt: string;
  guildId: string;
  guildName: string;
};

export type CrossServerSanctionSummaryPayload = {
  enabled: boolean;
  serverCount: number;
  total: number;
  breakdown: Record<DashboardSanctionType, number>;
  recent: CrossServerSanctionEntry[];
};

/** Un serveur tiers portant déjà le lien entre le membre et un autre compte. */
export type CrossServerLinkGuildEntry = {
  guildId: string;
  guildName: string;
  type: 'MANUAL' | 'AUTOMATIC';
  status: 'PENDING' | 'VALIDATED' | 'REJECTED';
  reason: string | null;
  linkedAt: string;
};

/**
 * Suggestion de liaison : ce compte est déjà lié à `userId` sur d'autres serveurs
 * de la même instance. Le staff décide de reproduire le lien ici ou non.
 */
export type CrossServerLinkSuggestionItem = {
  userId: string;
  userTag: string | null;
  avatarUrl: string | null;
  presentOnGuild: boolean;
  alreadyLinkedHere: boolean;
  serverCount: number;
  manualCount: number;
  guilds: CrossServerLinkGuildEntry[];
  /** Bonus de score de détection apporté par ce lien (0-85). */
  score: number;
};

export type CrossServerLinkSummaryPayload = {
  enabled: boolean;
  serverCount: number;
  suggestions: CrossServerLinkSuggestionItem[];
};

export type MemberCaseCandidature = {
  id: string;
  status: string;
  notes: string;
  createdAt: string;
  data: unknown;
  autoRejected: boolean;
  autoRejectReason: string | null;
  rejectionReason: string | null;
  oralResult: string | null;
  reapplyAfter: string | null;
};

export type MemberCaseConnection = {
  name: string;
  type: string;
  visible: boolean;
};

/** Une demande de vérification de sécurité passée sur ce membre. */
export type MemberCaseVerificationEntry = {
  id: string;
  status: 'PENDING' | 'VERIFIED' | 'FLAGGED' | 'EXPIRED';
  level: 'LOW' | 'MEDIUM' | 'HIGH';
  requestedAt: string;
  verifiedAt: string | null;
  expiresAt: string | null;
};

/**
 * Historique des vérifications, affiché à côté du bouton « Demander
 * vérification » pour qu'un modérateur voie qu'un collègue l'a déjà fait.
 */
export type MemberCaseVerifications = {
  entries: MemberCaseVerificationEntry[];
  total: number;
  lastRequestedAt: string | null;
  lastVerifiedAt: string | null;
  /** Une demande est toujours ouverte : en relancer une n'apporte rien. */
  hasPending: boolean;
  /** Instant avant lequel une nouvelle demande est refusée (anti-spam). */
  cooldownUntil: string | null;
};

export type MemberCaseResponse = {
  profile: MemberCaseProfile | null;
  invite: MemberCaseInviteInfo | null;
  roles: DashboardRole[];
  effectivePermissions: string[];
  sanctions: SanctionItem[];
  logs: MemberCaseLogEntry[];
  messagesByChannel: MemberCaseChannelSummary[];
  recentMessageCount: number;
  recentLogCount: number;
  connections: MemberCaseConnection[];
  connectionsNote: string;
  candidatures: MemberCaseCandidature[];
  linkedAccounts: LinkedAccountItem[];
  isSuspectedDC: boolean;
  sanctionReports: SanctionReportItem[];
  interactionGraph: MemberCaseInteractionGraph;
  crossServerSanctions: CrossServerSanctionSummaryPayload;
  /** Liens de double compte déjà posés sur d'autres serveurs de l'instance. */
  crossServerLinks: CrossServerLinkSummaryPayload;
  verifications: MemberCaseVerifications;
};
