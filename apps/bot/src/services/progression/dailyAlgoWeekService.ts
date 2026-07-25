/**
 * Semaine compétitive du Daily Algo.
 *
 * Une semaine ISO par serveur. À la clôture — le cron du lundi, ou le bouton
 * « Clôturer la semaine maintenant » de l'onglet Administration — le classement
 * est figé, les récompenses versées et une annonce publiée.
 *
 * **Ce module ne dépend pas des clans.** Le Daily Algo doit fonctionner seul sur un
 * serveur sans clans, et réciproquement. Le pont éventuel vers les points de clan
 * est branché en toute fin de clôture, derrière son propre interrupteur.
 */

import { EmbedBuilder, type Client, type Guild as DiscordGuild, type TextChannel } from 'discord.js';
import { Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { COLORS, truncate } from '../../utils/embeds.js';
import { addXp } from './levelingService.js';
import { getGuildDailyAlgoRanking } from './dailyAlgoService.js';
import { broadcastDashboardStateChange } from '../../api/shared.js';
import {
  convertToClanPoints,
  formatWeekRangeLabel,
  getPreviousWeekKey,
  getWeekBounds,
  getWeekDateKeys,
  getWeekKey,
  isValidWeekKey,
} from './dailyAlgoScoring.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export type DailyAlgoWeekRankingEntry = {
  rank: number;
  userId: string;
  userName: string;
  /** Points Daily Algo de la semaine, bonus manuels compris. Toujours entier. */
  points: number;
  /** Nombre de soumissions validées dans la semaine. */
  participations: number;
  /** Part des points venant de points bonus attribués à la main. */
  bonusPoints: number;
};

export type DailyAlgoWeekSummary = {
  weekKey: string;
  label: string;
  status: 'OPEN' | 'CLOSED';
  startsAt: Date;
  endsAt: Date;
  closedAt: Date | null;
  rewardsGrantedAt: Date | null;
  closedById: string | null;
  ranking: DailyAlgoWeekRankingEntry[];
};

export type DailyAlgoWeekCloseResult = {
  status: 'closed' | 'already-closed' | 'resumed' | 'disabled';
  weekKey: string;
  participants: number;
  podium: DailyAlgoWeekRankingEntry[];
  xpGranted: number;
  rolesAssigned: number;
  /** Points de clan versés. Toujours 0 si le pont vers les clans est inactif. */
  clanPointsGranted: number;
};

/** Rangs du podium, dans l'ordre. */
const PODIUM_RANKS = [1, 2, 3] as const;

// ── Résolution de la semaine ───────────────────────────────────────────────────

async function getGuildWeekSettings(guildId: string) {
  return prisma.guild.findUnique({
    where: { id: guildId },
    select: {
      id: true,
      dailyAlgoEnabled: true,
      dailyAlgoChannelId: true,
      dailyAlgoTimezone: true,
      // Pont vers les clans : trois interrupteurs indépendants doivent être
      // réunis pour qu'un seul point de clan soit versé.
      clansEnabled: true,
      clanPointsFromDailyAlgo: true,
      clanPointsFromDailyAlgoRate: true,
      clanPointsDailyAlgoTop1: true,
      clanPointsDailyAlgoTop2: true,
      clanPointsDailyAlgoTop3: true,
      dailyAlgoWeeklyRewardsEnabled: true,
      dailyAlgoWeekRole1Id: true,
      dailyAlgoWeekRole2Id: true,
      dailyAlgoWeekRole3Id: true,
      dailyAlgoWeekRoleRotate: true,
      dailyAlgoWeekXp1: true,
      dailyAlgoWeekXp2: true,
      dailyAlgoWeekXp3: true,
      dailyAlgoWeekParticipationXp: true,
      dailyAlgoWeekAnnouncementChannelId: true,
    },
  });
}

type GuildWeekSettings = NonNullable<Awaited<ReturnType<typeof getGuildWeekSettings>>>;

function resolvePodiumRoleId(settings: GuildWeekSettings, rank: number): string | null {
  if (rank === 1) return settings.dailyAlgoWeekRole1Id;
  if (rank === 2) return settings.dailyAlgoWeekRole2Id;
  if (rank === 3) return settings.dailyAlgoWeekRole3Id;
  return null;
}

/**
 * XP due à un membre pour son classement.
 *
 * Le podium reçoit son XP dédiée **à la place** de l'XP de participation, pas en
 * plus : elle est déjà bien supérieure, les cumuler donnerait des paliers illisibles.
 */
function resolveRankXp(settings: GuildWeekSettings, rank: number): number {
  if (rank === 1) return Math.max(0, settings.dailyAlgoWeekXp1);
  if (rank === 2) return Math.max(0, settings.dailyAlgoWeekXp2);
  if (rank === 3) return Math.max(0, settings.dailyAlgoWeekXp3);
  return Math.max(0, settings.dailyAlgoWeekParticipationXp);
}

/** Clé de la semaine en cours pour un serveur, dans son fuseau. */
export function getCurrentWeekKey(timeZone: string): string {
  return getWeekKey(new Date(), timeZone);
}

/**
 * Récupère la ligne de semaine, en la créant si besoin.
 * Les semaines sont créées à la demande : inutile d'en pré-générer.
 */
export async function ensureDailyAlgoWeek(guildId: string, weekKey: string, timeZone: string) {
  if (!isValidWeekKey(weekKey)) {
    throw new Error(`Clé de semaine invalide : « ${weekKey} ».`);
  }

  const existing = await prisma.dailyAlgoWeek.findUnique({
    where: { guildId_weekKey: { guildId, weekKey } },
  });

  if (existing) return existing;

  const { startsAt, endsAt } = getWeekBounds(weekKey, timeZone);

  // `create` en concurrence avec un autre worker : la contrainte d'unicité
  // tranche, on relit alors la ligne gagnante.
  try {
    return await prisma.dailyAlgoWeek.create({
      data: { guildId, weekKey, startsAt, endsAt },
    });
  } catch {
    const raced = await prisma.dailyAlgoWeek.findUnique({
      where: { guildId_weekKey: { guildId, weekKey } },
    });
    if (raced) return raced;
    throw new Error(`Impossible de créer la semaine ${weekKey}.`);
  }
}

// ── Classement hebdomadaire ────────────────────────────────────────────────────

/**
 * Classement d'une semaine : points des soumissions validées, plus les points
 * bonus attribués à la main sur cette même semaine.
 */
export async function getDailyAlgoWeekRanking(
  guildId: string,
  weekKey: string,
): Promise<DailyAlgoWeekRankingEntry[]> {
  const range = getWeekDateKeys(weekKey);

  const [submissionRanking, bonusRows] = await Promise.all([
    getGuildDailyAlgoRanking(guildId, range),
    prisma.dailyAlgoBonusPoint.groupBy({
      by: ['userId'],
      where: { guildId, weekKey },
      _sum: { amount: true },
    }),
  ]);

  const totals = new Map<string, DailyAlgoWeekRankingEntry>();

  for (const entry of submissionRanking) {
    totals.set(entry.authorId, {
      rank: 0,
      userId: entry.authorId,
      userName: entry.authorName,
      points: entry.totalPoints,
      participations: entry.approvedCount,
      bonusPoints: 0,
    });
  }

  for (const row of bonusRows) {
    const amount = row._sum.amount ?? 0;
    if (amount === 0) continue;

    const existing = totals.get(row.userId);
    if (existing) {
      existing.points += amount;
      existing.bonusPoints = amount;
      continue;
    }

    // Un membre peut n'avoir que des points bonus, sans soumission validée.
    totals.set(row.userId, {
      rank: 0,
      userId: row.userId,
      userName: row.userId,
      points: amount,
      participations: 0,
      bonusPoints: amount,
    });
  }

  const ranked = [...totals.values()]
    // Un retrait de points manuel peut faire passer un total sous zéro : on
    // n'affiche pas de score négatif au classement.
    .filter((entry) => entry.points > 0)
    .sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.participations !== a.participations) return b.participations - a.participations;
      return a.userName.localeCompare(b.userName);
    });

  return ranked.map((entry, index) => ({ ...entry, rank: index + 1 }));
}

/** Semaine en cours d'un serveur, avec son classement en direct. */
export async function getCurrentDailyAlgoWeek(guildId: string): Promise<DailyAlgoWeekSummary | null> {
  const settings = await getGuildWeekSettings(guildId);
  if (!settings) return null;

  const weekKey = getCurrentWeekKey(settings.dailyAlgoTimezone);
  const week = await ensureDailyAlgoWeek(guildId, weekKey, settings.dailyAlgoTimezone);
  const ranking = await getDailyAlgoWeekRanking(guildId, weekKey);

  return {
    weekKey,
    label: formatWeekRangeLabel(weekKey),
    status: week.status,
    startsAt: week.startsAt,
    endsAt: week.endsAt,
    closedAt: week.closedAt,
    rewardsGrantedAt: week.rewardsGrantedAt,
    closedById: week.closedById,
    ranking,
  };
}

/** Semaines déjà clôturées, de la plus récente à la plus ancienne. */
export async function getDailyAlgoWeekHistory(guildId: string, limit = 10) {
  const safeLimit = Math.max(1, Math.min(52, Math.trunc(limit)));

  const weeks = await prisma.dailyAlgoWeek.findMany({
    where: { guildId, status: 'CLOSED' },
    orderBy: { weekKey: 'desc' },
    take: safeLimit,
    include: {
      rewards: {
        orderBy: { rank: 'asc' },
      },
    },
  });

  return weeks.map((week) => ({
    weekKey: week.weekKey,
    label: formatWeekRangeLabel(week.weekKey),
    closedAt: week.closedAt,
    closedById: week.closedById,
    rewardsGrantedAt: week.rewardsGrantedAt,
    participants: week.rewards.length,
    podium: week.rewards
      .filter((reward) => reward.rank >= 1 && reward.rank <= 3)
      .map((reward) => ({
        rank: reward.rank,
        userId: reward.userId,
        points: reward.points,
        xpGranted: reward.xpGranted,
        clanPointsGranted: reward.clanPointsGranted,
        roleId: reward.roleId,
      })),
  }));
}

// ── Clôture ────────────────────────────────────────────────────────────────────

function formatMedal(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

/**
 * Retire un rôle de podium à tous ceux qui le portent encore.
 * Appelé avant l'attribution quand `dailyAlgoWeekRoleRotate` est actif : un rôle de
 * champion qui s'accumule d'une semaine sur l'autre ne veut plus rien dire.
 */
async function rotatePodiumRole(discordGuild: DiscordGuild, roleId: string): Promise<void> {
  const role = discordGuild.roles.cache.get(roleId)
    ?? await discordGuild.roles.fetch(roleId).catch(() => null);

  if (!role) return;

  for (const member of role.members.values()) {
    await member.roles.remove(roleId, 'Rotation du podium hebdomadaire Daily Algo').catch(() => null);
  }
}

/**
 * Clôture une semaine : fige le classement, verse les récompenses, annonce.
 *
 * **Une seule implémentation**, partagée par le cron du lundi et le bouton
 * d'administration — un second chemin finirait par diverger du premier.
 *
 * **Rejouable, et c'est nécessaire.** Une clôture manuelle en milieu de semaine
 * laisse derrière elle les jours restants : le cron du lundi doit pouvoir repasser
 * et rattraper les participations arrivées entre-temps, sinon leurs points sont
 * perdus en silence. Le classement est donc toujours recalculé.
 *
 * Ce qui empêche de verser deux fois n'est pas un verrou global mais l'état de
 * chaque ligne `DailyAlgoWeeklyReward` (unique par semaine et par membre) :
 * `xpGranted` marque l'XP déjà versée, `clanPointsGranted` cumule les points de
 * clan déjà attribués et seul le delta est complété. Une clôture interrompue en
 * cours de route se reprend par le même mécanisme.
 */
export async function closeDailyAlgoWeek(params: {
  client: Client;
  guildId: string;
  /** Semaine à clôturer. Par défaut, la semaine précédente (usage du cron). */
  weekKey?: string;
  /** Membre à l'origine d'une clôture manuelle ; absent pour le cron. */
  closedById?: string;
}): Promise<DailyAlgoWeekCloseResult> {
  const settings = await getGuildWeekSettings(params.guildId);

  if (!settings || !settings.dailyAlgoEnabled) {
    return emptyResult('disabled', params.weekKey ?? '');
  }

  const timeZone = settings.dailyAlgoTimezone;
  const weekKey = params.weekKey ?? getPreviousWeekKey(getCurrentWeekKey(timeZone));

  if (!isValidWeekKey(weekKey)) {
    throw new Error(`Clé de semaine invalide : « ${weekKey} ».`);
  }

  const week = await ensureDailyAlgoWeek(params.guildId, weekKey, timeZone);
  const wasAlreadyClosed = week.status === 'CLOSED';

  // Le classement est toujours recalculé, jamais relu depuis l'archive.
  //
  // C'est ce qui rend la clôture **rejouable**, et ce n'est pas un luxe : une
  // clôture manuelle le mercredi laisse quatre jours de participations derrière
  // elle. Si le lundi suivant le cron se contentait de constater « déjà clôturée »,
  // les points de tous ces participants seraient perdus en silence.
  const ranking = await getDailyAlgoWeekRanking(params.guildId, weekKey);

  const existingRewards = await prisma.dailyAlgoWeeklyReward.findMany({
    where: { weekId: week.id },
  });
  const rewardByUserId = new Map(existingRewards.map((reward) => [reward.userId, reward]));

  const hasNewcomers = ranking.some((entry) => !rewardByUserId.has(entry.userId));
  const hasPointChanges = ranking.some((entry) => {
    const existing = rewardByUserId.get(entry.userId);
    return existing ? existing.points !== entry.points : false;
  });

  // Rien de neuf depuis la dernière passe : on ne redistribue rien.
  if (wasAlreadyClosed && week.rewardsGrantedAt && !hasNewcomers && !hasPointChanges) {
    return emptyResult('already-closed', weekKey);
  }

  await prisma.$transaction(async (tx) => {
    await tx.dailyAlgoWeek.update({
      where: { id: week.id },
      data: {
        status: 'CLOSED',
        closedAt: week.closedAt ?? new Date(),
        closedById: week.closedById ?? params.closedById ?? null,
        // Colonne Json : le cast borne explicitement la conversion. Le contenu est
        // uniquement composé de chaînes et de nombres, donc sûrement sérialisable.
        finalLeaderboard: ranking as unknown as Prisma.InputJsonValue,
      },
    });

    for (const entry of ranking) {
      const rank = entry.rank <= 3 ? entry.rank : 0;
      const existing = rewardByUserId.get(entry.userId);

      if (existing) {
        // Rattrapage : le total et le rang peuvent avoir bougé depuis la dernière
        // passe. `xpGranted` et `clanPointsGranted` ne sont pas touchés ici, ce
        // sont eux qui empêchent de verser deux fois.
        if (existing.points !== entry.points || existing.rank !== rank) {
          await tx.dailyAlgoWeeklyReward.update({
            where: { id: existing.id },
            data: { points: entry.points, rank },
          });
        }
        continue;
      }

      await tx.dailyAlgoWeeklyReward.create({
        data: {
          weekId: week.id,
          guildId: params.guildId,
          userId: entry.userId,
          // Le podium garde son rang ; au-delà, 0 marque une récompense de
          // simple participation.
          rank,
          points: entry.points,
        },
      });
    }
  });

  const isResuming = wasAlreadyClosed;
  const podium = ranking.filter((entry) => entry.rank <= 3);

  // Sans récompenses activées, on fige quand même le classement : la semaine est
  // clôturée et archivée, simplement rien n'est distribué.
  if (!settings.dailyAlgoWeeklyRewardsEnabled) {
    await prisma.dailyAlgoWeek.update({
      where: { id: week.id },
      data: { rewardsGrantedAt: new Date() },
    });

    logger.info('DailyAlgoWeek', `Semaine ${weekKey} clôturée pour ${params.guildId} sans récompenses (option désactivée).`);
    broadcastDashboardStateChange(params.guildId, 'daily_algo_week_closed');
    return {
      status: isResuming ? 'resumed' : 'closed',
      weekKey,
      participants: ranking.length,
      podium,
      xpGranted: 0,
      rolesAssigned: 0,
      clanPointsGranted: 0,
    };
  }

  const { xpGranted, rolesAssigned } = await grantWeeklyRewards({
    client: params.client,
    settings,
    weekId: week.id,
  });

  // Pont vers les clans, en dernier : une erreur ici ne doit pas empêcher les
  // récompenses propres au Daily Algo d'avoir été versées.
  const clanPointsGranted = await grantClanPointsForWeek({
    client: params.client,
    settings,
    weekId: week.id,
    weekKey,
  }).catch((err: unknown) => {
    logger.error('DailyAlgoWeek', `Échec de la conversion en points de clan pour ${weekKey} :`, err);
    return 0;
  });

  await announceWeekResults({
    client: params.client,
    settings,
    weekKey,
    ranking,
  });

  await prisma.dailyAlgoWeek.update({
    where: { id: week.id },
    data: { rewardsGrantedAt: new Date() },
  });

  logger.success(
    'DailyAlgoWeek',
    `Semaine ${weekKey} clôturée pour ${params.guildId} : ${ranking.length} participant(s), ${xpGranted} XP, ${rolesAssigned} rôle(s), ${clanPointsGranted} point(s) de clan.`,
  );

  broadcastDashboardStateChange(params.guildId, 'daily_algo_week_closed');

  return {
    status: isResuming ? 'resumed' : 'closed',
    weekKey,
    participants: ranking.length,
    podium,
    xpGranted,
    rolesAssigned,
    clanPointsGranted,
  };
}

function emptyResult(status: DailyAlgoWeekCloseResult['status'], weekKey: string): DailyAlgoWeekCloseResult {
  return { status, weekKey, participants: 0, podium: [], xpGranted: 0, rolesAssigned: 0, clanPointsGranted: 0 };
}

/**
 * Verse l'XP et pose les rôles du podium.
 *
 * On travaille sur les lignes `DailyAlgoWeeklyReward` déjà écrites, et on ignore
 * celles dont l'XP est déjà versée : c'est ce qui rend une reprise sans danger.
 */
async function grantWeeklyRewards(params: {
  client: Client;
  settings: GuildWeekSettings;
  weekId: string;
}): Promise<{ xpGranted: number; rolesAssigned: number }> {
  const { client, settings, weekId } = params;

  const rewards = await prisma.dailyAlgoWeeklyReward.findMany({
    where: { weekId },
    orderBy: { rank: 'asc' },
  });

  if (rewards.length === 0) {
    return { xpGranted: 0, rolesAssigned: 0 };
  }

  const discordGuild = client.guilds.cache.get(settings.id)
    ?? await client.guilds.fetch(settings.id).catch(() => null);

  // Rotation des rôles avant toute attribution, sinon on retirerait aussitôt
  // celui qu'on vient de poser.
  if (discordGuild && settings.dailyAlgoWeekRoleRotate) {
    // `role.members` se calcule depuis le cache des membres : sans ce fetch, on
    // ne verrait pas les porteurs non chargés et les rôles s'accumuleraient.
    // Une fois par semaine, le coût est acceptable.
    await discordGuild.members.fetch().catch((err: unknown) => {
      logger.debug('DailyAlgoWeek', `Impossible de charger les membres pour la rotation des rôles : ${err}`);
      return null;
    });

    for (const rank of PODIUM_RANKS) {
      const roleId = resolvePodiumRoleId(settings, rank);
      if (roleId) {
        await rotatePodiumRole(discordGuild, roleId);
      }
    }
  }

  let xpGranted = 0;
  let rolesAssigned = 0;

  for (const reward of rewards) {
    const xpToGrant = resolveRankXp(settings, reward.rank);

    // Déjà versée lors d'une passe précédente : on ne repasse pas dessus.
    if (reward.xpGranted === 0 && xpToGrant > 0) {
      try {
        await addXp(settings.id, reward.userId, xpToGrant, client);
        await prisma.dailyAlgoWeeklyReward.update({
          where: { id: reward.id },
          data: { xpGranted: xpToGrant },
        });
        xpGranted += xpToGrant;
      } catch (err) {
        logger.error('DailyAlgoWeek', `Impossible de verser l'XP hebdomadaire à ${reward.userId} :`, err);
      }
    }

    const roleId = reward.rank >= 1 && reward.rank <= 3
      ? resolvePodiumRoleId(settings, reward.rank)
      : null;

    // Rôle facultatif : un champ vide au panel signifie « pas de rôle », et le
    // reste des récompenses fonctionne quand même.
    if (roleId && discordGuild) {
      const member = discordGuild.members.cache.get(reward.userId)
        ?? await discordGuild.members.fetch(reward.userId).catch(() => null);

      if (member) {
        const added = await member.roles.add(roleId, 'Podium hebdomadaire Daily Algo')
          .then(() => true)
          .catch((err: unknown) => {
            logger.error('DailyAlgoWeek', `Impossible d'attribuer le rôle ${roleId} à ${reward.userId} :`, err);
            return false;
          });

        if (added) {
          rolesAssigned += 1;
          await prisma.dailyAlgoWeeklyReward.update({
            where: { id: reward.id },
            data: { roleId },
          }).catch(() => null);
        }
      }
    }
  }

  return { xpGranted, rolesAssigned };
}

/** Bonus forfaitaire de clan accordé au podium, en plus de la conversion. */
function resolveClanPodiumBonus(settings: GuildWeekSettings, rank: number): number {
  if (rank === 1) return Math.max(0, settings.clanPointsDailyAlgoTop1);
  if (rank === 2) return Math.max(0, settings.clanPointsDailyAlgoTop2);
  if (rank === 3) return Math.max(0, settings.clanPointsDailyAlgoTop3);
  return 0;
}

/**
 * Convertit les points de la semaine en points de clan.
 *
 * **Trois interrupteurs indépendants** doivent être réunis : le Daily Algo actif,
 * les clans actifs, et le pont explicitement activé. Sinon on sort sans rien faire
 * et sans erreur — c'est le cas normal sur un serveur qui n'utilise qu'un des deux
 * modules, ou les deux sans vouloir les lier.
 *
 * `clanService` n'est importé qu'ici, dynamiquement : « Daily Algo seul » ne doit
 * pas traîner le code des clans au chargement.
 *
 * Idempotence : `clanPointsGranted` cumule ce qui a déjà été versé, et on ne verse
 * que le delta. Une clôture rejouée complète donc les nouveaux points sans jamais
 * doubler les anciens.
 */
async function grantClanPointsForWeek(params: {
  client: Client;
  settings: GuildWeekSettings;
  weekId: string;
  weekKey: string;
}): Promise<number> {
  const { client, settings, weekId, weekKey } = params;

  if (!settings.clansEnabled || !settings.clanPointsFromDailyAlgo) return 0;

  const rewards = await prisma.dailyAlgoWeeklyReward.findMany({ where: { weekId } });
  if (rewards.length === 0) return 0;

  const awards = rewards
    .map((reward) => {
      // Conversion des points de la semaine (1 pour 1 par défaut), plus le bonus
      // forfaitaire si le membre est sur le podium.
      const target = convertToClanPoints(reward.points, settings.clanPointsFromDailyAlgoRate)
        + resolveClanPodiumBonus(settings, reward.rank);

      return {
        reward,
        // Delta et non total : une clôture rejouée après de nouvelles
        // participations doit compléter ce qui a déjà été versé, pas le doubler.
        amount: target - reward.clanPointsGranted,
      };
    })
    .filter((entry) => entry.amount > 0);

  if (awards.length === 0) return 0;

  const { awardClanPointsToMembers } = await import('../community/clanService.js');

  const granted = await awardClanPointsToMembers({
    guildId: settings.id,
    client,
    source: 'DAILY_ALGO',
    reason: `Daily Algo ${weekKey}`,
    awards: awards.map((entry) => ({ userId: entry.reward.userId, amount: entry.amount })),
  });

  let total = 0;

  for (const entry of awards) {
    const amount = granted.get(entry.reward.userId);
    // Absent de la map : membre sans clan ou parti du serveur. On laisse
    // `clanPointsGranted` à 0, ce qui permettra un rattrapage ultérieur.
    if (!amount) continue;

    await prisma.dailyAlgoWeeklyReward.update({
      where: { id: entry.reward.id },
      // Incrément : la colonne cumule ce qui a réellement été versé, ce qui rend
      // le calcul du delta juste au tour suivant.
      data: { clanPointsGranted: { increment: amount } },
    }).catch(() => null);

    total += amount;
  }

  return total;
}

/** Publie le bilan de la semaine dans le salon d'annonce, ou à défaut celui du module. */
async function announceWeekResults(params: {
  client: Client;
  settings: GuildWeekSettings;
  weekKey: string;
  ranking: DailyAlgoWeekRankingEntry[];
}): Promise<void> {
  const { client, settings, weekKey, ranking } = params;

  // Pas de salon d'annonce configuré : on retombe sur le salon du Daily Algo
  // plutôt que de ne rien publier du tout.
  const channelId = settings.dailyAlgoWeekAnnouncementChannelId ?? settings.dailyAlgoChannelId;
  if (!channelId) return;

  const channel = await client.channels.fetch(channelId).catch(() => null) as TextChannel | null;
  if (!channel) {
    logger.debug('DailyAlgoWeek', `Salon d'annonce ${channelId} introuvable pour la semaine ${weekKey}.`);
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.primary)
    .setTitle(`🏁 Bilan de la semaine Daily Algo · ${weekKey}`)
    .setTimestamp()
    .setFooter({ text: 'Kotbo · Daily Algo' });

  if (ranking.length === 0) {
    embed.setDescription(`Aucune participation ${formatWeekRangeLabel(weekKey)}. La semaine repart de zéro !`);
    await channel.send({ embeds: [embed] }).catch(() => null);
    return;
  }

  const lines: string[] = [`Classement ${formatWeekRangeLabel(weekKey)}\n`];

  for (const entry of ranking.slice(0, 10)) {
    const bonusTag = entry.bonusPoints > 0 ? ` (dont ✨${entry.bonusPoints} bonus)` : '';
    const participationLabel = entry.participations > 0
      ? `${entry.participations} défi${entry.participations > 1 ? 's' : ''}`
      : 'points bonus uniquement';

    lines.push(`${formatMedal(entry.rank)} <@${entry.userId}> — **${entry.points}** pts${bonusTag} · ${participationLabel}`);
  }

  if (ranking.length > 10) {
    lines.push(`\n… et ${ranking.length - 10} autre${ranking.length - 10 > 1 ? 's' : ''} participant${ranking.length - 10 > 1 ? 's' : ''}.`);
  }

  lines.push('\n*Toute participation validée rapporte des points. À lundi pour la suite !*');

  embed.setDescription(truncate(lines.join('\n'), 4000));
  await channel.send({ embeds: [embed] }).catch(() => null);
}

// ── Entrée du cron ─────────────────────────────────────────────────────────────

/**
 * Clôture la semaine écoulée sur tous les serveurs où le Daily Algo est actif.
 * Déclenché le lundi ; une erreur sur un serveur n'interrompt pas les autres.
 */
export async function runDailyAlgoWeeklyClosuresForAllGuilds(client: Client): Promise<void> {
  const guilds = await prisma.guild.findMany({
    where: { dailyAlgoEnabled: true },
    select: { id: true },
  });

  if (guilds.length === 0) return;

  for (const guild of guilds) {
    try {
      const result = await closeDailyAlgoWeek({ client, guildId: guild.id });

      if (result.status === 'closed' || result.status === 'resumed') {
        logger.info('DailyAlgoWeek', `Clôture ${result.status} de ${result.weekKey} sur ${guild.id}.`);
      }
    } catch (err) {
      logger.error('DailyAlgoWeek', `Échec de la clôture hebdomadaire pour ${guild.id} :`, err);
    }
  }
}
