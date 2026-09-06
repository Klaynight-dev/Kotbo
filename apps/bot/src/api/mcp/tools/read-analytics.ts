/** Outils MCP - read analytics (permission READ_ANALYTICS). */
import { analyzeGuildChannelHealth, getChannelHealthDashboardData } from '../../../services/analytics/channelHealthService.js';
import { getHourlyHeatmapData } from '../../../services/analytics/dashboardAnalyticsService.js';
import { resolveGuildTimezone } from '../../../utils/timezone.js';
import { getPredictionData } from '../../../services/analytics/predictionService.js';
import { getPulseDashboardData } from '../../../services/analytics/pulseService.js';
import prisma from '../../../utils/db.js';
import { z } from 'zod';
import { type McpToolContext, err, ok, resolveMember } from '../toolkit.js';

export function registerReadAnalyticsTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, toolMeta } = ctx;

  if (shouldRegister('READ_ANALYTICS')) {
    server.registerTool(
      'get_channel_analytics',
      {
        description: "Statistiques d'activité par salon sur une période donnée (messages, auteurs uniques, vocal).",
        inputSchema: {
          period_days: z.number().int().min(1).max(90).default(7).describe('Nombre de jours à analyser'),
          limit: z.number().int().min(1).max(50).default(20).describe('Nombre de salons à retourner'),
        },
        _meta: toolMeta,
      },
      guard('READ_ANALYTICS', async ({ period_days, limit }) => {
        const since = new Date();
        since.setDate(since.getDate() - period_days);
        const sinceKey = since.toISOString().slice(0, 10);

        const stats = await prisma.channelDailyStat.groupBy({
          by: ['channelId'],
          where: { guildId, dateKey: { gte: sinceKey } },
          _sum: { messagesCount: true, uniqueAuthors: true, voiceMinutes: true },
          orderBy: { _sum: { messagesCount: 'desc' } },
          take: limit,
        });

        const guild = client.guilds.cache.get(guildId);
        return ok(
          stats.map((s) => {
            const ch = guild?.channels.cache.get(s.channelId);
            return {
              channelId: s.channelId,
              channelName: ch?.name ?? null,
              totalMessages: s._sum.messagesCount ?? 0,
              totalUniqueAuthors: s._sum.uniqueAuthors ?? 0,
              totalVoiceMinutes: s._sum.voiceMinutes ?? 0,
            };
          })
        );
      })
    );

    server.registerTool(
      'get_hourly_activity',
      {
        description:
          "Activité horaire du serveur (heatmap) pour visualiser les pics d'activité. "
          + 'Les heures sont exprimées dans le fuseau du serveur.',
        inputSchema: {
          days: z.number().int().min(1).max(30).default(7).describe('Nombre de jours à analyser'),
        },
        _meta: toolMeta,
      },
      guard('READ_ANALYTICS', async ({ days }) => {
        // Le fuseau du serveur plutot qu'UTC : une grille jour x heure lue en
        // UTC decrit des pics que personne n'observe a cette heure-la.
        const timezone = await resolveGuildTimezone(guildId);
        const data = await getHourlyHeatmapData(guildId, { days, timezone });
        return ok({ timezone, heatmap: data });
      })
    );

    server.registerTool(
      'get_pulse_dashboard',
      {
        description:
          'Score de santé du serveur (Pulse) avec détails par catégorie : activité, modération, croissance, engagement.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_ANALYTICS', async () => {
        const data = await getPulseDashboardData(guildId);
        return ok(data);
      })
    );

    server.registerTool(
      'get_member_daily_stats',
      {
        description: "Statistiques quotidiennes d'un membre spécifique (messages, vocal par jour).",
        inputSchema: {
          member: z.string().describe('Nom, surnom, @mention ou ID Discord du membre'),
          period_days: z.number().int().min(1).max(30).default(7),
        },
        _meta: toolMeta,
      },
      guard('READ_ANALYTICS', async ({ member, period_days }) => {
        const resolved = await resolveMember(guildId, member);
        if (!resolved.ok) return resolved.response;

        const since = new Date();
        since.setDate(since.getDate() - period_days);
        const sinceKey = since.toISOString().slice(0, 10);

        const stats = await prisma.memberDailyStat.findMany({
          where: { guildId, userId: resolved.userId, dateKey: { gte: sinceKey } },
          orderBy: { dateKey: 'asc' },
        });

        return ok({
          userId: resolved.userId,
          name: resolved.label,
          period: { from: sinceKey, days: period_days },
          daily: stats.map((s) => ({
            date: s.dateKey,
            messages: s.messagesCount,
            voiceMinutes: s.voiceMinutes,
          })),
          totals: stats.reduce(
            (acc: { messages: number; voiceMinutes: number }, s) => ({
              messages: acc.messages + s.messagesCount,
              voiceMinutes: acc.voiceMinutes + s.voiceMinutes,
            }),
            { messages: 0, voiceMinutes: 0 }
          ),
        });
      })
    );

    server.registerTool(
      'get_prediction_data',
      {
        description: "Prédictions d'activité du serveur (tendances, projections de croissance, prévisions de churn).",
        inputSchema: {
          days: z.number().int().min(7).max(90).default(30).describe("Nombre de jours d'historique pour les prédictions"),
        },
        _meta: toolMeta,
      },
      guard('READ_ANALYTICS', async ({ days }) => {
        const data = await getPredictionData(guildId, days);
        return ok(data);
      })
    );

    server.registerTool(
      'get_channel_health',
      {
        description: 'Récupère la configuration et les alertes de santé des salons (Channel Health). Requiert READ_ANALYTICS.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_ANALYTICS', async () => {
        try {
          const data = await getChannelHealthDashboardData(guildId);
          return ok(data);
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'analyze_channel_health',
      {
        description: 'Lance une analyse de santé des salons (surcharge, sous-utilisation, morts). Requiert READ_ANALYTICS.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('READ_ANALYTICS', async () => {
        try {
          const summary = await analyzeGuildChannelHealth(client, guildId);
          return ok(summary ?? { channels: [], overloaded: [], underused: [], dead: [], healthy: [] });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
  }
}
