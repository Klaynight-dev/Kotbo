/**
 * analytics.ts
 *
 * Routeur d'administration pour les statistiques commerciales et le tunnel
 * d'acquisition (`/api/admin/analytics/*`).
 *
 * Toutes les routes ici sont sous contrôle d'accès administrateur bot, vérifié
 * en amont par `handleAdminRoutes`.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Client } from 'discord.js';
import { json, readJsonBody, type AuthClaims } from '../../shared.js';
import { logger } from '../../../utils/logger.js';
import {
  getFunnelStats,
  getOnboardingFunnelStats,
  getRevenueStats,
  getRetentionCohorts,
  getSegmentsStats,
  getModuleCorrelations,
  getGuildsExplorer,
  getRisksSummary,
  getAlertThresholds,
  saveAlertThresholds,
  exportAnalyticsCsv,
  type AlertThresholds,
} from '../../../services/analytics/adminAnalyticsService.js';
import type { AnalyticsDimension } from '@kotbo/contracts';

export async function handleAdminAnalyticsRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  url: URL,
  client: Client,
  _user: AuthClaims
): Promise<boolean> {
  const method = req.method;

  // Doit être /api/admin/analytics/...
  if (parts[0] !== 'api' || parts[1] !== 'admin' || parts[2] !== 'analytics') {
    return false;
  }

  const sub = parts[3];

  try {
    // 1. GET /api/admin/analytics/funnel/onboarding
    if (sub === 'funnel' && parts[4] === 'onboarding' && method === 'GET') {
      const stats = await getOnboardingFunnelStats({
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        serverKind: url.searchParams.get('serverKind'),
        track: url.searchParams.get('track'),
      });
      json(res, 200, stats);
      return true;
    }

    // 2. GET /api/admin/analytics/funnel
    if (sub === 'funnel' && parts.length === 4 && method === 'GET') {
      const stats = await getFunnelStats({
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        compare: url.searchParams.get('compare') === 'previous',
      });
      json(res, 200, stats);
      return true;
    }

    // 3. GET /api/admin/analytics/revenue/cohorts
    if (sub === 'revenue' && parts[4] === 'cohorts' && method === 'GET') {
      const cohorts = await getRetentionCohorts();
      json(res, 200, cohorts);
      return true;
    }

    // 4. GET /api/admin/analytics/revenue
    if (sub === 'revenue' && parts.length === 4 && method === 'GET') {
      const stats = await getRevenueStats({
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        compare: url.searchParams.get('compare') === 'previous',
      });
      json(res, 200, stats);
      return true;
    }

    // 5. GET /api/admin/analytics/segments
    if (sub === 'segments' && method === 'GET') {
      const stats = await getSegmentsStats({
        dimension: url.searchParams.get('dimension') as AnalyticsDimension | null,
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
      });
      json(res, 200, stats);
      return true;
    }

    // 6. GET /api/admin/analytics/modules
    if (sub === 'modules' && method === 'GET') {
      const stats = await getModuleCorrelations();
      json(res, 200, stats);
      return true;
    }

    // 7. GET /api/admin/analytics/guilds
    if (sub === 'guilds' && method === 'GET') {
      const page = Number(url.searchParams.get('page')) || 1;
      const limit = Number(url.searchParams.get('limit')) || 25;
      const filter = url.searchParams.get('filter') as 'all' | 'paying' | 'trial' | 'churned' | 'at_risk' | 'out_of_tier' | null;
      const search = url.searchParams.get('search');
      const dimension = url.searchParams.get('dimension') as AnalyticsDimension | null;
      const bucket = url.searchParams.get('bucket');

      const data = await getGuildsExplorer(client, {
        page,
        limit,
        filter,
        search,
        dimension,
        bucket,
      });
      json(res, 200, data);
      return true;
    }

    // 8. GET /api/admin/analytics/risks
    if (sub === 'risks' && method === 'GET') {
      const risks = await getRisksSummary(client);
      json(res, 200, risks);
      return true;
    }

    // 9. GET /api/admin/analytics/export.csv
    if (sub === 'export.csv' && method === 'GET') {
      const view = url.searchParams.get('view') || 'funnel';
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const dimension = url.searchParams.get('dimension') as AnalyticsDimension | null;
      const filter = url.searchParams.get('filter');

      const { filename, content } = await exportAnalyticsCsv(client, view, {
        from,
        to,
        dimension,
        filter,
      });

      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.end(content);
      return true;
    }

    // 10. GET /api/admin/analytics/alerts
    if (sub === 'alerts' && method === 'GET') {
      const data = await getAlertThresholds();
      json(res, 200, data);
      return true;
    }

    // 10. POST /api/admin/analytics/alerts
    if (sub === 'alerts' && method === 'POST') {
      const body = await readJsonBody<Partial<AlertThresholds>>(req);
      if (!body) {
        json(res, 400, { error: 'Corps de requête manquant ou invalide' });
        return true;
      }
      const updated = await saveAlertThresholds(body);
      json(res, 200, { thresholds: updated });
      return true;
    }

    return false;
  } catch (error) {
    logger.error('AdminAnalyticsAPI', `Erreur sur /api/admin/analytics/${sub ?? ''}:`, error);
    json(res, 500, { error: "Erreur interne lors du traitement des statistiques d'acquisition." });
    return true;
  }
}
