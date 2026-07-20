// ─────────────────────────────────────────────────────────────
// Kotbo Custom Emoji System — Application Emojis
// ─────────────────────────────────────────────────────────────
// Emojis are loaded dynamically from the bot's Application Emojis
// at startup via `loadApplicationEmojis(client)`.
// Fallback: Unicode emojis if the application emoji is not found.
// ─────────────────────────────────────────────────────────────

import type { Client } from 'discord.js';
import { logger } from './logger.js';

// Maps emoji key (e.g. "success") → Discord emoji name (e.g. "ktb_check")
const EMOJI_NAME_MAP: Record<string, string> = {
  // ─── Status ───
  success: 'ktb_check',
  error: 'ktb_cross',
  warning: 'ktb_warn',
  info: 'ktb_info',

  // ─── UI Elements ───
  arrow: 'ktb_arrow',
  dot: 'ktb_dot',

  // ─── Ranking ───
  rank1: 'ktb_gold',
  rank2: 'ktb_silver',
  rank3: 'ktb_bronze',

  // ─── Features ───
  moderation: 'ktb_mod',
  stats: 'ktb_stats',
  trophy: 'ktb_trophy',
  profile: 'ktb_profile',
  xp: 'ktb_xp',
  level: 'ktb_level',
  messages: 'ktb_msg',
  voice: 'ktb_voice',
  coins: 'ktb_coins',
  calendar: 'ktb_cal',
  clock: 'ktb_clock',
  ticket: 'ktb_ticket',
  news: 'ktb_news',
  settings: 'ktb_settings',
  shield: 'ktb_shield',
  star: 'ktb_star',
  fire: 'ktb_fire',
  crown: 'ktb_crown',
  link: 'ktb_link',
  lock: 'ktb_lock',
  unlock: 'ktb_unlock',
  ban: 'ktb_ban',
  mute: 'ktb_mute',
  kick: 'ktb_kick',

  // ─── Platforms ───
  youtube: 'ktb_yt',
  twitch: 'ktb_twitch',

  // ─── Presence ───
  online: 'ktb_online',
  idle: 'ktb_idle',
  dnd: 'ktb_dnd',
  offline: 'ktb_offline',

  // ─── Progress Bar (3-part) ───
  barFullL: 'ktb_fl',
  barFullM: 'ktb_fm',
  barFullR: 'ktb_fr',
  barEmptyL: 'ktb_el',
  barEmptyM: 'ktb_em',
  barEmptyR: 'ktb_er',

  // ─── Branding ───
  kotbo: 'ktb_logo',
};

// ─── Fallback Unicode Emojis ───
export const UNICODE_FALLBACKS: Record<string, string> = {
  success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️', loading: '⏳',
  arrow: '▸', dot: '◈', line: '━', empty: '​', bullet: '▸',
  rank1: '🥇', rank2: '🥈', rank3: '🥉',
  moderation: '🛡️', stats: '📊', trophy: '🏆', profile: '👤',
  xp: '✨', level: '⭐', messages: '💬', voice: '🎙️', coins: '🪙',
  calendar: '📅', clock: '🕐', ticket: '🎫', news: '📰',
  settings: '⚙️', shield: '🛡️', star: '⭐', fire: '🔥', crown: '👑',
  link: '🔗', lock: '🔒', unlock: '🔓',
  ban: '🔨', mute: '🔇', kick: '👢',
  youtube: '▶️', twitch: '🟣',
  online: '🟢', idle: '🟡', dnd: '🔴', offline: '⚫',
  barFullL: '▰', barFullM: '▰', barFullR: '▰',
  barEmptyL: '▱', barEmptyM: '▱', barEmptyR: '▱',
  kotbo: '🔮',
};

// ─── Static values (never change) ───
const STATIC_VALUES: Record<string, string> = {
  loading: '⏳',
  line: '━',
  empty: '​',
  bullet: '▸',
};

// ─── Hardcoded Application Emoji IDs (fallback before dynamic load) ───
const HARDCODED_APP_EMOJIS: Record<string, string> = {
  success: '<:ktb_check:1519265258538143834>',
  error: '<:ktb_cross:1519265262690373632>',
  warning: '<:ktb_warn:1519265315077226668>',
  info: '<:ktb_info:1519265282915569704>',
  arrow: '<:ktb_arrow:1519265251378335814>',
  dot: '<:ktb_dot:1519265268143226961>',
  rank1: '<:ktb_gold:1519265280608436344>',
  rank2: '<:ktb_silver:1519265304092606484>',
  rank3: '<:ktb_bronze:1519265255358726246>',
  moderation: '<:ktb_mod:1519265290662187028>',
  stats: '<:ktb_stats:1519265306277711993>',
  trophy: '<:ktb_trophy:1519265309649932419>',
  profile: '<:ktb_profile:1519265300099502130>',
  xp: '<:ktb_xp:1519265316348235877>',
  level: '<:ktb_level:1519265285251792927>',
  messages: '<:ktb_msg:1519265291849170994>',
  voice: '<:ktb_voice:1519265313911345234>',
  coins: '<:ktb_coins:1519265260874371152>',
  calendar: '<:ktb_cal:1519265257032384512>',
  clock: '<:ktb_clock:1519265259758682172>',
  ticket: '<:ktb_ticket:1519265307582009344>',
  news: '<:ktb_news:1519265294541914152>',
  settings: '<:ktb_settings:1519265301345075282>',
  shield: '<:ktb_shield:1519265302968406096>',
  star: '<:ktb_star:1519265305245909113>',
  fire: '<:ktb_fire:1519265274916896888>',
  crown: '<:ktb_crown:1519265264129019904>',
  link: '<:ktb_link:1519265286572871691>',
  lock: '<:ktb_lock:1519265287889752215>',
  unlock: '<:ktb_unlock:1519265312501928016>',
  ban: '<:ktb_ban:1519265253463031838>',
  mute: '<:ktb_mute:1519265292969316362>',
  kick: '<:ktb_kick:1519265284144496670>',
  youtube: '<:ktb_yt:1519265317665247232>',
  twitch: '<:ktb_twitch:1519265311365533787>',
  online: '<:ktb_online:1519265298698600579>',
  idle: '<:ktb_idle:1519265281728450571>',
  dnd: '<:ktb_dnd:1519265267086135318>',
  offline: '<:ktb_offline:1519265296748253245>',
  barFullL: '<:ktb_fl:1519265276435103805>',
  barFullM: '<:ktb_fm:1519265277760765972>',
  barFullR: '<:ktb_fr:1519265278956146699>',
  barEmptyL: '<:ktb_el:1519265269594329128>',
  barEmptyM: '<:ktb_em:1519265270898622504>',
  barEmptyR: '<:ktb_er:1519265272274358333>',
  kotbo: '<:ktb_logo:1519265289446100992>',
};

// Mutable emoji store — starts with hardcoded app emojis, refreshed at runtime
const emojiStore: Record<string, string> = {
  ...UNICODE_FALLBACKS,
  ...HARDCODED_APP_EMOJIS,
  ...STATIC_VALUES,
};

// Proxy so `E.trophy` always reads the latest value from emojiStore
export const E: Record<string, string> = new Proxy(emojiStore, {
  get(target, prop: string) {
    return target[prop] ?? '';
  },
});

/**
 * Fetches all Application Emojis and populates the emoji store.
 * Call once in the ClientReady event.
 */
export async function loadApplicationEmojis(client: Client): Promise<void> {
  try {
    if (!client.application) {
      logger.warn('Emojis', 'client.application indisponible, utilisation des fallbacks Unicode.');
      return;
    }

    const appEmojis = await client.application.emojis.fetch();
    const nameToFormatted = new Map<string, string>();

    for (const [, emoji] of appEmojis) {
      const prefix = emoji.animated ? 'a' : '';
      nameToFormatted.set(emoji.name!, `<${prefix}:${emoji.name}:${emoji.id}>`);
    }

    let loaded = 0;
    for (const [key, discordName] of Object.entries(EMOJI_NAME_MAP)) {
      const formatted = nameToFormatted.get(discordName);
      if (formatted) {
        emojiStore[key] = formatted;
        loaded++;
      } else {
        logger.warn('Emojis', `Emoji d'application "${discordName}" introuvable, fallback: ${UNICODE_FALLBACKS[key] || '?'}`);
        emojiStore[key] = UNICODE_FALLBACKS[key] || '';
      }
    }

    // Rebuild the shortcode map after loading
    rebuildShortcodeMap();

    logger.success('Emojis', `${loaded}/${Object.keys(EMOJI_NAME_MAP).length} emojis d'application chargés.`);
  } catch (err) {
    logger.error('Emojis', "Impossible de charger les emojis d'application, fallback Unicode.", err);
  }
}

// ─── Shortcode Resolution ───
function rebuildShortcodeMap() {
  SHORTCODE_MAP = new Map();
  for (const [key, val] of Object.entries(emojiStore)) {
    const m = val.match(/^<a?:(\w+):\d+>$/);
    if (m) {
      SHORTCODE_MAP.set(m[1], val);
      SHORTCODE_MAP.set(key, val);
    }
  }
}

let SHORTCODE_MAP = new Map<string, string>();
rebuildShortcodeMap();

const UNICODE_SHORTCODE_MAP = new Map<string, string>();
for (const [key, val] of Object.entries(UNICODE_FALLBACKS)) {
  UNICODE_SHORTCODE_MAP.set(key, val);
  const discordName = EMOJI_NAME_MAP[key];
  if (discordName) {
    UNICODE_SHORTCODE_MAP.set(discordName, val);
  }
}

export function resolveEmojiShortcodes(text: string | null | undefined): string {
  if (!text) return '';
  // Replace full format with stale IDs: <:ktb_xxx:OLD_ID> → <:ktb_xxx:CURRENT_ID>
  let result = text.replace(/<a?:(\w+):\d+>/g, (match, name) => SHORTCODE_MAP.get(name) ?? match);
  // Replace shortcodes: :ktb_xxx: → <:ktb_xxx:ID>
  // The lookbehind skips :name: already inside a full <:name:id> format,
  // otherwise the emoji would be emitted twice (shortcode + interpreted).
  result = result.replace(/(?<!<a?):(\w+):(?!\d+>)/g, (match, name) => SHORTCODE_MAP.get(name) ?? match);
  return result;
}

export function resolveEmojiShortcodesToUnicode(text: string | null | undefined): string {
  if (!text) return '';
  let result = text.replace(/<a?:(\w+):\d+>/g, (match, name) => UNICODE_SHORTCODE_MAP.get(name) ?? match);
  result = result.replace(/(?<!<a?):(\w+):(?!\d+>)/g, (match, name) => UNICODE_SHORTCODE_MAP.get(name) ?? match);
  return result;
}

// ─── Helpers ───

export function rankEmoji(rank: number): string {
  if (rank === 1) return E.rank1;
  if (rank === 2) return E.rank2;
  if (rank === 3) return E.rank3;
  return `**#${rank}**`;
}

export function presenceEmoji(status: string): string {
  switch (status) {
    case 'online': return E.online;
    case 'idle': return E.idle;
    case 'dnd': return E.dnd;
    default: return E.offline;
  }
}

export function buildProgressBar(percent: number, size = 10): string {
  const filled = Math.round((percent / 100) * size);
  const empty = size - filled;

  if (size <= 3) {
    return '▰'.repeat(filled) + '▱'.repeat(empty);
  }

  let bar = '';
  for (let i = 0; i < size; i++) {
    if (i === 0) bar += i < filled ? E.barFullL : E.barEmptyL;
    else if (i === size - 1) bar += i < filled ? E.barFullR : E.barEmptyR;
    else bar += i < filled ? E.barFullM : E.barEmptyM;
  }
  return bar;
}

export function feedStatusEmoji(status: boolean): string {
  return status ? E.online : E.offline;
}

export function categoryEmoji(category: string): string {
  const c = category?.toLowerCase() || '';
  if (c.includes('youtube')) return E.youtube;
  if (c.includes('twitch')) return E.twitch;
  return E.news;
}
