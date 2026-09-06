// ─────────────────────────────────────────────────────────────
// Kotbo Custom Emoji System - Application Emojis
// ─────────────────────────────────────────────────────────────
// Emojis are loaded dynamically from the bot's Application Emojis
// at startup via `loadApplicationEmojis(client)`.
// Fallback: Unicode emojis if the application emoji is not found.
// Un ID d'emoji d'application n'appartient qu'à une application : rien ici ne
// sert un ID qui n'a pas été lu sur l'application courante.
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


  // ─── RPG ───
  // Le hub /rpg a son propre jeu de pictogrammes : voir `generate-png-emojis.ts`.
  rpgSword: 'ktb_rpg_sword',
  rpgArmor: 'ktb_rpg_armor',
  rpgAccessory: 'ktb_rpg_accessory',
  rpgPotion: 'ktb_rpg_potion',
  rpgKey: 'ktb_rpg_key',
  rarCommon: 'ktb_rar_common',
  rarUncommon: 'ktb_rar_uncommon',
  rarRare: 'ktb_rar_rare',
  rarEpic: 'ktb_rar_epic',
  rarLegendary: 'ktb_rar_legendary',
  rpgBag: 'ktb_rpg_bag',
  rpgShop: 'ktb_rpg_shop',
  rpgFight: 'ktb_rpg_fight',
  rpgBoss: 'ktb_rpg_boss',
  rpgTravel: 'ktb_rpg_travel',
  rpgCharacter: 'ktb_rpg_character',
  rpgCraft: 'ktb_rpg_craft',
  rpgForge: 'ktb_rpg_forge',
  rpgEnchant: 'ktb_rpg_enchant',
  rpgBestiary: 'ktb_rpg_bestiary',
  rpgGuild: 'ktb_rpg_guild',
  rpgWar: 'ktb_rpg_war',
  rpgClan: 'ktb_rpg_clan',
  rpgDaily: 'ktb_rpg_daily',
  rpgFish: 'ktb_rpg_fish',
  rpgBlackMarket: 'ktb_rpg_blackmarket',
  rpgRaid: 'ktb_rpg_raid',
  rpgPay: 'ktb_rpg_pay',
  rpgSell: 'ktb_rpg_sell',
  rpgMap: 'ktb_rpg_map',
  rpgHp: 'ktb_rpg_hp',
  rpgEnergy: 'ktb_rpg_energy',
  rpgXp: 'ktb_rpg_xp',
  rpgAtk: 'ktb_rpg_atk',
  rpgDef: 'ktb_rpg_def',
  rpgSpd: 'ktb_rpg_spd',
  rpgCrit: 'ktb_rpg_crit',
  rpgRest: 'ktb_rpg_rest',
  rpgBack: 'ktb_rpg_back',
  rpgPrev: 'ktb_rpg_prev',
  rpgNext: 'ktb_rpg_next',
  rpgRefresh: 'ktb_rpg_refresh',

  // Jauges segmentées du RPG. Le segment vide est partagé avec `barEmpty*`.
  rpgBarHpL: 'ktb_rpg_hp_l',
  rpgBarHpM: 'ktb_rpg_hp_m',
  rpgBarHpR: 'ktb_rpg_hp_r',
  rpgBarEnL: 'ktb_rpg_en_l',
  rpgBarEnM: 'ktb_rpg_en_m',
  rpgBarEnR: 'ktb_rpg_en_r',
  rpgBarXpL: 'ktb_rpg_xp_l',
  rpgBarXpM: 'ktb_rpg_xp_m',
  rpgBarXpR: 'ktb_rpg_xp_r',
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
  // RPG : repli Unicode tant que les emojis d'application ne sont pas déposés.
  rpgSword: '🗡️', rpgArmor: '🛡️', rpgAccessory: '💍', rpgPotion: '🧪', rpgKey: '🔑',
  rarCommon: '⬜', rarUncommon: '🟩', rarRare: '🟦', rarEpic: '🟪', rarLegendary: '🟨',
  rpgBag: '🎒', rpgShop: '🛒', rpgFight: '⚔️', rpgBoss: '💀', rpgTravel: '🧭',
  rpgCharacter: '🧬', rpgCraft: '⚒️', rpgForge: '🔨', rpgEnchant: '🔮', rpgBestiary: '📖',
  rpgGuild: '🏰', rpgWar: '🚩', rpgClan: '👥', rpgDaily: '🎁', rpgFish: '🎣',
  rpgBlackMarket: '🕯️', rpgRaid: '🐲', rpgPay: '💸', rpgSell: '🪙', rpgMap: '🗺️',
  rpgHp: '❤️', rpgEnergy: '⚡', rpgXp: '✨', rpgAtk: '⚔️', rpgDef: '🛡️', rpgSpd: '💨',
  rpgCrit: '🎯', rpgRest: '🏡',
  rpgBack: '◀️', rpgPrev: '◀️', rpgNext: '▶️', rpgRefresh: '🔄',
  rpgBarHpL: '❤️', rpgBarHpM: '❤️', rpgBarHpR: '❤️',
  rpgBarEnL: '⚡', rpgBarEnM: '⚡', rpgBarEnR: '⚡',
  rpgBarXpL: '🟦', rpgBarXpM: '🟦', rpgBarXpR: '🟦',
  kotbo: '🔮',
};

// ─── Static values (never change) ───
const STATIC_VALUES: Record<string, string> = {
  loading: '⏳',
  line: '━',
  empty: '​',
  bullet: '▸',
};

// Magasin d'emojis vivant : il démarre en Unicode et n'accueille un ID d'emoji
// d'application qu'après l'avoir lu sur l'application courante. Aucun ID n'est
// codé en dur ici : ceux-ci n'appartiennent qu'à une seule application, et un
// autre bot (recette, instance white-label) qui les renverrait verrait Discord
// afficher `:ktb_xxx:` en clair et rejeter tout message qui les pose sur un
// bouton (`COMPONENT_INVALID_EMOJI`).
const emojiStore: Record<string, string> = {
  ...UNICODE_FALLBACKS,
  ...STATIC_VALUES,
};

const CUSTOM_EMOJI_FORMAT = /^<a?:\w+:\d+>$/;

// Emojis confirmés présents sur l'application courante par `loadApplicationEmojis`.
// Garde-fou du magasin : tant qu'une clé n'y est pas, son ID n'a pas été vu sur
// cette application et ne doit pas partir vers Discord.
let verifiedEmojiKeys = new Set<string>();

/** Valeur servie pour une clé : jamais un ID d'emoji non confirmé. */
function safeEmojiValue(key: string): string {
  const value = emojiStore[key] ?? '';
  if (CUSTOM_EMOJI_FORMAT.test(value) && !verifiedEmojiKeys.has(key)) {
    return UNICODE_FALLBACKS[key] ?? '';
  }
  return value;
}

// Proxy so `E.trophy` always reads the latest value from emojiStore
export const E: Record<string, string> = new Proxy(emojiStore, {
  get(_target, prop: string) {
    return safeEmojiValue(prop);
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
      fallbackToUnicode();
      return;
    }

    const appEmojis = await client.application.emojis.fetch();
    const nameToFormatted = new Map<string, string>();

    for (const [, emoji] of appEmojis) {
      const prefix = emoji.animated ? 'a' : '';
      nameToFormatted.set(emoji.name!, `<${prefix}:${emoji.name}:${emoji.id}>`);
    }

    const verified = new Set<string>();
    let loaded = 0;
    for (const [key, discordName] of Object.entries(EMOJI_NAME_MAP)) {
      const formatted = nameToFormatted.get(discordName);
      if (formatted) {
        emojiStore[key] = formatted;
        verified.add(key);
        loaded++;
      } else {
        logger.warn('Emojis', `Emoji d'application "${discordName}" introuvable, fallback: ${UNICODE_FALLBACKS[key] || '?'}`);
        emojiStore[key] = UNICODE_FALLBACKS[key] || '';
      }
    }

    verifiedEmojiKeys = verified;

    // Rebuild the shortcode map after loading
    rebuildShortcodeMap();

    logger.success('Emojis', `${loaded}/${Object.keys(EMOJI_NAME_MAP).length} emojis d'application chargés.`);
  } catch (err) {
    logger.error('Emojis', "Impossible de charger les emojis d'application, fallback Unicode.", err);
    fallbackToUnicode();
  }
}

/**
 * Repli complet sur l'Unicode : faute d'avoir pu interroger l'application, plus
 * aucun ID n'est confirmé, donc on remet le magasin à plat plutôt que de servir
 * des IDs lus lors d'une session précédente. Un ID qui n'appartient pas à
 * l'application courante fait rejeter tout le message dès qu'il atterrit sur un
 * bouton (`COMPONENT_INVALID_EMOJI`).
 */
function fallbackToUnicode(): void {
  verifiedEmojiKeys = new Set();
  for (const key of Object.keys(EMOJI_NAME_MAP)) {
    emojiStore[key] = UNICODE_FALLBACKS[key] || '';
  }
  rebuildShortcodeMap();
}

// ─── Shortcode Resolution ───
function rebuildShortcodeMap() {
  SHORTCODE_MAP = new Map();
  for (const key of Object.keys(emojiStore)) {
    const val = safeEmojiValue(key);
    if (!val) continue;
    const m = val.match(/^<a?:(\w+):\d+>$/);
    if (m) {
      SHORTCODE_MAP.set(m[1], val);
      SHORTCODE_MAP.set(key, val);
      continue;
    }
    // Emoji d'application absent : `:ktb_xxx:` (et un `<:ktb_xxx:ID>` périmé
    // laissé en base) doit quand même se résoudre, vers le glyphe Unicode cette
    // fois, sinon le raccourci ressort tel quel devant les membres.
    const discordName = EMOJI_NAME_MAP[key];
    if (discordName) {
      SHORTCODE_MAP.set(discordName, val);
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
