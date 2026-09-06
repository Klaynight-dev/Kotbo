/**
 * adminAnalytics.ts
 *
 * Client HTTP pour les statistiques commerciales et le tunnel d'acquisition
 * de la console d'administration (`/api/admin/analytics/*`).
 */

import { API_BASE_URL, authorizedFetch, JSON_HEADERS } from './client';
import type { AnalyticsDimension } from '@kotbo/contracts';

export interface FunnelStepData {
  step: string;
  name: string;
  label?: string;
  count: number;
  conversionFromPrev: number;
  conversionPrevious?: number;
  conversionFromFirst: number;
  conversionTop?: number;
  medianDurationSeconds: number | null;
}

export interface FunnelStatsResult {
  range: { from: string; to: string; isRealtime: boolean };
  previousRange?: { from: string; to: string };
  steps: FunnelStepData[];
  previousSteps?: FunnelStepData[];
  sources: Record<string, { visits: number; joins: number; paid: number }>;
  campaigns: Record<string, { clicks: number; joins: number; paid: number }>;
  contents: Record<string, { clicks: number; joins: number; paid: number }>;
}

export interface OnboardingFunnelResult {
  totalStarted: number;
  totalCompleted: number;
  completionRate: number;
  medianDurationSeconds: number | null;
  stepDropOffs: Array<{ step: string; count: number; dropOffRate: number }>;
  byServerKind: Record<string, { started: number; completed: number; rate: number }>;
  byTrack: Record<string, { count: number }>;
}

export interface RevenueStatsResult {
  mrrCents: number;
  arrCents: number;
  arpaCents: number;
  payingGuilds: number;
  collectedCents: number;
  byInterval: {
    month: { count: number; mrrCents: number };
    year: { count: number; mrrCents: number };
  };
  byPlan: Record<string, { count: number; mrrCents: number }>;
  waterfall: {
    mrrStartCents: number;
    newCents: number;
    expansionCents: number;
    contractionCents: number;
    churnCents: number;
    mrrEndCents: number;
  };
  series: Array<{
    dateKey: string;
    mrrCents: number;
    collectedCents: number;
    payingCount: number;
  }>;
  recentInvoices: Array<{
    id: string;
    guildId: string | null;
    plan: string;
    interval: string | null;
    amountPaidCents: number;
    status: string;
    paidAt: string | null;
  }>;
}

export interface CohortPeriod {
  periodIndex?: number;
  monthKey?: string;
  activeGuilds?: number | null;
  retentionRate?: number;
  retainedPct?: number | null;
  mrrCents?: number | null;
  nrrRate?: number;
}

export interface CohortRow {
  cohortMonth: string;
  initialGuilds: number;
  initialMrrCents: number;
  periods: CohortPeriod[];
}

export interface SegmentsStatsResult {
  dimension: AnalyticsDimension;
  distribution: Array<{
    bucket: string;
    totalGuilds: number;
    payingGuilds: number;
    trialGuilds: number;
    conversionRate: number;
    mrrCents: number;
    avgLtvCents: number;
  }>;
  outOfTierMatrix: Array<{
    guildId: string;
    guildName: string;
    memberCount: number;
    currentPlan: string;
    recommendedPlan: string;
    mrrCents: number;
  }>;
}

export interface ModuleCorrelationsResult {
  moduleAdoption: Array<{
    module: string;
    freeAdoptionRate: number;
    paidAdoptionRate: number;
    totalActive: number;
  }>;
  churnDropOffModules: Array<{
    module: string;
    dropOffCount: number;
  }>;
}

export interface GuildExplorerItem {
  guildId: string;
  name: string;
  icon: string | null;
  plan: string;
  interval: string | null;
  memberCount: number;
  mrrCents: number;
  lifetimeCents: number;
  source: string | null;
  serverKind: string | null;
  invitedAt: string | null;
  onboardingCompletedAt: string | null;
  firstPaidAt: string | null;
  churnedAt: string | null;
  riskReasons: string[];
}

export interface GuildsExplorerResult {
  guilds: GuildExplorerItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface RisksSummaryResult {
  summary: {
    inactivePayingCount: number;
    decliningUsageCount: number;
    expiringTrials48hCount: number;
    expiringCards30dCount: number;
    atRiskMrrCents: number;
  };
  risksList: Array<{
    guildId: string;
    name: string;
    plan: string;
    mrrCents: number;
    riskReason: string;
  }>;
}

export interface AlertThresholds {
  churnRateWeeklyPercent: number;
  trialConversionDropPercent: number;
  onboardingCompletionMinPercent: number;
  outOfTierMaxCount: number;
}

// ── Appels d'API ─────────────────────────────────────────────────────────────

export async function fetchAdminFunnelStats(options?: {
  from?: string;
  to?: string;
  compare?: boolean;
}): Promise<FunnelStatsResult> {
  const params = new URLSearchParams();
  if (options?.from) params.set('from', options.from);
  if (options?.to) params.set('to', options.to);
  if (options?.compare) params.set('compare', 'previous');

  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/analytics/funnel?${params.toString()}`);
  if (!res.ok) throw new Error('Erreur lors du chargement des statistiques du tunnel');
  return res.json();
}

export async function fetchAdminOnboardingFunnel(options?: {
  from?: string;
  to?: string;
  serverKind?: string;
  track?: string;
}): Promise<OnboardingFunnelResult> {
  const params = new URLSearchParams();
  if (options?.from) params.set('from', options.from);
  if (options?.to) params.set('to', options.to);
  if (options?.serverKind) params.set('serverKind', options.serverKind);
  if (options?.track) params.set('track', options.track);

  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/analytics/funnel/onboarding?${params.toString()}`);
  if (!res.ok) throw new Error("Erreur lors du chargement du parcours d'onboarding");
  return res.json();
}

export async function fetchAdminRevenueStats(options?: {
  from?: string;
  to?: string;
  compare?: boolean;
}): Promise<RevenueStatsResult> {
  const params = new URLSearchParams();
  if (options?.from) params.set('from', options.from);
  if (options?.to) params.set('to', options.to);
  if (options?.compare) params.set('compare', 'previous');

  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/analytics/revenue?${params.toString()}`);
  if (!res.ok) throw new Error('Erreur lors du chargement des statistiques de revenus');
  return res.json();
}

export async function fetchAdminRetentionCohorts(): Promise<{ cohorts: CohortRow[] }> {
  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/analytics/revenue/cohorts`);
  if (!res.ok) throw new Error('Erreur lors du chargement des cohortes');
  return res.json();
}

export async function fetchAdminSegmentsStats(options?: {
  dimension?: AnalyticsDimension;
  from?: string;
  to?: string;
}): Promise<SegmentsStatsResult> {
  const params = new URLSearchParams();
  if (options?.dimension) params.set('dimension', options.dimension);
  if (options?.from) params.set('from', options.from);
  if (options?.to) params.set('to', options.to);

  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/analytics/segments?${params.toString()}`);
  if (!res.ok) throw new Error('Erreur lors du chargement des segments');
  return res.json();
}

export async function fetchAdminModuleCorrelations(): Promise<ModuleCorrelationsResult> {
  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/analytics/modules`);
  if (!res.ok) throw new Error('Erreur lors du chargement des modules');
  return res.json();
}

export async function fetchAdminAnalyticsGuilds(options: {
  page?: number;
  limit?: number;
  filter?: string;
  search?: string;
  dimension?: AnalyticsDimension;
  bucket?: string;
}): Promise<GuildsExplorerResult> {
  const params = new URLSearchParams();
  if (options.page) params.set('page', String(options.page));
  if (options.limit) params.set('limit', String(options.limit));
  if (options.filter) params.set('filter', options.filter);
  if (options.search) params.set('search', options.search);
  if (options.dimension) params.set('dimension', options.dimension);
  if (options.bucket) params.set('bucket', options.bucket);

  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/analytics/guilds?${params.toString()}`);
  if (!res.ok) throw new Error('Erreur lors du chargement des serveurs');
  return res.json();
}

export async function fetchAdminRisksSummary(): Promise<RisksSummaryResult> {
  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/analytics/risks`);
  if (!res.ok) throw new Error('Erreur lors du chargement des risques');
  return res.json();
}

export async function fetchAdminAlertThresholds(): Promise<{
  thresholds: AlertThresholds;
  recentAlerts: Array<{ key: string; lastFiredAt: string; lastValue: number | null }>;
}> {
  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/analytics/alerts`);
  if (!res.ok) throw new Error('Erreur lors du chargement des seuils');
  return res.json();
}

export async function saveAdminAlertThresholds(thresholds: Partial<AlertThresholds>): Promise<void> {
  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/analytics/alerts`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(thresholds),
  });
  if (!res.ok) throw new Error('Erreur lors de la sauvegarde des seuils');
}

export async function downloadAdminAnalyticsCsv(view: string, options?: {
  from?: string;
  to?: string;
  dimension?: string;
  filter?: string;
}): Promise<void> {
  const params = new URLSearchParams();
  params.set('view', view);
  if (options?.from) params.set('from', options.from);
  if (options?.to) params.set('to', options.to);
  if (options?.dimension) params.set('dimension', options.dimension);
  if (options?.filter) params.set('filter', options.filter);

  const res = await authorizedFetch(`${API_BASE_URL}/api/admin/analytics/export.csv?${params.toString()}`);
  if (!res.ok) throw new Error("Erreur lors de l'export CSV");
  const blob = await res.blob();
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `analytics-${view}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
}
