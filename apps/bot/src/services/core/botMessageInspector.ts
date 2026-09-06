/**
 * Ce que les messages deja postes disent de la configuration.
 *
 * Le scan par noms de salons repond a « ou », jamais a « quoi » : il trouve le
 * salon de bienvenue, pas le message qu'on y poste. Or ce message existe - il
 * est affiche, dans ce salon, depuis des mois. Le lire evite de demander a
 * quelqu'un de reecrire un texte qu'il a deja ecrit une fois.
 *
 * Quatre lectures, toutes sur le meme principe : on ne propose que ce qu'on a
 * vu, on dit ou on l'a vu, et on montre ce qui sera ecrit avant de l'ecrire.
 *
 *  - le dernier message de bienvenue poste par un autre bot ;
 *  - les articles d'un reglement deja redige ;
 *  - le panneau de tickets et ses sujets, lus dans ses boutons ;
 *  - les couples emoji -> role d'un menu de roles.
 *
 * Ce que ces lectures rendent reste approximatif : un texte compose par un
 * autre bot ne porte plus ses variables, une ligne de reglement n'a pas
 * toujours de titre. D'ou `payload`, qui est exactement ce qui sera ecrit et
 * que le dashboard affiche tel quel. La relecture par le staff fait partie du
 * procede ; ce n'est pas une precaution ajoutee apres coup.
 */
import {
  ChannelType,
  ComponentType,
  PermissionFlagsBits,
  type Embed,
  type Guild,
  type GuildBasedChannel,
  type Message,
} from 'discord.js';
import type { BotFeature } from './botRegistry.js';

/** Salons ou chercher, deja reperes par leur nom cote scan. */
export type InspectionTargets = {
  welcome: GuildBasedChannel[];
  rules: GuildBasedChannel[];
  tickets: GuildBasedChannel[];
  roles: GuildBasedChannel[];
};

/**
 * Ce qui sera ecrit si la proposition est retenue.
 *
 * Ces objets partent aussi au dashboard : l'apercu montre la valeur exacte que
 * l'application posera, pas une reformulation. Une reprise qu'on relit avant
 * de l'appliquer ne surprend pas apres.
 */
export type InspectionPayload =
  | {
      kind: 'welcome';
      channelId: string;
      message: string;
    }
  | {
      kind: 'rules';
      channelId: string;
      articles: { emoji: string | null; title: string; description: string }[];
    }
  | {
      kind: 'ticketPanel';
      channelId: string;
      title: string;
      description: string;
      buttonText: string;
      color: string | null;
      embedType: 'BUTTONS' | 'DROPDOWN';
      types: { id: string; label: string; description: string; emoji: string }[];
    }
  | {
      kind: 'reactionRoles';
      channelId: string;
      title: string;
      options: { emoji: string; label: string; roleId: string }[];
    };

/** Un constat tire des messages, dans la forme attendue par le scan. */
export type InspectedFinding = {
  key: string;
  feature: BotFeature;
  title: string;
  detail: string;
  action: string;
  entities: { id: string; name: string }[];
  payload: InspectionPayload;
};

/** Messages lus par salon. Au-dela, on paie des appels pour du bruit. */
const HISTORY_LIMIT = 50;
/** Salons lus par famille : le premier qui donne quelque chose suffit. */
const CHANNEL_LIMIT = 3;

// ── Lecture ─────────────────────────────────────────────────────────────────

/**
 * Historique d'un salon, du plus ancien au plus recent.
 *
 * Les permissions sont verifiees avant l'appel plutot qu'apres l'echec : sur un
 * serveur ou Kotbo vient d'arriver, la moitie des salons lui sont fermes, et
 * autant d'erreurs 403 dans les logs masqueraient les vraies.
 */
async function readHistory(guild: Guild, channel: GuildBasedChannel): Promise<Message[]> {
  if (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement) return [];

  const me = guild.members.me;
  const allowed = me
    ? channel
        .permissionsFor(me)
        ?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])
    : false;
  if (!allowed) return [];

  const fetched = await channel.messages.fetch({ limit: HISTORY_LIMIT }).catch(() => null);
  if (!fetched) return [];

  return Array.from(fetched.values()).reverse();
}

/** Messages ecrits par un autre bot : ce que Kotbo est cense remplacer. */
function fromOtherBot(message: Message, guild: Guild): boolean {
  return (message.author.bot || message.webhookId !== null) && message.author.id !== guild.client.user?.id;
}

// ── Mise en forme ───────────────────────────────────────────────────────────

const EMOJI = /(?:<a?:\w+:\d+>)|\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/u;

function firstEmoji(text: string): string | null {
  return text.match(EMOJI)?.[0] ?? null;
}

const CUSTOM_EMOJI = /^<a?:\w+:(\d+)>$/;

/**
 * Emoji que Kotbo pourra reellement afficher.
 *
 * Un emoji personnalise d'un autre serveur s'ecrit pareil mais ne s'affiche
 * pas : le bouton porterait `<:vip:123…>` en clair. Mieux vaut un bouton sans
 * emoji qu'un bouton avec un code brut dessus.
 */
function usableEmoji(guild: Guild, raw: string | null): string | null {
  if (!raw) return null;
  const custom = raw.match(CUSTOM_EMOJI);
  if (!custom) return raw;
  return guild.emojis.cache.has(custom[1]!) ? raw : null;
}

function hex(color: number | null | undefined): string | null {
  if (typeof color !== 'number') return null;
  return `#${color.toString(16).padStart(6, '0').toUpperCase()}`;
}

function clean(text: string): string {
  return text.replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Rend a un texte les variables que son bot d'origine y mettait.
 *
 * Le message lu est une instance : il nomme l'arrivant du jour, cite le nombre
 * de membres d'alors. Repris tel quel, il souhaiterait eternellement la
 * bienvenue a la meme personne. Les mentions et les compteurs redeviennent donc
 * les variables de Kotbo - les seules dont on soit sur qu'elles voulaient dire
 * cela.
 */
export function toTemplate(text: string, guild: Guild): string {
  return text
    .replace(/<@!?\d+>/g, '{user}')
    .split(guild.name)
    .join('{server}')
    .replace(/\b\d[\d\s.,\u00A0]*\s*(?:è?[me]{2}|er|ère|st|nd|rd|th)?\s+(membres?|members?)\b/gi, '{memberCount} $1')
    .trim();
}

/**
 * Banniere reutilisable du message, s'il en a une.
 *
 * Les fichiers heberges par Discord sont ecartes : leur URL porte depuis 2024
 * une signature qui expire au bout de quelques heures. Reprise telle quelle,
 * elle donnerait un message d'accueil a l'image cassee des le lendemain - pire
 * que pas d'image du tout, parce que personne ne penserait a aller voir.
 */
const EXPIRING_HOST = /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\//i;

function reusableImage(message: Message, embed: Embed | undefined): string | null {
  const candidate =
    embed?.image?.url ??
    message.attachments.find((file) => file.contentType?.startsWith('image/') ?? false)?.url ??
    null;
  if (!candidate || EXPIRING_HOST.test(candidate)) return null;
  return candidate;
}

/** Nom lisible d'un salon, pour citer la source d'un constat. */
function label(channel: GuildBasedChannel): string {
  return channel.name ?? channel.id;
}

// ── Bienvenue ───────────────────────────────────────────────────────────────

const WELCOME_WORDS = /bienvenu|welcome|nous rejoint|a rejoint|joined|arriv/i;

/**
 * Le dernier message de bienvenue poste par un autre bot.
 *
 * On prend le plus recent et non le plus frequent : un serveur qui a change de
 * formulation le mois dernier veut la nouvelle. La mention d'un membre sert de
 * preuve - un message d'accueil nomme celui qu'il accueille, une annonce
 * epinglee dans le meme salon ne le fait pas.
 */
function inspectWelcome(guild: Guild, channel: GuildBasedChannel, history: Message[]): InspectedFinding | null {
  const candidates = history.filter(
    (message) =>
      fromOtherBot(message, guild) &&
      (message.mentions.users.size > 0 ||
        WELCOME_WORDS.test(message.content) ||
        WELCOME_WORDS.test(message.embeds[0]?.description ?? '')),
  );

  const source = candidates.at(-1);
  if (!source) return null;

  const embed = source.embeds[0];
  // L'URL de la banniere est mise dans le texte, pas a cote : Kotbo poste du
  // contenu brut, et Discord affiche l'image d'une URL laissee seule sur sa
  // ligne. C'est la seule facon de la reproduire sans embed.
  const image = reusableImage(source, embed);
  const parts = [
    source.content,
    embed?.title ? `**${embed.title}**` : '',
    embed?.description ?? '',
    image ?? '',
  ].filter((part) => part.trim().length > 0);

  const message = toTemplate(parts.join('\n\n'), guild).slice(0, 1900);
  if (message.length < 3) return null;

  return {
    key: 'welcome.message',
    feature: 'welcome',
    title: 'Message de bienvenue relevé',
    detail:
      `${source.author.username} accueille les arrivants dans « ${label(channel)} ». Son dernier message est ` +
      'repris ici, mentions et compteurs remis en variables. Kotbo publie du texte brut : ce qui était en embed ' +
      'devient du texte mis en forme.',
    action: `Reprendre ce texte comme message de bienvenue Kotbo dans « ${label(channel)} »`,
    entities: [{ id: channel.id, name: label(channel) }],
    payload: { kind: 'welcome', channelId: channel.id, message },
  };
}

// ── Reglement ───────────────────────────────────────────────────────────────

type Article = { emoji: string | null; title: string; description: string };

/**
 * Reconnait une ligne de titre d'article.
 *
 * Deux formes couvrent la quasi-totalite des reglements ecrits a la main : la
 * ligne numerotee (« 3. Pas de spam ») et la ligne entierement en gras. Tout ce
 * qui suit jusqu'au titre suivant est le corps de l'article.
 */
function matchHeading(line: string): { emoji: string | null; title: string; inline: string } | null {
  let rest = line.trim();
  if (!rest) return null;

  const emojiMatch = rest.match(new RegExp(`^(${EMOJI.source})\\s*`, 'u'));
  const emoji = emojiMatch?.[1] ?? null;
  if (emojiMatch) rest = rest.slice(emojiMatch[0].length).trim();

  const numbered = rest.match(/^(?:art(?:icle)?\.?\s*)?\d{1,2}\s*[.)\-–:]\s*(.+)$/i);
  if (numbered) return { emoji, title: clean(numbered[1]!).slice(0, 100), inline: '' };

  const bold = rest.match(/^(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*(.*)$/);
  if (bold && clean(bold[1]!).length <= 80) {
    return { emoji, title: clean(bold[1]!).slice(0, 100), inline: bold[2]!.trim() };
  }

  return null;
}

/** Un titre sans corps se decrit lui-meme : mieux qu'un article vide. */
function finishArticle(draft: { emoji: string | null; title: string; body: string[] }): Article {
  const description = draft.body.join('\n').trim();
  return {
    emoji: draft.emoji,
    title: draft.title,
    description: (description || draft.title).slice(0, 900),
  };
}

export function splitArticles(raw: string): Article[] {
  const articles: Article[] = [];
  let current: { emoji: string | null; title: string; body: string[] } | null = null;

  for (const line of raw.split('\n')) {
    const heading = matchHeading(line);
    if (heading) {
      if (current) articles.push(finishArticle(current));
      current = { emoji: heading.emoji, title: heading.title, body: heading.inline ? [heading.inline] : [] };
      continue;
    }
    if (current && line.trim()) current.body.push(line.trim());
  }
  if (current) articles.push(finishArticle(current));

  return articles.filter((article) => article.title.length >= 3);
}

/**
 * Les articles d'un reglement deja redige.
 *
 * Les champs d'embed sont lus en priorite : quand un reglement en utilise,
 * chaque champ est deja un article, titre et corps separes. Le texte brut n'est
 * decoupe que faute de mieux.
 */
function inspectRules(guild: Guild, channel: GuildBasedChannel, history: Message[]): InspectedFinding | null {
  let articles: Article[] = [];
  let sourceLabel = '';

  for (const message of history) {
    for (const embed of message.embeds) {
      if (embed.fields.length >= 2 && embed.fields.length > articles.length) {
        articles = embed.fields.slice(0, 15).map((field) => ({
          emoji: usableEmoji(guild, firstEmoji(field.name)),
          title: clean(field.name).slice(0, 100),
          description: clean(field.value).slice(0, 900) || clean(field.name),
        }));
        sourceLabel = "les champs d'un embed";
      }
      if (embed.description) {
        const parsed = splitArticles(embed.description);
        if (parsed.length > articles.length) {
          articles = parsed;
          sourceLabel = "la description d'un embed";
        }
      }
    }
    if (message.content.length > 40) {
      const parsed = splitArticles(message.content);
      if (parsed.length > articles.length) {
        articles = parsed;
        sourceLabel = 'un message du salon';
      }
    }
  }

  if (articles.length < 2) return null;
  // Le decoupage prend l'emoji tel qu'il est ecrit ; celui d'un autre serveur
  // s'afficherait en code brut en tete d'article.
  const kept = articles
    .slice(0, 15)
    .map((article) => ({ ...article, emoji: usableEmoji(guild, article.emoji) }));

  return {
    key: 'rules.articles',
    feature: 'rules',
    title: `Règlement déjà rédigé : ${kept.length} article(s)`,
    detail:
      `« ${label(channel)} » contient un règlement, lu depuis ${sourceLabel}. Kotbo le reprend article par ` +
      'article, éditables ensuite depuis la page Règlement. Le découpage est automatique : relisez les titres.',
    action: `Créer les ${kept.length} articles du règlement Kotbo`,
    entities: [{ id: channel.id, name: label(channel) }],
    payload: { kind: 'rules', channelId: channel.id, articles: kept },
  };
}

// ── Panneau de tickets ──────────────────────────────────────────────────────

const TICKET_WORDS = /ticket|support|assistance|contact|aide|help|open|ouvrir/i;

/**
 * Emoji d'un sujet de ticket, ramene a ce que la colonne sait porter.
 *
 * Les sujets stockent leur emoji sur seize caracteres : un emoji personnalise,
 * qui s'ecrit `<:nom:18 chiffres>`, y serait tronque et donnerait un bouton
 * illisible. Ceux-la retombent sur l'emoji generique - le sujet garde son
 * libelle, qui est ce qui compte.
 */
function panelEmoji(emoji: { id?: string | null; name?: string | null } | null | undefined): string {
  if (!emoji || emoji.id) return '🎫';
  return emoji.name ?? '🎫';
}

function slug(value: string, index: number): string {
  const base = clean(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return base || `sujet-${index + 1}`;
}

/**
 * Le panneau de tickets de l'ancien bot, lu dans ses boutons.
 *
 * Un panneau expose ses sujets : c'est la seule partie du systeme de tickets
 * qu'un autre bot laisse voir. Les formulaires poses a l'ouverture, eux, vivent
 * dans sa base et restent a ressaisir - le constat le dit, plutot que de
 * laisser croire la reprise complete.
 */
function inspectTicketPanel(
  guild: Guild,
  channel: GuildBasedChannel,
  history: Message[],
): InspectedFinding | null {
  for (const message of [...history].reverse()) {
    if (!fromOtherBot(message, guild)) continue;

    const types: { id: string; label: string; description: string; emoji: string }[] = [];
    let embedType: 'BUTTONS' | 'DROPDOWN' = 'BUTTONS';
    let buttonText = '';

    for (const row of message.components) {
      const children = 'components' in row ? row.components : [];
      for (const component of children) {
        if (component.type === ComponentType.Button) {
          const text = component.label ?? '';
          if (!text || !TICKET_WORDS.test(text)) continue;
          buttonText ||= clean(text).slice(0, 80);
          types.push({
            id: slug(text, types.length),
            label: clean(text).slice(0, 80),
            description: '',
            emoji: panelEmoji(component.emoji),
          });
        } else if (component.type === ComponentType.StringSelect) {
          embedType = 'DROPDOWN';
          for (const option of component.options) {
            types.push({
              id: slug(option.value || option.label, types.length),
              label: clean(option.label).slice(0, 80),
              description: clean(option.description ?? '').slice(0, 100),
              emoji: panelEmoji(option.emoji),
            });
          }
        }
      }
    }

    if (types.length === 0) continue;

    const embed = message.embeds[0];
    const title = clean(embed?.title ?? '').slice(0, 100) || 'Support';
    const description =
      toTemplate(embed?.description ?? message.content, guild).slice(0, 900) ||
      'Cliquez ci-dessous pour ouvrir un ticket.';

    const unique = new Map(types.map((type) => [type.id, type]));
    const kept = Array.from(unique.values()).slice(0, 10);

    // Un panneau a bouton unique ne porte qu'un intitule, pas des sujets :
    // « Ouvrir un ticket » ne decrit aucune categorie a reprendre.
    const single = embedType === 'BUTTONS' && kept.length < 2;

    return {
      key: 'tickets.panel',
      feature: 'tickets',
      title: single ? 'Panneau de tickets repéré' : `Panneau de tickets et ${kept.length} sujet(s)`,
      detail: single
        ? `« ${label(channel)} » porte le panneau de ${message.author.username}. Son texte est repris ; il n'expose ` +
          "qu'un bouton, donc aucun sujet à récupérer. Les formulaires d'ouverture restent à ressaisir."
        : `« ${label(channel)} » porte le panneau de ${message.author.username}. Ses sujets sont lus dans ses ` +
          `${embedType === 'DROPDOWN' ? 'options de menu' : 'boutons'}, avec le texte du panneau. Les questions ` +
          "posées à l'ouverture, elles, vivent dans la base de l'ancien bot et restent à ressaisir.",
      action: single
        ? 'Reprendre le titre, le texte et le bouton du panneau Kotbo'
        : `Reprendre le panneau et ses ${kept.length} sujets`,
      entities: [{ id: channel.id, name: label(channel) }],
      payload: {
        kind: 'ticketPanel',
        channelId: channel.id,
        title,
        description,
        buttonText: buttonText || 'Ouvrir un ticket',
        color: hex(embed?.color),
        embedType: single ? 'BUTTONS' : embedType,
        types: single ? [] : kept,
      },
    };
  }

  return null;
}

// ── Roles par reaction ──────────────────────────────────────────────────────

/**
 * Un role nomme sur la ligne, mention ou nom en clair.
 *
 * La mention est sure ; le nom en clair ne l'est qu'a partir de trois
 * caracteres et hors du role @everyone. Un menu qui liste « 🎮 Gamer » n'est
 * pas moins lisible parce que son bot ne mentionne pas le role.
 */
function roleOnLine(guild: Guild, line: string): { id: string; name: string } | null {
  const mention = line.match(/<@&(\d+)>/);
  if (mention) {
    const role = guild.roles.cache.get(mention[1]!);
    if (role) return { id: role.id, name: role.name };
  }

  const text = clean(line).toLowerCase();
  if (!text) return null;

  const named = guild.roles.cache
    .filter((role) => role.name.length >= 3 && role.id !== guild.id && text.includes(role.name.toLowerCase()))
    // Le nom le plus long l'emporte : « Gamer Pro » plutot que « Gamer ».
    .sort((a, b) => b.name.length - a.name.length)
    .first();

  return named ? { id: named.id, name: named.name } : null;
}

/**
 * Les couples emoji -> role d'un menu deja publie.
 *
 * Discord ne stocke que les reactions, jamais le role qu'elles accordent : la
 * correspondance n'existe que dans la base de l'ancien bot. Mais le menu la
 * repete a l'ecran, ligne par ligne - sinon personne ne saurait sur quoi
 * cliquer. C'est cette liste qu'on lit, pas la configuration du bot.
 */
function inspectReactionRoles(
  guild: Guild,
  channel: GuildBasedChannel,
  history: Message[],
): InspectedFinding | null {
  for (const message of [...history].reverse()) {
    const text = [message.content, ...message.embeds.map((embed) => embed.description ?? '')].join('\n');
    const options: { emoji: string; label: string; roleId: string }[] = [];
    const seen = new Set<string>();

    for (const line of text.split('\n')) {
      const emoji = firstEmoji(line);
      if (!emoji) continue;
      // Un emoji venu d'un autre serveur ne s'affichera pas ici : la ligne est
      // laissee de cote plutot que reprise avec un bouton muet.
      const usable = usableEmoji(guild, emoji);
      if (!usable) continue;
      const role = roleOnLine(guild, line.replace(emoji, ' '));
      if (!role || seen.has(role.id)) continue;
      seen.add(role.id);
      options.push({ emoji: usable, label: role.name.slice(0, 80), roleId: role.id });
    }

    if (options.length < 2) continue;

    const title = clean(message.embeds[0]?.title ?? '').slice(0, 100) || 'Choisis tes rôles';
    const kept = options.slice(0, 20);
    const reacted = message.reactions.cache.size > 0;

    return {
      key: 'reactionRoles.menu',
      feature: 'reactionRoles',
      title: `Menu de rôles lisible : ${kept.length} rôle(s)`,
      detail:
        `« ${label(channel)} » contient un menu qui associe ${kept.length} emojis à des rôles${
          reacted ? ' et porte déjà les réactions correspondantes' : ''
        }. Ces couples sont lus dans le texte du menu, pas dans l'ancien bot : relisez-les. Kotbo publiera ` +
        "son propre menu à côté ; l'ancien message est à retirer une fois le nouveau en place.",
      action: `Publier un menu Kotbo reprenant ces ${kept.length} rôles dans « ${label(channel)} »`,
      entities: [{ id: channel.id, name: label(channel) }],
      payload: { kind: 'reactionRoles', channelId: channel.id, title, options: kept },
    };
  }

  return null;
}

// ── Orchestration ───────────────────────────────────────────────────────────

/**
 * Lit les salons deja reperes et rend ce qui s'y trouve.
 *
 * Une seule lecture par salon, partagee entre les inspections : le salon de
 * bienvenue heberge souvent aussi le reglement, et le relire pour chaque
 * question doublerait les appels sans rien apprendre de plus.
 */
export async function inspectMessages(
  guild: Guild,
  targets: InspectionTargets,
): Promise<InspectedFinding[]> {
  const histories = new Map<string, Message[]>();

  const load = async (channels: GuildBasedChannel[]): Promise<[GuildBasedChannel, Message[]][]> => {
    const out: [GuildBasedChannel, Message[]][] = [];
    for (const channel of channels.slice(0, CHANNEL_LIMIT)) {
      const cached = histories.get(channel.id) ?? (await readHistory(guild, channel));
      histories.set(channel.id, cached);
      if (cached.length > 0) out.push([channel, cached]);
    }
    return out;
  };

  const findings: InspectedFinding[] = [];

  const run = async (
    channels: GuildBasedChannel[],
    inspect: (guild: Guild, channel: GuildBasedChannel, history: Message[]) => InspectedFinding | null,
  ) => {
    for (const [channel, history] of await load(channels)) {
      const finding = inspect(guild, channel, history);
      // Le premier salon qui repond suffit : deux propositions pour la meme
      // question obligeraient a arbitrer entre deux lectures approximatives.
      if (finding) {
        findings.push(finding);
        return;
      }
    }
  };

  await Promise.all([
    run(targets.welcome, inspectWelcome),
    run(targets.rules, inspectRules),
    run(targets.tickets, inspectTicketPanel),
    run(targets.roles, inspectReactionRoles),
  ]);

  return findings;
}
