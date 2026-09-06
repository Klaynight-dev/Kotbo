import type { Ticket } from '@prisma/client';
import type { ColorResolvable, OverwriteResolvable } from 'discord.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type Client,
  EmbedBuilder,
  PermissionFlagsBits,
  TextChannel,
} from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { COLORS } from '../../utils/embeds.js';
import { broadcastDashboardStateChange } from '../../api/shared/sharding.js';
import { generateTranscript, parseTranscriptHtml } from './transcriptService.js';

/**
 * Cycle de vie d'un ticket au-dela de « ouvert / ferme » : rangement en
 * archives, verrou anti-suppression, et remise en service depuis une
 * transcription.
 *
 * Ces trois operations sont declenchees depuis trois surfaces (boutons Discord,
 * commande `/ticket`, API dashboard). Les regrouper ici evite que chacune
 * reimplemente ses propres garde-fous - la limite de restauration, notamment,
 * ne vivait que dans la route dashboard et n'existait donc pas cote Discord.
 */

export type TicketActor = { id: string; username: string };

// ─────────────────────────────────────────────────────────────
// Verrou anti-suppression
// ─────────────────────────────────────────────────────────────

export type DeletionLockState = {
  locked: boolean;
  /** `null` quand le verrou n'a pas d'echeance. */
  until: Date | null;
  reason: string | null;
  byId: string | null;
  byName: string | null;
};

/**
 * Etat reel du verrou, echeance comprise.
 *
 * Un verrou expire est traite comme absent sans attendre qu'une tache de fond
 * le nettoie : la date fait foi, le drapeau n'est qu'un cache.
 */
export function resolveDeletionLock(ticket: Pick<Ticket,
  'deletionLocked' | 'deletionLockedUntil' | 'deletionLockReason' | 'deletionLockedById' | 'deletionLockedByName'
>): DeletionLockState {
  const until = ticket.deletionLockedUntil ? new Date(ticket.deletionLockedUntil) : null;
  const expired = until !== null && until.getTime() <= Date.now();
  return {
    locked: ticket.deletionLocked && !expired,
    until,
    reason: ticket.deletionLockReason ?? null,
    byId: ticket.deletionLockedById ?? null,
    byName: ticket.deletionLockedByName ?? null,
  };
}

/** Message affiche a qui tente une suppression bloquee. */
export function deletionLockMessage(lock: DeletionLockState): string {
  const holder = lock.byId ? `<@${lock.byId}>` : (lock.byName ?? 'le staff');
  const until = lock.until
    ? ` jusqu'au <t:${Math.floor(lock.until.getTime() / 1000)}:f>`
    : ' sans echeance';
  const reason = lock.reason ? `\n**Motif :** ${lock.reason}` : '';
  return `🔐 Ce ticket est verrouille contre la suppression par ${holder}${until}.${reason}\n\nDeverrouillez-le d'abord si la suppression est bien voulue.`;
}

export async function lockTicketDeletion(
  ticketId: string,
  actor: TicketActor,
  options: { durationMs?: number | null; reason?: string | null } = {},
): Promise<Ticket> {
  const until = options.durationMs && options.durationMs > 0
    ? new Date(Date.now() + options.durationMs)
    : null;
  const updated = await prisma.ticket.update({
    where: { id: ticketId },
    data: {
      deletionLocked: true,
      deletionLockedUntil: until,
      deletionLockedById: actor.id,
      deletionLockedByName: actor.username,
      deletionLockReason: options.reason?.trim() || null,
    },
  });
  broadcastDashboardStateChange(updated.guildId, 'tickets_updated');
  return updated;
}

export async function unlockTicketDeletion(ticketId: string): Promise<Ticket> {
  const updated = await prisma.ticket.update({
    where: { id: ticketId },
    data: {
      deletionLocked: false,
      deletionLockedUntil: null,
      deletionLockedById: null,
      deletionLockedByName: null,
      deletionLockReason: null,
    },
  });
  broadcastDashboardStateChange(updated.guildId, 'tickets_updated');
  return updated;
}

/** Durees proposees dans le selecteur de verrou, en millisecondes. */
export const DELETION_LOCK_DURATIONS: { value: string; label: string; ms: number | null }[] = [
  { value: '7d', label: '7 jours', ms: 7 * 24 * 60 * 60 * 1000 },
  { value: '30d', label: '30 jours', ms: 30 * 24 * 60 * 60 * 1000 },
  { value: '90d', label: '90 jours', ms: 90 * 24 * 60 * 60 * 1000 },
  { value: 'permanent', label: 'Sans echeance', ms: null },
];

export function resolveLockDuration(value: string): number | null {
  return DELETION_LOCK_DURATIONS.find((d) => d.value === value)?.ms ?? null;
}

// ─────────────────────────────────────────────────────────────
// Archivage
// ─────────────────────────────────────────────────────────────

/**
 * Permissions d'un salon archive : tout le monde perd la parole, le staff garde
 * la lecture. L'auteur ne conserve la sienne que si le serveur le veut bien -
 * une archive sert souvent a garder une trace hors de sa vue.
 */
function buildArchivePermissionOverwrites(
  guild: { roles: { everyone: { id: string } } },
  ticket: Ticket,
  guildConfig: { ticketStaffRoleId: string | null; moderatorRoleId: string | null; ticketArchiveKeepOpenerView: boolean },
): OverwriteResolvable[] {
  const readOnly = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
  const overwrites: OverwriteResolvable[] = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
    {
      id: ticket.userId,
      allow: guildConfig.ticketArchiveKeepOpenerView ? readOnly : [],
      deny: guildConfig.ticketArchiveKeepOpenerView
        ? [PermissionFlagsBits.SendMessages]
        : [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages],
    },
  ];

  const staffRoleId = ticket.staffRoleId || guildConfig.ticketStaffRoleId;
  if (staffRoleId) {
    overwrites.push({ id: staffRoleId, allow: readOnly, deny: [PermissionFlagsBits.SendMessages] });
  }
  if (guildConfig.moderatorRoleId && guildConfig.moderatorRoleId !== staffRoleId) {
    overwrites.push({ id: guildConfig.moderatorRoleId, allow: readOnly, deny: [PermissionFlagsBits.SendMessages] });
  }
  return overwrites;
}

function archivedChannelName(current: string): string {
  const base = current.replace(/^(ticket|fermer|archive)-/, '');
  return `archive-${base}`.slice(0, 100);
}

function activeChannelName(current: string): string {
  const base = current.replace(/^(ticket|fermer|archive)-/, '');
  return `fermer-${base}`.slice(0, 100);
}

export type ArchiveResult = {
  ticket: Ticket;
  transcriptId: string | null;
  /** `null` quand le salon n'existait plus : le ticket est archive quand meme. */
  channelId: string | null;
};

/**
 * Range un ticket sans rien detruire : transcription figee, salon verrouille en
 * lecture seule et deplace dans la categorie d'archives quand elle est
 * configuree.
 *
 * La categorie d'origine est memorisee pour que le desarchivage remette le
 * salon exactement d'ou il vient, et pas dans la categorie tickets par defaut.
 */
export async function archiveTicket(
  client: Client,
  ticketId: string,
  actor: TicketActor,
): Promise<ArchiveResult> {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new Error('Ticket introuvable.');
  if (ticket.status === 'ARCHIVED') throw new Error('Ce ticket est deja archive.');
  if (ticket.status === 'PENDING' || ticket.status === 'REJECTED') {
    throw new Error("Une demande qui n'a jamais donne lieu a un salon ne s'archive pas.");
  }

  const guildConfig = await prisma.guild.findUnique({ where: { id: ticket.guildId } });
  if (!guildConfig) throw new Error('Configuration du serveur introuvable.');

  const channelId = ticket.channelId ?? ticket.threadId;
  const channel = channelId
    ? await client.channels.fetch(channelId).catch(() => null)
    : null;

  let transcriptId = ticket.transcriptId;
  let fromCategoryId: string | null = null;

  if (channel instanceof TextChannel) {
    // La transcription est refaite a l'archivage : le salon a pu vivre apres sa
    // fermeture, et une archive doit refleter son dernier etat.
    try {
      const transcript = await generateTranscript(channel);
      transcriptId = transcript.id;
    } catch (err) {
      logger.error('Ticket', `Archivage : transcription impossible pour ${ticketId}:`, err);
    }

    fromCategoryId = channel.parentId ?? null;

    try {
      await channel.permissionOverwrites.set(
        buildArchivePermissionOverwrites(channel.guild, ticket, {
          ticketStaffRoleId: guildConfig.ticketStaffRoleId,
          moderatorRoleId: guildConfig.moderatorRoleId,
          ticketArchiveKeepOpenerView: guildConfig.ticketArchiveKeepOpenerView,
        }),
        `Ticket archive par ${actor.username}`,
      );
    } catch (err) {
      logger.error('Ticket', `Archivage : permissions non appliquees sur ${channel.id}:`, err);
    }

    const archiveCategoryId = guildConfig.ticketArchiveCategoryId;
    if (archiveCategoryId && archiveCategoryId !== channel.parentId) {
      const category = await client.channels.fetch(archiveCategoryId).catch(() => null);
      if (category && category.type === ChannelType.GuildCategory) {
        // `lockPermissions: false` : les surcharges qu'on vient de poser priment
        // sur celles de la categorie d'accueil.
        await channel.setParent(category.id, { lockPermissions: false, reason: `Ticket archive par ${actor.username}` })
          .catch((err) => logger.error('Ticket', `Archivage : deplacement impossible pour ${channel.id}:`, err));
      } else {
        logger.warn('Ticket', `Categorie d'archives ${archiveCategoryId} introuvable sur ${ticket.guildId}.`);
      }
    }

    await channel.setName(archivedChannelName(channel.name), 'Ticket archive').catch(() => null);

    const embed = new EmbedBuilder()
      .setTitle('📦 Ticket archivé')
      .setDescription(
        `Ce ticket a été archivé par <@${actor.id}>.\n\n`
        + 'Le salon est conservé en lecture seule : rien n\'a été supprimé. '
        + 'Un membre du staff peut le désarchiver à tout moment.',
      )
      .setColor(COLORS.warning as ColorResolvable)
      .setTimestamp()
      .setFooter({ text: `Kotbo · Ticket ID: ${ticket.id}` });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`ticket:unarchive:${ticket.id}`).setLabel('Désarchiver').setStyle(ButtonStyle.Success).setEmoji('📤'),
    );

    await channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } }).catch(() => null);
  }

  const updated = await prisma.ticket.update({
    where: { id: ticketId },
    data: {
      status: 'ARCHIVED',
      transcriptId,
      archivedById: actor.id,
      archivedByName: actor.username,
      archivedAt: new Date(),
      archivedFromCategoryId: fromCategoryId,
      closedAt: ticket.closedAt ?? new Date(),
      closedById: ticket.closedById ?? actor.id,
      closedByName: ticket.closedByName ?? actor.username,
    },
  });

  broadcastDashboardStateChange(updated.guildId, 'tickets_updated');
  return { ticket: updated, transcriptId, channelId: channel instanceof TextChannel ? channel.id : null };
}

/**
 * Remet un ticket archive a sa place : categorie d'origine, nom de salon clos et
 * acces du staff retabli. Le ticket repart au statut `CLOSED`, pas `OPEN` : le
 * desarchivage rend le dossier manipulable, la reouverture reste un geste a
 * part.
 */
export async function unarchiveTicket(
  client: Client,
  ticketId: string,
  actor: TicketActor,
): Promise<Ticket> {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new Error('Ticket introuvable.');
  if (ticket.status !== 'ARCHIVED') throw new Error("Ce ticket n'est pas archive.");

  const guildConfig = await prisma.guild.findUnique({ where: { id: ticket.guildId } });
  if (!guildConfig) throw new Error('Configuration du serveur introuvable.');

  const channelId = ticket.channelId ?? ticket.threadId;
  const channel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;

  if (channel instanceof TextChannel) {
    const targetCategoryId = ticket.archivedFromCategoryId
      ?? ticket.categoryId
      ?? guildConfig.ticketCategoryId
      ?? null;
    if (targetCategoryId && targetCategoryId !== channel.parentId) {
      const category = await client.channels.fetch(targetCategoryId).catch(() => null);
      if (category && category.type === ChannelType.GuildCategory) {
        await channel.setParent(category.id, { lockPermissions: false, reason: `Ticket desarchive par ${actor.username}` })
          .catch(() => null);
      }
    }

    const staffRoleId = ticket.staffRoleId || guildConfig.ticketStaffRoleId;
    if (staffRoleId) {
      await channel.permissionOverwrites.edit(staffRoleId, {
        ViewChannel: true, SendMessages: true, ReadMessageHistory: true, EmbedLinks: true, AttachFiles: true,
      }).catch(() => null);
    }
    if (guildConfig.moderatorRoleId && guildConfig.moderatorRoleId !== staffRoleId) {
      await channel.permissionOverwrites.edit(guildConfig.moderatorRoleId, {
        ViewChannel: true, SendMessages: true, ReadMessageHistory: true, EmbedLinks: true, AttachFiles: true,
      }).catch(() => null);
    }

    await channel.setName(activeChannelName(channel.name), 'Ticket desarchive').catch(() => null);

    const embed = new EmbedBuilder()
      .setTitle('📤 Ticket désarchivé')
      .setDescription(`Ce ticket a été sorti des archives par <@${actor.id}>. Il est de nouveau manipulable par le staff.`)
      .setColor(COLORS.primary as ColorResolvable)
      .setTimestamp()
      .setFooter({ text: `Kotbo · Ticket ID: ${ticket.id}` });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`ticket:reopen:${ticket.id}`).setLabel('Réouvrir').setStyle(ButtonStyle.Success).setEmoji('🔓'),
      new ButtonBuilder().setCustomId(`ticket:archive:${ticket.id}`).setLabel('Archiver').setStyle(ButtonStyle.Secondary).setEmoji('📦'),
    );

    await channel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } }).catch(() => null);
  }

  const updated = await prisma.ticket.update({
    where: { id: ticketId },
    data: {
      status: 'CLOSED',
      archivedById: null,
      archivedByName: null,
      archivedAt: null,
      archivedFromCategoryId: null,
    },
  });
  broadcastDashboardStateChange(updated.guildId, 'tickets_updated');
  return updated;
}

// ─────────────────────────────────────────────────────────────
// Restauration depuis une transcription
// ─────────────────────────────────────────────────────────────

/**
 * Plafond de reouvertures applique quand le serveur n'en configure pas.
 *
 * Le quota `ticketQuotaReopenMax` le remplace des qu'il est actif ; cette
 * constante reste le repli des appelants qui n'ont pas la config sous la main.
 */
export const MAX_TICKET_RESTORES = 3;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;

/**
 * La deuxieme restauration attend un jour, la troisieme une semaine : une
 * reouverture doit rester un recours, pas un aller-retour permanent sur un
 * dossier clos.
 */
export function checkRestoreEligibility(
  ticket: Pick<Ticket, 'status' | 'transcriptId' | 'restoreCount' | 'lastRestoredAt'>,
  /** Plafond du serveur. `null` leve la limite de nombre ; les delais restent. */
  maxRestores: number | null = MAX_TICKET_RESTORES,
): { ok: true } | { ok: false; error: string } {
  if (ticket.status !== 'CLOSED' && ticket.status !== 'ARCHIVED') {
    return { ok: false, error: 'Seul un ticket fermé ou archivé peut être restauré.' };
  }
  if (!ticket.transcriptId) {
    return { ok: false, error: "Ce ticket n'a pas de transcription associée." };
  }

  const restoreCount = ticket.restoreCount ?? 0;
  if (maxRestores !== null && restoreCount >= maxRestores) {
    return { ok: false, error: `Ce ticket a atteint la limite maximale de restaurations (${maxRestores}).` };
  }

  const lastRestoredAt = ticket.lastRestoredAt ? new Date(ticket.lastRestoredAt).getTime() : null;
  if (restoreCount === 1 && lastRestoredAt) {
    const elapsed = Date.now() - lastRestoredAt;
    if (elapsed < ONE_DAY_MS) {
      const remaining = Math.ceil((ONE_DAY_MS - elapsed) / (60 * 60 * 1000));
      return { ok: false, error: `Deuxième restauration disponible dans ${remaining}h. Délai : 24h après la première restauration.` };
    }
  }
  if (restoreCount === 2 && lastRestoredAt) {
    const elapsed = Date.now() - lastRestoredAt;
    if (elapsed < ONE_WEEK_MS) {
      const remainingDays = Math.ceil((ONE_WEEK_MS - elapsed) / ONE_DAY_MS);
      return { ok: false, error: `Troisième restauration disponible dans ${remainingDays}j. Délai : 7 jours après la deuxième restauration.` };
    }
  }
  return { ok: true };
}

/** Quand la prochaine restauration redevient possible, ou `null` si tout de suite. */
export function nextRestoreAvailableAt(ticket: Pick<Ticket, 'restoreCount' | 'lastRestoredAt'>): Date | null {
  const restoreCount = ticket.restoreCount ?? 0;
  if (!ticket.lastRestoredAt) return null;
  const last = new Date(ticket.lastRestoredAt).getTime();
  if (restoreCount === 1) return new Date(last + ONE_DAY_MS);
  if (restoreCount === 2) return new Date(last + ONE_WEEK_MS);
  return null;
}

export type RestoreOrigin = 'DASHBOARD' | 'DISCORD' | 'MEMBER';

const RESTORE_ORIGIN_LABEL: Record<RestoreOrigin, string> = {
  DASHBOARD: 'depuis le Dashboard',
  DISCORD: 'depuis Discord',
  MEMBER: 'à la demande de son auteur',
};

/**
 * Recree le salon d'un ticket clos et y rejoue sa transcription via webhook.
 *
 * Extrait de la route dashboard pour que le bouton Discord applique exactement
 * les memes regles : deux implantations auraient diverge sur les quotas de
 * restauration, ce qui est precisement la limite qu'on cherche a tenir.
 */
export async function restoreTicketFromTranscript(
  client: Client,
  ticketId: string,
  actor: TicketActor,
  origin: RestoreOrigin = 'DISCORD',
): Promise<{ channelId: string; ticket: Ticket }> {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId } });
  if (!ticket) throw new Error('Ticket introuvable.');

  const eligibility = checkRestoreEligibility(ticket);
  if (!eligibility.ok) throw new Error(eligibility.error);

  const transcript = await prisma.transcript.findUnique({ where: { id: ticket.transcriptId! } });
  if (!transcript) throw new Error('Transcription introuvable.');

  const guildConfig = await prisma.guild.findUnique({ where: { id: ticket.guildId } });
  if (!guildConfig) throw new Error('Serveur introuvable.');

  const discordGuild = client.guilds.cache.get(ticket.guildId)
    ?? await client.guilds.fetch(ticket.guildId).catch(() => null);
  if (!discordGuild) throw new Error('Serveur Discord introuvable.');

  const categoryId = ticket.categoryId || guildConfig.ticketCategoryId || null;
  const ticketCategory = categoryId
    ? await client.channels.fetch(categoryId).catch(() => null)
    : null;
  const staffRoleId = ticket.staffRoleId || guildConfig.ticketStaffRoleId || null;

  const cleanedUsername = ticket.username.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'membre';
  const channelName = `ticket-${cleanedUsername}`.slice(0, 100);

  const memberPerms = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.AttachFiles,
  ];
  const permissionOverwrites: OverwriteResolvable[] = [
    { id: discordGuild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: ticket.userId, allow: memberPerms },
  ];
  if (staffRoleId) permissionOverwrites.push({ id: staffRoleId, allow: memberPerms });
  if (guildConfig.moderatorRoleId && guildConfig.moderatorRoleId !== staffRoleId) {
    permissionOverwrites.push({ id: guildConfig.moderatorRoleId, allow: memberPerms });
  }

  const ticketChannel = await discordGuild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: ticketCategory && ticketCategory.type === ChannelType.GuildCategory ? ticketCategory.id : undefined,
    topic: `Ticket restauré de ${ticket.username} - Raison : ${ticket.reason}`.slice(0, 1024),
    permissionOverwrites,
  });

  await replayTranscript(ticketChannel, transcript.html, actor);

  const restoreEmbed = new EmbedBuilder()
    .setTitle('🔄 Ticket Restauré')
    .setDescription(
      `Ce ticket a été réouvert par **${actor.username}** (<@${actor.id}>) ${RESTORE_ORIGIN_LABEL[origin]}.\n\n`
      + `**Raison d'origine :** ${ticket.reason}\n**Description :** ${ticket.description || 'Aucune'}`,
    )
    .setColor(COLORS.primary as ColorResolvable)
    .setTimestamp()
    .setFooter({ text: `Kotbo · Ticket ID: ${ticket.id} · Réouverture ${(ticket.restoreCount ?? 0) + 1}/${MAX_TICKET_RESTORES}` });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`ticket:claim:${ticket.id}`).setLabel('Prendre en charge').setStyle(ButtonStyle.Primary).setEmoji('🛠️'),
    new ButtonBuilder().setCustomId(`ticket:close:${ticket.id}`).setLabel('Fermer').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
  );
  await ticketChannel.send({ embeds: [restoreEmbed], components: [row], allowedMentions: { parse: [] } });

  const updated = await prisma.ticket.update({
    where: { id: ticketId },
    data: {
      channelId: ticketChannel.id,
      status: 'OPEN',
      restoreCount: (ticket.restoreCount ?? 0) + 1,
      lastRestoredAt: new Date(),
      claimedById: null,
      claimedByName: null,
      closedById: null,
      closedByName: null,
      closedAt: null,
      // Une restauration sort forcement le ticket des archives : le salon
      // d'archive n'est plus celui du ticket.
      archivedById: null,
      archivedByName: null,
      archivedAt: null,
      archivedFromCategoryId: null,
    },
  });

  if (guildConfig.ticketLogChannelId) {
    const logCh = await client.channels.fetch(guildConfig.ticketLogChannelId).catch(() => null);
    if (logCh instanceof TextChannel) {
      const logEmbed = new EmbedBuilder()
        .setTitle('🔄 Ticket Restauré')
        .setDescription(`Le ticket de **${ticket.username}** a été restauré ${RESTORE_ORIGIN_LABEL[origin]} par **${actor.username}**.`)
        .setColor(COLORS.primary as ColorResolvable)
        .addFields([
          { name: 'Créateur', value: `<@${ticket.userId}>`, inline: true },
          { name: 'Restauré par', value: `<@${actor.id}>`, inline: true },
          { name: 'Nouveau salon', value: `<#${ticketChannel.id}>`, inline: true },
        ])
        .setTimestamp()
        .setFooter({ text: `Kotbo · Ticket ID: ${ticket.id} · Réouverture ${updated.restoreCount}/${MAX_TICKET_RESTORES}` });
      await logCh.send({ embeds: [logEmbed], allowedMentions: { parse: [] } }).catch(() => null);
    }
  }

  broadcastDashboardStateChange(updated.guildId, 'tickets_updated');
  return { channelId: ticketChannel.id, ticket: updated };
}

/**
 * Rejoue une transcription dans un salon via un webhook ephemere, chaque message
 * repris sous le nom et l'avatar de son auteur d'origine.
 */
async function replayTranscript(channel: TextChannel, html: string, actor: TicketActor): Promise<void> {
  const parsedMessages = parseTranscriptHtml(html);
  if (parsedMessages.length === 0) return;

  const headerEmbed = new EmbedBuilder()
    .setTitle('📜 Historique restauré')
    .setDescription(
      `Ce ticket a été restauré depuis une transcription par **${actor.username}** (<@${actor.id}>).\n`
      + "Les messages ci-dessous sont une restitution de la conversation d'origine.",
    )
    .setColor(COLORS.primary as ColorResolvable)
    .setTimestamp();
  await channel.send({ embeds: [headerEmbed], allowedMentions: { parse: [] } });

  const webhook = await channel.createWebhook({ name: 'Kotbo Restore' });
  try {
    for (const msg of parsedMessages) {
      if (!msg.content && !msg.username && msg.embeds.length === 0 && msg.imageUrls.length === 0) continue;

      // Discord refuse un nom de webhook vide, au-dela de 80 caracteres, ou
      // contenant « clyde ».
      let webhookName = msg.username.slice(0, 80) || 'Utilisateur';
      if (/clyde/i.test(webhookName)) webhookName = webhookName.replace(/clyde/gi, 'C|yde');

      const discordEmbeds: EmbedBuilder[] = [];
      for (const e of msg.embeds) {
        const eb = new EmbedBuilder();
        if (e.color) {
          try { eb.setColor(e.color as ColorResolvable); } catch { /* couleur illisible : on garde l'embed sans */ }
        }
        if (e.authorName) eb.setAuthor({ name: e.authorName, iconURL: e.authorIconUrl || undefined, url: e.authorUrl || undefined });
        if (e.title) eb.setTitle(e.title.slice(0, 256));
        if (e.url) eb.setURL(e.url);
        if (e.description) eb.setDescription(e.description.slice(0, 4096));
        if (e.fields.length > 0) {
          eb.addFields(e.fields.slice(0, 25).map((f) => ({
            name: f.name.slice(0, 256) || '​',
            value: f.value.slice(0, 1024) || '​',
            inline: f.inline,
          })));
        }
        if (e.thumbnailUrl) eb.setThumbnail(e.thumbnailUrl);
        if (e.imageUrl) eb.setImage(e.imageUrl);
        if (e.footerText) eb.setFooter({ text: e.footerText.slice(0, 2048), iconURL: e.footerIconUrl || undefined });
        discordEmbeds.push(eb);
      }

      for (const imgUrl of msg.imageUrls) {
        if (discordEmbeds.length >= 10) break;
        discordEmbeds.push(new EmbedBuilder().setImage(imgUrl));
      }

      try {
        await webhook.send({
          content: msg.content
            ? msg.content.slice(0, 2000)
            : (discordEmbeds.length === 0 ? '*(message sans contenu texte)*' : undefined),
          username: `${webhookName} (historique)`,
          avatarURL: msg.avatarUrl || undefined,
          embeds: discordEmbeds.length > 0 ? discordEmbeds.slice(0, 10) : undefined,
          allowedMentions: { parse: [] },
        });
      } catch (sendErr) {
        logger.warn('Ticket', `Rejeu impossible pour un message de ${msg.username}: ${String(sendErr)}`);
      }
    }
  } finally {
    await webhook.delete('Restore terminé').catch(() => null);
  }
}
