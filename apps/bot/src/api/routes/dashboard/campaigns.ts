/** Routes dashboard des campagnes marketing. */
import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import { CampaignStatus, CampaignStepStatus, Prisma } from '@prisma/client';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { json, readJsonBody, resolveDashboardAccess, pushAudit, getGuildName, type AuthClaims } from '../../shared.js';
import { getCampaignReport, resolveAudience } from '../../../services/features/campaignService.js';

/** Etapes d'une campagne, telles que le formulaire les envoie. */
type StepInput = {
  offsetMinutes?: unknown;
  delivery?: unknown;
  channelId?: unknown;
  content?: unknown;
  embed?: unknown;
};

function positiveOrNull(value: unknown): number | null {
  const parsed = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(parsed)) return null;
  return Math.max(0, Math.floor(parsed));
}

function ids(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).slice(0, 50)
    : [];
}

function sanitizeEmbed(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (!value || typeof value !== 'object') return Prisma.JsonNull;
  const raw = value as Record<string, unknown>;

  const embed: Record<string, string> = {};
  if (typeof raw.title === 'string' && raw.title.trim()) embed.title = raw.title.trim().slice(0, 256);
  if (typeof raw.description === 'string' && raw.description.trim()) embed.description = raw.description.trim().slice(0, 4096);
  if (typeof raw.imageUrl === 'string' && /^https:\/\//.test(raw.imageUrl)) embed.imageUrl = raw.imageUrl.slice(0, 500);
  if (typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color)) embed.color = raw.color;

  return Object.keys(embed).length > 0 ? embed : Prisma.JsonNull;
}

/**
 * Valide les etapes. Une etape sans texte n'a rien a poster, et une etape en
 * salon sans salon n'a nulle part ou le poster : les deux sont refusees ici
 * plutot qu'a l'heure dite, ou l'echec passerait inapercu.
 */
function parseSteps(value: unknown): { steps: Prisma.CampaignStepCreateManyCampaignInput[] } | { error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: 'Une campagne a besoin d\'au moins une étape.' };
  }

  const steps: Prisma.CampaignStepCreateManyCampaignInput[] = [];
  for (const [index, raw] of value.entries()) {
    const item = (raw ?? {}) as StepInput;
    const content = typeof item.content === 'string' ? item.content.trim().slice(0, 2000) : '';
    const delivery = item.delivery === 'DM' ? 'DM' : 'CHANNEL';
    const channelId = typeof item.channelId === 'string' && item.channelId.trim() ? item.channelId.trim() : null;

    if (!content) return { error: `L'étape ${index + 1} n'a pas de texte.` };
    if (delivery === 'CHANNEL' && !channelId) return { error: `L'étape ${index + 1} n'a pas de salon de destination.` };

    const offset = Number(item.offsetMinutes);
    steps.push({
      position: index,
      // Un decalage negatif est legitime : c'est le teaser avant la date pivot.
      offsetMinutes: Number.isFinite(offset) ? Math.trunc(offset) : 0,
      delivery,
      channelId,
      content,
      embed: sanitizeEmbed(item.embed),
    });
  }

  return { steps };
}

export async function handleCampaignRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  _url: URL,
  client: Client,
  user: AuthClaims,
): Promise<boolean> {
  if (parts[4] !== 'campaigns') return false;

  const method = req.method;
  const guildId = parts[3];

  const access = await resolveDashboardAccess(client, guildId, user.userId);
  if (!access.canManageSettings) {
    json(res, 403, { error: 'Accès refusé' });
    return true;
  }

  const auditUser = user.username ?? `User${user.userId}`;

  // GET /api/dashboard/guilds/:guildId/campaigns
  if (parts.length === 5 && method === 'GET') {
    try {
      const campaigns = await prisma.campaign.findMany({
        where: { guildId },
        include: { steps: { orderBy: { position: 'asc' } } },
        orderBy: { createdAt: 'desc' },
      });
      json(res, 200, { campaigns });
    } catch (err) {
      logger.error('CampaignsAPI', 'Erreur GET:', err);
      json(res, 500, { error: 'Erreur lors de la récupération des campagnes' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/campaigns/audience-preview
  //
  // Compte l'audience avant l'enregistrement : un ciblage qui ne retient
  // personne, ou tout le serveur, se voit mieux avant l'envoi qu'apres.
  if (parts.length === 6 && parts[5] === 'audience-preview' && method === 'POST') {
    try {
      const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
      if (!guild) {
        json(res, 404, { error: 'Serveur Discord introuvable' });
        return true;
      }

      const body = (await readJsonBody<Record<string, unknown>>(req)) ?? {};
      const audience = await resolveAudience(guild, {
        audienceRoleIds: ids(body.audienceRoleIds),
        audienceExcludeRoleIds: ids(body.audienceExcludeRoleIds),
        audienceMinLevel: positiveOrNull(body.audienceMinLevel),
        audienceMinTenureDays: positiveOrNull(body.audienceMinTenureDays),
        audienceInactiveDays: positiveOrNull(body.audienceInactiveDays),
      });

      json(res, 200, {
        count: audience.length,
        sample: audience.slice(0, 8).map((member) => ({ id: member.id, name: member.user.username })),
      });
    } catch (err) {
      logger.error('CampaignsAPI', 'Erreur audience-preview:', err);
      json(res, 500, { error: 'Erreur lors du calcul de l\'audience' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/campaigns
  if (parts.length === 5 && method === 'POST') {
    try {
      const body = (await readJsonBody<Record<string, unknown>>(req)) ?? {};
      const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
      if (!name) {
        json(res, 400, { error: 'Le nom de la campagne est obligatoire.' });
        return true;
      }

      const parsed = parseSteps(body.steps);
      if ('error' in parsed) {
        json(res, 400, { error: parsed.error });
        return true;
      }

      const campaign = await prisma.campaign.create({
        data: {
          guildId,
          name,
          description: typeof body.description === 'string' ? body.description.trim().slice(0, 500) : null,
          startAt: typeof body.startAt === 'string' && body.startAt ? new Date(body.startAt) : null,
          audienceRoleIds: ids(body.audienceRoleIds),
          audienceExcludeRoleIds: ids(body.audienceExcludeRoleIds),
          audienceMinLevel: positiveOrNull(body.audienceMinLevel),
          audienceMinTenureDays: positiveOrNull(body.audienceMinTenureDays),
          audienceInactiveDays: positiveOrNull(body.audienceInactiveDays),
          targetGuildIds: ids(body.targetGuildIds),
          inviteCode: typeof body.inviteCode === 'string' && body.inviteCode.trim()
            ? body.inviteCode.trim().slice(0, 30)
            : null,
          createdByUserId: user.userId,
          steps: { createMany: { data: parsed.steps } },
        },
        include: { steps: { orderBy: { position: 'asc' } } },
      });

      await pushAudit(guildId, {
        channelId: null,
        user: auditUser,
        action: 'Création de campagne',
        context: getGuildName(client, guildId),
        module: 'Campagnes',
        eventType: 'Settings',
        details: `${name} · ${parsed.steps.length} étape(s)`,
      });

      json(res, 201, { campaign });
    } catch (err) {
      logger.error('CampaignsAPI', 'Erreur POST:', err);
      json(res, 500, { error: 'Erreur lors de la création de la campagne' });
    }
    return true;
  }

  const campaignId = parts[5];

  // PATCH /api/dashboard/guilds/:guildId/campaigns/:id
  if (parts.length === 6 && method === 'PATCH') {
    try {
      const existing = await prisma.campaign.findFirst({ where: { id: campaignId, guildId } });
      if (!existing) {
        json(res, 404, { error: 'Campagne introuvable' });
        return true;
      }

      const body = (await readJsonBody<Record<string, unknown>>(req)) ?? {};

      // Modifier les etapes d'une campagne deja partie reecrirait l'histoire :
      // les etapes envoyees portent leurs mesures, qu'un remplacement effacerait.
      const wantsSteps = body.steps !== undefined;
      if (wantsSteps && existing.status !== CampaignStatus.DRAFT) {
        json(res, 409, { error: 'Les étapes ne se modifient qu\'en brouillon. Dupliquez la campagne pour la rejouer.' });
        return true;
      }

      const parsed = wantsSteps ? parseSteps(body.steps) : null;
      if (parsed && 'error' in parsed) {
        json(res, 400, { error: parsed.error });
        return true;
      }

      const campaign = await prisma.$transaction(async (tx) => {
        if (parsed && 'steps' in parsed) {
          await tx.campaignStep.deleteMany({ where: { campaignId } });
          await tx.campaignStep.createMany({
            data: parsed.steps.map((step) => ({ ...step, campaignId })),
          });
        }

        return tx.campaign.update({
          where: { id: campaignId },
          data: {
            name: typeof body.name === 'string' ? body.name.trim().slice(0, 120) : undefined,
            description: body.description !== undefined
              ? (typeof body.description === 'string' ? body.description.trim().slice(0, 500) : null)
              : undefined,
            startAt: body.startAt !== undefined
              ? (typeof body.startAt === 'string' && body.startAt ? new Date(body.startAt) : null)
              : undefined,
            audienceRoleIds: body.audienceRoleIds !== undefined ? ids(body.audienceRoleIds) : undefined,
            audienceExcludeRoleIds: body.audienceExcludeRoleIds !== undefined ? ids(body.audienceExcludeRoleIds) : undefined,
            audienceMinLevel: body.audienceMinLevel !== undefined ? positiveOrNull(body.audienceMinLevel) : undefined,
            audienceMinTenureDays: body.audienceMinTenureDays !== undefined ? positiveOrNull(body.audienceMinTenureDays) : undefined,
            audienceInactiveDays: body.audienceInactiveDays !== undefined ? positiveOrNull(body.audienceInactiveDays) : undefined,
            targetGuildIds: body.targetGuildIds !== undefined ? ids(body.targetGuildIds) : undefined,
            inviteCode: body.inviteCode !== undefined
              ? (typeof body.inviteCode === 'string' && body.inviteCode.trim() ? body.inviteCode.trim().slice(0, 30) : null)
              : undefined,
          },
          include: { steps: { orderBy: { position: 'asc' } } },
        });
      });

      json(res, 200, { campaign });
    } catch (err) {
      logger.error('CampaignsAPI', 'Erreur PATCH:', err);
      json(res, 500, { error: 'Erreur lors de la mise à jour de la campagne' });
    }
    return true;
  }

  // DELETE /api/dashboard/guilds/:guildId/campaigns/:id
  if (parts.length === 6 && method === 'DELETE') {
    try {
      const { count } = await prisma.campaign.deleteMany({ where: { id: campaignId, guildId } });
      if (count === 0) {
        json(res, 404, { error: 'Campagne introuvable' });
        return true;
      }

      await pushAudit(guildId, {
        channelId: null,
        user: auditUser,
        action: 'Suppression de campagne',
        context: getGuildName(client, guildId),
        module: 'Campagnes',
        eventType: 'Settings',
        details: campaignId,
      });

      json(res, 200, { success: true });
    } catch (err) {
      logger.error('CampaignsAPI', 'Erreur DELETE:', err);
      json(res, 500, { error: 'Erreur lors de la suppression de la campagne' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/campaigns/:id/status { status }
  if (parts.length === 7 && parts[6] === 'status' && method === 'POST') {
    try {
      const existing = await prisma.campaign.findFirst({ where: { id: campaignId, guildId } });
      if (!existing) {
        json(res, 404, { error: 'Campagne introuvable' });
        return true;
      }

      const body = await readJsonBody<{ status?: unknown }>(req);
      const wanted = body?.status;

      // Seules trois transitions sont pilotees a la main : lancer, annuler,
      // remettre en brouillon. Le passage a RUNNING puis COMPLETED appartient
      // au cycle, qui seul sait ou en sont les etapes.
      if (wanted !== 'SCHEDULED' && wanted !== 'CANCELLED' && wanted !== 'DRAFT') {
        json(res, 400, { error: 'Transition non autorisée' });
        return true;
      }

      if (wanted === 'SCHEDULED' && !existing.startAt) {
        json(res, 400, { error: 'Donnez une date de départ avant de lancer la campagne.' });
        return true;
      }

      const campaign = await prisma.campaign.update({
        where: { id: campaignId },
        data: {
          status: wanted as CampaignStatus,
          // Repasser en brouillon remet les etapes non parties a zero : sans
          // cela, une campagne relancee sauterait tout ce qui etait deja du.
          ...(wanted === 'DRAFT'
            ? { steps: { updateMany: { where: { status: CampaignStepStatus.FAILED }, data: { status: CampaignStepStatus.PENDING, lastError: null } } } }
            : {}),
        },
        include: { steps: { orderBy: { position: 'asc' } } },
      });

      await pushAudit(guildId, {
        channelId: null,
        user: auditUser,
        action: `Campagne : ${wanted}`,
        context: getGuildName(client, guildId),
        module: 'Campagnes',
        eventType: 'Settings',
        details: existing.name,
      });

      json(res, 200, { campaign });
    } catch (err) {
      logger.error('CampaignsAPI', 'Erreur POST status:', err);
      json(res, 500, { error: 'Erreur lors du changement de statut' });
    }
    return true;
  }

  // GET /api/dashboard/guilds/:guildId/campaigns/:id/report
  if (parts.length === 7 && parts[6] === 'report' && method === 'GET') {
    try {
      const exists = await prisma.campaign.findFirst({ where: { id: campaignId, guildId }, select: { id: true } });
      if (!exists) {
        json(res, 404, { error: 'Campagne introuvable' });
        return true;
      }
      json(res, 200, { report: await getCampaignReport(campaignId) });
    } catch (err) {
      logger.error('CampaignsAPI', 'Erreur GET report:', err);
      json(res, 500, { error: 'Erreur lors du calcul des indicateurs' });
    }
    return true;
  }

  return false;
}
