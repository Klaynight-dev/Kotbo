import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { HTTPException } from 'hono/http-exception';
import type { Client } from 'discord.js';
import { dashboardCors } from './middleware/cors.js';
import { createHealthRouter } from './routes/health.js';
import { configRouter } from './routes/config.js';
import { eventBusRouter } from './routes/eventBus.js';
import { authRouter } from './routes/auth.js';
import { createPublicProfileRouter } from './routes/public/profile.js';
import { createPublicInviteRouter } from './routes/public/invite.js';
import { createPublicStatsRouter } from './routes/public/stats.js';
import { createPublicFunnelRouter } from './routes/public/funnel.js';
import { createPublicWidgetDataRouter } from './routes/public/widgetData.js';
import { createVerificationRouter } from './routes/verification.js';
import { createChangelogRouter } from './routes/public/changelog.js';
import { createOgRouter } from './routes/public/og.js';
import { createBillingRouter } from './routes/billing.js';
import { logger } from '../../utils/logger.js';

/**
 * Crée et configure l'application Hono avec tous les middlewares et routes.
 * Le Client Discord est injecté pour les routes qui en ont besoin.
 */
export function createHonoApp(client: Client): OpenAPIHono {
  const app = new OpenAPIHono();

  // ---------------------------------------------------------------------------
  // Middlewares globaux
  // ---------------------------------------------------------------------------

  // CORS + headers de sécurité (toutes les routes)
  app.use('*', dashboardCors());

  // Logging des requêtes
  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    if (c.res.status === 404) return;
    const ms = Date.now() - start;
    logger.info('HonoAPI', `${c.req.method} ${c.req.path} → ${c.res.status} (${ms}ms)`);
  });

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------

  app.route('/', createHealthRouter(client));
  app.route('/', configRouter);
  app.route('/', eventBusRouter);
  app.route('/', authRouter);
  app.route('/', createPublicProfileRouter(client));
  app.route('/', createPublicInviteRouter());
  app.route('/', createPublicStatsRouter(client));
  app.route('/', createPublicFunnelRouter());
  app.route('/', createPublicWidgetDataRouter(client));
  app.route('/', createVerificationRouter(client));
  app.route('/', createChangelogRouter());
  app.route('/', createOgRouter(client));
  app.route('/', createBillingRouter(client));

  // ---------------------------------------------------------------------------
  // OpenAPI / Swagger UI (uniquement en développement)
  // ---------------------------------------------------------------------------

  app.doc('/api/openapi.json', {
    openapi:  '3.1.0',
    info: {
      title:   'Kotbo Dashboard API',
      version: '1.0.0',
    },
  });

  if (process.env.NODE_ENV !== 'production') {
    app.get('/api/docs', swaggerUI({ url: '/api/openapi.json' }));
    logger.info('HonoAPI', 'Swagger UI disponible sur /api/docs');
  }

  // ---------------------------------------------------------------------------
  // Gestion d'erreurs globale
  // ---------------------------------------------------------------------------

  app.onError((err, c) => {
    // HTTPException : erreur intentionnelle avec status code
    if (err instanceof HTTPException) {
      return err.getResponse();
    }

    logger.error('HonoAPI', 'Erreur non gérée:', err);
    return c.json({ error: 'Erreur interne du serveur' }, 500);
  });

  app.notFound((c) => {
    // Retourner 404 pour signaler au fallback legacy que la route n'est pas gérée
    return c.json({ error: 'Route introuvable' }, 404);
  });

  return app;
}

/**
 * Type exporté pour le client Hono côté frontend (hono/client).
 * Permet un typage automatique des fetch depuis le dashboard Svelte.
 */
export type AppType = ReturnType<typeof createHonoApp>;
