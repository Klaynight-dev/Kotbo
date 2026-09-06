import { AppealItemOutcome, type BanAppealStatus } from '@prisma/client';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { json, readJsonBody, type AuthClaims, type DashboardAccess } from '../../shared.js';
import { setDashboardModuleStatus } from '../../../services/core/moduleActivationService.js';
import {
  APPEALABLE_SANCTION_TYPES,
  applyItemOutcome,
  decideAppeal,
  findConflictingItems,
  ensureDefaultAppealForm,
  getAppealConfig,
  getAppealDetail,
  getAppeals,
  getModeratorAppealStats,
  requestAppealInfo,
  upsertAppealConfig,
  type AppealDecision,
} from '../../../services/moderation/banAppealService.js';

interface AppealConfigBody {
  enabled?: boolean;
  formId?: string | null;
  staffChannelId?: string | null;
  inviteChannelId?: string | null;
  cooldownDays?: number;
  welcomeText?: string | null;
  acceptMessage?: string | null;
  denyMessage?: string | null;
  notifyOnBanDM?: boolean;
  createDefaultForm?: boolean;
  appealVerification?: boolean;
  appealSaveIp?: boolean;
  appealSaveDevice?: boolean;
  appealVerificationLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  appealableTypes?: string[];
  maxSanctionsPerAppeal?: number;
  appealWindowDays?: number | null;
  cooldownByType?: Record<string, unknown> | null;
  formIdByType?: Record<string, unknown> | null;
  notifyOnSanctionDM?: boolean;
  excludeIssuingModerator?: boolean;
  notifyIssuingModerator?: boolean;
}

const VALID_OUTCOMES = new Set<string>(Object.values(AppealItemOutcome));

/**
 * Normalise les réglages « contestation étendue » venus du dashboard : rien de
 * ce qui vient du navigateur n'entre en base sans être borné et filtré.
 */
function sanitizeAppealScopeSettings(body: AppealConfigBody) {
  const out: Record<string, unknown> = {};

  if (body.appealableTypes !== undefined) {
    const requested = Array.isArray(body.appealableTypes) ? body.appealableTypes : [];
    out.appealableTypes = APPEALABLE_SANCTION_TYPES.filter(type => requested.includes(type));
  }

  if (body.maxSanctionsPerAppeal !== undefined) {
    out.maxSanctionsPerAppeal = Math.max(1, Math.min(10, Math.round(Number(body.maxSanctionsPerAppeal) || 1)));
  }

  if (body.appealWindowDays !== undefined) {
    const parsed = Number(body.appealWindowDays);
    out.appealWindowDays = body.appealWindowDays === null || !Number.isFinite(parsed) || parsed <= 0
      ? null
      : Math.min(3650, Math.round(parsed));
  }

  if (body.cooldownByType !== undefined) {
    if (body.cooldownByType === null) {
      out.cooldownByType = null;
    } else {
      const map: Record<string, number> = {};
      for (const type of APPEALABLE_SANCTION_TYPES) {
        const raw = Number((body.cooldownByType as Record<string, unknown>)[type]);
        if (Number.isFinite(raw) && raw >= 0) map[type] = Math.min(365, Math.round(raw));
      }
      out.cooldownByType = Object.keys(map).length > 0 ? map : null;
    }
  }

  if (body.formIdByType !== undefined) {
    if (body.formIdByType === null) {
      out.formIdByType = null;
    } else {
      const map: Record<string, string> = {};
      for (const type of APPEALABLE_SANCTION_TYPES) {
        const raw = (body.formIdByType as Record<string, unknown>)[type];
        if (typeof raw === 'string' && raw.trim()) map[type] = raw.trim();
      }
      out.formIdByType = Object.keys(map).length > 0 ? map : null;
    }
  }

  for (const key of ['notifyOnSanctionDM', 'excludeIssuingModerator', 'notifyIssuingModerator'] as const) {
    if (body[key] !== undefined) out[key] = !!body[key];
  }

  return out;
}

/**
 * Routes de gestion des appels de bannissement.
 * Base: /api/dashboard/guilds/:guildId/appeals
 */
export async function handleBanAppealRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  _url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  access: DashboardAccess
): Promise<boolean> {
  const method = req.method;

  if (parts[4] !== 'appeals') {
    return false;
  }

  // Décider d'un appel = modération de contenu au minimum
  if (!access.canModerateContent) {
    json(res, 403, { error: 'Accès modérateur requis pour gérer les appels de bannissement' });
    return true;
  }

  // GET /appeals - Liste (filtre ?status=)
  if (parts.length === 5 && method === 'GET') {
    try {
      const status = (_url.searchParams.get('status') as BanAppealStatus | null) ?? undefined;
      const appeals = await getAppeals(guildId, status);
      json(res, 200, { appeals });
    } catch (err) {
      logger.error('BanAppealsAPI', 'Error listing appeals:', err);
      json(res, 500, { error: 'Erreur lors de la récupération des appels' });
    }
    return true;
  }

  // GET /appeals/config
  if (parts.length === 6 && parts[5] === 'config' && method === 'GET') {
    try {
      const config = await getAppealConfig(guildId);
      json(res, 200, { config });
    } catch (err) {
      logger.error('BanAppealsAPI', 'Error getting appeal config:', err);
      json(res, 500, { error: 'Erreur lors de la récupération de la configuration' });
    }
    return true;
  }

  // PUT /appeals/config
  if (parts.length === 6 && parts[5] === 'config' && method === 'PUT') {
    if (!access.canManageSettings) {
      json(res, 403, { error: 'Accès administrateur requis pour configurer les appels' });
      return true;
    }
    try {
      const body = await readJsonBody<AppealConfigBody>(req);
      if (!body) {
        json(res, 400, { error: 'Le corps de la requête est vide' });
        return true;
      }

      const { createDefaultForm, ...data } = body;

      if (data.cooldownDays !== undefined) {
        data.cooldownDays = Math.max(0, Math.min(365, Math.round(Number(data.cooldownDays) || 0)));
      }

      // Vérifie que le formulaire lié appartient bien à la guilde
      if (data.formId) {
        const form = await prisma.customForm.findFirst({ where: { id: data.formId, guildId }, select: { id: true } });
        if (!form) {
          json(res, 400, { error: 'Formulaire introuvable sur ce serveur' });
          return true;
        }
      }

      const scopeSettings = sanitizeAppealScopeSettings(data);

      // Même contrôle pour les formulaires par type : un id de formulaire
      // appartenant à un autre serveur exposerait ses questions ici.
      const perTypeForms = scopeSettings.formIdByType as Record<string, string> | null | undefined;
      if (perTypeForms) {
        const ids = [...new Set(Object.values(perTypeForms))];
        const found = await prisma.customForm.findMany({ where: { id: { in: ids }, guildId }, select: { id: true } });
        if (found.length !== ids.length) {
          json(res, 400, { error: 'Un des formulaires par type est introuvable sur ce serveur' });
          return true;
        }
      }

      // L'interrupteur de la page est celui du module : le laisser écrire la
      // seule table laisserait la ligne du registre dire l'inverse, et c'est
      // elle que lit la garde. La bascule écrit les deux.
      const {
        enabled,
        appealableTypes: _rawTypes,
        maxSanctionsPerAppeal: _rawMax,
        appealWindowDays: _rawWindow,
        cooldownByType: _rawCooldowns,
        formIdByType: _rawForms,
        notifyOnSanctionDM: _rawSanctionDM,
        excludeIssuingModerator: _rawExclude,
        notifyIssuingModerator: _rawNotifyMod,
        ...settings
      } = data;
      await upsertAppealConfig(guildId, { ...settings, ...scopeSettings });

      if (enabled !== undefined) {
        const current = await getAppealConfig(guildId);
        if (current?.enabled !== enabled) {
          await setDashboardModuleStatus(guildId, 'ban_appeals', enabled);
        }
      }

      if (createDefaultForm) {
        await ensureDefaultAppealForm(guildId);
      }

      const config = await getAppealConfig(guildId);
      json(res, 200, { config });
    } catch (err) {
      logger.error('BanAppealsAPI', 'Error updating appeal config:', err);
      json(res, 500, { error: 'Erreur lors de la mise à jour de la configuration' });
    }
    return true;
  }

  // GET /appeals/blacklist
  if (parts.length === 6 && parts[5] === 'blacklist' && method === 'GET') {
    try {
      const entries = await prisma.banAppealBlacklist.findMany({
        where: { guildId },
        orderBy: { createdAt: 'desc' },
      });
      json(res, 200, { entries });
    } catch (err) {
      logger.error('BanAppealsAPI', 'Error listing appeal blacklist:', err);
      json(res, 500, { error: 'Erreur lors de la récupération de la blacklist' });
    }
    return true;
  }

  // DELETE /appeals/blacklist/:userId
  if (parts.length === 7 && parts[5] === 'blacklist' && parts[6] && method === 'DELETE') {
    try {
      await prisma.banAppealBlacklist.deleteMany({ where: { guildId, userId: parts[6] } });
      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('BanAppealsAPI', 'Error removing appeal blacklist entry:', err);
      json(res, 500, { error: 'Erreur lors de la suppression de la blacklist' });
    }
    return true;
  }

  // GET /appeals/moderator-stats - taux d'annulation par modérateur
  if (parts.length === 6 && parts[5] === 'moderator-stats' && method === 'GET') {
    try {
      const stats = await getModeratorAppealStats(guildId);
      json(res, 200, { stats });
    } catch (err) {
      logger.error('BanAppealsAPI', 'Error computing moderator appeal stats:', err);
      json(res, 500, { error: 'Erreur lors du calcul des statistiques' });
    }
    return true;
  }

  // Routes avec :appealId
  if (parts[5]) {
    const appealId = parts[5];

    // POST /appeals/:id/items/:itemId - { outcome, note? }
    // Verdict d'UNE sanction contestée, appliqué immédiatement (archivage,
    // suppression ou verrou), sans clore l'appel : le staff peut trancher
    // sanction par sanction puis prononcer la décision globale.
    if (parts.length === 8 && parts[6] === 'items' && parts[7] && method === 'POST') {
      try {
        const body = await readJsonBody<{ outcome: string; note?: string }>(req);
        if (!body?.outcome || !VALID_OUTCOMES.has(body.outcome)) {
          json(res, 400, { error: 'Verdict invalide' });
          return true;
        }
        if (body.outcome === AppealItemOutcome.DELETED && access.level !== 'admin') {
          json(res, 403, { error: 'Seuls les administrateurs peuvent supprimer définitivement une sanction.' });
          return true;
        }

        const item = await prisma.banAppealSanction.findFirst({
          where: { id: parts[7], guildId, appealId },
          select: { id: true },
        });
        if (!item) {
          json(res, 404, { error: 'Sanction contestée introuvable' });
          return true;
        }

        // Même garde que sur l'embed Discord : on ne juge pas sa propre sanction.
        const config = await getAppealConfig(guildId);
        const conflicts = await findConflictingItems(appealId, user.userId, config);
        if (conflicts.some(conflict => conflict.id === item.id)) {
          json(res, 403, { error: "Tu as prononcé cette sanction : un autre membre du staff doit la trancher." });
          return true;
        }

        const result = await applyItemOutcome(client, {
          guildId,
          itemId: parts[7],
          outcome: body.outcome as AppealItemOutcome,
          actor: { userId: user.userId, tag: user.username },
          note: body.note,
        });

        if (!result.ok) {
          json(res, 409, { error: result.error });
          return true;
        }
        json(res, 200, { item: result.item });
      } catch (err) {
        logger.error('BanAppealsAPI', 'Error applying appeal item outcome:', err);
        json(res, 500, { error: 'Erreur lors de l\'application du verdict' });
      }
      return true;
    }

    // GET /appeals/:id - Détail (réponses + historique sanctions + appels précédents)
    if (parts.length === 6 && method === 'GET') {
      try {
        const detail = await getAppealDetail(appealId, guildId);
        if (!detail) {
          json(res, 404, { error: 'Appel introuvable' });
          return true;
        }
        json(res, 200, detail);
      } catch (err) {
        logger.error('BanAppealsAPI', 'Error getting appeal detail:', err);
        json(res, 500, { error: 'Erreur lors de la récupération de l\'appel' });
      }
      return true;
    }

    // POST /appeals/:id/decide - { decision: ACCEPTED|DENIED|DENIED_PERMANENT, reason? }
    if (parts.length === 7 && parts[6] === 'decide' && method === 'POST') {
      try {
        const body = await readJsonBody<{
          decision: AppealDecision;
          reason?: string;
          outcomes?: Record<string, string>;
        }>(req);
        if (!body?.decision || !['ACCEPTED', 'DENIED', 'DENIED_PERMANENT'].includes(body.decision)) {
          json(res, 400, { error: 'Décision invalide' });
          return true;
        }
        if (body.decision !== 'ACCEPTED' && !body.reason?.trim()) {
          json(res, 400, { error: 'Une raison est requise pour un refus' });
          return true;
        }

        // Verdicts par sanction : on n'accepte que des valeurs connues, et la
        // suppression définitive reste réservée aux administrateurs.
        const outcomes: Record<string, AppealItemOutcome> = {};
        for (const [itemId, value] of Object.entries(body.outcomes ?? {})) {
          if (!VALID_OUTCOMES.has(value)) {
            json(res, 400, { error: `Verdict invalide pour la sanction ${itemId}` });
            return true;
          }
          if (value === AppealItemOutcome.DELETED && access.level !== 'admin') {
            json(res, 403, { error: 'Seuls les administrateurs peuvent supprimer définitivement une sanction.' });
            return true;
          }
          outcomes[itemId] = value as AppealItemOutcome;
        }

        const result = await decideAppeal(client, {
          appealId,
          guildId,
          decision: body.decision,
          staffUserId: user.userId,
          staffTag: user.username,
          reason: body.reason?.trim() || undefined,
          outcomes,
        });

        if (!result.ok) {
          json(res, 409, { error: result.error });
          return true;
        }
        json(res, 200, { appeal: result.appeal });
      } catch (err) {
        logger.error('BanAppealsAPI', 'Error deciding appeal:', err);
        json(res, 500, { error: 'Erreur lors de la décision' });
      }
      return true;
    }

    // POST /appeals/:id/request-info - { question }
    if (parts.length === 7 && parts[6] === 'request-info' && method === 'POST') {
      try {
        const body = await readJsonBody<{ question: string }>(req);
        if (!body?.question?.trim()) {
          json(res, 400, { error: 'La question est requise' });
          return true;
        }

        const result = await requestAppealInfo(client, {
          appealId,
          guildId,
          question: body.question.trim().slice(0, 1000),
          staffUserId: user.userId,
          staffTag: user.username,
        });

        if (!result.ok) {
          json(res, 409, { error: result.error });
          return true;
        }
        json(res, 200, { appeal: result.appeal });
      } catch (err) {
        logger.error('BanAppealsAPI', 'Error requesting appeal info:', err);
        json(res, 500, { error: 'Erreur lors de la demande d\'informations' });
      }
      return true;
    }
  }

  return false;
}
