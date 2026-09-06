import { errorMessage, errorStack } from '../../utils/errors.js';
import { 
  type OverwriteResolvable,
  Client, 
  ChannelType, 
  GuildScheduledEventPrivacyLevel, 
  GuildScheduledEventEntityType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { broadcastDashboardStateChange } from '../../api/shared/sharding.js';


import { getClient } from '../../utils/client.js';
import { formatGuildDateTime, formatInTimezone } from '../../utils/timezone.js';

type AbsenceMutableStatus = 'PENDING' | 'ACKNOWLEDGED' | 'APPROVED' | 'REJECTED' | 'CANCELED' | 'ENDED';

export const getAbsences = async (guildId: string) => {
  const absences = await prisma.staffAbsence.findMany({
    where: { guildId },
    include: { staffMember: true },
    orderBy: { startDate: 'desc' },
  });

  // Fetch unique superior IDs (Discord IDs)
  const superiorUserIds = [...new Set(absences.map(a => a.superiorUserId).filter(Boolean))] as string[];

  if (superiorUserIds.length === 0) return absences;

  // Fetch superior staff members
  const superiors = await prisma.staffMember.findMany({
    where: {
      guildId,
      userId: { in: superiorUserIds }
    }
  });

  // Attach superior info and resolve display names
  return absences.map((absence) => {
    const staff = absence.staffMember;
    const superior = absence.superiorUserId ? superiors.find(s => s.userId === absence.superiorUserId) : null;

    // Helper to resolve display name: Pseudo > Tag > Username > Discord ID
    const resolveName = (m: Record<string, unknown> | null | undefined, defaultId: string) => {
      if (!m) return defaultId;
      return m.displayName || m.userTag || m.username || m.userId || defaultId;
    };

    return {
      ...absence,
      staffMember: {
        ...staff,
        displayName: resolveName(staff, absence.staffUserId),
      },
      superior: superior
        ? {
            ...superior,
            displayName: resolveName(superior, absence.superiorUserId!),
          }
        : null,
    };
  });
};

const ABSENCE_FEATURE_KEY = 'absences';

const getAbsenceFeatureConfig = async (guildId: string) => {
  return prisma.dashboardFeatureConfig.findUnique({
    where: {
      guildId_featureKey: {
        guildId,
        featureKey: ABSENCE_FEATURE_KEY,
      },
    },
    include: {
      notificationTargets: true,
    },
  });
};

const sendAbsenceDiscordRelay = async (params: {
  guildId: string;
  absence: {
    id: string;
    staffUserId: string;
    superiorUserId?: string | null;
    type?: string | null;
    reason?: string | null;
    message?: string | null;
    startDate: Date;
    endDate?: Date | null;
  };
  requester: Record<string, unknown> | null;
  superior: Record<string, unknown> | null;
  featureConfig: {
    enabled: boolean;
    channelId: string | null;
    notificationRoleId: string | null;
    notifyViaDiscordChannel: boolean;
    metadata?: unknown;
    notificationTargets?: Array<{
      targetType: string;
      targetId: string | null;
      enabled: boolean;
    }>;
  } | null;
}) => {
  if (!params.featureConfig?.enabled) return;

  const targetChannelIds = new Set<string>();

  if (params.featureConfig.notifyViaDiscordChannel) {
    if (params.featureConfig.channelId) {
      targetChannelIds.add(params.featureConfig.channelId);
    }

    for (const target of params.featureConfig.notificationTargets || []) {
      if (target.enabled && target.targetType === 'DISCORD_CHANNEL' && target.targetId) {
        targetChannelIds.add(target.targetId);
      }
    }
  }

  const metadata = params.featureConfig.metadata as { webhookUrl?: string } | null | undefined;
  const webhookUrl = metadata?.webhookUrl;

  if (targetChannelIds.size === 0 && !webhookUrl) return;

  const requesterName = getAbsenceDisplayName(params.requester, params.absence.staffUserId);
  const superiorName = getAbsenceDisplayName(params.superior, params.absence.superiorUserId ?? 'Aucun');
  const durationLabel = formatAbsenceDuration(params.absence.startDate, params.absence.endDate ?? undefined);
  const isFinite = !!params.absence.endDate;
  const roleMention = params.featureConfig.notificationRoleId ? `<@&${params.featureConfig.notificationRoleId}>` : '';

  const embed = new EmbedBuilder()
    .setTitle('📣 Absence staff déclarée')
    .setDescription(
      [
        `**Staff :** <@${params.absence.staffUserId}>`,
        `**Supérieur notifié :** ${params.absence.superiorUserId ? `<@${params.absence.superiorUserId}>` : 'Aucun'}`,
        `**Type :** ${params.absence.type || 'Absence'}`,
      ].join('\n')
    )
    .addFields(
      { name: 'Nom affiché', value: requesterName, inline: true },
      { name: 'Durée', value: durationLabel, inline: true },
      {
        name: 'Période',
        value: isFinite
          ? `${formatAbsenceDate(params.absence.startDate)}\n→ ${formatAbsenceDate(params.absence.endDate!)}`
          : `${formatAbsenceDate(params.absence.startDate)}\n→ Indéterminée`,
        inline: false,
      },
      { name: 'Motif', value: params.absence.reason || 'Aucun motif fourni', inline: false },
      { name: 'Message complémentaire', value: params.absence.message || 'Aucun', inline: false },
      { name: 'Supérieur', value: superiorName, inline: true },
      { name: 'Référence', value: params.absence.id, inline: true },
    )
    .setColor('#5865F2')
    .setTimestamp(new Date())
    .setFooter({ text: 'Kotbo • Relai notifications absences' });

  const content = roleMention ? `📣 Nouvelle absence staff ${roleMention}` : '📣 Nouvelle absence staff';

  // Send to Discord channels if configured
  if (targetChannelIds.size > 0) {
    const client = getClient();
    const guild = client.guilds.cache.get(params.guildId) ?? await client.guilds.fetch(params.guildId).catch(() => null);
    if (guild) {
      await Promise.all(Array.from(targetChannelIds).map(async (channelId) => {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel || !('send' in channel)) return;

        await channel.send({
          content,
          embeds: [embed],
          allowedMentions: params.featureConfig?.notificationRoleId ? { roles: [params.featureConfig.notificationRoleId] } : undefined,
        }).catch((error: unknown) => {
          logger.warn('StaffLeadership', `Impossible d'envoyer le relai Discord d'absence vers ${channelId}: ${String(error)}`);
        });
      }));
    }
  }

  // Send to Webhook if configured
  if (webhookUrl && typeof webhookUrl === 'string' && webhookUrl.startsWith('https://')) {
    fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        content,
        embeds: [embed.toJSON()],
      }),
    }).catch((err) => {
      logger.error('StaffLeadership', `Failed to send webhook for absence: ${String(err)}`);
    });
  }
};



export const createAbsence = async (
  params: {
    guildId: string;
    staffMemberId: string;
    startDate: Date;
    endDate?: Date;
    reason: string;
    type: string;
    message?: string;
    superiorUserId: string;
    notifyOnMention?: boolean;
  }
) => {
  const [requester, superior, allRoles] = await Promise.all([
    prisma.staffMember.findUnique({ where: { id: params.staffMemberId } }),
    prisma.staffMember.findUnique({
      where: {
        guildId_userId: {
          guildId: params.guildId,
          userId: params.superiorUserId
        }
      },
      include: { testingPeriods: { where: { status: 'ONGOING' } } }
    }),
    prisma.staffRole.findMany({ where: { guildId: params.guildId, enabled: true } })
  ]);

  if (superior && superior.testingPeriods && superior.testingPeriods.length > 0) {
    throw new Error('Le responsable sélectionné ne doit pas être en tutorat.');
  }

  if (requester && superior && allRoles.length > 0) {
    const myRole = allRoles.find(r => r.name === requester.grade);
    const sRole = allRoles.find(r => r.name === superior.grade);
    
    if (myRole && sRole) {
      const isSuperior = sRole.sortOrder >= myRole.sortOrder;
      
      if (!isSuperior) {
        throw new Error('Le responsable sélectionné doit avoir un grade supérieur ou égal au vôtre.');
      }
    }
  }

  const isIndefinite = !params.endDate;
  const featureConfig = await getAbsenceFeatureConfig(params.guildId);

  const absence = await prisma.staffAbsence.create({
    data: {
      guildId: params.guildId,
      staffUserId: params.staffMemberId,
      startDate: params.startDate,
      endDate: params.endDate,
      reason: params.reason,
      type: params.type,
      message: params.message,
      isIndefinite,
      notifyOnMention: params.notifyOnMention ?? false,
      superiorUserId: params.superiorUserId,
      superiorNotifiedAt: new Date(),
      status: 'ACKNOWLEDGED'
    }
  });

  await sendAbsenceDiscordRelay({
    guildId: params.guildId,
    absence,
    requester,
    superior,
    featureConfig,
  }).catch((error) => {
    logger.warn('StaffLeadership', `Impossible d'envoyer le relai Discord d'absence: ${String(error)}`);
  });

  // Notifier le responsable (superiorUserId)
  if (params.superiorUserId && featureConfig?.enabled !== false) {
    await createNotification(
      params.guildId,
      params.superiorUserId,
      "Validation d'absence en attente",
      `Une absence a été soumise par un de vos subordonnés. Type: ${params.type}. Durée: ${formatAbsenceDuration(params.startDate, params.endDate)}. Motif: ${params.reason}.`,
      'WARNING',
      '/planning',
      featureConfig?.notifyViaDM ?? true
    ).catch(() => null);
  }

  // Notifier tous les managers/admins
  const managers = await prisma.staffMember.findMany({
    where: {
      guildId: params.guildId,
      grade: { in: ['Manager', 'Admin', 'Administrateur', 'Fondateur', 'Direction'] }
    }
  });
  
  if (managers.length > 0) {
    await Promise.all(managers
      .filter(m => m.userId !== params.superiorUserId)
      .map(m => createNotification(
        params.guildId,
        m.userId,
        'Nouvelle absence demandée',
        `Une absence a été soumise. Staff: ${getAbsenceDisplayName(requester, params.staffMemberId)}. Type: ${params.type}. Durée: ${formatAbsenceDuration(params.startDate, params.endDate)}. Motif: ${params.reason}.`,
        'INFO',
        '/planning',
        featureConfig?.notifyViaDM ?? true
      ).catch(() => null))
    );
  }

  return absence;
};

export const getAbsenceById = async (guildId: string, absenceId: string) => {
  return prisma.staffAbsence.findFirst({
    where: { id: absenceId, guildId },
    include: { staffMember: true },
  });
};

const formatAbsenceDate = (date: Date) => {
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(date);
};

const formatAbsenceDuration = (startDate: Date, endDate?: Date) => {
  if (!endDate) return 'Indéterminée';

  const durationMs = Math.max(endDate.getTime() - startDate.getTime(), 0);
  const totalHours = durationMs / (1000 * 60 * 60);

  if (totalHours < 1) {
    return `${Math.max(1, Math.round(durationMs / (1000 * 60)))} min`;
  }

  if (totalHours < 24) {
    const roundedHours = Math.round(totalHours * 10) / 10;
    return `${Number.isInteger(roundedHours) ? roundedHours.toFixed(0) : roundedHours.toFixed(1)} h`;
  }

  const days = Math.floor(totalHours / 24);
  const remainingHours = Math.round((totalHours - days * 24) * 10) / 10;

  if (remainingHours <= 0) {
    return `${days} j`;
  }

  return `${days} j ${Number.isInteger(remainingHours) ? remainingHours.toFixed(0) : remainingHours.toFixed(1)} h`;
};

const getAbsenceDisplayName = (member: Record<string, unknown> | null | undefined, fallback: string): string => {
  if (!member) return fallback;
  for (const key of ['displayName', 'userTag', 'username', 'userId']) {
    const value = member[key];
    if (typeof value === 'string' && value) return value;
  }
  return fallback;
};


export const getLatestOpenAbsenceForMember = async (guildId: string, staffMemberId: string) => {
  return prisma.staffAbsence.findFirst({
    where: {
      guildId,
      staffUserId: staffMemberId,
      status: {
        in: ['PENDING', 'ACKNOWLEDGED', 'APPROVED'],
      },
      endedAt: null,
    },
    include: { staffMember: true },
    orderBy: { startDate: 'desc' },
  });
};

export const updateAbsenceStatus = async (
  guildId: string,
  id: string,
  status: AbsenceMutableStatus,
  decisionByUserId: string,
  decisionNote?: string
) => {
  const now = new Date();
  const result = await prisma.staffAbsence.update({
    where: { id, guildId },
    data: {
      status,
      decisionByUserId,
      decisionNote,
      decidedAt: now,
      endedByUserId: status === 'ENDED' || status === 'CANCELED' ? decisionByUserId : null,
      endedAt: status === 'ENDED' || status === 'CANCELED' ? now : null,
    }
  });

  // Notifier le demandeur
  const absence = await prisma.staffAbsence.findUnique({
    where: { id, guildId },
    include: { staffMember: true }
  });
  if (absence && absence.staffMember.userId !== decisionByUserId) {
    await createNotification(
      absence.guildId,
      absence.staffMember.userId,
      'Mise à jour de votre absence',
      `Votre absence a été marquée comme: ${status}.`,
      status === 'APPROVED' ? 'SUCCESS' : (status === 'REJECTED' ? 'ERROR' : 'INFO'),
      '/planning'
    ).catch(() => null);
  }

  return result;
};

export const deleteAbsence = async (guildId: string, id: string) => {
  return prisma.staffAbsence.delete({
    where: { id, guildId }
  });
};

export const closeAbsence = async (
  absenceId: string,
  endedByUserId: string,
  closeNote?: string
) => {
  return prisma.staffAbsence.update({
    where: { id: absenceId },
    data: {
      status: 'ENDED',
      endedByUserId,
      endedAt: new Date(),
      decisionByUserId: endedByUserId,
      decisionNote: closeNote,
      decidedAt: new Date(),
    },
  });
};

export const getMeetings = async (guildId: string) => {
  return prisma.staffMeeting.findMany({
    where: { guildId },
    include: { presences: { include: { staffMember: { select: { username: true, displayName: true, avatarUrl: true, userId: true } } } } },
    orderBy: { scheduledAt: 'desc' },
  });
};

/**
 * Crée une réunion staff avec synchronisation Discord (Événement + Annonce).
 */
/**
 * Refus previsible d'une creation de reunion : configuration incomplete, salon
 * introuvable, date deja passee. Distinct d'une panne, pour que les appelants
 * repondent 400 et montrent le message.
 *
 * Ils triaient jusqu'ici sur `message.includes('Configurez')` : les autres
 * refus finissaient en erreur serveur, et la commande /meeting jetait meme
 * leur message pour repondre « Erreur lors de la creation de la reunion ».
 */
export class MeetingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeetingValidationError';
  }
}

export const createMeeting = async (
  client: Client,
  guildId: string,
  createdByUserId: string,
  title: string,
  description: string,
  scheduledAt: Date,
  endedAt?: Date,
  /**
   * Fuseau dans lequel l'organisateur a saisi l'heure. Stocke tel quel, pour
   * re-afficher l'edition et rediger les libelles envoyes aux participants
   * dans le meme fuseau que la creation, meme si le defaut de la guilde a
   * change entre-temps. `undefined` = repli sur le fuseau du serveur.
   */
  timezone?: string | null,
) => {
  try {
    // Discord refuse un événement planifié dans le passé, et une fin qui
    // précède son début. Le contrôle vit ici parce que les trois portes
    // d'entrée - dashboard, /meeting, MCP - passent toutes par cette fonction :
    // ailleurs, il aurait fallu l'écrire trois fois et il en manquait deux.
    if (scheduledAt.getTime() <= Date.now()) {
      throw new MeetingValidationError('La réunion doit être planifiée dans le futur : Discord refuse un événement déjà passé.');
    }
    if (endedAt && endedAt.getTime() <= scheduledAt.getTime()) {
      throw new MeetingValidationError('La fin de la réunion doit être postérieure à son début.');
    }

    // 1. Récupération de la configuration Discord pour la guilde
    const guildConfig = await prisma.guild.findUnique({
      where: { id: guildId },
      select: {
        meetingAnnouncementChannelId: true,
        meetingVoiceChannelId: true,
      },
    });

    const announcementChannelId = guildConfig?.meetingAnnouncementChannelId;
    const voiceChannelId = guildConfig?.meetingVoiceChannelId;

    if (!announcementChannelId || !voiceChannelId) {
      throw new MeetingValidationError('Configurez les salons de réunion (annonce + vocal/conférence) dans la configuration staff avant de créer une réunion.');
    }

    // 2. Récupération de la guilde et des salons Discord
    const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
    if (!discordGuild) {
      throw new MeetingValidationError("Impossible d'accéder au serveur Discord pour créer la réunion.");
    }

    const announcementChannel = await client.channels.fetch(announcementChannelId).catch(() => null);
    if (!announcementChannel || (announcementChannel.type !== ChannelType.GuildText && announcementChannel.type !== ChannelType.GuildAnnouncement)) {
      throw new MeetingValidationError("Le salon d'annonce configuré est introuvable ou n'est pas un salon texte/annonces.");
    }

    const voiceChannel = await client.channels.fetch(voiceChannelId).catch(() => null);
    if (!voiceChannel || (voiceChannel.type !== ChannelType.GuildVoice && voiceChannel.type !== ChannelType.GuildStageVoice)) {
      throw new MeetingValidationError('Le salon vocal/conférence configuré est introuvable ou invalide.');
    }

    // 3. Création de l'événement programmé Discord
    const scheduledEvent = await discordGuild.scheduledEvents.create({
      name: title.trim().slice(0, 100),
      description: (description?.trim() || 'Réunion staff Kotbo').slice(0, 1000),
      scheduledStartTime: scheduledAt,
      scheduledEndTime: endedAt || new Date(scheduledAt.getTime() + 60 * 60 * 1000), // +1h par défaut
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType: GuildScheduledEventEntityType.Voice,
      channel: voiceChannel.id,
      reason: `Création via dashboard par ${createdByUserId}`,
    });

    // 4. Création de l'enregistrement en base de données
    const meeting = await prisma.staffMeeting.create({
      data: {
        guildId,
        createdByUserId,
        title,
        description,
        scheduledAt,
        endedAt: endedAt || new Date(scheduledAt.getTime() + 60 * 60 * 1000),
        discordEventId: scheduledEvent.id,
        voiceChannelId: voiceChannel.id,
        timezone: timezone ?? null,
        status: 'SCHEDULED'
      }
    });

    // 5. Envoi du message d'annonce avec boutons de présence
    const embed = new EmbedBuilder()
      .setTitle(`📅 Nouvelle Réunion : ${title}`)
      .setDescription(description || 'Aucune description fournie.')
      .addFields(
        { name: 'Date & Heure', value: `<t:${Math.floor(scheduledAt.getTime() / 1000)}:F> (<t:${Math.floor(scheduledAt.getTime() / 1000)}:R>)`, inline: false },
        { name: 'Lieu', value: `<#${voiceChannel.id}>`, inline: true },
        { name: 'Organisateur', value: `<@${createdByUserId}>`, inline: true }
      )
      .setColor('#5865F2')
      .setTimestamp(scheduledAt);

    const row = buildMeetingRsvpRow(meeting.id);

    const announcementMessage = await announcementChannel.send({
      content: '📢 **Nouvelle réunion staff planifiée !** @everyone',
      embeds: [embed],
      components: [row]
    });

    // 6. Mise à jour du meeting avec l'ID du message Discord
    await prisma.staffMeeting.update({
      where: { id: meeting.id },
      data: { discordMessageId: announcementMessage.id }
    });

    // 7. Synchronisation automatique des absences (ceux déjà en congé sont marqués EXCUSED)
    await syncMeetingPresencesWithAbsences(client, meeting.id);

    // 8. Notifications internes (Dashboard Inbox + MP Discord)
    const staff = await prisma.staffMember.findMany({
      where: { guildId }
    });

    // Le libelle part aussi dans l'inbox du dashboard, ou un `<t:…>` resterait
    // affiche tel quel : on formate dans le fuseau ou l'organisateur a saisi,
    // repli sur celui du serveur. `Intl` retomberait sinon sur UTC.
    const meetingTimeLabel = timezone
      ? formatInTimezone(scheduledAt, timezone)
      : await formatGuildDateTime(guildId, scheduledAt);
    
    if (staff.length > 0) {
      await Promise.all(staff.map(m => createNotification(
        guildId,
        m.userId,
        'Nouvelle réunion planifiée',
        `La réunion "${title}" a été planifiée pour le ${meetingTimeLabel}.`,
        'INFO',
        '/planning'
      ).catch(() => null)));
    }

    // On met à jour l'annonce immédiatement pour afficher les stats initiales (ex: ceux déjà en congé)
    await updateMeetingAnnouncement(client, meeting.id);

    broadcastDashboardStateChange(guildId, 'meetings_updated');
    return { ...meeting, discordMessageId: announcementMessage.id };

  } catch (error) {
    if (error instanceof Error && error.message.includes('Configurez')) {
      logger.warn('StaffLeadership', `Erreur de configuration lors de la création de la réunion: ${error.message}`);
    } else {
      logger.error('StaffLeadership', `Erreur lors de la création de la réunion: ${error instanceof Error ? error.message : error}`);
    }
    throw error;
  }
};

export const updateMeetingStatus = async (id: string, status: 'SCHEDULED' | 'COMPLETED' | 'CANCELED') => {
  const updated = await prisma.staffMeeting.update({
    where: { id },
    data: { status }
  });
  broadcastDashboardStateChange(updated.guildId, 'meetings_updated');
  return updated;
};

/**
 * Met à jour une réunion et synchronise les changements sur Discord.
 */
export const updateMeeting = async (
  client: Client,
  guildId: string,
  id: string,
  data: {
    title?: string;
    description?: string;
    scheduledAt?: Date;
    endedAt?: Date;
    status?: 'SCHEDULED' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELED';
    discordMessageId?: string;
    discordEventId?: string;
    // `null` : revient au fuseau du serveur. Distinct de `undefined` qui laisse
    // la valeur inchangee.
    timezone?: string | null;
  }
) => {
  const meeting = await prisma.staffMeeting.update({
    where: { id },
    data,
  });

  // Synchronisation Discord si nécessaire
  if (meeting.discordEventId && (data.title || data.description || data.scheduledAt || data.status)) {
    try {
      const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
      if (discordGuild) {
        const event = await discordGuild.scheduledEvents.fetch(meeting.discordEventId).catch(() => null);
        if (event) {
          await event.edit({
            name: meeting.title.trim().slice(0, 100),
            description: (meeting.description?.trim() || '').slice(0, 1000),
            scheduledStartTime: meeting.scheduledAt,
            scheduledEndTime: meeting.endedAt || new Date(meeting.scheduledAt.getTime() + 60 * 60 * 1000),
            status: data.status === 'COMPLETED' ? 3 : (data.status === 'CANCELED' ? 4 : (data.status === 'IN_PROGRESS' ? 2 : undefined)), // 3=Completed, 4=Canceled, 2=Active
          });
        } else {
          logger.warn('StaffLeadership', `Discord event ${meeting.discordEventId} not found for meeting ${meeting.id}`);
        }
      }
    } catch (err: unknown) {
      logger.error('StaffLeadership', `Failed to update Discord event ${meeting.discordEventId}: ${errorMessage(err)}`, errorStack(err));
    }
  }

  // Optionnel : Mettre à jour l'embed de l'annonce si le message existe encore.
  // On réutilise updateMeetingAnnouncement, qui reconstruit intégralement l'embed
  // depuis la BDD (titre, date, lieu, présences) - nécessaire car le message est
  // en Components V2 et n'expose plus son embed d'origine.
  if (meeting.discordMessageId && (data.title || data.description || data.scheduledAt)) {
    try {
      await updateMeetingAnnouncement(client, id);
    } catch (err) {
      logger.warn('StaffLeadership', `Impossible de mettre à jour l'annonce Discord ${meeting.discordMessageId}: ${err}`);
    }
  }

  broadcastDashboardStateChange(guildId, 'meetings_updated');
  return meeting;
};

/**
 * Supprime une réunion et annule optionnellement l'événement/message Discord associé.
 */
export const deleteMeeting = async (
  client: Client, 
  guildId: string, 
  id: string, 
  options: { deleteEvent?: boolean; deleteMessage?: boolean; deleteNotifications?: boolean } = { deleteEvent: true, deleteMessage: false, deleteNotifications: false }
) => {
  const meeting = await prisma.staffMeeting.findUnique({
    where: { id },
    select: { discordEventId: true, discordMessageId: true, title: true }
  });

  if (!meeting) return;

  // 1. Suppression de l'événement Discord
  if (options.deleteEvent && meeting.discordEventId) {
    try {
      const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
      if (discordGuild) {
        const event = await discordGuild.scheduledEvents.fetch(meeting.discordEventId).catch(() => null);
        if (event) {
          await event.delete().catch(() => null);
        }
      }
    } catch (err) {
      logger.warn('StaffLeadership', `Impossible d'annuler l'événement Discord ${meeting.discordEventId}: ${err}`);
    }
  }

  // 2. Suppression du message d'annonce
  if (options.deleteMessage && meeting.discordMessageId) {
    try {
      const guildConfig = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { meetingAnnouncementChannelId: true }
      });
      if (guildConfig?.meetingAnnouncementChannelId) {
        const channel = await client.channels.fetch(guildConfig.meetingAnnouncementChannelId).catch(() => null);
        if (channel?.isTextBased()) {
          const msg = await channel.messages.fetch(meeting.discordMessageId).catch(() => null);
          if (msg) {
            await msg.delete().catch(() => null);
          }
        }
      }
    } catch (err) {
      logger.warn('StaffLeadership', `Impossible de supprimer le message d'annonce ${meeting.discordMessageId}: ${err}`);
    }
  }

  // 3. Suppression des notifications internes
  if (options.deleteNotifications) {
    try {
      await prisma.notification.deleteMany({
        where: {
          guildId,
          title: 'Nouvelle réunion planifiée',
          message: { contains: `"${meeting.title}"` },
          link: '/planning'
        }
      });
    } catch (err) {
      logger.warn('StaffLeadership', `Impossible de supprimer les notifications pour la réunion ${meeting.title}: ${err}`);
    }
  }

  const deleted = await prisma.staffMeeting.delete({
    where: { id }
  });
  broadcastDashboardStateChange(guildId, 'meetings_updated');
  return deleted;
};

export const checkInMeeting = async (
  client: Client,
  meetingId: string,
  staffUserId: string,
  status: 'PRESENT' | 'EXCUSED' | 'ABSENT',
  note?: string
) => {
  const result = await prisma.staffMeetingPresence.upsert({
    where: { meetingId_staffUserId: { meetingId, staffUserId } },
    update: {
      status,
      checkInAt: status === 'PRESENT' ? new Date() : null,
      note
    },
    create: {
      meetingId,
      staffUserId,
      status,
      checkInAt: status === 'PRESENT' ? new Date() : null,
      note
    },
    include: {
      meeting: true
    }
  });

  // Gérer la création d'une absence automatique si marqué comme ABSENT
  if (status === 'ABSENT') {
    await prisma.staffAbsence.create({
      data: {
        guildId: result.meeting.guildId,
        staffUserId: staffUserId,
        startDate: result.meeting.scheduledAt,
        endDate: new Date(result.meeting.scheduledAt.getTime() + 60 * 60 * 1000), // 1h par défaut
        reason: `Absent à la réunion : ${result.meeting.title}`,
        type: 'Réunion (Absent)',
        status: 'ACKNOWLEDGED'
      }
    });
  } else {
    // Si l'utilisateur re-change de statut, on pourrait supprimer l'absence automatique ?
    // Pour simplifier et éviter les erreurs, on ne supprime que si c'est exactement le même motif
    await prisma.staffAbsence.deleteMany({
      where: {
        staffUserId: staffUserId,
        type: 'Réunion (Absent)',
        reason: `Absent à la réunion : ${result.meeting.title}`
      }
    });
  }

  // Mettre à jour le message d'annonce Discord
  await updateMeetingAnnouncement(client, meetingId).catch(err => 
    logger.error('Meeting', `Failed to update announcement for ${meetingId}:`, err)
  );

  broadcastDashboardStateChange(result.meeting.guildId, 'meetings_updated');
  return result;
};

/**
 * Reconstruit l'embed d'annonce d'une réunion à partir des données en BDD.
 * Les messages sont envoyés en Components V2 (voir utils/patchV2.ts) :
 * `message.embeds` est vide, on ne peut donc pas relire l'embed sur le message.
 */
function buildMeetingAnnouncementEmbed(meeting: {
  title: string;
  description: string | null;
  scheduledAt: Date;
  createdByUserId: string;
  voiceChannelId: string | null;
  presences?: { status: string; note: string | null; staffMember: { userId: string } }[];
}): EmbedBuilder {
  const scheduledSec = Math.floor(meeting.scheduledAt.getTime() / 1000);
  const embed = new EmbedBuilder()
    .setTitle(`📅 Réunion : ${meeting.title}`)
    .setDescription(meeting.description || 'Aucune description fournie.')
    .setColor('#5865F2')
    .setTimestamp(meeting.scheduledAt);

  embed.addFields(
    { name: 'Date & Heure', value: `<t:${scheduledSec}:F> (<t:${scheduledSec}:R>)`, inline: false },
    { name: 'Lieu', value: meeting.voiceChannelId ? `<#${meeting.voiceChannelId}>` : 'Non défini', inline: true },
    { name: 'Organisateur', value: `<@${meeting.createdByUserId}>`, inline: true }
  );

  if (meeting.presences) {
    const presentCount = meeting.presences.filter(p => p.status === 'PRESENT').length;
    const excusedCount = meeting.presences.filter(p => p.status === 'EXCUSED').length;
    const absentCount = meeting.presences.filter(p => p.status === 'ABSENT').length;

    embed.addFields({
      name: '📊 État des présences',
      value: `✅ **Présents:** ${presentCount}\n⏳ **Excusés:** ${excusedCount}\n❌ **Absents:** ${absentCount}`,
      inline: false
    });

    const excuses = meeting.presences
      .filter(p => p.status === 'EXCUSED' && p.note)
      .map(p => `- <@${p.staffMember.userId}> : *${p.note}*`)
      .join('\n');

    if (excuses) {
      embed.addFields({ name: '📝 Justifications', value: excuses, inline: false });
    }
  }

  return embed;
}

/**
 * Ligne des boutons de présence (RSVP) de l'annonce de réunion.
 * En Components V2, les boutons vivent dans `components` : toute édition de
 * l'annonce doit les repasser sinon ils disparaissent.
 */
function buildMeetingRsvpRow(meetingId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`meeting_rsvp:${meetingId}:PRESENT`)
      .setLabel('Présent')
      .setStyle(ButtonStyle.Success)
      .setEmoji('✅'),
    new ButtonBuilder()
      .setCustomId(`meeting_rsvp:${meetingId}:EXCUSED`)
      .setLabel("S'excuser")
      .setStyle(ButtonStyle.Primary)
      .setEmoji('⏳'),
    new ButtonBuilder()
      .setCustomId(`meeting_rsvp:${meetingId}:ABSENT`)
      .setLabel('Absent')
      .setStyle(ButtonStyle.Danger)
      .setEmoji('❌')
  );
}

export const updateMeetingAnnouncement = async (client: Client, meetingId: string) => {
  const meeting = await prisma.staffMeeting.findUnique({
    where: { id: meetingId },
    include: {
      presences: {
        include: {
          staffMember: true
        }
      }
    }
  });

  if (!meeting || !meeting.discordMessageId) return;

  const guildConfig = await prisma.guild.findUnique({
    where: { id: meeting.guildId },
    select: { meetingAnnouncementChannelId: true }
  });

  if (!guildConfig?.meetingAnnouncementChannelId) return;

  const channel = await client.channels.fetch(guildConfig.meetingAnnouncementChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  const message = await channel.messages.fetch(meeting.discordMessageId).catch(() => null);
  if (!message) return;

  const embed = buildMeetingAnnouncementEmbed(meeting);
  // On repasse les boutons RSVP : en Components V2 une édition sans `components`
  // efface les boutons de présence.
  await message.edit({ embeds: [embed], components: [buildMeetingRsvpRow(meeting.id)] });
};

export const syncMeetingPresencesWithAbsences = async (client: Client, meetingId: string) => {
  const meeting = await prisma.staffMeeting.findUnique({
    where: { id: meetingId },
    select: { guildId: true, scheduledAt: true }
  });
  if (!meeting) return;

  const absences = await prisma.staffAbsence.findMany({
    where: {
      guildId: meeting.guildId,
      status: { in: ['APPROVED', 'ACKNOWLEDGED'] },
      startDate: { lte: meeting.scheduledAt },
      OR: [
        { endDate: { gte: meeting.scheduledAt } },
        { isIndefinite: true }
      ]
    }
  });

  for (const absence of absences) {
    await prisma.staffMeetingPresence.upsert({
      where: { meetingId_staffUserId: { meetingId, staffUserId: absence.staffUserId } },
      update: { status: 'EXCUSED', note: `Absence automatique (Staff Panel): ${absence.type} - ${absence.reason}` },
      create: { meetingId, staffUserId: absence.staffUserId, status: 'EXCUSED', note: `Absence automatique (Staff Panel): ${absence.type} - ${absence.reason}` }
    });
  }

  // Mettre à jour le message d'annonce Discord
  await updateMeetingAnnouncement(client, meetingId).catch(err => 
    logger.error('Meeting', `Failed to update announcement for ${meetingId}:`, err)
  );
};

export const getManagerNotes = async (guildId: string, staffUserId: string) => {
  return prisma.staffManagerNote.findMany({
    where: { guildId, staffUserId },
    include: { author: true },
    orderBy: { createdAt: 'desc' },
  });
};

export const createManagerNote = async (
  guildId: string,
  staffUserId: string,
  authorUserId: string,
  content: string
) => {
  const note = await prisma.staffManagerNote.create({
    data: {
      guildId,
      staffUserId,
      authorUserId,
      content
    }
  });

  // Notifier le staff concerné
  const author = await prisma.staffMember.findUnique({ where: { id: authorUserId } });
  const target = await prisma.staffMember.findUnique({ where: { id: staffUserId } });
  
  if (target) {
    await createNotification(
      guildId,
      target.userId,
      'Nouvelle note de management',
      `Une nouvelle note a été ajoutée à votre dossier par ${author?.displayName || 'un manager'}.`,
      'INFO',
      `/profile/${target.userId}`
    ).catch(() => null);
  }

  return note;
};

export const deleteManagerNote = async (id: string) => {
  return prisma.staffManagerNote.delete({
    where: { id }
  });
};

export const getPolls = async (guildId: string) => {
  return prisma.staffPoll.findMany({
    where: { guildId },
    include: {
      options: { include: { _count: { select: { votes: true } } } },
      author: { select: { username: true, displayName: true } },
      votes: { select: { staffUserId: true, optionId: true, weight: true, staffMember: { select: { userId: true } } } }
    },
    orderBy: { createdAt: 'desc' },
  });
};

export const createPoll = async (
  guildId: string,
  authorUserId: string,
  title: string,
  description: string,
  options: string[],
  isAnonymous: boolean = true,
  closesAt?: Date
) => {
  const poll = await prisma.staffPoll.create({
    data: {
      guildId,
      authorUserId,
      title,
      description,
      isAnonymous,
      closesAt,
    }
  });

  if (options.length > 0) {
    await prisma.staffPollOption.createMany({
      data: options.map((opt, index) => ({
        pollId: poll.id,
        text: opt,
        sortOrder: index
      }))
    });
  }

  // Notifier tout le staff
  const staff = await prisma.staffMember.findMany({
    where: { guildId }
  });

  if (staff.length > 0) {
    await Promise.all(staff.map(m => createNotification(
      guildId,
      m.userId,
      'Nouveau sondage staff',
      `Un nouveau sondage est disponible : "${title}".`,
      'INFO',
      '/staff-management/polls'
    ).catch(() => null)));
  }

  return poll;
};

export const castPollVote = async (
  pollId: string,
  staffUserId: string,
  optionId: string,
  weight: number = 1.0
) => {
  return prisma.staffPollVote.upsert({
    where: { pollId_staffUserId: { pollId, staffUserId } },
    update: {
      optionId,
      weight
    },
    create: {
      pollId,
      optionId,
      staffUserId,
      weight
    }
  });
};

export const getProcedures = async (guildId: string) => {
  return prisma.staffProcedure.findMany({
    where: { guildId },
    include: { reads: { select: { staffUserId: true, readAt: true } } },
    orderBy: { sortOrder: 'asc' },
  });
};

export const upsertProcedure = async (
  guildId: string,
  id: string | null,
  title: string,
  content: string,
  sortOrder: number
) => {
  if (id) {
    return prisma.staffProcedure.update({
      where: { id },
      data: { title, content, sortOrder }
    });
  } else {
    const procedure = await prisma.staffProcedure.create({
      data: { guildId, title, content, sortOrder }
    });

    // Notifier tout le staff
    const staff = await prisma.staffMember.findMany({ where: { guildId } });
    const notifsData = staff.map(m => ({
      guildId,
      userId: m.userId,
      title: 'Nouvelle procédure disponible',
      message: `Une nouvelle procédure intitulée "${title}" a été ajoutée. Veuillez en prendre connaissance.`,
      type: 'INFO',
      link: '/procedures',
      isRead: false
    }));

    if (notifsData.length > 0) {
      await prisma.notification.createMany({ data: notifsData });
      broadcastDashboardStateChange(guildId, 'notifications_updated');
    }

    return procedure;
  }
};

export const deleteProcedure = async (id: string) => {
  return prisma.staffProcedure.delete({
    where: { id }
  });
};

export const markProcedureAsRead = async (
  procedureId: string,
  staffUserId: string
) => {
  return prisma.staffProcedureRead.upsert({
    where: { procedureId_staffUserId: { procedureId, staffUserId } },
    update: { readAt: new Date() },
    create: { procedureId, staffUserId }
  });
};

export const getStaffAlertsAndProgression = async (guildId: string) => {
  const staff = await prisma.staffMember.findMany({
    where: { guildId },
    include: {
      activities: {
        where: {
          activityDate: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) }
        }
      },
      warnings: {
        where: { isActive: true }
      },
      mentorReports: true
    }
  });

  return staff.map(member => {
    let progressionScore = 100;
    
    progressionScore -= member.warnings.length * 20;

    const positiveReports = member.mentorReports.filter(r => r.type === 'POSITIVE').length;
    const negativeReports = member.mentorReports.filter(r => r.type === 'NEGATIVE').length;
    progressionScore += positiveReports * 10;
    progressionScore -= negativeReports * 15;

    let hasInactivityAlert = false;
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    
    const messages30d = member.activities.reduce((sum, a) => sum + a.messageCount, 0);
    const messages7d = member.activities.filter(a => a.activityDate >= sevenDaysAgo).reduce((sum, a) => sum + a.messageCount, 0);
    
    const avg30d = messages30d / 30;
    const avg7d = messages7d / 7;

    if (avg30d > 2 && avg7d < avg30d * 0.5) {
      hasInactivityAlert = true;
    }

    return {
      staffUserId: member.userId,
      progressionScore: Math.max(0, progressionScore),
      hasInactivityAlert,
      avg30d: Math.round(avg30d * 10) / 10,
      avg7d: Math.round(avg7d * 10) / 10
    };
  });
};

export const getNotifications = async (guildId: string, userId: string) => {
  return prisma.notification.findMany({
    where: { guildId, userId },
    orderBy: { createdAt: 'desc' },
    take: 50
  });
};

export const markNotificationRead = async (id: string, userId: string) => {
  return prisma.notification.update({
    where: { id, userId },
    data: { isRead: true }
  });
};

export const markAllNotificationsRead = async (guildId: string, userId: string) => {
  const result = await prisma.notification.updateMany({
    where: { guildId, userId, isRead: false },
    data: { isRead: true }
  });
  broadcastDashboardStateChange(guildId, 'notifications_updated');
  return result;
};

export const createNotification = async (
  guildId: string,
  userId: string,
  title: string,
  message: string,
  type: 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR' | 'CRITICAL' = 'INFO',
  link?: string,
  sendDm: boolean = true
) => {
  // 1. Vérifier si l'utilisateur est un membre du staff pour enregistrer la notification sur le dashboard
  const staff = await prisma.staffMember.findUnique({
    where: { guildId_userId: { guildId, userId } }
  });

  let notification = null;
  if (staff) {
    notification = await prisma.notification.create({
      data: {
        guildId,
        userId,
        title,
        message,
        type,
        link,
        isRead: false
      }
    });
    broadcastDashboardStateChange(guildId, 'notifications_updated');
  }

  // 2. Envoi d'un MP automatique (pour tout le monde, staff ou non)
  if (sendDm) {
    try {
      const client = getClient();
      const user = await client.users.fetch(userId).catch(() => null);
      if (user) {
        const typeEmoji = {
          'SUCCESS': '✅',
          'WARNING': '⚠️',
          'ERROR': '❌',
          'INFO': 'ℹ️',
          'CRITICAL': '🚨'
        }[type] || '🔔';

        const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        const serverName = guild ? guild.name : '';

        const embed = new EmbedBuilder()
          .setTitle(`${typeEmoji} ${title}`)
          .setDescription(message)
          .setColor(type === 'ERROR' || type === 'CRITICAL' ? '#ED4245' : (type === 'WARNING' ? '#FEE75C' : (type === 'SUCCESS' ? '#57F287' : '#5865F2')))
          .setTimestamp();

        if (serverName) {
          embed.setFooter({ text: `Serveur : ${serverName}` });
        }

        if (link && staff) { // Le lien vers le dashboard n'est utile que pour le staff
          const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';
          const fullLink = link.startsWith('http') ? link : `${dashboardUrl}${link}`;
          
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setLabel('Voir sur le Dashboard')
              .setStyle(ButtonStyle.Link)
              .setURL(fullLink)
          );
          
          await user.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } }).catch(() => null);
        } else {
          await user.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => null);
        }
      }
    } catch (error) {
      logger.debug('Notification', `Impossible d'envoyer le MP à ${userId}: ${error}`);
    }
  }

  return notification;
};

/**
 * Notifie les participants d'une réunion au début et à la fin
 */
export const processMeetingNotifications = async () => {
  try {
    const now = new Date();
    const notificationWindow = 2 * 60 * 1000; // 2 minutes de fenêtre

    // 1. Vérifier les réunions qui commencent (dans les 2 minutes)
    const meetingsStarting = await prisma.staffMeeting.findMany({
      where: {
        status: 'SCHEDULED',
        scheduledAt: {
          gte: new Date(now.getTime() - 1 * 60 * 1000), // 1 minute avant
          lte: new Date(now.getTime() + notificationWindow), // 2 minutes après
        },
      },
      include: {
        presences: {
          include: {
            staffMember: true
          }
        },
        guild: { select: { id: true } }
      }
    });

    for (const meeting of meetingsStarting) {
      // Vérifier si la notification de début a déjà été envoyée
      const hasStartNotification = meeting.notificationSentAt 
        && meeting.notificationSentAt.getTime() > new Date(now.getTime() - 5 * 60 * 1000).getTime();
      
      if (!hasStartNotification) {
        // Envoyer les notifications de début
        const participants = meeting.presences.map(p => p.staffMember);
        const notificationTasks = participants.map((member) =>
          createNotification(
            meeting.guildId,
            member.userId,
            '📅 Réunion en cours',
            `La réunion ${meeting.title} commence maintenant!`,
            'INFO',
            `/planning?id=${meeting.id}`,
            true
          )
        );
        
        await Promise.all(notificationTasks);
        
        // Mettre à jour la notification date
        await prisma.staffMeeting.update({
          where: { id: meeting.id },
          data: { notificationSentAt: now }
        });
      }
    }

    // 2. Vérifier les réunions qui se terminent (30 min après + 2 min fenêtre)
    const meetingsEnding = await prisma.staffMeeting.findMany({
      where: {
        status: 'SCHEDULED',
        scheduledAt: {
          gte: new Date(now.getTime() - 32 * 60 * 1000), // 32 minutes avant (30min + 2min)
          lte: new Date(now.getTime() - 30 * 60 * 1000 + notificationWindow), // 30min + 2min après
        },
      },
      include: {
        presences: {
          include: {
            staffMember: true
          }
        },
        guild: { select: { id: true } }
      }
    });

    for (const meeting of meetingsEnding) {
      // Vérifier si la notification de fin a déjà été envoyée (30min après le début)
      const endNotificationTime = new Date(meeting.scheduledAt.getTime() + 30 * 60 * 1000);
      const hasEndNotification = meeting.notificationEndSentAt 
        && meeting.notificationEndSentAt.getTime() > endNotificationTime.getTime() - 5 * 60 * 1000;
      
      if (!hasEndNotification && meeting.status === 'SCHEDULED') {
        // Envoyer les notifications de fin
        const participants = meeting.presences.map(p => p.staffMember);
        const notificationTasks = participants.map((member) =>
          createNotification(
            meeting.guildId,
            member.userId,
            '📅 Réunion terminée',
            `La réunion ${meeting.title} est terminée.`,
            'INFO',
            `/planning?id=${meeting.id}`,
            true
          )
        );
        
        await Promise.all(notificationTasks);
        
        // Mettre à jour la notification end date et marquer comme complétée
        await prisma.staffMeeting.update({
          where: { id: meeting.id },
          data: {
            notificationEndSentAt: now,
            status: 'COMPLETED'
          }
        });
      }
    }
  } catch (error) {
    logger.error('Meeting Notifications', 'Erreur lors du traitement des notifications de réunion:', error);
  }
};

/**
 * Enregistre une session vocale pour un membre du staff
 */
export const logStaffVoiceSession = async (
  guildId: string,
  userId: string,
  channelId: string,
  channelName: string | null,
  joinedAt: Date,
  leftAt?: Date
) => {
  try {
    // Vérifier si c'est bien un membre du staff
    const staff = await prisma.staffMember.findUnique({
      where: { guildId_userId: { guildId, userId } }
    });

    if (!staff) return;

    const durationSeconds = leftAt 
      ? Math.floor((leftAt.getTime() - joinedAt.getTime()) / 1000) 
      : null;

    if (leftAt) {
      // Session terminée : on essaie de mettre à jour la session en cours ou d'en créer une nouvelle
      const lastSession = await prisma.staffVoiceSession.findFirst({
        where: {
          guildId,
          staffUserId: staff.id,
          channelId,
          leftAt: null
        },
        orderBy: { joinedAt: 'desc' }
      });

      if (lastSession) {
        return prisma.staffVoiceSession.update({
          where: { id: lastSession.id },
          data: {
            leftAt,
            durationSeconds
          }
        });
      }
    }

    // Création d'une nouvelle session (ouverte ou fermée)
    return prisma.staffVoiceSession.create({
      data: {
        guildId,
        staffUserId: staff.id,
        channelId,
        channelName,
        joinedAt,
        leftAt,
        durationSeconds
      }
    });
  } catch (error) {
    logger.error('StaffLeadership', `Erreur lors du logging de la session vocale staff: ${error}`);
  }
};

/**
 * Récupère les données du calendrier pour le staff (absences + vocal)
 */
export const getStaffCalendarData = async (guildId: string, start: Date, end: Date, staffUserIds?: string[]) => {
  let absences: Record<string, unknown>[] = [];
  let voiceSessions: Record<string, unknown>[] = [];

  try {
    absences = await prisma.staffAbsence.findMany({
      where: {
        guildId,
        status: { in: ['APPROVED', 'ACKNOWLEDGED', 'PENDING'] },
        startDate: { lte: end },
        OR: [
          { endDate: { gte: start } },
          { isIndefinite: true }
        ],
        staffMember: {
          blacklistEntries: {
            none: {
              isActive: true
            }
          }
        },
        ...(staffUserIds ? { staffUserId: { in: staffUserIds } } : {})
      },
      include: { staffMember: true }
    });
  } catch (err: unknown) {
    logger.error('StaffLeadership', `Error fetching absences: ${errorMessage(err)}`);
  }

  try {
    voiceSessions = await prisma.staffVoiceSession.findMany({
      where: {
        guildId,
        joinedAt: { gte: start, lte: end },
        staffMember: {
          blacklistEntries: {
            none: {
              isActive: true
            }
          }
        },
        ...(staffUserIds ? { staffUserId: { in: staffUserIds } } : {})
      },
      include: { staffMember: true }
    });
  } catch (err: unknown) {
    logger.error('StaffLeadership', `Error fetching voice sessions: ${errorMessage(err)}`);
  }

  let meetings: Record<string, unknown>[] = [];
  try {
    meetings = await prisma.staffMeeting.findMany({
      where: {
        guildId,
        scheduledAt: { gte: start, lte: end }
      },
      include: {
        reminders: true,
        presences: {
          where: {
            staffMember: {
              blacklistEntries: {
                none: {
                  isActive: true
                }
              }
            }
          },
          include: {
            staffMember: true
          }
        }
      }
    });
  } catch (err: unknown) {
    logger.error('StaffLeadership', `Error fetching meetings: ${(err as Error).message}`);
  }

  let calls: Record<string, unknown>[] = [];
  try {
    calls = await prisma.staffCall.findMany({
      where: {
        guildId,
        scheduledAt: { gte: start, lte: end }
      },
      include: {
        creator: true,
        reminders: true,
        invitees: {
          include: {
            staffMember: true
          }
        }
      }
    });
  } catch (err: unknown) {
    logger.error('StaffLeadership', `Error fetching calls: ${(err as Error).message}`);
  }

  let tasks: Record<string, unknown>[] = [];
  try {
    tasks = await prisma.staffTask.findMany({
      where: {
        guildId,
        OR: [
          { dueDate: { gte: start, lte: end } },
          { dueDate: null }
        ],
        assignee: {
          blacklistEntries: {
            none: {
              isActive: true
            }
          }
        },
        ...(staffUserIds ? { assignee: { id: { in: staffUserIds } } } : {})
      },
      include: {
        assignee: true,
        creator: true,
        reminders: true
      }
    });
  } catch (err: unknown) {
    logger.error('StaffLeadership', `Error fetching tasks: ${errorMessage(err)}`);
  }

  return { absences, voiceSessions, meetings, calls, tasks };
};

// ==========================================
// CALLS SERVICES
// ==========================================

export const getCalls = async (guildId: string) => {
  return prisma.staffCall.findMany({
    where: { guildId },
    include: {
      creator: true,
      invitees: { include: { staffMember: true } }
    },
    orderBy: { scheduledAt: 'desc' }
  });
};

async function resolveInviteeCUIDs(client: Client, guildId: string, ids: string[]): Promise<string[]> {
  const cuids: string[] = [];

  for (const idOrUserId of ids) {
    if (!idOrUserId) continue;

    // 1. Check if it's already a valid CUID for an existing StaffMember in this guild
    let member = await prisma.staffMember.findFirst({
      where: {
        id: idOrUserId,
        guildId
      }
    });

    if (!member) {
      // 2. Check if it's a Discord userId for an existing StaffMember in this guild
      member = await prisma.staffMember.findFirst({
        where: {
          userId: idOrUserId,
          guildId
        }
      });
    }

    if (!member) {
      // 3. Create a new StaffMember record
      let username: string | null = null;
      let displayName: string | null = null;
      let avatarUrl: string | null = null;
      try {
        const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
        if (discordGuild) {
          const memberObj = await discordGuild.members.fetch(idOrUserId).catch(() => null);
          if (memberObj) {
            username = memberObj.user.username;
            displayName = memberObj.displayName || memberObj.user.globalName || username;
            avatarUrl = memberObj.user.displayAvatarURL() || '';
          } else {
            const userObj = await client.users.fetch(idOrUserId).catch(() => null);
            if (userObj) {
              username = userObj.username;
              displayName = userObj.globalName || username;
              avatarUrl = userObj.displayAvatarURL() || '';
            }
          }
        }
      } catch (err) {
        logger.error('StaffLeadership', `Erreur lors de la récupération des infos Discord pour le membre invité ${idOrUserId}: ${err}`);
      }

      member = await prisma.staffMember.create({
        data: {
          guildId,
          userId: idOrUserId,
          grade: 'Staff',
          username,
          displayName,
          avatarUrl
        }
      });
    }

    if (member && !cuids.includes(member.id)) {
      cuids.push(member.id);
    }
  }

  return cuids;
}

export const createCall = async (
  client: Client,
  guildId: string,
  createdByUserId: string,
  title: string,
  description: string | null,
  scheduledAt: Date,
  channelMode: string,
  channelType?: string | null,
  discordChannelId?: string | null,
  isTempChannel: boolean = true,
  inviteeUserIds: string[] = [] // StaffMember IDs (CUIDs) or Discord User IDs
) => {
  try {
    const finalInviteeCUIDs = await resolveInviteeCUIDs(client, guildId, inviteeUserIds);

    const creator = await prisma.staffMember.findUnique({
      where: { guildId_userId: { guildId, userId: createdByUserId } }
    });
    if (!creator) throw new Error("Le créateur n'est pas un membre du staff.");

    const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
    if (!discordGuild) throw new Error("Impossible d'accéder au serveur Discord.");

    let finalChannelId = discordChannelId;

    if (channelMode === 'CREATE_NEW' && channelType) {
      let categoryId = undefined;
      const voiceConfig = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { meetingVoiceChannelId: true }
      });
      if (voiceConfig?.meetingVoiceChannelId) {
        const configChan = await discordGuild.channels.fetch(voiceConfig.meetingVoiceChannelId).catch(() => null);
        if (configChan) categoryId = configChan.parentId ?? undefined;
      }

      const permissionOverwrites: OverwriteResolvable[] = [
        {
          id: discordGuild.id,
          deny: channelType === 'THREAD' ? [] : ['Connect', 'ViewChannel']
        },
        {
          id: createdByUserId,
          allow: channelType === 'THREAD' 
            ? ['ViewChannel', 'SendMessages'] 
            : ['ViewChannel', 'Connect', 'Speak', 'MuteMembers', 'MoveMembers']
        }
      ];

      const inviteeStaff = await prisma.staffMember.findMany({
        where: { id: { in: finalInviteeCUIDs } }
      });

      for (const invitee of inviteeStaff) {
        permissionOverwrites.push({
          id: invitee.userId,
          allow: channelType === 'THREAD' ? ['ViewChannel', 'SendMessages'] : ['ViewChannel', 'Connect', 'Speak']
        });
      }

      let type = ChannelType.GuildVoice;
      if (channelType === 'STAGE') type = ChannelType.GuildStageVoice;

      const newChannel = await discordGuild.channels.create({
        name: `call-${title.toLowerCase().replace(/\s+/g, '-')}`.slice(0, 100),
        type,
        parent: categoryId,
        permissionOverwrites,
        reason: `Appel staff planifié par ${createdByUserId}`
      });

      finalChannelId = newChannel.id;
    }

    const validInvitees = await prisma.staffMember.findMany({
      where: { id: { in: finalInviteeCUIDs } },
      select: { id: true }
    });
    const validInviteeIds = validInvitees.map(m => m.id);

    const call = await prisma.staffCall.create({
      data: {
        guildId,
        title,
        description,
        scheduledAt,
        status: 'SCHEDULED',
        creatorId: creator.id,
        channelMode,
        channelType: channelType ?? null,
        discordChannelId: finalChannelId ?? null,
        isTempChannel,
        invitees: {
          create: validInviteeIds.map(id => ({ staffUserId: id }))
        }
      },
      include: {
        creator: true,
        invitees: { include: { staffMember: true } }
      }
    });

    const inviteeStaff = await prisma.staffMember.findMany({
      where: { id: { in: finalInviteeCUIDs } }
    });

    const timeLabel = await formatGuildDateTime(guildId, scheduledAt);
    await Promise.all(inviteeStaff.map(m => 
      createNotification(
        guildId,
        m.userId,
        `Nouvel appel planifié`,
        `Vous êtes invité à l'appel "${title}" planifié pour le ${timeLabel}.`,
        'INFO',
        '/planning'
      ).catch(() => null)
    ));

    return call;
  } catch (error) {
    logger.error('StaffLeadership', `Erreur lors de la création de l'appel: ${error instanceof Error ? error.message : error}`);
    throw error;
  }
};

export const updateCall = async (
  client: Client,
  guildId: string,
  id: string,
  data: {
    title?: string;
    description?: string | null;
    scheduledAt?: Date;
    endedAt?: Date;
    status?: 'SCHEDULED' | 'ACTIVE' | 'COMPLETED' | 'CANCELED';
    invitees?: string[];
  }
) => {
  const existingCall = await prisma.staffCall.findUnique({
    where: { id },
    include: { invitees: true }
  });
  if (!existingCall) throw new Error("Appel introuvable.");

  const updatePayload: Record<string, unknown> = {};
  if (data.title) updatePayload.title = data.title;
  if (data.description !== undefined) updatePayload.description = data.description;
  if (data.scheduledAt) updatePayload.scheduledAt = data.scheduledAt;
  if (data.endedAt) updatePayload.endedAt = data.endedAt;
  if (data.status) updatePayload.status = data.status;

  if (data.status === 'COMPLETED' && !existingCall.endedAt) {
    updatePayload.endedAt = new Date();
  }

  if (data.invitees) {
    const resolvedCUIDs = await resolveInviteeCUIDs(client, guildId, data.invitees);
    const validMembers = await prisma.staffMember.findMany({
      where: { id: { in: resolvedCUIDs } },
      select: { id: true }
    });
    await prisma.staffCallInvitee.deleteMany({ where: { callId: id } });
    updatePayload.invitees = {
      create: validMembers.map(m => ({ staffUserId: m.id }))
    };
  }

  const updatedCall = await prisma.staffCall.update({
    where: { id },
    data: updatePayload,
    include: {
      creator: true,
      invitees: { include: { staffMember: true } }
    }
  });

  if (data.status === 'COMPLETED' && updatedCall.isTempChannel && updatedCall.discordChannelId) {
    const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
    if (discordGuild) {
      const channel = await discordGuild.channels.fetch(updatedCall.discordChannelId).catch(() => null);
      if (channel) {
        await channel.delete('Appel terminé. Nettoyage du salon temporaire.').catch(() => null);
      }
    }
  }

  return updatedCall;
};

export const deleteCall = async (client: Client, guildId: string, id: string) => {
  const call = await prisma.staffCall.findUnique({ where: { id } });
  if (!call) return;

  if (call.discordChannelId && call.isTempChannel && call.channelMode === 'CREATE_NEW') {
    const discordGuild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
    if (discordGuild) {
      const channel = await discordGuild.channels.fetch(call.discordChannelId).catch(() => null);
      if (channel) {
        await channel.delete('Appel supprimé.').catch(() => null);
      }
    }
  }

  return prisma.staffCall.delete({ where: { id } });
};

// ==========================================
// CALL PERMISSIONS
// ==========================================

const DEFAULT_CALL_PERMISSION_CONFIG = {
  mode: 'EVERYONE' as const,
  allowedRoleIds: [] as string[],
  allowedUserIds: [] as string[],
};

export const getCallPermissionConfig = async (guildId: string) => {
  const config = await prisma.callPermissionConfig.findUnique({ where: { guildId } });
  return config ?? { guildId, ...DEFAULT_CALL_PERMISSION_CONFIG };
};

export const updateCallPermissionConfig = async (
  guildId: string,
  data: { mode: 'EVERYONE' | 'RESTRICTED'; allowedRoleIds: string[]; allowedUserIds: string[] }
) => {
  return prisma.callPermissionConfig.upsert({
    where: { guildId },
    update: {
      mode: data.mode,
      allowedRoleIds: data.allowedRoleIds,
      allowedUserIds: data.allowedUserIds,
    },
    create: {
      guildId,
      mode: data.mode,
      allowedRoleIds: data.allowedRoleIds,
      allowedUserIds: data.allowedUserIds,
    },
  });
};

export const canUserCreateCall = async (guildId: string, userId: string, roleIds: string[]): Promise<boolean> => {
  const config = await getCallPermissionConfig(guildId);
  if (config.mode === 'EVERYONE') return true;

  if (config.allowedUserIds.includes(userId)) return true;
  return config.allowedRoleIds.some((roleId) => roleIds.includes(roleId));
};

// ==========================================
// TASKS SERVICES
// ==========================================

export const getTasks = async (guildId: string, assigneeId?: string) => {
  return prisma.staffTask.findMany({
    where: {
      guildId,
      ...(assigneeId ? { assigneeId } : {})
    },
    include: {
      assignee: true,
      creator: true
    },
    orderBy: { dueDate: 'asc' }
  });
};

export const createTask = async (
  guildId: string,
  createdByUserId: string,
  title: string,
  description: string | null,
  priority: 'LOW' | 'MEDIUM' | 'HIGH',
  dueDate: Date | null,
  assigneeStaffId: string
) => {
  const creator = await prisma.staffMember.findUnique({
    where: { guildId_userId: { guildId, userId: createdByUserId } }
  });
  if (!creator) throw new Error("Le créateur n'est pas un membre du staff.");

  const task = await prisma.staffTask.create({
    data: {
      guildId,
      title,
      description,
      priority,
      dueDate,
      assigneeId: assigneeStaffId,
      creatorId: creator.id,
      status: 'PENDING'
    },
    include: {
      assignee: true,
      creator: true
    }
  });

  if (task.assignee.userId !== createdByUserId) {
    await createNotification(
      guildId,
      task.assignee.userId,
      `Nouvelle tâche assignée`,
      `Vous avez reçu une nouvelle tâche : "${title}" (Priorité: ${priority}).`,
      'INFO',
      '/planning'
    ).catch(() => null);
  }

  return task;
};

export const updateTask = async (
  id: string,
  data: {
    title?: string;
    description?: string | null;
    status?: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED';
    priority?: 'LOW' | 'MEDIUM' | 'HIGH';
    dueDate?: Date | null;
    assigneeId?: string;
  }
) => {
  return prisma.staffTask.update({
    where: { id },
    data,
    include: {
      assignee: true,
      creator: true
    }
  });
};

export const deleteTask = async (id: string) => {
  return prisma.staffTask.delete({ where: { id } });
};
