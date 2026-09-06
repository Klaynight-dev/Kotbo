import type { Prisma } from '@prisma/client';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import {
  json,
  readJsonBody,
  broadcastDashboardStateChange,
  type AuthClaims,
  type DashboardAccess,
} from '../../shared.js';
import {
  getEvents,
  getEvent,
  createEvent,
  publishEvent,
  nextQuestion,
  getEventStats,
  prevQuestion,
  finishEvent,
  deleteEvent,
  createCustomEvent,
} from '../../../services/features/eventService.js';
import {
  getEventRegistrations,
  removeEventRegistration,
} from '../../../services/features/customFormService.js';
import { getMemberIdentities } from '../../../services/moderation/memberIdentityService.js';

export async function handleEventsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  user: AuthClaims,
  guildId: string,
  _access: DashboardAccess
): Promise<boolean> {
  const method = req.method;

  if (parts[4] !== 'events') {
    return false;
  }

  // GET /api/dashboard/guilds/:guildId/events
  if (method === 'GET' && !parts[5]) {
    try {
      const events = await getEvents(guildId);
      json(res, 200, { events });
    } catch (err) {
      logger.error('EventsAPI', err);
      json(res, 500, { error: 'Erreur récupération événements' });
    }
    return true;
  }

  // POST /api/dashboard/guilds/:guildId/events
  if (method === 'POST' && !parts[5]) {
    try {
      const body = await readJsonBody<Record<string, unknown>>(req);
      if (!body || typeof body.title !== 'string' || !body.title.trim()) {
        json(res, 400, { error: 'Le titre de l\'événement est requis.' });
        return true;
      }

      let event;
      if (body.type === 'CUSTOM') {
        event = await createCustomEvent(client, guildId, body as Parameters<typeof createCustomEvent>[2]);
      } else {
        if (body.type !== 'QUIZ' && body.type !== 'CTF') {
          json(res, 400, { error: "Type d'événement invalide : attendu CUSTOM, QUIZ ou CTF." });
          return true;
        }
        event = await createEvent(guildId, body as Parameters<typeof createEvent>[1]);
      }
      broadcastDashboardStateChange(guildId, 'events_updated');
      json(res, 201, { event });
    } catch (err) {
      logger.error('EventsAPI', err);
      json(res, 500, { error: 'Erreur création événement' });
    }
    return true;
  }

  // Routes avec :eventId
  if (parts[5]) {
    const eventId = parts[5];

    // GET /api/dashboard/guilds/:guildId/events/:eventId
    if (method === 'GET' && !parts[6]) {
      try {
        const event = await getEvent(eventId);
        json(res, 200, { event });
      } catch (err) {
        logger.error('EventsAPI', err);
        json(res, 500, { error: 'Erreur récupération événement' });
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/events/:eventId
    if (method === 'DELETE' && !parts[6]) {
      try {
        await deleteEvent(client, eventId);
        broadcastDashboardStateChange(guildId, 'events_updated');
        json(res, 200, { success: true });
      } catch (err) {
        logger.error('EventsAPI', err);
        json(res, 500, { error: 'Erreur suppression événement' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/events/:eventId/publish
    if (method === 'POST' && parts[6] === 'publish') {
      try {
        const event = await publishEvent(client, eventId);
        broadcastDashboardStateChange(guildId, 'events_updated');
        json(res, 200, { event });
      } catch (err) {
        logger.error('EventsAPI', err);
        json(res, 500, { error: (err as Error).message });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/events/:eventId/next
    if (method === 'POST' && parts[6] === 'next') {
      try {
        const result = await nextQuestion(client, eventId);
        broadcastDashboardStateChange(guildId, 'events_updated');
        json(res, 200, result);
      } catch (err) {
        logger.error('EventsAPI', err);
        json(res, 500, { error: (err as Error).message });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/events/:eventId/prev
    if (method === 'POST' && parts[6] === 'prev') {
      try {
        const result = await prevQuestion(client, eventId);
        broadcastDashboardStateChange(guildId, 'events_updated');
        json(res, 200, result);
      } catch (err) {
        logger.error('EventsAPI', err);
        json(res, 500, { error: (err as Error).message });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/events/:eventId/finish
    if (method === 'POST' && parts[6] === 'finish') {
      try {
        const result = await finishEvent(client, eventId);
        broadcastDashboardStateChange(guildId, 'events_updated');
        json(res, 200, result);
      } catch (err) {
        logger.error('EventsAPI', err);
        json(res, 500, { error: (err as Error).message });
      }
      return true;
    }

    // PATCH /api/dashboard/guilds/:guildId/events/:eventId
    if (method === 'PATCH' && !parts[6]) {
      try {
        const body = await readJsonBody<Record<string, unknown>>(req);
        if (!body) {
          json(res, 400, { error: 'Corps de requête invalide.' });
          return true;
        }
        const currentEvent = await prisma.event.findUnique({ where: { id: eventId } });
        const isLive = currentEvent?.status === 'ONGOING';

        // Le corps vient du dashboard : on ne recopie que les champs presents,
        // et les listes imbriquees ne sont acceptees que dans leur forme attendue.
        const quizQuestions = Array.isArray(body.questions) ? body.questions as Record<string, unknown>[] : null;
        const ctfChallenges = Array.isArray(body.ctfChallenges) ? body.ctfChallenges as Record<string, unknown>[] : null;

        const event = await prisma.event.update({
          where: { id: eventId },
          data: {
            title: body.title,
            description: body.description,
            channelId: body.channelId,
            announcementChannelId: body.announcementChannelId,
            formId: body.formId,
            triggerType: body.triggerType,
            triggerValue: body.triggerValue,
            config: body.config,
            triggerStatus: (body.triggerType !== currentEvent?.triggerType || body.triggerValue !== currentEvent?.triggerValue) ? 'PENDING' : undefined,
            questions: (quizQuestions && !isLive && currentEvent?.type === 'QUIZ') ? {
              deleteMany: {},
              create: quizQuestions.map((q, i) => ({
                text: q.text,
                options: q.options,
                correctOptionIndex: q.correctOptionIndex,
                sortOrder: i,
                imageUrl: q.imageUrl
              }))
            } : undefined,
            ctfChallenges: (ctfChallenges && !isLive && currentEvent?.type === 'CTF') ? {
              deleteMany: {},
              create: ctfChallenges.map((c, i) => ({
                title: c.title,
                description: c.description || '',
                flag: c.flag,
                points: Number(c.points) || 100,
                roleIdReward: c.roleIdReward || null,
                xpReward: Number(c.xpReward) || 0,
                imageUrl: c.imageUrl || null,
                sortOrder: i
              }))
            } : undefined
          } as Prisma.EventUpdateInput,
          include: { questions: true, ctfChallenges: true },
        });

        if (isLive && quizQuestions && currentEvent?.type === 'QUIZ') {
          const existingQuestions = await prisma.eventQuizQuestion.findMany({
            where: { eventId },
            orderBy: { sortOrder: 'asc' }
          });

          for (let i = 0; i < Math.min(existingQuestions.length, quizQuestions.length); i++) {
            const q = quizQuestions[i];
            if (i < existingQuestions.length) {
              await prisma.eventQuizQuestion.update({
                where: { id: existingQuestions[i].id },
                data: {
                  text: String(q.text ?? ''),
                  options: (q.options ?? []) as Prisma.InputJsonValue,
                  correctOptionIndex: Number(q.correctOptionIndex ?? 0),
                  imageUrl: typeof q.imageUrl === 'string' ? q.imageUrl : null,
                }
              });
            }
          }
        }

        if (isLive && ctfChallenges && currentEvent?.type === 'CTF') {
          const existingChallenges = await prisma.eventCtfChallenge.findMany({
            where: { eventId },
            orderBy: { sortOrder: 'asc' }
          });

          for (let i = 0; i < Math.min(existingChallenges.length, ctfChallenges.length); i++) {
            const c = ctfChallenges[i];
            await prisma.eventCtfChallenge.update({
              where: { id: existingChallenges[i].id },
              data: {
                title: String(c.title ?? ''),
                description: typeof c.description === 'string' ? c.description : '',
                flag: String(c.flag ?? ''),
                points: Number(c.points) || 100,
                roleIdReward: typeof c.roleIdReward === 'string' ? c.roleIdReward : null,
                xpReward: Number(c.xpReward) || 0,
                imageUrl: typeof c.imageUrl === 'string' ? c.imageUrl : null,
              }
            });
          }
        }

        broadcastDashboardStateChange(guildId, 'events_updated');
        json(res, 200, { event });
      } catch (err) {
        logger.error('EventsAPI', err);
        json(res, 500, { error: (err as Error).message });
      }
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/events/:eventId/stats
    if (method === 'GET' && parts[6] === 'stats') {
      try {
        const stats = await getEventStats(eventId);
        json(res, 200, { stats });
      } catch (err) {
        logger.error('EventsAPI', err);
        json(res, 500, { error: 'Erreur récupération stats' });
      }
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/events/:eventId/registrations
    if (method === 'GET' && parts[6] === 'registrations') {
      try {
        const registrations = await getEventRegistrations(eventId);
        // L'inscription ne garde que l'identifiant et le pseudo fige au moment
        // de l'inscription : la photo doit etre resolue ici.
        const identities = await getMemberIdentities(
          client,
          guildId,
          registrations.map((registration) => registration.userId),
        );
        json(res, 200, {
          registrations: registrations.map((registration) => {
            const identity = identities.get(registration.userId);
            return {
              ...registration,
              username: identity?.displayName || registration.username,
              avatarUrl: identity?.avatarUrl || null,
            };
          }),
        });
      } catch (err) {
        logger.error('EventsAPI', err);
        json(res, 500, { error: 'Erreur récupération inscriptions' });
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/events/:eventId/registrations/:userId
    if (method === 'DELETE' && parts[6] === 'registrations' && parts[7]) {
      try {
        await removeEventRegistration(eventId, parts[7]);
        broadcastDashboardStateChange(guildId, 'events_updated');
        json(res, 200, { ok: true });
      } catch (err) {
        logger.error('EventsAPI', err);
        json(res, 500, { error: 'Erreur suppression inscription' });
      }
      return true;
    }
  }

  return false;
}
