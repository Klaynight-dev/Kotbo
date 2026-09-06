/**
 * adminAnalyticsService.ts
 *
 * Moteur de calcul pour l'administration du tunnel d'acquisition et des
 * statistiques commerciales.
 *
 * ── Deux modes d'interrogation (spécification §9) ───────────────────────────
 *
 *   - Période <= 7 jours : calcul direct sur les tables temps réel
 *     (`AcquisitionEvent`, `GuildLifecycle`, `BillingInvoice`) afin que la
 *     vue du jour soit immédiatement fraîche.
 *   - Période > 7 jours : exploitation des instantanés quotidiens
 *     (`AnalyticsDailySnapshot`) pour les jours passés, complétée par la
 *     contribution temps réel de la journée courante.
 *
 * Ce service ne jette jamais bruyamment : les erreurs sont tracées et des
 * structures par défaut cohérentes sont renvoyées pour ne jamais bloquer
 * l'interface d'administration.
 */

import type { Client } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import {
  ANALYTICS_DIMENSIONS,
  ONBOARDING_STEPS,
  PLAN_MEMBER_THRESHOLDS,
  SIZE_BUCKETS,
  normalizePlanKey,
  planForMemberCount,
  sizeBucketFor,
  type AnalyticsDimension,
  type OnboardingStep,
  type SizeBucketKey,
} from '@kotbo/contracts';
import { KOTBO_MODULES, type KotboModule } from './moduleStatsService.js';
import { dateKeyFor } from './acquisitionSnapshotService.js';

/**
 * Ce serveur paie-t-il un palier qui ne correspond plus à sa taille ?
 *
 * Le prix suivant la taille du serveur, un serveur qui grossit finit par sortir
 * de la tranche qu'il a souscrite. On compare l'offre en cours à celle que sa
 * taille appelle aujourd'hui plutôt que d'énumérer les seuils à la main : un
 * palier ajouté dans `PLAN_REGISTRY` est ainsi pris en compte sans retoucher
 * l'analytique. `FREE` n'est jamais hors palier - il ne paie rien - et `CUSTOM`
 * non plus, ses conditions étant négociées hors grille.
 */
function isOutOfTier(plan: string, memberCount: number): boolean {
  if (plan === 'FREE' || plan === 'CUSTOM') return false;
  // Effectif inconnu (colonne à null, ramenée à 0 par l'appelant) : on ne
  // signale rien. Accuser un abonné de payer le mauvais palier parce que le
  // cache du bot n'a pas encore compté ses membres serait pire que se taire.
  if (!Number.isFinite(memberCount) || memberCount <= 0) return false;
  return planForMemberCount(memberCount) !== plan;
}

// ─────────────────────────────────────────────────────────────
// Utilitaires de dates et calculs
// ─────────────────────────────────────────────────────────────

export interface DateRange {
  from: Date;
  to: Date;
  daysDiff: number;
  useSnapshots: boolean;
  previousFrom: Date;
  previousTo: Date;
}

export function parseDateRange(fromStr?: string | null, toStr?: string | null): DateRange {
  const now = new Date();
  const to = toStr ? new Date(toStr) : now;
  const defaultFrom = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  const from = fromStr ? new Date(fromStr) : defaultFrom;

  const durationMs = Math.max(to.getTime() - from.getTime(), 24 * 60 * 60 * 1000);
  const daysDiff = Math.ceil(durationMs / (24 * 60 * 60 * 1000));
  const useSnapshots = daysDiff > 7;

  const previousTo = new Date(from.getTime());
  const previousFrom = new Date(from.getTime() - durationMs);

  return { from, to, daysDiff, useSnapshots, previousFrom, previousTo };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function round1(val: number): number {
  return Math.round(val * 10) / 10;
}

function resolveGuildDisplayName(client: Client, guildId: string): string {
  const cached = client.guilds?.cache?.get(guildId);
  return cached?.name ?? `Serveur ${guildId}`;
}

// ─────────────────────────────────────────────────────────────
// 1. Entonnoir d'acquisition (GET /funnel)
// ─────────────────────────────────────────────────────────────

export interface FunnelStepItem {
  step: string;
  label: string;
  name?: string;
  count: number;
  conversionPrevious: number;
  conversionFromPrev?: number;
  conversionTop: number;
  conversionFromFirst?: number;
  medianDurationSeconds: number | null;
}

export interface FunnelResult {
  range?: { from: string; to: string; isRealtime: boolean };
  steps: FunnelStepItem[];
  bySource: Array<{
    source: string;
    visits: number;
    joins: number;
    paid: number;
    conversionRate: number;
  }>;
  byContent: Array<{
    content: string;
    clicks: number;
    joins: number;
    paid: number;
    conversionRate: number;
  }>;
  sources?: Record<string, { visits: number; joins: number; paid: number }>;
  campaigns?: Record<string, { clicks: number; joins: number; paid: number }>;
  contents?: Record<string, { clicks: number; joins: number; paid: number }>;
  comparison?: {
    steps: FunnelStepItem[];
  };
}

const PRIMARY_FUNNEL_STEPS = [
  { step: 'site_visit', label: 'Visite du site' },
  { step: 'pricing_viewed', label: 'Consultation des tarifs' },
  { step: 'invite_clicked', label: "Clic d'invitation" },
  { step: 'invite_redirected', label: "Redirection d'invitation" },
  { step: 'bot_joined', label: 'Installation du bot' },
  { step: 'dashboard_first_open', label: 'Premier accès dashboard' },
  { step: 'onboarding_started', label: 'Démarrage configuration' },
  { step: 'onboarding_completed', label: 'Configuration terminée' },
  { step: 'checkout_started', label: 'Session de paiement ouverte' },
  { step: 'first_payment', label: 'Premier paiement encaissé' },
] as const;

async function computeFunnelCounts(from: Date, to: Date): Promise<{
  counts: Map<string, number>;
  sourceMap: Map<string, { visits: number; joins: number; paid: number }>;
  contentMap: Map<string, { clicks: number; joins: number; paid: number }>;
  durations: Map<string, number[]>;
}> {
  const counts = new Map<string, number>();
  const sourceMap = new Map<string, { visits: number; joins: number; paid: number }>();
  const contentMap = new Map<string, { clicks: number; joins: number; paid: number }>();
  const durations = new Map<string, number[]>();

  for (const item of PRIMARY_FUNNEL_STEPS) {
    counts.set(item.step, 0);
    durations.set(item.step, []);
  }

  try {
    const events = await prisma.acquisitionEvent.findMany({
      where: { occurredAt: { gte: from, lte: to } },
      select: { step: true, source: true, content: true, metadata: true, occurredAt: true, visitorId: true, guildId: true },
    }).catch(() => []);

    for (const ev of events) {
      const currentCount = counts.get(ev.step);
      if (currentCount !== undefined) {
        counts.set(ev.step, currentCount + 1);
      }

      if (ev.source) {
        const src = ev.source;
        if (!sourceMap.has(src)) sourceMap.set(src, { visits: 0, joins: 0, paid: 0 });
        const sm = sourceMap.get(src)!;
        if (ev.step === 'site_visit') sm.visits += 1;
        if (ev.step === 'bot_joined') sm.joins += 1;
        if (ev.step === 'first_payment') sm.paid += 1;
      }

      if (ev.content) {
        const cnt = ev.content;
        if (!contentMap.has(cnt)) contentMap.set(cnt, { clicks: 0, joins: 0, paid: 0 });
        const cm = contentMap.get(cnt)!;
        if (ev.step === 'invite_clicked') cm.clicks += 1;
        if (ev.step === 'bot_joined') cm.joins += 1;
        if (ev.step === 'first_payment') cm.paid += 1;
      }
    }

    const lifecycles = await prisma.guildLifecycle.findMany({
      where: { invitedAt: { gte: from, lte: to } },
      select: {
        invitedAt: true,
        dashboardFirstOpenedAt: true,
        onboardingStartedAt: true,
        onboardingCompletedAt: true,
        onboardingSeconds: true,
        checkoutStartedAt: true,
        firstPaidAt: true,
      },
    }).catch(() => []);

    for (const g of lifecycles) {
      if (g.invitedAt && g.dashboardFirstOpenedAt) {
        const sec = Math.max(0, Math.round((g.dashboardFirstOpenedAt.getTime() - g.invitedAt.getTime()) / 1000));
        durations.get('dashboard_first_open')?.push(sec);
      }
      if (g.onboardingSeconds && g.onboardingSeconds > 0) {
        durations.get('onboarding_completed')?.push(g.onboardingSeconds);
      }
      if (g.checkoutStartedAt && g.firstPaidAt) {
        const sec = Math.max(0, Math.round((g.firstPaidAt.getTime() - g.checkoutStartedAt.getTime()) / 1000));
        durations.get('first_payment')?.push(sec);
      }
    }
  } catch (error) {
    logger.warn('AdminAnalytics', 'computeFunnelCounts fallback:', error);
  }

  return { counts, sourceMap, contentMap, durations };
}

export async function getFunnelStats(options: {
  from?: string | null;
  to?: string | null;
  compare?: boolean;
}): Promise<FunnelResult> {
  const range = parseDateRange(options.from, options.to);
  const currentData = await computeFunnelCounts(range.from, range.to);

  const topCount = currentData.counts.get('site_visit') || currentData.counts.get('bot_joined') || 1;
  let previousStepCount = topCount;

  const steps: FunnelStepItem[] = PRIMARY_FUNNEL_STEPS.map((item, idx) => {
    const count = currentData.counts.get(item.step) || 0;
    const conversionPrevious = idx === 0 ? 100 : previousStepCount > 0 ? round1((count / previousStepCount) * 100) : 0;
    const conversionTop = topCount > 0 ? round1((count / topCount) * 100) : 0;
    previousStepCount = count > 0 ? count : previousStepCount;

    return {
      step: item.step,
      label: item.label,
      name: item.label,
      count,
      conversionPrevious,
      conversionFromPrev: conversionPrevious,
      conversionTop,
      conversionFromFirst: conversionTop,
      medianDurationSeconds: median(currentData.durations.get(item.step) || []),
    };
  });

  const bySource = Array.from(currentData.sourceMap.entries()).map(([source, data]) => ({
    source,
    visits: data.visits,
    joins: data.joins,
    paid: data.paid,
    conversionRate: data.joins > 0 ? round1((data.paid / data.joins) * 100) : 0,
  }));

  const byContent = Array.from(currentData.contentMap.entries()).map(([content, data]) => ({
    content,
    clicks: data.clicks,
    joins: data.joins,
    paid: data.paid,
    conversionRate: data.joins > 0 ? round1((data.paid / data.joins) * 100) : 0,
  }));

  const sources = Object.fromEntries(currentData.sourceMap);
  const contents = Object.fromEntries(currentData.contentMap);
  const campaigns: Record<string, { clicks: number; joins: number; paid: number }> = {};

  const result: FunnelResult = {
    range: { from: range.from.toISOString(), to: range.to.toISOString(), isRealtime: !range.useSnapshots },
    steps,
    bySource,
    byContent,
    sources,
    contents,
    campaigns,
  };

  if (options.compare) {
    const prevData = await computeFunnelCounts(range.previousFrom, range.previousTo);
    const prevTop = prevData.counts.get('site_visit') || prevData.counts.get('bot_joined') || 1;
    let prevPrevCount = prevTop;

    result.comparison = {
      steps: PRIMARY_FUNNEL_STEPS.map((item, idx) => {
        const count = prevData.counts.get(item.step) || 0;
        const conversionPrevious = idx === 0 ? 100 : prevPrevCount > 0 ? round1((count / prevPrevCount) * 100) : 0;
        const conversionTop = prevTop > 0 ? round1((count / prevTop) * 100) : 0;
        prevPrevCount = count > 0 ? count : prevPrevCount;

        return {
          step: item.step,
          label: item.label,
          name: item.label,
          count,
          conversionPrevious,
          conversionFromPrev: conversionPrevious,
          conversionTop,
          conversionFromFirst: conversionTop,
          medianDurationSeconds: median(prevData.durations.get(item.step) || []),
        };
      }),
    };
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// 2. Décrochage du parcours Onboarding (GET /funnel/onboarding)
// ─────────────────────────────────────────────────────────────

export interface OnboardingStepStats {
  step: OnboardingStep;
  eligible: number;
  reached: number;
  dropOffCount: number;
  dropOffRate: number;
  backtracks: number;
  medianDurationSeconds: number | null;
}

export interface OnboardingFunnelResult {
  steps: OnboardingStepStats[];
  stepDropOffs?: Array<{ step: string; count: number; dropOffRate: number }>;
  totalStarted: number;
  totalCompleted: number;
  totalAbandoned: number;
  completionRate?: number;
  medianDurationSeconds?: number | null;
  medianTotalDurationSeconds: number | null;
  byServerKind?: Record<string, { started: number; completed: number; rate: number }>;
  byTrack?: Record<string, { count: number }>;
}

const STEP_TRACK_MAP: Record<string, string | null> = {
  welcome: null,
  kind: null,
  'migration-bots': null,
  'migration-findings': null,
  tracks: null,
  identity: null,
  theme: null,
  tickets: 'tickets',
  structure: 'structure',
  moderation: 'moderation',
  logs: 'logs',
  staff: 'staff',
  greeting: 'greeting',
  rules: 'rules',
  levels: 'levels',
  economy: 'economy',
  'economy-shop': 'economy',
  animation: 'animation',
  'animation-drops': 'animation',
  mcp: 'mcp',
  recap: null,
  checkout: null,
};

function isStepEligible(step: OnboardingStep, serverKind: string | null, tracks: string[]): boolean {
  if (step === 'migration-bots' || step === 'migration-findings') {
    return serverKind === 'existing';
  }
  const requiredTrack = STEP_TRACK_MAP[step];
  if (!requiredTrack) return true;
  return tracks.length === 0 || tracks.includes(requiredTrack);
}

export async function getOnboardingFunnelStats(options: {
  from?: string | null;
  to?: string | null;
  serverKind?: string | null;
  track?: string | null;
}): Promise<OnboardingFunnelResult> {
  const range = parseDateRange(options.from, options.to);

  const lifecycles = await prisma.guildLifecycle.findMany({
    where: {
      onboardingStartedAt: { gte: range.from, lte: range.to },
      ...(options.serverKind ? { serverKind: options.serverKind } : {}),
      ...(options.track ? { tracks: { has: options.track } } : {}),
    },
    select: {
      guildId: true,
      serverKind: true,
      tracks: true,
      onboardingStartedAt: true,
      onboardingCompletedAt: true,
      onboardingLastStep: true,
      onboardingSteps: true,
      onboardingSeconds: true,
    },
  }).catch(() => []);

  const backEvents = await prisma.acquisitionEvent.findMany({
    where: {
      step: 'onboarding_back',
      occurredAt: { gte: range.from, lte: range.to },
    },
    select: { metadata: true },
  }).catch(() => []);

  const backtrackCounts = new Map<string, number>();
  for (const ev of backEvents) {
    const meta = ev.metadata as { from?: string; step?: string } | null;
    const fromStep = meta?.from;
    if (fromStep) {
      backtrackCounts.set(fromStep, (backtrackCounts.get(fromStep) || 0) + 1);
    }
  }

  const stepDurations = new Map<string, number[]>();
  for (const s of ONBOARDING_STEPS) {
    stepDurations.set(s, []);
  }

  const stepsData: OnboardingStepStats[] = ONBOARDING_STEPS.map((step) => {
    let eligible = 0;
    let reached = 0;
    let dropOffCount = 0;

    for (const g of lifecycles) {
      const eligibleForGuild = isStepEligible(step, g.serverKind, g.tracks);
      if (eligibleForGuild) {
        eligible += 1;
        const stepsObj = (g.onboardingSteps as Record<string, string> | null) ?? {};
        if (stepsObj[step]) {
          reached += 1;
        }
        if (g.onboardingLastStep === step && !g.onboardingCompletedAt) {
          dropOffCount += 1;
        }
      }
    }

    const dropOffRate = eligible > 0 ? round1((dropOffCount / eligible) * 100) : 0;
    const backtracks = backtrackCounts.get(step) || 0;

    return {
      step,
      eligible,
      reached,
      dropOffCount,
      dropOffRate,
      backtracks,
      medianDurationSeconds: median(stepDurations.get(step) || []),
    };
  });

  const totalStarted = lifecycles.length;
  const totalCompleted = lifecycles.filter((g) => g.onboardingCompletedAt !== null).length;
  const totalAbandoned = lifecycles.filter((g) => g.onboardingCompletedAt === null && g.onboardingLastStep !== null).length;
  const completionRate = totalStarted > 0 ? round1((totalCompleted / totalStarted) * 100) : 0;

  const totalDurations = lifecycles
    .filter((g) => g.onboardingSeconds && g.onboardingSeconds > 0)
    .map((g) => g.onboardingSeconds!);

  const medianDur = median(totalDurations);

  return {
    steps: stepsData,
    stepDropOffs: stepsData.map((s) => ({ step: s.step, count: s.dropOffCount, dropOffRate: s.dropOffRate })),
    totalStarted,
    totalCompleted,
    totalAbandoned,
    completionRate,
    medianDurationSeconds: medianDur,
    medianTotalDurationSeconds: medianDur,
    byServerKind: {},
    byTrack: {},
  };
}

// ─────────────────────────────────────────────────────────────
// 3. Revenus et cascade MRR (GET /revenue)
// ─────────────────────────────────────────────────────────────

export interface RevenueStatsResult {
  mrrCents: number;
  arrCents: number;
  arpaCents: number;
  collectedCents: number;
  payingGuilds: number;
  series: Array<{
    dateKey: string;
    mrrCents: number;
    collectedCents: number;
    payingCount: number;
  }>;
  waterfall: {
    mrrStartCents: number;
    newCents: number;
    expansionCents: number;
    contractionCents: number;
    churnCents: number;
    reactivationCents: number;
    residualCents: number;
    mrrEndCents: number;
  };
  byInterval: {
    month: { count: number; mrrCents: number };
    year: { count: number; mrrCents: number };
  };
  byPlan: Record<string, { count: number; mrrCents: number }>;
  recentInvoices: Array<{
    id: string;
    guildId: string | null;
    plan: string;
    interval: string | null;
    status: string;
    amountPaidCents: number;
    paidAt: Date | null;
  }>;
  comparison?: {
    mrrCentsDelta: number;
    collectedCentsDelta: number;
    payingGuildsDelta: number;
  };
}

export async function getRevenueStats(options: {
  from?: string | null;
  to?: string | null;
  compare?: boolean;
}): Promise<RevenueStatsResult> {
  const range = parseDateRange(options.from, options.to);

  const activePayingGuilds = await prisma.guildLifecycle.findMany({
    where: {
      plan: { not: 'FREE' },
      churnedAt: null,
    },
    select: {
      guildId: true,
      plan: true,
      interval: true,
      mrrCents: true,
    },
  }).catch(() => []);

  const mrrCents = activePayingGuilds.reduce((sum, g) => sum + g.mrrCents, 0);
  const payingGuilds = activePayingGuilds.length;
  const arrCents = mrrCents * 12;
  const arpaCents = payingGuilds > 0 ? Math.round(mrrCents / payingGuilds) : 0;

  const byInterval = {
    month: { count: 0, mrrCents: 0 },
    year: { count: 0, mrrCents: 0 },
  };
  const byPlan: Record<string, { count: number; mrrCents: number }> = {
    PLUS: { count: 0, mrrCents: 0 },
    PRO: { count: 0, mrrCents: 0 },
    ULTIMATE: { count: 0, mrrCents: 0 },
    CUSTOM: { count: 0, mrrCents: 0 },
  };

  for (const g of activePayingGuilds) {
    const p = normalizePlanKey(g.plan);
    if (!byPlan[p]) byPlan[p] = { count: 0, mrrCents: 0 };
    byPlan[p].count += 1;
    byPlan[p].mrrCents += g.mrrCents;

    if (g.interval === 'year') {
      byInterval.year.count += 1;
      byInterval.year.mrrCents += g.mrrCents;
    } else {
      byInterval.month.count += 1;
      byInterval.month.mrrCents += g.mrrCents;
    }
  }

  const invoices = await prisma.billingInvoice.findMany({
    where: {
      status: 'paid',
      paidAt: { gte: range.from, lte: range.to },
    },
    select: { amountPaidCents: true },
  }).catch(() => []);
  const collectedCents = invoices.reduce((sum, inv) => sum + inv.amountPaidCents, 0);

  const startKey = dateKeyFor(range.from);
  const endKey = dateKeyFor(range.to);

  const snapshots = await prisma.analyticsDailySnapshot.findMany({
    where: {
      dimension: 'global',
      bucket: '',
      dateKey: { gte: startKey, lte: endKey },
    },
    orderBy: { dateKey: 'asc' },
  }).catch(() => []);

  const series = snapshots.map((s) => {
    const m = s.metrics as Record<string, number>;
    return {
      dateKey: s.dateKey,
      mrrCents: m.mrrCents ?? 0,
      collectedCents: m.collectedCents ?? 0,
      payingCount: m.paying ?? 0,
    };
  });

  const newPayingGuilds = await prisma.guildLifecycle.findMany({
    where: {
      firstPaidAt: { gte: range.from, lte: range.to },
      plan: { not: 'FREE' },
    },
    select: { mrrCents: true },
  }).catch(() => []);
  const newCents = newPayingGuilds.reduce((sum, g) => sum + g.mrrCents, 0);

  const churnedGuilds = await prisma.guildLifecycle.findMany({
    where: {
      churnedAt: { gte: range.from, lte: range.to },
    },
    select: { mrrCents: true },
  }).catch(() => []);
  const churnCents = churnedGuilds.reduce((sum, g) => sum + g.mrrCents, 0);

  const upgradeEvents = await prisma.acquisitionEvent.findMany({
    where: {
      step: 'plan_upgraded',
      occurredAt: { gte: range.from, lte: range.to },
    },
    select: { metadata: true },
  }).catch(() => []);
  let expansionCents = 0;
  for (const ev of upgradeEvents) {
    const meta = ev.metadata as { mrrCents?: number } | null;
    expansionCents += meta?.mrrCents ?? 0;
  }

  const downgradeEvents = await prisma.acquisitionEvent.findMany({
    where: {
      step: 'plan_downgraded',
      occurredAt: { gte: range.from, lte: range.to },
    },
    select: { metadata: true },
  }).catch(() => []);
  let contractionCents = 0;
  for (const ev of downgradeEvents) {
    const meta = ev.metadata as { mrrCents?: number } | null;
    contractionCents += meta?.mrrCents ?? 0;
  }

  const mrrStartCents = series.length > 0 ? series[0].mrrCents : mrrCents;
  const mrrEndCents = mrrCents;
  const calculatedEnd = mrrStartCents + newCents + expansionCents - contractionCents - churnCents;
  const residualCents = mrrEndCents - calculatedEnd;

  const waterfall = {
    mrrStartCents,
    newCents,
    expansionCents,
    contractionCents,
    churnCents,
    reactivationCents: 0,
    residualCents,
    mrrEndCents,
  };

  const recentInvoices = await prisma.billingInvoice.findMany({
    take: 15,
    orderBy: { issuedAt: 'desc' },
    select: {
      id: true,
      guildId: true,
      plan: true,
      interval: true,
      status: true,
      amountPaidCents: true,
      paidAt: true,
    },
  }).catch(() => []);

  const result: RevenueStatsResult = {
    mrrCents,
    arrCents,
    arpaCents,
    collectedCents,
    payingGuilds,
    series,
    waterfall,
    byInterval,
    byPlan,
    recentInvoices,
  };

  if (options.compare) {
    const prevInvoices = await prisma.billingInvoice.findMany({
      where: { status: 'paid', paidAt: { gte: range.previousFrom, lte: range.previousTo } },
      select: { amountPaidCents: true },
    }).catch(() => []);
    const prevCollected = prevInvoices.reduce((sum, inv) => sum + inv.amountPaidCents, 0);

    result.comparison = {
      mrrCentsDelta: 0,
      collectedCentsDelta: collectedCents - prevCollected,
      payingGuildsDelta: 0,
    };
  }

  return result;
}

// ─────────────────────────────────────────────────────────────
// 4. Matrice de rétention par cohorte (GET /revenue/cohorts)
// ─────────────────────────────────────────────────────────────

export interface CohortPeriod {
  periodIndex?: number;
  retainedPct: number | null;
  retentionRate?: number;
  retainedMrrPct: number | null;
  activeCount: number | null;
  mrrCents: number | null;
}

export interface CohortRow {
  cohortMonth: string;
  initialGuilds: number;
  initialMrrCents: number;
  periods: CohortPeriod[];
}

export async function getRetentionCohorts(): Promise<{ cohorts: CohortRow[] }> {
  const paidGuilds = await prisma.guildLifecycle.findMany({
    where: { firstPaidAt: { not: null } },
    select: {
      guildId: true,
      firstPaidAt: true,
      churnedAt: true,
      mrrCents: true,
    },
  }).catch(() => []);

  type CohortMember = {
    guildId: string;
    firstPaidAt: Date | null;
    churnedAt: Date | null;
    mrrCents: number;
  };
  const cohortGroups = new Map<string, CohortMember[]>();
  for (const g of paidGuilds) {
    if (!g.firstPaidAt) continue;
    const monthKey = g.firstPaidAt.toISOString().slice(0, 7);
    if (!cohortGroups.has(monthKey)) cohortGroups.set(monthKey, []);
    cohortGroups.get(monthKey)!.push(g);
  }

  const now = new Date();
  const currentMonthKey = now.toISOString().slice(0, 7);
  const sortedMonths = Array.from(cohortGroups.keys()).sort().slice(-12);

  const cohorts: CohortRow[] = sortedMonths.map((cohortMonth) => {
    const members = cohortGroups.get(cohortMonth)!;
    const initialGuilds = members.length;
    const initialMrrCents = members.reduce((sum, m) => sum + m.mrrCents, 0);

    const [cYear, cMonth] = cohortMonth.split('-').map(Number);
    const periods: CohortPeriod[] = [];

    for (let offset = 0; offset <= 12; offset++) {
      const targetDate = new Date(Date.UTC(cYear, cMonth - 1 + offset, 1));
      const targetMonthKey = targetDate.toISOString().slice(0, 7);

      if (targetMonthKey > currentMonthKey) {
        periods.push({ periodIndex: offset, retainedPct: null, retentionRate: 0, retainedMrrPct: null, activeCount: null, mrrCents: null });
        continue;
      }

      const nextMonthDate = new Date(Date.UTC(cYear, cMonth + offset, 1));
      const activeAtPeriod = members.filter((g) => {
        if (!g.churnedAt) return true;
        return g.churnedAt >= nextMonthDate;
      });

      const activeCount = activeAtPeriod.length;
      const mrr = activeAtPeriod.reduce((sum, m) => sum + m.mrrCents, 0);
      const rate = initialGuilds > 0 ? round1((activeCount / initialGuilds) * 100) : 0;

      periods.push({
        periodIndex: offset,
        retainedPct: rate,
        retentionRate: rate,
        retainedMrrPct: initialMrrCents > 0 ? round1((mrr / initialMrrCents) * 100) : 0,
        activeCount,
        mrrCents: mrr,
      });
    }

    return { cohortMonth, initialGuilds, initialMrrCents, periods };
  });

  return { cohorts };
}

// ─────────────────────────────────────────────────────────────
// 5. Segments et matrice de taille (GET /segments)
// ─────────────────────────────────────────────────────────────

export interface SegmentRow {
  bucket: string;
  guilds: number;
  paying: number;
  conversionRate: number;
  mrrCents: number;
  arpaCents: number;
  churned: number;
  churnRate: number;
}

export interface CrossMatrixCell {
  count: number;
  isOutOfTier: boolean;
}

export interface SegmentsResult {
  dimension: AnalyticsDimension;
  segments: SegmentRow[];
  distribution?: Array<{
    bucket: string;
    totalGuilds: number;
    payingGuilds: number;
    trialGuilds: number;
    conversionRate: number;
    mrrCents: number;
    avgLtvCents: number;
  }>;
  outOfTierMatrix?: Array<{
    guildId: string;
    guildName: string;
    memberCount: number;
    currentPlan: string;
    recommendedPlan: string;
    mrrCents: number;
  }>;
  crossMatrix: {
    rows: SizeBucketKey[];
    columns: string[];
    data: Record<SizeBucketKey, Record<string, CrossMatrixCell>>;
  };
}

export async function getSegmentsStats(options: {
  dimension?: AnalyticsDimension | null;
  from?: string | null;
  to?: string | null;
}): Promise<SegmentsResult> {
  const dimension: AnalyticsDimension = options.dimension && ANALYTICS_DIMENSIONS.includes(options.dimension)
    ? options.dimension
    : 'size';

  const guilds = await prisma.guildLifecycle.findMany({
    select: {
      guildId: true,
      plan: true,
      interval: true,
      mrrCents: true,
      memberCount: true,
      source: true,
      activationOrigin: true,
      serverKind: true,
      instanceId: true,
      locale: true,
      churnedAt: true,
    },
  }).catch(() => []);

  const bucketMap = new Map<string, { guilds: number; paying: number; mrrCents: number; churned: number }>();

  function resolveBucketValue(g: typeof guilds[number], dim: AnalyticsDimension): string {
    switch (dim) {
      case 'size':
        return sizeBucketFor(g.memberCount);
      case 'plan':
        return normalizePlanKey(g.plan);
      case 'source':
        return g.source ?? 'inconnu';
      case 'origin':
        return g.activationOrigin ?? 'inconnu';
      case 'kind':
        return g.serverKind ?? 'inconnu';
      case 'instance':
        return g.instanceId ?? 'principale';
      case 'locale':
        return g.locale ?? 'inconnu';
      case 'interval':
        return g.interval ?? 'aucun';
      case 'global':
      default:
        return 'global';
    }
  }

  for (const g of guilds) {
    const val = resolveBucketValue(g, dimension);
    if (!bucketMap.has(val)) {
      bucketMap.set(val, { guilds: 0, paying: 0, mrrCents: 0, churned: 0 });
    }
    const b = bucketMap.get(val)!;
    b.guilds += 1;
    const isPaying = normalizePlanKey(g.plan) !== 'FREE' && !g.churnedAt;
    if (isPaying) {
      b.paying += 1;
      b.mrrCents += g.mrrCents;
    }
    if (g.churnedAt) {
      b.churned += 1;
    }
  }

  const segments: SegmentRow[] = Array.from(bucketMap.entries()).map(([bucket, data]) => ({
    bucket,
    guilds: data.guilds,
    paying: data.paying,
    conversionRate: data.guilds > 0 ? round1((data.paying / data.guilds) * 100) : 0,
    mrrCents: data.mrrCents,
    arpaCents: data.paying > 0 ? Math.round(data.mrrCents / data.paying) : 0,
    churned: data.churned,
    churnRate: data.guilds > 0 ? round1((data.churned / data.guilds) * 100) : 0,
  }));

  const columns = ['FREE', 'PLUS', 'PRO', 'ULTIMATE', 'CUSTOM'];
  const sizeKeys: SizeBucketKey[] = ['0-100', '100-1k', '1k-10k', '10k-100k', '100k+'];

  const matrixData: Record<SizeBucketKey, Record<string, CrossMatrixCell>> = {} as never;
  for (const k of sizeKeys) {
    matrixData[k] = {};
    for (const c of columns) {
      matrixData[k][c] = { count: 0, isOutOfTier: false };
    }
  }

  for (const g of guilds) {
    const sBucket = sizeBucketFor(g.memberCount);
    const plan = normalizePlanKey(g.plan);
    if (!matrixData[sBucket][plan]) matrixData[sBucket][plan] = { count: 0, isOutOfTier: false };
    matrixData[sBucket][plan].count += 1;

    const mCount = g.memberCount ?? 0;
    if (isOutOfTier(plan, mCount)) {
      matrixData[sBucket][plan].isOutOfTier = true;
    }
  }

  const distribution = segments.map((s) => ({
    bucket: s.bucket,
    totalGuilds: s.guilds,
    payingGuilds: s.paying,
    trialGuilds: 0,
    conversionRate: s.conversionRate,
    mrrCents: s.mrrCents,
    avgLtvCents: s.arpaCents,
  }));

  const outOfTierMatrix: Array<{
    guildId: string;
    guildName: string;
    memberCount: number;
    currentPlan: string;
    recommendedPlan: string;
    mrrCents: number;
  }> = [];

  for (const g of guilds) {
    const mCount = g.memberCount ?? 0;
    const plan = normalizePlanKey(g.plan);
    if (isOutOfTier(plan, mCount)) {
      outOfTierMatrix.push({
        guildId: g.guildId,
        guildName: g.guildId,
        memberCount: mCount,
        currentPlan: plan,
        recommendedPlan: planForMemberCount(mCount),
        mrrCents: g.mrrCents,
      });
    }
  }

  return {
    dimension,
    segments,
    distribution,
    outOfTierMatrix,
    crossMatrix: {
      rows: sizeKeys,
      columns,
      data: matrixData,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// 6. Modules et corrélation à la conversion (GET /modules)
// ─────────────────────────────────────────────────────────────

export interface ModuleCorrelationItem {
  module: KotboModule;
  enabledGuilds: number;
  activationRate: number;
  usedLast30Days: number;
  conversionWithModule: number;
  conversionWithoutModule: number;
  sampleCountWith: number;
  sampleCountWithout: number;
  sampleTooLow: boolean;
}

export interface ModuleCorrelationsResult {
  modules: ModuleCorrelationItem[];
  moduleAdoption?: Array<{
    module: string;
    freeAdoptionRate: number;
    paidAdoptionRate: number;
    totalActive: number;
  }>;
  churnDropOffModules?: Array<{
    module: string;
    dropOffCount: number;
  }>;
}

export async function getModuleCorrelations(): Promise<ModuleCorrelationsResult> {
  const activeGuildCount = await prisma.guild.count().catch(() => 0);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const activations = await prisma.moduleActivationStat.findMany({
    where: { enabled: true },
    select: { moduleName: true, guildId: true, lastUsedAt: true },
  }).catch(() => []);

  const activationsByModule = new Map<string, Set<string>>();
  const usedByModule = new Map<string, Set<string>>();

  for (const act of activations) {
    if (!act.guildId) continue;
    if (!activationsByModule.has(act.moduleName)) activationsByModule.set(act.moduleName, new Set());
    activationsByModule.get(act.moduleName)!.add(act.guildId);

    if (act.lastUsedAt && act.lastUsedAt >= thirtyDaysAgo) {
      if (!usedByModule.has(act.moduleName)) usedByModule.set(act.moduleName, new Set());
      usedByModule.get(act.moduleName)!.add(act.guildId);
    }
  }

  const trialGuilds = await prisma.guildLifecycle.findMany({
    where: { trialStartedAt: { not: null } },
    select: { guildId: true, trialConvertedAt: true },
  }).catch(() => []);

  const convertedGuildIds = new Set(
    trialGuilds.filter((g) => g.trialConvertedAt !== null).map((g) => g.guildId)
  );
  const trialGuildIds = new Set(trialGuilds.map((g) => g.guildId));

  const modules: ModuleCorrelationItem[] = KOTBO_MODULES.map((mod) => {
    const enabledSet = activationsByModule.get(mod) || new Set<string>();
    const usedSet = usedByModule.get(mod) || new Set<string>();

    const enabledGuilds = enabledSet.size;
    const activationRate = activeGuildCount > 0 ? round1((enabledGuilds / activeGuildCount) * 100) : 0;
    const usedLast30Days = usedSet.size;

    let withCount = 0;
    let withConverted = 0;
    let withoutCount = 0;
    let withoutConverted = 0;

    for (const guildId of trialGuildIds) {
      if (enabledSet.has(guildId)) {
        withCount += 1;
        if (convertedGuildIds.has(guildId)) withConverted += 1;
      } else {
        withoutCount += 1;
        if (convertedGuildIds.has(guildId)) withoutConverted += 1;
      }
    }

    const conversionWithModule = withCount > 0 ? round1((withConverted / withCount) * 100) : 0;
    const conversionWithoutModule = withoutCount > 0 ? round1((withoutConverted / withoutCount) * 100) : 0;
    const sampleTooLow = withCount < 30 || withoutCount < 30;

    return {
      module: mod,
      enabledGuilds,
      activationRate,
      usedLast30Days,
      conversionWithModule,
      conversionWithoutModule,
      sampleCountWith: withCount,
      sampleCountWithout: withoutCount,
      sampleTooLow,
    };
  });

  const moduleAdoption = modules.map((m) => ({
    module: m.module,
    freeAdoptionRate: m.activationRate,
    paidAdoptionRate: m.activationRate,
    totalActive: m.enabledGuilds,
  }));

  return {
    modules,
    moduleAdoption,
    churnDropOffModules: [],
  };
}

// ─────────────────────────────────────────────────────────────
// 7. Explorateur des serveurs (GET /guilds)
// ─────────────────────────────────────────────────────────────

export interface GuildExplorerItem {
  guildId: string;
  name: string;
  plan: string;
  interval: string | null;
  mrrCents: number;
  memberCount: number | null;
  source: string | null;
  activationOrigin: string | null;
  serverKind: string | null;
  status: 'active_paid' | 'trial' | 'free' | 'churned' | 'at_risk';
  isOutOfTier: boolean;
  invitedAt: Date | null;
  firstPaidAt: Date | null;
  churnedAt: Date | null;
}

export async function getGuildsExplorer(
  client: Client,
  options: {
    filter?: 'all' | 'paying' | 'trial' | 'churned' | 'at_risk' | 'out_of_tier' | null;
    search?: string | null;
    dimension?: AnalyticsDimension | null;
    bucket?: string | null;
    page?: number;
    limit?: number;
  }
): Promise<{
  guilds: GuildExplorerItem[];
  total: number;
  page: number;
  totalPages: number;
}> {
  const page = Math.max(1, options.page || 1);
  const limit = Math.min(100, Math.max(1, options.limit || 25));
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {};

  if (options.search) {
    const s = options.search.trim();
    where.OR = [
      { guildId: { contains: s } },
      { source: { contains: s } },
    ];
  }

  if (options.dimension && options.bucket !== undefined && options.bucket !== null) {
    if (options.dimension === 'plan') where.plan = options.bucket;
    else if (options.dimension === 'source') where.source = options.bucket;
    else if (options.dimension === 'origin') where.activationOrigin = options.bucket;
    else if (options.dimension === 'kind') where.serverKind = options.bucket;
    else if (options.dimension === 'instance') where.instanceId = options.bucket;
    else if (options.dimension === 'locale') where.locale = options.bucket;
    else if (options.dimension === 'interval') where.interval = options.bucket;
    else if (options.dimension === 'size') {
      const b = SIZE_BUCKETS.find((sb) => sb.key === options.bucket);
      if (b) {
        where.memberCount = {
          gte: b.min,
          ...(b.max !== null ? { lte: b.max } : {}),
        };
      }
    }
  }

  if (options.filter === 'paying') {
    where.plan = { not: 'FREE' };
    where.churnedAt = null;
  } else if (options.filter === 'trial') {
    where.trialStartedAt = { not: null };
    where.trialConvertedAt = null;
    where.churnedAt = null;
  } else if (options.filter === 'churned') {
    where.churnedAt = { not: null };
  } else if (options.filter === 'out_of_tier') {
    where.OR = [
      { plan: 'PLUS', memberCount: { gt: PLAN_MEMBER_THRESHOLDS.PRO } },
      { plan: 'PRO', memberCount: { gt: PLAN_MEMBER_THRESHOLDS.ULTIMATE } },
      { plan: 'ULTIMATE', memberCount: { gt: PLAN_MEMBER_THRESHOLDS.CUSTOM } },
    ];
  }

  const [total, lifecycles] = await Promise.all([
    prisma.guildLifecycle.count({ where }).catch(() => 0),
    prisma.guildLifecycle.findMany({
      where,
      skip,
      take: limit,
      orderBy: { invitedAt: 'desc' },
    }).catch(() => []),
  ]);

  const guildIds = lifecycles.map((g) => g.guildId);
  const dbGuilds = await prisma.guild.findMany({
    where: { id: { in: guildIds } },
    select: { id: true, stripeCancelAtPeriodEnd: true, stripeSubscriptionStatus: true },
  }).catch(() => []);
  const dbGuildMap = new Map(dbGuilds.map((g) => [g.id, g]));

  const guilds: GuildExplorerItem[] = lifecycles.map((g) => {
    const name = resolveGuildDisplayName(client, g.guildId);
    const dbG = dbGuildMap.get(g.guildId);
    const plan = normalizePlanKey(g.plan);
    const mCount = g.memberCount ?? 0;
    const outOfTier = isOutOfTier(plan, mCount);

    let status: GuildExplorerItem['status'] = 'free';
    if (g.churnedAt) status = 'churned';
    else if (dbG?.stripeSubscriptionStatus === 'past_due' || dbG?.stripeCancelAtPeriodEnd) status = 'at_risk';
    else if (plan !== 'FREE') status = 'active_paid';
    else if (g.trialStartedAt && !g.trialConvertedAt) status = 'trial';

    return {
      guildId: g.guildId,
      name,
      plan: g.plan,
      interval: g.interval,
      mrrCents: g.mrrCents,
      memberCount: g.memberCount,
      source: g.source,
      activationOrigin: g.activationOrigin,
      serverKind: g.serverKind,
      status,
      isOutOfTier: outOfTier,
      invitedAt: g.invitedAt,
      firstPaidAt: g.firstPaidAt,
      churnedAt: g.churnedAt,
    };
  });

  return {
    guilds,
    total,
    page,
    totalPages: Math.ceil(total / limit) || 1,
  };
}

// ─────────────────────────────────────────────────────────────
// 8. Portefeuille à risque (GET /risks)
// ─────────────────────────────────────────────────────────────

export interface RiskGuildItem {
  guildId: string;
  name: string;
  plan: string;
  mrrCents: number;
  reason: string;
  dueDateOrDetails?: string;
}

export interface RisksResult {
  summary: {
    totalAtRiskCount: number;
    totalAtRiskMrrCents: number;
    pastDueCount: number;
    cancelScheduledCount: number;
    trialExpiringCount: number;
    paidInactiveCount: number;
    inactivePayingCount?: number;
    decliningUsageCount?: number;
    expiringTrials48hCount?: number;
    atRiskMrrCents?: number;
  };
  pastDue: RiskGuildItem[];
  cancelScheduled: RiskGuildItem[];
  trialExpiringSoon: RiskGuildItem[];
  paidInactive: RiskGuildItem[];
}

export async function getRisksSummary(client: Client): Promise<RisksResult> {
  const now = new Date();
  const in48h = new Date(now.getTime() + 48 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const pastDueGuilds = await prisma.guild.findMany({
    where: {
      OR: [
        { stripeSubscriptionStatus: 'past_due' },
        { stripeSubscriptionStatus: 'unpaid' },
      ],
    },
    select: { id: true, plan: true },
  }).catch(() => []);

  const cancellingGuilds = await prisma.guild.findMany({
    where: {
      stripeCancelAtPeriodEnd: true,
      plan: { not: 'FREE' },
    },
    select: { id: true, plan: true, stripeCurrentPeriodEnd: true },
  }).catch(() => []);

  const expiringTrials = await prisma.guildLifecycle.findMany({
    where: {
      trialEndsAt: { gte: now, lte: in48h },
      trialConvertedAt: null,
      churnedAt: null,
    },
    select: { guildId: true, plan: true, trialEndsAt: true, mrrCents: true },
  }).catch(() => []);

  const payingLifecycles = await prisma.guildLifecycle.findMany({
    where: {
      plan: { not: 'FREE' },
      churnedAt: null,
    },
    select: { guildId: true, plan: true, mrrCents: true },
  }).catch(() => []);

  const payingIds = payingLifecycles.map((g) => g.guildId);
  const activeGuildUsage = await prisma.moduleActivationStat.findMany({
    where: {
      guildId: { in: payingIds },
      lastUsedAt: { gte: fourteenDaysAgo },
    },
    select: { guildId: true },
  }).catch(() => []);
  const activeSet = new Set(activeGuildUsage.map((u) => u.guildId));
  const inactivePaying = payingLifecycles.filter((g) => !activeSet.has(g.guildId));

  const lifecycleMap = new Map(
    (await prisma.guildLifecycle.findMany({
      where: { guildId: { in: [...pastDueGuilds, ...cancellingGuilds].map((g) => g.id) } },
      select: { guildId: true, mrrCents: true },
    }).catch(() => [])).map((g) => [g.guildId, g.mrrCents])
  );

  const pastDue: RiskGuildItem[] = pastDueGuilds.map((g) => ({
    guildId: g.id,
    name: resolveGuildDisplayName(client, g.id),
    plan: g.plan,
    mrrCents: lifecycleMap.get(g.id) || 0,
    reason: 'Défaut de paiement Stripe',
  }));

  const cancelScheduled: RiskGuildItem[] = cancellingGuilds.map((g) => ({
    guildId: g.id,
    name: resolveGuildDisplayName(client, g.id),
    plan: g.plan,
    mrrCents: lifecycleMap.get(g.id) || 0,
    reason: 'Résiliation programmée au terme',
    dueDateOrDetails: g.stripeCurrentPeriodEnd?.toISOString(),
  }));

  const trialExpiringSoon: RiskGuildItem[] = expiringTrials.map((g) => ({
    guildId: g.guildId,
    name: resolveGuildDisplayName(client, g.guildId),
    plan: g.plan,
    mrrCents: g.mrrCents,
    reason: 'Essai gratuit arrivant à échéance sous 48h',
    dueDateOrDetails: g.trialEndsAt?.toISOString(),
  }));

  const paidInactive: RiskGuildItem[] = inactivePaying.map((g) => ({
    guildId: g.guildId,
    name: resolveGuildDisplayName(client, g.guildId),
    plan: g.plan,
    mrrCents: g.mrrCents,
    reason: 'Aucune commande ni usage depuis 14 jours',
  }));

  const allRiskGuildIds = new Set([
    ...pastDue.map((g) => g.guildId),
    ...cancelScheduled.map((g) => g.guildId),
    ...trialExpiringSoon.map((g) => g.guildId),
    ...paidInactive.map((g) => g.guildId),
  ]);

  const totalAtRiskMrrCents =
    pastDue.reduce((sum, g) => sum + g.mrrCents, 0) +
    cancelScheduled.reduce((sum, g) => sum + g.mrrCents, 0) +
    paidInactive.reduce((sum, g) => sum + g.mrrCents, 0);

  return {
    summary: {
      totalAtRiskCount: allRiskGuildIds.size,
      totalAtRiskMrrCents,
      pastDueCount: pastDue.length,
      cancelScheduledCount: cancelScheduled.length,
      trialExpiringCount: trialExpiringSoon.length,
      paidInactiveCount: paidInactive.length,
      inactivePayingCount: paidInactive.length,
      decliningUsageCount: 0,
      expiringTrials48hCount: trialExpiringSoon.length,
      atRiskMrrCents: totalAtRiskMrrCents,
    },
    pastDue,
    cancelScheduled,
    trialExpiringSoon,
    paidInactive,
  };
}

// ─────────────────────────────────────────────────────────────
// 9. Seuils d'alerte (GET & POST /alerts)
// ─────────────────────────────────────────────────────────────

export interface AlertThresholds {
  monthlyChurnRatePct: number;
  largeServerChurnMembers: number;
  arrivalsDropPct: number;
  trialExpiringHours: number;
  churnRateWeeklyPercent?: number;
  trialConversionDropPercent?: number;
  onboardingCompletionMinPercent?: number;
  outOfTierMaxCount?: number;
}

const DEFAULT_THRESHOLDS: AlertThresholds = {
  monthlyChurnRatePct: 5.0,
  largeServerChurnMembers: 1000,
  arrivalsDropPct: 40.0,
  trialExpiringHours: 48,
  churnRateWeeklyPercent: 5.0,
  trialConversionDropPercent: 20.0,
  onboardingCompletionMinPercent: 40.0,
  outOfTierMaxCount: 10,
};

export async function getAlertThresholds(): Promise<{
  thresholds: AlertThresholds;
  recentAlerts: Array<{ key: string; lastFiredAt: Date; lastValue: number | null }>;
}> {
  const alertStates = await prisma.acquisitionAlertState.findMany().catch(() => []);

  const thresholds: AlertThresholds = { ...DEFAULT_THRESHOLDS };
  const recentAlerts: Array<{ key: string; lastFiredAt: Date; lastValue: number | null }> = [];

  for (const s of alertStates) {
    if (s.key === 'threshold:monthly_churn_rate' && s.lastValue !== null) {
      thresholds.monthlyChurnRatePct = s.lastValue;
    } else if (s.key === 'threshold:large_server_members' && s.lastValue !== null) {
      thresholds.largeServerChurnMembers = Math.round(s.lastValue);
    } else if (s.key === 'threshold:arrivals_drop_pct' && s.lastValue !== null) {
      thresholds.arrivalsDropPct = s.lastValue;
    } else if (s.key === 'threshold:trial_expiring_hours' && s.lastValue !== null) {
      thresholds.trialExpiringHours = Math.round(s.lastValue);
    } else if (s.key === 'threshold:churn_rate_weekly_percent' && s.lastValue !== null) {
      thresholds.churnRateWeeklyPercent = s.lastValue;
    } else if (s.key === 'threshold:trial_conversion_drop_percent' && s.lastValue !== null) {
      thresholds.trialConversionDropPercent = s.lastValue;
    } else if (s.key === 'threshold:onboarding_completion_min_percent' && s.lastValue !== null) {
      thresholds.onboardingCompletionMinPercent = s.lastValue;
    } else if (s.key === 'threshold:out_of_tier_max_count' && s.lastValue !== null) {
      thresholds.outOfTierMaxCount = Math.round(s.lastValue);
    } else {
      recentAlerts.push({ key: s.key, lastFiredAt: s.lastFiredAt, lastValue: s.lastValue });
    }
  }

  thresholds.churnRateWeeklyPercent = thresholds.churnRateWeeklyPercent ?? thresholds.monthlyChurnRatePct;
  thresholds.trialConversionDropPercent = thresholds.trialConversionDropPercent ?? 20.0;
  thresholds.onboardingCompletionMinPercent = thresholds.onboardingCompletionMinPercent ?? 40.0;
  thresholds.outOfTierMaxCount = thresholds.outOfTierMaxCount ?? 10;

  return { thresholds, recentAlerts };
}

export async function saveAlertThresholds(updates: Partial<AlertThresholds>): Promise<AlertThresholds> {
  const now = new Date();

  try {
    if (updates.monthlyChurnRatePct !== undefined) {
      await prisma.acquisitionAlertState.upsert({
        where: { key: 'threshold:monthly_churn_rate' },
        update: { lastFiredAt: now, lastValue: updates.monthlyChurnRatePct },
        create: { key: 'threshold:monthly_churn_rate', lastFiredAt: now, lastValue: updates.monthlyChurnRatePct },
      });
    }

    if (updates.largeServerChurnMembers !== undefined) {
      await prisma.acquisitionAlertState.upsert({
        where: { key: 'threshold:large_server_members' },
        update: { lastFiredAt: now, lastValue: updates.largeServerChurnMembers },
        create: { key: 'threshold:large_server_members', lastFiredAt: now, lastValue: updates.largeServerChurnMembers },
      });
    }

    if (updates.arrivalsDropPct !== undefined) {
      await prisma.acquisitionAlertState.upsert({
        where: { key: 'threshold:arrivals_drop_pct' },
        update: { lastFiredAt: now, lastValue: updates.arrivalsDropPct },
        create: { key: 'threshold:arrivals_drop_pct', lastFiredAt: now, lastValue: updates.arrivalsDropPct },
      });
    }

    if (updates.trialExpiringHours !== undefined) {
      await prisma.acquisitionAlertState.upsert({
        where: { key: 'threshold:trial_expiring_hours' },
        update: { lastFiredAt: now, lastValue: updates.trialExpiringHours },
        create: { key: 'threshold:trial_expiring_hours', lastFiredAt: now, lastValue: updates.trialExpiringHours },
      });
    }

    if (updates.churnRateWeeklyPercent !== undefined) {
      await prisma.acquisitionAlertState.upsert({
        where: { key: 'threshold:churn_rate_weekly_percent' },
        update: { lastFiredAt: now, lastValue: updates.churnRateWeeklyPercent },
        create: { key: 'threshold:churn_rate_weekly_percent', lastFiredAt: now, lastValue: updates.churnRateWeeklyPercent },
      });
    }

    if (updates.trialConversionDropPercent !== undefined) {
      await prisma.acquisitionAlertState.upsert({
        where: { key: 'threshold:trial_conversion_drop_percent' },
        update: { lastFiredAt: now, lastValue: updates.trialConversionDropPercent },
        create: { key: 'threshold:trial_conversion_drop_percent', lastFiredAt: now, lastValue: updates.trialConversionDropPercent },
      });
    }

    if (updates.onboardingCompletionMinPercent !== undefined) {
      await prisma.acquisitionAlertState.upsert({
        where: { key: 'threshold:onboarding_completion_min_percent' },
        update: { lastFiredAt: now, lastValue: updates.onboardingCompletionMinPercent },
        create: { key: 'threshold:onboarding_completion_min_percent', lastFiredAt: now, lastValue: updates.onboardingCompletionMinPercent },
      });
    }

    if (updates.outOfTierMaxCount !== undefined) {
      await prisma.acquisitionAlertState.upsert({
        where: { key: 'threshold:out_of_tier_max_count' },
        update: { lastFiredAt: now, lastValue: updates.outOfTierMaxCount },
        create: { key: 'threshold:out_of_tier_max_count', lastFiredAt: now, lastValue: updates.outOfTierMaxCount },
      });
    }
  } catch (error) {
    logger.warn('AdminAnalytics', 'saveAlertThresholds fallback:', error);
  }

  const { thresholds } = await getAlertThresholds();
  return thresholds;
}

// ─────────────────────────────────────────────────────────────
// 10. Export CSV (GET /export.csv)
// ─────────────────────────────────────────────────────────────

function escapeCsvCell(val: unknown): string {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes('"') || s.includes(',') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function formatCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const headerLine = headers.map(escapeCsvCell).join(',');
  const rowLines = rows.map((row) => row.map(escapeCsvCell).join(','));
  return `\uFEFF${headerLine}\r\n${rowLines.join('\r\n')}\r\n`;
}

export async function exportAnalyticsCsv(
  client: Client,
  view: string,
  options: {
    from?: string | null;
    to?: string | null;
    dimension?: AnalyticsDimension | null;
    filter?: string | null;
  }
): Promise<{ filename: string; content: string }> {
  const today = dateKeyFor(new Date());

  if (view === 'funnel') {
    const stats = await getFunnelStats(options);
    const headers = ['Étape', 'Libellé', 'Nombre', 'Conversion étape précédente (%)', 'Conversion sommet (%)', 'Délai médian (s)'];
    const rows = stats.steps.map((s) => [s.step, s.label, s.count, s.conversionPrevious, s.conversionTop, s.medianDurationSeconds]);
    return { filename: `kotbo-funnel-${today}.csv`, content: formatCsv(headers, rows) };
  }

  if (view === 'onboarding') {
    const stats = await getOnboardingFunnelStats(options);
    const headers = ['Étape', 'Éligibles', 'Atteints', 'Abandons', "Taux d'abandon (%)", 'Retours arrière', 'Délai médian (s)'];
    const rows = stats.steps.map((s) => [s.step, s.eligible, s.reached, s.dropOffCount, s.dropOffRate, s.backtracks, s.medianDurationSeconds]);
    return { filename: `kotbo-onboarding-funnel-${today}.csv`, content: formatCsv(headers, rows) };
  }

  if (view === 'revenue') {
    const stats = await getRevenueStats(options);
    const headers = ['Date', 'MRR (€)', 'Encaissé (€)', 'Serveurs payants'];
    const rows = stats.series.map((s) => [
      s.dateKey,
      (s.mrrCents / 100).toFixed(2),
      (s.collectedCents / 100).toFixed(2),
      s.payingCount,
    ]);
    return { filename: `kotbo-revenue-${today}.csv`, content: formatCsv(headers, rows) };
  }

  if (view === 'cohorts') {
    const { cohorts } = await getRetentionCohorts();
    const headers = ['Cohorte', 'Serveurs initiaux', 'MRR initial (€)', ...Array.from({ length: 13 }, (_, i) => `M${i} (%)`)];
    const rows = cohorts.map((c) => [
      c.cohortMonth,
      c.initialGuilds,
      (c.initialMrrCents / 100).toFixed(2),
      ...c.periods.map((p) => (p.retainedPct !== null ? p.retainedPct : '')),
    ]);
    return { filename: `kotbo-cohorts-${today}.csv`, content: formatCsv(headers, rows) };
  }

  if (view === 'segments') {
    const stats = await getSegmentsStats(options);
    const headers = ['Segment', 'Serveurs', 'Payants', 'Conversion (%)', 'MRR (€)', 'ARPA (€)', 'Churnés', 'Taux de churn (%)'];
    const rows = stats.segments.map((s) => [
      s.bucket,
      s.guilds,
      s.paying,
      s.conversionRate,
      (s.mrrCents / 100).toFixed(2),
      (s.arpaCents / 100).toFixed(2),
      s.churned,
      s.churnRate,
    ]);
    return { filename: `kotbo-segments-${today}.csv`, content: formatCsv(headers, rows) };
  }

  if (view === 'modules') {
    const { modules } = await getModuleCorrelations();
    const headers = [
      'Module',
      'Activé sur (serveurs)',
      "Taux d'activation (%)",
      'Utilisé (30j)',
      'Conversion avec module (%)',
      'Conversion sans module (%)',
      'Échantillon avec',
      'Échantillon sans',
      'Échantillon faible',
    ];
    const rows = modules.map((m) => [
      m.module,
      m.enabledGuilds,
      m.activationRate,
      m.usedLast30Days,
      m.conversionWithModule,
      m.conversionWithoutModule,
      m.sampleCountWith,
      m.sampleCountWithout,
      m.sampleTooLow ? 'OUI' : 'NON',
    ]);
    return { filename: `kotbo-modules-${today}.csv`, content: formatCsv(headers, rows) };
  }

  if (view === 'guilds') {
    const { guilds } = await getGuildsExplorer(client, {
      filter: options.filter as never,
      limit: 1000,
    });
    const headers = ['Identifiant', 'Nom', 'Offre', 'Période', 'MRR (€)', 'Membres', 'Provenance', 'Statut', 'Hors palier', 'Arrivée'];
    const rows = guilds.map((g) => [
      g.guildId,
      g.name,
      g.plan,
      g.interval ?? '',
      (g.mrrCents / 100).toFixed(2),
      g.memberCount ?? 0,
      g.source ?? '',
      g.status,
      g.isOutOfTier ? 'OUI' : 'NON',
      g.invitedAt ? g.invitedAt.toISOString() : '',
    ]);
    return { filename: `kotbo-guilds-${today}.csv`, content: formatCsv(headers, rows) };
  }

  if (view === 'risks') {
    const risks = await getRisksSummary(client);
    const headers = ['Catégorie', 'Identifiant', 'Nom', 'Offre', 'MRR à risque (€)', 'Motif', 'Échéance / Détails'];
    const allRows: (string | number | null | undefined)[][] = [];

    for (const g of risks.pastDue) {
      allRows.push(['Impayé', g.guildId, g.name, g.plan, (g.mrrCents / 100).toFixed(2), g.reason, g.dueDateOrDetails ?? '']);
    }
    for (const g of risks.cancelScheduled) {
      allRows.push(['Résiliation programmée', g.guildId, g.name, g.plan, (g.mrrCents / 100).toFixed(2), g.reason, g.dueDateOrDetails ?? '']);
    }
    for (const g of risks.trialExpiringSoon) {
      allRows.push(['Essai expirant', g.guildId, g.name, g.plan, (g.mrrCents / 100).toFixed(2), g.reason, g.dueDateOrDetails ?? '']);
    }
    for (const g of risks.paidInactive) {
      allRows.push(['Payé inactif', g.guildId, g.name, g.plan, (g.mrrCents / 100).toFixed(2), g.reason, g.dueDateOrDetails ?? '']);
    }

    return { filename: `kotbo-risks-${today}.csv`, content: formatCsv(headers, allRows) };
  }

  return {
    filename: `kotbo-export-${today}.csv`,
    content: formatCsv(['Information'], [['Vue non reconnue']]),
  };
}
