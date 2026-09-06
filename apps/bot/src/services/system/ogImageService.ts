import { createCanvas, loadImage, type SKRSContext2D } from '@napi-rs/canvas';
import { ensureCanvasFonts, canvasFont } from '../../utils/canvasFonts.js';
import { BRAND } from '../../utils/brandPalette.js';
import { logger } from '../../utils/logger.js';

// ============================================================================
// CARTES D'APERÇU OPEN GRAPH
//
// Une image 1200x630 par lien partageable, dans la charte « tableau noir » du
// bot (cf. brandPalette). Discord, Slack, Twitter et consorts affichent cette
// image dans l'embed : c'est le seul rendu visuel qu'un lien Kotbo obtient hors
// du dashboard, il doit donc raconter la page a lui seul.
//
// Deux regles structurent ce module :
//
//  1. **Rendu deterministe.** Toutes les irregularites « craie » sont tirees
//     d'un PRNG seede par l'identifiant de la carte. Une meme URL rend donc
//     toujours les memes octets, ce qui rend l'ETag stable et evite que les
//     CDN des reseaux sociaux gardent deux versions d'une meme carte.
//  2. **Aucune donnee privee.** Une carte est servie sans authentification :
//     ce qui n'est pas deja public sur la page ne doit pas y figurer. Les
//     ressources protegees (transcriptions, preuves) sont rendues
//     « caviardees » - la forme d'une conversation, jamais son contenu.
// ============================================================================

const W = 1200;
const H = 630;

/** Bandeau d'illustration a droite de la carte. */
export type OgCardArt =
  | { type: 'none' }
  /** Silhouette de conversation, contenu masque : ressource protegee. */
  | { type: 'redactedChat'; rows?: number }
  /** Apercu des intitules de questions d'un formulaire public. */
  | { type: 'questions'; items: string[]; more?: number }
  /** Compte a rebours d'un giveaway. */
  | { type: 'countdown'; label: string; value: string; ended?: boolean }
  /** Podium d'un classement. */
  | { type: 'podium'; entries: { name: string; score: string }[] };

export interface OgCardSpec {
  /** Cle de cache et graine du PRNG : doit identifier la carte de facon stable. */
  cacheKey: string;
  /** Sur-titre en petites capitales (type de ressource). */
  kicker: string;
  title: string;
  subtitle?: string;
  /** Nom du serveur, affiche en tete avec son icone. */
  guildName?: string;
  guildIconUrl?: string;
  /** Couleur d'accent (#rrggbb). Par defaut : le bleu de la charte. */
  accent?: string;
  /** Jusqu'a trois post-its de chiffres cles. */
  stats?: { value: string; label: string }[];
  /** Pastilles d'etat (« Ouvert », « Connexion requise »...). */
  badges?: string[];
  art?: OgCardArt;
  /** Mention en bas a droite (date, statut...). */
  footerRight?: string;
}

// ---------------------------------------------------------------------------
// Cache memoire
//
// Les CDN des reseaux sociaux rechargent une meme carte en rafale (une requete
// par client qui affiche l'embed). Un LRU de quelques dizaines d'entrees suffit
// a absorber ces rafales ; au-dela, l'en-tete Cache-Control fait le travail.
// Redis n'est volontairement pas utilise : ces PNG pesent ~150 Ko piece et
// n'ont aucun interet a survivre au process.
// ---------------------------------------------------------------------------
const MAX_CACHED_CARDS = 64;
const cardCache = new Map<string, Buffer>();

function readCache(key: string): Buffer | null {
  const hit = cardCache.get(key);
  if (!hit) return null;
  // Reinsertion = eviction approximativement LRU, comme dans utils/cache.ts.
  cardCache.delete(key);
  cardCache.set(key, hit);
  return hit;
}

function writeCache(key: string, value: Buffer): void {
  cardCache.delete(key);
  cardCache.set(key, value);
  while (cardCache.size > MAX_CACHED_CARDS) {
    const oldest = cardCache.keys().next().value as string | undefined;
    if (!oldest) break;
    cardCache.delete(oldest);
  }
}

/** Vide le cache des cartes devenues obsoletes (formulaire renomme, giveaway clos...). */
export function invalidateOgCard(cacheKeyPrefix: string): void {
  for (const key of [...cardCache.keys()]) {
    if (key.startsWith(cacheKeyPrefix)) cardCache.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Utilitaires de rendu
// ---------------------------------------------------------------------------

/** PRNG mulberry32 seede par une chaine : rendu identique d'un appel a l'autre. */
function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function roundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill?: string | CanvasGradient,
  stroke?: string,
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
}

function truncate(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Decoupe un texte en lignes tenant dans `maxWidth`, au plus `maxLines`. */
function wrapText(ctx: SKRSContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  const words = normalized.split(' ');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length === maxLines) break;
  }

  if (lines.length < maxLines && current) lines.push(current);

  // Le texte tronque doit rester lisible : on ellipse caractere par caractere
  // plutot que de laisser la derniere ligne deborder du cadre.
  if (lines.length === maxLines && lines.join(' ').length < normalized.length) {
    let last = lines[maxLines - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) {
      last = last.slice(0, -1);
    }
    lines[maxLines - 1] = `${last}…`;
  }

  return lines;
}

function drawChalkLine(
  ctx: SKRSContext2D,
  rand: () => number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  color: string,
  width = 2,
) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  const segments = 14;
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    ctx.lineTo(x1 + (x2 - x1) * t + (rand() - 0.5) * 1.6, y1 + (y2 - y1) * t + (rand() - 0.5) * 1.6);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.globalAlpha = 0.75 + rand() * 0.25;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '');
  const full = normalized.length === 3
    ? normalized.split('').map((c) => c + c).join('')
    : normalized.slice(0, 6);
  const int = Number.parseInt(full, 16);
  if (!Number.isFinite(int)) return `rgba(168, 200, 255, ${alpha})`;
  return `rgba(${(int >> 16) & 255}, ${(int >> 8) & 255}, ${int & 255}, ${alpha})`;
}

/** Normalise une couleur venue de la base vers un `#rrggbb` sur lequel on peut compter. */
export function normalizeAccent(value: string | null | undefined, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    return `#${trimmed.slice(1).split('').map((c) => c + c).join('')}`.toLowerCase();
  }
  const rgb = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgb) {
    const hex = [rgb[1], rgb[2], rgb[3]]
      .map((c) => Math.min(255, Number.parseInt(c, 10)).toString(16).padStart(2, '0'))
      .join('');
    return `#${hex}`;
  }
  return fallback;
}

function drawBackdrop(ctx: SKRSContext2D, rand: () => number, accent: string) {
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, BRAND.bg1);
  bg.addColorStop(0.5, BRAND.bg2);
  bg.addColorStop(1, BRAND.bg1);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // Halo d'accent en haut a gauche : ancre le regard sur le sur-titre.
  const glow = ctx.createRadialGradient(W * 0.18, H * 0.1, 0, W * 0.18, H * 0.1, W * 0.5);
  glow.addColorStop(0, hexToRgba(accent, 0.1));
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // Poussiere de craie.
  for (let i = 0; i < 90; i++) {
    ctx.beginPath();
    ctx.arc(rand() * W, rand() * H, rand() * 1.6 + 0.3, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(232, 228, 217, ${rand() * 0.08})`;
    ctx.fill();
  }

  // Filets de craie haut/bas.
  drawChalkLine(ctx, rand, 48, 26, W - 48, 26, BRAND.chalkDim, 2);
  drawChalkLine(ctx, rand, 48, H - 26, W - 48, H - 26, BRAND.chalkDim, 1.5);

  // Trait d'accent vertical : rappelle la couleur du serveur / du formulaire.
  roundRect(ctx, 48, 96, 6, 132, 3, accent);
}

async function drawGuildAvatar(
  ctx: SKRSContext2D,
  url: string | undefined,
  x: number,
  y: number,
  radius: number,
  fallbackName: string,
  accent: string,
) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  let drawn = false;
  if (url) {
    try {
      const img = await loadImage(url);
      ctx.drawImage(img, x - radius, y - radius, radius * 2, radius * 2);
      drawn = true;
    } catch {
      // Icone indisponible (serveur sans avatar, CDN en erreur) : on retombe
      // sur l'initiale plutot que de laisser un trou dans la carte.
    }
  }

  if (!drawn) {
    ctx.fillStyle = hexToRgba(accent, 0.28);
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    ctx.fillStyle = accent;
    ctx.font = canvasFont(Math.round(radius), 'bold');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((fallbackName.trim()[0] ?? 'K').toUpperCase(), x, y + 1);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
  }
  ctx.restore();

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.strokeStyle = hexToRgba(accent, 0.55);
  ctx.lineWidth = 2;
  ctx.stroke();
}

const POST_IT_COLORS = [BRAND.postItYellow, BRAND.postItBlue, BRAND.postItGreen, BRAND.postItPink];

function drawPostIt(
  ctx: SKRSContext2D,
  rand: () => number,
  index: number,
  x: number,
  y: number,
  w: number,
  h: number,
  value: string,
  label: string,
) {
  const tilt = (rand() - 0.5) * 3.2;
  ctx.save();
  ctx.translate(x + w / 2, y + h / 2);
  ctx.rotate((tilt * Math.PI) / 180);

  ctx.shadowColor = 'rgba(0, 0, 0, 0.28)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 4;
  roundRect(ctx, -w / 2, -h / 2, w, h, 4, POST_IT_COLORS[index % POST_IT_COLORS.length]);
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // Adhesif au sommet.
  ctx.save();
  ctx.translate(0, -h / 2);
  ctx.rotate((-tilt * 0.6 * Math.PI) / 180);
  ctx.fillStyle = BRAND.tape;
  ctx.fillRect(-26, -8, 52, 14);
  ctx.restore();

  // Coin corne.
  ctx.beginPath();
  ctx.moveTo(w / 2 - 16, h / 2);
  ctx.lineTo(w / 2, h / 2 - 16);
  ctx.lineTo(w / 2, h / 2);
  ctx.closePath();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
  ctx.fill();

  ctx.fillStyle = '#2C2C2C';
  ctx.font = canvasFont(34, 'bold');
  ctx.fillText(truncate(value, 9), -w / 2 + 18, 4);

  ctx.fillStyle = '#5A5A5A';
  ctx.font = canvasFont(14, 'normal');
  ctx.fillText(truncate(label.toUpperCase(), 18), -w / 2 + 18, 30);

  ctx.restore();
}

function drawBadges(ctx: SKRSContext2D, badges: string[], x: number, y: number, accent: string) {
  let cursor = x;
  ctx.font = canvasFont(16, 'bold');
  for (const badge of badges.slice(0, 3)) {
    const label = truncate(badge.toUpperCase(), 26);
    const width = ctx.measureText(label).width + 34;
    roundRect(ctx, cursor, y, width, 34, 17, hexToRgba(accent, 0.14), hexToRgba(accent, 0.5));
    ctx.fillStyle = accent;
    ctx.fillText(label, cursor + 17, y + 23);
    cursor += width + 12;
  }
}

// ---------------------------------------------------------------------------
// Panneaux d'illustration
// ---------------------------------------------------------------------------

const ART_X = 700;
const ART_W = 452;

/**
 * Silhouette de conversation caviardee.
 *
 * Les transcriptions ne sont lisibles qu'apres authentification : leur carte
 * d'apercu, elle, est servie a qui possede le lien. On dessine donc la *forme*
 * d'un echange - bulles de largeurs variables, avatars anonymes - sans jamais
 * lire le HTML de la transcription. Le cadenas dit explicitement au lecteur
 * pourquoi il ne voit rien.
 */
function drawRedactedChat(ctx: SKRSContext2D, rand: () => number, accent: string, rows: number) {
  const top = 150;
  const height = 340;
  roundRect(ctx, ART_X, top, ART_W, height, 18, BRAND.card, BRAND.border);

  let y = top + 40;
  for (let i = 0; i < rows; i++) {
    const mine = rand() > 0.6;
    const avatarX = mine ? ART_X + ART_W - 34 : ART_X + 34;
    ctx.beginPath();
    ctx.arc(avatarX, y, 14, 0, Math.PI * 2);
    ctx.fillStyle = mine ? hexToRgba(accent, 0.35) : 'rgba(232, 228, 217, 0.16)';
    ctx.fill();

    const bubbleW = 150 + rand() * 170;
    const bubbleX = mine ? avatarX - 26 - bubbleW : avatarX + 26;
    roundRect(ctx, bubbleX, y - 18, bubbleW, 36, 12, mine ? hexToRgba(accent, 0.18) : 'rgba(232, 228, 217, 0.08)');

    // Deux barres de « texte » par bulle : la longueur varie, le contenu non.
    roundRect(ctx, bubbleX + 14, y - 9, (bubbleW - 28) * (0.6 + rand() * 0.35), 7, 3, 'rgba(232, 228, 217, 0.22)');
    roundRect(ctx, bubbleX + 14, y + 3, (bubbleW - 28) * (0.35 + rand() * 0.4), 7, 3, 'rgba(232, 228, 217, 0.14)');

    y += 54;
    if (y > top + height - 60) break;
  }

  // Voile + cadenas : l'illustration doit se lire comme « verrouille ».
  const veil = ctx.createLinearGradient(0, top + height * 0.35, 0, top + height);
  veil.addColorStop(0, 'rgba(26, 35, 33, 0)');
  veil.addColorStop(1, 'rgba(26, 35, 33, 0.92)');
  roundRect(ctx, ART_X, top, ART_W, height, 18, veil);

  const lockY = top + height - 62;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(ART_X + ART_W / 2, lockY - 12, 11, Math.PI, 0);
  ctx.stroke();
  roundRect(ctx, ART_X + ART_W / 2 - 17, lockY - 12, 34, 26, 5, accent);
}

/** Trois intitules de questions : ce que le visiteur devra reellement remplir. */
function drawQuestions(ctx: SKRSContext2D, accent: string, items: string[], more: number) {
  const top = 150;
  const height = 340;
  roundRect(ctx, ART_X, top, ART_W, height, 18, BRAND.card, BRAND.border);

  ctx.font = canvasFont(15, 'bold');
  ctx.fillStyle = BRAND.textMuted;
  ctx.fillText('AU PROGRAMME', ART_X + 28, top + 40);

  let y = top + 82;
  items.slice(0, 3).forEach((item, index) => {
    roundRect(ctx, ART_X + 28, y - 22, 30, 30, 8, hexToRgba(accent, 0.18));
    ctx.fillStyle = accent;
    ctx.font = canvasFont(16, 'bold');
    ctx.fillText(String(index + 1), ART_X + 39, y - 1);

    ctx.fillStyle = BRAND.textPrimary;
    ctx.font = canvasFont(19, 'normal');
    const lines = wrapText(ctx, item, ART_W - 100, 2);
    lines.forEach((line, lineIndex) => ctx.fillText(line, ART_X + 72, y + lineIndex * 26));
    y += 34 + lines.length * 26;
  });

  if (more > 0) {
    ctx.fillStyle = BRAND.textMuted;
    ctx.font = canvasFont(17, 'normal');
    const label = `+ ${more} autre${more > 1 ? 's' : ''} question${more > 1 ? 's' : ''}`;
    ctx.fillText(label, ART_X + 28, Math.min(y + 6, top + height - 28));
  }
}

/** Grand compteur : le temps restant est l'information utile d'un giveaway. */
function drawCountdown(ctx: SKRSContext2D, accent: string, label: string, value: string, ended: boolean) {
  const top = 170;
  const height = 300;
  const color = ended ? BRAND.textMuted : accent;
  roundRect(ctx, ART_X, top, ART_W, height, 18, BRAND.card, hexToRgba(color, 0.4));

  ctx.textAlign = 'center';
  ctx.fillStyle = BRAND.textMuted;
  ctx.font = canvasFont(17, 'bold');
  ctx.fillText(truncate(label.toUpperCase(), 28), ART_X + ART_W / 2, top + 66);

  ctx.fillStyle = color;
  ctx.font = canvasFont(value.length > 8 ? 52 : 68, 'bold');
  ctx.fillText(truncate(value, 14), ART_X + ART_W / 2, top + 175);

  ctx.fillStyle = BRAND.textSecondary;
  ctx.font = canvasFont(18, 'normal');
  ctx.fillText(ended ? 'Tirage termine' : 'Avant le tirage', ART_X + ART_W / 2, top + 232);
  ctx.textAlign = 'left';
}

/** Podium : un classement se resume a ses trois premieres places. */
function drawPodium(ctx: SKRSContext2D, accent: string, entries: { name: string; score: string }[]) {
  const top = 150;
  const height = 340;
  roundRect(ctx, ART_X, top, ART_W, height, 18, BRAND.card, BRAND.border);

  if (entries.length === 0) {
    ctx.fillStyle = BRAND.textMuted;
    ctx.font = canvasFont(20, 'normal');
    ctx.fillText('Classement en construction', ART_X + 40, top + height / 2);
    return;
  }

  const medals = ['#FFD479', '#D6DDE3', '#D9A06B'];
  let y = top + 62;
  entries.slice(0, 3).forEach((entry, index) => {
    ctx.beginPath();
    ctx.arc(ART_X + 48, y - 6, 18, 0, Math.PI * 2);
    ctx.fillStyle = medals[index];
    ctx.fill();
    ctx.fillStyle = '#2C2C2C';
    ctx.font = canvasFont(17, 'bold');
    ctx.textAlign = 'center';
    ctx.fillText(String(index + 1), ART_X + 48, y);
    ctx.textAlign = 'left';

    ctx.fillStyle = BRAND.textPrimary;
    ctx.font = canvasFont(22, 'bold');
    ctx.fillText(truncate(entry.name, 20), ART_X + 82, y + 2);

    ctx.fillStyle = accent;
    ctx.font = canvasFont(18, 'normal');
    ctx.textAlign = 'right';
    ctx.fillText(truncate(entry.score, 12), ART_X + ART_W - 28, y + 2);
    ctx.textAlign = 'left';

    y += 62;
  });
}

// ---------------------------------------------------------------------------
// Rendu principal
// ---------------------------------------------------------------------------

export async function renderOgCard(spec: OgCardSpec): Promise<Buffer> {
  const cached = readCache(spec.cacheKey);
  if (cached) return cached;

  ensureCanvasFonts();
  const rand = seededRandom(spec.cacheKey);
  const accent = normalizeAccent(spec.accent, BRAND.blurple);
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  drawBackdrop(ctx, rand, accent);

  const hasArt = Boolean(spec.art && spec.art.type !== 'none');
  const textWidth = hasArt ? ART_X - 120 : W - 160;

  // En-tete : serveur + type de ressource.
  if (spec.guildName) {
    await drawGuildAvatar(ctx, spec.guildIconUrl, 100, 96, 32, spec.guildName, accent);
    ctx.fillStyle = BRAND.textSecondary;
    ctx.font = canvasFont(22, 'bold');
    ctx.fillText(truncate(spec.guildName, 34), 148, 92);
    ctx.fillStyle = BRAND.textMuted;
    ctx.font = canvasFont(15, 'normal');
    ctx.fillText('sur Kotbo', 148, 116);
  }

  ctx.fillStyle = accent;
  ctx.font = canvasFont(19, 'bold');
  ctx.fillText(truncate(spec.kicker.toUpperCase(), 46), 78, spec.guildName ? 176 : 120);

  // Titre.
  ctx.fillStyle = BRAND.textPrimary;
  ctx.font = canvasFont(56, 'bold');
  const titleLines = wrapText(ctx, spec.title, textWidth, 2);
  let cursorY = spec.guildName ? 244 : 190;
  for (const line of titleLines) {
    ctx.fillText(line, 78, cursorY);
    cursorY += 66;
  }

  // Sous-titre.
  if (spec.subtitle) {
    ctx.fillStyle = BRAND.textSecondary;
    ctx.font = canvasFont(24, 'normal');
    for (const line of wrapText(ctx, spec.subtitle, textWidth, 2)) {
      ctx.fillText(line, 78, cursorY + 8);
      cursorY += 34;
    }
  }

  // Pastilles d'etat.
  if (spec.badges?.length) {
    drawBadges(ctx, spec.badges, 78, cursorY + 22, accent);
    cursorY += 66;
  }

  // Post-its de chiffres cles, ancres en bas de la colonne de texte.
  if (spec.stats?.length) {
    const stats = spec.stats.slice(0, 3);
    const boxW = hasArt ? 178 : 200;
    const boxH = 104;
    const top = Math.max(cursorY + 26, H - 190);
    stats.forEach((stat, index) => {
      drawPostIt(ctx, rand, index, 78 + index * (boxW + 18), top, boxW, boxH, stat.value, stat.label);
    });
  }

  // Illustration.
  switch (spec.art?.type) {
    case 'redactedChat':
      drawRedactedChat(ctx, rand, accent, spec.art.rows ?? 6);
      break;
    case 'questions':
      drawQuestions(ctx, accent, spec.art.items, spec.art.more ?? 0);
      break;
    case 'countdown':
      drawCountdown(ctx, accent, spec.art.label, spec.art.value, spec.art.ended ?? false);
      break;
    case 'podium':
      drawPodium(ctx, accent, spec.art.entries);
      break;
    default:
      break;
  }

  // Pied de carte.
  ctx.fillStyle = BRAND.chalkDim;
  ctx.font = canvasFont(16, 'bold');
  ctx.fillText('KOTBO', 78, H - 48);
  ctx.font = canvasFont(15, 'normal');
  ctx.fillText('kotbo.fr', 152, H - 48);
  if (spec.footerRight) {
    ctx.textAlign = 'right';
    ctx.fillText(truncate(spec.footerRight, 60), W - 78, H - 48);
    ctx.textAlign = 'left';
  }

  const buffer = canvas.toBuffer('image/png');
  writeCache(spec.cacheKey, buffer);
  return buffer;
}

/** Rendu tolerant aux pannes : un embed sans image vaut mieux qu'une 500. */
export async function tryRenderOgCard(spec: OgCardSpec): Promise<Buffer | null> {
  try {
    return await renderOgCard(spec);
  } catch (err) {
    logger.error('OpenGraph', `Rendu de carte impossible pour ${spec.cacheKey}`, err);
    return null;
  }
}
