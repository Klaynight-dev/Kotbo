/**
 * Routes dashboard du module `starboard` (Starlight).
 *
 * La configuration vit dans sa propre table plutôt que sur `Guild` : la page
 * n'écrit donc pas des colonnes mais une ligne créée à la première sauvegarde.
 * Le service tient un cache de 5 minutes sur cette lecture, invalidé ici à
 * chaque écriture - sans quoi une modification ne prendrait effet que plusieurs
 * minutes plus tard, ce qui se lit comme un bug.
 *
 * `enabled` n'est pas modifiable ici. Le segment est ferme par la garde des
 * modules tant que Starlight est eteint : une route qu'on ne peut atteindre
 * qu'allume ne peut pas servir a l'allumer. L'activation passe donc par
 * `/modules`, qui ecrit les deux etats (la pastille et `StarboardConfig`) et
 * propage les dependances.
 */
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { invalidateStarboardCache, normalizeEmojiKey } from '../../../../services/features/starboardService.js';
import { getGuildName, json, pushAudit, readJsonBody } from '../../../shared.js';
import { type ModuleRouteContext } from './_shared.js';

/** Identifiant Discord : salon, rôle ou emoji custom. */
const SNOWFLAKE_RE = /^\d{17,20}$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** Bornes de saisie : un serveur n'a pas 200 salons à surveiller nommément. */
const MAX_EMOJIS = 10;
const MAX_CHANNELS = 100;
const MAX_THRESHOLD = 1000;

const DEFAULTS = {
  channelId: null as string | null,
  upvoteEmojis: ['👍'],
  downvoteEmojis: ['👎'],
  threshold: 5,
  countEmbedReactions: true,
  autoReactEmbed: true,
  autoReactChannels: [] as string[],
  watchedChannels: [] as string[],
  ignoredChannels: [] as string[],
  allowBots: false,
  embedColor: '#F5C518',
  removeBelowThreshold: true,
};

type StarboardPayload = Partial<{
  channelId: string | null;
  upvoteEmojis: string[];
  downvoteEmojis: string[];
  threshold: number;
  countEmbedReactions: boolean;
  autoReactEmbed: boolean;
  autoReactChannels: string[];
  watchedChannels: string[];
  ignoredChannels: string[];
  allowBots: boolean;
  embedColor: string;
  removeBelowThreshold: boolean;
}>;

const has = (body: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(body, key);

/** Liste de salons : dédoublonnée, bornée, et rejetée si un id est mal formé. */
function parseChannelList(value: unknown, field: string): { ids: string[] } | { error: string } {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return { error: `Le champ ${field} doit être un tableau de chaînes` };
  }
  const ids = [...new Set((value as string[]).map((id) => id.trim()).filter(Boolean))];
  if (ids.length > MAX_CHANNELS) {
    return { error: `Le champ ${field} ne peut pas contenir plus de ${MAX_CHANNELS} salons` };
  }
  if (ids.some((id) => !SNOWFLAKE_RE.test(id))) {
    return { error: `Le champ ${field} contient un identifiant de salon invalide` };
  }
  return { ids };
}

/**
 * Liste d'emojis de vote. Un emoji custom est stocké sous son seul id : le nom
 * peut changer sur le serveur, l'id non. `normalizeEmojiKey` fait cette
 * réduction, la même que celle appliquée au décompte des réactions.
 */
function parseEmojiList(value: unknown, field: string): { emojis: string[] } | { error: string } {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return { error: `Le champ ${field} doit être un tableau de chaînes` };
  }
  const emojis = [...new Set(
    (value as string[])
      .map((raw) => normalizeEmojiKey(raw))
      .filter(Boolean),
  )];
  if (emojis.length > MAX_EMOJIS) {
    return { error: `Le champ ${field} ne peut pas contenir plus de ${MAX_EMOJIS} emojis` };
  }
  // Un emoji unicode tient en quelques points de code ; au-delà, c'est du texte
  // collé par erreur, que Discord refuserait à la réaction.
  if (emojis.some((e) => [...e].length > 8)) {
    return { error: `Le champ ${field} contient une valeur qui n'est pas un emoji` };
  }
  return { emojis };
}

export async function handleStarboardRoutes(ctx: ModuleRouteContext): Promise<boolean> {
  const { req, res, parts, client, guildId, method, auditUser, access } = ctx;

  // GET/PATCH /api/dashboard/guilds/:guildId/starboard
  if (parts.length !== 5) return false;

  if (method === 'GET') {
    try {
      const config = await prisma.starboardConfig.findUnique({ where: { guildId } });
      // Aucune ligne : le serveur n'a jamais ouvert la page. On renvoie les
      // valeurs par défaut du schéma pour que le formulaire s'affiche rempli.
      json(res, 200, { config: config ?? { guildId, ...DEFAULTS } });
    } catch (err) {
      logger.error('StarboardAPI', 'GET starboard error:', err);
      json(res, 500, { error: 'Erreur lors de la récupération de la configuration' });
    }
    return true;
  }

  if (method === 'PATCH') {
    if (!access.canManageSettings) {
      json(res, 403, { error: 'Permissions insuffisantes' });
      return true;
    }

    try {
      const body = await readJsonBody<StarboardPayload>(req);
      if (!body || typeof body !== 'object') {
        json(res, 400, { error: 'Payload invalide' });
        return true;
      }

      const data: Record<string, unknown> = {};

      for (const key of ['countEmbedReactions', 'autoReactEmbed', 'allowBots', 'removeBelowThreshold'] as const) {
        if (!has(body, key)) continue;
        if (typeof body[key] !== 'boolean') {
          json(res, 400, { error: `Le champ ${key} doit être un booléen` });
          return true;
        }
        data[key] = body[key];
      }

      if (has(body, 'channelId')) {
        const channelId = body.channelId;
        if (channelId !== null && (typeof channelId !== 'string' || !SNOWFLAKE_RE.test(channelId.trim()))) {
          json(res, 400, { error: 'Le salon de publication est invalide' });
          return true;
        }
        data.channelId = channelId === null ? null : channelId.trim();
      }

      if (has(body, 'threshold')) {
        const threshold = body.threshold;
        if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 1 || threshold > MAX_THRESHOLD) {
          json(res, 400, { error: `Le seuil doit être un entier entre 1 et ${MAX_THRESHOLD}` });
          return true;
        }
        data.threshold = threshold;
      }

      if (has(body, 'embedColor')) {
        const color = typeof body.embedColor === 'string' ? body.embedColor.trim() : '';
        if (!HEX_COLOR_RE.test(color)) {
          json(res, 400, { error: 'La couleur doit être au format hexadécimal (#RRGGBB)' });
          return true;
        }
        data.embedColor = color.toUpperCase();
      }

      for (const field of ['upvoteEmojis', 'downvoteEmojis'] as const) {
        if (!has(body, field)) continue;
        const parsed = parseEmojiList(body[field], field);
        if ('error' in parsed) {
          json(res, 400, { error: parsed.error });
          return true;
        }
        data[field] = parsed.emojis;
      }

      for (const field of ['autoReactChannels', 'watchedChannels', 'ignoredChannels'] as const) {
        if (!has(body, field)) continue;
        const parsed = parseChannelList(body[field], field);
        if ('error' in parsed) {
          json(res, 400, { error: parsed.error });
          return true;
        }
        data[field] = parsed.ids;
      }

      if (Object.keys(data).length === 0) {
        json(res, 400, { error: 'Aucun champ à mettre à jour' });
        return true;
      }

      // Sans emoji positif, aucun vote ne peut être compté : le module
      // tournerait en silence. On refuse plutôt que de le laisser inerte.
      const upvotes = (data.upvoteEmojis as string[] | undefined);
      if (upvotes && upvotes.length === 0) {
        json(res, 400, { error: 'Au moins un emoji de vote positif est requis' });
        return true;
      }

      // La garde des modules a laisse passer la requete : Starlight est allume,
      // et la ligne existe deja dans la quasi-totalite des cas. Le `create`
      // reste pour le serveur dont la bascule aurait echoue a mi-chemin.
      const config = await prisma.starboardConfig.upsert({
        where: { guildId },
        create: { guildId, enabled: true, ...DEFAULTS, ...data },
        update: data,
      });

      await invalidateStarboardCache(guildId);

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Sauvegarde configuration Starlight',
        context: getGuildName(client, guildId),
        module: 'Starlight',
        eventType: 'Manuel',
        details: `Configuration Starlight mise à jour (seuil: ${config.threshold}).`,
        channelId: config.channelId,
      });

      json(res, 200, { config });
    } catch (err) {
      logger.error('StarboardAPI', 'PATCH starboard error:', err);
      json(res, 500, { error: 'Erreur lors de la mise à jour' });
    }
    return true;
  }

  return false;
}
