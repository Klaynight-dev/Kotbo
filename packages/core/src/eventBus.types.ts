/**
 * Kotbo Internal Event Bus - Type definitions
 *
 * Each domain module publishes and subscribes to typed events.
 * Phase 1: in-process EventEmitter (same bot instance)
 * Phase 2: Redis Pub/Sub (multi-process, multi-bot split)
 */

// ── Message Events ──────────────────────────────────────────────
export interface MessageNewEvent {
  guildId: string;
  channelId: string;
  authorId: string;
  authorTag: string;
  content: string;
  isBot: boolean;
  isCommand: boolean;
  hasReference: boolean;
  messageId: string;
  attachmentCount: number;
  isInteraction: boolean;
  timestamp: number;
}

export interface MessageDeleteEvent {
  guildId: string;
  channelId: string;
  authorId: string | null;
  authorTag: string | null;
  messageId: string;
  content: string | null;
  timestamp: number;
}

export interface MessageUpdateEvent {
  guildId: string;
  channelId: string;
  authorId: string | null;
  messageId: string;
  oldContent: string | null;
  newContent: string | null;
  timestamp: number;
}

// ── Voice Events ────────────────────────────────────────────────
export interface VoiceJoinEvent {
  guildId: string;
  userId: string;
  channelId: string;
  channelName: string | null;
  timestamp: number;
}

export interface VoiceLeaveEvent {
  guildId: string;
  userId: string;
  channelId: string;
  channelName: string | null;
  durationMs: number | null;
  joinTimestamp: number | null;
  timestamp: number;
}

export interface VoiceMoveEvent {
  guildId: string;
  userId: string;
  fromChannelId: string;
  fromChannelName: string | null;
  toChannelId: string;
  toChannelName: string | null;
  joinTimestamp: number | null;
  timestamp: number;
}

// ── Member Events ───────────────────────────────────────────────
export interface MemberJoinEvent {
  guildId: string;
  userId: string;
  userTag: string;
  isBot: boolean;
  timestamp: number;
}

export interface MemberLeaveEvent {
  guildId: string;
  userId: string;
  userTag: string;
  isBot: boolean;
  timestamp: number;
}

export interface MemberUpdateEvent {
  guildId: string;
  userId: string;
  oldNickname: string | null;
  newNickname: string | null;
  addedRoles: string[];
  removedRoles: string[];
  isBoosting: boolean;
  timestamp: number;
}

// ── Moderation Events ───────────────────────────────────────────
export interface SanctionAppliedEvent {
  guildId: string;
  targetId: string;
  targetTag: string;
  moderatorId: string;
  moderatorTag: string;
  /** Reprend l'énumération Prisma `SanctionType` sans la traduire. */
  type: 'WARN' | 'KICK' | 'TIMEOUT' | 'TEMP_BAN' | 'BAN' | 'SOFTBAN';
  reason: string | null;
  duration: number | null;
  sanctionId: string | null;
  timestamp: number;
}

export interface SanctionRevokedEvent {
  guildId: string;
  targetId: string;
  moderatorId: string;
  type: 'UNBAN' | 'UNTIMEOUT' | 'UNMUTE' | 'UNWARN';
  sanctionId: string | null;
  timestamp: number;
}

export interface AutoModTriggeredEvent {
  guildId: string;
  userId: string;
  channelId: string;
  rule: string;
  matchedContent: string | null;
  action: 'DELETE' | 'WARN' | 'TIMEOUT' | 'LOG';
  timestamp: number;
}

// ── Reaction / Thread Events ────────────────────────────────────
export interface ReactionAddEvent {
  guildId: string;
  channelId: string;
  userId: string;
  messageId: string;
  emoji: string;
  timestamp: number;
}

export interface ThreadCreateEvent {
  guildId: string;
  channelId: string;
  threadId: string;
  creatorId: string | null;
  timestamp: number;
}

// ── Channel Events ──────────────────────────────────────────────
export interface ChannelCreateEvent {
  guildId: string;
  channelId: string;
  channelName: string;
  channelType: number;
  timestamp: number;
}

export interface ChannelDeleteEvent {
  guildId: string;
  channelId: string;
  channelName: string;
  channelType: number;
  timestamp: number;
}

// ── Ticket Events ───────────────────────────────────────────────
export interface TicketCreatedEvent {
  guildId: string;
  ticketId: string;
  userId: string;
  userTag: string;
  /** Null en mode MP : la conversation ne vit dans aucun salon du serveur. */
  channelId: string | null;
  ticketTypeId: string | null;
  ticketTypeLabel: string | null;
  subject: string;
  timestamp: number;
}

// ── Progression Events ──────────────────────────────────────────
export interface LevelUpEvent {
  guildId: string;
  userId: string;
  previousLevel: number;
  level: number;
  timestamp: number;
}

// ── Role Events ─────────────────────────────────────────────────
export interface RoleCreateEvent {
  guildId: string;
  roleId: string;
  roleName: string;
  timestamp: number;
}

export interface RoleDeleteEvent {
  guildId: string;
  roleId: string;
  roleName: string;
  timestamp: number;
}

// ── Paris en points de clan ─────────────────────────────────────

/**
 * Pari tranché par un arbitre.
 *
 * Le camp gagnant et les perdants sont transportés entiers : un abonné qui
 * n'aurait que les identifiants devrait relire la base pour savoir qui a gagné
 * quoi, alors que le règlement vient précisément de le calculer.
 */
export interface BetResolvedEvent {
  guildId: string;
  betId: string;
  subject: string;
  season: number;
  /** DUEL | POOL | TEAMS */
  shape: string;
  /** Enjeu total redistribué, crédit compris. */
  pot: number;
  winningSideLabel: string;
  /** Gain net de chacun : ce qu'il a touché moins ce qu'il avait engagé. */
  winners: Array<{ userId: string; netGain: number }>;
  losers: Array<{ userId: string; lost: number }>;
  resolvedById: string | null;
  timestamp: number;
}

/** Pari clos sans vainqueur : mises rendues. */
export interface BetRefundedEvent {
  guildId: string;
  betId: string;
  subject: string;
  season: number;
  /** REFUNDED | CANCELLED | EXPIRED | DECLINED */
  reason: string;
  refunded: Array<{ userId: string; amount: number }>;
  timestamp: number;
}

/**
 * Un membre vient d'engager plus de points qu'il n'en possède.
 *
 * `amount` est ce qui vient d'être creusé, `total` ce qu'il doit désormais :
 * un serveur qui alerte au franchissement d'un seuil a besoin du second, un
 * serveur qui journalise chaque emprunt a besoin du premier.
 */
export interface ClanDebtOpenedEvent {
  guildId: string;
  userId: string;
  amount: number;
  total: number;
  source: string;
  timestamp: number;
}

/** Dette entièrement remboursée sur les gains du membre. */
export interface ClanDebtClearedEvent {
  guildId: string;
  userId: string;
  repaid: number;
  timestamp: number;
}

// ── Mapping type → payload ──────────────────────────────────────
export interface KotboEventMap {
  'message:new': MessageNewEvent;
  'message:delete': MessageDeleteEvent;
  'message:update': MessageUpdateEvent;
  'voice:join': VoiceJoinEvent;
  'voice:leave': VoiceLeaveEvent;
  'voice:move': VoiceMoveEvent;
  'member:join': MemberJoinEvent;
  'member:leave': MemberLeaveEvent;
  'member:update': MemberUpdateEvent;
  'sanction:applied': SanctionAppliedEvent;
  'sanction:revoked': SanctionRevokedEvent;
  'automod:triggered': AutoModTriggeredEvent;
  'reaction:add': ReactionAddEvent;
  'ticket:created': TicketCreatedEvent;
  'level:up': LevelUpEvent;
  'thread:create': ThreadCreateEvent;
  'channel:create': ChannelCreateEvent;
  'channel:delete': ChannelDeleteEvent;
  'role:create': RoleCreateEvent;
  'role:delete': RoleDeleteEvent;
  'bet:resolved': BetResolvedEvent;
  'bet:refunded': BetRefundedEvent;
  'clan:debt-opened': ClanDebtOpenedEvent;
  'clan:debt-cleared': ClanDebtClearedEvent;
}

export type KotboEventName = keyof KotboEventMap;
