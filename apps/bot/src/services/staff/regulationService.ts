import {
  type APIEmbedField,
  type Client,
  EmbedBuilder,
  type TextChannel,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Guild
} from 'discord.js';
import { ensureBotCanPost } from '../../utils/channelAccess.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { resolveGuildLocale, type BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

export type RegulationArticle = {
  id: string;
  title: string;
  description: string;
  emoji: string | null;
  sortOrder: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Discord refuse un message dont le texte affichable cumulé dépasse 4000
 * caractères (`COMPONENT_DISPLAYABLE_TEXT_SIZE_EXCEEDED`). On garde une marge
 * pour le titre, le pied de page et l'éventuel bloc « … et plus ».
 */
const EMBED_TEXT_BUDGET = 3900;
const PAGE_OVERHEAD = 200;
const FIELD_NAME_LIMIT = 256;
const FIELD_VALUE_LIMIT = 1024;
const FIELDS_PER_EMBED = 25;
/** Au-delà, on arrête de découper : un règlement de 10 messages est déjà énorme. */
const MAX_MESSAGES = 10;
/** Place gardée sur la dernière page pour le bloc « … et plus ». */
const OVERFLOW_NOTICE_RESERVE = 150;

function getArticleEmoji(article: RegulationArticle): string {
  const emoji = article.emoji?.trim();
  return emoji ? emoji : '📌';
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Découpe un texte en morceaux de `limit` caractères max, sur une coupure propre. */
function splitText(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let rest = text.trim();

  while (rest.length > limit) {
    const softLimit = Math.floor(limit / 2);
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < softLimit) cut = rest.lastIndexOf(' ', limit);
    if (cut < softLimit) cut = limit;

    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }

  if (rest.length > 0) chunks.push(rest);
  return chunks.length > 0 ? chunks : [''];
}

/** Un article = un champ, ou plusieurs si sa description dépasse la limite Discord. */
function buildArticleFields(
  article: RegulationArticle,
  index: number,
  locale: BotLocale,
): APIEmbedField[] {
  const emoji = getArticleEmoji(article);
  const description = article.description.trim() || m.panel_regulation_article_no_desc({}, { locale });

  return splitText(description, FIELD_VALUE_LIMIT).map((value, chunkIndex) => ({
    name: truncate(
      chunkIndex === 0
        ? m.panel_regulation_article_heading({ emoji, index, title: article.title }, { locale })
        : m.panel_regulation_article_heading_continued(
            { emoji, index, title: article.title },
            { locale },
          ),
      FIELD_NAME_LIMIT,
    ),
    value,
    inline: false,
  }));
}

/**
 * Construit le règlement sous forme de pages : une page = un message Discord.
 * La première porte l'en-tête et le résumé, la dernière le pied de page.
 */
export function buildRegulationEmbeds(params: {
  guildName: string;
  guildId: string;
  articles: RegulationArticle[];
  publishedAt?: Date;
  locale: BotLocale;
}): EmbedBuilder[] {
  const { locale } = params;
  const activeArticles = params.articles.filter((article) => article.enabled);
  const publishedRelative = params.publishedAt
    ? `<t:${Math.floor(params.publishedAt.getTime() / 1000)}:R>`
    : m.panel_regulation_updated_now({}, { locale });

  const headerDescription = [
    m.panel_regulation_welcome({ guild: params.guildName }, { locale }),
    m.panel_regulation_read({}, { locale }),
    m.panel_regulation_synced({}, { locale }),
  ].join('\n');
  const summaryField: APIEmbedField = {
    name: m.panel_regulation_summary({}, { locale }),
    value: [
      m.panel_regulation_articles_active({ count: activeArticles.length }, { locale }),
      m.panel_regulation_articles_total({ count: params.articles.length }, { locale }),
      m.panel_regulation_updated({ when: publishedRelative }, { locale }),
    ].join(' · '),
    inline: false,
  };

  const pages: { fields: APIEmbedField[]; length: number }[] = [{
    fields: [summaryField],
    length: PAGE_OVERHEAD + headerDescription.length + summaryField.name.length + summaryField.value.length,
  }];
  let current = pages[0]!;
  let skippedArticles = 0;

  for (const [index, article] of activeArticles.entries()) {
    let overflow = false;

    for (const field of buildArticleFields(article, index + 1, locale)) {
      // Sur la dernière page autorisée, on garde de la place pour « … et plus ».
      const isFinalPage = pages.length >= MAX_MESSAGES;
      const fieldLimit = isFinalPage ? FIELDS_PER_EMBED - 1 : FIELDS_PER_EMBED;
      const textLimit = isFinalPage ? EMBED_TEXT_BUDGET - OVERFLOW_NOTICE_RESERVE : EMBED_TEXT_BUDGET;
      const cost = field.name.length + field.value.length;
      const needsNewPage = current.fields.length >= fieldLimit || current.length + cost > textLimit;

      if (needsNewPage) {
        if (isFinalPage) {
          overflow = true;
          break;
        }
        current = { fields: [], length: PAGE_OVERHEAD };
        pages.push(current);
      }

      current.fields.push(field);
      current.length += cost;
    }

    if (overflow) {
      skippedArticles = activeArticles.length - index;
      break;
    }
  }

  return pages.map((page, pageIndex) => {
    const isLast = pageIndex === pages.length - 1;
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(
        pages.length === 1
          ? m.panel_regulation_title({}, { locale })
          : m.panel_regulation_page_title({ page: pageIndex + 1, total: pages.length }, { locale }),
      )
      .addFields(page.fields);

    if (pageIndex === 0) {
      embed.setDescription(headerDescription);
    }

    if (isLast) {
      if (skippedArticles > 0) {
        embed.addFields({
          name: m.panel_regulation_more_title({}, { locale }),
          value: m.panel_regulation_more_value({ count: skippedArticles }, { locale }),
          inline: false,
        });
      }
      embed.setFooter({ text: m.panel_regulation_footer({}, { locale }) });
      embed.setTimestamp(params.publishedAt ?? new Date());
    }

    return embed;
  });
}

export async function loadRegulationArticles(guildId: string): Promise<RegulationArticle[]> {
  return prisma.guildRegulationArticle.findMany({
    where: { guildId },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
}

export async function publishOrUpdateRegulationMessage(client: Client, guildId: string) {
  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
    select: {
      configChannelId: true,
      regulationChannelId: true,
      regulationMessageId: true,
      regulationMessageIds: true,
      regulationVerificationEnabled: true,
      regulationRoleId: true,
      staffAnnouncementChannelId: true,
    },
  });

  const targetChannelId = guild?.regulationChannelId ?? guild?.configChannelId;
  if (!targetChannelId) {
    throw new Error("Le salon de publication du règlement n'est pas défini.");
  }

  const discordGuild = client.guilds.cache.get(guildId);
  const guildName = discordGuild?.name ?? `Serveur ${guildId}`;
  const locale = await resolveGuildLocale(guildId, discordGuild?.preferredLocale ?? null);
  const articles = await loadRegulationArticles(guildId);
  const embeds = buildRegulationEmbeds({
    guildName,
    guildId,
    articles,
    publishedAt: new Date(),
    locale,
  });

  const channel = await client.channels.fetch(targetChannelId).catch(() => null) as TextChannel | null;
  if (!channel || !('send' in channel)) {
    throw new Error('Le salon de publication du règlement est introuvable ou inaccessible.');
  }

  // Le salon des regles est repris a Discord plutot que cree : ses surcharges
  // sont celles du serveur, pas celles de la mise en place, et le bot peut
  // parfaitement s'y voir refuser la parole.
  if (discordGuild) await ensureBotCanPost(discordGuild, channel, 'Publication du règlement');

  const components = [];
  if (guild?.regulationVerificationEnabled) {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('regulation_accept')
        .setLabel(m.panel_regulation_accept_button({}, { locale }))
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅')
    );
    components.push(row);
  }

  // Les serveurs publiés avant le découpage multi-messages n'ont que l'ancien champ.
  const previousMessageIds = guild?.regulationMessageIds?.length
    ? guild.regulationMessageIds
    : guild?.regulationMessageId
      ? [guild.regulationMessageId]
      : [];

  const messageIds: string[] = [];
  let hasEditedExisting = false;

  for (const [index, embed] of embeds.entries()) {
    // Le bouton d'acceptation ne va que sur le dernier message du règlement.
    const messageComponents = index === embeds.length - 1 ? components : [];
    const existingId = previousMessageIds[index];
    const existingMessage = existingId
      ? await channel.messages.fetch(existingId).catch(() => null)
      : null;

    if (existingMessage) {
      await existingMessage.edit({ embeds: [embed], components: messageComponents });
      messageIds.push(existingMessage.id);
      hasEditedExisting = true;
      continue;
    }

    const sentMessage = await channel.send({
      embeds: [embed],
      components: messageComponents,
      allowedMentions: { parse: [] },
    });
    messageIds.push(sentMessage.id);
  }

  // Le règlement a raccourci : on retire les messages devenus orphelins.
  for (const staleId of previousMessageIds.slice(embeds.length)) {
    await channel.messages
      .fetch(staleId)
      .then((message) => message.delete())
      .catch(() => null);
  }

  const mode: 'created' | 'updated' = hasEditedExisting ? 'updated' : 'created';
  const messageId = messageIds[0] ?? null;

  await prisma.guild.update({
    where: { id: guildId },
    data: { regulationMessageId: messageId, regulationMessageIds: messageIds },
  });

  logger.info('Règlement', `${mode === 'updated' ? 'Mise à jour' : 'Publication'} du règlement pour ${guildId} dans ${targetChannelId} (${messageIds.length} message(s)).`);

  await announceRegulationToStaff(client, guildId, {
    mode,
    staffChannelId: guild?.staffAnnouncementChannelId ?? null,
    regulationChannelId: targetChannelId,
    messageId,
    articles,
    locale,
  });

  return { mode, messageId, messageIds, targetChannelId };
}

/**
 * Une publication du règlement ne notifie personne en MP : seul le salon
 * d'annonces staff reçoit un récapitulatif.
 */
async function announceRegulationToStaff(
  client: Client,
  guildId: string,
  params: {
    mode: 'created' | 'updated';
    staffChannelId: string | null;
    regulationChannelId: string;
    messageId: string | null;
    articles: RegulationArticle[];
    locale: BotLocale;
  }
) {
  const { staffChannelId, locale } = params;
  if (!staffChannelId) return;

  const channel = await client.channels.fetch(staffChannelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    logger.warn('Règlement', `Salon d'annonces staff introuvable ou invalide (${staffChannelId}) pour ${guildId}.`);
    return;
  }

  const activeCount = params.articles.filter((article) => article.enabled).length;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(
      params.mode === 'updated'
        ? m.regulation_staff_notice_updated_title({}, { locale })
        : m.regulation_staff_notice_published_title({}, { locale })
    )
    .setDescription(
      m.regulation_staff_notice_desc({ channel: `<#${params.regulationChannelId}>` }, { locale })
    )
    .addFields({
      name: m.regulation_staff_notice_articles({}, { locale }),
      value: `${activeCount}/${params.articles.length}`,
      inline: true,
    })
    .setFooter({ text: m.regulation_staff_notice_footer({}, { locale }) })
    .setTimestamp(new Date());

  if (params.messageId) {
    embed.setURL(`https://discord.com/channels/${guildId}/${params.regulationChannelId}/${params.messageId}`);
  }

  await channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch((err) => {
    logger.error('Règlement', `Impossible de notifier le staff dans ${staffChannelId}: ${err}`);
  });
}

export async function applyRegulationLock(
  discordGuild: Guild,
  verifiedRoleId: string,
  regulationChannelId: string,
  enabled: boolean
) {
  try {
    const verifiedRole = discordGuild.roles.cache.get(verifiedRoleId);
    if (!verifiedRole) {
      logger.error('RegulationLock', `Rôle de vérification introuvable (${verifiedRoleId}) pour le serveur ${discordGuild.name}`);
      return;
    }

    const channels = await discordGuild.channels.fetch();
    for (const channel of channels.values()) {
      if (!channel) continue;

      if (
        channel.type !== ChannelType.GuildText &&
        channel.type !== ChannelType.GuildVoice &&
        channel.type !== ChannelType.GuildCategory &&
        channel.type !== ChannelType.GuildAnnouncement &&
        channel.type !== ChannelType.GuildStageVoice
      ) {
        continue;
      }

      const isRegulationChannel = channel.id === regulationChannelId;

      if (enabled) {
        if (isRegulationChannel) {
          await channel.permissionOverwrites.edit(discordGuild.roles.everyone, {
            ViewChannel: true,
          }).catch((err) => logger.warn('RegulationLock', `Impossible de modifier les perms de règlement pour @everyone: ${err}`));
        } else {
          await channel.permissionOverwrites.edit(discordGuild.roles.everyone, {
            ViewChannel: false,
          }).catch((err) => logger.warn('RegulationLock', `Impossible de masquer le salon ${channel.name} pour @everyone: ${err}`));
          
          await channel.permissionOverwrites.edit(verifiedRole, {
            ViewChannel: true,
          }).catch((err) => logger.warn('RegulationLock', `Impossible d'autoriser le salon ${channel.name} pour le rôle de vérification: ${err}`));
        }
      } else {
        if (!isRegulationChannel) {
          await channel.permissionOverwrites.delete(discordGuild.roles.everyone).catch(() => null);
          await channel.permissionOverwrites.delete(verifiedRole).catch(() => null);
        }
      }
    }
    logger.info('RegulationLock', `Verrouillage du règlement ${enabled ? 'appliqué' : 'retiré'} sur le serveur ${discordGuild.name}.`);
  } catch (err) {
    logger.error('RegulationLock', `Erreur lors de l'application du verrouillage règlement:`, err);
  }
}
