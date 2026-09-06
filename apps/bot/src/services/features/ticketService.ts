import type { Ticket } from '@prisma/client';
import type { ColorResolvable } from 'discord.js';
import { type Client, type APIInteractionGuildMember, type ButtonInteraction, type ModalSubmitInteraction, type StringSelectMenuInteraction, TextChannel, ChannelType, PermissionFlagsBits, PermissionsBitField, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, type Guild, type GuildMember, type ThreadChannel, Message, ComponentType } from 'discord.js';
import { kotboEventBus } from '@kotbo/core';
import { ensureBotCanPost } from '../../utils/channelAccess.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { broadcastDashboardStateChange } from '../../api/shared/sharding.js';
import { COLORS, COLORS_RAW, successEmbed, errorEmbed, v2 } from '../../utils/embeds.js';
import { resolveEmojiShortcodes } from '../../utils/emojis.js';
import { generateTranscript } from './transcriptService.js';
import { buildMemberCasePanel } from '../moderation/memberCaseService.js';
import { handleTicketTrigger } from './autoResponseService.js';
import { embedToV2 } from '../../utils/patchV2.js';
import { type BotLocale, resolveGuildLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { isModuleEnabled } from '../core/moduleGate.js';
import {
  applyMacroActions,
  listUsableMacros,
  MACRO_SELECT_LIMIT,
  markMacroUsed,
  renderMacroContent,
  sendAutoMacros,
  suggestMacros,
} from './ticketMacroService.js';
import {
  checkMemberTicketQuota,
  checkStaffTicketLoad,
  relativeTimestamp,
  resolveTicketQuotas,
} from './ticketQuotaService.js';
import {
  archiveTicket,
  checkRestoreEligibility,
  deletionLockMessage,
  DELETION_LOCK_DURATIONS,
  lockTicketDeletion,
  nextRestoreAvailableAt,
  resolveDeletionLock,
  resolveLockDuration,
  restoreTicketFromTranscript,
  unarchiveTicket,
  unlockTicketDeletion,
} from './ticketLifecycleService.js';

function sanitizeTicketChannelName(input: string): string {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!cleaned) return '';
  return cleaned.slice(0, 100);
}

export function buildTicketChannelName(input: string, fallbackSeed: string): string {
  const sanitizedInput = sanitizeTicketChannelName(input);
  const sanitizedFallback = sanitizeTicketChannelName(fallbackSeed) || 'ticket';
  const baseName = sanitizedInput || sanitizedFallback;
  const prefixedName = baseName.startsWith('ticket-') ? baseName : `ticket-${baseName}`;
  return prefixedName.slice(0, 100);
}

type TicketPanelTypeConfig = {
  id: string;
  label: string;
  description?: string | null;
  emoji?: string | null;
  categoryId?: string | null;
  staffRoleId?: string | null;
  buttonStyle?: 'PRIMARY' | 'SECONDARY' | 'SUCCESS' | 'DANGER';
  mode?: 'CHANNEL' | 'DM' | 'THREAD' | null;
  anonymous?: boolean;
  staffServerRelay?: boolean;
  // Tickets internes : le salon du ticket est créé sur le serveur staff lié
  staffServerChannel?: boolean;
  staffServerCategoryId?: string | null;
  // Tri-etat : `null` signifie « suivre la configuration du serveur ».
  lockUntilClaim?: boolean | null;
  requireApproval?: boolean | null;
  fields?: any[] | null;
  // Surcharges de quota, meme convention tri-etat que ci-dessus.
  quotaOpenMax?: number | null;
  quotaCooldownMinutes?: number | null;
  quotaPeriodMax?: number | null;
  quotaReopenMax?: number | null;
};

/** Lit un reglage tri-etat d'un type de ticket : `null` = herite du serveur. */
function inheritedFlag(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

/** Meme convention que `inheritedFlag`, pour les surcharges numeriques. */
function inheritedNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.floor(value);
  return rounded >= 1 ? rounded : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeTicketPanelTypes(rawTypes: unknown, fallback: {
  label: string;
  description: string;
  categoryId: string | null;
  staffRoleId: string | null;
  buttonStyle?: TicketPanelTypeConfig['buttonStyle'];
  emoji?: string | null;
}): TicketPanelTypeConfig[] {
  if (Array.isArray(rawTypes) && rawTypes.length > 0) {
    return rawTypes
      .filter(isRecord)
      .map((item, index) => {
        const buttonStyle: TicketPanelTypeConfig['buttonStyle'] = item.buttonStyle === 'SECONDARY' || item.buttonStyle === 'SUCCESS' || item.buttonStyle === 'DANGER'
          ? item.buttonStyle
          : 'PRIMARY';

        const mode = item.mode === 'CHANNEL' || item.mode === 'DM' || item.mode === 'THREAD'
          ? item.mode as 'CHANNEL' | 'DM' | 'THREAD'
          : null;

        return {
          id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : `ticket-type-${index + 1}`,
          label: typeof item.label === 'string' && item.label.trim() ? item.label.trim().slice(0, 80) : `Ticket ${index + 1}`,
          description: typeof item.description === 'string' ? item.description.trim().slice(0, 200) : null,
          emoji: typeof item.emoji === 'string' ? item.emoji.trim().slice(0, 16) : null,
          categoryId: typeof item.categoryId === 'string' && item.categoryId.trim() ? item.categoryId.trim() : null,
          staffRoleId: typeof item.staffRoleId === 'string' && item.staffRoleId.trim() ? item.staffRoleId.trim() : null,
          buttonStyle,
          mode,
          anonymous: item.anonymous === true,
          staffServerRelay: item.staffServerRelay === true,
          staffServerChannel: item.staffServerChannel === true,
          staffServerCategoryId: typeof item.staffServerCategoryId === 'string' && item.staffServerCategoryId.trim() ? item.staffServerCategoryId.trim() : null,
          lockUntilClaim: inheritedFlag(item.lockUntilClaim),
          requireApproval: inheritedFlag(item.requireApproval),
          fields: Array.isArray(item.fields) ? item.fields : null,
          quotaOpenMax: inheritedNumber(item.quotaOpenMax),
          quotaCooldownMinutes: inheritedNumber(item.quotaCooldownMinutes),
          quotaPeriodMax: inheritedNumber(item.quotaPeriodMax),
          quotaReopenMax: inheritedNumber(item.quotaReopenMax),
        };
      })
      .filter((item) => item.label.length > 0);
  }

  return [{
    id: 'legacy',
    label: fallback.label,
    description: fallback.description,
    emoji: fallback.emoji ?? '📩',
    categoryId: fallback.categoryId,
    staffRoleId: fallback.staffRoleId,
    buttonStyle: fallback.buttonStyle ?? 'PRIMARY',
    lockUntilClaim: null,
    requireApproval: null,
    fields: null,
  }];
}

/** Libelle « reouvertures utilisees », sans denominateur quand rien ne plafonne. */
function reopenCapLabel(used: number, max: number | null): string {
  return max === null
    ? `Réouvertures utilisées : **${used}**.`
    : `Réouvertures utilisées : **${used}/${max}**.`;
}

/**
 * Refuse l'ouverture si un quota s'y oppose, et repond au membre. Renvoie
 * `true` quand l'interaction a ete traitee (donc que l'appelant doit s'arreter).
 *
 * Le message de refus nomme la limite atteinte : un membre qui ne sait pas
 * pourquoi il est refuse reessaie, ou ouvre un ticket ailleurs pour demander.
 */
async function refuseIfQuotaExceeded(
  client: Client,
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  guildConfig: Record<string, unknown>,
  ticketType: TicketPanelTypeConfig,
  guildId: string,
  userId: string,
): Promise<boolean> {
  const quotas = resolveTicketQuotas(guildConfig, ticketType);
  const verdict = await checkMemberTicketQuota({ guildId, userId, quotas });
  if (verdict.ok) return false;

  let content: string;

  if (verdict.kind === 'COOLDOWN') {
    content = `⏳ Vous avez ouvert un ticket il y a peu. Vous pourrez en ouvrir un nouveau ${relativeTimestamp(verdict.retryAtMs)}.`;
  } else if (verdict.kind === 'PERIOD') {
    content = `⏳ Vous avez atteint la limite de **${verdict.max} ticket(s)** sur ${verdict.hours} h. Prochaine ouverture possible ${relativeTimestamp(verdict.retryAtMs)}.`;
  } else if (verdict.blocking?.status === 'PENDING') {
    content = '⏳ Votre précédente demande de ticket attend encore la validation du staff.';
  } else if (verdict.blocking?.channelId) {
    // client.channels.fetch : le ticket peut vivre sur le serveur staff lié.
    // Salon introuvable = ticket fantome en base : on laisse passer plutot que
    // de bloquer le membre sur un salon qui n'existe plus.
    const channel = await client.channels.fetch(verdict.blocking.channelId).catch(() => null);
    if (!channel) return false;

    const ticketRef = verdict.blocking.staffServerGuildId
      ? `https://discord.com/channels/${verdict.blocking.staffServerGuildId}/${verdict.blocking.channelId}`
      : `<#${verdict.blocking.channelId}>`;
    content = verdict.max === 1
      ? `⚠️ Vous avez déjà un ticket d'ouvert : ${ticketRef}. Merci de l'utiliser !`
      : `⚠️ Vous avez déjà **${verdict.max} ticket(s)** en cours, dont ${ticketRef}. Fermez-en un avant d'en ouvrir un autre.`;
  } else {
    content = `⚠️ Vous avez déjà **${verdict.max} ticket(s)** en cours. Fermez-en un avant d'en ouvrir un autre.`;
  }

  await interaction.reply({ content, flags: [MessageFlags.Ephemeral] });
  return true;
}

/**
 * Verrouillage jusqu'a la prise en charge et validation prealable se reglent
 * pour tout le serveur, et un type de ticket peut trancher differemment. Le
 * reglage du type ne compte que s'il a ete decide (`true`/`false`) : laisse a
 * « heriter », il rend la main a la configuration du serveur.
 */
export function resolveLockUntilClaim(ticketType: TicketPanelTypeConfig, guildConfig: Record<string, unknown>): boolean {
  if (ticketType.lockUntilClaim !== null && ticketType.lockUntilClaim !== undefined) return ticketType.lockUntilClaim;
  return guildConfig.ticketLockUntilClaim === true;
}

export function resolveRequireApproval(ticketType: TicketPanelTypeConfig, guildConfig: Record<string, unknown>): boolean {
  if (ticketType.requireApproval !== null && ticketType.requireApproval !== undefined) return ticketType.requireApproval;
  return guildConfig.ticketApprovalEnabled === true;
}

function resolveTicketPanelType(guildConfig: Record<string, unknown>, typeId?: string | null): TicketPanelTypeConfig {
  const asText = (value: unknown, fallback: string) => (typeof value === 'string' && value ? value : fallback);
  const asId = (value: unknown) => (typeof value === 'string' ? value : null);

  const ticketTypes = normalizeTicketPanelTypes(guildConfig.ticketTypes, {
    label: asText(guildConfig.ticketEmbedButtonText, 'Ouvrir un ticket'),
    description: asText(guildConfig.ticketEmbedDesc, "Cliquez sur le bouton ci-dessous pour ouvrir un ticket d'assistance."),
    categoryId: asId(guildConfig.ticketCategoryId),
    staffRoleId: asId(guildConfig.ticketStaffRoleId),
    emoji: '📩',
    buttonStyle: 'PRIMARY',
  });

  if (!typeId) {
    return ticketTypes[0];
  }

  return ticketTypes.find((type) => type.id === typeId) ?? ticketTypes[0];
}

function resolveButtonStyle(style?: TicketPanelTypeConfig['buttonStyle']): ButtonStyle {
  switch (style) {
    case 'SECONDARY': return ButtonStyle.Secondary;
    case 'SUCCESS': return ButtonStyle.Success;
    case 'DANGER': return ButtonStyle.Danger;
    default: return ButtonStyle.Primary;
  }
}

/**
 * Rebuilds the welcome message's V2 container with an updated status line.
 * The welcome message is Components V2 only (no embeds), so status updates
 * (claim/close/reopen) must edit the container directly instead of touching
 * a non-existent `.embeds[0]`.
 */
function buildTicketStatusContainer(
  ticket: { id: string; ticketTypeLabel?: string | null },
  bodyText: string,
  color: number,
): ContainerBuilder {
  return new ContainerBuilder()
    .setAccentColor(color)
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`### 🎫 Ticket d'Assistance · ${ticket.ticketTypeLabel || 'Ticket'}`))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(bodyText))
    .addSeparatorComponents(new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Kotbo · Ticket ID: ${ticket.id}`));
}

export async function renameTicketChannel(
  client: Client,
  ticket: { id: string; guildId: string; channelId: string | null; userId: string; username: string; reason: string; description: string },
  guildConfig: Record<string, unknown>,
  executor: { id: string; username: string },
  newName: string,
): Promise<string> {
  if (!ticket.channelId) {
    throw new Error("Ce ticket n'a pas de salon actif à renommer.");
  }

  const channel = await client.channels.fetch(ticket.channelId).catch(() => null);
  if (!channel || !(channel instanceof TextChannel)) {
    throw new Error("Le salon du ticket est introuvable ou n'est pas un salon textuel.");
  }

  const finalName = buildTicketChannelName(newName, ticket.username || ticket.userId);
  await channel.setName(finalName, `Ticket renommé par ${executor.username}`);

  await logTicketEvent(client, guildConfig, 'RENAMED', ticket, executor, finalName);

  await channel.send({
    embeds: [successEmbed('Ticket renommé', `Le salon a été renommé en **#${finalName}** par <@${executor.id}>.`)],
  }).catch(() => null);

  return finalName;
}

/**
 * Checks if a member has permission to moderate/manage tickets.
 */
export function canManageTicket(member: GuildMember | APIInteractionGuildMember | null | undefined, guildConfig: Record<string, unknown>, ticketStaffRoleId?: string | null): boolean {
  if (!member) return false;

  const permissionBits = (member as GuildMember | APIInteractionGuildMember).permissions;
  const permissions = typeof permissionBits === 'string'
    ? new PermissionsBitField(BigInt(permissionBits))
    : new PermissionsBitField(permissionBits ?? 0n);
  if (permissions.has(PermissionFlagsBits.Administrator)) return true;

  const guildMemberRoles = (member as GuildMember).roles as { cache?: Map<string, unknown> } | undefined;
  const roleIds = guildMemberRoles?.cache
    ? Array.from(guildMemberRoles.cache.keys())
    : Array.isArray((member as APIInteractionGuildMember).roles)
      ? (member as APIInteractionGuildMember).roles
      : [];

  const moderatorRoleId = typeof guildConfig.moderatorRoleId === 'string' ? guildConfig.moderatorRoleId : null;
  if (moderatorRoleId && roleIds.includes(moderatorRoleId)) return true;
  const configuredStaffRoleId = typeof guildConfig.ticketStaffRoleId === 'string' ? guildConfig.ticketStaffRoleId : null;
  const effectiveTicketStaffRoleId = ticketStaffRoleId || configuredStaffRoleId;
  if (effectiveTicketStaffRoleId && roleIds.includes(effectiveTicketStaffRoleId)) return true;
  return false;
}

// ─── Blacklist d'ouverture ────────────────────────────────────────────────────

export type TicketBlacklistEntry = {
  reason: string | null;
  expiresAt: Date | null;
  /**
   * La blacklist ferme la creation de nouveaux tickets. Ce drapeau decide si
   * elle ferme aussi la reouverture d'un dossier deja traite : un membre exclu
   * peut avoir un litige en cours qu'on ne veut pas enterrer avec lui.
   */
  allowReopen: boolean;
};

/**
 * Renvoie l'entree de blacklist qui bloque encore ce membre, ou `null`.
 *
 * Une entree arrivee a echeance est supprimee au passage plutot que filtree a
 * chaque lecture : sans cela, la liste affichee au staff se remplirait de
 * sanctions eteintes qu'il faudrait nettoyer a la main.
 */
export async function findActiveTicketBlacklist(guildId: string, userId: string): Promise<TicketBlacklistEntry | null> {
  const entry = await prisma.ticketBlacklist.findUnique({
    where: { guildId_userId: { guildId, userId } },
    select: { id: true, reason: true, expiresAt: true, allowReopen: true },
  }).catch(() => null);
  if (!entry) return null;

  if (entry.expiresAt && entry.expiresAt.getTime() <= Date.now()) {
    await prisma.ticketBlacklist.delete({ where: { id: entry.id } }).catch(() => null);
    return null;
  }

  return { reason: entry.reason, expiresAt: entry.expiresAt, allowReopen: entry.allowReopen };
}

/** Message ephemere affiche au membre blacklisté qui tente d'ouvrir un ticket. */
export function ticketBlacklistMessage(entry: TicketBlacklistEntry): string {
  const reasonLine = entry.reason ? `\n**Raison :** ${entry.reason}` : '';
  const untilLine = entry.expiresAt
    ? `\n**Jusqu'au :** <t:${Math.floor(entry.expiresAt.getTime() / 1000)}:F>`
    : '';
  return `⛔ Vous n'êtes pas autorisé à ouvrir un ticket sur ce serveur.${reasonLine}${untilLine}`;
}

/**
 * Repond a l'interaction et renvoie `true` si le membre est blackliste.
 * Regroupe ici pour que les quatre points d'entree d'ouverture (boutons, menu,
 * commande, MP) appliquent exactement la meme regle.
 */
async function rejectIfBlacklisted(
  guildId: string,
  userId: string,
  reply: (content: string) => Promise<unknown>,
): Promise<boolean> {
  const entry = await findActiveTicketBlacklist(guildId, userId);
  if (!entry) return false;
  await reply(ticketBlacklistMessage(entry)).catch(() => null);
  return true;
}

// ─── Verrouillage jusqu'a la prise en charge ─────────────────────────────────

/**
 * Ouvre ou ferme l'ecriture dans le salon d'un ticket sans toucher a sa
 * visibilite : l'auteur et le staff continuent de tout voir, personne ne peut
 * ecrire tant que le ticket n'est pas pris en charge.
 */
export async function applyTicketLockState(
  client: Client,
  ticket: { channelId: string | null; threadId: string | null; mode: string; userId: string; staffRoleId: string | null },
  guildConfig: Record<string, unknown>,
  locked: boolean,
): Promise<void> {
  const channelId = ticket.channelId || ticket.threadId;
  if (!channelId) return;

  const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return;

  // Un fil n'a pas d'overwrites propres : Discord expose le verrou directement.
  if (channel.isThread()) {
    await (channel as ThreadChannel).setLocked(locked, locked ? 'Ticket en attente de prise en charge' : 'Ticket pris en charge').catch(() => null);
    return;
  }

  if (!(channel instanceof TextChannel)) return;

  const moderatorRoleId = typeof guildConfig.moderatorRoleId === 'string' ? guildConfig.moderatorRoleId : null;
  const configuredStaffRoleId = typeof guildConfig.ticketStaffRoleId === 'string' ? guildConfig.ticketStaffRoleId : null;
  const targets = [ticket.userId, ticket.staffRoleId, configuredStaffRoleId, moderatorRoleId]
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  // `true` et non `null` au deverrouillage : c'est ce que pose la creation du
  // salon. Rendre le droit a l'heritage laisserait la categorie decider.
  for (const targetId of new Set(targets)) {
    await channel.permissionOverwrites.edit(targetId, { SendMessages: !locked }).catch(() => null);
  }
}

/**
 * Sends the ticket opening embed in the configured channel using V2 components.
 * Buttons or dropdown are embedded directly inside the container.
 */
/**
 * Textes que le bot compose lui-meme quand l'admin n'en a pas ecrit. Exposes
 * plutot qu'ecrits deux fois : la mise en route les depose dans la
 * configuration pour qu'ils soient visibles et modifiables, et l'envoi s'en
 * sert quand le champ est reste vide.
 *
 * Les jetons `{user}`, `{type_label}` et compagnie traversent la traduction
 * tels quels, ils sont remplaces au moment de l'envoi.
 */
export function ticketDefaultTexts(locale: BotLocale) {
  return {
    ticketEmbedTitle: m.ticket_default_panel_title({}, { locale }),
    ticketEmbedDesc: m.ticket_default_panel_desc({}, { locale }),
    ticketEmbedButtonText: m.ticket_default_panel_button({}, { locale }),
    ticketWelcomeTitle: m.ticket_default_welcome_title({ type_label: '{type_label}' }, { locale }),
    ticketWelcomeDesc: m.ticket_default_welcome_desc(
      { user: '{user}', staff_mention: '{staff_mention}', description: '{description}' },
      { locale },
    ),
    ticketWelcomeFooter: m.ticket_default_welcome_footer({ ticket_id: '{ticket_id}' }, { locale }),
    ticketInactivityMessage: m.ticket_default_inactivity({ user: '{user}' }, { locale }),
  };
}

/**
 * Les panneaux d'ouverture deja en place dans le salon, retires avant le notre.
 *
 * Reprendre un serveur habite, c'est presque toujours reprendre un salon de
 * tickets qui en porte deja un - celui du bot qu'on remplace. Sans ce menage,
 * le salon finissait avec deux panneaux empiles : l'ancien, dont les boutons ne
 * repondent plus une fois l'autre bot parti, et le notre en dessous. Les
 * membres cliquaient sur le premier.
 *
 * Trois garde-fous, parce qu'on efface chez quelqu'un d'autre : seuls les
 * messages de bots sont regardes - jamais ceux d'un humain, quoi qu'ils
 * contiennent -, il leur faut des composants pour compter comme un panneau, ce
 * qui laisse tranquille une annonce ou un embed de presentation, et le nombre
 * comme la fenetre de lecture sont bornes. Un echec ne fait rien echouer : un
 * panneau en trop se supprime a la main, un panneau jamais publie ne se
 * rattrape pas.
 */
async function clearPreviousTicketPanels(channel: TextChannel): Promise<number> {
  const SCAN = 50;
  const MAX_DELETIONS = 10;

  const recent = await channel.messages.fetch({ limit: SCAN }).catch(() => null);
  if (!recent) return 0;

  const panels = [...recent.values()]
    .filter((message) => message.author?.bot && message.components.length > 0)
    .slice(0, MAX_DELETIONS);

  let removed = 0;
  for (const message of panels) {
    // Supprimer le message d'un autre bot demande « Gerer les messages ». Sans
    // la permission, on garde le sien et on publie quand meme.
    const done = await message.delete().then(() => true).catch(() => false);
    if (done) removed += 1;
  }

  if (removed > 0) {
    logger.info('Ticket', `${removed} ancien(s) panneau(x) retire(s) de #${channel.name} (${channel.guild.id})`);
  }
  return removed;
}

export async function sendTicketSetupEmbed(client: Client, guildId: string): Promise<void> {
  const guildConfig = await prisma.guild.findUnique({ where: { id: guildId } });
  if (!guildConfig || !guildConfig.ticketChannelId) {
    throw new Error("Le salon d'embed des tickets n'est pas configuré.");
  }

  // Repli sur un appel REST : le cache peut ne pas porter un salon cree a
  // l'instant, et l'absence du cache ne veut pas dire que le salon n'existe pas.
  //
  // Tout salon de serveur ou l'on peut ecrire convient, y compris un salon
  // d'annonces : c'est un choix legitime pour un panneau, et la mise en route
  // accepte deja d'en reprendre un.
  const channel = client.channels.cache.get(guildConfig.ticketChannelId)
    ?? await client.channels.fetch(guildConfig.ticketChannelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    throw new Error("Le salon d'embed des tickets est introuvable ou n'est pas un salon textuel.");
  }

  // Le salon du panneau vient du service de tickets, pas de la mise en place :
  // sur un serveur ferme a @everyone, le bot peut ne pas y avoir acces.
  if (channel.guild) await ensureBotCanPost(channel.guild, channel, "Panneau d'ouverture de tickets");

  const colorHex = guildConfig.ticketEmbedColor || '#5865F2';
  const color = typeof colorHex === 'string' ? parseInt(colorHex.replace('#', ''), 16) : COLORS_RAW.primary;

  // Un texte ecrit par l'admin est republie tel quel, sans traduction : il lui
  // appartient. La langue du serveur ne sert qu'aux textes que le bot compose
  // lui-meme, defauts compris.
  const discordGuild = client.guilds.cache.get(guildId);
  const locale = await resolveGuildLocale(guildId, discordGuild?.preferredLocale ?? null);

  // Un champ vide veut dire « le texte par defaut », compose ici dans la langue
  // du serveur : le figer en base le laisserait dans la langue du jour ou la
  // configuration est nee.
  const defaults = ticketDefaultTexts(locale);
  const panelTitle = guildConfig.ticketEmbedTitle?.trim() || defaults.ticketEmbedTitle;
  const panelDesc = guildConfig.ticketEmbedDesc?.trim() || defaults.ticketEmbedDesc;
  const panelButton = guildConfig.ticketEmbedButtonText?.trim() || defaults.ticketEmbedButtonText;

  const ticketTypes = normalizeTicketPanelTypes(guildConfig.ticketTypes, {
    label: panelButton,
    description: panelDesc,
    categoryId: guildConfig.ticketCategoryId ?? null,
    staffRoleId: guildConfig.ticketStaffRoleId ?? null,
    emoji: '📩',
    buttonStyle: 'PRIMARY',
  });

  const title = resolveEmojiShortcodes(panelTitle);
  let desc = resolveEmojiShortcodes(panelDesc);
  if (ticketTypes.length > 0) {
    desc += `\n\n${m.panel_tickets_types_heading({}, { locale })}\n`;
    ticketTypes.forEach(t => {
      desc += `${t.emoji || '📩'} **${t.label}** - ${t.description}\n`;
    });
  }

  const embed = new EmbedBuilder()
    .setTitle(title.substring(0, 256))
    .setDescription(desc.substring(0, 4000))
    .setColor(color);

  if (guildConfig.ticketEmbedThumbnail) {
    embed.setThumbnail(guildConfig.ticketEmbedThumbnail);
  }
  if (guildConfig.ticketEmbedImage) {
    embed.setImage(guildConfig.ticketEmbedImage);
  }
  if (guildConfig.ticketEmbedFooter) {
    embed.setFooter({ text: resolveEmojiShortcodes(guildConfig.ticketEmbedFooter).substring(0, 2048) });
  } else {
    embed.setFooter({ text: m.panel_tickets_default_footer({}, { locale }) });
  }
  if (guildConfig.ticketEmbedAuthorName) {
    embed.setAuthor({
      name: resolveEmojiShortcodes(guildConfig.ticketEmbedAuthorName).substring(0, 256),
      iconURL: guildConfig.ticketEmbedAuthorIcon || undefined
    });
  }

  const container = embedToV2(embed);

  const embedType = guildConfig.ticketEmbedType || 'BUTTONS';

  if (embedType === 'DROPDOWN') {
    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId('ticket:select_type')
      .setPlaceholder(m.panel_tickets_select_placeholder({}, { locale }))
      .addOptions(
        ticketTypes.map((type) => ({
          label: type.label.slice(0, 80),
          description: type.description?.slice(0, 100) || undefined,
          value: type.id,
          emoji: type.emoji || undefined,
        }))
      );

    container.addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)
    );
  } else {
    const buttons = ticketTypes.map((type) => new ButtonBuilder()
      .setCustomId(`ticket:open_modal:${type.id}`)
      .setLabel(type.label.slice(0, 80))
      .setStyle(resolveButtonStyle(type.buttonStyle))
      .setEmoji(type.emoji || '📩'));

    for (let index = 0; index < buttons.length; index += 5) {
      container.addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(index, index + 5))
      );
    }
  }

  // Accès à ses propres tickets clos, sur une ligne à part pour ne pas se
  // confondre avec les types d'ouverture : le panneau qui s'ouvre est éphémère,
  // personne d'autre ne voit l'historique du membre.
  if (guildConfig.ticketHistoryPanelEnabled) {
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('ticket:history')
          .setLabel(m.panel_tickets_history_button({}, { locale }))
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('🗂️'),
      )
    );
  }

  // Avant l'envoi, pas apres : publier puis nettoyer laisserait, si la
  // suppression echoue, le nouveau panneau sous l'ancien - l'ordre exact qu'on
  // cherche a eviter.
  if (channel instanceof TextChannel) await clearPreviousTicketPanels(channel);

  await channel.send(v2(container));
  logger.success('Ticket', `Embed d'ouverture envoyé avec succès dans #${channel.name} (${guildId})`);
}

function buildTicketWelcomeContainer(
  guildConfig: any,
  ticketType: TicketPanelTypeConfig,
  ticket: any,
  user: any,
  staffMention: string | null,
  reason: string,
  description: string,
  locale: BotLocale
): ContainerBuilder {
  const replaceTemplates = (str: string) => {
    if (!str) return '';
    return str
      .replace(/{user}/g, `<@${user.id}>`)
      .replace(/{username}/g, user.username)
      .replace(/{staff_mention}/g, staffMention || '')
      .replace(/{type_label}/g, ticketType.label || 'Ticket')
      .replace(/{ticket_id}/g, ticket.id)
      .replace(/{reason}/g, reason)
      .replace(/{description}/g, description);
  };

  // Les jetons `{user}`, `{type_label}` et compagnie traversent la traduction
  // tels quels : `replaceTemplates` les remplace juste apres.
  const defaults = ticketDefaultTexts(locale);
  const title = replaceTemplates(guildConfig.ticketWelcomeTitle?.trim() || defaults.ticketWelcomeTitle);
  const desc = replaceTemplates(guildConfig.ticketWelcomeDesc?.trim() || defaults.ticketWelcomeDesc);
  const footerText = replaceTemplates(guildConfig.ticketWelcomeFooter?.trim() || defaults.ticketWelcomeFooter);
  
  const welcomeColorHex = guildConfig.ticketWelcomeColor || '#5865F2';
  const color = typeof welcomeColorHex === 'string' ? parseInt(welcomeColorHex.replace('#', ''), 16) : COLORS_RAW.primary;

  const embed = new EmbedBuilder()
    .setTitle(title.substring(0, 256))
    .setDescription(desc.substring(0, 4000))
    .setColor(color);

  if (footerText) {
    embed.setFooter({ text: footerText.substring(0, 2048) });
  }

  if (guildConfig.ticketWelcomeThumbnail) {
    embed.setThumbnail(guildConfig.ticketWelcomeThumbnail);
  }

  if (guildConfig.ticketWelcomeImage) {
    embed.setImage(guildConfig.ticketWelcomeImage);
  }

  return embedToV2(embed);
}

/**
 * Styles qu'un modal Discord ne sait pas afficher : ils sont poses dans le
 * ticket apres son ouverture. Un style absent ou inconnu vaut du texte court.
 */
const INTERACTIVE_FIELD_STYLES = new Set(['SELECT', 'RADIO', 'FILE']);

/** Questions personnalisees configurees pour ce type, sinon celles du serveur. */
function resolveCustomFormFields(ticketType: any, guildConfig: any): any[] {
  const fields = (ticketType?.formCustomFields ?? guildConfig?.ticketFormCustomFields) as unknown;
  return Array.isArray(fields) ? fields.filter((f) => !!f && typeof f === 'object') : [];
}

/**
 * Questions a poser dans le modal d'ouverture. Les menus, boutons et fichiers
 * en sont exclus : Discord ne sait pas les afficher dans un modal, c'est
 * `setupInteractiveTicketQuestions` qui les pose dans le ticket. On ecarte
 * aussi les champs sans identifiant, sans intitule ou en doublon, qu'un modal
 * refuse en bloc - un seul champ invalide empechait toute ouverture.
 */
function resolveModalFormFields(ticketType: any, guildConfig: any): any[] {
  const seenIds = new Set<string>();
  return resolveCustomFormFields(ticketType, guildConfig)
    .filter((f: any) => {
      if (INTERACTIVE_FIELD_STYLES.has(f.style)) return false;
      const id = typeof f.id === 'string' ? f.id.trim() : '';
      const label = typeof f.label === 'string' ? f.label.trim() : '';
      if (!id || !label || seenIds.has(id)) return false;
      seenIds.add(id);
      return true;
    })
    .slice(0, 5);
}

async function showTicketOpeningModal(
  client: Client,
  interaction: StringSelectMenuInteraction | ButtonInteraction,
  ticketType: TicketPanelTypeConfig,
  guildConfig: any
): Promise<void> {
  const isFormEnabled = (ticketType as any).formEnabled !== undefined
    ? (ticketType as any).formEnabled
    : (guildConfig.ticketFormEnabled !== undefined ? guildConfig.ticketFormEnabled : true);

  if (isFormEnabled === false) {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const reason = ticketType.label || 'Ticket';
    const description = 'Aucune description fournie (formulaire désactivé).';
    await executeTicketCreation(client, interaction, ticketType, reason, description);
    return;
  }

  const customFields = resolveCustomFormFields(ticketType, guildConfig);
  const modalFields = resolveModalFormFields(ticketType, guildConfig);

  // Formulaire compose uniquement de questions interactives : il n'y a rien a
  // mettre dans le modal, on ouvre directement et les questions sont posees
  // dans le ticket. Sans ce cas, Discord rejetait un modal sans composant.
  if (customFields.length > 0 && modalFields.length === 0) {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    await executeTicketCreation(
      client,
      interaction,
      ticketType,
      ticketType.label || 'Ticket',
      'Les questions du formulaire sont posées à l\'ouverture du ticket.',
    );
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`modal:ticket:open:${ticketType.id}`)
    .setTitle((ticketType.label || guildConfig.ticketEmbedTitle || 'Ouvrir un ticket').substring(0, 45));

  if (modalFields.length > 0) {
    const rows = modalFields.map((f: any) => {
      const input = new TextInputBuilder()
        .setCustomId(f.id)
        .setLabel(f.label.substring(0, 45))
        .setStyle(f.style === 'PARAGRAPH' ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setRequired(f.required !== false);

      if (f.placeholder) {
        input.setPlaceholder(f.placeholder.substring(0, 100));
      }
      if (typeof f.maxLength === 'number') {
        input.setMaxLength(f.maxLength);
      }
      if (typeof f.minLength === 'number') {
        input.setMinLength(f.minLength);
      }
      return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
    });
    modal.addComponents(...rows);
  } else {
    // Rétrocompatibilité avec les champs par défaut du type
    const fieldsToUse = Array.isArray((ticketType as any).fields) && (ticketType as any).fields.length > 0
      ? (ticketType as any).fields.slice(0, 5)
      : null;

    if (fieldsToUse) {
      const rows = fieldsToUse.map((f: any) => {
        const input = new TextInputBuilder()
          .setCustomId(f.id)
          .setLabel(f.label.substring(0, 45))
          .setStyle(f.style === 'PARAGRAPH' ? TextInputStyle.Paragraph : TextInputStyle.Short)
          .setRequired(f.required !== false);

        if (f.placeholder) {
          input.setPlaceholder(f.placeholder.substring(0, 100));
        }
        if (typeof f.max_length === 'number') {
          input.setMaxLength(f.max_length);
        }
        if (typeof f.min_length === 'number') {
          input.setMinLength(f.min_length);
        }
        return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
      });
      modal.addComponents(...rows);
    } else {
      const isSalon = ticketType.label.toLowerCase().includes('salon');

      const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Sujet / Raison de la demande')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Ex : Problème avec mon grade, Plainte, etc.')
        .setRequired(true)
        .setMaxLength(100);

      if (isSalon) {
        reasonInput.setValue('Demande de salon');
      }

      const descInput = new TextInputBuilder()
        .setCustomId('description')
        .setLabel('Description détaillée')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Détaillez au maximum votre demande afin de faciliter le traitement par notre staff...')
        .setRequired(true)
        .setMaxLength(1000);

      if (isSalon) {
        descInput.setValue('Créé le pour moi');
      }

      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(descInput)
      );
    }
  }

  await interaction.showModal(modal);
}

/**
 * Handles select menu interactions for ticket type selection
 */
export async function handleTicketSelectMenu(client: Client, customId: string, interaction: StringSelectMenuInteraction): Promise<void> {
  const { guildId, user, member, guild } = interaction;
  if (!guildId || !guild || !member) return;

  const isMacroSend = customId.startsWith('ticket:macro_send:');
  if (customId !== 'ticket:select_type' && customId !== 'ticket:history_select' && !isMacroSend) return;

  const guildConfig = await prisma.guild.findUnique({ where: { id: guildId } });
  if (!guildConfig) {
    await interaction.reply({ content: '❌ Configuration du serveur introuvable.', flags: [MessageFlags.Ephemeral] });
    return;
  }

  if (isMacroSend) {
    await sendChosenMacro(
      client,
      interaction,
      customId.split(':')[2] ?? '',
      guildId,
      guild,
      member as GuildMember,
      guildConfig,
    );
    return;
  }

  // Fiche d'un ticket choisi dans l'historique personnel du membre.
  if (customId === 'ticket:history_select') {
    const [selected] = await fetchTicketHistory(guildId, user.id)
      .then((tickets) => tickets.filter((t) => t.id === interaction.values[0]));
    if (!selected) {
      await interaction.reply({ content: "❌ Ce ticket n'est plus consultable.", flags: [MessageFlags.Ephemeral] });
      return;
    }

    const locale = await resolveGuildLocale(guildId, guild.preferredLocale);
    const blacklist = await findActiveTicketBlacklist(guildId, user.id);
    const view = buildTicketHistoryDetail(selected, guildConfig, blacklist, locale);
    await interaction.update({ embeds: view.embeds, components: view.components });
    return;
  }

  const typeId = interaction.values[0];
  const ticketType = resolveTicketPanelType(guildConfig, typeId);

  const isBlacklisted = await rejectIfBlacklisted(guildId, user.id, (content) =>
    interaction.reply({ content, flags: [MessageFlags.Ephemeral] }));
  if (isBlacklisted) return;

  // Quotas d'ouverture : nombre de tickets simultanes, cooldown, quota sur
  // periode. Chacun est desactive par defaut ; sans aucun quota actif, rien ne
  // limite plus l'ouverture.
  const quotaRefusal = await refuseIfQuotaExceeded(client, interaction, guildConfig, ticketType, guildId, user.id);
  if (quotaRefusal) return;

  await showTicketOpeningModal(client, interaction, ticketType, guildConfig);
}

// ─── Macros ──────────────────────────────────────────────────────────────────

/**
 * Selecteur ephemere des macros utilisables dans ce ticket.
 *
 * Le selecteur ne montre que ce que ce membre du staff peut envoyer ici : les
 * macros restreintes a d'autres types de ticket ou a d'autres roles n'y
 * apparaissent pas, plutot que d'echouer au moment du clic.
 */
async function showMacroPicker(
  interaction: ButtonInteraction,
  ticketId: string,
  guildId: string,
  member: GuildMember,
  guildConfig: Record<string, unknown>,
): Promise<void> {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) {
    await interaction.reply({ content: '❌ Ticket introuvable en base de données.', flags: [MessageFlags.Ephemeral] });
    return;
  }

  if (!canManageTicket(member, guildConfig, ticket.staffRoleId)) {
    await interaction.reply({ content: '❌ Seuls les membres du personnel peuvent utiliser les macros.', flags: [MessageFlags.Ephemeral] });
    return;
  }

  const macros = await listUsableMacros({
    guildId,
    ticketTypeId: ticket.ticketTypeId,
    staffRoleIds: [...member.roles.cache.keys()],
  });

  if (macros.length === 0) {
    await interaction.reply({
      content: 'ℹ️ Aucune macro disponible pour ce ticket. Elles se créent depuis le dashboard, onglet Tickets › Macros.',
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  // Les macros suggerees remontent en tete : c'est tout l'interet de la
  // suggestion, qui ne sert a rien si elle reste noyee au milieu du menu.
  const suggested = new Set(suggestMacros(macros, `${ticket.reason} ${ticket.description}`).map((m) => m.id));
  const ordered = [...macros].sort((a, b) => Number(suggested.has(b.id)) - Number(suggested.has(a.id)));

  const select = new StringSelectMenuBuilder()
    .setCustomId(`ticket:macro_send:${ticketId}`)
    .setPlaceholder('Choisir une réponse')
    .addOptions(
      ordered.slice(0, MACRO_SELECT_LIMIT).map((macro) => ({
        label: macro.name.slice(0, 100),
        value: macro.id,
        description: [suggested.has(macro.id) ? '★ suggérée' : null, macro.category]
          .filter(Boolean)
          .join(' · ')
          .slice(0, 100) || undefined,
        emoji: macro.emoji || undefined,
      })),
    );

  await interaction.reply({
    content: suggested.size > 0
      ? `⚡ ${macros.length} macro(s) disponibles - ${suggested.size} suggérée(s) d'après la demande du membre.`
      : `⚡ ${macros.length} macro(s) disponibles.`,
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
    flags: [MessageFlags.Ephemeral],
  });
}

/** Poste la macro choisie dans le salon du ticket, puis applique ses actions. */
async function sendChosenMacro(
  client: Client,
  interaction: StringSelectMenuInteraction,
  ticketId: string,
  guildId: string,
  guild: Guild,
  member: GuildMember,
  guildConfig: Record<string, unknown>,
): Promise<void> {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) {
    await interaction.update({ content: '❌ Ticket introuvable en base de données.', components: [] });
    return;
  }

  if (!canManageTicket(member, guildConfig, ticket.staffRoleId)) {
    await interaction.update({ content: '❌ Seuls les membres du personnel peuvent utiliser les macros.', components: [] });
    return;
  }

  const macro = await prisma.ticketMacro.findFirst({
    where: { id: interaction.values[0], guildId, enabled: true },
  });
  if (!macro) {
    await interaction.update({ content: "❌ Cette macro n'existe plus.", components: [] });
    return;
  }

  const content = renderMacroContent(macro.content, {
    ticket,
    staffTag: `<@${member.id}>`,
    guildName: guild.name,
  });

  const channel = interaction.channel;
  if (!channel || !channel.isTextBased() || !('send' in channel)) {
    await interaction.update({ content: '❌ Ce salon ne permet pas d’envoyer la macro.', components: [] });
    return;
  }

  await channel.send({ content });
  await markMacroUsed(macro.id);

  const applied = await applyMacroActions({
    client,
    guild,
    macro,
    ticket,
    actor: { id: member.id, username: member.user.username },
  });

  // La fermeture vient apres les autres actions : elles ont besoin d'un ticket
  // encore ouvert, et le message de confirmation doit pouvoir la mentionner.
  if (macro.closeTicket) {
    try {
      await closeTicket(client, ticket.id, member.id, member.user.username);
      applied.push('ticket fermé');
    } catch (err) {
      logger.error('TicketMacro', `Fermeture par macro impossible (${macro.id})`, err);
    }
  }

  await interaction.update({
    content: applied.length > 0
      ? `✅ Macro « ${macro.name} » envoyée · ${applied.join(', ')}.`
      : `✅ Macro « ${macro.name} » envoyée.`,
    components: [],
  });
}

// ─── Panneau « Mes anciens tickets » ─────────────────────────────────────────

/** Statuts qui font entrer un ticket dans l'historique consultable du membre. */
const HISTORY_STATUSES = ['CLOSED', 'ARCHIVED'] as const;

/** Nombre d'entrées tenables dans un sélecteur Discord. */
const HISTORY_PAGE_SIZE = 25;

function transcriptUrl(transcriptId: string): string {
  const dashboardUrl = (process.env.DASHBOARD_URL || 'http://localhost:5173').replace(/\/$/, '');
  return `${dashboardUrl}/transcripts/${transcriptId}`;
}

function historyStatusBadge(status: string): string {
  return status === 'ARCHIVED' ? '📦 Archivé' : '🔒 Fermé';
}

type HistoryTicket = Pick<Ticket,
  'id' | 'reason' | 'description' | 'status' | 'createdAt' | 'closedAt' | 'transcriptId'
  | 'restoreCount' | 'lastRestoredAt' | 'ticketTypeLabel' | 'channelId'
  | 'deletionLocked' | 'deletionLockedUntil' | 'deletionLockReason' | 'deletionLockedById' | 'deletionLockedByName'
>;

async function fetchTicketHistory(guildId: string, userId: string): Promise<HistoryTicket[]> {
  return prisma.ticket.findMany({
    where: { guildId, userId, status: { in: [...HISTORY_STATUSES] } },
    orderBy: { closedAt: 'desc' },
    take: HISTORY_PAGE_SIZE,
    select: {
      id: true, reason: true, description: true, status: true, createdAt: true, closedAt: true,
      transcriptId: true, restoreCount: true, lastRestoredAt: true, ticketTypeLabel: true, channelId: true,
      deletionLocked: true, deletionLockedUntil: true, deletionLockReason: true,
      deletionLockedById: true, deletionLockedByName: true,
    },
  });
}

/**
 * Liste éphémère des tickets clos d'un membre.
 *
 * Un embed plus un sélecteur, et non un embed qui détaille chaque ticket : au
 * delà de quelques dossiers l'embed déborderait, alors que le sélecteur tient
 * vingt-cinq entrées et mène à une fiche complète.
 */
function buildTicketHistoryList(tickets: HistoryTicket[], locale: BotLocale): { embeds: EmbedBuilder[]; components: ActionRowBuilder<StringSelectMenuBuilder>[] } {
  const embed = new EmbedBuilder()
    .setTitle(m.panel_tickets_history_title({}, { locale }))
    .setColor(COLORS.primary as ColorResolvable);

  if (tickets.length === 0) {
    embed.setDescription(m.panel_tickets_history_empty({}, { locale }));
    return { embeds: [embed], components: [] };
  }

  embed.setDescription(m.panel_tickets_history_desc({}, { locale }));
  embed.addFields(tickets.slice(0, 10).map((ticket) => ({
    name: `${historyStatusBadge(ticket.status)} · ${(ticket.ticketTypeLabel || 'Ticket').slice(0, 40)}`,
    value: `${(ticket.reason || 'Sans motif').slice(0, 120)}\n<t:${Math.floor((ticket.closedAt ?? ticket.createdAt).getTime() / 1000)}:D>`,
    inline: true,
  })));
  if (tickets.length > 10) {
    embed.setFooter({ text: `${tickets.length} tickets · les 10 plus récents sont détaillés ci-dessus` });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('ticket:history_select')
    .setPlaceholder(m.panel_tickets_history_select({}, { locale }))
    .addOptions(tickets.map((ticket) => {
      const date = new Date(ticket.closedAt ?? ticket.createdAt).toLocaleDateString('fr-FR');
      return {
        label: `${date} · ${(ticket.reason || 'Sans motif').slice(0, 60)}`.slice(0, 100),
        description: `${historyStatusBadge(ticket.status)} · ${(ticket.ticketTypeLabel || 'Ticket')}`.slice(0, 100),
        value: ticket.id,
      };
    }));

  return { embeds: [embed], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)] };
}

/**
 * Fiche d'un ticket clos vue par son auteur : ce qu'il contenait, sa
 * transcription, et les deux gestes qu'on lui laisse - demander la réouverture,
 * demander la suppression - chacun affiché avec la raison qui l'empêche quand
 * c'est le cas, plutôt que simplement absent.
 */
function buildTicketHistoryDetail(
  ticket: HistoryTicket,
  guildConfig: Record<string, unknown> & { ticketSelfReopenEnabled: boolean; ticketSelfDeleteEnabled: boolean },
  blacklist: TicketBlacklistEntry | null,
  locale: BotLocale,
): { embeds: EmbedBuilder[]; components: ActionRowBuilder<ButtonBuilder>[] } {
  // `null` quand le serveur n'active pas le quota : le nombre de reouvertures
  // n'est alors plus plafonne, seuls les delais entre deux subsistent.
  const maxRestores = resolveTicketQuotas(guildConfig).reopenMax;
  const eligibility = checkRestoreEligibility(ticket, maxRestores);
  const lock = resolveDeletionLock(ticket);
  const nextRestore = nextRestoreAvailableAt(ticket);

  const embed = new EmbedBuilder()
    .setTitle(`${historyStatusBadge(ticket.status)} · ${(ticket.ticketTypeLabel || 'Ticket').slice(0, 200)}`)
    .setColor(ticket.status === 'ARCHIVED' ? (COLORS.warning as ColorResolvable) : (COLORS.primary as ColorResolvable))
    .addFields([
      { name: 'Motif', value: (ticket.reason || 'Aucun').slice(0, 1024), inline: false },
      { name: 'Description', value: (ticket.description || 'Aucune').slice(0, 1024), inline: false },
      { name: 'Ouvert le', value: `<t:${Math.floor(ticket.createdAt.getTime() / 1000)}:D>`, inline: true },
      { name: 'Fermé le', value: ticket.closedAt ? `<t:${Math.floor(ticket.closedAt.getTime() / 1000)}:D>` : '-', inline: true },
      {
        name: 'Réouvertures',
        value: maxRestores === null
          ? `${ticket.restoreCount ?? 0}`
          : m.panel_tickets_history_reopen_quota({ used: ticket.restoreCount ?? 0, max: maxRestores }, { locale }),
        inline: true,
      },
    ])
    .setFooter({ text: `Kotbo · Ticket ID: ${ticket.id}` });

  const notices: string[] = [];
  if (!ticket.transcriptId) {
    notices.push("📄 Aucune transcription n'a été conservée pour ce ticket.");
  }
  if (lock.locked) {
    notices.push(`🔐 Ce ticket est protégé contre la suppression${lock.until ? ` jusqu'au <t:${Math.floor(lock.until.getTime() / 1000)}:d>` : ''}.`);
  }
  if (blacklist && !blacklist.allowReopen) {
    notices.push("⛔ Votre accès au système de tickets est restreint : la réouverture n'est pas disponible.");
  }
  if (!eligibility.ok) {
    notices.push(`⏳ ${eligibility.error}`);
  } else if (nextRestore) {
    notices.push(`⏳ Prochaine réouverture possible <t:${Math.floor(nextRestore.getTime() / 1000)}:R>.`);
  }
  if (notices.length > 0) embed.setDescription(notices.join('\n'));

  const buttons: ButtonBuilder[] = [];
  if (ticket.transcriptId) {
    buttons.push(new ButtonBuilder().setLabel('Transcription').setStyle(ButtonStyle.Link).setEmoji('📄').setURL(transcriptUrl(ticket.transcriptId)));
  }
  if (guildConfig.ticketSelfReopenEnabled) {
    const blocked = !eligibility.ok || (blacklist !== null && !blacklist.allowReopen);
    buttons.push(new ButtonBuilder()
      .setCustomId(`ticket:hist_reopen:${ticket.id}`)
      .setLabel('Réouvrir')
      .setStyle(ButtonStyle.Success)
      .setEmoji('🔓')
      .setDisabled(blocked));
  }
  if (guildConfig.ticketSelfDeleteEnabled) {
    buttons.push(new ButtonBuilder()
      .setCustomId(`ticket:hist_delete:${ticket.id}`)
      .setLabel('Supprimer définitivement')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('🗑️')
      .setDisabled(lock.locked));
  }
  buttons.push(new ButtonBuilder().setCustomId('ticket:hist_back').setLabel('Retour').setStyle(ButtonStyle.Secondary).setEmoji('◀️'));

  return { embeds: [embed], components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)] };
}

/** Ouvre (ou rafraîchit) la liste éphémère des anciens tickets du membre. */
async function showTicketHistory(
  interaction: ButtonInteraction,
  guildId: string,
  userId: string,
  locale: BotLocale,
  mode: 'reply' | 'update',
): Promise<void> {
  const tickets = await fetchTicketHistory(guildId, userId);
  const view = buildTicketHistoryList(tickets, locale);
  if (mode === 'update') {
    await interaction.update({ embeds: view.embeds, components: view.components });
  } else {
    await interaction.reply({ embeds: view.embeds, components: view.components, flags: [MessageFlags.Ephemeral] });
  }
}

/**
 * Réouverture et suppression demandées par l'auteur du ticket depuis son
 * historique.
 *
 * Les mêmes garde-fous que côté staff s'appliquent - quota de réouvertures,
 * verrou anti-suppression - plus deux propres au membre : la blacklist peut lui
 * fermer la réouverture, et chaque geste doit être activé par le serveur.
 */
async function handleTicketHistoryAction(
  client: Client,
  interaction: ButtonInteraction,
  action: 'hist_reopen' | 'hist_delete' | 'hist_delconf',
  ticket: Ticket,
  guildConfig: any,
): Promise<void> {
  const { user } = interaction;

  if (action === 'hist_reopen') {
    if (!guildConfig.ticketSelfReopenEnabled) {
      await interaction.reply({ content: "❌ La réouverture par le membre n'est pas activée sur ce serveur.", flags: [MessageFlags.Ephemeral] });
      return;
    }

    // La blacklist ferme la création de tickets ; elle ne ferme le suivi d'un
    // dossier déjà traité que si le staff l'a explicitement voulu.
    const blacklist = await findActiveTicketBlacklist(ticket.guildId, user.id);
    if (blacklist && !blacklist.allowReopen) {
      await interaction.reply({ content: ticketBlacklistMessage(blacklist), flags: [MessageFlags.Ephemeral] });
      return;
    }

    const eligibility = checkRestoreEligibility(ticket, resolveTicketQuotas(guildConfig).reopenMax);
    if (!eligibility.ok) {
      await interaction.reply({ content: `⏳ ${eligibility.error}`, flags: [MessageFlags.Ephemeral] });
      return;
    }

    // Une reouverture consomme une place comme une ouverture : elle passe donc
    // par le meme quota, plutot que par une regle « un seul ticket » a part.
    const reopenQuota = await checkMemberTicketQuota({
      guildId: ticket.guildId,
      userId: user.id,
      quotas: resolveTicketQuotas(guildConfig),
    });
    if (!reopenQuota.ok) {
      const ref = reopenQuota.kind === 'OPEN' && reopenQuota.blocking?.channelId
        ? `<#${reopenQuota.blocking.channelId}>`
        : 'une demande en attente';
      await interaction.reply({
        content: reopenQuota.kind === 'OPEN'
          ? `⚠️ Vous avez déjà un ticket en cours : ${ref}. Terminez-le avant d'en réouvrir un autre.`
          : `⏳ Vous pourrez réouvrir un ticket ${relativeTimestamp(reopenQuota.retryAtMs)}.`,
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    await interaction.deferUpdate();
    try {
      const result = await restoreTicketFromTranscript(client, ticket.id, { id: user.id, username: user.username }, 'MEMBER');
      await logTicketEvent(client, guildConfig, 'REOPENED', result.ticket, user);
      await interaction.editReply({
        embeds: [successEmbed(
          'Ticket réouvert',
          `Votre ticket a été réouvert dans <#${result.channelId}>. L'historique de la conversation y a été restitué.\n\n`
          + reopenCapLabel(result.ticket.restoreCount, resolveTicketQuotas(guildConfig).reopenMax),
        )],
        components: [],
      });
    } catch (err) {
      logger.error('Ticket', 'Error on member-side ticket reopen:', err);
      await interaction.editReply({
        embeds: [errorEmbed('Réouverture impossible', err instanceof Error ? err.message : 'Une erreur est survenue.')],
        components: [],
      });
    }
    return;
  }

  if (!guildConfig.ticketSelfDeleteEnabled) {
    await interaction.reply({ content: "❌ La suppression par le membre n'est pas activée sur ce serveur.", flags: [MessageFlags.Ephemeral] });
    return;
  }

  const lock = resolveDeletionLock(ticket);
  if (lock.locked) {
    await interaction.reply({ content: deletionLockMessage(lock), flags: [MessageFlags.Ephemeral] });
    return;
  }

  if (action === 'hist_delete') {
    // Effacement irréversible d'une pièce que le staff peut vouloir consulter :
    // une confirmation explicite s'impose avant de la détruire.
    const embed = new EmbedBuilder()
      .setTitle('🗑️ Supprimer définitivement ce ticket ?')
      .setDescription(
        `**${ticket.reason || 'Sans motif'}**\n\n`
        + 'Le ticket et sa transcription seront effacés sans retour possible. '
        + 'Le staff ne pourra plus les consulter.',
      )
      .setColor(COLORS.danger as ColorResolvable);

    await interaction.update({
      embeds: [embed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`ticket:hist_delconf:${ticket.id}`).setLabel('Oui, supprimer').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
        new ButtonBuilder().setCustomId('ticket:hist_back').setLabel('Annuler').setStyle(ButtonStyle.Secondary),
      )],
    });
    return;
  }

  // hist_delconf : confirmation reçue
  await interaction.deferUpdate();
  try {
    if (ticket.channelId) {
      const channel = await client.channels.fetch(ticket.channelId).catch(() => null);
      if (channel instanceof TextChannel) {
        await channel.delete(`Ticket supprimé par son auteur (${user.username})`).catch(() => null);
      }
    }
    if (ticket.transcriptId) {
      await prisma.transcript.delete({ where: { id: ticket.transcriptId } }).catch(() => null);
    }
    await prisma.ticket.delete({ where: { id: ticket.id } });
    await logTicketEvent(client, guildConfig, 'DELETED', ticket, user);

    await interaction.editReply({
      embeds: [successEmbed('Ticket supprimé', 'Le ticket et sa transcription ont été définitivement effacés.')],
      components: [],
    });
  } catch (err) {
    logger.error('Ticket', 'Error on member-side ticket delete:', err);
    await interaction.editReply({
      embeds: [errorEmbed('Suppression impossible', 'Une erreur est survenue. Contactez le staff.')],
      components: [],
    });
  }
}

/**
 * Handles all button interactions starting with "ticket:"
 */
export async function handleTicketButton(client: Client, customId: string, interaction: ButtonInteraction): Promise<void> {
  const { guildId, user, member, guild } = interaction;
  if (!guildId || !guild || !member) return;

  const guildConfig = await prisma.guild.findUnique({ where: { id: guildId } });
  if (!guildConfig) {
    await interaction.reply({ content: '❌ Configuration du serveur introuvable.', flags: [MessageFlags.Ephemeral] });
    return;
  }

  // 1. Clic sur "Ouvrir un ticket" -> Afficher le modal
  if (customId === 'ticket:open_modal' || customId.startsWith('ticket:open_modal:')) {
    const typeId = customId.startsWith('ticket:open_modal:') ? customId.split(':')[2] : null;
    const ticketType = resolveTicketPanelType(guildConfig, typeId);

    const isBlacklisted = await rejectIfBlacklisted(guildId, user.id, (content) =>
      interaction.reply({ content, flags: [MessageFlags.Ephemeral] }));
    if (isBlacklisted) return;

    // Memes quotas que par le selecteur de type : les deux chemins menent au
    // meme modal, ils doivent refuser dans les memes cas.
    const quotaRefusal = await refuseIfQuotaExceeded(client, interaction, guildConfig, ticketType, guildId, user.id);
    if (quotaRefusal) return;

    await showTicketOpeningModal(client, interaction, ticketType, guildConfig);
    return;
  }

  // 1 ter. Macros : selecteur ephemere des reponses pre-ecrites du serveur.
  if (customId.startsWith('ticket:macros:')) {
    await showMacroPicker(interaction, customId.split(':')[2] ?? '', guildId, member as GuildMember, guildConfig);
    return;
  }

  // 1 bis. Historique personnel : panneau éphémère, sans identifiant de ticket
  // dans le customId puisqu'il s'agit d'ouvrir la liste, pas d'agir sur un
  // dossier précis.
  if (customId === 'ticket:history' || customId === 'ticket:hist_back') {
    if (!guildConfig.ticketHistoryPanelEnabled) {
      await interaction.reply({ content: "❌ L'historique des tickets n'est pas activé sur ce serveur.", flags: [MessageFlags.Ephemeral] });
      return;
    }
    const locale = await resolveGuildLocale(guildId, guild.preferredLocale);
    await showTicketHistory(interaction, guildId, user.id, locale, customId === 'ticket:hist_back' ? 'update' : 'reply');
    return;
  }

  // Autres boutons requièrent de décoder l'ID
  const parts = customId.split(':');
  const action = parts[1];
  const ticketId = parts[2];

  if (!action || !ticketId) return;

  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) {
    await interaction.reply({ content: '❌ Ticket introuvable en base de données.', flags: [MessageFlags.Ephemeral] });
    return;
  }

  // Helper to fetch staff level
  async function getStaffLevel(guildId: string, userId: string): Promise<number> {
    const staff = await prisma.staffMember.findUnique({
      where: { guildId_userId: { guildId, userId } }
    });
    if (!staff) return 0;
    const role = await prisma.staffRole.findFirst({
      where: { guildId, name: staff.grade, enabled: true }
    });
    return role ? role.level : 0;
  }

  // 2. Action: Claim
  if (action === 'claim') {
    if (!canManageTicket(member as GuildMember, guildConfig, ticket.staffRoleId)) {
      await interaction.reply({ content: '❌ Seuls les membres du personnel peuvent prendre en charge un ticket.', flags: [MessageFlags.Ephemeral] });
      return;
    }

    const allowOverclaim = guildConfig.ticketAllowOverclaim ?? true;
    const overclaimPermission = guildConfig.ticketOverclaimPermission || 'ANY';

    if (ticket.status === 'CLAIMED') {
      if (!allowOverclaim || overclaimPermission === 'NONE') {
        await interaction.reply({ content: `⚠️ Ce ticket est déjà pris en charge par <@${ticket.claimedById}>. La sur-revendication est désactivée.`, flags: [MessageFlags.Ephemeral] });
        return;
      }

      if (ticket.claimedById === user.id) {
        await interaction.reply({ content: `⚠️ Vous prenez déjà en charge ce ticket.`, flags: [MessageFlags.Ephemeral] });
        return;
      }

      if (overclaimPermission === 'SUPERIOR_OR_EQUAL') {
        const claimantIsAdmin = (member as GuildMember).permissions.has(PermissionFlagsBits.Administrator);
        if (!claimantIsAdmin) {
          const claimantLevel = await getStaffLevel(guildId, user.id);
          const currentLevel = ticket.claimedById ? await getStaffLevel(guildId, ticket.claimedById) : 0;

          if (claimantLevel < currentLevel) {
            await interaction.reply({
              content: `❌ Vous ne pouvez pas sur-revendiquer ce ticket car le grade de l'intervenant actuel est supérieur au vôtre.`,
              flags: [MessageFlags.Ephemeral]
            });
            return;
          }
        }
      }
    }

    // Plafond de charge : le staff deja au maximum de tickets en cours est
    // prevenu (WARN) ou refuse (BLOCK). Les roles de contournement ramenent le
    // mode a OFF, sans quoi un serveur ou tout le monde est plein se bloquerait.
    const staffLoad = await checkStaffTicketLoad({
      guildId,
      staffUserId: user.id,
      staffRoleIds: [...((member as GuildMember).roles?.cache?.keys() ?? [])],
      quotas: resolveTicketQuotas(guildConfig),
    });

    if (staffLoad.exceeded && staffLoad.mode === 'BLOCK') {
      await interaction.reply({
        content: `❌ Vous avez déjà **${staffLoad.current}/${staffLoad.max}** tickets en cours. Fermez-en un avant d'en prendre un nouveau.`,
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    await interaction.deferUpdate();

    // Mettre à jour en base de données
    const _updated = await prisma.ticket.update({
      where: { id: ticketId },
      data: {
        status: 'CLAIMED',
        claimedById: user.id,
        claimedByName: user.username
      }
    });

    if (staffLoad.exceeded && staffLoad.mode === 'WARN') {
      // Apres le `deferUpdate`, seul un followUp reste possible : la prise en
      // charge a bien eu lieu, l'avertissement ne fait que la commenter.
      await interaction.followUp({
        content: `⚠️ Vous suivez maintenant **${staffLoad.current + 1}** tickets, au-delà du plafond conseillé de ${staffLoad.max}.`,
        flags: [MessageFlags.Ephemeral],
      }).catch(() => null);
    }

    // Le verrou d'attente tombe a la prise en charge : c'est tout son objet.
    if (ticket.lockUntilClaim) {
      await applyTicketLockState(client, ticket, guildConfig, false);
      await prisma.ticket.update({ where: { id: ticketId }, data: { lockUntilClaim: false } });
    }

    // Mettre à jour le container V2 du message de bienvenue (Components V2 uniquement, pas d'embeds)
    const ticketChannel = interaction.channel as TextChannel;
    if (ticketChannel) {
      try {
        const bodyText = `Ce ticket est actuellement pris en charge par <@${user.id}>.\n\n**Auteur :** <@${ticket.userId}>\n**Raison :** ${ticket.reason}\n**Description :** ${ticket.description}`;
        const updatedContainer = buildTicketStatusContainer(ticket, bodyText, COLORS_RAW.warning);

        const componentsList: ButtonBuilder[] = [];

        if (allowOverclaim && overclaimPermission !== 'NONE') {
          componentsList.push(
            new ButtonBuilder().setCustomId(`ticket:claim:${ticketId}`).setLabel('Sur-revendiquer').setStyle(ButtonStyle.Primary).setEmoji('🛠️')
          );
        }

        componentsList.push(
          new ButtonBuilder().setCustomId(`ticket:info:${ticketId}`).setLabel('Infos Membre').setStyle(ButtonStyle.Secondary).setEmoji('🔍'),
          new ButtonBuilder().setCustomId(`ticket:macros:${ticketId}`).setLabel('Macros').setStyle(ButtonStyle.Secondary).setEmoji('⚡'),
          new ButtonBuilder().setCustomId(`ticket:close:${ticketId}`).setLabel('Fermer').setStyle(ButtonStyle.Danger).setEmoji('🔒')
        );

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(componentsList);

        await interaction.message.edit({
          components: [updatedContainer, row],
          flags: MessageFlags.IsComponentsV2,
          allowedMentions: { users: [user.id, ticket.userId] },
        });
      } catch (err) {
        logger.error('Ticket', 'Error updating welcome message container:', err);
      }

      await ticketChannel.send({
        embeds: [successEmbed('Pris en charge', `Ce ticket est désormais pris en charge par <@${user.id}>.`)],
        allowedMentions: { users: [user.id] },
      });
    }

    // Logger
    await logTicketEvent(client, guildConfig, 'CLAIMED', ticket, user);
    return;
  }

  // 2 bis. Validation préalable : accepter la demande et créer le ticket
  if (action === 'approve') {
    if (!canManageTicket(member as GuildMember, guildConfig, ticket.staffRoleId)) {
      await interaction.reply({ content: '❌ Seuls les membres du personnel peuvent valider une demande de ticket.', flags: [MessageFlags.Ephemeral] });
      return;
    }

    if (ticket.status !== 'PENDING') {
      await interaction.reply({ content: '⚠️ Cette demande a déjà été traitée.', flags: [MessageFlags.Ephemeral] });
      return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    const ticketType = resolveTicketPanelType(guildConfig, ticket.ticketTypeId);
    const opener = await client.users.fetch(ticket.userId).catch(() => null);
    const locale = await resolveGuildLocale(guildId, guild.preferredLocale);

    try {
      const result = await createTicketWorkspace(client, {
        guild,
        user: { id: ticket.userId, username: opener?.username ?? ticket.username },
        ticketType,
        guildConfig,
        reason: ticket.reason,
        description: ticket.description,
        locale,
        existingTicketId: ticket.id,
      });

      await prisma.ticket.update({
        where: { id: ticket.id },
        data: { reviewedById: user.id, reviewedByName: user.username, reviewedAt: new Date() },
      });

      await updateTicketReviewCard(client, ticket, 'APPROVED', user, null);

      // Le membre n'est pas forcement encore devant Discord : le MP le ramene
      // vers son ticket sans qu'il ait a surveiller la liste des salons.
      if (opener) {
        await opener.send({
          embeds: [successEmbed('Demande de ticket acceptée', `Votre demande sur **${guild.name}** a été validée par <@${user.id}>.\n\n${result.userMessage}`)],
          allowedMentions: { parse: [] },
        }).catch(() => null);
      }

      await interaction.editReply({ content: `✅ Demande validée. ${result.userMessage}` });
    } catch (err) {
      logger.error('Ticket', 'Error approving ticket request:', err);
      const message = err instanceof Error && err.message.startsWith('❌')
        ? err.message
        : "❌ Impossible de créer le ticket. Vérifiez la configuration du module.";
      await interaction.editReply({ content: message });
    }
    return;
  }

  // 2 ter. Validation préalable : refuser la demande (motif saisi dans un modal)
  if (action === 'reject') {
    if (!canManageTicket(member as GuildMember, guildConfig, ticket.staffRoleId)) {
      await interaction.reply({ content: '❌ Seuls les membres du personnel peuvent refuser une demande de ticket.', flags: [MessageFlags.Ephemeral] });
      return;
    }

    if (ticket.status !== 'PENDING') {
      await interaction.reply({ content: '⚠️ Cette demande a déjà été traitée.', flags: [MessageFlags.Ephemeral] });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`modal:ticket:reject:${ticket.id}`)
      .setTitle('Refuser la demande')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('reason')
            .setLabel('Motif communiqué au membre')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Ex : demande déjà traitée, informations insuffisantes...')
            .setRequired(false)
            .setMaxLength(500),
        ),
      );

    await interaction.showModal(modal);
    return;
  }

  // 3. Action: Info / Casier de la personne
  if (action === 'info') {
    if (!canManageTicket(member as GuildMember, guildConfig, ticket.staffRoleId)) {
      await interaction.reply({ content: '❌ Permissions insuffisantes.', flags: [MessageFlags.Ephemeral] });
      return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    try {
      const panel = await buildMemberCasePanel(guild, ticket.userId, 'resume', 0);
      await interaction.editReply({
        components: panel.components,
        files: panel.files,
        flags: [MessageFlags.IsComponentsV2],
      });
    } catch (err) {
      logger.error('Ticket', 'Error building member profile card for ticket:', err);
      await interaction.editReply({ content: "❌ Impossible de générer la fiche de l'utilisateur." });
    }
    return;
  }

  // 4. Action: Fermer
  if (action === 'close') {
    // Le créateur ou le staff peut fermer
    const isOpener = ticket.userId === user.id;
    const isStaff = canManageTicket(member as GuildMember, guildConfig, ticket.staffRoleId);

    if (!isOpener && !isStaff) {
      await interaction.reply({ content: "❌ Vous n'avez pas la permission de fermer ce ticket.", flags: [MessageFlags.Ephemeral] });
      return;
    }

    if (ticket.status === 'CLOSED') {
      await interaction.reply({ content: '⚠️ Le ticket est déjà fermé.', flags: [MessageFlags.Ephemeral] });
      return;
    }

    await interaction.deferUpdate();
    await closeTicket(client, ticketId, user.id, user.username);
    return;
  }

  // 5. Action: Réouvrir
  if (action === 'reopen') {
    if (!canManageTicket(member as GuildMember, guildConfig, ticket.staffRoleId)) {
      await interaction.reply({ content: '❌ Seuls les membres du personnel peuvent réouvrir un ticket.', flags: [MessageFlags.Ephemeral] });
      return;
    }

    await interaction.deferUpdate();

    // Un ticket archivé sort d'abord des archives : sans cela le salon restait
    // rangé et muet pendant que le ticket, lui, repassait ouvert.
    if (ticket.status === 'ARCHIVED') {
      await unarchiveTicket(client, ticketId, { id: user.id, username: user.username }).catch((err) => {
        logger.error('Ticket', 'Error unarchiving before reopen:', err);
      });
      await logTicketEvent(client, guildConfig, 'UNARCHIVED', ticket, user);
    }

    // Mettre à jour en BDD
    await prisma.ticket.update({
      where: { id: ticketId },
      data: {
        status: 'OPEN',
        closedById: null,
        closedByName: null,
        closedAt: null,
        archivedById: null,
        archivedByName: null,
        archivedAt: null,
        archivedFromCategoryId: null
      }
    });

    const ticketChannel = interaction.channel as TextChannel;
    if (ticketChannel) {
      // Rename channel
      await renameChannelToOpen(client, ticketChannel.id).catch(() => null);

      // Restaurer les permissions de l'opener
      try {
        await ticketChannel.permissionOverwrites.edit(ticket.userId, {
          ViewChannel: true,
          // Un ticket clos sans avoir jamais été pris en charge repart
          // verrouillé : la réouverture ne doit pas contourner l'attente.
          SendMessages: !ticket.lockUntilClaim,
          ReadMessageHistory: true
        });
      } catch (err) {
        logger.error('Ticket', 'Error restoring opener permissions:', err);
      }

      if (ticket.lockUntilClaim) {
        await applyTicketLockState(client, ticket, guildConfig, true);
      }

      // Restaurer le container V2 du message de bienvenue (ré-active les boutons désactivés à la fermeture)
      try {
        const welcomeMessage = await findTicketWelcomeMessage(ticketChannel, ticketId);
        if (welcomeMessage) {
          const bodyText = `Ce ticket a été réouvert par <@${user.id}>.\n\n**Auteur :** <@${ticket.userId}>\n**Raison :** ${ticket.reason}\n**Description :** ${ticket.description}`;
          const updatedContainer = buildTicketStatusContainer(ticket, bodyText, COLORS_RAW.primary);

          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`ticket:claim:${ticketId}`).setLabel('Prendre en charge').setStyle(ButtonStyle.Primary).setEmoji('🛠️'),
            new ButtonBuilder().setCustomId(`ticket:info:${ticketId}`).setLabel('Infos Membre').setStyle(ButtonStyle.Secondary).setEmoji('🔍'),
            new ButtonBuilder().setCustomId(`ticket:macros:${ticketId}`).setLabel('Macros').setStyle(ButtonStyle.Secondary).setEmoji('⚡'),
            new ButtonBuilder().setCustomId(`ticket:close:${ticketId}`).setLabel('Fermer').setStyle(ButtonStyle.Danger).setEmoji('🔒')
          );

          await welcomeMessage.edit({
            components: [updatedContainer, row],
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: { users: [user.id, ticket.userId] },
          }).catch(() => null);
        }
      } catch (err) {
        logger.error('Ticket', 'Error restoring welcome message container on reopen:', err);
      }

      // Supprimer le message d'interaction précédent ou juste en envoyer un nouveau
      await ticketChannel.send({
        embeds: [successEmbed('Ticket Réouvert', `Le ticket a été réouvert par <@${user.id}>. Le créateur a de nouveau accès au salon.`)],
        allowedMentions: { users: [user.id, ticket.userId] },
      });
    }

    // Logger
    await logTicketEvent(client, guildConfig, 'REOPENED', ticket, user);
    return;
  }

  // 5 bis. Action: Archiver / Désarchiver - le salon survit, rien n'est perdu
  if (action === 'archive' || action === 'unarchive') {
    if (!canManageTicket(member as GuildMember, guildConfig, ticket.staffRoleId)) {
      await interaction.reply({ content: `❌ Seuls les membres du personnel peuvent ${action === 'archive' ? 'archiver' : 'désarchiver'} un ticket.`, flags: [MessageFlags.Ephemeral] });
      return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    try {
      if (action === 'archive') {
        const result = await archiveTicket(client, ticketId, { id: user.id, username: user.username });
        await logTicketEvent(
          client, guildConfig, 'ARCHIVED', result.ticket, user,
          result.transcriptId ? transcriptUrl(result.transcriptId) : undefined,
        );
        await interaction.editReply({
          content: guildConfig.ticketArchiveCategoryId
            ? '📦 Ticket archivé : le salon passe en lecture seule dans la catégorie d\'archives.'
            : "📦 Ticket archivé : le salon passe en lecture seule. Configurez une catégorie d'archives pour le ranger automatiquement.",
        });
      } else {
        const updated = await unarchiveTicket(client, ticketId, { id: user.id, username: user.username });
        await logTicketEvent(client, guildConfig, 'UNARCHIVED', updated, user);
        await interaction.editReply({ content: '📤 Ticket sorti des archives : le staff peut de nouveau y écrire.' });
      }
    } catch (err) {
      logger.error('Ticket', `Error on ticket ${action}:`, err);
      await interaction.editReply({ content: `❌ ${err instanceof Error ? err.message : 'Opération impossible.'}` });
    }
    return;
  }

  // 5 ter. Action: Verrou anti-suppression
  if (action === 'lock') {
    if (!canManageTicket(member as GuildMember, guildConfig, ticket.staffRoleId)) {
      await interaction.reply({ content: '❌ Seuls les membres du personnel peuvent verrouiller un ticket.', flags: [MessageFlags.Ephemeral] });
      return;
    }

    // La durée et le motif passent par un modal : un simple bouton poserait un
    // verrou muet, impossible à justifier pour qui le trouve des semaines après.
    const modal = new ModalBuilder()
      .setCustomId(`modal:ticket:lock:${ticketId}`)
      .setTitle('Protéger contre la suppression')
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('duration')
            .setLabel('Durée')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(`Au choix : ${DELETION_LOCK_DURATIONS.map((d) => d.value).join(', ')}`)
            .setValue('30d')
            .setRequired(true)
            .setMaxLength(16),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('reason')
            .setLabel('Motif de la protection')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Ex : litige en cours, pièce d\'un dossier de modération...')
            .setRequired(false)
            .setMaxLength(400),
        ),
      );

    await interaction.showModal(modal);
    return;
  }

  if (action === 'unlock') {
    if (!canManageTicket(member as GuildMember, guildConfig, ticket.staffRoleId)) {
      await interaction.reply({ content: '❌ Seuls les membres du personnel peuvent lever ce verrou.', flags: [MessageFlags.Ephemeral] });
      return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    const updated = await unlockTicketDeletion(ticketId);
    await refreshClosedTicketButtons(client, updated);
    await logTicketEvent(client, guildConfig, 'UNLOCKED', updated, user);
    await interaction.editReply({ content: '🔓 Verrou levé : ce ticket peut de nouveau être supprimé.' });
    return;
  }

  // 5 quater. Historique du membre : réouverture et suppression de son propre ticket
  if (action === 'hist_reopen' || action === 'hist_delete' || action === 'hist_delconf') {
    if (ticket.userId !== user.id) {
      await interaction.reply({ content: "❌ Ce ticket n'est pas le vôtre.", flags: [MessageFlags.Ephemeral] });
      return;
    }
    await handleTicketHistoryAction(client, interaction, action, ticket, guildConfig);
    return;
  }

  // 6. Action: Supprimer (avec transcription obligatoire !)
  if (action === 'delete') {
    if (!canManageTicket(member as GuildMember, guildConfig, ticket.staffRoleId)) {
      await interaction.reply({ content: '❌ Seuls les membres du personnel peuvent supprimer un ticket.', flags: [MessageFlags.Ephemeral] });
      return;
    }

    // Le verrou prime sur la permission : c'est tout son objet. Il est relu ici
    // et pas seulement reflété dans le bouton, un message ancien pouvant porter
    // des composants antérieurs à la pose du verrou.
    const lock = resolveDeletionLock(ticket);
    if (lock.locked) {
      await interaction.reply({ content: deletionLockMessage(lock), flags: [MessageFlags.Ephemeral] });
      return;
    }

    const ticketChannel = interaction.channel as TextChannel;
    if (!ticketChannel) return;

    await interaction.reply({ content: '⏳ Transcription en cours et suppression imminente du salon...' });

    try {
      // 1. Générer la transcription
      const transcriptData = await generateTranscript(ticketChannel);

      // 2. Enregistrer la transcription et fermer le ticket en BDD
      await prisma.ticket.update({
        where: { id: ticketId },
        data: {
          channelId: null, // Plus de salon actif
          status: 'CLOSED',
          transcriptId: transcriptData.id
        }
      });

      // 3. Logger l'événement avec le lien de transcription
      const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';
      const publicLink = `${dashboardUrl}/transcripts/${transcriptData.id}`;
      
      await logTicketEvent(client, guildConfig, 'DELETED', ticket, user, publicLink);

      // 4. Envoyer en MP aux personnes concernées (créateur, staff claim, staff close, staff delete) sans doublons
      const usersToDm = new Set<string>();
      if (ticket.userId) usersToDm.add(ticket.userId);
      if (ticket.claimedById) usersToDm.add(ticket.claimedById);
      if (ticket.closedById) usersToDm.add(ticket.closedById);
      if (user.id) usersToDm.add(user.id);
      
      const dmEmbed = new EmbedBuilder()
        .setTitle('📄 Transcription de ticket')
        .setDescription(`Le ticket d'assistance **${ticket.reason}** du serveur **${guild.name}** a été supprimé.\n\nVoici le lien pour consulter la transcription complète :`)
        .addFields([{ name: "Lien d'accès", value: `🌐 [Consulter le transcript](${publicLink})` }])
        .setColor(COLORS.primary as ColorResolvable)
        .setTimestamp();
        
      for (const dmUserId of usersToDm) {
        try {
          const dmUser = await client.users.fetch(dmUserId);
          if (dmUser) await dmUser.send({ embeds: [dmEmbed], allowedMentions: { parse: [] } });
        } catch (err) {
          // Ignorer si les MPs sont bloqués
        }
      }

      // 5. Supprimer le salon Discord après 3 secondes
      setTimeout(async () => {
        try {
          await ticketChannel.delete(`Ticket supprimé par ${user.username} (Transcript ID: ${transcriptData.id})`);
        } catch (delErr) {
          logger.error('Ticket', 'Error deleting ticket channel:', delErr);
        }
      }, 3000);

    } catch (err) {
      logger.error('Ticket', 'Error deleting ticket and generating transcript:', err);
      await interaction.followUp({ content: '❌ Une erreur est survenue lors de la transcription. Suppression annulée.', flags: [MessageFlags.Ephemeral] });
    }
    return;
  }
}

type TicketWorkspaceParams = {
  guild: Guild;
  user: { id: string; username: string };
  ticketType: TicketPanelTypeConfig;
  guildConfig: any;
  reason: string;
  description: string;
  locale: BotLocale;
  /**
   * Demande deja enregistree (validation prealable) : la ligne existe en base
   * au statut PENDING et doit etre completee, pas dupliquee.
   */
  existingTicketId?: string | null;
};

type TicketWorkspaceResult = {
  ticketId: string;
  /** Message de confirmation destine a l'auteur du ticket. */
  userMessage: string;
};

/**
 * Annonce l'ouverture sur le bus, une fois l'espace du ticket en place : un
 * abonne qui veut y ecrire doit trouver le salon deja cree.
 *
 * `channelId` reste nul quand la conversation ne vit pas dans un salon du
 * serveur du ticket - mode MP, ou salon heberge sur le serveur staff lie.
 * Annoncer un identifiant introuvable cote guilde ferait echouer les abonnes
 * qui le resolvent.
 */
function publishTicketCreated(ticket: Ticket, channelId: string | null): void {
  kotboEventBus.publish('ticket:created', {
    guildId: ticket.guildId,
    ticketId: ticket.id,
    userId: ticket.userId,
    userTag: ticket.username,
    channelId,
    ticketTypeId: ticket.ticketTypeId,
    ticketTypeLabel: ticket.ticketTypeLabel,
    subject: ticket.reason,
    timestamp: Date.now(),
  });
  broadcastDashboardStateChange(ticket.guildId, 'tickets_updated');
}

/**
 * Cree le salon, le fil ou la conversation MP d'un ticket puis y depose le
 * message d'accueil.
 *
 * Separee de `executeTicketCreation` parce qu'elle sert aussi a la validation
 * prealable : une demande acceptee des heures plus tard n'a plus d'interaction
 * a repondre, seulement un ticket a materialiser. Elle leve donc une erreur
 * porteuse d'un message lisible au lieu de repondre elle-meme.
 */
async function createTicketWorkspace(
  client: Client,
  params: TicketWorkspaceParams,
): Promise<TicketWorkspaceResult> {
  const { guild, user, ticketType, guildConfig, reason, description, locale, existingTicketId } = params;
  const guildId = guild.id;

  const ticketMode = ticketType.mode || guildConfig.ticketMode || 'CHANNEL';
  const isAnonymous = ticketType.anonymous === true && ticketMode === 'DM';
  const useStaffServerRelay = ticketType.staffServerRelay === true;
  // Un ticket MP n'a pas de salon a verrouiller : le reglage ne s'y applique pas.
  const lockUntilClaim = ticketMode !== 'DM' && resolveLockUntilClaim(ticketType, guildConfig);

  /** Complete la demande deja validee, ou ouvre une ligne neuve. */
  const persistTicket = async (data: Record<string, unknown>) => {
    if (existingTicketId) {
      return prisma.ticket.update({
        where: { id: existingTicketId },
        data: { ...data, rejectionReason: null },
      });
    }
    return prisma.ticket.create({ data: data as never });
  };

  const ticketStaffRoleId = ticketType.staffRoleId || guildConfig.ticketStaffRoleId || null;
  const staffMention = ticketStaffRoleId ? `<@&${ticketStaffRoleId}>` : null;

  if (ticketMode === 'DM') {
    // ─── Mode DM : ticket via messages privés ───────────────────────
    let relayChannel: TextChannel | null = null;
    let staffServerGuildId: string | null = null;

    if (useStaffServerRelay) {
      const staffLink = await prisma.staffServerLink.findFirst({
        where: { mainGuildId: guildId, enabled: true },
      });
      if (staffLink) {
        staffServerGuildId = staffLink.staffGuildId;
        const staffGuild = client.guilds.cache.get(staffLink.staffGuildId);
        const logChannelId = staffLink.staffLogChannelId;
        if (logChannelId && staffGuild) {
          const ch = staffGuild.channels.cache.get(logChannelId);
          if (ch instanceof TextChannel) relayChannel = ch;
        }
        if (!relayChannel && staffGuild) {
          const fallback = staffGuild.channels.cache.find(
            (c) => c instanceof TextChannel && c.name.includes('ticket'),
          );
          if (fallback instanceof TextChannel) relayChannel = fallback;
        }
      }
    }

    if (!relayChannel) {
      const relayChannelId = (guildConfig as any).ticketDmRelayChannelId || guildConfig.ticketLogChannelId;
      const fetched = relayChannelId ? await client.channels.fetch(relayChannelId).catch(() => null) : null;
      if (fetched instanceof TextChannel) relayChannel = fetched;
    }

    if (!relayChannel) {
      throw new Error('❌ Aucun salon de relais configuré pour le mode MP. Contactez un administrateur.');
    }

    const displayName = isAnonymous ? 'Membre Anonyme' : user.username;

    const ticket = await persistTicket({
      guildId,
      mode: 'DM',
      ticketTypeId: ticketType.id,
      ticketTypeLabel: ticketType.label,
      staffRoleId: ticketStaffRoleId,
      categoryId: null,
      userId: user.id,
      username: user.username,
      reason,
      description,
      status: 'OPEN',
      isAnonymous,
      staffServerGuildId,
    });

    const threadName = isAnonymous
      ? `🎫 Anonyme - ${reason}`.slice(0, 100)
      : `🎫 ${user.username} - ${reason}`.slice(0, 100);

    const thread = await relayChannel.threads.create({
      name: threadName,
      autoArchiveDuration: 10080,
      reason: `Ticket DM de ${displayName}`
    });

    await prisma.ticket.update({ where: { id: ticket.id }, data: { threadId: thread.id } });

    const creatorLine = isAnonymous
      ? '**Créateur :** Anonyme (identité masquée)'
      : `**Créateur :** <@${user.id}> (${user.username})`;

    const welcomeColorHex = guildConfig.ticketWelcomeColor || '#5865F2';
    const color = typeof welcomeColorHex === 'string' ? parseInt(welcomeColorHex.replace('#', ''), 16) : COLORS_RAW.primary;

    const staffEmbed = new EmbedBuilder()
      .setTitle(`🎫 Nouveau Ticket MP · ${ticketType.label}`)
      .setDescription(`${creatorLine}\n**Raison :** ${reason}\n\n**Description :**\n${description}\n\n> Les messages envoyés ici seront relayés en MP à l'utilisateur.`)
      .setColor(color)
      .setTimestamp()
      .setFooter({ text: `Kotbo · Ticket ID: ${ticket.id}` });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`ticket:claim:${ticket.id}`).setLabel('Prendre en charge').setStyle(ButtonStyle.Primary).setEmoji('🛠️'),
      new ButtonBuilder().setCustomId(`ticket:info:${ticket.id}`).setLabel('Infos Membre').setStyle(ButtonStyle.Secondary).setEmoji('🔍'),
      new ButtonBuilder().setCustomId(`ticket:macros:${ticket.id}`).setLabel('Macros').setStyle(ButtonStyle.Secondary).setEmoji('⚡'),
      new ButtonBuilder().setCustomId(`ticket:close:${ticket.id}`).setLabel('Fermer').setStyle(ButtonStyle.Danger).setEmoji('🔒')
    );

    if (staffMention) await thread.send({ content: staffMention, allowedMentions: { roles: ticketStaffRoleId ? [ticketStaffRoleId] : [] } });
    await thread.send({ embeds: [staffEmbed], components: [row] });

    const dmEmbed = new EmbedBuilder()
      .setTitle(`🎫 Ticket ouvert · ${guild.name}`)
      .setDescription(`Votre ticket d'assistance a bien été créé !\nLe personnel va prendre en charge votre demande. **Répondez directement ici** pour communiquer avec le staff.\n\n**Raison :** ${reason}\n**Description :** ${description}`)
      .setColor(color)
      .setTimestamp()
      .setFooter({ text: `Kotbo · Ticket ID: ${ticket.id}` });

    try {
      const dmUser = await client.users.fetch(user.id);
      await dmUser.send({ embeds: [dmEmbed], allowedMentions: { parse: [] } });
    } catch {
      await thread.send({ embeds: [errorEmbed('MP bloqués', `<@${user.id}> a ses messages privés désactivés. Le ticket ne pourra pas fonctionner en mode MP.`)], allowedMentions: { parse: [] } });
    }

    await logTicketEvent(client, guildConfig, 'OPENED', ticket, user);
    await handleTicketTrigger(guildId, user.id, ticketType.id, reason, description, client, ticket.id);
    publishTicketCreated(ticket, null);

    client.users.fetch(user.id).then(dmUser => {
      if (dmUser) setupInteractiveTicketQuestions(client, dmUser, user.id, ticketType, guildConfig).catch(console.error);
    }).catch(console.error);

    return {
      ticketId: ticket.id,
      userMessage: '✅ Votre ticket a été créé ! Consultez vos messages privés pour communiquer avec le staff.',
    };

  } else if (ticketMode === 'THREAD') {
    // ─── Mode Thread : ticket dans un fil de discussion ─────────────
    const parentChannelId = guildConfig.ticketChannelId || guildConfig.ticketLogChannelId;
    const parentChannel = parentChannelId ? await client.channels.fetch(parentChannelId).catch(() => null) : null;

    if (!parentChannel || !(parentChannel instanceof TextChannel)) {
      throw new Error('❌ Aucun salon configuré pour le mode Thread. Contactez un administrateur.');
    }

    const ticket = await persistTicket({
      guildId,
      mode: 'THREAD',
      ticketTypeId: ticketType.id,
      ticketTypeLabel: ticketType.label,
      staffRoleId: ticketStaffRoleId,
      categoryId: null,
      userId: user.id,
      username: user.username,
      reason,
      description,
      status: 'OPEN',
      lockUntilClaim,
    });

    const thread = await parentChannel.threads.create({
      name: `🎫 ${user.username} - ${reason}`.slice(0, 100),
      autoArchiveDuration: 10080,
      type: ChannelType.PrivateThread,
      reason: `Ticket Thread de ${user.username}`
    });

    await thread.members.add(user.id).catch(() => null);

    await prisma.ticket.update({ where: { id: ticket.id }, data: { threadId: thread.id, channelId: thread.id } });

    const welcomeContainer = buildTicketWelcomeContainer(
      guildConfig,
      ticketType,
      ticket,
      user,
      staffMention,
      reason,
      description,
      locale
    );

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`ticket:claim:${ticket.id}`).setLabel('Prendre en charge').setStyle(ButtonStyle.Primary).setEmoji('🛠️'),
      new ButtonBuilder().setCustomId(`ticket:info:${ticket.id}`).setLabel('Infos Membre').setStyle(ButtonStyle.Secondary).setEmoji('🔍'),
      new ButtonBuilder().setCustomId(`ticket:macros:${ticket.id}`).setLabel('Macros').setStyle(ButtonStyle.Secondary).setEmoji('⚡'),
      new ButtonBuilder().setCustomId(`ticket:close:${ticket.id}`).setLabel('Fermer').setStyle(ButtonStyle.Danger).setEmoji('🔒')
    );

    await thread.send({
      components: [welcomeContainer, row],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { users: [user.id], roles: ticketStaffRoleId ? [ticketStaffRoleId] : [] },
    });

    // Le verrou vient apres l'accueil : un fil verrouille n'accepte plus que
    // les messages des moderateurs.
    if (lockUntilClaim) {
      await thread.send({ embeds: [buildTicketLockNoticeEmbed(staffMention)], allowedMentions: { parse: [] } }).catch(() => null);
      await thread.setLocked(true, 'Ticket en attente de prise en charge').catch(() => null);
    }

    // Macros a envoi automatique : posees apres l'accueil, avant le verrou
    // d'attente, pour que le membre les lise meme si le salon se ferme ensuite.
    await sendAutoMacros({ channel: thread, guildId, guildName: guild.name, ticket }).catch(() => null);

    await logTicketEvent(client, guildConfig, 'OPENED', ticket, user);
    await handleTicketTrigger(guildId, user.id, ticketType.id, reason, description, client, ticket.id);
    publishTicketCreated(ticket, thread.id);

    if (!lockUntilClaim) {
      setupInteractiveTicketQuestions(client, thread, user.id, ticketType, guildConfig).catch(console.error);
    }

    return {
      ticketId: ticket.id,
      userMessage: lockUntilClaim
        ? `✅ Votre ticket a été créé : <#${thread.id}>. Il reste verrouillé jusqu'à sa prise en charge par un membre du staff.`
        : `✅ Votre ticket a été créé : <#${thread.id}>.`,
    };

  } else {
    // ─── Mode CHANNEL (défaut) : créer un salon texte ───────────────

    // Tickets internes : le salon est créé sur le serveur staff lié (si configuré)
    let targetGuild = guild;
    let onStaffServer = false;
    let staffLinkForTicket: { staffGuildId: string; simpleStaffRoleId: string | null } | null = null;

    if (ticketType.staffServerChannel) {
      const staffLink = await prisma.staffServerLink.findFirst({
        where: { mainGuildId: guildId, enabled: true },
        select: { staffGuildId: true, simpleStaffRoleId: true },
      });
      const staffGuild = staffLink ? client.guilds.cache.get(staffLink.staffGuildId) : null;
      if (staffGuild) {
        targetGuild = staffGuild;
        onStaffServer = true;
        staffLinkForTicket = staffLink;
      } else {
        logger.warn('Ticket', `Ticket interne demandé mais serveur staff introuvable pour ${guildId} - repli sur le serveur principal.`);
      }
    }

    const ticketCategoryId = onStaffServer
      ? (ticketType.staffServerCategoryId || null)
      : (ticketType.categoryId || guildConfig.ticketCategoryId || null);
    const ticketCategory = ticketCategoryId
      ? targetGuild.channels.cache.get(ticketCategoryId)
      : null;

    const cleanedUsername = user.username.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'membre';
    const channelName = `ticket-${cleanedUsername}`;

    // Verrouille, le salon reste visible pour l'auteur comme pour le staff :
    // seule l'ecriture est refusee, et il faut la refuser explicitement car
    // `SendMessages` non precise s'herite de la categorie.
    const participantOverwrite = (id: string) => ({
      id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
        ...(lockUntilClaim ? [] : [PermissionFlagsBits.SendMessages]),
      ],
      ...(lockUntilClaim ? { deny: [PermissionFlagsBits.SendMessages] } : {}),
    });

    const permissionOverwrites: any[] = [
      {
        id: targetGuild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel]
      },
      participantOverwrite(user.id),
    ];

    // Sur le serveur staff, les rôles du serveur principal n'existent pas : n'ajouter un
    // overwrite de rôle que s'il existe réellement sur la guilde cible.
    const staffRoleForOverwrite = ticketStaffRoleId && targetGuild.roles.cache.has(ticketStaffRoleId)
      ? ticketStaffRoleId
      : (onStaffServer && staffLinkForTicket?.simpleStaffRoleId && targetGuild.roles.cache.has(staffLinkForTicket.simpleStaffRoleId)
        ? staffLinkForTicket.simpleStaffRoleId
        : null);

    if (staffRoleForOverwrite) {
      permissionOverwrites.push(participantOverwrite(staffRoleForOverwrite));
    }

    if (guildConfig.moderatorRoleId && targetGuild.roles.cache.has(guildConfig.moderatorRoleId)) {
      permissionOverwrites.push(participantOverwrite(guildConfig.moderatorRoleId));
    }

    const ticketChannel = await targetGuild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: ticketCategory && ticketCategory.type === ChannelType.GuildCategory ? ticketCategory.id : undefined,
      topic: `Ticket de ${user.username} - Raison : ${reason}`,
      permissionOverwrites
    });

    const ticket = await persistTicket({
      guildId,
      channelId: ticketChannel.id,
      mode: 'CHANNEL',
      ticketTypeId: ticketType.id,
      ticketTypeLabel: ticketType.label,
      staffRoleId: staffRoleForOverwrite,
      categoryId: ticketCategoryId,
      userId: user.id,
      username: user.username,
      reason,
      description,
      status: 'OPEN',
      staffServerGuildId: onStaffServer ? targetGuild.id : null,
      lockUntilClaim,
    });

    const welcomeContainer = buildTicketWelcomeContainer(
      guildConfig,
      ticketType,
      ticket,
      user,
      staffMention,
      reason,
      description,
      locale
    );

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`ticket:claim:${ticket.id}`).setLabel('Prendre en charge').setStyle(ButtonStyle.Primary).setEmoji('🛠️'),
      new ButtonBuilder().setCustomId(`ticket:info:${ticket.id}`).setLabel('Infos Membre').setStyle(ButtonStyle.Secondary).setEmoji('🔍'),
      new ButtonBuilder().setCustomId(`ticket:macros:${ticket.id}`).setLabel('Macros').setStyle(ButtonStyle.Secondary).setEmoji('⚡'),
      new ButtonBuilder().setCustomId(`ticket:close:${ticket.id}`).setLabel('Fermer').setStyle(ButtonStyle.Danger).setEmoji('🔒')
    );

    await ticketChannel.send({
      components: [welcomeContainer, row],
      flags: MessageFlags.IsComponentsV2,
      allowedMentions: { users: [user.id], roles: staffRoleForOverwrite ? [staffRoleForOverwrite] : [] },
    });

    if (lockUntilClaim) {
      await ticketChannel.send({ embeds: [buildTicketLockNoticeEmbed(staffMention)], allowedMentions: { parse: [] } }).catch(() => null);
    }

    await sendAutoMacros({ channel: ticketChannel, guildId, guildName: targetGuild.name, ticket }).catch(() => null);

    await logTicketEvent(client, guildConfig, 'OPENED', ticket, user);
    await handleTicketTrigger(guildId, user.id, ticketType.id, reason, description, client, ticket.id);
    publishTicketCreated(ticket, onStaffServer ? null : ticketChannel.id);

    // Les questions interactives attendent des reponses de l'auteur : les
    // poser dans un salon verrouille ne ferait qu'accumuler des expirations.
    if (!lockUntilClaim) {
      setupInteractiveTicketQuestions(client, ticketChannel, user.id, ticketType, guildConfig).catch(console.error);
    }

    // <#id> ne résout pas entre serveurs : URL complète quand le ticket vit sur le serveur staff
    const channelRef = onStaffServer
      ? `https://discord.com/channels/${targetGuild.id}/${ticketChannel.id}`
      : `<#${ticketChannel.id}>`;

    return {
      ticketId: ticket.id,
      userMessage: lockUntilClaim
        ? `✅ Votre ticket a été créé : ${channelRef}. Il reste verrouillé jusqu'à sa prise en charge par un membre du staff.`
        : `✅ Votre ticket a été créé avec succès : ${channelRef}.`,
    };
  }
}

/** Encart depose dans un ticket verrouille pour expliquer l'absence d'ecriture. */
function buildTicketLockNoticeEmbed(staffMention: string | null): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('🔒 Ticket verrouillé')
    .setDescription(
      `Ce ticket est visible mais **verrouillé** : personne ne peut y écrire tant qu'un membre du staff${staffMention ? ` (${staffMention})` : ''} ne l'a pas pris en charge.\n\n` +
      'Le salon s\'ouvrira automatiquement dès la prise en charge.',
    )
    .setColor(COLORS.warning as ColorResolvable)
    .setTimestamp();
}

/**
 * Enregistre une demande de ticket en attente et depose sa carte de validation
 * dans le salon prevu. Aucun salon de ticket n'est cree a ce stade.
 */
async function createPendingTicketRequest(
  client: Client,
  params: Omit<TicketWorkspaceParams, 'existingTicketId'>,
): Promise<TicketWorkspaceResult> {
  const { guild, user, ticketType, guildConfig, reason, description } = params;

  const reviewChannelId = guildConfig.ticketApprovalChannelId || guildConfig.ticketLogChannelId;
  const reviewChannel = reviewChannelId
    ? await client.channels.fetch(reviewChannelId).catch(() => null)
    : null;

  if (!reviewChannel || !(reviewChannel instanceof TextChannel)) {
    throw new Error("❌ Aucun salon de validation configuré pour les demandes de ticket. Contactez un administrateur.");
  }

  const ticketMode = ticketType.mode || guildConfig.ticketMode || 'CHANNEL';
  const ticketStaffRoleId = ticketType.staffRoleId || guildConfig.ticketStaffRoleId || null;

  const ticket = await prisma.ticket.create({
    data: {
      guildId: guild.id,
      mode: ticketMode,
      ticketTypeId: ticketType.id,
      ticketTypeLabel: ticketType.label,
      staffRoleId: ticketStaffRoleId,
      categoryId: null,
      userId: user.id,
      username: user.username,
      reason,
      description,
      status: 'PENDING',
      lockUntilClaim: ticketMode !== 'DM' && resolveLockUntilClaim(ticketType, guildConfig),
      reviewChannelId: reviewChannel.id,
    },
  });

  const message = await reviewChannel.send({
    content: ticketStaffRoleId ? `<@&${ticketStaffRoleId}>` : undefined,
    embeds: [buildTicketReviewEmbed(ticket)],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`ticket:approve:${ticket.id}`).setLabel('Valider').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId(`ticket:reject:${ticket.id}`).setLabel('Refuser').setStyle(ButtonStyle.Danger).setEmoji('⛔'),
        new ButtonBuilder().setCustomId(`ticket:info:${ticket.id}`).setLabel('Infos Membre').setStyle(ButtonStyle.Secondary).setEmoji('🔍'),
      new ButtonBuilder().setCustomId(`ticket:macros:${ticket.id}`).setLabel('Macros').setStyle(ButtonStyle.Secondary).setEmoji('⚡'),
      ),
    ],
    allowedMentions: { roles: ticketStaffRoleId ? [ticketStaffRoleId] : [] },
  });

  await prisma.ticket.update({ where: { id: ticket.id }, data: { reviewMessageId: message.id } });

  return {
    ticketId: ticket.id,
    userMessage: "📬 Votre demande a été transmise au staff. Le ticket sera ouvert dès qu'un membre du personnel l'aura validée.",
  };
}

/**
 * Fige la carte de validation apres decision : boutons retires et verdict
 * affiche, pour qu'aucun autre membre du staff ne rejoue la meme demande.
 */
async function updateTicketReviewCard(
  client: Client,
  ticket: { id: string; reviewChannelId: string | null; reviewMessageId: string | null; userId: string; username: string; reason: string; description: string; ticketTypeLabel: string | null },
  decision: 'APPROVED' | 'REJECTED',
  reviewer: { id: string; username: string },
  rejectionReason: string | null,
): Promise<void> {
  if (!ticket.reviewChannelId || !ticket.reviewMessageId) return;

  try {
    const channel = client.channels.cache.get(ticket.reviewChannelId)
      ?? await client.channels.fetch(ticket.reviewChannelId).catch(() => null);
    if (!channel || !(channel instanceof TextChannel)) return;

    const message = await channel.messages.fetch(ticket.reviewMessageId).catch(() => null);
    if (!message) return;

    const embed = buildTicketReviewEmbed(ticket)
      .setTitle(decision === 'APPROVED' ? '✅ Demande de ticket validée' : '⛔ Demande de ticket refusée')
      .setColor((decision === 'APPROVED' ? COLORS.success : COLORS.danger) as ColorResolvable)
      .addFields([
        { name: decision === 'APPROVED' ? 'Validée par' : 'Refusée par', value: `<@${reviewer.id}>`, inline: true },
        ...(rejectionReason ? [{ name: 'Motif', value: rejectionReason.slice(0, 1024) }] : []),
      ]);

    await message.edit({ content: null, embeds: [embed], components: [], allowedMentions: { parse: [] } });
  } catch (err) {
    logger.error('Ticket', 'Error updating ticket review card:', err);
  }
}

/** Carte de decision affichee au staff pour une demande en attente. */
function buildTicketReviewEmbed(ticket: {
  id: string;
  userId: string;
  username: string;
  reason: string;
  description: string;
  ticketTypeLabel: string | null;
}): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('🕒 Demande de ticket en attente')
    .setDescription(`<@${ticket.userId}> (${ticket.username}) demande l'ouverture d'un ticket.`)
    .setColor(COLORS.warning as ColorResolvable)
    .addFields([
      { name: 'Type', value: ticket.ticketTypeLabel || 'Ticket standard', inline: true },
      { name: 'Raison', value: ticket.reason.slice(0, 1024) || '-', inline: true },
      { name: 'Description', value: ticket.description.slice(0, 1024) || '-' },
    ])
    .setTimestamp()
    .setFooter({ text: `Kotbo · Ticket ID: ${ticket.id}` });
}

/**
 * Point d'entree de l'ouverture depuis le panneau : refuse les membres
 * blacklistes, passe par la validation prealable quand elle est active, et
 * repond a l'interaction dans tous les cas.
 */
export async function executeTicketCreation(
  client: Client,
  interaction: ButtonInteraction | ModalSubmitInteraction | StringSelectMenuInteraction,
  ticketType: TicketPanelTypeConfig,
  reason: string,
  description: string
): Promise<string | null> {
  const { guildId, user, guild } = interaction;
  if (!guildId || !guild) return null;

  const guildConfig = await prisma.guild.findUnique({ where: { id: guildId } });
  if (!guildConfig) {
    await interaction.editReply({ content: '❌ Configuration du serveur introuvable.' });
    return null;
  }

  // Dernier filet : le formulaire a pu etre ouvert avant la mise en blacklist.
  const blacklisted = await findActiveTicketBlacklist(guildId, user.id);
  if (blacklisted) {
    await interaction.editReply({ content: ticketBlacklistMessage(blacklisted) });
    return null;
  }

  // Langue du serveur et non celle de la personne qui clique : le message
  // d'accueil est lu dans le salon par tous ceux qui y ont acces.
  const locale = await resolveGuildLocale(guildId, guild.preferredLocale);

  try {
    const params = { guild, user, ticketType, guildConfig, reason, description, locale };
    const result = resolveRequireApproval(ticketType, guildConfig)
      ? await createPendingTicketRequest(client, params)
      : await createTicketWorkspace(client, params);

    await interaction.editReply({ content: result.userMessage });
    return result.ticketId;
  } catch (err) {
    logger.error('Ticket', 'Error creating ticket:', err);
    // Les messages leves par la creation sont ecrits pour l'auteur du ticket :
    // les afficher tels quels evite un « erreur inconnue » quand la cause est
    // une configuration incomplete.
    const message = err instanceof Error && err.message.startsWith('❌')
      ? err.message
      : "❌ Une erreur est survenue lors de l'ouverture du ticket. Veuillez contacter un administrateur.";
    await interaction.editReply({ content: message });
    return null;
  }
}

export async function handleTicketModalSubmit(client: Client, customId: string, interaction: ModalSubmitInteraction): Promise<void> {
  // ─── DM direct ticket (from /ticket open in DM) ──────────
  if (customId.startsWith('modal:ticket:open:dm_direct:')) {
    const targetGuildId = customId.split(':')[4];
    return handleDmDirectTicket(client, interaction, targetGuildId);
  }

  const { guildId, guild } = interaction;
  if (!guildId || !guild) return;

  const guildConfig = await prisma.guild.findUnique({ where: { id: guildId } });
  if (!guildConfig) {
    await interaction.reply({ content: '❌ Configuration du serveur introuvable.', flags: [MessageFlags.Ephemeral] });
    return;
  }

  // ─── Verrou anti-suppression ──────────
  if (customId.startsWith('modal:ticket:lock:')) {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    const ticketId = customId.split(':')[3];
    const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, guildId } });
    if (!ticket) {
      await interaction.editReply({ content: '❌ Ticket introuvable.' });
      return;
    }

    const rawDuration = interaction.fields.getTextInputValue('duration')?.trim().toLowerCase() || 'permanent';
    const known = DELETION_LOCK_DURATIONS.find((d) => d.value === rawDuration);
    if (!known) {
      await interaction.editReply({
        content: `❌ Durée inconnue. Valeurs acceptées : ${DELETION_LOCK_DURATIONS.map((d) => `\`${d.value}\``).join(', ')}.`,
      });
      return;
    }

    const reason = interaction.fields.getTextInputValue('reason')?.trim() || null;
    const durationMs = resolveLockDuration(rawDuration);
    const updated = await lockTicketDeletion(ticket.id, { id: interaction.user.id, username: interaction.user.username }, { durationMs, reason });

    await refreshClosedTicketButtons(client, updated);
    await logTicketEvent(
      client, guildConfig, 'LOCKED', updated, interaction.user,
      updated.deletionLockedUntil ? `<t:${Math.floor(updated.deletionLockedUntil.getTime() / 1000)}:f>` : undefined,
    );

    await interaction.editReply({
      content: `🔐 Ticket protégé contre la suppression (**${known.label}**).`
        + (reason ? `\n**Motif :** ${reason}` : ''),
    });
    return;
  }

  // ─── Refus d'une demande en attente de validation ──────────
  if (customId.startsWith('modal:ticket:reject:')) {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    const ticketId = customId.split(':')[3];
    const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, guildId } });
    if (!ticket) {
      await interaction.editReply({ content: '❌ Demande introuvable.' });
      return;
    }
    if (ticket.status !== 'PENDING') {
      await interaction.editReply({ content: '⚠️ Cette demande a déjà été traitée.' });
      return;
    }

    const rejectionReason = interaction.fields.getTextInputValue('reason')?.trim() || null;

    await prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        status: 'REJECTED',
        rejectionReason,
        reviewedById: interaction.user.id,
        reviewedByName: interaction.user.username,
        reviewedAt: new Date(),
      },
    });

    await updateTicketReviewCard(client, ticket, 'REJECTED', interaction.user, rejectionReason);

    const opener = await client.users.fetch(ticket.userId).catch(() => null);
    if (opener) {
      await opener.send({
        embeds: [errorEmbed(
          'Demande de ticket refusée',
          `Votre demande sur **${guild.name}** a été refusée.${rejectionReason ? `\n\n**Motif :** ${rejectionReason}` : ''}`,
        )],
        allowedMentions: { parse: [] },
      }).catch(() => null);
    }

    await interaction.editReply({ content: '⛔ Demande refusée. Le membre a été prévenu en message privé.' });
    return;
  }

  if (customId === 'modal:ticket:open' || customId.startsWith('modal:ticket:open:')) {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    const typeId = customId.startsWith('modal:ticket:open:') ? customId.split(':')[3] : null;
    const ticketType = resolveTicketPanelType(guildConfig, typeId);

    let reason = '';
    let description = '';

    // Meme filtre qu'a l'affichage : les questions interactives ne sont pas
    // dans le modal, les relire ici ne renverrait que des trous.
    const modalFields = resolveModalFormFields(ticketType, guildConfig);

    if (modalFields.length > 0) {
      const answers: string[] = [];
      modalFields.forEach((f: any) => {
        try {
          const val = interaction.fields.getTextInputValue(f.id);
          answers.push(`**${f.label}** :\n${val || '_Non renseigné_'}`);
          if (!reason && val) {
            reason = val.substring(0, 100);
          }
        } catch {}
      });
      description = answers.join('\n\n');
      if (!reason) {
        reason = ticketType.label || 'Ticket';
      }
    } else {
      // Rétrocompatibilité avec les champs par défaut du type
      const fieldsToUse = Array.isArray((ticketType as any).fields) && (ticketType as any).fields.length > 0
        ? (ticketType as any).fields.slice(0, 5)
        : null;

      if (fieldsToUse) {
        const answers: string[] = [];
        for (const f of fieldsToUse) {
          try {
            const val = interaction.fields.getTextInputValue(f.id);
            answers.push(`**${f.label}** :\n${val || '_Non renseigné_'}`);
            if (!reason && val) {
              reason = val.substring(0, 100);
            }
          } catch {}
        }
        description = answers.join('\n\n');
        if (!reason) {
          reason = ticketType.label || 'Ticket';
        }
      } else {
        reason = interaction.fields.getTextInputValue('reason') || 'Ticket';
        description = interaction.fields.getTextInputValue('description') || 'Aucune description fournie.';
      }
    }

    await executeTicketCreation(client, interaction, ticketType, reason, description);
    return;
  }

}

/**
 * Creates a DM ticket from /ticket open in DMs.
 */
async function handleDmDirectTicket(
  client: Client,
  interaction: ModalSubmitInteraction,
  targetGuildId: string,
): Promise<void> {
  const user = interaction.user;

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  const guildConfig = await prisma.guild.findUnique({ where: { id: targetGuildId } });
  if (!guildConfig) {
    await interaction.editReply({ content: '❌ Ce serveur n\'est pas configuré.' });
    return;
  }

  const guild = client.guilds.cache.get(targetGuildId);
  if (!guild) {
    await interaction.editReply({ content: '❌ Le bot n\'est pas présent sur ce serveur.' });
    return;
  }

  const blacklisted = await findActiveTicketBlacklist(targetGuildId, user.id);
  if (blacklisted) {
    await interaction.editReply({ content: ticketBlacklistMessage(blacklisted) });
    return;
  }

  const existingTicket = await prisma.ticket.findFirst({
    where: { guildId: targetGuildId, userId: user.id, status: { in: ['PENDING', 'OPEN', 'CLAIMED'] } },
  });
  if (existingTicket) {
    await interaction.editReply({
      content: existingTicket.status === 'PENDING'
        ? `⏳ Votre demande de ticket sur **${guild.name}** attend encore la validation du staff.`
        : `⚠️ Vous avez déjà un ticket ouvert sur **${guild.name}**.`,
    });
    return;
  }

  const reason = interaction.fields.getTextInputValue('reason');
  const description = interaction.fields.getTextInputValue('description');

  const ticketStaffRoleId = guildConfig.ticketStaffRoleId || null;
  const staffMention = ticketStaffRoleId ? `<@&${ticketStaffRoleId}>` : null;

  let relayChannel: TextChannel | null = null;
  let staffServerGuildId: string | null = null;

  const staffLink = await prisma.staffServerLink.findFirst({
    where: { mainGuildId: targetGuildId, enabled: true },
  });
  if (staffLink) {
    staffServerGuildId = staffLink.staffGuildId;
    const staffGuild = client.guilds.cache.get(staffLink.staffGuildId);
    if (staffLink.staffLogChannelId && staffGuild) {
      const ch = staffGuild.channels.cache.get(staffLink.staffLogChannelId);
      if (ch instanceof TextChannel) relayChannel = ch;
    }
  }

  if (!relayChannel) {
    const relayChannelId = (guildConfig as any).ticketDmRelayChannelId || guildConfig.ticketLogChannelId;
    if (relayChannelId) {
      const fetched = await client.channels.fetch(relayChannelId).catch(() => null);
      if (fetched instanceof TextChannel) relayChannel = fetched;
    }
  }

  if (!relayChannel) {
    await interaction.editReply({ content: '❌ Aucun salon de relais configuré sur ce serveur.' });
    return;
  }

  const ticket = await prisma.ticket.create({
    data: {
      guildId: targetGuildId,
      mode: 'DM',
      ticketTypeId: null,
      ticketTypeLabel: 'MP Direct',
      staffRoleId: ticketStaffRoleId,
      categoryId: null,
      userId: user.id,
      username: user.username,
      reason,
      description,
      status: 'OPEN',
      staffServerGuildId,
    },
  });

  const thread = await relayChannel.threads.create({
    name: `🎫 ${user.username} - ${reason}`.slice(0, 100),
    autoArchiveDuration: 10080,
    reason: `Ticket DM direct de ${user.username}`,
  });

  await prisma.ticket.update({ where: { id: ticket.id }, data: { threadId: thread.id } });

  const staffEmbed = new EmbedBuilder()
    .setTitle(`🎫 Nouveau Ticket MP · MP Direct`)
    .setDescription(
      `**Créateur :** <@${user.id}> (${user.username})\n` +
      `**Raison :** ${reason}\n\n` +
      `**Description :**\n${description}\n\n` +
      `> Les messages envoyés ici seront relayés en MP à l'utilisateur.`,
    )
    .setColor(COLORS.primary as any)
    .setTimestamp()
    .setFooter({ text: `Kotbo · Ticket ID: ${ticket.id}` });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`ticket:claim:${ticket.id}`).setLabel('Prendre en charge').setStyle(ButtonStyle.Primary).setEmoji('🛠️'),
    new ButtonBuilder().setCustomId(`ticket:info:${ticket.id}`).setLabel('Infos Membre').setStyle(ButtonStyle.Secondary).setEmoji('🔍'),
    new ButtonBuilder().setCustomId(`ticket:macros:${ticket.id}`).setLabel('Macros').setStyle(ButtonStyle.Secondary).setEmoji('⚡'),
    new ButtonBuilder().setCustomId(`ticket:close:${ticket.id}`).setLabel('Fermer').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
  );

  if (staffMention) await thread.send({ content: staffMention, allowedMentions: { roles: ticketStaffRoleId ? [ticketStaffRoleId] : [] } });
  await thread.send({ embeds: [staffEmbed], components: [row] });

  const dmEmbed = new EmbedBuilder()
    .setTitle(`🎫 Ticket ouvert · ${guild.name}`)
    .setDescription(
      `Votre ticket d'assistance a bien été créé !\n` +
      `Le personnel va prendre en charge votre demande. **Répondez directement ici** pour communiquer avec le staff.\n\n` +
      `**Raison :** ${reason}\n**Description :** ${description}`,
    )
    .setColor(COLORS.primary as any)
    .setTimestamp()
    .setFooter({ text: `Kotbo · Ticket ID: ${ticket.id}` });

  try {
    await user.send({ embeds: [dmEmbed], allowedMentions: { parse: [] } });
  } catch {
    await thread.send({
      embeds: [errorEmbed('MP bloqués', `<@${user.id}> a ses messages privés désactivés.`)],
      allowedMentions: { parse: [] },
    });
  }

  await logTicketEvent(client, guildConfig, 'OPENED', ticket, user);
  await handleTicketTrigger(targetGuildId, user.id, null, reason, description, client, ticket.id);
  await interaction.editReply({ content: `✅ Votre ticket a été créé sur **${guild.name}** ! Consultez vos messages privés.` });
}

/**
 * Relays a DM message from a ticket creator to the staff thread.
 */
export async function relayDmToThread(client: Client, message: Message): Promise<void> {
  if (message.author.bot || message.guild) return;

  const ticket = await prisma.ticket.findFirst({
    where: {
      userId: message.author.id,
      mode: 'DM',
      status: { in: ['OPEN', 'CLAIMED'] },
      threadId: { not: null }
    },
    orderBy: { createdAt: 'desc' }
  });
  if (!ticket || !ticket.threadId) return;

  try {
    const thread = await client.channels.fetch(ticket.threadId).catch(() => null);
    if (!thread || !thread.isThread()) return;

    const authorName = ticket.isAnonymous ? 'Membre Anonyme' : message.author.username;
    const authorIcon = ticket.isAnonymous ? undefined : message.author.displayAvatarURL();

    const relayEmbed = new EmbedBuilder()
      .setAuthor({ name: authorName, ...(authorIcon ? { iconURL: authorIcon } : {}) })
      .setDescription(message.content || '*Pièce jointe*')
      .setColor(COLORS.primary as any)
      .setTimestamp();

    const files = message.attachments.map(a => a.url);
    await (thread as ThreadChannel).send({ embeds: [relayEmbed], files, allowedMentions: { parse: [] } });

    await message.react('✅').catch(() => null);
  } catch (err) {
    logger.error('Ticket', 'Error relaying DM to thread:', err);
  }
}

/**
 * Relays a staff thread message to the DM ticket creator.
 */
export async function relayThreadToDm(client: Client, message: Message): Promise<void> {
  if (message.author.bot || !message.channel.isThread()) return;

  const ticket = await prisma.ticket.findFirst({
    where: {
      threadId: message.channel.id,
      mode: 'DM',
      status: { in: ['OPEN', 'CLAIMED'] }
    }
  });
  if (!ticket) return;

  try {
    const dmUser = await client.users.fetch(ticket.userId);
    if (!dmUser) return;

    const _guildConfig = await prisma.guild.findUnique({ where: { id: ticket.guildId } });
    const guildName = client.guilds.cache.get(ticket.guildId)?.name || 'Serveur';

    const relayEmbed = new EmbedBuilder()
      .setAuthor({ name: `${message.author.username} · ${guildName}`, iconURL: message.author.displayAvatarURL() })
      .setDescription(message.content || '*Pièce jointe*')
      .setColor(COLORS.primary as ColorResolvable)
      .setTimestamp()
      .setFooter({ text: `Ticket: ${ticket.reason}` });

    const files = message.attachments.map(a => a.url);
    await dmUser.send({ embeds: [relayEmbed], files, allowedMentions: { parse: [] } });
  } catch (err) {
    logger.error('Ticket', 'Error relaying thread to DM:', err);
  }
}

/**
 * Prend automatiquement en charge un ticket OPEN des qu'un membre du staff y
 * ecrit : evite l'oubli du bouton « Prendre en charge » avant d'intervenir.
 * Ne joue que sur la premiere prise en charge (statut OPEN) — une
 * sur-revendication reste un choix volontaire via le bouton dedie.
 */
export async function autoClaimTicketOnStaffMessage(client: Client, message: Message): Promise<void> {
  if (message.author.bot || !message.guildId || !message.member) return;

  const ticket = await prisma.ticket.findFirst({
    where: {
      guildId: message.guildId,
      status: 'OPEN',
      OR: [{ channelId: message.channelId }, { threadId: message.channelId }],
    },
  });
  if (!ticket || ticket.userId === message.author.id) return;

  const guildConfig = await prisma.guild.findUnique({ where: { id: message.guildId } });
  if (!guildConfig?.ticketAutoClaimOnReply) return;
  if (!canManageTicket(message.member, guildConfig, ticket.staffRoleId)) return;

  const staffLoad = await checkStaffTicketLoad({
    guildId: message.guildId,
    staffUserId: message.author.id,
    staffRoleIds: [...message.member.roles.cache.keys()],
    quotas: resolveTicketQuotas(guildConfig),
  });
  // BLOCK n'annule pas le message du staff, seulement la prise en charge
  // automatique : il devra fermer un de ses tickets avant de revendiquer celui-ci.
  if (staffLoad.exceeded && staffLoad.mode === 'BLOCK') return;

  const updatedTicket = await prisma.ticket.update({
    where: { id: ticket.id },
    data: { status: 'CLAIMED', claimedById: message.author.id, claimedByName: message.author.username },
  });

  if (ticket.lockUntilClaim) {
    await applyTicketLockState(client, ticket, guildConfig, false);
    await prisma.ticket.update({ where: { id: ticket.id }, data: { lockUntilClaim: false } });
  }

  try {
    const ticketChannel = message.channel as TextChannel | ThreadChannel;
    const welcomeMessage = await findTicketWelcomeMessage(ticketChannel, ticket.id);
    if (welcomeMessage) {
      const bodyText = `Ce ticket est actuellement pris en charge par <@${message.author.id}>.\n\n**Auteur :** <@${ticket.userId}>\n**Raison :** ${ticket.reason}\n**Description :** ${ticket.description}`;
      const updatedContainer = buildTicketStatusContainer(updatedTicket, bodyText, COLORS_RAW.warning);

      const allowOverclaim = guildConfig.ticketAllowOverclaim ?? true;
      const overclaimPermission = guildConfig.ticketOverclaimPermission || 'ANY';
      const componentsList: ButtonBuilder[] = [];
      if (allowOverclaim && overclaimPermission !== 'NONE') {
        componentsList.push(
          new ButtonBuilder().setCustomId(`ticket:claim:${ticket.id}`).setLabel('Sur-revendiquer').setStyle(ButtonStyle.Primary).setEmoji('🛠️')
        );
      }
      componentsList.push(
        new ButtonBuilder().setCustomId(`ticket:info:${ticket.id}`).setLabel('Infos Membre').setStyle(ButtonStyle.Secondary).setEmoji('🔍'),
        new ButtonBuilder().setCustomId(`ticket:macros:${ticket.id}`).setLabel('Macros').setStyle(ButtonStyle.Secondary).setEmoji('⚡'),
        new ButtonBuilder().setCustomId(`ticket:close:${ticket.id}`).setLabel('Fermer').setStyle(ButtonStyle.Danger).setEmoji('🔒')
      );

      await welcomeMessage.edit({
        components: [updatedContainer, new ActionRowBuilder<ButtonBuilder>().addComponents(componentsList)],
        flags: MessageFlags.IsComponentsV2,
        allowedMentions: { users: [message.author.id, ticket.userId] },
      });
    }

    await ticketChannel.send({
      embeds: [successEmbed('Pris en charge automatiquement', `Ce ticket est désormais pris en charge par <@${message.author.id}>, suite à son intervention.`)],
      allowedMentions: { users: [message.author.id] },
    });
  } catch (err) {
    logger.error('Ticket', 'Error updating welcome message after auto-claim:', err);
  }

  await logTicketEvent(client, guildConfig, 'CLAIMED', updatedTicket, message.author);
}

/**
 * Logs ticket events in the designated logs channel.
 */
export async function logTicketEvent(
  client: Client,
  guildConfig: Record<string, unknown>,
  action: 'OPENED' | 'CLAIMED' | 'CLOSED' | 'REOPENED' | 'DELETED' | 'RENAMED'
    | 'ARCHIVED' | 'UNARCHIVED' | 'LOCKED' | 'UNLOCKED',
  ticket: Record<string, unknown>,
  executor: { id: string; username?: string; tag?: string },
  transcriptLink?: string
): Promise<void> {
  if (ticket?.guildId && typeof ticket.guildId === 'string') {
    broadcastDashboardStateChange(ticket.guildId, 'tickets_updated');
  }

  const logChannelId = typeof guildConfig.ticketLogChannelId === 'string' ? guildConfig.ticketLogChannelId : null;
  if (!logChannelId) return;

  const logChannel = client.channels.cache.get(logChannelId);
  if (!logChannel || !(logChannel instanceof TextChannel)) return;

  const embed = new EmbedBuilder()
    .setTimestamp()
    .setFooter({ text: `Kotbo · Ticket ID: ${ticket.id}` });

  switch (action) {
    case 'OPENED':
      embed
        .setTitle('🎫 Nouveau Ticket Créé')
        .setDescription(`Le ticket <#${ticket.channelId}> a été ouvert.`)
        .setColor(COLORS.success as ColorResolvable)
        .addFields([
          { name: 'Type', value: String(ticket.ticketTypeLabel ?? ticket.ticketTypeId ?? 'Ticket standard'), inline: true },
          { name: 'Créateur', value: `<@${ticket.userId}> (${ticket.username})`, inline: true },
          { name: 'Raison', value: String(ticket.reason ?? '-'), inline: true },
          { name: 'Description', value: String(ticket.description ?? '-') }
        ]);
      break;

    case 'CLAIMED':
      embed
        .setTitle('🛠️ Ticket Pris en Charge')
        .setDescription(`Le ticket <#${ticket.channelId}> a été pris en charge par <@${executor.id}>.`)
        .setColor(COLORS.warning as ColorResolvable)
        .addFields([
          { name: 'Créateur', value: `<@${ticket.userId}>`, inline: true },
          { name: 'Staff', value: `<@${executor.id}>`, inline: true }
        ]);
      break;

    case 'CLOSED':
      embed
        .setTitle('🔒 Ticket Fermé')
        .setDescription(`Le ticket <#${ticket.channelId}> a été fermé par <@${executor.id}>.`)
        .setColor(COLORS.danger as ColorResolvable)
        .addFields([
          { name: 'Créateur', value: `<@${ticket.userId}>`, inline: true },
          { name: 'Fermé par', value: `<@${executor.id}>`, inline: true }
        ]);
      break;

    case 'REOPENED':
      embed
        .setTitle('🔓 Ticket Réouvert')
        .setDescription(`Le ticket <#${ticket.channelId}> a été réouvert par <@${executor.id}>.`)
        .setColor(COLORS.primary as ColorResolvable)
        .addFields([
          { name: 'Créateur', value: `<@${ticket.userId}>`, inline: true },
          { name: 'Réouvert par', value: `<@${executor.id}>`, inline: true }
        ]);
      break;

    case 'DELETED':
      embed
        .setTitle('🗑️ Ticket Supprimé')
        .setDescription(`Le ticket ouvert par **${ticket.username}** a été définitivement supprimé par <@${executor.id}>.`)
        .setColor(0x000000)
        .addFields([
          { name: 'Créateur', value: `<@${ticket.userId}>`, inline: true },
          { name: 'Supprimé par', value: `<@${executor.id}>`, inline: true }
        ]);

      if (transcriptLink) {
        embed.addFields([{ name: 'Transcription publique', value: `🌐 [Consulter le transcript](${transcriptLink})` }]);
      }
      break;

    case 'ARCHIVED':
      embed
        .setTitle('📦 Ticket Archivé')
        .setDescription(`Le ticket de **${ticket.username}** a été archivé par <@${executor.id}>. Le salon est conservé en lecture seule.`)
        .setColor(COLORS.warning as ColorResolvable)
        .addFields([
          { name: 'Créateur', value: `<@${ticket.userId}>`, inline: true },
          { name: 'Archivé par', value: `<@${executor.id}>`, inline: true },
        ]);
      if (transcriptLink) {
        embed.addFields([{ name: 'Transcription', value: `🌐 [Consulter le transcript](${transcriptLink})` }]);
      }
      break;

    case 'UNARCHIVED':
      embed
        .setTitle('📤 Ticket Désarchivé')
        .setDescription(`Le ticket de **${ticket.username}** a été sorti des archives par <@${executor.id}>.`)
        .setColor(COLORS.primary as ColorResolvable)
        .addFields([
          { name: 'Créateur', value: `<@${ticket.userId}>`, inline: true },
          { name: 'Désarchivé par', value: `<@${executor.id}>`, inline: true },
        ]);
      break;

    case 'LOCKED':
      embed
        .setTitle('🔐 Ticket Verrouillé')
        .setDescription(`Le ticket de **${ticket.username}** est protégé contre la suppression par <@${executor.id}>.`)
        .setColor(COLORS.warning as ColorResolvable)
        .addFields([
          { name: 'Créateur', value: `<@${ticket.userId}>`, inline: true },
          { name: 'Verrouillé par', value: `<@${executor.id}>`, inline: true },
          { name: 'Échéance', value: transcriptLink || 'Sans échéance', inline: true },
        ]);
      break;

    case 'UNLOCKED':
      embed
        .setTitle('🔓 Verrou de suppression levé')
        .setDescription(`Le ticket de **${ticket.username}** peut de nouveau être supprimé. Verrou levé par <@${executor.id}>.`)
        .setColor(COLORS.primary as ColorResolvable)
        .addFields([
          { name: 'Créateur', value: `<@${ticket.userId}>`, inline: true },
          { name: 'Levé par', value: `<@${executor.id}>`, inline: true },
        ]);
      break;

    case 'RENAMED':
      embed
        .setTitle('✏️ Ticket Renommé')
        .setDescription(`Le ticket <#${ticket.channelId}> a été renommé en **#${transcriptLink || 'inconnu'}** par <@${executor.id}>.`)
        .setColor(COLORS.primary as ColorResolvable)
        .addFields([
          { name: 'Créateur', value: `<@${ticket.userId}>`, inline: true },
          { name: 'Renommé par', value: `<@${executor.id}>`, inline: true }
        ]);
      break;
  }

  try {
    await logChannel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  } catch (err) {
    logger.error('Ticket', 'Error sending to ticket log channel:', err);
  }
}

/**
 * Finds the initial welcome message of a ticket.
 */
export async function findTicketWelcomeMessage(
  channel: TextChannel | ThreadChannel,
  ticketId: string
): Promise<Message | null> {
  try {
    const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    if (!messages) return null;
    const marker = `Ticket ID: ${ticketId}`;

    return messages.find(msg => {
      if (!msg.author.bot) return false;

      for (const component of msg.components as unknown[]) {
        const c = component as { type: ComponentType; content?: string; components?: { type: ComponentType; content?: string }[] };
        if (c.type === ComponentType.TextDisplay && c.content?.includes(marker)) return true;
        if (c.type === ComponentType.Container && c.components) {
          for (const nested of c.components) {
            if (nested.type === ComponentType.TextDisplay && nested.content?.includes(marker)) return true;
          }
        }
      }
      return false;
    }) || null;
  } catch (err) {
    logger.error('Ticket', `Error finding welcome message for ticket ${ticketId}:`, err);
    return null;
  }
}

/**
 * Boutons proposés au staff sur un ticket clos. Recalculés à chaque changement
 * d'état plutôt que figés : le verrou et l'archivage se reflètent dans les
 * libellés, sinon un staff clique « Supprimer » sur un ticket protégé pour se
 * voir refuser sans avoir été prévenu.
 */
export function buildClosedTicketButtons(ticket: Ticket): ButtonBuilder[] {
  const lock = resolveDeletionLock(ticket);
  const buttons: ButtonBuilder[] = [
    new ButtonBuilder().setCustomId(`ticket:reopen:${ticket.id}`).setLabel('Réouvrir').setStyle(ButtonStyle.Success).setEmoji('🔓'),
  ];

  buttons.push(ticket.status === 'ARCHIVED'
    ? new ButtonBuilder().setCustomId(`ticket:unarchive:${ticket.id}`).setLabel('Désarchiver').setStyle(ButtonStyle.Primary).setEmoji('📤')
    : new ButtonBuilder().setCustomId(`ticket:archive:${ticket.id}`).setLabel('Archiver').setStyle(ButtonStyle.Secondary).setEmoji('📦'));

  buttons.push(
    lock.locked
      ? new ButtonBuilder().setCustomId(`ticket:unlock:${ticket.id}`).setLabel('Déverrouiller').setStyle(ButtonStyle.Secondary).setEmoji('🔓')
      : new ButtonBuilder().setCustomId(`ticket:lock:${ticket.id}`).setLabel('Verrouiller').setStyle(ButtonStyle.Secondary).setEmoji('🔐'),
    // Le bouton reste visible mais inerte sous verrou : le masquer laisserait
    // croire que la suppression n'existe pas sur ce ticket.
    new ButtonBuilder().setCustomId(`ticket:delete:${ticket.id}`).setLabel('Supprimer').setStyle(ButtonStyle.Danger).setEmoji('🗑️').setDisabled(lock.locked),
  );

  return buttons;
}

/**
 * Remet à jour la barre de boutons du message de fermeture après un changement
 * d'état (verrou posé ou levé, archivage).
 *
 * Le message est retrouvé par le `customId` de son bouton de suppression :
 * c'est le seul repère stable, le salon pouvant contenir plusieurs messages du
 * bot depuis la fermeture. Un échec est silencieux - les gardes réévaluent
 * l'état à chaque clic, un bouton périmé ne fait donc rien passer en force.
 */
async function refreshClosedTicketButtons(client: Client, ticket: Ticket): Promise<void> {
  const channelId = ticket.channelId ?? ticket.threadId;
  if (!channelId) return;

  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!(channel instanceof TextChannel) && !channel?.isThread()) return;

    const messages = await (channel as TextChannel).messages.fetch({ limit: 30 }).catch(() => null);
    if (!messages) return;

    const marker = `ticket:delete:${ticket.id}`;
    const target = messages.find((msg) => msg.author.id === client.user?.id
      && msg.components.some((row: any) => row.type === ComponentType.ActionRow
        && row.components.some((c: any) => c.type === ComponentType.Button && c.customId === marker)));
    if (!target) return;

    await target.edit({
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buildClosedTicketButtons(ticket))],
    });
  } catch (err) {
    logger.warn('Ticket', `Boutons de fermeture non rafraîchis pour ${ticket.id}: ${String(err)}`);
  }
}

export async function closeTicket(
  client: Client,
  ticketId: string,
  closedByUserId: string,
  closedByUsername: string
): Promise<any> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId }
  });
  if (!ticket || ticket.status === 'CLOSED') return ticket || null;

  const guildConfig = await prisma.guild.findUnique({
    where: { id: ticket.guildId }
  });
  if (!guildConfig) return null;

  // Mettre à jour en BDD
  const updatedTicket = await prisma.ticket.update({
    where: { id: ticketId },
    data: {
      status: 'CLOSED',
      closedById: closedByUserId,
      closedByName: closedByUsername,
      closedAt: new Date()
    }
  });

  const channelId = ticket.channelId || ticket.threadId;
  if (channelId) {
    const channel = client.channels.cache.get(channelId) || await client.channels.fetch(channelId).catch(() => null);
    if (channel && (channel instanceof TextChannel || channel.isThread())) {
      const ticketChannel = channel as TextChannel;
      // Rename channel
      await renameChannelToClosed(client, ticketChannel.id).catch(() => null);

      // Retirer les permissions d'écriture et lecture de l'opener
      try {
        if (ticketChannel.permissionOverwrites && typeof ticketChannel.permissionOverwrites.edit === 'function') {
          await ticketChannel.permissionOverwrites.edit(ticket.userId, {
            ViewChannel: false,
            SendMessages: false
          });
        }
      } catch (err) {
        logger.error('Ticket', 'Error removing opener permissions from closed channel:', err);
      }

      // Mettre à jour le container V2 du message de bienvenue s'il existe
      try {
        const welcomeMessage = await findTicketWelcomeMessage(ticketChannel, ticketId);
        if (welcomeMessage) {
          const bodyText = `Ce ticket a été fermé par <@${closedByUserId}>.\n\n**Auteur :** <@${ticket.userId}>\n**Raison :** ${ticket.reason}\n**Description :** ${ticket.description}`;
          const updatedContainer = buildTicketStatusContainer(ticket, bodyText, COLORS_RAW.danger);

          // Disable all button components carried over from the original message
          const disabledRows = welcomeMessage.components
            .filter((component: any) => component.type === ComponentType.ActionRow)
            .map((actionRow: any) => {
              const newRow = new ActionRowBuilder<ButtonBuilder>();
              for (const comp of actionRow.components) {
                if (comp.type === ComponentType.Button) {
                  newRow.addComponents(ButtonBuilder.from(comp as any).setDisabled(true));
                }
              }
              return newRow;
            })
            .filter((row: ActionRowBuilder<ButtonBuilder>) => row.components.length > 0);

          await welcomeMessage.edit({
            components: [updatedContainer, ...disabledRows],
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: { users: [closedByUserId, ticket.userId] },
          }).catch(() => null);
        }
      } catch (err) {
        logger.error('Ticket', 'Error updating welcome message container on close:', err);
      }

      const closeEmbed = new EmbedBuilder()
        .setTitle('🔒 Ticket Fermé')
        .setDescription(`Le ticket a été fermé par <@${closedByUserId}>.\n\nLe personnel peut le réouvrir, l'archiver en lecture seule sans rien perdre, le protéger contre la suppression, ou le supprimer définitivement.`)
        .setColor(COLORS.danger as ColorResolvable)
        .setTimestamp();

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...buildClosedTicketButtons(updatedTicket));

      await ticketChannel.send({ embeds: [closeEmbed], components: [row], allowedMentions: { users: [closedByUserId] } }).catch(() => null);
    }
  }

  // Logger
  await logTicketEvent(client, guildConfig, 'CLOSED', updatedTicket, { id: closedByUserId, username: closedByUsername });

  // Satisfaction survey
  try {
    const { sendSatisfactionSurvey } = await import('./ticketSatisfactionService.js');
    await sendSatisfactionSurvey(client, ticket.guildId, ticketId, ticket.userId, ticket.claimedById ?? undefined);
  } catch (err) {
    logger.error('Ticket', 'Erreur envoi sondage satisfaction:', err);
  }

  return updatedTicket;
}

export async function renameChannelToClosed(client: Client, channelId: string): Promise<void> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (channel && channel instanceof TextChannel) {
    const currentName = channel.name;
    const newName = currentName.startsWith('ticket-') ? currentName.replace(/^ticket-/, 'fermer-') : `fermer-${currentName}`;
    if (newName !== currentName) {
      await channel.setName(newName, 'Ticket fermé').catch((err) => 
        logger.error('Ticket', `Error renaming channel ${channelId} to closed:`, err)
      );
    }
  }
}

export async function renameChannelToOpen(client: Client, channelId: string): Promise<void> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (channel && channel instanceof TextChannel) {
    const currentName = channel.name;
    const newName = currentName.startsWith('fermer-') ? currentName.replace(/^fermer-/, 'ticket-') : `ticket-${currentName}`;
    if (newName !== currentName) {
      await channel.setName(newName, 'Ticket réouvert').catch((err) => 
        logger.error('Ticket', `Error renaming channel ${channelId} to open:`, err)
      );
    }
  }
}

/**
 * Checks open tickets for inactivity and sends automated warnings if configured.
 */
export async function checkTicketInactivity(client: Client): Promise<void> {
  try {
    const guilds = await prisma.guild.findMany({
      where: { ticketInactivityEnabled: true },
      select: {
        id: true,
        ticketInactivityHours: true,
        ticketInactivityMessage: true,
      },
    });

    for (const guildConfig of guilds) {
      // La relance d'inactivité continuerait de tomber dans des tickets d'un
      // serveur qui a éteint le module.
      if (!(await isModuleEnabled(guildConfig.id, 'tickets'))) continue;

      const activeTickets = await prisma.ticket.findMany({
        where: {
          guildId: guildConfig.id,
          status: { in: ['OPEN', 'CLAIMED'] },
          channelId: { not: null },
          inactivityAlertSent: false,
        },
      });

      const inactivityTimeMs = guildConfig.ticketInactivityHours * 60 * 60 * 1000;

      // Resolue une fois par serveur, et avec la langue declaree du serveur
      // Discord : sans elle, la cascade saute a son repli qui est l'anglais, et
      // un serveur francais reste en detection automatique recevrait une
      // relance anglaise au milieu de messages francais.
      const discordGuild = client.guilds.cache.get(guildConfig.id);
      const locale = await resolveGuildLocale(guildConfig.id, discordGuild?.preferredLocale ?? null);

      for (const ticket of activeTickets) {
        if (!ticket.channelId) continue;

        const channel = await client.channels.fetch(ticket.channelId).catch(() => null);
        if (!channel || !(channel instanceof TextChannel)) continue;

        const messages = await channel.messages.fetch({ limit: 1 }).catch(() => null);
        const lastMessage = messages?.first();

        let lastActivityTimestamp = ticket.createdAt.getTime();
        let shouldAlert = false;

        if (lastMessage) {
          // Si le dernier message a été envoyé par le créateur, on n'alerte pas
          if (lastMessage.author.id === ticket.userId) {
            continue;
          }
          lastActivityTimestamp = lastMessage.createdTimestamp;
        }

        if (Date.now() - lastActivityTimestamp > inactivityTimeMs) {
          shouldAlert = true;
        }

        if (shouldAlert) {
          // Formater le message d'inactivité
          const userMention = `<@${ticket.userId}>`;
          const rawMessage = guildConfig.ticketInactivityMessage?.trim()
            || ticketDefaultTexts(locale).ticketInactivityMessage;
          const formattedMessage = rawMessage.replace(/{user}/g, userMention);

          await channel.send({ content: formattedMessage }).catch(() => null);

          await prisma.ticket.update({
            where: { id: ticket.id },
            data: { inactivityAlertSent: true },
          });

          logger.info('Ticket', `Alerte d'inactivité envoyée dans le ticket ${ticket.id} (${ticket.channelId})`);
        }
      }
    }
  } catch (err) {
    logger.error('Ticket', "Erreur lors de la vérification de l'inactivité des tickets:", err);
  }
}

async function setupInteractiveTicketQuestions(
  client: Client,
  channel: any,
  userId: string,
  ticketType: any,
  guildConfig: any
): Promise<void> {
  // Un type qui ouvre sans formulaire ne doit rien demander non plus ici.
  const isFormEnabled = (ticketType as any)?.formEnabled !== undefined
    ? (ticketType as any).formEnabled
    : (guildConfig?.ticketFormEnabled !== undefined ? guildConfig.ticketFormEnabled : true);
  if (isFormEnabled === false) return;

  const postFields = resolveCustomFormFields(ticketType, guildConfig).filter(
    (f: any) => INTERACTIVE_FIELD_STYLES.has(f.style) && typeof f.label === 'string' && f.label.trim().length > 0,
  );
  if (postFields.length === 0) return;

  for (const f of postFields) {
    try {
      if (f.style === 'SELECT') {
        const choices = Array.isArray(f.choices) ? f.choices : [];
        if (choices.length === 0) continue;

        const select = new StringSelectMenuBuilder()
          .setCustomId(`ticket:question:select:${f.id}`)
          .setPlaceholder(f.placeholder || 'Sélectionnez une option...')
          .addOptions(choices.map((c: string) => ({ label: c.substring(0, 100), value: c })));

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
        const msg = await channel.send({
          content: `<@${userId}> ❓ **${f.label}**`,
          components: [row]
        });

        const filter = (i: any) => i.customId === `ticket:question:select:${f.id}` && i.user.id === userId;
        const collected = await msg.awaitMessageComponent({ filter, time: 300000 }).catch(() => null);

        if (collected && collected.isStringSelectMenu()) {
          const value = collected.values[0];
          await collected.update({
            content: `✅ **${f.label}** : **${value}**`,
            components: []
          });
        } else {
          await msg.edit({
            content: `❌ **${f.label}** (Pas de réponse)`,
            components: []
          }).catch(() => null);
        }
      } else if (f.style === 'RADIO') {
        const choices = Array.isArray(f.choices) ? f.choices : [];
        if (choices.length === 0) continue;

        const buttons = choices.slice(0, 5).map((c: string, idx: number) => {
          return new ButtonBuilder()
            .setCustomId(`ticket:question:radio:${f.id}:${idx}`)
            .setLabel(c.substring(0, 80))
            .setStyle(ButtonStyle.Secondary);
        });

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
        const msg = await channel.send({
          content: `<@${userId}> ❓ **${f.label}**`,
          components: [row]
        });

        const filter = (i: any) => i.customId.startsWith(`ticket:question:radio:${f.id}:`) && i.user.id === userId;
        const collected = await msg.awaitMessageComponent({ filter, time: 300000 }).catch(() => null);

        if (collected && collected.isButton()) {
          const clickedLabel = choices[parseInt(collected.customId.split(':')[4])];
          await collected.update({
            content: `✅ **${f.label}** : **${clickedLabel}**`,
            components: []
          });
        } else {
          await msg.edit({
            content: `❌ **${f.label}** (Pas de réponse)`,
            components: []
          }).catch(() => null);
        }
      } else if (f.style === 'FILE') {
        const msg = await channel.send({
          content: `<@${userId}> 📎 **${f.label}** : Veuillez glisser-déposer votre fichier ou image dans ce salon.`
        });

        const filter = (candidate: Message) => candidate.author.id === userId && candidate.attachments.size > 0;
        const collected = await channel.awaitMessages({ filter, max: 1, time: 300000 }).catch(() => null);

        if (collected && collected.first()) {
          const firstMsg = collected.first()!;
          const attachment = firstMsg.attachments.first()!;
          await msg.edit({
            content: `✅ **${f.label}** : Fichier joint reçu [${attachment.name}](${attachment.url})`
          });
        } else {
          await msg.edit({
            content: `❌ **${f.label}** (Pas de fichier reçu)`
          }).catch(() => null);
        }
      }
    } catch (err) {
      logger.error('Ticket', 'Error rendering interactive question:', err);
    }
  }
}

