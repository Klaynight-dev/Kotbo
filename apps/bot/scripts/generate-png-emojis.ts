import { createCanvas, loadImage } from '@napi-rs/canvas';
import { write, mkdir } from 'bun';
import { join } from 'path';

// Define stroke colors matching Discord/Kotbo branding
const COLORS = {
  green: '#57F287',
  red: '#ED4245',
  yellow: '#FEE75C',
  blurple: '#5865F2',
  pink: '#EB459E',
  purple: '#9146FF',
  gold: '#F5A623',
  silver: '#B8C2CC',
  bronze: '#CD7F32',
  gray: '#8E9297',
  darkGray: '#4F545C',
};

/**
 * Palette du module RPG.
 *
 * Distincte de `COLORS`, et volontairement claire : ces icônes se posent sur
 * des boutons Discord, qui ont leur propre fond coloré (blurple #5865F2, vert
 * #248046, rouge #DA373C, gris #4E5058). Une teinte saturée reprise de la
 * charte du bot disparaît sur le bouton de même famille ; une teinte pastel se
 * détache des quatre fonds comme du fond sombre d'un conteneur.
 */
const RPG = {
  steel: '#DBDEE1',
  parchment: '#EFE0C0',
  gold: '#FFD166',
  ember: '#FF8F8F',
  mint: '#8FE3B0',
  azure: '#9BC5FF',
  amethyst: '#C9A7FF',
  rose: '#FFA8D5',
  bronze: '#E3B48A',
  slate: '#B9BDC7',
};

interface EmojiConfig {
  type: 'lucide' | 'custom';
  lucideName?: string;
  color?: string;
  fillType?: 'none' | 'full' | 'opacity';
  fillOpacity?: number;
  strokeWidth?: number;
  svg?: string;
}

/**
 * Les trois segments pleins d'une jauge RPG, dans la teinte de la ressource.
 *
 * Même géométrie que `ktb_fl/fm/fr` pour que les segments pleins et vides se
 * raccordent sans décrochage : extrémités arrondies, milieu droit.
 */
function rpgBar(key: string, color: string): Record<string, EmojiConfig> {
  return {
    [`ktb_rpg_${key}_l`]: {
      type: 'custom',
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.5"><path d="M22 7H8c-2.8 0-5 2.2-5 5s2.2 5 5 5h14" fill="${color}"/></svg>`,
    },
    [`ktb_rpg_${key}_m`]: {
      type: 'custom',
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.5"><rect x="0" y="7" width="24" height="10" fill="${color}"/></svg>`,
    },
    [`ktb_rpg_${key}_r`]: {
      type: 'custom',
      svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2.5"><path d="M2 7h14c2.8 0 5 2.2 5 5s-2.2 5-5 5H2" fill="${color}"/></svg>`,
    },
  };
}

type IconNode = [string, Record<string, string | number>];

const EMOJI_CONFIGS: Record<string, EmojiConfig> = {
  // --- Status (filled container with foreground icon) ---
  ktb_check: {
    type: 'lucide',
    lucideName: 'circle-check',
    color: COLORS.green,
    fillType: 'opacity',
    fillOpacity: 0.15,
  },
  ktb_cross: {
    type: 'lucide',
    lucideName: 'circle-x',
    color: COLORS.red,
    fillType: 'opacity',
    fillOpacity: 0.15,
  },
  ktb_warn: {
    type: 'lucide',
    lucideName: 'triangle-alert',
    color: COLORS.yellow,
    fillType: 'opacity',
    fillOpacity: 0.15,
  },
  ktb_info: {
    type: 'lucide',
    lucideName: 'info',
    color: COLORS.blurple,
    fillType: 'opacity',
    fillOpacity: 0.15,
  },

  // --- UI Elements ---
  ktb_arrow: {
    type: 'lucide',
    lucideName: 'chevron-right',
    color: COLORS.gray,
    fillType: 'none',
  },
  ktb_dot: {
    type: 'custom',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${COLORS.gray}" stroke="${COLORS.gray}" stroke-width="2.5"><circle cx="12" cy="12" r="4"/></svg>`,
  },

  // --- Ranking (using Medal) ---
  ktb_gold: {
    type: 'lucide',
    lucideName: 'medal',
    color: COLORS.gold,
    fillType: 'opacity',
    fillOpacity: 0.15,
  },
  ktb_silver: {
    type: 'lucide',
    lucideName: 'medal',
    color: COLORS.silver,
    fillType: 'opacity',
    fillOpacity: 0.15,
  },
  ktb_bronze: {
    type: 'lucide',
    lucideName: 'medal',
    color: COLORS.bronze,
    fillType: 'opacity',
    fillOpacity: 0.15,
  },

  // --- Features ---
  ktb_mod: {
    type: 'lucide',
    lucideName: 'shield-alert',
    color: COLORS.purple,
    fillType: 'opacity',
    fillOpacity: 0.15,
  },
  ktb_stats: {
    type: 'lucide',
    lucideName: 'bar-chart-2',
    color: COLORS.blurple,
    fillType: 'none',
  },
  ktb_trophy: {
    type: 'lucide',
    lucideName: 'trophy',
    color: COLORS.gold,
    fillType: 'none',
  },
  ktb_profile: {
    type: 'lucide',
    lucideName: 'user',
    color: COLORS.blurple,
    fillType: 'none',
  },
  ktb_xp: {
    type: 'lucide',
    lucideName: 'sparkles',
    color: COLORS.yellow,
    fillType: 'opacity',
    fillOpacity: 0.15,
  },
  ktb_level: {
    type: 'lucide',
    lucideName: 'trending-up',
    color: COLORS.green,
    fillType: 'none',
  },
  ktb_msg: {
    type: 'lucide',
    lucideName: 'message-square',
    color: COLORS.blurple,
    fillType: 'none',
  },
  ktb_voice: {
    type: 'lucide',
    lucideName: 'mic',
    color: COLORS.blurple,
    fillType: 'none',
  },
  ktb_coins: {
    type: 'lucide',
    lucideName: 'coins',
    color: COLORS.yellow,
    fillType: 'none',
  },
  ktb_cal: {
    type: 'lucide',
    lucideName: 'calendar',
    color: COLORS.blurple,
    fillType: 'none',
  },
  ktb_clock: {
    type: 'lucide',
    lucideName: 'clock',
    color: COLORS.blurple,
    fillType: 'none',
  },
  ktb_ticket: {
    type: 'lucide',
    lucideName: 'ticket',
    color: COLORS.pink,
    fillType: 'none',
  },
  ktb_news: {
    type: 'lucide',
    lucideName: 'megaphone',
    color: COLORS.blurple,
    fillType: 'none',
  },
  ktb_settings: {
    type: 'lucide',
    lucideName: 'settings',
    color: COLORS.gray,
    fillType: 'none',
  },
  ktb_shield: {
    type: 'lucide',
    lucideName: 'shield',
    color: COLORS.blurple,
    fillType: 'none',
  },
  ktb_star: {
    type: 'lucide',
    lucideName: 'star',
    color: COLORS.yellow,
    fillType: 'opacity',
    fillOpacity: 0.15,
  },
  ktb_fire: {
    type: 'lucide',
    lucideName: 'flame',
    color: COLORS.red,
    fillType: 'none',
  },
  ktb_crown: {
    type: 'lucide',
    lucideName: 'crown',
    color: COLORS.gold,
    fillType: 'opacity',
    fillOpacity: 0.15,
  },
  ktb_link: {
    type: 'lucide',
    lucideName: 'link',
    color: COLORS.blurple,
    fillType: 'none',
  },
  ktb_lock: {
    type: 'lucide',
    lucideName: 'lock',
    color: COLORS.red,
    fillType: 'none',
  },
  ktb_unlock: {
    type: 'lucide',
    lucideName: 'unlock',
    color: COLORS.green,
    fillType: 'none',
  },
  ktb_ban: {
    type: 'lucide',
    lucideName: 'ban',
    color: COLORS.red,
    fillType: 'none',
  },
  ktb_mute: {
    type: 'lucide',
    lucideName: 'volume-x',
    color: COLORS.red,
    fillType: 'none',
  },
  ktb_kick: {
    type: 'lucide',
    lucideName: 'user-minus',
    color: COLORS.red,
    fillType: 'none',
  },

  // --- Platforms (Custom SVGs as brand icons are absent in this Lucide build) ---
  ktb_yt: {
    type: 'custom',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${COLORS.red}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17z" fill="${COLORS.red}" fill-opacity="0.15"/>
  <path d="m10 15 5-3-5-3z" fill="#FFFFFF" stroke="#FFFFFF"/>
</svg>`,
  },
  ktb_twitch: {
    type: 'custom',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${COLORS.purple}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 2H3v16h5v4l4-4h5l4-4V2zm-10 9H9.5V6H11v5zm4 0h-1.5V6H15v5z" />
</svg>`,
  },

  // --- Presence ---
  ktb_online: {
    type: 'lucide',
    lucideName: 'circle',
    color: COLORS.green,
    fillType: 'full',
  },
  ktb_idle: {
    type: 'lucide',
    lucideName: 'moon',
    color: COLORS.yellow,
    fillType: 'full',
  },
  ktb_dnd: {
    type: 'lucide',
    lucideName: 'circle-minus',
    color: COLORS.red,
    fillType: 'full',
  },
  ktb_offline: {
    type: 'lucide',
    lucideName: 'circle',
    color: COLORS.gray,
    fillType: 'none',
  },

  // --- Progress Bar (custom geometric SVGs) ---
  ktb_fl: {
    type: 'custom',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${COLORS.blurple}" stroke-width="2.5"><path d="M22 7H8c-2.8 0-5 2.2-5 5s2.2 5 5 5h14" fill="${COLORS.blurple}"/></svg>`,
  },
  ktb_fm: {
    type: 'custom',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${COLORS.blurple}" stroke-width="2.5"><rect x="0" y="7" width="24" height="10" fill="${COLORS.blurple}"/></svg>`,
  },
  ktb_fr: {
    type: 'custom',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${COLORS.blurple}" stroke-width="2.5"><path d="M2 7h14c2.8 0 5 2.2 5 5s-2.2 5-5 5H2" fill="${COLORS.blurple}"/></svg>`,
  },
  ktb_el: {
    type: 'custom',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${COLORS.darkGray}" stroke-width="2.5"><path d="M22 7H8c-2.8 0-5 2.2-5 5s2.2 5 5 5h14"/></svg>`,
  },
  ktb_em: {
    type: 'custom',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${COLORS.darkGray}" stroke-width="2.5"><rect x="0" y="7" width="24" height="10"/></svg>`,
  },
  ktb_er: {
    type: 'custom',
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${COLORS.darkGray}" stroke-width="2.5"><path d="M2 7h14c2.8 0 5 2.2 5 5s-2.2 5-5 5H2"/></svg>`,
  },

  // ─────────────────────────────────────────────────────────────
  // RPG - jeu de pictogrammes dédié
  // ─────────────────────────────────────────────────────────────
  // Le hub /rpg s'écrivait en emojis Unicode : un rendu différent sur chaque
  // plateforme, aucune parenté visuelle entre deux écrans, et des glyphes
  // (🦺, 🧬) qui ne disaient rien du jeu. Un trait Lucide commun donne au
  // module l'identité d'un vrai client de jeu.
  //
  // La palette est volontairement CLAIRE et n'emprunte rien à `COLORS`. Ces
  // icônes se posent sur des boutons Discord, qui ont leur propre fond coloré :
  // une épée rouge sur un bouton Danger rouge, une boussole blurple sur un
  // bouton Primary blurple, une flèche grise sur un bouton Secondary gris
  // disparaissaient purement et simplement. Des teintes pastel se détachent des
  // quatre fonds de bouton comme du fond sombre d'un conteneur.
  //
  // Trait à 3 : Discord affiche ces PNG autour de 22 px, où un trait à 2,5
  // s'efface.

  // --- Catégories d'objets ---
  ktb_rpg_sword: { type: 'lucide', lucideName: 'sword', color: RPG.steel, fillType: 'none', strokeWidth: 3 },
  ktb_rpg_armor: { type: 'lucide', lucideName: 'shirt', color: RPG.azure, fillType: 'none', strokeWidth: 3 },
  ktb_rpg_accessory: { type: 'lucide', lucideName: 'gem', color: RPG.rose, fillType: 'opacity', fillOpacity: 0.35, strokeWidth: 3 },
  ktb_rpg_potion: { type: 'lucide', lucideName: 'flask-conical', color: RPG.mint, fillType: 'opacity', fillOpacity: 0.35, strokeWidth: 3 },
  ktb_rpg_key: { type: 'lucide', lucideName: 'key', color: RPG.gold, fillType: 'none', strokeWidth: 3 },

  // --- Raretés (même glyphe, teinte croissante : la couleur porte le rang) ---
  ktb_rar_common: { type: 'lucide', lucideName: 'circle-dot', color: RPG.slate, fillType: 'none', strokeWidth: 3 },
  ktb_rar_uncommon: { type: 'lucide', lucideName: 'gem', color: RPG.mint, fillType: 'opacity', fillOpacity: 0.3, strokeWidth: 3 },
  ktb_rar_rare: { type: 'lucide', lucideName: 'gem', color: RPG.azure, fillType: 'opacity', fillOpacity: 0.45, strokeWidth: 3 },
  ktb_rar_epic: { type: 'lucide', lucideName: 'gem', color: RPG.amethyst, fillType: 'opacity', fillOpacity: 0.6, strokeWidth: 3 },
  ktb_rar_legendary: { type: 'lucide', lucideName: 'gem', color: RPG.gold, fillType: 'full', strokeWidth: 3 },

  // --- Navigation du hub ---
  ktb_rpg_bag: { type: 'lucide', lucideName: 'backpack', color: RPG.bronze, fillType: 'none', strokeWidth: 3 },
  ktb_rpg_shop: { type: 'lucide', lucideName: 'shopping-cart', color: RPG.gold, fillType: 'none', strokeWidth: 3 },
  ktb_rpg_fight: { type: 'lucide', lucideName: 'swords', color: RPG.steel, fillType: 'none', strokeWidth: 3 },
  ktb_rpg_boss: { type: 'lucide', lucideName: 'skull', color: RPG.parchment, fillType: 'opacity', fillOpacity: 0.3, strokeWidth: 3 },
  ktb_rpg_travel: { type: 'lucide', lucideName: 'compass', color: RPG.gold, fillType: 'none', strokeWidth: 3 },
  ktb_rpg_character: { type: 'lucide', lucideName: 'user-round', color: RPG.parchment, fillType: 'opacity', fillOpacity: 0.3, strokeWidth: 3 },
  ktb_rpg_craft: { type: 'lucide', lucideName: 'hammer', color: RPG.bronze, fillType: 'none', strokeWidth: 3 },
  ktb_rpg_forge: { type: 'lucide', lucideName: 'anvil', color: RPG.slate, fillType: 'none', strokeWidth: 3 },
  ktb_rpg_enchant: { type: 'lucide', lucideName: 'wand-sparkles', color: RPG.amethyst, fillType: 'none', strokeWidth: 3 },
  ktb_rpg_bestiary: { type: 'lucide', lucideName: 'book-open', color: RPG.parchment, fillType: 'none', strokeWidth: 3 },
  ktb_rpg_guild: { type: 'lucide', lucideName: 'castle', color: RPG.steel, fillType: 'none', strokeWidth: 3 },
  ktb_rpg_war: { type: 'lucide', lucideName: 'flag', color: RPG.ember, fillType: 'opacity', fillOpacity: 0.4, strokeWidth: 3 },
  ktb_rpg_clan: { type: 'lucide', lucideName: 'users', color: RPG.azure, fillType: 'none', strokeWidth: 3 },
  ktb_rpg_daily: { type: 'lucide', lucideName: 'gift', color: RPG.rose, fillType: 'opacity', fillOpacity: 0.35, strokeWidth: 3 },
  ktb_rpg_fish: { type: 'lucide', lucideName: 'fish', color: RPG.azure, fillType: 'none', strokeWidth: 3 },
  ktb_rpg_blackmarket: { type: 'lucide', lucideName: 'venetian-mask', color: RPG.amethyst, fillType: 'opacity', fillOpacity: 0.35, strokeWidth: 3 },
  ktb_rpg_raid: { type: 'lucide', lucideName: 'flame', color: RPG.gold, fillType: 'opacity', fillOpacity: 0.4, strokeWidth: 3 },
  ktb_rpg_pay: { type: 'lucide', lucideName: 'hand-coins', color: RPG.mint, fillType: 'none', strokeWidth: 3 },
  ktb_rpg_sell: { type: 'lucide', lucideName: 'shopping-bag', color: RPG.gold, fillType: 'none', strokeWidth: 3 },
  ktb_rpg_map: { type: 'lucide', lucideName: 'map', color: RPG.mint, fillType: 'none', strokeWidth: 3 },
  ktb_rpg_rest: { type: 'lucide', lucideName: 'tent', color: RPG.parchment, fillType: 'none', strokeWidth: 3 },

  // --- Jauges et statistiques ---
  ktb_rpg_hp: { type: 'lucide', lucideName: 'heart', color: RPG.ember, fillType: 'full', strokeWidth: 3 },
  ktb_rpg_energy: { type: 'lucide', lucideName: 'zap', color: RPG.gold, fillType: 'full', strokeWidth: 3 },
  ktb_rpg_xp: { type: 'lucide', lucideName: 'sparkles', color: RPG.azure, fillType: 'none', strokeWidth: 3 },
  ktb_rpg_atk: { type: 'lucide', lucideName: 'sword', color: RPG.ember, fillType: 'none', strokeWidth: 3 },
  ktb_rpg_def: { type: 'lucide', lucideName: 'shield-half', color: RPG.azure, fillType: 'opacity', fillOpacity: 0.3, strokeWidth: 3 },
  ktb_rpg_spd: { type: 'lucide', lucideName: 'footprints', color: RPG.mint, fillType: 'none', strokeWidth: 3 },
  ktb_rpg_crit: { type: 'lucide', lucideName: 'crosshair', color: RPG.gold, fillType: 'none', strokeWidth: 3 },

  // --- Commandes de navigation ---
  ktb_rpg_back: { type: 'lucide', lucideName: 'arrow-left', color: RPG.steel, fillType: 'none', strokeWidth: 3.5 },
  ktb_rpg_prev: { type: 'lucide', lucideName: 'chevron-left', color: RPG.steel, fillType: 'none', strokeWidth: 3.5 },
  ktb_rpg_next: { type: 'lucide', lucideName: 'chevron-right', color: RPG.steel, fillType: 'none', strokeWidth: 3.5 },
  ktb_rpg_refresh: { type: 'lucide', lucideName: 'refresh-cw', color: RPG.mint, fillType: 'none', strokeWidth: 3 },

  // --- Jauges segmentées ---
  // Les barres s'écrivaient en carrés Unicode répétés (❤️❤️❤️, ⚡⚡⚡) : dix
  // glyphes côte à côte donnaient une frise hachée, pas une jauge. Trois
  // segments - gauche, milieu, droite - composent une capsule continue, une
  // teinte par ressource. Le segment vide est partagé avec `ktb_el/em/er`.
  ...rpgBar('hp', RPG.ember),
  ...rpgBar('en', RPG.gold),
  ...rpgBar('xp', RPG.azure),

  // --- Branding ---
  ktb_logo: {
    type: 'lucide',
    lucideName: 'globe',
    color: COLORS.blurple,
    fillType: 'opacity',
    fillOpacity: 0.15,
  },
};

// Retrieve SVG element definitions dynamically from the installed Lucide package
async function getIconNodes(name: string): Promise<IconNode[]> {
  const candidates = [
    name,
    name === 'circle-check' ? 'check-circle' : null,
    name === 'circle-x' ? 'x-circle' : null,
    name === 'triangle-alert' ? 'alert-triangle' : null,
    name === 'circle-minus' ? 'minus-circle' : null,
  ].filter(Boolean) as string[];

  let svelteContent = '';
  let resolvedPath = '';

  for (const cand of candidates) {
    const basePath = join(import.meta.dirname, '..', '..', '..', 'node_modules', 'lucide-svelte', 'dist', 'icons');
    const jsPath = join(basePath, `${cand}.js`);
    const sveltePath = join(basePath, `${cand}.svelte`);

    if (await Bun.file(jsPath).exists()) {
      const jsContent = await Bun.file(jsPath).text();
      const match = jsContent.match(/from\s+["']\.\/(.*\.svelte)["']/);
      if (match) {
        const realSveltePath = join(basePath, match[1]);
        if (await Bun.file(realSveltePath).exists()) {
          svelteContent = await Bun.file(realSveltePath).text();
          resolvedPath = realSveltePath;
          break;
        }
      }
    }

    if (await Bun.file(sveltePath).exists()) {
      svelteContent = await Bun.file(sveltePath).text();
      resolvedPath = sveltePath;
      break;
    }
  }

  if (!svelteContent) {
    throw new Error(`Could not find Lucide icon files for candidate names: ${candidates.join(', ')}`);
  }

  const match = svelteContent.match(/const\s+iconNode\s*=\s*(\[[\s\S]*?\]);/);
  if (!match) {
    throw new Error(`Could not find iconNode in Svelte file: ${resolvedPath}`);
  }

  // Parse the static array literal without eval(): normalize the JS literal
  // (unquoted keys, single quotes, trailing commas) into JSON. The source is a
  // trusted local Lucide package file, but this avoids arbitrary code execution.
  const json = match[1]
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/'([^'\\]*)'/g, '"$1"')
    .replace(/,\s*([\]}])/g, '$1');
  return JSON.parse(json) as IconNode[];
}

function buildSvgString(
  nodes: IconNode[],
  emojiName: string,
  color: string,
  fillType: 'none' | 'full' | 'opacity',
  fillOpacity?: number,
  strokeWidth: number = 2.5
): string {
  const childStrings = nodes.map((node, index) => {
    const [tag, attrs] = node;
    const newAttrs = { ...attrs };

    // YouTube logo customization: make standard play button white inside red background
    if (emojiName === 'ktb_yt' && index === 1) {
      newAttrs.fill = '#FFFFFF';
      newAttrs.stroke = '#FFFFFF';
    }
    // DND customization: make horizontal dash white and thick
    else if (emojiName === 'ktb_dnd' && index === 1) {
      newAttrs.stroke = '#FFFFFF';
      newAttrs['stroke-width'] = 3;
    }
    // Default styling rules based on fillType
    else {
      if (fillType === 'full') {
        newAttrs.fill = color;
      } else if (fillType === 'opacity') {
        if (index === 0) {
          newAttrs.fill = color;
          newAttrs['fill-opacity'] = fillOpacity ?? 0.15;
        } else {
          newAttrs.fill = 'none';
        }
      } else {
        newAttrs.fill = 'none';
      }
    }

    const attrStr = Object.entries(newAttrs)
      .map(([key, val]) => `${key}="${val}"`)
      .join(' ');

    return `<${tag} ${attrStr} />`;
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">\n  ${childStrings.join('\n  ')}\n</svg>`;
}

const outputDir = join(import.meta.dirname, '..', '..', 'dashboard', 'public', 'emojis-png');

// Ensure output directory exists
try {
  await mkdir(outputDir, { recursive: true });
  console.log(`Ensured output directory: ${outputDir}`);
} catch (e) {
  // Ignore
}

let count = 0;
for (const [name, config] of Object.entries(EMOJI_CONFIGS)) {
  try {
    let svgContent = '';

    if (config.type === 'custom') {
      svgContent = config.svg!;
    } else {
      const nodes = await getIconNodes(config.lucideName!);
      svgContent = buildSvgString(
        nodes,
        name,
        config.color!,
        config.fillType!,
        config.fillOpacity,
        config.strokeWidth ?? 2.5
      );
    }

    const canvas = createCanvas(128, 128);
    const ctx = canvas.getContext('2d');

    const svgBuffer = Buffer.from(svgContent);
    const img = await loadImage(svgBuffer);
    ctx.drawImage(img, 0, 0, 128, 128);

    const pngBuffer = await canvas.encode('png');
    const filePath = join(outputDir, `${name}.png`);
    await write(filePath, pngBuffer);
    console.log(`Generated PNG emoji: ${name}.png`);
    count++;
  } catch (err) {
    console.error(`Failed to generate emoji ${name}:`, err);
  }
}

console.log(`\nSuccess: Generated ${count} PNG custom emojis directly using Lucide assets.`);
