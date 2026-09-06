import type { NewsChannel } from 'discord.js';
import { type TextChannel, type Message, type Guild, type Embed, ComponentType } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

export interface ParsedTranscriptEmbed {
  color: string | null;
  authorName: string | null;
  authorIconUrl: string | null;
  authorUrl: string | null;
  title: string | null;
  url: string | null;
  description: string | null;
  fields: { name: string; value: string; inline: boolean }[];
  thumbnailUrl: string | null;
  imageUrl: string | null;
  footerText: string | null;
  footerIconUrl: string | null;
}

export interface ParsedTranscriptMessage {
  avatarUrl: string;
  username: string;
  isBot: boolean;
  timestamp: string;
  content: string;
  embeds: ParsedTranscriptEmbed[];
  imageUrls: string[];
}

function unescapeHtml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<span class="mention">(@[^<]*)<\/span>/g, '$1')
    .replace(/<span class="mention">(#[^<]*)<\/span>/g, '$1')
    .replace(/<code class="inline-code">([^<]*)<\/code>/g, '`$1`')
    .replace(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/g, '```\n$1```')
    .replace(/<strong>(.*?)<\/strong>/g, '**$1**')
    .replace(/<em>(.*?)<\/em>/g, '*$1*')
    .replace(/<u>(.*?)<\/u>/g, '__$1__')
    .replace(/<del>(.*?)<\/del>/g, '~~$1~~')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>[^<]*<\/a>/g, '$1')
    .replace(/<img[^>]*class="discord-emoji"[^>]*alt="([^"]*)"[^>]*\/?>/g, '$1')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function parseEmbedFromHtml(embedHtml: string): ParsedTranscriptEmbed {
  const colorMatch = embedHtml.match(/border-left-color:\s*([^"]+)/);

  const authorIconMatch = embedHtml.match(/<img class="discord-embed-author-icon" src="([^"]*?)"/);
  const authorLinkMatch = embedHtml.match(/<a class="discord-embed-author-link" href="([^"]*?)"[^>]*>([^<]*)<\/a>/);
  const authorSpanMatch = !authorLinkMatch ? embedHtml.match(/<div class="discord-embed-author">[^]*?<span>([^<]*)<\/span>/) : null;

  const titleLinkMatch = embedHtml.match(/<div class="discord-embed-title">\s*<a href="([^"]*?)"[^>]*>([^<]*)<\/a>/);
  const titlePlainMatch = !titleLinkMatch ? embedHtml.match(/<div class="discord-embed-title">\s*([^<]+)/) : null;

  const descMatch = embedHtml.match(/<div class="discord-embed-description">([\s\S]*?)<\/div>/);

  const fields: { name: string; value: string; inline: boolean }[] = [];
  const fieldRegex = /<div class="discord-embed-field\s*(inline)?\s*">\s*<div class="discord-embed-field-name">([^<]*)<\/div>\s*<div class="discord-embed-field-value">([\s\S]*?)<\/div>/g;
  let fieldMatch;
  while ((fieldMatch = fieldRegex.exec(embedHtml)) !== null) {
    fields.push({
      name: unescapeHtml(fieldMatch[2]),
      value: unescapeHtml(stripHtmlTags(fieldMatch[3])),
      inline: !!fieldMatch[1]
    });
  }

  const thumbnailMatch = embedHtml.match(/<img class="discord-embed-thumbnail" src="([^"]*?)"/);
  const imageMatch = embedHtml.match(/<img class="discord-embed-image" src="([^"]*?)"/);
  const footerTextMatch = embedHtml.match(/<span class="discord-embed-footer-text">\s*([\s\S]*?)\s*<\/span>/);
  const footerIconMatch = embedHtml.match(/<img class="discord-embed-footer-icon" src="([^"]*?)"/);

  return {
    color: colorMatch ? colorMatch[1].trim() : null,
    authorName: authorLinkMatch ? unescapeHtml(authorLinkMatch[2]) : (authorSpanMatch ? unescapeHtml(authorSpanMatch[1]) : null),
    authorIconUrl: authorIconMatch ? authorIconMatch[1] : null,
    authorUrl: authorLinkMatch ? authorLinkMatch[1] : null,
    title: titleLinkMatch ? unescapeHtml(titleLinkMatch[2]) : (titlePlainMatch ? unescapeHtml(titlePlainMatch[1].trim()) : null),
    url: titleLinkMatch ? titleLinkMatch[1] : null,
    description: descMatch ? unescapeHtml(stripHtmlTags(descMatch[1])) : null,
    fields,
    thumbnailUrl: thumbnailMatch ? thumbnailMatch[1] : null,
    imageUrl: imageMatch ? imageMatch[1] : null,
    footerText: footerTextMatch ? unescapeHtml(footerTextMatch[1].replace(/\s*•\s*.*$/, '').trim()) : null,
    footerIconUrl: footerIconMatch ? footerIconMatch[1] : null,
  };
}

export function parseTranscriptHtml(html: string): ParsedTranscriptMessage[] {
  const messages: ParsedTranscriptMessage[] = [];

  // Split on message-group boundaries to get each message block
  const blocks = html.split(/<div class="message-group">/);
  blocks.shift(); // remove content before first message

  for (const rawBlock of blocks) {
    // Re-add the opening tag for consistency
    const block = `<div class="message-group">${rawBlock}`;

    const avatarMatch = block.match(/<img class="avatar" src="([^"]*?)"/);
    const usernameMatch = block.match(/<span class="username"[^>]*>([^<]*)<\/span>/);
    const isBotMatch = block.match(/<span class="bot-tag">BOT<\/span>/);
    const timestampMatch = block.match(/<span class="timestamp">([^<]*)<\/span>/);
    const textMatch = block.match(/<div class="message-text">([\s\S]*?)<\/div>/);

    if (!usernameMatch) continue;

    const rawContent = textMatch ? stripHtmlTags(textMatch[1]) : '';
    const content = unescapeHtml(rawContent);

    // Extract embeds
    const embeds: ParsedTranscriptEmbed[] = [];
    const embedRegex = /<div class="discord-embed"[\s\S]*?(?=<div class="discord-embed"|<div class="message-group">|<div class="reactions-list">|$)/g;
    let embedMatch;
    while ((embedMatch = embedRegex.exec(block)) !== null) {
      embeds.push(parseEmbedFromHtml(embedMatch[0]));
    }

    // Extract standalone images (attachments)
    const imageUrls: string[] = [];
    const imgRegex = /<img src="([^"]*?)" class="discord-img"/g;
    let imgMatch;
    while ((imgMatch = imgRegex.exec(block)) !== null) {
      imageUrls.push(imgMatch[1]);
    }

    messages.push({
      avatarUrl: avatarMatch ? avatarMatch[1] : '',
      username: unescapeHtml(usernameMatch[1]),
      isBot: !!isBotMatch,
      timestamp: timestampMatch ? timestampMatch[1] : '',
      content,
      embeds,
      imageUrls
    });
  }

  return messages;
}

/**
 * Escapes HTML tags to prevent XSS.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Parses basic Discord markdown: **bold**, *italic*, __underline__, ~~strike~~, `code`, and blockquotes.
 */
export function parseMarkdown(text: string, guild?: Guild): string {
  let escaped = escapeHtml(text);

  // 1. Extract block code
  const blockCodes: string[] = [];
  escaped = escaped.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const placeholder = `%%BLOCK_CODE_PLACEHOLDER_${blockCodes.length}%%`;
    blockCodes.push(`<pre><code class="block-code language-${lang || 'plaintext'}">${code}</code></pre>`);
    return placeholder;
  });

  // 2. Extract inline code
  const inlineCodes: string[] = [];
  escaped = escaped.replace(/`(.*?)`/g, (_, code) => {
    const placeholder = `%%INLINE_CODE_PLACEHOLDER_${inlineCodes.length}%%`;
    inlineCodes.push(`<code class="inline-code">${code}</code>`);
    return placeholder;
  });

  // 3. Masked links `[libelle](url)` / `[libelle](<url>)`. L'ancre produite est
  // mise de cote : sans ca l'auto-lien de l'etape suivante relierait l'URL
  // presente dans le href.
  const maskedLinks: string[] = [];
  escaped = escaped.replace(
    /\[((?:[^[\]\\]|\\.)+)\]\((?:&lt;)?(https?:\/\/[^\s)]+?)(?:&gt;)?\)/g,
    (_full: string, label: string, url: string) => {
      const cleanLabel = label.replace(/\\([[\]])/g, '$1');
      const placeholder = `%%MASKED_LINK_PLACEHOLDER_${maskedLinks.length}%%`;
      maskedLinks.push(`<a href="${url}" target="_blank" class="discord-link">${cleanLabel}</a>`);
      return placeholder;
    }
  );

  // 4. Auto-link URLs
  escaped = escaped.replace(/(https?:\/\/[^\s<]+)/g, (url) => {
    let cleanUrl = url;
    let trailing = '';
    
    if (cleanUrl.endsWith('&gt;')) {
      cleanUrl = cleanUrl.slice(0, -4);
      trailing = '&gt;';
    }
    
    const match = cleanUrl.match(/([.,;:!?)\]]+)$/);
    if (match) {
      cleanUrl = cleanUrl.substring(0, cleanUrl.length - match[0].length);
      trailing = match[0] + trailing;
    }
    
    return `<a href="${cleanUrl}" target="_blank" class="discord-link">${cleanUrl}</a>${trailing}`;
  });

  // 5. Bold, Italic, Underline, Strikethrough
  escaped = escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  escaped = escaped.replace(/\*(.*?)\*/g, '<em>$1</em>');
  escaped = escaped.replace(/__(.*?)__/g, '<u>$1</u>');
  escaped = escaped.replace(/~~(.*?)~~/g, '<del>$1</del>');

  // 6. Custom emojis: &lt;a:name:id&gt; or &lt;:name:id&gt;
  escaped = escaped.replace(/&lt;a:([a-zA-Z0-9_]+):(\d+)&gt;/g, '<img class="discord-emoji" src="https://cdn.discordapp.com/emojis/$2.gif" alt=":$1:" title=":$1:" />');
  escaped = escaped.replace(/&lt;:([a-zA-Z0-9_]+):(\d+)&gt;/g, '<img class="discord-emoji" src="https://cdn.discordapp.com/emojis/$2.png" alt=":$1:" title=":$1:" />');

  // 7. User/Channel/Role mentions
  if (guild) {
    escaped = escaped.replace(/&lt;@!?(\d+)&gt;/g, (_, id) => {
      const member = guild.members.cache.get(id);
      const user = guild.client.users.cache.get(id);
      const name = member?.displayName || user?.username || 'Utilisateur inconnu';
      return `<span class="mention">@${escapeHtml(name)}</span>`;
    });
    escaped = escaped.replace(/&lt;#(\d+)&gt;/g, (_, id) => {
      const ch = guild.channels.cache.get(id);
      return `<span class="mention">#${ch ? escapeHtml(ch.name) : 'salon-inconnu'}</span>`;
    });
    escaped = escaped.replace(/&lt;@&amp;(\d+)&gt;/g, (_, id) => {
      const role = guild.roles.cache.get(id);
      return `<span class="mention">@${role ? escapeHtml(role.name) : 'rôle-inconnu'}</span>`;
    });
  } else {
    escaped = escaped.replace(/&lt;@!?(\d+)&gt;/g, '<span class="mention">@Utilisateur</span>');
    escaped = escaped.replace(/&lt;#(\d+)&gt;/g, '<span class="mention">#salon</span>');
    escaped = escaped.replace(/&lt;@&amp;(\d+)&gt;/g, '<span class="mention">@Rôle</span>');
  }

  // 8. Restore inline code
  inlineCodes.forEach((html, index) => {
    escaped = escaped.replace(`%%INLINE_CODE_PLACEHOLDER_${index}%%`, html);
  });

  // 9. Restore block code
  blockCodes.forEach((html, index) => {
    escaped = escaped.replace(`%%BLOCK_CODE_PLACEHOLDER_${index}%%`, html);
  });

  // 10. Restore masked links
  maskedLinks.forEach((html, index) => {
    escaped = escaped.replace(`%%MASKED_LINK_PLACEHOLDER_${index}%%`, html);
  });

  return escaped;
}

/**
 * Resolves Discord mentions (<@id>, <#id>, <@&id>) in raw (non-escaped) message
 * text into plain readable text (@Pseudo, #salon, @Rôle) - no HTML produced.
 * Used by API responses that are rendered client-side without {@html}.
 */
export function resolveMentionsToText(text: string, guild?: Guild): string {
  if (!guild) {
    return text
      .replace(/<@!?(\d+)>/g, '@Utilisateur')
      .replace(/<#(\d+)>/g, '#salon')
      .replace(/<@&(\d+)>/g, '@Rôle');
  }

  return text
    .replace(/<@!?(\d+)>/g, (_, id) => {
      const member = guild.members.cache.get(id);
      const user = guild.client.users.cache.get(id);
      return `@${member?.displayName || user?.username || 'Utilisateur inconnu'}`;
    })
    .replace(/<#(\d+)>/g, (_, id) => `#${guild.channels.cache.get(id)?.name || 'salon-inconnu'}`)
    .replace(/<@&(\d+)>/g, (_, id) => `@${guild.roles.cache.get(id)?.name || 'rôle-inconnu'}`);
}

/**
 * Builds a plain-data representation of a Discord embed (no HTML), suitable
 * for client-side Svelte rendering without {@html}.
 */
export function embedToApiShape(embed: Embed, guild?: Guild): ParsedTranscriptEmbed {
  return {
    color: embed.hexColor,
    authorName: embed.author?.name ?? null,
    authorIconUrl: embed.author?.iconURL ?? null,
    authorUrl: embed.author?.url ?? null,
    title: embed.title,
    url: embed.url,
    description: embed.description ? resolveMentionsToText(embed.description, guild) : null,
    fields: (embed.fields ?? []).map((f) => ({
      name: f.name,
      value: resolveMentionsToText(f.value, guild),
      inline: f.inline ?? false,
    })),
    thumbnailUrl: embed.thumbnail?.url ?? null,
    imageUrl: embed.image?.url ?? null,
    footerText: embed.footer?.text ?? null,
    footerIconUrl: embed.footer?.iconURL ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Components V2 rendering
//
// The bot patches every send/reply method (see utils/patchV2.ts) so that legacy
// `embeds` are converted into Components V2 containers. As a result, messages
// sent by the bot carry an EMPTY `msg.embeds` array and their real content lives
// in `msg.components`. The transcript must therefore render Components V2 too,
// otherwise every bot "embed" disappears from the transcript.
// ─────────────────────────────────────────────────────────────────────────────

interface V2Node {
  type: number;
  content?: string;
  components?: V2Node[];
  accessory?: V2Node;
  items?: { media?: { url?: string }; description?: string }[];
  media?: { url?: string };
  file?: { url?: string };
  name?: string;
  divider?: boolean;
  accent_color?: number | null;
  accentColor?: number | null;
  label?: string;
  url?: string;
  emoji?: { id?: string | null; name?: string | null; animated?: boolean } | null;
}

function v2ColorToHex(color: unknown): string | null {
  if (typeof color === 'number' && Number.isFinite(color)) {
    return '#' + (color & 0xffffff).toString(16).padStart(6, '0');
  }
  return null;
}

/**
 * Parses Discord markdown for a V2 text block, additionally handling
 * block-level headings (`#`, `##`, `###`) and subtext (`-#`) that Components V2
 * relies on heavily.
 */
function parseV2Markdown(text: string, guild?: Guild): string {
  let html = parseMarkdown(text, guild);
  html = html
    .replace(/^\s*-#\s+(.*)$/gm, '<span class="v2-subtext">$1</span>')
    .replace(/^\s*###\s+(.*)$/gm, '<span class="v2-heading v2-h3">$1</span>')
    .replace(/^\s*##\s+(.*)$/gm, '<span class="v2-heading v2-h2">$1</span>')
    .replace(/^\s*#\s+(.*)$/gm, '<span class="v2-heading v2-h1">$1</span>');
  return html;
}

function renderV2Emoji(emoji?: V2Node['emoji']): string {
  if (!emoji) return '';
  if (emoji.id) {
    const ext = emoji.animated ? 'gif' : 'png';
    return `<img class="discord-emoji" src="https://cdn.discordapp.com/emojis/${emoji.id}.${ext}" alt=":${escapeHtml(emoji.name || '')}:" /> `;
  }
  return emoji.name ? `${escapeHtml(emoji.name)} ` : '';
}

function renderV2Button(node: V2Node): string {
  const label = escapeHtml(node.label || '');
  const emoji = renderV2Emoji(node.emoji);
  const inner = `${emoji}${label}`.trim() || '-';
  if (node.url) {
    return `<a class="discord-button" href="${node.url}" target="_blank">${inner}</a>`;
  }
  return `<span class="discord-button">${inner}</span>`;
}

function renderV2Media(items: V2Node['items'], _guild?: Guild): string {
  const imgs = (items || [])
    .filter((it) => it.media?.url)
    .map((it) => `<img class="discord-embed-image" src="${it.media!.url}" alt="${escapeHtml(it.description || '')}" loading="lazy" />`)
    .join('');
  if (!imgs) return '';
  return `<div class="discord-embed-image-container">${imgs}</div>`;
}

function renderV2File(node: V2Node): string {
  const url = node.file?.url;
  if (!url) return '';
  const name = node.name || url.split('/').pop() || 'fichier';
  return `
    <div class="attachment-card">
      <span class="attachment-icon">📁</span>
      <div class="attachment-info">
        <a href="${url}" target="_blank" class="attachment-name">${escapeHtml(name)}</a>
      </div>
    </div>
  `;
}

function renderV2Section(node: V2Node, guild?: Guild): string {
  const texts = (node.components || [])
    .filter((c) => c.type === ComponentType.TextDisplay)
    .map((c) => `<div class="v2-text">${parseV2Markdown(c.content || '', guild)}</div>`)
    .join('');

  const acc = node.accessory;
  let accessoryHtml = '';
  if (acc?.type === ComponentType.Thumbnail && acc.media?.url) {
    accessoryHtml = `<img class="discord-embed-thumbnail" src="${acc.media.url}" alt="" />`;
  } else if (acc?.type === ComponentType.Button) {
    accessoryHtml = renderV2Button(acc);
  }

  if (accessoryHtml) {
    return `<div class="v2-section"><div class="v2-section-text">${texts}</div><div class="v2-section-accessory">${accessoryHtml}</div></div>`;
  }
  return texts;
}

function renderV2ActionRow(node: V2Node): string {
  const buttons = (node.components || [])
    .filter((c) => c.type === ComponentType.Button)
    .map((b) => renderV2Button(b))
    .join('');
  return buttons ? `<div class="discord-buttons-row">${buttons}</div>` : '';
}

/** Renders the children of a container node into embed-body HTML. */
function renderV2Child(node: V2Node, guild?: Guild): string {
  switch (node.type) {
    case ComponentType.TextDisplay:
      return `<div class="v2-text">${parseV2Markdown(node.content || '', guild)}</div>`;
    case ComponentType.Section:
      return renderV2Section(node, guild);
    case ComponentType.Separator:
      return node.divider === false ? '<div class="v2-separator-space"></div>' : '<div class="v2-separator-line"></div>';
    case ComponentType.MediaGallery:
      return renderV2Media(node.items, guild);
    case ComponentType.File:
      return renderV2File(node);
    case ComponentType.ActionRow:
      return renderV2ActionRow(node);
    default:
      return '';
  }
}

function renderV2Container(node: V2Node, guild?: Guild): string {
  const hex = v2ColorToHex(node.accent_color ?? node.accentColor) || '#1e1f22';
  const inner = (node.components || []).map((child) => renderV2Child(child, guild)).join('');
  return `
    <div class="discord-embed" style="border-left-color: ${hex}">
      <div class="discord-embed-content">
        <div class="discord-embed-text">${inner}</div>
      </div>
    </div>
  `;
}

/**
 * Renders a message's top-level Components V2 tree into transcript HTML.
 * Containers become embed-like blocks; loose text/sections/media/action rows
 * render inline like normal message content.
 */
function renderV2ComponentsHtml(components: unknown[], guild?: Guild): string {
  let html = '';
  for (const raw of components) {
    let node: V2Node | undefined;
    if (raw && typeof (raw as { toJSON?: unknown }).toJSON === 'function') {
      try {
        node = (raw as { toJSON: () => V2Node }).toJSON();
      } catch {
        node = raw as V2Node;
      }
    } else {
      node = raw as V2Node;
    }
    if (!node || typeof node.type !== 'number') continue;

    switch (node.type) {
      case ComponentType.Container:
        html += renderV2Container(node, guild);
        break;
      case ComponentType.TextDisplay:
        html += `<div class="message-text">${parseV2Markdown(node.content || '', guild)}</div>`;
        break;
      case ComponentType.Section:
        html += renderV2Section(node, guild);
        break;
      case ComponentType.MediaGallery:
        html += renderV2Media(node.items, guild);
        break;
      case ComponentType.File:
        html += renderV2File(node);
        break;
      case ComponentType.ActionRow:
        html += renderV2ActionRow(node);
        break;
      default:
        break;
    }
  }
  return html;
}

/**
 * Generates an HTML transcript of all messages in a channel and stores it in the DB.
 */
export async function generateTranscript(channel: TextChannel): Promise<{ id: string; url: string; count: number }> {
  logger.info('Transcript', `Génération de la transcription pour #${channel.name} (${channel.id})...`);
  
  // 1. Fetch ALL messages in chronological order
  const allMessages: Message[] = [];
  let lastId: string | undefined;

  for (;;) {
    const options = { limit: 100, before: lastId };
    const messages = await channel.messages.fetch(options);
    if (messages.size === 0) break;
    allMessages.push(...messages.values());
    lastId = messages.last()?.id;
  }

  // Reverse so they are in chronological order (oldest to newest)
  allMessages.reverse();

  return generateTranscriptFromMessages(channel, allMessages);
}

export async function generateTranscriptFromMessages(channel: TextChannel | NewsChannel, allMessages: Message[]): Promise<{ id: string; url: string; count: number }> {
  // 2. Build the HTML content
  const messagesHtmlChunks: string[] = [];
  const timestampFormatter = new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  
  for (const msg of allMessages) {
    const author = msg.author;
    const avatarUrl = author.displayAvatarURL({ size: 64 });
    const username = msg.member?.displayName || author.displayName || author.username;
    
    // Role color fallback
    const roleColor = msg.member?.roles.highest?.color 
      ? '#' + msg.member.roles.highest.color.toString(16).padStart(6, '0') 
      : '#f2f3f5';

    const timestamp = timestampFormatter.format(msg.createdAt);

    let bodyHtml = '';
    if (msg.content) {
      bodyHtml += `<div class="message-text">${parseMarkdown(msg.content, channel.guild)}</div>`;
    }

    // Process attachments
    if (msg.attachments.size > 0) {
      for (const [_, attachment] of msg.attachments) {
        const contentType = attachment.contentType || '';
        if (contentType.startsWith('image/')) {
          bodyHtml += `<img src="${attachment.url}" class="discord-img" alt="Image jointe" loading="lazy" />`;
        } else if (contentType.startsWith('video/')) {
          bodyHtml += `<video src="${attachment.url}" controls class="discord-video"></video>`;
        } else {
          // File download card
          const fileSize = (attachment.size / 1024).toFixed(1) + ' KB';
          bodyHtml += `
            <div class="attachment-card">
              <span class="attachment-icon">📁</span>
              <div class="attachment-info">
                <a href="${attachment.url}" target="_blank" class="attachment-name">${escapeHtml(attachment.name)}</a>
                <span class="attachment-size">${fileSize}</span>
              </div>
            </div>
          `;
        }
      }
    }

    // Process stickers
    if (msg.stickers && msg.stickers.size > 0) {
      for (const [_, sticker] of msg.stickers) {
        bodyHtml += `
          <div class="sticker-container">
            <img src="${sticker.url}" class="discord-sticker" alt="${escapeHtml(sticker.name)}" title="${escapeHtml(sticker.name)}" />
          </div>
        `;
      }
    }

    // Process embeds
    if (msg.embeds.length > 0) {
      for (const embed of msg.embeds) {
        const borderHex = embed.hexColor || '#1e1f22';
        bodyHtml += `
          <div class="discord-embed" style="border-left-color: ${borderHex}">
            <div class="discord-embed-content">
              <div class="discord-embed-text">
                ${embed.provider && embed.provider.name ? `<div class="discord-embed-provider">${escapeHtml(embed.provider.name || '')}</div>` : ''}
                ${embed.author ? `
                  <div class="discord-embed-author">
                    ${embed.author.iconURL ? `<img class="discord-embed-author-icon" src="${embed.author.iconURL}" alt="" />` : ''}
                    ${embed.author.url ? `<a class="discord-embed-author-link" href="${embed.author.url}" target="_blank">${escapeHtml(embed.author.name)}</a>` : `<span>${escapeHtml(embed.author.name)}</span>`}
                  </div>
                ` : ''}
                ${embed.title ? `
                  <div class="discord-embed-title">
                    ${embed.url ? `<a href="${embed.url}" target="_blank">${escapeHtml(embed.title)}</a>` : escapeHtml(embed.title)}
                  </div>
                ` : ''}
                ${embed.description ? `<div class="discord-embed-description">${parseMarkdown(embed.description, channel.guild)}</div>` : ''}
                ${embed.fields && embed.fields.length > 0 ? `
                  <div class="discord-embed-fields">
                    ${embed.fields.map(f => `
                      <div class="discord-embed-field ${f.inline ? 'inline' : ''}">
                        <div class="discord-embed-field-name">${escapeHtml(f.name)}</div>
                        <div class="discord-embed-field-value">${parseMarkdown(f.value, channel.guild)}</div>
                      </div>
                    `).join('')}
                  </div>
                ` : ''}
              </div>
              ${embed.thumbnail ? `
                <div class="discord-embed-thumbnail-container">
                  <img class="discord-embed-thumbnail" src="${embed.thumbnail.url}" alt="" />
                </div>
              ` : ''}
            </div>
            ${embed.image ? `
              <div class="discord-embed-image-container">
                <img class="discord-embed-image" src="${embed.image.url}" alt="" />
              </div>
            ` : ''}
            ${embed.video && !embed.image ? `
              <div class="discord-embed-video-container">
                <video class="discord-embed-video" src="${embed.video.url}" controls></video>
              </div>
            ` : ''}
            ${embed.footer ? `
              <div class="discord-embed-footer">
                ${embed.footer.iconURL ? `<img class="discord-embed-footer-icon" src="${embed.footer.iconURL}" alt="" />` : ''}
                <span class="discord-embed-footer-text">
                  ${escapeHtml(embed.footer.text)}
                  ${embed.timestamp ? ` • ${new Date(embed.timestamp).toLocaleString('fr-FR')}` : ''}
                </span>
              </div>
            ` : ''}
          </div>
        `;
      }
    }

    // Process Components V2 (containers rendered as embeds, text displays, sections,
    // media galleries and action rows). The bot converts all legacy embeds into V2
    // containers (utils/patchV2.ts), so without this bot embeds would be missing.
    if (msg.components && msg.components.length > 0) {
      bodyHtml += renderV2ComponentsHtml(msg.components as unknown[], channel.guild);
    }

    // Process reactions
    if (msg.reactions.cache.size > 0) {
      bodyHtml += '<div class="reactions-list">';
      for (const [_, reaction] of msg.reactions.cache) {
        const emojiName = reaction.emoji.name;
        const count = reaction.count;
        if (reaction.emoji.url) {
          bodyHtml += `
            <span class="reaction-tag">
              <img class="discord-emoji-reaction" src="${reaction.emoji.url}" alt=":${emojiName}:" title=":${emojiName}:" />
              <span class="reaction-count">${count}</span>
            </span>
          `;
        } else {
          bodyHtml += `
            <span class="reaction-tag">
              ${emojiName}
              <span class="reaction-count">${count}</span>
            </span>
          `;
        }
      }
      bodyHtml += '</div>';
    }

    messagesHtmlChunks.push(`
      <div class="message-group">
        <img class="avatar" src="${avatarUrl}" alt="${escapeHtml(author.username)}" />
        <div class="message-content">
          <div class="message-header">
            <span class="username" style="color: ${roleColor}">${escapeHtml(username)}</span>
            ${author.bot ? '<span class="bot-tag">BOT</span>' : ''}
            <span class="timestamp">${timestamp}</span>
          </div>
          ${bodyHtml}
        </div>
      </div>
    `);
  }

  // Un seul assemblage évite les recopies quadratiques sur les salons de
  // plusieurs milliers de messages.
  const messagesHtml = messagesHtmlChunks.join('');
  const generatedAt = new Date();

  // Generate full HTML template
  const fullHtml = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <title>Transcription Kotbo - #${channel.name}</title>
  <style>
    body {
      background-color: #313338;
      color: #dbdee1;
      font-family: 'gg sans', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      margin: 0;
      padding: 24px;
      display: flex;
      justify-content: center;
    }
    .container {
      width: 100%;
      max-width: 900px;
      background-color: #313338;
    }
    .transcript-header {
      border-bottom: 1px solid #3f4147;
      padding-bottom: 20px;
      margin-bottom: 24px;
    }
    .channel-name {
      font-size: 26px;
      font-weight: 700;
      color: #f2f3f5;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .channel-hashtag {
      color: #80848e;
      font-size: 32px;
      font-weight: 300;
    }
    .channel-topic {
      font-size: 14px;
      color: #949ba4;
      margin-top: 6px;
      line-height: 1.4;
    }
    .message-group {
      display: flex;
      margin-bottom: 20px;
      gap: 16px;
    }
    .avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background-color: #5865F2;
      flex-shrink: 0;
    }
    .message-content {
      display: flex;
      flex-direction: column;
      gap: 4px;
      width: calc(100% - 56px);
    }
    .message-header {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .username {
      font-weight: 600;
      font-size: 16px;
      cursor: pointer;
    }
    .username:hover {
      text-decoration: underline;
    }
    .bot-tag {
      background-color: #5865f2;
      color: #ffffff;
      font-size: 10px;
      font-weight: 700;
      padding: 1px 4.5px;
      border-radius: 3px;
      line-height: 1.3;
    }
    .timestamp {
      font-size: 12px;
      color: #949ba4;
    }
    .message-text {
      font-size: 15px;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
      color: #dbdee1;
    }
    .inline-code {
      background: #1e1f22;
      padding: 2px 4px;
      border-radius: 4px;
      font-family: Consolas, Andale Mono WT, Andale Mono, Lucida Console, Monaco, monospace;
      font-size: 85%;
    }
    .block-code {
      display: block;
      background: #1e1f22;
      border: 1px solid #2b2d31;
      padding: 10px;
      border-radius: 4px;
      font-family: Consolas, Andale Mono WT, Andale Mono, Lucida Console, Monaco, monospace;
      font-size: 90%;
      color: #dbdee1;
      overflow-x: auto;
      margin: 8px 0;
    }
    .mention {
      color: #c9cdfb;
      background-color: rgba(88, 101, 242, 0.3);
      padding: 0 4px;
      border-radius: 3px;
      font-weight: 500;
      transition: background-color 0.05s ease;
    }
    .mention:hover {
      background-color: #5865f2;
      color: #ffffff;
    }
    .attachment-card {
      background-color: #2b2d31;
      border: 1px solid #1e1f22;
      border-radius: 8px;
      padding: 12px;
      display: flex;
      align-items: center;
      gap: 12px;
      max-width: 450px;
      margin-top: 8px;
    }
    .attachment-icon {
      font-size: 28px;
    }
    .attachment-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .attachment-name {
      color: #00a8fc;
      text-decoration: none;
      font-weight: 500;
      font-size: 14px;
    }
    .attachment-name:hover {
      text-decoration: underline;
    }
    .attachment-size {
      font-size: 12px;
      color: #949ba4;
    }
    .discord-img {
      max-width: 100%;
      max-height: 350px;
      border-radius: 8px;
      margin-top: 8px;
      display: block;
    }
    .discord-video {
      max-width: 100%;
      max-height: 350px;
      border-radius: 8px;
      margin-top: 8px;
      display: block;
    }
    .discord-embed {
      background-color: #2b2d31;
      border-left: 4px solid #1e1f22;
      border-radius: 4px;
      padding: 12px 16px;
      margin-top: 8px;
      max-width: 520px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .discord-embed-author {
      font-size: 13px;
      color: #f2f3f5;
      font-weight: 600;
    }
    .discord-embed-title {
      font-size: 16px;
      color: #00a8fc;
      font-weight: 600;
    }
    .discord-embed-description {
      font-size: 14px;
      color: #dbdee1;
      line-height: 1.4;
    }
    .discord-embed-fields {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 8px;
    }
    .discord-embed-field {
      flex: 1 1 100%;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .discord-embed-field.inline {
      flex: 1 1 45%;
    }
    .discord-embed-field-name {
      font-size: 12px;
      color: #949ba4;
      font-weight: 600;
    }
    .discord-embed-field-value {
      font-size: 14px;
      color: #dbdee1;
    }
    .reactions-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 8px;
    }
    .reaction-tag {
      background-color: #2b2d31;
      border: 1px solid transparent;
      border-radius: 8px;
      padding: 4px 8px;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .reaction-count {
      color: #b5bac1;
      font-size: 12px;
      font-weight: 600;
    }
    .discord-emoji {
      width: 22px;
      height: 22px;
      min-width: 22px;
      min-height: 22px;
      object-fit: contain;
      vertical-align: bottom;
      display: inline-block;
      margin: 0 1px;
    }
    .discord-emoji-reaction {
      width: 16px;
      height: 16px;
      object-fit: contain;
      vertical-align: middle;
      display: inline-block;
    }
    .sticker-container {
      margin-top: 8px;
    }
    .discord-sticker {
      width: 160px;
      height: 160px;
      object-fit: contain;
    }
    .discord-link {
      color: #00a8fc;
      text-decoration: none;
    }
    .discord-link:hover {
      text-decoration: underline;
    }
    .discord-embed-content {
      display: flex;
      justify-content: space-between;
      gap: 16px;
    }
    .discord-embed-text {
      flex-grow: 1;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .discord-embed-provider {
      font-size: 12px;
      color: #949ba4;
    }
    .discord-embed-author {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 600;
    }
    .discord-embed-author-icon {
      width: 24px;
      height: 24px;
      border-radius: 50%;
    }
    .discord-embed-author-link {
      color: #f2f3f5;
      text-decoration: none;
    }
    .discord-embed-author-link:hover {
      text-decoration: underline;
    }
    .discord-embed-title a {
      color: #00a8fc;
      text-decoration: none;
    }
    .discord-embed-title a:hover {
      text-decoration: underline;
    }
    .discord-embed-thumbnail-container {
      flex-shrink: 0;
    }
    .discord-embed-thumbnail {
      max-width: 80px;
      max-height: 80px;
      border-radius: 4px;
      object-fit: contain;
    }
    .discord-embed-image-container {
      margin-top: 8px;
      border-radius: 4px;
      overflow: hidden;
    }
    .discord-embed-image {
      max-width: 100%;
      max-height: 400px;
      object-fit: contain;
      border-radius: 4px;
    }
    .discord-embed-video-container {
      margin-top: 8px;
      border-radius: 4px;
      overflow: hidden;
    }
    .discord-embed-video {
      max-width: 100%;
      max-height: 400px;
      border-radius: 4px;
    }
    .discord-embed-footer {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      font-size: 12px;
      color: #949ba4;
    }
    .discord-embed-footer-icon {
      width: 20px;
      height: 20px;
      border-radius: 50%;
    }
    .v2-text {
      font-size: 14px;
      color: #dbdee1;
      line-height: 1.4;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .v2-heading {
      display: block;
      font-weight: 700;
      color: #f2f3f5;
      margin: 4px 0 2px;
    }
    .v2-h1 { font-size: 20px; }
    .v2-h2 { font-size: 17px; }
    .v2-h3 { font-size: 15px; }
    .v2-subtext {
      display: block;
      font-size: 12px;
      color: #949ba4;
    }
    .v2-separator-line {
      border-top: 1px solid #3f4147;
      margin: 8px 0;
    }
    .v2-separator-space {
      height: 8px;
    }
    .v2-section {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-start;
    }
    .v2-section-text {
      flex-grow: 1;
      min-width: 0;
    }
    .v2-section-accessory {
      flex-shrink: 0;
    }
    .discord-buttons-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 8px;
    }
    .discord-button {
      background-color: #4e5058;
      color: #ffffff;
      font-size: 14px;
      font-weight: 500;
      padding: 6px 12px;
      border-radius: 6px;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      line-height: 1.2;
    }
    a.discord-button {
      background-color: #4e5058;
    }
    .footer {
      border-top: 1px solid #3f4147;
      padding-top: 16px;
      margin-top: 36px;
      text-align: center;
      font-size: 12px;
      color: #949ba4;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="transcript-header">
      <div class="channel-name">
        <span class="channel-hashtag">#</span>
        <span>${escapeHtml(channel.name)}</span>
      </div>
      <div class="channel-topic">
        Transcription de salon générée par Kotbo · ${allMessages.length} messages transcrits.
        ${channel.topic ? `<br/><br/><strong>Sujet :</strong> ${escapeHtml(channel.topic)}` : ''}
      </div>
    </div>

    <div class="messages">
      ${messagesHtml}
    </div>

    <div class="footer">
      Généré avec amour par Kotbo · ${generatedAt.toLocaleDateString('fr-FR')} ${generatedAt.toLocaleTimeString('fr-FR')}
    </div>
  </div>
</body>
</html>`;

  // 3. Save to database
  const firstMsg = allMessages[0];
  const lastMsg = allMessages[allMessages.length - 1];

  const transcript = await prisma.transcript.create({
    data: {
      guildId: channel.guild.id,
      channelId: channel.id,
      channelName: channel.name,
      html: fullHtml,
      startMessageId: firstMsg?.id || null,
      endMessageId: lastMsg?.id || null,
      startTime: firstMsg?.createdAt || null,
      endTime: lastMsg?.createdAt || null
    }
  });

  const url = `/transcripts/${transcript.id}`;
  logger.success('Transcript', `Transcription générée avec succès pour #${channel.name} (${allMessages.length} messages) : ID ${transcript.id}`);

  return {
    id: transcript.id,
    url,
    count: allMessages.length
  };
}
