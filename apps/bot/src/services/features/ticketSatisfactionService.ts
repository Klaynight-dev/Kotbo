import prisma, { prismaRead } from '../../utils/db.js';
import type { Prisma } from '@prisma/client';
import { logger } from '../../utils/logger.js';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Client,
  type Message,
} from 'discord.js';
import { COLORS } from '../../utils/embeds.js';

type SatisfactionPerson = {
  userId: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
};

type SatisfactionReview = {
  rating: number;
  staffId: string | null;
  userId: string;
  comment: string | null;
  createdAt: Date;
  ticketId: string;
};

type StaffSatisfactionRow = {
  staffId: string | null;
  _avg: { rating: number | null };
  _count: { rating: number };
};

/** Question par défaut : la colonne reste vide tant que le serveur n'a rien personnalisé. */
export const DEFAULT_SATISFACTION_COMMENT_QUESTION = 'Avez-vous des commentaires à ajouter ?';
export const SATISFACTION_COMMENT_MAX_LENGTH = 500;
/** Bornes du délai d'expiration du bouton « Ajouter un commentaire », en secondes. */
const COMMENT_TIMEOUT_MIN = 30;
const COMMENT_TIMEOUT_MAX = 900;
export const DEFAULT_COMMENT_TIMEOUT = 120;
/** Nombre de commentaires affichés directement sous chaque staff dans le dashboard. */
const STAFF_COMMENT_PREVIEW = 3;

const RATING_EMOJIS = ['', '\u{1F621}', '\u{1F615}', '\u{1F610}', '\u{1F642}', '\u{1F929}'];

export type SatisfactionCommentConfig = {
  enabled: boolean;
  question: string;
  timeoutSeconds: number;
};

export function clampCommentTimeout(seconds: unknown): number {
  const value = Math.round(Number(seconds));
  if (!Number.isFinite(value)) return DEFAULT_COMMENT_TIMEOUT;
  return Math.min(Math.max(value, COMMENT_TIMEOUT_MIN), COMMENT_TIMEOUT_MAX);
}

// Caractères de contrôle, invisibles et marques bidirectionnelles : ils servent à
// masquer du texte ou à en inverser l'affichage, jamais à rédiger un avis. \n et
// \t sont volontairement préservés.
// eslint-disable-next-line no-control-regex -- viser ces caractères de contrôle est précisément le but du filtre
const INVISIBLE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]/g;

/**
 * Un commentaire est du texte fourni par un membre : on le nettoie avant de le
 * stocker plutôt qu'à l'affichage, pour qu'aucun consommateur (dashboard, export
 * RGPD, futur relais Discord) n'ait à refaire le travail.
 */
export function sanitizeSatisfactionComment(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE_CHARS, '')
    // Les mentions n'ont aucun sens dans un avis et pingueraient le serveur si le
    // commentaire repassait un jour par Discord. Un espace de largeur nulle les
    // casse sans rien retirer de ce que le membre a écrit.
    .replace(/@(everyone|here)\b/gi, '@\u200B$1')
    .replace(/<@[!&]?(\d+)>/g, '@\u200B$1')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{3,}/g, '  ')
    .trim()
    .slice(0, SATISFACTION_COMMENT_MAX_LENGTH);
}

export async function getSatisfactionCommentConfig(guildId: string): Promise<SatisfactionCommentConfig> {
  const guild = await prismaRead.guild.findUnique({
    where: { id: guildId },
    select: {
      ticketSatisfactionCommentEnabled: true,
      ticketSatisfactionCommentQuestion: true,
      ticketSatisfactionCommentTimeout: true,
    },
  });

  return {
    enabled: guild?.ticketSatisfactionCommentEnabled ?? true,
    question: guild?.ticketSatisfactionCommentQuestion?.trim() || DEFAULT_SATISFACTION_COMMENT_QUESTION,
    timeoutSeconds: clampCommentTimeout(guild?.ticketSatisfactionCommentTimeout ?? DEFAULT_COMMENT_TIMEOUT),
  };
}

function bestDisplayName(profile: {
  userId: string;
  displayName?: string | null;
  globalName?: string | null;
  username?: string | null;
  userTag?: string | null;
}): string {
  return profile.displayName || profile.globalName || profile.username || profile.userTag || `Utilisateur ${profile.userId}`;
}

async function resolveSatisfactionPeople(
  guildId: string,
  userIds: string[],
  client?: Client,
): Promise<Map<string, SatisfactionPerson>> {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  const people = new Map<string, SatisfactionPerson>();
  if (uniqueIds.length === 0) return people;

  const [profiles, staffMembers] = await Promise.all([
    prismaRead.memberProfile.findMany({
      where: { guildId, userId: { in: uniqueIds } },
      select: {
        userId: true,
        userTag: true,
        username: true,
        globalName: true,
        displayName: true,
        avatarUrl: true,
      },
    }),
    prismaRead.staffMember.findMany({
      where: { guildId, userId: { in: uniqueIds } },
      select: {
        userId: true,
        userTag: true,
        username: true,
        displayName: true,
        avatarUrl: true,
      },
    }),
  ]);

  for (const staff of staffMembers) {
    people.set(staff.userId, {
      userId: staff.userId,
      username: staff.username ?? staff.userTag ?? null,
      displayName: bestDisplayName(staff),
      avatarUrl: staff.avatarUrl ?? null,
    });
  }

  for (const profile of profiles) {
    people.set(profile.userId, {
      userId: profile.userId,
      username: profile.username ?? profile.userTag ?? null,
      displayName: bestDisplayName(profile),
      avatarUrl: profile.avatarUrl ?? null,
    });
  }

  if (client) {
    const missingIds = uniqueIds.filter((userId) => !people.get(userId)?.avatarUrl || !people.get(userId)?.displayName);
    await Promise.all(missingIds.map(async (userId) => {
      const discordUser = await client.users.fetch(userId).catch(() => null);
      if (!discordUser) return;
      const existing = people.get(userId);
      const discordDisplayName = discordUser.globalName ?? discordUser.username;
      const existingDisplayName = existing?.displayName;
      people.set(userId, {
        userId,
        username: existing?.username ?? discordUser.username,
        displayName: existingDisplayName && !existingDisplayName.startsWith('Utilisateur ')
          ? existingDisplayName
          : discordDisplayName,
        avatarUrl: existing?.avatarUrl ?? discordUser.displayAvatarURL(),
      });
    }));
  }

  for (const userId of uniqueIds) {
    if (!people.has(userId)) {
      people.set(userId, {
        userId,
        username: null,
        displayName: `Utilisateur ${userId}`,
        avatarUrl: null,
      });
    }
  }

  return people;
}

export async function sendSatisfactionSurvey(client: Client, guildId: string, ticketId: string, userId: string, _staffId?: string): Promise<void> {
  try {
    const user = await client.users.fetch(userId).catch(() => null);
    if (!user) return;

    const existing = await prismaRead.ticketSatisfaction.findUnique({
      where: { guildId_ticketId_userId: { guildId, ticketId, userId } },
    });
    if (existing) return;

    const embed = new EmbedBuilder()
      .setColor(COLORS.primary)
      .setTitle('📋 Votre avis compte !')
      .setDescription('Votre ticket vient d\'être résolu. Comment évaluez-vous la qualité du support reçu ?')
      .setFooter({ text: `Kotbo • Ticket #${ticketId.slice(-6)}` })
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`satisfaction:${guildId}:${ticketId}:1`).setEmoji('😡').setLabel('1').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`satisfaction:${guildId}:${ticketId}:2`).setEmoji('😕').setLabel('2').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`satisfaction:${guildId}:${ticketId}:3`).setEmoji('😐').setLabel('3').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`satisfaction:${guildId}:${ticketId}:4`).setEmoji('🙂').setLabel('4').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`satisfaction:${guildId}:${ticketId}:5`).setEmoji('🤩').setLabel('5').setStyle(ButtonStyle.Success),
    );

    await user.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } }).catch(() => {
      logger.debug('TicketSatisfaction', `Impossible d'envoyer le sondage à ${userId} (DM fermés)`);
    });
  } catch (error) {
    logger.error('TicketSatisfaction', 'Erreur envoi sondage:', error);
  }
}

export async function recordSatisfaction(guildId: string, ticketId: string, userId: string, rating: number, staffId?: string): Promise<boolean> {
  try {
    // Le bouton du sondage ne transporte pas l'identifiant du staff (la limite de
    // 100 caractères du customId est déjà serrée) : on le relit sur le ticket,
    // sans quoi la vue « par staff » du dashboard resterait vide.
    const resolvedStaffId = staffId ?? (await prismaRead.ticket.findUnique({
      where: { id: ticketId },
      select: { claimedById: true },
    }))?.claimedById ?? undefined;

    await prisma.ticketSatisfaction.upsert({
      where: { guildId_ticketId_userId: { guildId, ticketId, userId } },
      create: { guildId, ticketId, userId, staffId: resolvedStaffId, rating },
      update: { rating, ...(resolvedStaffId ? { staffId: resolvedStaffId } : {}) },
    });
    return true;
  } catch (error) {
    logger.error('TicketSatisfaction', 'Erreur enregistrement:', error);
    return false;
  }
}

/**
 * Enregistre le commentaire facultatif. La note doit déjà exister : le sondage ne
 * propose la question qu'après un clic sur une note.
 */
export async function recordSatisfactionComment(guildId: string, ticketId: string, userId: string, rawComment: string): Promise<boolean> {
  const comment = sanitizeSatisfactionComment(rawComment);
  if (!comment) return false;

  try {
    const { count } = await prisma.ticketSatisfaction.updateMany({
      where: { guildId, ticketId, userId },
      data: { comment },
    });
    return count > 0;
  } catch (error) {
    logger.error('TicketSatisfaction', 'Erreur enregistrement commentaire:', error);
    return false;
  }
}

/** Embed + boutons proposant la question facultative, une fois la note enregistrée. */
export function buildCommentPrompt(guildId: string, ticketId: string, rating: number, config: SatisfactionCommentConfig) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle('Merci pour votre retour !')
    .setDescription(
      `Vous avez donné la note ${RATING_EMOJIS[rating] ?? ''} **${rating}/5**.\n\n`
      + `**${config.question}**\n`
      + `-# Facultatif - vous pouvez répondre dans les ${config.timeoutSeconds} secondes, ou simplement ignorer ce message.`,
    )
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`satcomment:${guildId}:${ticketId}`)
      .setLabel('Ajouter un commentaire')
      .setEmoji('💬')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`satskip:${guildId}:${ticketId}`)
      .setLabel('Non merci')
      .setStyle(ButtonStyle.Secondary),
  );

  return { embed, row };
}

/** Embed final, sans bouton : note seule, commentaire envoyé, ou question expirée. */
export function buildSatisfactionDoneEmbed(rating: number, comment?: string | null): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle('Merci pour votre retour !')
    .setDescription(`Vous avez donné la note ${RATING_EMOJIS[rating] ?? ''} **${rating}/5**.`)
    .setTimestamp();

  if (comment) {
    embed.addFields({ name: 'Votre commentaire', value: comment.slice(0, 1024) });
  }
  return embed;
}

/**
 * Mémorise le message porteur de la question et sa date limite. Le minuteur en
 * mémoire ne survit pas à un redémarrage : ces champs permettent au balayage
 * périodique de reprendre la main et de refermer le sondage.
 */
export async function markCommentPromptOpen(
  guildId: string,
  ticketId: string,
  userId: string,
  message: Message,
  timeoutSeconds: number,
): Promise<void> {
  try {
    await prisma.ticketSatisfaction.updateMany({
      where: { guildId, ticketId, userId },
      data: {
        commentPromptChannelId: message.channelId,
        commentPromptMessageId: message.id,
        commentPromptExpiresAt: new Date(Date.now() + timeoutSeconds * 1000),
      },
    });
  } catch (error) {
    logger.error('TicketSatisfaction', 'Erreur enregistrement du sondage en attente:', error);
  }
}

/** Marque la question comme résolue : plus rien à rattraper au prochain balayage. */
export async function clearCommentPrompt(guildId: string, ticketId: string, userId: string): Promise<void> {
  try {
    await prisma.ticketSatisfaction.updateMany({
      where: { guildId, ticketId, userId },
      data: { commentPromptChannelId: null, commentPromptMessageId: null, commentPromptExpiresAt: null },
    });
  } catch (error) {
    logger.error('TicketSatisfaction', 'Erreur nettoyage du sondage en attente:', error);
  }
}

/**
 * Retire le bouton passé le délai imparti : sans cela, un sondage resterait
 * ouvert indéfiniment dans les DM du membre alors que la question est facultative.
 * Relit la réponse en base pour ne pas écraser un commentaire arrivé entre-temps.
 */
export function scheduleCommentPromptExpiry(
  message: Message,
  guildId: string,
  ticketId: string,
  userId: string,
  fallbackRating: number,
  timeoutSeconds: number,
): void {
  const timer = setTimeout(() => {
    void (async () => {
      try {
        const stored = await prismaRead.ticketSatisfaction.findUnique({
          where: { guildId_ticketId_userId: { guildId, ticketId, userId } },
          select: { rating: true, comment: true, commentPromptExpiresAt: true },
        });
        // Deja resolu (commentaire envoye, refus, ou balayage passe avant) :
        // ne pas reecrire un message que quelqu'un d'autre a deja finalise.
        if (stored && !stored.commentPromptExpiresAt) return;

        await message.edit({
          embeds: [buildSatisfactionDoneEmbed(stored?.rating ?? fallbackRating, stored?.comment)],
          components: [],
        });
      } catch {
        // Le membre a pu fermer ses DM ou supprimer le message : rien à rattraper.
      } finally {
        await clearCommentPrompt(guildId, ticketId, userId);
      }
    })();
  }, timeoutSeconds * 1000);
  // Ne doit pas retenir la boucle d'évènements lors d'un arrêt du bot.
  timer.unref?.();
}

/**
 * Referme les questions dont le délai a expiré pendant que le bot était arrêté
 * (ou dont le minuteur en mémoire a été perdu). Appelé par le cron minute.
 */
export async function expirePendingCommentPrompts(client: Client): Promise<number> {
  const pending = await prismaRead.ticketSatisfaction.findMany({
    where: {
      commentPromptExpiresAt: { lte: new Date() },
      commentPromptMessageId: { not: null },
    },
    // Un arret prolonge peut en accumuler : on avance par lots plutot que de
    // tenir la boucle d'evenements sur des centaines d'appels Discord.
    take: 100,
    select: {
      guildId: true,
      ticketId: true,
      userId: true,
      rating: true,
      comment: true,
      commentPromptChannelId: true,
      commentPromptMessageId: true,
    },
  });
  if (pending.length === 0) return 0;

  let closed = 0;
  for (const row of pending) {
    try {
      const channel = row.commentPromptChannelId
        ? await client.channels.fetch(row.commentPromptChannelId).catch(() => null)
        : null;

      if (channel?.isTextBased()) {
        const message = await channel.messages.fetch(row.commentPromptMessageId!).catch(() => null);
        await message?.edit({
          embeds: [buildSatisfactionDoneEmbed(row.rating, row.comment)],
          components: [],
        }).catch(() => null);
      }
      closed += 1;
    } catch (error) {
      logger.debug('TicketSatisfaction', `Expiration du sondage ${row.ticketId} impossible: ${error}`);
    } finally {
      // Meme si l'edition echoue (DM ferme, message supprime), on libere la
      // ligne : la reessayer chaque minute indefiniment n'apporterait rien.
      await clearCommentPrompt(row.guildId, row.ticketId, row.userId);
    }
  }

  if (closed > 0) logger.debug('TicketSatisfaction', `${closed} sondage(s) de satisfaction expiré(s)`);
  return closed;
}

export function buildCommentModal(guildId: string, ticketId: string, config: SatisfactionCommentConfig): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`satcomment_modal:${guildId}:${ticketId}`)
    .setTitle('Votre commentaire')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('comment')
          // Discord plafonne le label d'un champ à 45 caractères : une question
          // personnalisée plus longue passe en placeholder.
          .setLabel(config.question.length <= 45 ? config.question : 'Votre commentaire')
          .setPlaceholder(config.question.slice(0, 100))
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(SATISFACTION_COMMENT_MAX_LENGTH),
      ),
    );
}

export async function getStaffSatisfactionStats(guildId: string, staffId?: string, client?: Client) {
  const where: Prisma.TicketSatisfactionWhereInput = { guildId };
  if (staffId) where.staffId = staffId;

  const [stats, recentRaw] = await Promise.all([
    prismaRead.ticketSatisfaction.aggregate({
      where,
      _avg: { rating: true },
      _count: { rating: true },
    }),
    prismaRead.ticketSatisfaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { rating: true, staffId: true, userId: true, comment: true, createdAt: true, ticketId: true },
    }),
  ]);
  const recent = recentRaw as SatisfactionReview[];

  const distribution = await prismaRead.ticketSatisfaction.groupBy({
    by: ['rating'],
    where,
    _count: { rating: true },
    orderBy: { rating: 'asc' },
  });

  const people = await resolveSatisfactionPeople(
    guildId,
    recent.flatMap((review) => [review.userId, review.staffId].filter((id): id is string => Boolean(id))),
    client,
  );

  return {
    averageRating: stats._avg.rating ?? 0,
    totalResponses: stats._count.rating,
    distribution: distribution.map((d) => ({ rating: d.rating, count: d._count.rating })),
    recent: recent.map((review) => ({
      ...review,
      user: people.get(review.userId) ?? null,
      staff: review.staffId ? people.get(review.staffId) ?? null : null,
    })),
  };
}

export async function getSatisfactionDashboardData(guildId: string, client?: Client) {
  const [global, byStaffRaw, commentCountsRaw, commentRowsRaw] = await Promise.all([
    getStaffSatisfactionStats(guildId, undefined, client),
    prismaRead.ticketSatisfaction.groupBy({
      by: ['staffId'],
      where: { guildId, staffId: { not: null } },
      _avg: { rating: true },
      _count: { rating: true },
      orderBy: { _avg: { rating: 'desc' } },
    }),
    prismaRead.ticketSatisfaction.groupBy({
      by: ['staffId'],
      where: { guildId, staffId: { not: null }, comment: { not: null } },
      _count: { comment: true },
    }),
    // Un seul passage sur les commentaires récents, découpé par staff en mémoire :
    // le détail complet reste accessible via la route paginée.
    prismaRead.ticketSatisfaction.findMany({
      where: { guildId, staffId: { not: null }, comment: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 300,
      select: { rating: true, staffId: true, userId: true, comment: true, createdAt: true, ticketId: true },
    }),
  ]);
  const byStaff = byStaffRaw as StaffSatisfactionRow[];
  const commentRows = commentRowsRaw as SatisfactionReview[];

  const commentCounts = new Map(
    (commentCountsRaw as { staffId: string | null; _count: { comment: number } }[])
      .map((row) => [row.staffId!, row._count.comment]),
  );

  const previewByStaff = new Map<string, SatisfactionReview[]>();
  for (const row of commentRows) {
    const bucket = previewByStaff.get(row.staffId!) ?? [];
    if (bucket.length >= STAFF_COMMENT_PREVIEW) continue;
    bucket.push(row);
    previewByStaff.set(row.staffId!, bucket);
  }

  const people = await resolveSatisfactionPeople(
    guildId,
    [
      ...byStaff.map((s) => s.staffId),
      ...commentRows.flatMap((row) => [row.staffId, row.userId]),
    ].filter((userId): userId is string => Boolean(userId)),
    client,
  );

  return {
    global,
    byStaff: byStaff.map((s) => ({
      staffId: s.staffId!,
      staff: people.get(s.staffId!) ?? null,
      averageRating: s._avg.rating ?? 0,
      totalResponses: s._count.rating,
      commentCount: commentCounts.get(s.staffId!) ?? 0,
      recentComments: (previewByStaff.get(s.staffId!) ?? []).map((review) => ({
        ...review,
        user: people.get(review.userId) ?? null,
      })),
    })),
  };
}

/** Avis d'un staff, paginés - alimente la modale « Voir tous les avis » du dashboard. */
export async function getStaffSatisfactionReviews(
  guildId: string,
  staffId: string,
  options: { limit?: number; offset?: number; commentsOnly?: boolean } = {},
  client?: Client,
) {
  const limit = Number.isFinite(options.limit) ? Math.min(Math.max(Math.trunc(options.limit!), 1), 100) : 20;
  const offset = Number.isFinite(options.offset) ? Math.max(Math.trunc(options.offset!), 0) : 0;
  const where: Prisma.TicketSatisfactionWhereInput = { guildId, staffId };
  if (options.commentsOnly) where.comment = { not: null };

  const [rowsRaw, total] = await Promise.all([
    prismaRead.ticketSatisfaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: limit,
      select: { rating: true, staffId: true, userId: true, comment: true, createdAt: true, ticketId: true },
    }),
    prismaRead.ticketSatisfaction.count({ where }),
  ]);
  const rows = rowsRaw as SatisfactionReview[];

  const people = await resolveSatisfactionPeople(guildId, rows.map((row) => row.userId), client);

  return {
    reviews: rows.map((review) => ({ ...review, user: people.get(review.userId) ?? null })),
    total,
    limit,
    offset,
    hasMore: offset + rows.length < total,
  };
}

export type SatisfactionLogConfig = {
  channelId: string | null;
  anonymous: boolean;
};

export async function getSatisfactionLogConfig(guildId: string): Promise<SatisfactionLogConfig> {
  const guild = await prismaRead.guild.findUnique({
    where: { id: guildId },
    select: {
      ticketSatisfactionLogChannelId: true,
      ticketSatisfactionLogAnonymous: true,
    },
  });

  return {
    channelId: guild?.ticketSatisfactionLogChannelId || null,
    anonymous: guild?.ticketSatisfactionLogAnonymous ?? false,
  };
}

const RATING_COLORS = [COLORS.dark, COLORS.danger, COLORS.danger, COLORS.warning, COLORS.success, COLORS.success];

function ratingStars(rating: number): string {
  const value = Math.min(Math.max(Math.trunc(rating) || 0, 0), 5);
  return `${'★'.repeat(value)}${'☆'.repeat(5 - value)}`;
}

export function buildSatisfactionReviewEmbed(review: {
  ticketId: string;
  rating: number;
  comment: string | null;
  userId: string;
  author: SatisfactionPerson | null;
  staffId: string | null;
  anonymous: boolean;
}): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(RATING_COLORS[review.rating] ?? COLORS.primary)
    .setTitle('Nouvel avis de satisfaction')
    .setDescription(`${RATING_EMOJIS[review.rating] ?? ''} ${ratingStars(review.rating)} **${review.rating}/5**`)
    .addFields(
      {
        name: 'Auteur',
        value: review.anonymous ? '*Membre anonyme*' : `<@${review.userId}>`,
        inline: true,
      },
      {
        name: 'Staff',
        value: review.staffId ? `<@${review.staffId}>` : '*Non attribué*',
        inline: true,
      },
      {
        name: 'Commentaire',
        // Le commentaire est déjà assaini au stockage (mentions neutralisées,
        // 500 caractères max) : rien à refaire ici.
        value: review.comment || '*Aucun commentaire*',
      },
    )
    .setFooter({ text: `Kotbo · Ticket #${review.ticketId.slice(-6)}` })
    .setTimestamp();

  if (!review.anonymous && review.author) {
    embed.setAuthor({
      name: review.author.displayName.slice(0, 256),
      ...(review.author.avatarUrl ? { iconURL: review.author.avatarUrl } : {}),
    });
  }

  return embed;
}

/**
 * Une publication à la fois par avis : la note et le commentaire peuvent se
 * suivre de très près, et deux passages concurrents posteraient deux messages
 * avant que le premier n'ait mémorisé le sien.
 */
const publishQueue = new Map<string, Promise<void>>();

/**
 * Republie l'avis dans le salon configuré. Appelée une première fois dès la note
 * puis, si un commentaire arrive, une seconde fois : le message déjà publié est
 * alors édité plutôt que dupliqué. Ne lève jamais : un relais impossible (salon
 * supprimé, permissions manquantes) ne doit pas perturber le sondage du membre.
 */
export async function publishSatisfactionReview(
  client: Client,
  guildId: string,
  ticketId: string,
  userId: string,
): Promise<void> {
  const key = `${guildId}:${ticketId}:${userId}`;
  const run = (publishQueue.get(key) ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => publishSatisfactionReviewOnce(client, guildId, ticketId, userId))
    .finally(() => {
      if (publishQueue.get(key) === run) publishQueue.delete(key);
    });
  publishQueue.set(key, run);
  return run;
}

async function publishSatisfactionReviewOnce(
  client: Client,
  guildId: string,
  ticketId: string,
  userId: string,
): Promise<void> {
  try {
    const config = await getSatisfactionLogConfig(guildId);
    if (!config.channelId) return;

    // Lecture sur la primaire : le commentaire vient d'être écrit, une réplique
    // en retard republierait l'avis sans lui.
    const stored = await prisma.ticketSatisfaction.findUnique({
      where: { guildId_ticketId_userId: { guildId, ticketId, userId } },
      select: {
        rating: true,
        comment: true,
        staffId: true,
        reviewLogChannelId: true,
        reviewLogMessageId: true,
      },
    });
    if (!stored) return;

    const channel = await client.channels.fetch(config.channelId).catch(() => null);
    if (!channel?.isTextBased() || !('send' in channel)) return;
    // Un identifiant de salon arbitraire peut arriver par l'outil MCP : sans ce
    // contrôle, les avis d'un serveur pourraient être publiés dans un autre.
    if (!('guildId' in channel) || channel.guildId !== guildId) return;

    const people = await resolveSatisfactionPeople(
      guildId,
      config.anonymous ? [] : [userId],
      client,
    );

    const embed = buildSatisfactionReviewEmbed({
      ticketId,
      rating: stored.rating,
      comment: stored.comment,
      userId,
      author: people.get(userId) ?? null,
      staffId: stored.staffId,
      anonymous: config.anonymous,
    });

    // Le salon a pu changer entre la note et le commentaire : on n'édite que si
    // le message publié se trouve bien dans le salon actuellement configuré.
    if (stored.reviewLogMessageId && stored.reviewLogChannelId === channel.id) {
      const existing = await channel.messages.fetch(stored.reviewLogMessageId).catch(() => null);
      if (existing) {
        await existing.edit({ embeds: [embed], allowedMentions: { parse: [] } });
        return;
      }
    }

    const message = await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    await prisma.ticketSatisfaction.updateMany({
      where: { guildId, ticketId, userId },
      data: { reviewLogChannelId: channel.id, reviewLogMessageId: message.id },
    });
  } catch (error) {
    logger.debug('TicketSatisfaction', `Publication de l'avis ${ticketId} impossible: ${error}`);
  }
}

/**
 * Retire du salon des avis les embeds publiés pour un membre, dans le cadre
 * d'une demande d'effacement RGPD. À appeler *avant* de supprimer les lignes en
 * base : l'identifiant du message n'est stocké que là, et une ligne effacée
 * rendrait l'embed impossible à retrouver.
 *
 * La référence n'est vidée que si le message a bien disparu : un échec (droits
 * retirés, salon indisponible) laisse la ligne intacte pour permettre un
 * nouvel essai plutôt que d'abandonner l'embed en place.
 */
export async function deleteSatisfactionReviewMessages(
  client: Client,
  userId: string,
  guildId?: string,
): Promise<{ deleted: number; cleared: number; failed: number }> {
  const rows = await prisma.ticketSatisfaction.findMany({
    where: {
      userId,
      ...(guildId ? { guildId } : {}),
      reviewLogMessageId: { not: null },
    },
    select: {
      guildId: true,
      ticketId: true,
      reviewLogChannelId: true,
      reviewLogMessageId: true,
    },
  });

  let deleted = 0;
  let cleared = 0;
  let failed = 0;

  for (const row of rows) {
    const channel = row.reviewLogChannelId
      ? await client.channels.fetch(row.reviewLogChannelId).catch(() => null)
      : null;

    // Trois issues distinctes : l'embed a été retiré, il avait déjà disparu, ou
    // il est toujours là. Les deux premières libèrent la référence, mais seule
    // la première est une suppression - les confondre faisait annoncer des
    // embeds retirés que personne n'avait touchés.
    let removed = false;
    let alreadyGone = false;

    if (!channel?.isTextBased()) {
      // Salon supprimé ou devenu inaccessible : l'embed n'est plus atteignable,
      // garder la référence n'apporterait rien.
      alreadyGone = true;
    } else {
      const message = await channel.messages.fetch(row.reviewLogMessageId!).catch(() => null);
      if (!message) {
        alreadyGone = true;
      } else {
        removed = await message.delete().then(() => true).catch(() => false);
      }
    }

    if (!removed && !alreadyGone) {
      failed += 1;
      continue;
    }

    if (removed) deleted += 1;
    else cleared += 1;

    await prisma.ticketSatisfaction.updateMany({
      where: { guildId: row.guildId, ticketId: row.ticketId, userId },
      data: { reviewLogChannelId: null, reviewLogMessageId: null },
    });
  }

  if (deleted > 0 || cleared > 0 || failed > 0) {
    logger.info(
      'TicketSatisfaction',
      `Effacement RGPD des avis de ${userId}: ${deleted} embed(s) retiré(s), ${cleared} déjà absent(s), ${failed} en échec`,
    );
  }
  return { deleted, cleared, failed };
}
