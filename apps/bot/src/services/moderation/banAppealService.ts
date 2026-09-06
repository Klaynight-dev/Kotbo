// ============================================================================
// APPELS DE SANCTION (modèle appeals.gg, étendu au-delà du ban définitif)
// Page publique → OAuth Discord → sélection des sanctions contestées →
// formulaire d'appel → review dashboard + embed staff Discord synchronisés →
// verdict par sanction (maintenue / archivée / supprimée / verrouillée).
//
// Le module s'appelle toujours « ban appeals » en base par compatibilité, mais
// un appel peut désormais viser n'importe quel type de sanction activé par le
// serveur. Un appel sans sanction rattachée reste l'appel de ban historique,
// adossé à l'état de bannissement Discord.
// ============================================================================

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type Guild,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import prisma from '../../utils/db.js';
import { Prisma, AppealItemOutcome, BanAppealStatus, SanctionType } from '@prisma/client';
import { logger } from '../../utils/logger.js';
import { INVITE_SOURCE, recordBotInvite } from '../analytics/inviteService.js';
import {
  archiveSanctions,
  deleteSanctions,
  setSanctionAppealLock,
} from './sanctionArchiveService.js';

const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'http://localhost:5173').replace(/\/+$/, '');

export type AppealDecision = 'ACCEPTED' | 'DENIED' | 'DENIED_PERMANENT';

export type AppealConfigInput = {
  enabled?: boolean;
  formId?: string | null;
  staffChannelId?: string | null;
  inviteChannelId?: string | null;
  cooldownDays?: number;
  welcomeText?: string | null;
  acceptMessage?: string | null;
  denyMessage?: string | null;
  notifyOnBanDM?: boolean;
  appealVerification?: boolean;
  appealSaveIp?: boolean;
  appealSaveDevice?: boolean;
  appealVerificationLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  // Contestation étendue
  appealableTypes?: SanctionType[];
  maxSanctionsPerAppeal?: number;
  appealWindowDays?: number | null;
  /** { WARN: 7 } - cooldown par type, `null` efface la surcharge. */
  cooldownByType?: Record<string, number> | null;
  /** { WARN: "<formId>" } - formulaire par type, `null` efface la surcharge. */
  formIdByType?: Record<string, string> | null;
  notifyOnSanctionDM?: boolean;
  excludeIssuingModerator?: boolean;
  notifyIssuingModerator?: boolean;
};

/** Ordre d'affichage stable des types dans le dashboard et les embeds. */
export const APPEALABLE_SANCTION_TYPES: SanctionType[] = [
  SanctionType.WARN,
  SanctionType.TIMEOUT,
  SanctionType.KICK,
  SanctionType.SOFTBAN,
  SanctionType.TEMP_BAN,
  SanctionType.BAN,
];

const SANCTION_TYPE_LABELS: Record<SanctionType, string> = {
  WARN: 'Avertissement',
  KICK: 'Expulsion',
  TIMEOUT: 'Exclusion temporaire',
  TEMP_BAN: 'Bannissement temporaire',
  BAN: 'Bannissement',
  SOFTBAN: 'Softban',
};

export function sanctionTypeLabel(type: SanctionType): string {
  return SANCTION_TYPE_LABELS[type] ?? type;
}

const OUTCOME_META: Record<AppealItemOutcome, { label: string; emoji: string }> = {
  PENDING: { label: 'À trancher', emoji: '⏳' },
  UPHELD: { label: 'Maintenue', emoji: '⚖️' },
  ARCHIVED: { label: 'Archivée', emoji: '📦' },
  DELETED: { label: 'Supprimée', emoji: '🗑️' },
  LOCKED: { label: 'Maintenue et verrouillée', emoji: '🔒' },
};

export function outcomeLabel(outcome: AppealItemOutcome): string {
  return OUTCOME_META[outcome]?.label ?? outcome;
}

const DEFAULT_ACCEPT_MESSAGE =
  'Bonne nouvelle ! Ta demande de débannissement sur **{server}** a été acceptée. Tu peux revenir avec cette invitation : {invite}';
const DEFAULT_DENY_MESSAGE =
  'Ta demande de débannissement sur **{server}** a été refusée.\nRaison : {reason}';

// ============================================================================
// CONFIGURATION
// ============================================================================

export async function getAppealConfig(guildId: string) {
  return prisma.banAppealConfig.findUnique({
    where: { guildId },
    include: { form: { select: { id: true, name: true, structure: true, theme: true, customCss: true } } },
  });
}

export async function upsertAppealConfig(guildId: string, data: AppealConfigInput) {
  // Prisma distingue « colonne JSON absente de la requête » de « colonne mise à
  // NULL » : un `null` nu est refusé, il faut `Prisma.DbNull`.
  const { cooldownByType, formIdByType, ...rest } = data;
  const payload = {
    ...rest,
    ...(cooldownByType !== undefined
      ? { cooldownByType: cooldownByType === null ? Prisma.DbNull : (cooldownByType as Prisma.InputJsonValue) }
      : {}),
    ...(formIdByType !== undefined
      ? { formIdByType: formIdByType === null ? Prisma.DbNull : (formIdByType as Prisma.InputJsonValue) }
      : {}),
  };

  return prisma.banAppealConfig.upsert({
    where: { guildId },
    create: { guildId, ...payload },
    update: payload,
  });
}

/**
 * Crée le formulaire d'appel par défaut (modifiable ensuite dans le builder)
 * et le lie à la config si aucun formulaire n'est configuré.
 */
export async function ensureDefaultAppealForm(guildId: string): Promise<string> {
  const existing = await getAppealConfig(guildId);
  if (existing?.formId) return existing.formId;

  const form = await prisma.customForm.create({
    data: {
      guildId,
      name: "Demande de débannissement",
      description: "Formulaire d'appel pour les membres bannis définitivement.",
      requiresDiscordAuth: true,
      structure: {
        title: 'Demande de débannissement',
        description: 'Réponds honnêtement : les réponses copiées-collées ou vides sont refusées.',
        fields: [
          { id: 'appeal_why_banned', type: 'paragraph', label: 'Pourquoi as-tu été banni, selon toi ?', required: true, sectionIndex: 0 },
          { id: 'appeal_why_unban', type: 'paragraph', label: 'Pourquoi devrions-nous te débannir ?', required: true, sectionIndex: 0 },
          { id: 'appeal_changed', type: 'paragraph', label: 'Qu\'est-ce qui a changé / que feras-tu différemment ?', required: true, sectionIndex: 0 },
          { id: 'appeal_extra', type: 'paragraph', label: 'Informations complémentaires (optionnel)', required: false, sectionIndex: 0 },
        ],
      } as unknown as Prisma.InputJsonValue,
    },
  });

  await upsertAppealConfig(guildId, { formId: form.id });
  return form.id;
}

// ============================================================================
// ÉLIGIBILITÉ
// ============================================================================

async function fetchGuild(client: Client, guildId: string): Promise<Guild | null> {
  return client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId).catch(() => null));
}

export async function fetchBanInfo(client: Client, guildId: string, userId: string) {
  const guild = await fetchGuild(client, guildId);
  if (!guild) return { banned: false as const, reason: null };
  const ban = await guild.bans.fetch(userId).catch(() => null);
  return ban ? { banned: true as const, reason: ban.reason ?? null } : { banned: false as const, reason: null };
}

// -- Sanctions contestables ---------------------------------------------------

/** Une sanction telle qu'exposee au membre sur la page publique d'appel. */
export type AppealableSanction = {
  id: string;
  type: SanctionType;
  typeLabel: string;
  reason: string;
  status: string;
  durationSeconds: number | null;
  expiresAt: string | null;
  createdAt: string;
  moderatorTag: string | null;
};

type AppealConfigRecord = Awaited<ReturnType<typeof getAppealConfig>>;

/** Types contestables declares par le serveur, BAN seul par defaut. */
export function resolveAppealableTypes(config: AppealConfigRecord): SanctionType[] {
  const raw = config?.appealableTypes;
  if (!Array.isArray(raw) || raw.length === 0) return [SanctionType.BAN];
  return APPEALABLE_SANCTION_TYPES.filter(type => raw.includes(type));
}

function readJsonMap(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Cooldown applicable a un type, avec repli sur le cooldown global. */
export function cooldownDaysForType(config: AppealConfigRecord, type: SanctionType): number {
  const perType = readJsonMap(config?.cooldownByType)[type];
  const parsed = Number(perType);
  if (Number.isFinite(parsed) && parsed >= 0) return Math.round(parsed);
  return config?.cooldownDays ?? 30;
}

/**
 * Formulaire a presenter pour un jeu de types contestes : le premier formulaire
 * specifique trouve (dans l'ordre d'affichage des types), sinon celui du module.
 */
export function formIdForTypes(config: AppealConfigRecord, types: SanctionType[]): string | null {
  const perType = readJsonMap(config?.formIdByType);
  for (const type of APPEALABLE_SANCTION_TYPES) {
    if (!types.includes(type)) continue;
    const formId = perType[type];
    if (typeof formId === 'string' && formId.trim()) return formId;
  }
  return config?.formId ?? null;
}

function toAppealableSanction(entry: {
  id: string;
  type: SanctionType;
  reason: string;
  status: string;
  durationSeconds: number | null;
  expiresAt: Date | null;
  createdAt: Date;
  moderatorTag: string | null;
}): AppealableSanction {
  return {
    id: entry.id,
    type: entry.type,
    typeLabel: sanctionTypeLabel(entry.type),
    reason: entry.reason,
    status: entry.status,
    durationSeconds: entry.durationSeconds,
    expiresAt: entry.expiresAt?.toISOString() ?? null,
    createdAt: entry.createdAt.toISOString(),
    moderatorTag: entry.moderatorTag,
  };
}

/**
 * Sanctions qu'un membre peut effectivement contester maintenant.
 *
 * Sont ecartees : les types non actives, les sanctions verrouillees
 * (appealable: false), les sanctions archivees (deja annulees, il n'y a plus
 * rien a contester) et celles sorties de la fenetre appealWindowDays.
 */
export async function getAppealableSanctions(
  guildId: string,
  userId: string,
  config?: AppealConfigRecord
): Promise<AppealableSanction[]> {
  const cfg = config ?? (await getAppealConfig(guildId));
  const types = resolveAppealableTypes(cfg);
  if (types.length === 0) return [];

  const windowDays = cfg?.appealWindowDays ?? null;
  const cutoff = windowDays && windowDays > 0
    ? new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
    : null;

  const sanctions = await prisma.sanction.findMany({
    where: {
      guildId,
      targetUserId: userId,
      type: { in: types },
      appealable: true,
      archivedAt: null,
      ...(cutoff ? { createdAt: { gte: cutoff } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      type: true,
      reason: true,
      status: true,
      durationSeconds: true,
      expiresAt: true,
      createdAt: true,
      moderatorTag: true,
    },
  });

  return sanctions.map(toAppealableSanction);
}

export type AppealEligibility =
  | {
      eligible: true;
      banReason: string | null;
      banned: boolean;
      sanctions: AppealableSanction[];
      maxSelectable: number;
    }
  | {
      eligible: false;
      blockedBy: 'not_banned' | 'blacklisted' | 'active_appeal' | 'cooldown' | 'nothing_to_appeal';
      cooldownEndsAt?: string;
    };

/**
 * Cooldown effectif apres un refus : le plus long des cooldowns des types
 * contestes lors du dernier appel. Contester un warn ne doit pas bloquer un
 * mois, mais melanger un warn et un ban applique bien le delai du ban.
 */
async function cooldownDaysForAppeal(config: AppealConfigRecord, appealId: string): Promise<number> {
  const items = await prisma.banAppealSanction.findMany({
    where: { appealId },
    select: { sanctionType: true },
  });
  if (items.length === 0) return config?.cooldownDays ?? 30;
  return Math.max(...items.map(item => cooldownDaysForType(config, item.sanctionType)));
}

export async function getAppealEligibility(client: Client, guildId: string, userId: string): Promise<AppealEligibility> {
  const blacklisted = await prisma.banAppealBlacklist.findUnique({
    where: { guildId_userId: { guildId, userId } },
  });
  if (blacklisted) return { eligible: false, blockedBy: 'blacklisted' };

  const lastAppeal = await prisma.banAppeal.findFirst({
    where: { guildId, userId },
    orderBy: { createdAt: 'desc' },
  });

  if (lastAppeal && (lastAppeal.status === 'PENDING' || lastAppeal.status === 'NEEDS_INFO')) {
    return { eligible: false, blockedBy: 'active_appeal' };
  }

  if (lastAppeal?.status === 'DENIED_PERMANENT') {
    return { eligible: false, blockedBy: 'blacklisted' };
  }

  const config = await getAppealConfig(guildId);

  if (lastAppeal?.status === 'DENIED' && lastAppeal.decidedAt) {
    const cooldownDays = await cooldownDaysForAppeal(config, lastAppeal.id);
    const endsAt = new Date(lastAppeal.decidedAt.getTime() + cooldownDays * 24 * 60 * 60 * 1000);
    if (endsAt > new Date()) {
      return { eligible: false, blockedBy: 'cooldown', cooldownEndsAt: endsAt.toISOString() };
    }
  }

  const types = resolveAppealableTypes(config);
  const banTypeEnabled = types.includes(SanctionType.BAN) || types.includes(SanctionType.TEMP_BAN);

  const ban = banTypeEnabled
    ? await fetchBanInfo(client, guildId, userId)
    : { banned: false as const, reason: null };

  const sanctions = await getAppealableSanctions(guildId, userId, config);

  if (!ban.banned && sanctions.length === 0) {
    // Config historique (ban seul) : on garde le message « pas banni », plus
    // parlant pour un membre qui n'a jamais rien recu d'autre.
    const banOnly = types.length === 1 && types[0] === SanctionType.BAN;
    return { eligible: false, blockedBy: banOnly ? 'not_banned' : 'nothing_to_appeal' };
  }

  return {
    eligible: true,
    banned: ban.banned,
    banReason: ban.reason,
    sanctions,
    maxSelectable: Math.max(1, Math.min(10, config?.maxSanctionsPerAppeal ?? 3)),
  };
}

// ============================================================================
// SOUMISSION
// ============================================================================

export type SubmitAppealOptions = {
  /** Sanctions contestees, choisies par le membre parmi celles eligibles. */
  sanctionIds?: string[];
  /** Argumentaire par sanction (sanctionId -> texte). */
  statements?: Record<string, string>;
};

export type SubmitAppealBlockReason =
  | 'not_banned'
  | 'blacklisted'
  | 'active_appeal'
  | 'cooldown'
  | 'nothing_to_appeal'
  | 'no_sanction_selected'
  | 'invalid_sanction'
  | 'too_many_sanctions';

export async function submitAppeal(
  client: Client,
  guildId: string,
  user: { id: string; tag?: string; avatar?: string | null },
  data: Record<string, unknown>,
  options: SubmitAppealOptions = {}
) {
  const eligibility = await getAppealEligibility(client, guildId, user.id);
  if (!eligibility.eligible) {
    return { ok: false as const, blockedBy: eligibility.blockedBy as SubmitAppealBlockReason };
  }

  const config = await getAppealConfig(guildId);

  // Le membre ne choisit que parmi les sanctions que l'eligibilite vient de
  // calculer : un id envoye a la main ne peut pas viser la sanction d'un autre.
  const eligibleById = new Map(eligibility.sanctions.map(entry => [entry.id, entry]));
  const requested = [...new Set(options.sanctionIds ?? [])];
  const unknown = requested.filter(id => !eligibleById.has(id));
  if (unknown.length > 0) {
    return { ok: false as const, blockedBy: 'invalid_sanction' as SubmitAppealBlockReason };
  }
  if (requested.length > eligibility.maxSelectable) {
    return { ok: false as const, blockedBy: 'too_many_sanctions' as SubmitAppealBlockReason };
  }
  // Un membre non banni doit designer ce qu'il conteste : sans ban actif, un
  // appel sans sanction ne porte sur rien.
  if (requested.length === 0 && !eligibility.banned) {
    return { ok: false as const, blockedBy: 'no_sanction_selected' as SubmitAppealBlockReason };
  }

  const selected = requested
    .map(id => eligibleById.get(id))
    .filter((entry): entry is AppealableSanction => !!entry);
  const contestedTypes = [...new Set(selected.map(entry => entry.type))];

  const appeal = await prisma.banAppeal.create({
    data: {
      guildId,
      userId: user.id,
      userTag: user.tag ?? null,
      avatar: user.avatar ?? null,
      data: data as Prisma.InputJsonValue,
      formId: formIdForTypes(config, contestedTypes),
      banReason: eligibility.banReason,
      status: 'PENDING',
      sanctions: {
        create: selected.map(entry => ({
          guildId,
          sanctionId: entry.id,
          sanctionType: entry.type,
          sanctionReason: entry.reason,
          sanctionCreatedAt: new Date(entry.createdAt),
          moderatorTag: entry.moderatorTag,
          memberStatement: options.statements?.[entry.id]?.trim().slice(0, 1500) || null,
        })),
      },
    },
    include: { sanctions: true },
  });

  // Le tag du moderateur suffit a l'affichage, mais pas a le prevenir : on
  // complete l'id depuis le casier, la photo ne le porte pas.
  if (selected.length > 0) {
    await backfillItemModerators(appeal.id, selected.map(entry => entry.id)).catch(err =>
      logger.warn('BanAppeal', 'Could not backfill appeal item moderators:', err)
    );
  }

  await postStaffEmbed(client, appeal, config).catch(err =>
    logger.error('BanAppeal', `Failed to post staff embed for appeal ${appeal.id}:`, err)
  );

  await notifyIssuingModerators(client, guildId, appeal.id, config).catch(err =>
    logger.warn('BanAppeal', 'Could not notify issuing moderators:', err)
  );

  return { ok: true as const, appeal };
}

/** Recopie l'id du moderateur emetteur sur les lignes d'appel. */
async function backfillItemModerators(appealId: string, sanctionIds: string[]): Promise<void> {
  const sanctions = await prisma.sanction.findMany({
    where: { id: { in: sanctionIds } },
    select: { id: true, moderatorUserId: true },
  });
  await Promise.all(
    sanctions.map(sanction =>
      prisma.banAppealSanction.updateMany({
        where: { appealId, sanctionId: sanction.id },
        data: { moderatorUserId: sanction.moderatorUserId },
      })
    )
  );
}

/**
 * Previent en DM chaque moderateur dont une sanction est contestee, pour qu'il
 * puisse apporter son contexte avant le verdict.
 */
async function notifyIssuingModerators(
  client: Client,
  guildId: string,
  appealId: string,
  config: AppealConfigRecord
): Promise<void> {
  if (!config?.notifyIssuingModerator) return;

  const items = await prisma.banAppealSanction.findMany({
    where: { appealId },
    select: { moderatorUserId: true, sanctionType: true, sanctionReason: true },
  });

  const byModerator = new Map<string, { type: SanctionType; reason: string }[]>();
  for (const item of items) {
    if (!item.moderatorUserId) continue;
    const list = byModerator.get(item.moderatorUserId) ?? [];
    list.push({ type: item.sanctionType, reason: item.sanctionReason });
    byModerator.set(item.moderatorUserId, list);
  }
  if (byModerator.size === 0) return;

  const appeal = await prisma.banAppeal.findUnique({
    where: { id: appealId },
    select: { userId: true, userTag: true },
  });
  const guild = await fetchGuild(client, guildId);
  const serverName = guild?.name || 'ce serveur';

  for (const [moderatorId, entries] of byModerator) {
    const lines = entries.map(entry => `- ${sanctionTypeLabel(entry.type)} : ${entry.reason.slice(0, 150)}`);
    await sendMemberDM(
      client,
      moderatorId,
      [
        `⚖️ Une sanction que tu as prononcee sur **${serverName}** est contestee.`,
        `**Membre :** ${appeal?.userTag || appeal?.userId || 'inconnu'}`,
        ...lines,
        '',
        `Tu peux apporter ton contexte au staff avant le verdict : ${DASHBOARD_URL}/security/sanctions/appeals`,
      ].join('\n')
    );
  }
}

// ============================================================================
// EMBED STAFF + BOUTONS
// ============================================================================

const STATUS_META: Record<string, { label: string; color: number; emoji: string }> = {
  PENDING: { label: 'En attente', color: 0xf59e0b, emoji: '⏳' },
  NEEDS_INFO: { label: "En attente d'infos du membre", color: 0x3b82f6, emoji: '💬' },
  ACCEPTED: { label: 'Accepté', color: 0x22c55e, emoji: '✅' },
  DENIED: { label: 'Refusé', color: 0xef4444, emoji: '❌' },
  DENIED_PERMANENT: { label: 'Refusé définitivement', color: 0x7f1d1d, emoji: '⛔' },
};

/** Ligne « sanction contestee » telle qu'affichee dans l'embed staff. */
export type AppealItemRecord = {
  id: string;
  sanctionId: string | null;
  sanctionType: SanctionType;
  sanctionReason: string;
  sanctionCreatedAt: Date;
  moderatorTag: string | null;
  moderatorUserId: string | null;
  memberStatement: string | null;
  outcome: AppealItemOutcome;
  outcomeNote: string | null;
};

type AppealRecord = {
  id: string;
  guildId: string;
  userId: string;
  userTag: string | null;
  data: unknown;
  status: string;
  banReason: string | null;
  infoRequest: string | null;
  infoResponse: string | null;
  decidedByTag: string | null;
  decisionReason: string | null;
  staffChannelId: string | null;
  staffMessageId: string | null;
  createdAt: Date;
  messages?: any;
  sanctions?: AppealItemRecord[];
};

/** Recharge les sanctions contestees d'un appel (ordre de soumission). */
async function loadAppealItems(appealId: string): Promise<AppealItemRecord[]> {
  return prisma.banAppealSanction.findMany({
    where: { appealId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      sanctionId: true,
      sanctionType: true,
      sanctionReason: true,
      sanctionCreatedAt: true,
      moderatorTag: true,
      moderatorUserId: true,
      memberStatement: true,
      outcome: true,
      outcomeNote: true,
    },
  });
}

function buildAppealEmbed(appeal: AppealRecord): EmbedBuilder {
  const meta = STATUS_META[appeal.status] ?? STATUS_META.PENDING;
  const answers = (appeal.data ?? {}) as Record<string, unknown>;

  const isBanAppeal = (appeal.sanctions ?? []).length === 0;
  const embed = new EmbedBuilder()
    .setTitle(`${meta.emoji} ${isBanAppeal ? 'Demande de débannissement' : 'Contestation de sanction'} - ${appeal.userTag || appeal.userId}`)
    .setColor(meta.color)
    .setDescription(
      [
        `**Membre :** <@${appeal.userId}> (\`${appeal.userId}\`)`,
        `**Raison du ban :** ${appeal.banReason || '_Non renseignée_'}`,
        `**Statut :** ${meta.label}`,
      ].join('\n')
    )
    .setTimestamp(appeal.createdAt)
    .setFooter({ text: `Appel ID: ${appeal.id}` });

  let fieldCount = 0;
  for (const [key, value] of Object.entries(answers)) {
    if (fieldCount >= 20) break;
    const text = Array.isArray(value) ? value.join(', ') : String(value ?? '');
    if (!text.trim()) continue;
    embed.addFields({
      name: key.replace(/^appeal_/, '').replace(/_/g, ' ').slice(0, 250) || 'Réponse',
      value: text.slice(0, 1000),
    });
    fieldCount++;
  }

  const items = appeal.sanctions ?? [];
  if (items.length > 0) {
    const lines = items.map((item, index) => {
      const meta = OUTCOME_META[item.outcome] ?? OUTCOME_META.PENDING;
      const date = `<t:${Math.floor(item.sanctionCreatedAt.getTime() / 1000)}:d>`;
      const statement = item.memberStatement ? `\n   ↳ _${item.memberStatement.slice(0, 200)}_` : '';
      const gone = item.sanctionId ? '' : ' _(sanction supprimée)_';
      return `**${index + 1}.** ${sanctionTypeLabel(item.sanctionType)} · ${date} · ${meta.emoji} ${meta.label}${gone}\n   ${item.sanctionReason.slice(0, 180)}${statement}`;
    });
    embed.addFields({
      name: `⚖️ Sanctions contestées (${items.length})`,
      value: lines.join('\n').slice(0, 1024),
    });
  }

  if (appeal.infoRequest) {
    embed.addFields({ name: '💬 Infos demandées', value: appeal.infoRequest.slice(0, 1000) });
  }
  if (appeal.infoResponse) {
    embed.addFields({ name: '↩️ Réponse du membre', value: appeal.infoResponse.slice(0, 1000) });
  }
  if (appeal.decisionReason) {
    embed.addFields({ name: '📝 Décision', value: `${appeal.decisionReason.slice(0, 900)}\n- ${appeal.decidedByTag || 'staff'}` });
  }

  return embed;
}

// Discord plafonne un message a 5 rangees de composants : une pour les boutons
// de decision, donc au plus 4 menus de verdict. Au-dela, le staff tranche depuis
// le dashboard, ou tout tient.
const MAX_ITEM_SELECTS = 4;

type AppealComponentRow =
  | ActionRowBuilder<ButtonBuilder>
  | ActionRowBuilder<StringSelectMenuBuilder>;

function buildItemSelect(
  appealId: string,
  item: AppealItemRecord,
  index: number,
  decided: boolean
): ActionRowBuilder<StringSelectMenuBuilder> {
  const options = (
    [
      ['UPHELD', 'Maintenir la sanction'],
      ['ARCHIVED', 'Archiver (annuler, garder la trace)'],
      ['DELETED', 'Supprimer definitivement'],
      ['LOCKED', 'Maintenir et verrouiller'],
    ] as const
  ).map(([value, label]) =>
    new StringSelectMenuOptionBuilder()
      .setValue(value)
      .setLabel(label)
      .setEmoji(OUTCOME_META[value as AppealItemOutcome].emoji)
      .setDefault(item.outcome === value)
  );

  const current = OUTCOME_META[item.outcome] ?? OUTCOME_META.PENDING;
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`appeal_item:${appealId}:${item.id}`)
    .setPlaceholder(
      `${index + 1}. ${sanctionTypeLabel(item.sanctionType)} - ${current.label}`.slice(0, 100)
    )
    .setMinValues(1)
    .setMaxValues(1)
    .addOptions(options)
    .setDisabled(decided || !item.sanctionId);

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function buildAppealButtons(
  appealId: string,
  status: string,
  items: AppealItemRecord[] = []
): AppealComponentRow[] {
  const decided = status === 'ACCEPTED' || status === 'DENIED' || status === 'DENIED_PERMANENT';
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`appeal:accept:${appealId}`).setLabel('Accepter').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(decided),
    new ButtonBuilder().setCustomId(`appeal:deny:${appealId}`).setLabel('Refuser').setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(decided),
    new ButtonBuilder().setCustomId(`appeal:permdeny:${appealId}`).setLabel('Refus définitif').setEmoji('⛔').setStyle(ButtonStyle.Danger).setDisabled(decided),
    new ButtonBuilder().setCustomId(`appeal:info:${appealId}`).setLabel("Plus d'infos").setEmoji('💬').setStyle(ButtonStyle.Secondary).setDisabled(decided),
    new ButtonBuilder().setLabel('Dashboard').setStyle(ButtonStyle.Link).setURL(`${DASHBOARD_URL}/security/sanctions/appeals`)
  );

  const selects = items
    .slice(0, MAX_ITEM_SELECTS)
    .map((item, index) => buildItemSelect(appealId, item, index, decided));

  return [...selects, buttons];
}

// Le salon staff peut vivre sur un serveur staff dédié lié (StaffServerLink),
// pas seulement sur le serveur principal : on résout via le cache global des
// salons du client plutôt que via guild.channels (limité à un seul serveur).
async function fetchStaffChannel(client: Client, channelId: string) {
  return client.channels.cache.get(channelId) ?? (await client.channels.fetch(channelId).catch(() => null));
}

async function postStaffEmbed(client: Client, appeal: AppealRecord, config: { staffChannelId?: string | null } | null) {
  if (!config?.staffChannelId) return;
  const channel = await fetchStaffChannel(client, config.staffChannelId);
  if (!channel?.isSendable()) return;

  const items = appeal.sanctions ?? (await loadAppealItems(appeal.id));
  const message = await channel.send({
    embeds: [buildAppealEmbed({ ...appeal, sanctions: items })],
    components: buildAppealButtons(appeal.id, appeal.status, items),
  });

  await prisma.banAppeal.update({
    where: { id: appeal.id },
    data: { staffChannelId: channel.id, staffMessageId: message.id },
  });
}

export async function refreshStaffEmbed(client: Client, appeal: AppealRecord) {
  if (!appeal.staffChannelId || !appeal.staffMessageId) return;
  try {
    const channel = await fetchStaffChannel(client, appeal.staffChannelId);
    if (!channel?.isTextBased()) return;
    const message = await channel.messages.fetch(appeal.staffMessageId).catch(() => null);
    if (!message) return;
    // Les verdicts par sanction changent hors de ce chemin (dashboard, menus) :
    // on relit systematiquement plutot que de faire confiance a l'objet recu.
    const items = await loadAppealItems(appeal.id);
    await message.edit({
      embeds: [buildAppealEmbed({ ...appeal, sanctions: items })],
      components: buildAppealButtons(appeal.id, appeal.status, items),
    });
  } catch (err) {
    logger.warn('BanAppeal', `Could not refresh staff embed for appeal ${appeal.id}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ============================================================================
// VERDICT PAR SANCTION
// ============================================================================

export type AppealActor = { userId: string; tag?: string | null };

/**
 * Le moderateur qui a prononce une sanction ne peut pas trancher son propre
 * appel quand `excludeIssuingModerator` est actif. Renvoie les lignes bloquantes.
 */
export async function findConflictingItems(
  appealId: string,
  staffUserId: string,
  config?: AppealConfigRecord
): Promise<AppealItemRecord[]> {
  const cfg = config ?? null;
  if (cfg && !cfg.excludeIssuingModerator) return [];
  const items = await loadAppealItems(appealId);
  return items.filter(item => item.moderatorUserId === staffUserId);
}

/**
 * Applique un verdict a une sanction contestee : archivage, suppression ou
 * verrouillage passent par le service d'archivage, pour que le geste soit
 * strictement le meme que depuis la page Sanctions.
 */
export async function applyItemOutcome(
  client: Client,
  params: {
    guildId: string;
    itemId: string;
    outcome: AppealItemOutcome;
    actor: AppealActor;
    note?: string | null;
  }
): Promise<{ ok: false; error: string } | { ok: true; item: AppealItemRecord }> {
  const item = await prisma.banAppealSanction.findFirst({
    where: { id: params.itemId, guildId: params.guildId },
    include: { appeal: { select: { id: true, userId: true, status: true } } },
  });
  if (!item) return { ok: false, error: 'Sanction contestée introuvable' };

  const actor = { userId: params.actor.userId, tag: params.actor.tag ?? null };
  const note = params.note?.trim().slice(0, 500) || null;

  if (item.sanctionId) {
    switch (params.outcome) {
      case AppealItemOutcome.ARCHIVED:
        await archiveSanctions(params.guildId, [item.sanctionId], actor, note ?? 'Appel accepté');
        // Une sanction annulée ne doit plus être suivie par le cron
        // d'expiration (déban/untimeout automatiques) : on la clôt aussi.
        await prisma.sanction.updateMany({
          where: { id: item.sanctionId, status: 'ACTIVE' },
          data: {
            status: 'RESOLVED',
            resolvedAt: new Date(),
            resolutionNote: `Contestation acceptée par ${actor.tag || actor.userId}`,
          },
        }).catch(() => null);
        await liftSanctionEffect(client, params.guildId, item.appeal.userId, item.sanctionType, actor);
        break;
      case AppealItemOutcome.DELETED:
        await liftSanctionEffect(client, params.guildId, item.appeal.userId, item.sanctionType, actor);
        await deleteSanctions(params.guildId, [item.sanctionId], actor);
        break;
      case AppealItemOutcome.LOCKED:
        await setSanctionAppealLock(params.guildId, [item.sanctionId], true, actor, note ?? 'Appel refusé définitivement');
        break;
      case AppealItemOutcome.UPHELD:
      case AppealItemOutcome.PENDING:
      default:
        break;
    }
  }

  const updated = await prisma.banAppealSanction.update({
    where: { id: item.id },
    data: {
      outcome: params.outcome,
      outcomeNote: note,
      decidedAt: params.outcome === AppealItemOutcome.PENDING ? null : new Date(),
      decidedByUserId: params.outcome === AppealItemOutcome.PENDING ? null : actor.userId,
      decidedByTag: params.outcome === AppealItemOutcome.PENDING ? null : actor.tag,
    },
    select: {
      id: true,
      sanctionId: true,
      sanctionType: true,
      sanctionReason: true,
      sanctionCreatedAt: true,
      moderatorTag: true,
      moderatorUserId: true,
      memberStatement: true,
      outcome: true,
      outcomeNote: true,
    },
  });

  const appeal = await prisma.banAppeal.findUnique({ where: { id: item.appealId } });
  if (appeal) await refreshStaffEmbed(client, appeal);

  return { ok: true, item: updated };
}

/**
 * Leve l'effet Discord d'une sanction annulee : deban pour un bannissement,
 * retrait du timeout pour une exclusion. Un warn, un kick ou un softban n'ont
 * plus d'effet en cours a lever.
 */
async function liftSanctionEffect(
  client: Client,
  guildId: string,
  userId: string,
  type: SanctionType,
  actor: AppealActor
): Promise<void> {
  const guild = await fetchGuild(client, guildId);
  if (!guild) return;
  const reason = `Appel accepté par ${actor.tag || actor.userId}`;

  if (type === SanctionType.BAN || type === SanctionType.TEMP_BAN) {
    const ban = await guild.bans.fetch(userId).catch(() => null);
    if (ban) await guild.members.unban(userId, reason).catch(() => null);
    return;
  }

  if (type === SanctionType.TIMEOUT) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member?.isCommunicationDisabled()) await member.timeout(null, reason).catch(() => null);
  }
}

/** Verdict par defaut deduit de la decision globale prise par le staff. */
function defaultOutcomeFor(decision: AppealDecision): AppealItemOutcome {
  if (decision === 'ACCEPTED') return AppealItemOutcome.ARCHIVED;
  if (decision === 'DENIED_PERMANENT') return AppealItemOutcome.LOCKED;
  return AppealItemOutcome.UPHELD;
}

// ============================================================================
// DÉCISION
// ============================================================================

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => vars[key] ?? `{${key}}`);
}

export async function createReturnInvite(client: Client, guildId: string, inviteChannelId?: string | null): Promise<string | null> {
  const guild = await fetchGuild(client, guildId);
  if (!guild) return null;

  const me = guild.members.me;
  const candidates = [
    inviteChannelId ? guild.channels.cache.get(inviteChannelId) : null,
    guild.rulesChannel,
    guild.systemChannel,
    ...guild.channels.cache
      .filter(c => c.isTextBased() && !c.isThread() && !!me && c.permissionsFor(me)?.has(PermissionFlagsBits.CreateInstantInvite))
      .values(),
  ];

  for (const channel of candidates) {
    if (!channel || channel.isThread() || !('createInvite' in channel)) continue;
    const invite = await channel
      .createInvite({ maxAge: 7 * 24 * 60 * 60, maxUses: 1, unique: true, reason: 'Appel de bannissement accepté' })
      .catch(() => null);
    if (invite) {
      await recordBotInvite(invite, INVITE_SOURCE.banAppeal());
      return invite.url;
    }
  }
  return null;
}

export async function sendMemberDM(client: Client, userId: string, content: string): Promise<boolean> {
  try {
    const user = await client.users.fetch(userId);
    await user.send({ content });
    return true;
  } catch {
    return false;
  }
}

/**
 * Envoie au membre le lien public de l'appel de bannissement par DM, si la
 * configuration l'active. À appeler AVANT d'exécuter le ban Discord (une fois
 * banni, l'utilisateur peut ne plus partager de serveur avec le bot et le DM
 * échouera silencieusement selon ses réglages de confidentialité).
 */
export async function sendBanAppealNotificationDM(client: Client, guildId: string, userId: string): Promise<boolean> {
  const config = await getAppealConfig(guildId);
  if (!config?.enabled || !config?.notifyOnBanDM) return false;

  const guild = await fetchGuild(client, guildId);
  const serverName = guild?.name || 'ce serveur';
  const link = `${DASHBOARD_URL}/appeal/${guildId}`;

  return sendMemberDM(
    client,
    userId,
    `Tu as été banni définitivement de **${serverName}**.\n\nSi tu penses qu'il s'agit d'une erreur, tu peux soumettre une demande de débannissement ici : ${link}`
  );
}

const PRE_ACTION_INTRO: Partial<Record<SanctionType, string>> = {
  KICK: 'Tu as été expulsé de',
  BAN: 'Tu as été banni définitivement de',
  TEMP_BAN: 'Tu as été banni temporairement de',
  SOFTBAN: 'Tu as fait l\'objet d\'un softban sur',
};

/**
 * Prévient le membre AVANT une sanction qui le sort du serveur (kick, ban,
 * tempban, softban) : une fois parti, il ne partage plus forcément de serveur
 * avec le bot et le DM échouerait silencieusement.
 *
 * Pour le ban définitif, l'ancien réglage `notifyOnBanDM` reste honoré seul ;
 * les autres types dépendent de `notifyOnSanctionDM` et de leur activation.
 */
export async function sendPreActionAppealDM(
  client: Client,
  guildId: string,
  userId: string,
  type: SanctionType
): Promise<boolean> {
  const config = await getAppealConfig(guildId);
  if (!config?.enabled) return false;

  const wanted = type === SanctionType.BAN
    ? config.notifyOnBanDM || config.notifyOnSanctionDM
    : config.notifyOnSanctionDM;
  if (!wanted) return false;
  if (!resolveAppealableTypes(config).includes(type)) return false;

  const guild = await fetchGuild(client, guildId);
  const serverName = guild?.name || 'ce serveur';
  const link = `${DASHBOARD_URL}/appeal/${guildId}`;
  const intro = PRE_ACTION_INTRO[type] ?? 'Tu as reçu une sanction sur';

  return sendMemberDM(
    client,
    userId,
    `${intro} **${serverName}**.\n\nSi tu penses qu'il s'agit d'une erreur, tu peux la contester ici : ${link}`
  );
}

/**
 * Previent le membre qu'il vient de recevoir une sanction contestable, avec le
 * lien direct vers la page d'appel pre-remplie.
 *
 * A appeler apres l'enregistrement de la sanction pour les types ou le membre
 * reste sur le serveur (warn, timeout) ; pour un kick ou un ban, le DM doit
 * partir AVANT l'action, via `sendBanAppealNotificationDM`.
 */
export async function sendSanctionAppealDM(
  client: Client,
  guildId: string,
  sanction: { id: string; targetUserId: string; type: SanctionType; reason: string }
): Promise<boolean> {
  const config = await getAppealConfig(guildId);
  if (!config?.enabled || !config.notifyOnSanctionDM) return false;
  if (!resolveAppealableTypes(config).includes(sanction.type)) return false;

  const guild = await fetchGuild(client, guildId);
  const serverName = guild?.name || 'ce serveur';
  const link = `${DASHBOARD_URL}/appeal/${guildId}?sanction=${encodeURIComponent(sanction.id)}`;

  return sendMemberDM(
    client,
    sanction.targetUserId,
    [
      `Tu as reçu une sanction sur **${serverName}**.`,
      `**Type :** ${sanctionTypeLabel(sanction.type)}`,
      `**Raison :** ${sanction.reason.slice(0, 500)}`,
      '',
      `Si tu estimes que c'est une erreur, tu peux la contester ici : ${link}`,
    ].join('\n')
  );
}

export async function decideAppeal(
  client: Client,
  params: {
    appealId: string;
    guildId: string;
    decision: AppealDecision;
    staffUserId: string;
    staffTag?: string;
    reason?: string;
    /** Verdict par sanction contestée (id de ligne d'appel -> verdict). */
    outcomes?: Record<string, AppealItemOutcome>;
  }
) {
  const appeal = await prisma.banAppeal.findFirst({
    where: { id: params.appealId, guildId: params.guildId },
  });
  if (!appeal) return { ok: false as const, error: 'Appel introuvable' };
  if (appeal.status === 'ACCEPTED' || appeal.status === 'DENIED' || appeal.status === 'DENIED_PERMANENT') {
    return { ok: false as const, error: 'Cet appel a déjà été tranché' };
  }

  const config = await getAppealConfig(params.guildId);
  const guild = await fetchGuild(client, params.guildId);
  const serverName = guild?.name || 'ce serveur';

  // Conflit d'intérêt : on refuse avant tout effet de bord, pas au milieu.
  const conflicts = await findConflictingItems(params.appealId, params.staffUserId, config);
  if (conflicts.length > 0) {
    return {
      ok: false as const,
      error: "Tu as prononcé une des sanctions contestées : un autre membre du staff doit trancher cet appel.",
    };
  }

  const items = await loadAppealItems(params.appealId);
  const actor: AppealActor = { userId: params.staffUserId, tag: params.staffTag ?? null };

  // Verdict par sanction : ce que le staff a choisi, sinon le verdict par
  // défaut de la décision globale.
  for (const item of items) {
    const outcome = params.outcomes?.[item.id] ?? defaultOutcomeFor(params.decision);
    if (outcome === AppealItemOutcome.PENDING) continue;
    await applyItemOutcome(client, {
      guildId: params.guildId,
      itemId: item.id,
      outcome,
      actor,
      note: params.reason,
    }).catch(err => logger.warn('BanAppeal', `Could not apply outcome for item ${item.id}:`, err));
  }

  // Le bloc ban historique ne s'applique qu'aux appels sans sanction rattachée :
  // quand des lignes existent, `applyItemOutcome` a déjà levé les effets Discord
  // sanction par sanction.
  const isLegacyBanAppeal = items.length === 0;

  let dmDelivered = false;

  if (params.decision === 'ACCEPTED' && isLegacyBanAppeal) {
    if (config?.appealVerification) {
      // 1. Résoudre les sanctions BAN actives correspondantes
      await prisma.sanction.updateMany({
        where: { guildId: params.guildId, targetUserId: appeal.userId, type: 'BAN', status: 'ACTIVE' },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          resolutionNote: `Appel de bannissement accepté par ${params.staffTag || params.staffUserId} (En attente de vérification OAuth)`,
        },
      }).catch(err => logger.warn('BanAppeal', 'Could not resolve linked sanctions:', err));

      // 2. Créer la session de vérification et envoyer le lien par DM
      const { createVerificationSession, buildVerificationUrl } = await import('./securityVerificationService.js');
      const token = await createVerificationSession(
        params.guildId,
        appeal.userId,
        (config as any).appealVerificationLevel || 'HIGH',
        appeal.id
      );
      const verifyUrl = buildVerificationUrl(DASHBOARD_URL, params.guildId, token);
      const message = `Bonne nouvelle ! Ta demande de débannissement sur **${serverName}** a été acceptée par le staff.\n\nPour pouvoir rejoindre le serveur, tu dois d'abord authentifier ton compte en complétant la vérification de sécurité en cliquant sur ce lien : ${verifyUrl}`;
      dmDelivered = await sendMemberDM(client, appeal.userId, message);
    } else {
      // 1. Unban via l'API Discord
      if (guild) {
        await guild.members
          .unban(appeal.userId, `Appel accepté par ${params.staffTag || params.staffUserId}`)
          .catch(err => logger.warn('BanAppeal', `Unban failed for ${appeal.userId}: ${err instanceof Error ? err.message : String(err)}`));
      }

      // 2. Résoudre les sanctions BAN actives correspondantes
      await prisma.sanction.updateMany({
        where: { guildId: params.guildId, targetUserId: appeal.userId, type: 'BAN', status: 'ACTIVE' },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          resolutionNote: `Appel de bannissement accepté par ${params.staffTag || params.staffUserId}`,
        },
      }).catch(err => logger.warn('BanAppeal', 'Could not resolve linked sanctions:', err));

      // 3. Invitation fraîche + DM
      const inviteUrl = await createReturnInvite(client, params.guildId, config?.inviteChannelId);
      const message = renderTemplate(config?.acceptMessage || DEFAULT_ACCEPT_MESSAGE, {
        server: serverName,
        invite: inviteUrl || '(invitation indisponible - contacte un membre du staff)',
        reason: params.reason || '',
      });
      dmDelivered = await sendMemberDM(client, appeal.userId, message);
    }
  } else if (params.decision === 'ACCEPTED') {
    // Appel portant sur des sanctions : le verdict a déjà été appliqué ligne par
    // ligne, il ne reste qu'à annoncer le résultat au membre.
    const summary = await summarizeOutcomes(params.appealId);

    // Un bannissement levé ne suffit pas : sans invitation, le membre n'a aucun
    // moyen de revenir.
    const decidedItems = await loadAppealItems(params.appealId);
    const banLifted = decidedItems.some(
      item =>
        (item.sanctionType === SanctionType.BAN || item.sanctionType === SanctionType.TEMP_BAN) &&
        (item.outcome === AppealItemOutcome.ARCHIVED || item.outcome === AppealItemOutcome.DELETED)
    );
    const inviteUrl = banLifted
      ? await createReturnInvite(client, params.guildId, config?.inviteChannelId)
      : null;

    dmDelivered = await sendMemberDM(
      client,
      appeal.userId,
      [
        `✅ Ta contestation sur **${serverName}** a été acceptée.`,
        summary,
        params.reason ? `\n**Note du staff :** ${params.reason}` : '',
        inviteUrl ? `\nTu peux revenir avec cette invitation : ${inviteUrl}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    );
  } else {
    if (params.decision === 'DENIED_PERMANENT') {
      await prisma.banAppealBlacklist.upsert({
        where: { guildId_userId: { guildId: params.guildId, userId: appeal.userId } },
        create: {
          guildId: params.guildId,
          userId: appeal.userId,
          reason: params.reason || 'Refus définitif de l\'appel',
          addedByUserId: params.staffUserId,
          addedByTag: params.staffTag ?? null,
        },
        update: { reason: params.reason || 'Refus définitif de l\'appel' },
      });
    }

    const denyBase = isLegacyBanAppeal
      ? renderTemplate(config?.denyMessage || DEFAULT_DENY_MESSAGE, {
          server: serverName,
          reason: params.reason || 'Non communiquée',
          invite: '',
        })
      : [
          `❌ Ta contestation sur **${serverName}** a été refusée.`,
          `Raison : ${params.reason || 'Non communiquée'}`,
          await summarizeOutcomes(params.appealId),
        ].join('\n');
    const cooldownDays = await cooldownDaysForAppeal(config, params.appealId);
    const suffix =
      params.decision === 'DENIED_PERMANENT'
        ? '\n\n⛔ Cette décision est définitive : aucun nouvel appel ne sera accepté.'
        : `\n\nTu pourras soumettre un nouvel appel dans ${cooldownDays} jours : ${DASHBOARD_URL}/appeal/${params.guildId}`;
    dmDelivered = await sendMemberDM(client, appeal.userId, denyBase + suffix);
  }

  const updated = await prisma.banAppeal.update({
    where: { id: appeal.id },
    data: {
      status: params.decision,
      decidedByUserId: params.staffUserId,
      decidedByTag: params.staffTag ?? null,
      decisionReason: params.reason ?? null,
      decidedAt: new Date(),
      dmDelivered,
    },
  });

  await refreshStaffEmbed(client, updated);
  return { ok: true as const, appeal: updated };
}

/** Rend le verdict de chaque sanction sous forme de liste, pour les DM. */
async function summarizeOutcomes(appealId: string): Promise<string> {
  const items = await loadAppealItems(appealId);
  if (items.length === 0) return '';
  return items
    .map(item => {
      const meta = OUTCOME_META[item.outcome] ?? OUTCOME_META.PENDING;
      return `${meta.emoji} ${sanctionTypeLabel(item.sanctionType)} - ${meta.label}`;
    })
    .join('\n');
}

export async function requestAppealInfo(
  client: Client,
  params: { appealId: string; guildId: string; question: string; staffUserId: string; staffTag?: string }
) {
  const appeal = await (prisma.banAppeal as any).findFirst({
    where: { id: params.appealId, guildId: params.guildId },
  });
  if (!appeal) return { ok: false as const, error: 'Appel introuvable' };
  if (appeal.status !== 'PENDING' && appeal.status !== 'NEEDS_INFO') {
    return { ok: false as const, error: 'Cet appel a déjà été tranché' };
  }

  const currentMessages = Array.isArray((appeal as any).messages) ? ((appeal as any).messages as any[]) : [];
  const newMessages = [
    ...currentMessages,
    {
      author: 'staff',
      authorTag: params.staffTag || 'staff',
      authorId: params.staffUserId,
      content: params.question,
      createdAt: new Date().toISOString(),
    },
  ];

  const updated = await (prisma.banAppeal as any).update({
    where: { id: appeal.id },
    data: {
      status: 'NEEDS_INFO',
      infoRequest: params.question,
      infoResponse: null,
      infoRequestedAt: new Date(),
      messages: newMessages as any,
    },
  });

  const guild = await fetchGuild(client, params.guildId);
  await sendMemberDM(
    client,
    appeal.userId,
    `Le staff de **${guild?.name || 'ce serveur'}** a besoin de plus d'informations sur ta demande de débannissement :\n> ${params.question}\n\nRéponds ici : ${DASHBOARD_URL}/appeal/${params.guildId}`
  );

  await refreshStaffEmbed(client, updated);
  return { ok: true as const, appeal: updated };
}

export async function submitAppealInfoResponse(client: Client, guildId: string, userId: string, response: string) {
  const appeal = await (prisma.banAppeal as any).findFirst({
    where: { guildId, userId, status: 'NEEDS_INFO' },
    orderBy: { createdAt: 'desc' },
  });
  if (!appeal) return { ok: false as const, error: "Aucune demande d'informations en attente" };

  const currentMessages = Array.isArray((appeal as any).messages) ? ((appeal as any).messages as any[]) : [];
  const newMessages = [
    ...currentMessages,
    {
      author: 'user',
      content: response.slice(0, 2000),
      createdAt: new Date().toISOString(),
    },
  ];

  const updated = await (prisma.banAppeal as any).update({
    where: { id: appeal.id },
    data: {
      status: 'PENDING',
      infoResponse: response.slice(0, 2000),
      messages: newMessages as any,
    },
  });

  await refreshStaffEmbed(client, updated);
  return { ok: true as const, appeal: updated };
}

// ============================================================================
// LECTURE (dashboard)
// ============================================================================

export async function getAppeals(guildId: string, status?: BanAppealStatus) {
  return prisma.banAppeal.findMany({
    where: { guildId, ...(status ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: {
      sanctions: {
        orderBy: { createdAt: 'asc' },
        select: { id: true, sanctionType: true, outcome: true },
      },
    },
  });
}

export async function getAppealDetail(appealId: string, guildId: string) {
  const appeal = await prisma.banAppeal.findFirst({
    where: { id: appealId, guildId },
    include: { sanctions: { orderBy: { createdAt: 'asc' } } },
  });
  if (!appeal) return null;

  // Casier complet du membre, archives comprises : le staff a besoin du contexte
  // pour juger, y compris des sanctions déjà annulées.
  const sanctions = await prisma.sanction.findMany({
    where: { guildId, targetUserId: appeal.userId },
    orderBy: { createdAt: 'desc' },
    take: 25,
    select: {
      id: true,
      type: true,
      status: true,
      reason: true,
      createdAt: true,
      moderatorTag: true,
      archivedAt: true,
      appealable: true,
    },
  });

  const previousAppeals = await prisma.banAppeal.findMany({
    where: { guildId, userId: appeal.userId, id: { not: appealId } },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, createdAt: true, decidedAt: true, decisionReason: true },
  });

  return { appeal, sanctions, previousAppeals };
}

/**
 * Statistiques d'appels par modérateur : taux d'acceptation des contestations
 * visant les sanctions qu'il a prononcées. Un taux anormalement haut signale
 * un modérateur qui sanctionne mal, pas un staff trop clément.
 */
export async function getModeratorAppealStats(guildId: string) {
  const items = await prisma.banAppealSanction.findMany({
    where: { guildId, moderatorUserId: { not: null } },
    select: { moderatorUserId: true, moderatorTag: true, outcome: true },
  });

  const byModerator = new Map<
    string,
    { moderatorUserId: string; moderatorTag: string | null; contested: number; overturned: number; upheld: number; pending: number }
  >();

  for (const item of items) {
    const key = item.moderatorUserId as string;
    const entry = byModerator.get(key) ?? {
      moderatorUserId: key,
      moderatorTag: item.moderatorTag,
      contested: 0,
      overturned: 0,
      upheld: 0,
      pending: 0,
    };
    entry.contested += 1;
    if (item.outcome === AppealItemOutcome.ARCHIVED || item.outcome === AppealItemOutcome.DELETED) entry.overturned += 1;
    else if (item.outcome === AppealItemOutcome.PENDING) entry.pending += 1;
    else entry.upheld += 1;
    byModerator.set(key, entry);
  }

  return [...byModerator.values()]
    .map(entry => ({
      ...entry,
      overturnRate: entry.contested > 0 ? Math.round((entry.overturned / entry.contested) * 100) : 0,
    }))
    .sort((a, b) => b.contested - a.contested);
}

// ============================================================================
// INTERACTIONS DISCORD (boutons + modals du salon staff)
// ============================================================================

function hasDecisionPermission(
  interaction: ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction
): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.BanMembers) ?? false;
}

/**
 * Menu « verdict » d'une sanction contestée, dans l'embed staff.
 * customId : appeal_item:<appealId>:<itemId>
 */
export async function handleAppealItemSelect(
  client: Client,
  customId: string,
  interaction: StringSelectMenuInteraction
): Promise<void> {
  const [, appealId, itemId] = customId.split(':');
  if (!appealId || !itemId || !interaction.guildId) return;

  if (!hasDecisionPermission(interaction)) {
    await interaction.reply({
      content: '❌ Tu dois avoir la permission **Bannir des membres** pour trancher un appel.',
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const outcome = interaction.values[0] as AppealItemOutcome;
  if (!Object.values(AppealItemOutcome).includes(outcome)) return;

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  const config = await getAppealConfig(interaction.guildId);
  const conflicts = await findConflictingItems(appealId, interaction.user.id, config);
  if (conflicts.some(item => item.id === itemId)) {
    await interaction.editReply({
      content: "❌ Tu as prononcé cette sanction : un autre membre du staff doit trancher.",
    });
    return;
  }

  const result = await applyItemOutcome(client, {
    guildId: interaction.guildId,
    itemId,
    outcome,
    actor: { userId: interaction.user.id, tag: interaction.user.tag },
  });

  if (!result.ok) {
    await interaction.editReply({ content: `❌ ${result.error}` });
    return;
  }

  const meta = OUTCOME_META[outcome];
  await interaction.editReply({
    content: `${meta.emoji} ${sanctionTypeLabel(result.item.sanctionType)} : ${meta.label.toLowerCase()}. Valide ensuite l'appel avec **Accepter** ou **Refuser** pour prévenir le membre.`,
  });
}

export async function handleAppealButton(client: Client, customId: string, interaction: ButtonInteraction) {
  const [, action, appealId] = customId.split(':');
  if (!appealId) return;

  if (!hasDecisionPermission(interaction)) {
    await interaction.reply({
      content: '❌ Tu dois avoir la permission **Bannir des membres** pour traiter un appel.',
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  // Conflit d'intérêt : autant le dire avant d'ouvrir le modal.
  if (interaction.guildId && action !== 'info') {
    const config = await getAppealConfig(interaction.guildId);
    const conflicts = await findConflictingItems(appealId, interaction.user.id, config);
    if (conflicts.length > 0) {
      await interaction.reply({
        content: "❌ Tu as prononcé une des sanctions contestées : un autre membre du staff doit trancher cet appel.",
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }
  }

  const titles: Record<string, string> = {
    accept: "Accepter l'appel",
    deny: "Refuser l'appel",
    permdeny: 'Refus définitif (blacklist)',
    info: "Demander plus d'infos",
  };
  const title = titles[action];
  if (!title) return;

  const input = new TextInputBuilder()
    .setCustomId('appeal_input')
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(1000);

  if (action === 'info') {
    input.setLabel('Question à poser au membre').setRequired(true).setPlaceholder('Ex: Peux-tu préciser ce qui s\'est passé le soir du ban ?');
  } else if (action === 'accept') {
    input.setLabel('Note (optionnelle)').setRequired(false).setPlaceholder('Visible par le membre dans le DM de verdict.');
  } else {
    input.setLabel('Raison du refus').setRequired(true).setPlaceholder('Communiquée au membre par DM.');
  }

  const modal = new ModalBuilder()
    .setCustomId(`appeal_modal:${action}:${appealId}`)
    .setTitle(title.slice(0, 45))
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));

  await interaction.showModal(modal);
}

export async function handleAppealModalSubmit(client: Client, customId: string, interaction: ModalSubmitInteraction) {
  const [, action, appealId] = customId.split(':');
  if (!appealId || !interaction.guildId) return;

  if (!hasDecisionPermission(interaction)) {
    await interaction.reply({ content: '❌ Permission insuffisante.', flags: [MessageFlags.Ephemeral] });
    return;
  }

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
  const text = interaction.fields.getTextInputValue('appeal_input') || undefined;

  let result: { ok: boolean; error?: string };
  if (action === 'info') {
    result = await requestAppealInfo(client, {
      appealId,
      guildId: interaction.guildId,
      question: text || '',
      staffUserId: interaction.user.id,
      staffTag: interaction.user.tag,
    });
  } else {
    const decision: AppealDecision = action === 'accept' ? 'ACCEPTED' : action === 'permdeny' ? 'DENIED_PERMANENT' : 'DENIED';
    result = await decideAppeal(client, {
      appealId,
      guildId: interaction.guildId,
      decision,
      staffUserId: interaction.user.id,
      staffTag: interaction.user.tag,
      reason: text,
    });
  }

  if (!result.ok) {
    await interaction.editReply({ content: `❌ ${result.error || 'Action impossible'}` });
    return;
  }

  const confirmations: Record<string, string> = {
    accept: '✅ Appel accepté : le membre a été débanni et prévenu par DM.',
    deny: '❌ Appel refusé, le membre a été prévenu par DM.',
    permdeny: '⛔ Appel refusé définitivement : le membre ne pourra plus faire appel.',
    info: '💬 Demande d\'informations envoyée au membre.',
  };
  await interaction.editReply({ content: confirmations[action] || '✅ Fait.' });
}
