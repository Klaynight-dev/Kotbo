import {
  EmbedBuilder,
  ContainerBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  SectionBuilder,
  ThumbnailBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  MessageFlags,
  SeparatorSpacingSize,
  type ColorResolvable,
  type APIEmbedField,
} from 'discord.js';
import { E } from './emojis.js';
import { accessory, container, ContainerChild, section, separator, thumbnail } from '@arcscord/components';

// ─────────────────────────────────────────────────────────────
// Color Palette
// ─────────────────────────────────────────────────────────────
export const COLORS = {
  primary: 0x5865f2 as ColorResolvable,
  success: 0x57f287 as ColorResolvable,
  danger: 0xed4245 as ColorResolvable,
  warning: 0xfee75c as ColorResolvable,
  info: 0x5865f2 as ColorResolvable,
  dark: 0x2b2d31 as ColorResolvable,
  pink: 0xeb459e as ColorResolvable,
};

export const COLORS_RAW = {
  primary: 0x5865f2,
  success: 0x57f287,
  danger: 0xed4245,
  warning: 0xfee75c,
  info: 0x5865f2,
  dark: 0x2b2d31,
  pink: 0xeb459e,
};

// ─────────────────────────────────────────────────────────────
// V2 Helper — wraps components in IsComponentsV2 flag
// ─────────────────────────────────────────────────────────────
export function v2(...containers: ContainerBuilder[]) {
  return {
    components: containers,
    // `as const` : sans lui le type infere est l'enum MessageFlags entier, que
    // les options d'envoi de discord.js refusent.
    flags: MessageFlags.IsComponentsV2 as const,
  };
}

// ─────────────────────────────────────────────────────────────
// V2 Text Shorthand
// ─────────────────────────────────────────────────────────────
export function text(content: string) {
  return new TextDisplayBuilder().setContent(content);
}

export function separatorOld(divider = true, spacing: SeparatorSpacingSize = SeparatorSpacingSize.Small) {
  return new SeparatorBuilder().setDivider(divider).setSpacing(spacing);
}

export function thumbnailOld(url: string, description?: string) {
  const tb = new ThumbnailBuilder({ media: { url } });
  if (description) tb.setDescription(description);
  return tb;
}

export function sectionOld(content: string, accessory?: ThumbnailBuilder | ButtonBuilder) {
  const s = new SectionBuilder().addTextDisplayComponents(text(content));
  if (accessory instanceof ThumbnailBuilder) s.setThumbnailAccessory(accessory);
  else if (accessory instanceof ButtonBuilder) s.setButtonAccessory(accessory);
  return s;
}

export function mediaGallery(...urls: string[]) {
  const mg = new MediaGalleryBuilder();
  mg.addItems(...urls.map(url => new MediaGalleryItemBuilder({ media: { url } })));
  return mg;
}

// ─────────────────────────────────────────────────────────────
// V2 Preset Containers
// ─────────────────────────────────────────────────────────────
export function successContainer(title: string, description?: string) {
  return new ContainerBuilder()
    .setAccentColor(COLORS_RAW.success)
    .addTextDisplayComponents(
      text(`${E.success} **${title}**${description ? `\n${description}` : ''}`)
    );
}

export function errorContainer(title: string, description?: string) {
  return new ContainerBuilder()
    .setAccentColor(COLORS_RAW.danger)
    .addTextDisplayComponents(
      text(`${E.error} **${title}**${description ? `\n${description}` : ''}`)
    );
}

export function warningContainer(title: string, description?: string) {
  return new ContainerBuilder()
    .setAccentColor(COLORS_RAW.warning)
    .addTextDisplayComponents(
      text(`${E.warning} **${title}**${description ? `\n${description}` : ''}`)
    );
}

export function infoContainer(title: string, description?: string) {
  return new ContainerBuilder()
    .setAccentColor(COLORS_RAW.info)
    .addTextDisplayComponents(
      text(`${E.info} **${title}**${description ? `\n${description}` : ''}`)
    );
}

// ─────────────────────────────────────────────────────────────
// V2 Rich Container Builder
// ─────────────────────────────────────────────────────────────
export interface V2Field {
  name: string;
  value: string;
}

export type KotboContainerOptions = {
  /**
   * Color of the container, accept number or a key of {@link COLORS_RAW}
   */
  color?: number | keyof typeof COLORS_RAW
  /**
   * Set a title of the container, add '### ' at begin of the string
   * if {@link KotboContainerOptions.titleOverwrite} is set, this value are ignored
   */
  title?: string;
  /**
   * Add a Thumbnail in the title, transfor title in section
   */
  titleThumbnail?: { url: string, description?: string }
  /**
   * Title overwrite, if set, title don't include '### '
   * have priority over {@link KotboContainerOptions.title}
   */
  titleOverwrite?: string;
  /**
   * All fields inside container
   */
  fields?: ContainerChild[],
  /**
   * Set a footer below the container, add '-# ${E.kotbo} Kotbo · ' at begin of the string
   * if {@link KotboContainerOptions.footerOverwrite} is set, this value are ignored
   */
  footerTitle?: string;
  /**
   * Add a separator before footer, default are true
   * @default true
   */
  footerSeparator?: boolean;
  /**
   * Footer overwrite, if set, footer don't include '-# ${E.kotbo} Kotbo · '
   * have priority over {@link KotboContainerOptions.footerTitle}
   */
  footerOverwrite?: string;
}

export function kotboContainer(options: KotboContainerOptions) {
  const fields: ContainerChild[] = [];

  const title = options.titleOverwrite ?? (options.title ? `### ${options.title}` : undefined);

  if (typeof title !== 'undefined') {
    if (options.titleThumbnail) {
      fields.push(
        section(
          title,
          accessory(
            thumbnail({media: options.titleThumbnail})
          )
        )
      )
    } else {
      fields.push(title)
    }
  }

  if (options.fields) {
    fields.push(...options.fields)
  }

  const footer = options.footerOverwrite ??
    (options.footerTitle ? `-# ${E.kotbo} Kotbo · ${options.footerTitle}` : undefined);
  if (footer) {

    if (typeof options.footerSeparator === 'undefined' || options.footerSeparator) {
      fields.push(separator({ divider: false, spacing: 'small' }))
    }
    fields.push(footer)

  }

  const accentColor = typeof options.color === 'string' ? COLORS_RAW[options.color] : options.color;

  const firstField = fields.shift()
  if (typeof firstField === 'undefined') {
    throw TypeError('Try to create a container with 0 fields');
  }

  // firstField are here for respect typescript (fields can have 0 length and container need 1 or more)
  return container({accentColor}, firstField, ...fields);
}

export function richContainer(options: {
  color?: number;
  title?: string;
  description?: string;
  thumbnailUrl?: string;
  fields?: V2Field[];
  footer?: string;
  imageUrl?: string;
  actionRow?: ActionRowBuilder<ButtonBuilder>;
}) {
  const c = new ContainerBuilder().setAccentColor(options.color ?? COLORS_RAW.primary);

  if (options.title && options.thumbnailUrl) {
    c.addSectionComponents(
      sectionOld(`### ${options.title}`, thumbnailOld(options.thumbnailUrl))
    );
  } else if (options.title) {
    c.addTextDisplayComponents(text(`### ${options.title}`));
  }

  if (options.description) {
    c.addTextDisplayComponents(text(options.description));
  }

  if (options.fields?.length) {
    c.addSeparatorComponents(separatorOld(true, SeparatorSpacingSize.Small));
    for (const field of options.fields) {
      c.addTextDisplayComponents(text(`**${field.name}**\n${field.value}`));
    }
  }

  if (options.imageUrl) {
    c.addMediaGalleryComponents(mediaGallery(options.imageUrl));
  }

  if (options.actionRow) {
    c.addActionRowComponents(options.actionRow);
  }

  if (options.footer) {
    c.addSeparatorComponents(separatorOld(false, SeparatorSpacingSize.Small));
    c.addTextDisplayComponents(text(`-# ${options.footer}`));
  }

  return c;
}

// ─────────────────────────────────────────────────────────────
// Legacy Embed Helpers (kept for backward compatibility)
// ─────────────────────────────────────────────────────────────
export interface EmbedOptions {
  user?: { username: string; displayAvatarURL?: () => string };
}

export function baseEmbed(color: ColorResolvable = COLORS.primary, options?: EmbedOptions) {
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTimestamp();

  if (options?.user) {
    embed.setFooter({
      text: `Kotbo • Demandé par ${options.user.username}`,
      iconURL: options.user.displayAvatarURL ? options.user.displayAvatarURL() : undefined,
    });
  } else {
    embed.setFooter({ text: 'Kotbo • Assistant V2' });
  }

  return embed;
}

export function successEmbed(title: string, description?: string, options?: EmbedOptions) {
  return baseEmbed(COLORS.success, options).setTitle(`${E.success} ${title}`).setDescription(description ?? null);
}

export function errorEmbed(title: string, description?: string, options?: EmbedOptions) {
  return baseEmbed(COLORS.danger, options).setTitle(`${E.error} ${title}`).setDescription(description ?? null);
}

export function infoEmbed(title: string, description?: string, fields?: APIEmbedField[], options?: EmbedOptions) {
  const e = baseEmbed(COLORS.info, options).setTitle(`${E.info} ${title}`);
  if (description) e.setDescription(description);
  if (fields?.length) e.addFields(fields);
  return e;
}

// ─────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────
export function truncate(str: string, max: number) {
  return str.length > max ? str.slice(0, max - 3) + '...' : str;
}

export function getCategoryTheme(category: string) {
  const c = category?.toLowerCase() || '';
  if (c.includes('youtube')) return { label: 'YouTube', color: 0xff0000 as ColorResolvable };
  if (c.includes('twitch')) return { label: 'Twitch', color: 0x9146ff as ColorResolvable };
  return { label: 'Actualités', color: COLORS.primary };
}

// Re-export emoji helpers for backward compatibility
export { categoryEmoji, feedStatusEmoji } from './emojis.js';

// ─────────────────────────────────────────────────────────────
// Platform Embeds (YouTube / Twitch / News)
// ─────────────────────────────────────────────────────────────
export function buildYouTubeEmbed(params: {
  title: string;
  videoId: string;
  channelName: string;
  publishedAt: Date;
}) {
  return baseEmbed(0xff0000)
    .setTitle(truncate(params.title, 256))
    .setURL(`https://www.youtube.com/watch?v=${params.videoId}`)
    .setAuthor({ name: params.channelName })
    .setTimestamp(params.publishedAt);
}

export function buildTwitchEmbed(params: {
  title: string;
  streamerName: string;
  gameName?: string;
  viewerCount?: number;
  thumbnailUrl?: string;
}) {
  const embed = baseEmbed(0x9146ff)
    .setTitle(truncate(params.title, 256))
    .setURL(`https://twitch.tv/${params.streamerName}`)
    .setAuthor({ name: params.streamerName })
    .setDescription(`${E.dnd} ${params.streamerName} est en live !`);

  if (params.gameName) {
    embed.addFields({ name: 'Jeu', value: params.gameName, inline: true });
  }
  if (params.viewerCount !== undefined) {
    embed.addFields({ name: 'Spectateurs', value: params.viewerCount.toLocaleString(), inline: true });
  }
  if (params.thumbnailUrl) {
    const formattedUrl = params.thumbnailUrl
      .replace('{width}', '1280')
      .replace('{height}', '720');
    embed.setImage(formattedUrl);
  }

  return embed;
}

export function buildNewsEmbed(params: {
  title: string;
  url: string;
  description: string;
  feedName: string;
  category: string;
  publishedAt: Date;
  isValidation?: boolean;
  itemId?: string;
}) {
  const theme = getCategoryTheme(params.category);
  const embed = baseEmbed(theme.color)
    .setTitle(truncate(params.title, 256))
    .setURL(params.url)
    .setDescription(truncate(params.description, 2048))
    .setAuthor({ name: params.feedName })
    .setTimestamp(params.publishedAt);

  embed.addFields(
    { name: 'Catégorie', value: params.category, inline: true },
    { name: 'Source', value: params.feedName, inline: true },
  );

  if (params.itemId) {
    embed.setFooter({ text: `Kotbo • ID: ${params.itemId}` });
  }

  return embed;
}
