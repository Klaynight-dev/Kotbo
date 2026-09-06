/**
 * Hebergement des images utilisees par les broadcasts globaux.
 *
 * Pourquoi ce service existe : un embed Discord ne sait afficher qu'une image
 * accessible par une URL HTTP(S) publique et durable.
 *   - une URL `data:` (ce que produit un `FileReader.readAsDataURL` cote
 *     dashboard) n'est jamais telechargee par Discord ;
 *   - un lien `cdn.discordapp.com` copie depuis un message est signe et expire
 *     (`?ex=&is=&hm=`), donc l'embed finit par afficher "Echec du chargement
 *     de l'image" meme s'il s'affichait au moment de l'envoi ;
 *   - une URL derriere une authentification renvoie 401 au crawler Discord.
 *
 * On stocke donc l'octet brut en base et on le ressert sur une route publique
 * stable, protegee par un jeton non devinable present dans l'URL.
 */
import { randomBytes } from 'node:crypto';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getApiUrl } from '../../api/shared/core.js';

/** Types acceptes par les embeds Discord pour `image` et `thumbnail`. */
export const BROADCAST_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

export type BroadcastImageMime = (typeof BROADCAST_IMAGE_MIME_TYPES)[number];

/** Discord refuse au-dela de 10 Mo ; on garde une marge et on reste raisonnable en base. */
export const BROADCAST_MEDIA_MAX_BYTES = 8 * 1024 * 1024;

/** Quota global du stockage de medias de broadcast. */
export const BROADCAST_MEDIA_QUOTA_BYTES = 512 * 1024 * 1024;

export interface StoredBroadcastMedia {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
  uploadedBy: string;
  usageCount: number;
  createdAt: string;
}

export class BroadcastMediaError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'BroadcastMediaError';
  }
}

function isImageMime(value: string): value is BroadcastImageMime {
  return (BROADCAST_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * Verifie la signature binaire du fichier : le `mimeType` annonce par le
 * navigateur ne prouve rien, et un embed pointant vers un fichier qui n'est pas
 * reellement une image casse le rendu Discord sans message d'erreur.
 */
function hasImageMagicBytes(buffer: Buffer, mimeType: BroadcastImageMime): boolean {
  if (mimeType === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return buffer.length >= 8 &&
      buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
      buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a;
  }
  if (mimeType === 'image/gif') {
    return buffer.length >= 6 &&
      buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38 &&
      (buffer[4] === 0x37 || buffer[4] === 0x39) && buffer[5] === 0x61;
  }
  // image/webp
  return buffer.length >= 12 &&
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50;
}

const EXTENSION_BY_MIME: Record<BroadcastImageMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * URL publique d'un media. L'extension finale n'a aucun role fonctionnel cote
 * Kotbo, mais Discord se fie a l'URL pour deviner qu'il s'agit d'une image
 * avant meme de lancer la requete : sans elle, certains embeds ne tentent pas
 * le rendu.
 */
export function buildBroadcastMediaUrl(media: { token: string; mimeType: string }): string {
  const extension = isImageMime(media.mimeType) ? EXTENSION_BY_MIME[media.mimeType] : 'png';
  return `${getApiUrl().replace(/\/$/, '')}/api/public/broadcast-media/${media.token}.${extension}`;
}

function sanitizeFileName(input: string | undefined, mimeType: BroadcastImageMime): string {
  const fallback = `image.${EXTENSION_BY_MIME[mimeType]}`;
  if (!input) return fallback;
  const cleaned = input.trim().replace(/[^\w.\- ]+/g, '').slice(0, 120);
  return cleaned || fallback;
}

/**
 * Enregistre une image envoyee depuis la console admin (corps JSON base64,
 * meme convention que les preuves de sanction) et renvoie son URL publique.
 */
export async function storeBroadcastMedia(input: {
  fileName?: string;
  mimeType: string;
  data: string;
  uploadedBy: string;
}): Promise<StoredBroadcastMedia> {
  const mimeType = input.mimeType?.trim().toLowerCase() ?? '';
  if (!isImageMime(mimeType)) {
    throw new BroadcastMediaError(
      400,
      `Type d'image non supporté : ${mimeType || 'inconnu'}. Formats acceptés : PNG, JPEG, GIF, WEBP.`,
    );
  }

  // Le dashboard peut envoyer soit du base64 nu, soit une data URL complete.
  const rawData = input.data?.includes(',') && input.data.trim().startsWith('data:')
    ? input.data.slice(input.data.indexOf(',') + 1)
    : input.data;

  if (!rawData?.trim()) {
    throw new BroadcastMediaError(400, 'Fichier vide.');
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(rawData, 'base64');
  } catch {
    throw new BroadcastMediaError(400, 'Données base64 invalides.');
  }

  if (buffer.length === 0) {
    throw new BroadcastMediaError(400, 'Fichier vide.');
  }

  if (buffer.length > BROADCAST_MEDIA_MAX_BYTES) {
    const limitMb = Math.round(BROADCAST_MEDIA_MAX_BYTES / (1024 * 1024));
    throw new BroadcastMediaError(400, `Image trop lourde : ${limitMb} Mo maximum.`);
  }

  if (!hasImageMagicBytes(buffer, mimeType)) {
    throw new BroadcastMediaError(
      400,
      `Le contenu du fichier ne correspond pas au type déclaré (${mimeType}).`,
    );
  }

  const usage = await prisma.broadcastMedia.aggregate({ _sum: { size: true } });
  const used = usage._sum.size ?? 0;
  if (used + buffer.length > BROADCAST_MEDIA_QUOTA_BYTES) {
    throw new BroadcastMediaError(
      400,
      "Quota de stockage des médias de broadcast atteint. Supprimez d'anciennes images.",
    );
  }

  const media = await prisma.broadcastMedia.create({
    data: {
      token: randomBytes(24).toString('base64url'),
      fileName: sanitizeFileName(input.fileName, mimeType),
      mimeType,
      size: buffer.length,
      data: new Uint8Array(buffer),
      uploadedBy: input.uploadedBy,
    },
    select: {
      id: true, token: true, fileName: true, mimeType: true,
      size: true, uploadedBy: true, usageCount: true, createdAt: true,
    },
  });

  logger.info('BroadcastMedia', `Image hebergee ${media.id} (${media.size} octets) par ${input.uploadedBy}`);

  return {
    id: media.id,
    fileName: media.fileName,
    mimeType: media.mimeType,
    size: media.size,
    url: buildBroadcastMediaUrl(media),
    uploadedBy: media.uploadedBy,
    usageCount: media.usageCount,
    createdAt: media.createdAt.toISOString(),
  };
}

export async function listBroadcastMedia(limit = 60): Promise<{
  media: StoredBroadcastMedia[];
  usedBytes: number;
  quotaBytes: number;
}> {
  const [rows, usage] = await Promise.all([
    prisma.broadcastMedia.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
      select: {
        id: true, token: true, fileName: true, mimeType: true,
        size: true, uploadedBy: true, usageCount: true, createdAt: true,
      },
    }),
    prisma.broadcastMedia.aggregate({ _sum: { size: true } }),
  ]);

  return {
    media: rows.map((row) => ({
      id: row.id,
      fileName: row.fileName,
      mimeType: row.mimeType,
      size: row.size,
      url: buildBroadcastMediaUrl(row),
      uploadedBy: row.uploadedBy,
      usageCount: row.usageCount,
      createdAt: row.createdAt.toISOString(),
    })),
    usedBytes: usage._sum.size ?? 0,
    quotaBytes: BROADCAST_MEDIA_QUOTA_BYTES,
  };
}

export async function deleteBroadcastMedia(id: string): Promise<boolean> {
  try {
    await prisma.broadcastMedia.delete({ where: { id } });
    return true;
  } catch {
    return false;
  }
}

/** Lecture par jeton, pour la route publique de service du fichier. */
export async function readBroadcastMediaByToken(token: string): Promise<{
  data: Buffer;
  mimeType: string;
  size: number;
} | null> {
  const media = await prisma.broadcastMedia.findUnique({
    where: { token },
    select: { data: true, mimeType: true, size: true },
  });
  if (!media) return null;
  return { data: Buffer.from(media.data), mimeType: media.mimeType, size: media.size };
}

/** Incremente le compteur d'usage, sans jamais faire echouer l'envoi. */
export async function markBroadcastMediaUsed(urls: (string | null | undefined)[]): Promise<void> {
  const tokens = urls
    .map((url) => (url ? extractMediaToken(url) : null))
    .filter((token): token is string => Boolean(token));
  if (tokens.length === 0) return;
  try {
    await prisma.broadcastMedia.updateMany({
      where: { token: { in: tokens } },
      data: { usageCount: { increment: 1 } },
    });
  } catch (err) {
    logger.warn('BroadcastMedia', `Compteur d'usage non mis a jour: ${(err as Error).message}`);
  }
}

function extractMediaToken(url: string): string | null {
  const match = url.match(/\/api\/public\/broadcast-media\/([A-Za-z0-9_-]+)(?:\.[a-z]+)?(?:\?|$)/);
  return match?.[1] ?? null;
}

export interface ImageUrlCheck {
  ok: boolean;
  /** URL a utiliser reellement dans l'embed. */
  value: string | null;
  /** Message bloquant (ok=false) ou avertissement non bloquant (ok=true). */
  message?: string;
  severity?: 'error' | 'warning';
}

/**
 * Valide une URL destinee a `setImage` / `setThumbnail`.
 *
 * C'est ici que se joue le bug d'origine : sans ce garde-fou, une data URL ou
 * un lien CDN expirable partait vers des centaines de serveurs et n'affichait
 * qu'une vignette cassee, sans aucune trace cote Kotbo.
 */
export function checkEmbedImageUrl(raw: string | null | undefined): ImageUrlCheck {
  const value = raw?.trim();
  if (!value) return { ok: true, value: null };

  if (value.startsWith('data:')) {
    return {
      ok: false,
      value: null,
      severity: 'error',
      message: "Une image encodée en base64 (`data:`) n'est jamais chargée par Discord. Utilisez l'upload : Kotbo l'héberge et fournit un lien permanent.",
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, value: null, severity: 'error', message: "URL d'image invalide." };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      ok: false,
      value: null,
      severity: 'error',
      message: `Protocole non supporté (${parsed.protocol}). Discord n'accepte que http(s).`,
    };
  }

  if (parsed.protocol === 'http:') {
    return {
      ok: true,
      value,
      severity: 'warning',
      message: 'Lien en HTTP non sécurisé : Discord peut refuser de le charger. Préférez HTTPS.',
    };
  }

  // Liens CDN Discord signes : valides quelques heures, puis 404 cote embed.
  const isDiscordCdn = /(^|\.)cdn\.discordapp\.com$/.test(parsed.hostname) ||
    /(^|\.)media\.discordapp\.net$/.test(parsed.hostname);
  if (isDiscordCdn && parsed.searchParams.has('ex') && parsed.searchParams.has('hm')) {
    const expiresHex = parsed.searchParams.get('ex') ?? '';
    const expiresAt = Number.parseInt(expiresHex, 16) * 1000;
    const expired = Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt < Date.now();
    return {
      ok: false,
      value: null,
      severity: 'error',
      message: expired
        ? "Ce lien Discord a expiré : il affichera « Échec du chargement de l'image ». Uploadez l'image dans Kotbo pour obtenir un lien permanent."
        : "Les liens `cdn.discordapp.com` sont signés et expirent au bout de quelques heures. Uploadez l'image dans Kotbo pour obtenir un lien permanent.",
    };
  }

  return { ok: true, value };
}
