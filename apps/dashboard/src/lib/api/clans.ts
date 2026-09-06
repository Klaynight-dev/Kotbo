/** Clans. */
import { authStore } from '../stores/auth.svelte';
import type { BetStakeMode } from '@kotbo/shared';
import { API_BASE_URL, dashboardMutation, dashboardRequest } from './client';

// ─────────────────────────────────────────────────────────────
// Clans
// ─────────────────────────────────────────────────────────────

export interface ClanEntry {
  id: string;
  name: string;
  description: string | null;
  roleId: string;
  generalChannelId: string | null;
  leaderRoleId: string | null;
  memberCount: number;
  totalXp: number;
}

export interface ClansDataResult {
  clansEnabled: boolean;
  clanAutoAssignOnJoin: boolean;
  clanWeeklyDigest: boolean;
  currentClanSeason: number;
  clanXpFromLevelUp: boolean;
  clanXpPerLevelUp: number;
  clanXpLevelUpProportional: boolean;
  clanXpReferenceLevel: number;
  clanXpFromBoost: boolean;
  clanXpPerBoost: number;
  clanAnnouncementChannelId: string | null;
  clanRewardGiveaway: boolean;
  clanRewardXpBoost: boolean;
  clanRewardXpBoostRate: number;
  clanRewardLeaderRole: boolean;
  lastWinningClanId: string | null;
  clanSeasonStartsAt: string | null;
  clanSeasonEndsAt: string | null;
  betsEnabled: boolean;
  betChannelId: string | null;
  betAnnouncementChannelId: string | null;
  betMinStake: number;
  betMaxStake: number;
  betMaxOpenPerMember: number;
  betAcceptWindowHours: number;
  betAllowDebt: boolean;
  betMaxDebt: number;
  betDebtResetOnSeason: boolean;
  betResolverRoleIds: string[];
  betAllowPool: boolean;
  betAllowTeams: boolean;
  betAllowOpen: boolean;
  betStakeMode: BetStakeMode;
  betMaxParticipants: number;
  betMaxSides: number;
  betSeasonRewardEnabled: boolean;
  betSeasonRewardRoleId: string | null;
  betRewardTop1: number;
  betRewardTop2: number;
  betRewardTop3: number;
  clans: ClanEntry[];
  taskInProgress: { type: 'distribute' | 'clear' | 'dedupe'; processed: number; total: number } | null;
}

export async function fetchClansData(guildId = authStore.selectedGuildId): Promise<ClansDataResult | null> {
  return dashboardRequest('/clans', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Clans):',
    silent: true,
  });
}

export async function updateClanSettings(
  payload: {
    clansEnabled?: boolean;
    clanAutoAssignOnJoin?: boolean;
    clanWeeklyDigest?: boolean;
    clanXpFromLevelUp?: boolean;
    clanXpPerLevelUp?: number;
    clanXpLevelUpProportional?: boolean;
    clanXpReferenceLevel?: number;
    clanXpFromBoost?: boolean;
    clanXpPerBoost?: number;
    clanAnnouncementChannelId?: string | null;
    clanRewardGiveaway?: boolean;
    clanRewardLeaderRole?: boolean;
    clanRewardXpBoost?: boolean;
    clanRewardXpBoostRate?: number;
    clanSeasonStartsAt?: string | null;
    clanSeasonEndsAt?: string | null;
    betsEnabled?: boolean;
    betChannelId?: string | null;
    betAnnouncementChannelId?: string | null;
    betMinStake?: number;
    betMaxStake?: number;
    betMaxOpenPerMember?: number;
    betAcceptWindowHours?: number;
    betAllowDebt?: boolean;
    betMaxDebt?: number;
    betDebtResetOnSeason?: boolean;
    betResolverRoleIds?: string[];
    betAllowPool?: boolean;
    betAllowTeams?: boolean;
    betAllowOpen?: boolean;
    betStakeMode?: BetStakeMode;
    betMaxParticipants?: number;
    betMaxSides?: number;
    betSeasonRewardEnabled?: boolean;
    betSeasonRewardRoleId?: string | null;
    betRewardTop1?: number;
    betRewardTop2?: number;
    betRewardTop3?: number;
  },
  guildId = authStore.selectedGuildId,
): Promise<{
  clansEnabled: boolean;
  clanAutoAssignOnJoin: boolean;
  clanWeeklyDigest: boolean;
  clanXpFromLevelUp: boolean;
  clanXpPerLevelUp: number;
  clanXpLevelUpProportional: boolean;
  clanXpReferenceLevel: number;
  clanXpFromBoost: boolean;
  clanXpPerBoost: number;
  clanAnnouncementChannelId: string | null;
  clanRewardGiveaway: boolean;
  clanRewardLeaderRole: boolean;
  clanRewardXpBoost: boolean;
  clanRewardXpBoostRate: number;
  clanSeasonStartsAt: string | null;
  clanSeasonEndsAt: string | null;
  betsEnabled: boolean;
  betChannelId: string | null;
  betAnnouncementChannelId: string | null;
  betMinStake: number;
  betMaxStake: number;
  betMaxOpenPerMember: number;
  betAcceptWindowHours: number;
  betAllowDebt: boolean;
  betMaxDebt: number;
  betDebtResetOnSeason: boolean;
  betResolverRoleIds: string[];
  betAllowPool: boolean;
  betAllowTeams: boolean;
  betAllowOpen: boolean;
  betStakeMode: BetStakeMode;
  betMaxParticipants: number;
  betMaxSides: number;
  betSeasonRewardEnabled: boolean;
  betSeasonRewardRoleId: string | null;
  betRewardTop1: number;
  betRewardTop2: number;
  betRewardTop3: number;
} | null> {
  return dashboardRequest('/clans', {
    method: 'PATCH',
    payload,
    guildId,
    errorContext: 'API Error (Update Clans Settings):',
  });
}

export async function createClan(
  payload: {
    name: string;
    description?: string;
    roleId: string;
    generalChannelId?: string | null;
    leaderRoleId?: string | null;
  },
  guildId = authStore.selectedGuildId,
): Promise<{ clan: ClanEntry } | null> {
  return dashboardRequest('/clans', {
    method: 'POST',
    payload,
    guildId,
    errorContext: 'API Error (Create Clan):',
  });
}

export async function updateClan(
  id: string,
  payload: {
    name: string;
    description?: string;
    roleId: string;
    generalChannelId?: string | null;
    leaderRoleId?: string | null;
  },
  guildId = authStore.selectedGuildId,
): Promise<{ clan: ClanEntry } | null> {
  return dashboardRequest(`/clans/${id}`, {
    method: 'PUT',
    payload,
    guildId,
    errorContext: 'API Error (Update Clan):',
  });
}

export async function deleteClan(id: string, guildId = authStore.selectedGuildId): Promise<boolean> {
  return dashboardMutation(`/clans/${id}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Delete Clan):',
  });
}

export async function distributeClans(guildId = authStore.selectedGuildId): Promise<{ message: string } | null> {
  return dashboardRequest('/clans/distribute', {
    method: 'POST',
    guildId,
    errorContext: 'API Error (Distribute Clans):',
  });
}

export async function clearClans(guildId = authStore.selectedGuildId): Promise<{ message: string } | null> {
  return dashboardRequest('/clans/clear', {
    method: 'POST',
    guildId,
    errorContext: 'API Error (Clear Clans):',
  });
}

export async function dedupeClans(guildId = authStore.selectedGuildId): Promise<{ message: string } | null> {
  return dashboardRequest('/clans/dedupe', {
    method: 'POST',
    guildId,
    errorContext: 'API Error (Dedupe Clans):',
  });
}

export async function resetClanSeason(guildId = authStore.selectedGuildId): Promise<{ currentClanSeason: number } | null> {
  return dashboardRequest('/clans/reset-season', {
    method: 'POST',
    guildId,
    errorContext: 'API Error (Reset Clan Season):',
  });
}

export async function resetAllClans(guildId = authStore.selectedGuildId): Promise<{ success: boolean } | null> {
  return dashboardRequest('/clans/reset-all', {
    method: 'POST',
    guildId,
    errorContext: 'API Error (Reset All Clans):',
  });
}

export async function rollbackClanSeason(guildId = authStore.selectedGuildId): Promise<{ currentClanSeason: number } | null> {
  return dashboardRequest('/clans/rollback-season', {
    method: 'POST',
    guildId,
    errorContext: 'API Error (Rollback Clan Season):',
  });
}

/** `amount` positif pour un ajout, négatif pour un retrait. */
export async function adjustClanPoints(
  payload: { clanId?: string | null; userId?: string | null; amount: number },
  guildId = authStore.selectedGuildId
): Promise<{ success: boolean; granted?: number; debtRepaid?: number; contribution?: any } | null> {
  return dashboardRequest('/clans/points', {
    method: 'POST',
    guildId,
    payload,
    errorContext: 'API Error (Adjust Clan Points):',
  });
}

export interface ClanBetMember {
  userId: string;
  displayName: string | null;
  clanName: string | null;
  /** JOINED | INVITED */
  status: string;
  /** Points prélevés plus part à crédit. */
  engaged: number;
  debt: number;
  payout: number;
}

export interface ClanBetSideEntry {
  id: string;
  label: string;
  /** `null` pour un camp qui se remplit sans limite. */
  capacity: number | null;
  won: boolean;
  members: ClanBetMember[];
}

export interface ClanBetEntry {
  id: string;
  subject: string;
  stake: number;
  /** PER_MEMBER | PER_SIDE */
  stakeMode: string;
  /** DUEL | POOL | TEAMS */
  shape: string;
  /** TARGETED | OPEN */
  access: string;
  season: number;
  status: string;
  sides: ClanBetSideEntry[];
  pot: number;
  creditUsed: number;
  winningSideId: string | null;
  resolvedById: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface ClanPointDebtEntry {
  userId: string;
  displayName: string | null;
  amount: number;
  /** Part encore engagée dans des paris non tranchés, rendue si le pari tombe. */
  engaged: number;
  /** Ce qui reste dû quoi qu'il arrive : `amount` moins `engaged`. */
  firm: number;
  source: string;
  createdAt: string;
}

export async function fetchClanBets(
  guildId = authStore.selectedGuildId,
): Promise<{
  bets: ClanBetEntry[];
  debts: ClanPointDebtEntry[];
  /** Totaux en base : les listes ci-dessus s'arrêtent aux 50 premières lignes. */
  betCount: number;
  debtCount: number;
} | null> {
  return dashboardRequest('/clans/bets', {
    method: 'GET',
    guildId,
    errorContext: 'API Error (Fetch Clan Bets):',
    silent: true,
  });
}

/**
 * Efface la dette de points de clan d'un membre.
 *
 * Seule la part ferme part par défaut : le crédit engagé dans des paris en
 * cours a été misé en connaissance de cause, et l'effacer rendrait gratuits des
 * paris toujours en jeu.
 */
export async function clearClanPointDebt(
  userId: string,
  includeEngaged = false,
  guildId = authStore.selectedGuildId,
): Promise<boolean> {
  return dashboardMutation(`/clans/bets/debts/${userId}${includeEngaged ? '?engaged=1' : ''}`, {
    method: 'DELETE',
    guildId,
    errorContext: 'API Error (Clear Clan Debt):',
  });
}

export interface GuildMemberSearchResult {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isBot: boolean;
  isOnServer: boolean;
}

export async function searchGuildMembers(
  query: string,
  limit = 15,
  guildId = authStore.selectedGuildId
): Promise<GuildMemberSearchResult[]> {
  const params = new URLSearchParams();
  if (query) params.append('q', query);
  params.append('limit', String(limit));
  params.append('botFilter', 'human');
  const res = await dashboardRequest(`/members/search?${params.toString()}`, {
    method: 'GET',
    guildId,
    silent: true,
    errorContext: 'API Error (Search Guild Members):'
  });
  return (res?.members as GuildMemberSearchResult[]) ?? [];
}

export interface PublicDebtor {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  amount: number;
  /** Part encore engagée dans des paris non tranchés. */
  engaged: number;
  /** Ce qui reste dû quoi qu'il arrive. */
  firm: number;
  clanId: string | null;
  clanName: string | null;
  clanColor: string | null;
  since: string;
}

export interface PublicClanDebts {
  total: number;
  totalEngaged: number;
  debtorCount: number;
  unaffiliated: PublicDebtor[];
  top: PublicDebtor[];
  clans: Array<{
    id: string;
    name: string;
    roleColor: string | null;
    totalDebt: number;
    totalEngaged: number;
    debtorCount: number;
    debtors: PublicDebtor[];
  }>;
}

export interface PublicBetActor {
  displayName: string;
  avatarUrl: string | null;
}

/** Un parieur dans le récapitulatif public d'un pari tranché. */
export interface PublicBetParticipant extends PublicBetActor {
  userId: string;
  clanName: string | null;
  /**
   * Ce qu'il a gagné en plus de sa mise, ou perdu. Jamais le pot : le gagnant
   * n'a fait que récupérer sa propre mise en plus de celles qu'il a prises.
   */
  netGain: number;
}

export interface PublicBetHistoryEntry {
  id: string;
  subject: string;
  stake: number;
  /** DUEL | POOL | TEAMS */
  shape: string;
  /** TARGETED | OPEN */
  access: string;
  /** Enjeu total redistribué, crédit compris. */
  pot: number;
  creditUsed: number;
  winningSideLabel: string | null;
  winners: PublicBetParticipant[];
  losers: PublicBetParticipant[];
  resolvedAt: string;
}

export interface PublicBettorStanding extends PublicBetActor {
  userId: string;
  wins: number;
  losses: number;
  netGain: number;
  bestStreak: number;
  currentStreak: number;
  /** Marche du podium que la clôture lui donnerait en l'état, `null` sinon. */
  podiumRank: number | null;
  /** Prime que cette marche lui vaudrait, ex aequo partagés compris. */
  reward: number;
}

/**
 * Ce qui attend le podium à la clôture. `null` quand le serveur ne récompense
 * pas ses parieurs : le palmarès reste alors un classement, sans enjeu annoncé.
 */
export interface PublicBettorRewards {
  top1: number;
  top2: number;
  top3: number;
  roleName: string | null;
  roleColor: string | null;
}

export async function fetchPublicClans(guildId: string): Promise<any | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/public/guilds/${guildId}/clans`);
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    console.error('API Error (Fetch Public Clans):', err);
    return null;
  }
}

/** Vue publique du RPG de clan : avancement de chaque clan sur le raid et les quetes. */
export async function fetchPublicRpgClans(guildId: string): Promise<any | null> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/public/guilds/${guildId}/rpg`);
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    console.error('API Error (Fetch Public RPG Clans):', err);
    return null;
  }
}

export interface PublicClanSearchResult {
  bets: PublicBetHistoryEntry[];
  bettors: PublicBettorStanding[];
  debts: PublicDebtor[];
  participants: {
    userId: string;
    clanId: string;
    clanName: string | null;
    clanColor: string | null;
    rank: number | null;
    xp: number;
    displayName: string;
    avatarUrl: string | null;
  }[];
  scores: any[];
  matchCounts: Record<string, number>;
}

/**
 * Résultat vide de la recherche publique.
 *
 * Exporté pour que la page l'utilise à l'initialisation et à la remise à zéro :
 * réécrire l'objet à la main laissait les listes ajoutées ensuite à `undefined`,
 * et la page cassait sur la première lecture de leur `length`.
 */
export const EMPTY_CLAN_SEARCH: PublicClanSearchResult = {
  participants: [], scores: [], matchCounts: {}, bets: [], bettors: [], debts: [],
};

export async function searchPublicClans(guildId: string, query: string): Promise<PublicClanSearchResult> {
  try {
    const response = await fetch(`${API_BASE_URL}/api/public/guilds/${guildId}/clans/search?q=${encodeURIComponent(query)}`);
    if (!response.ok) return EMPTY_CLAN_SEARCH;
    const data = await response.json();
    return {
      participants: data?.participants ?? [],
      scores: data?.scores ?? [],
      matchCounts: data?.matchCounts ?? {},
      bets: data?.bets ?? [],
      bettors: data?.bettors ?? [],
      debts: data?.debts ?? [],
    };
  } catch (err) {
    console.error('API Error (Search Public Clans):', err);
    return EMPTY_CLAN_SEARCH;
  }
}
