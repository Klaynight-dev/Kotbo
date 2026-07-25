import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type Client,
  type TextChannel,
} from 'discord.js';
import { Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { COLORS, truncate } from '../../utils/embeds.js';
import { createNotification } from '../staff/staffLeadershipService.js';
import { broadcastDashboardStateChange } from '../../api/shared.js';
import {
  DAILY_ALGO_SPEED_BONUS,
  clampCriterionScore,
  computeCriteriaAverage,
  computeSubmissionPoints,
  getSpeedBonus,
  resolveRunMultiplier,
  roundCriteriaAverage,
  type DailyAlgoCriteriaScores,
} from './dailyAlgoScoring.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export type DailyAlgoDispatchResult = {
  status: 'created' | 'resent' | 'exists';
  runId: string;
  problemTitle: string;
  dateKey: string;
};

export type DailyAlgoSkillTier = 'Débutant' | 'Apprenti' | 'Maître' | 'Légende';

type DailyAlgoFunctionArg = {
  name: string;
  type?: string;
};

type DailyAlgoChallengeTypeKey =
  | 'time-complexity'
  | 'space-complexity'
  | 'code-golf'
  | 'absurd-constraints'
  | 'debug'
  | 'language-imposed'
  | 'classic';

export const DAILY_ALGO_SCORING_RULES = {
  criteria: [
    { key: 'correctness', label: '✅ Exactitude (fonctionnement/cas limites)', max: 5 },
    { key: 'comments', label: '💬 Commentaires (clarté/explications)', max: 5 },
    { key: 'compactness', label: '📦 Compacité (efficacité/superflu)', max: 5 },
    { key: 'optimization', label: '⚡ Optimisation (performance/runtime)', max: 5 },
    { key: 'readability', label: '🧹 Lisibilité (propreté/formatage)', max: 5 },
  ],
  // Barème unique : voir `dailyAlgoScoring.ts`, seule source de vérité.
  speedBonus: DAILY_ALGO_SPEED_BONUS,
} as const;

const dailyAlgoRunDispatchSelect = {
  id: true,
  dateKey: true,
  createdAt: true,
  summarySentAt: true,
  challengeChannelId: true,
  validationChannelId: true,
  challengeMessageId: true,
  leaderboardMessageId: true,
  problem: {
    select: {
      title: true,
      description: true,
      difficulty: true,
      functionName: true,
      functionArgs: true,
      unitTests: true,
      allowedLanguages: true,
    },
  },
} as const;

type DailyAlgoRunMessageData = {
  id: string;
  dateKey: string | null;
  createdAt: Date;
  summarySentAt: Date | null;
  challengeChannelId: string;
  validationChannelId: string | null;
  challengeMessageId: string | null;
  leaderboardMessageId: string | null;
  problem: {
    title: string;
    description: string;
    difficulty: string;
    functionName: string | null;
    functionArgs: DailyAlgoFunctionArg[];
    unitTests: unknown[];
    allowedLanguages: string[];
  };
};

type DailyAlgoRunDispatchPayload = Prisma.DailyAlgoRunGetPayload<{
  select: typeof dailyAlgoRunDispatchSelect;
}>;

function toDailyAlgoRunMessageData(run: DailyAlgoRunDispatchPayload): DailyAlgoRunMessageData {
  const functionArgs = Array.isArray(run.problem.functionArgs)
    ? run.problem.functionArgs.filter((value): value is DailyAlgoFunctionArg => (
        !!value && typeof value === 'object' && typeof (value as { name?: unknown }).name === 'string'
      ))
    : [];

  const unitTests = Array.isArray(run.problem.unitTests) ? run.problem.unitTests : [];
  const allowedLanguages = Array.isArray(run.problem.allowedLanguages)
    ? run.problem.allowedLanguages.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];

  return {
    id: run.id,
    dateKey: run.dateKey,
    createdAt: run.createdAt,
    summarySentAt: run.summarySentAt,
    challengeChannelId: run.challengeChannelId,
    validationChannelId: run.validationChannelId,
    challengeMessageId: run.challengeMessageId,
    leaderboardMessageId: run.leaderboardMessageId,
    problem: {
      title: run.problem.title,
      description: run.problem.description,
      difficulty: run.problem.difficulty,
      functionName: run.problem.functionName,
      functionArgs,
      unitTests,
      allowedLanguages,
    },
  };
}

// ── Points d'une soumission ────────────────────────────────────────────────────

type SubmissionPointsSource = {
  status: string;
  pointsAwarded?: number | null;
  scoreFinal?: number | null;
  speedBonusPoints?: number | null;
};

/**
 * Total de points d'une soumission, toujours en entier.
 *
 * `pointsAwarded` est la source de vérité dès qu'il est renseigné : il a été figé
 * à la notation. Les soumissions notées avant la v2 ne l'ont pas ; on le
 * reconstitue alors depuis la moyenne et le bonus déjà en base, ce qui évite une
 * migration de données rétroactive.
 */
function resolveSubmissionPoints(submission: SubmissionPointsSource): number {
  // Seule une soumission approuvée rapporte des points, quoi qu'il reste en base :
  // une soumission rejetée après avoir été approuvée ne doit rien conserver.
  if (submission.status !== 'APPROVED') {
    return 0;
  }

  if (typeof submission.pointsAwarded === 'number') {
    return submission.pointsAwarded;
  }

  if (typeof submission.scoreFinal !== 'number') {
    return 0;
  }

  return Math.max(0, Math.ceil(submission.scoreFinal + (submission.speedBonusPoints ?? 0)));
}

/**
 * Palier de compétence, à partir de la moyenne **sur 5** et du nombre de
 * soumissions validées.
 *
 * Les seuils étaient exprimés sur 10 (9, 8, 6) alors que `averageScore` est une
 * moyenne sur 5 : aucun n'était atteignable et tout le monde restait « Débutant »
 * à vie. Ils sont ramenés à l'échelle réelle, en gardant les proportions
 * d'origine (9/10 → 4.5/5, 8/10 → 4/5, 6/10 → 3/5).
 */
function resolveSkillTier(averageScore: number, approvedCount: number): DailyAlgoSkillTier {
  if (approvedCount >= 25 && averageScore >= 4.5) return 'Légende';
  if (approvedCount >= 10 && averageScore >= 4) return 'Maître';
  if (approvedCount >= 3 && averageScore >= 3) return 'Apprenti';
  return 'Débutant';
}

function detectChallengeTypeKey(title: string, description: string): DailyAlgoChallengeTypeKey {
  const text = `${title} ${description}`.toLowerCase();

  if (/débog|debug|corrig|fix|bug/.test(text)) {
    return 'debug';
  }

  if (/complexité|o\(n|o\(log|temps d'exécution|runtime/.test(text)) {
    return 'time-complexity';
  }

  if (/mémoire|espace|space complexity|in-place|sans allocation/.test(text)) {
    return 'space-complexity';
  }

  if (/plus court|code golf|minimum de caractères|moins de caractères/.test(text)) {
    return 'code-golf';
  }

  if (/obligatoirement|en python|en rust|en javascript|en go|en typescript|en c\+\+|en c#|en sql|en bash|langage/.test(text)) {
    return 'language-imposed';
  }

  if (/sans la lettre|interdit|absurde|contraintes absurdes|uniquement|sans utiliser/.test(text)) {
    return 'absurd-constraints';
  }

  return 'classic';
}

function pickProblemCandidateWithVariety(params: {
  candidates: Array<{ id: string; title: string; description: string }>;
  recentTypeKeys: DailyAlgoChallengeTypeKey[];
}): { id: string; title: string; description: string } | null {
  const { candidates, recentTypeKeys } = params;
  if (candidates.length === 0) return null;

  const recent = new Set(recentTypeKeys);
  const firstVaried = candidates.find((candidate) => !recent.has(detectChallengeTypeKey(candidate.title, candidate.description)));

  return firstVaried ?? candidates[0] ?? null;
}

// ── Difficulty Emoji ───────────────────────────────────────────────────────────

function difficultyEmoji(difficulty: string): string {
  const d = difficulty.toLowerCase();
  if (d === 'facile') return '🟢';
  if (d === 'moyen') return '🟡';
  if (d === 'difficile') return '🔴';
  return '⚪';
}

// ── Date Utilities ─────────────────────────────────────────────────────────────

export function getLocalDateKey(date = new Date()): string {
  // Daily Algo est configuré en UTC côté panneau d'administration.
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

function isDailyAlgoRunOpenForSubmissions(params: {
  dateKey: string | null;
  createdAt: Date;
  summarySentAt: Date | null;
}): boolean {
  const todayKey = getLocalDateKey();
  if (params.dateKey) {
    return params.dateKey === todayKey;
  }

  if (params.summarySentAt) {
    return false;
  }

  return getLocalDateKey(params.createdAt) === todayKey;
}

function resolveRunDateKey(runDateKey: string | null | undefined, runCreatedAt?: Date): string {
  if (runDateKey) return runDateKey;
  if (runCreatedAt) return getLocalDateKey(runCreatedAt);
  return getLocalDateKey();
}

/**
 * Bonus de rapidité effectivement acquis par une soumission.
 *
 * Le bonus compte dès la soumission, y compris le jour même. Une version
 * précédente le neutralisait tant que la journée n'était pas terminée, mais comme
 * il était aussi neutralisé *à l'écriture*, il finissait stocké à 0 et
 * n'apparaissait jamais — le 3/2/1 était mort. Le rang de soumission est attribué
 * une fois pour toutes et ne bouge plus après coup : rien ne justifie de le
 * masquer, et le figer dans `pointsAwarded` exige de le connaître tout de suite.
 */
function resolveEffectiveSpeedBonus(rawBonus: number | null | undefined): number {
  return rawBonus ?? 0;
}

export function formatDailyAlgoDate(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map((value) => Number(value));

  if (!year || !month || !day) {
    return dateKey;
  }

  return new Date(year, month - 1, day).toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

// ── Button Rows ────────────────────────────────────────────────────────────────

export function getDailyAlgoButtonRow(runId: string, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`daily-algo-submit:${runId}`)
      .setLabel('📝 Soumettre ma solution')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
  );
}

export function getDailyAlgoLeaderboardButtonRow(runId: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`daily-algo-why:${runId}`)
      .setLabel('❓ Pourquoi ma note ?')
      .setStyle(ButtonStyle.Secondary),
  );
}

export function buildDailyAlgoValidationButtons(submissionId: string, disabled = false) {
  const DASHBOARD_URL = process.env.DASHBOARD_URL || 'http://localhost:5173';
  
  const rate = new ButtonBuilder()
    .setLabel('📝 Noter')
    .setStyle(ButtonStyle.Link)
    .setURL(`${DASHBOARD_URL}/dailyalgo/ide?submissionId=${submissionId}`)
    .setDisabled(disabled);

  // Hors-sujet : la réponse ne traite pas le sujet. Aucun point, aucune sanction.
  // À distinguer du rejet, réservé aux dérapages.
  const dismiss = new ButtonBuilder()
    .setCustomId(`validate:dismiss:daily-algo:${submissionId}`)
    .setLabel('Hors-sujet')
    .setEmoji('🚫')
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(disabled);

  const reject = new ButtonBuilder()
    .setCustomId(`validate:reject:daily-algo:${submissionId}`)
    .setLabel('Rejeter')
    .setEmoji('❌')
    .setStyle(ButtonStyle.Danger)
    .setDisabled(disabled);

  return [new ActionRowBuilder<ButtonBuilder>().addComponents(rate, dismiss, reject)];
}

// ── Embed Builders ─────────────────────────────────────────────────────────────

function normalizeAllowedLanguageLabel(language: string): string {
  const value = language.trim().toLowerCase();
  if (value === 'javascript' || value === 'js') return 'JavaScript';
  if (value === 'typescript' || value === 'ts') return 'TypeScript';
  if (value === 'python' || value === 'py') return 'Python';
  if (value === 'c' || value === 'cpp' || value === 'c++') return 'C / C++';
  if (value === 'lua') return 'Lua';
  if (value === 'sqlite' || value === 'sql') return 'SQLite';
  return language;
}

function formatFunctionSignature(functionName: string | null, functionArgs: DailyAlgoFunctionArg[]): string {
  const safeName = functionName?.trim() || 'solve';
  if (functionArgs.length === 0) return `${safeName}()`;
  const args = functionArgs
    .map((arg) => `${arg.name}${arg.type ? `: ${arg.type}` : ''}`)
    .join(', ');
  return `${safeName}(${args})`;
}

function buildDailyAlgoChallengeEmbed(params: {
  title: string;
  problemTitle: string;
  description: string;
  difficulty: string;
  functionName: string | null;
  functionArgs: DailyAlgoFunctionArg[];
  allowedLanguages: string[];
  testsCount?: number;
  footerText?: string;
}) {
  const allowedLanguages = params.allowedLanguages.length > 0
    ? params.allowedLanguages.map((entry) => normalizeAllowedLanguageLabel(entry)).join(' · ')
    : 'Libre (aucune contrainte)';

  const signature = formatFunctionSignature(params.functionName, params.functionArgs);
  const testsLabel = Number.isFinite(params.testsCount) ? Math.max(0, Number(params.testsCount ?? 0)) : 0;

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(params.title)
    .addFields({
      name: '📌 Problème',
      value: `**${truncate(params.problemTitle, 220)}**\n\n${truncate(params.description, 900)}`,
    })
    .addFields({
      name: '⚙️ Difficulté',
      value: `${difficultyEmoji(params.difficulty)} \`${truncate(params.difficulty, 32)}\``,
      inline: true,
    })
    .addFields({
      name: '🧠 Fonction attendue',
      value: `\`${truncate(signature, 200)}\``,
    })
    .addFields({
      name: '🌐 Langages acceptés',
      value: allowedLanguages,
      inline: true,
    })
    .addFields({
      name: '🧪 Tests publics',
      value: testsLabel > 0 ? `${testsLabel} test(s) disponible(s) pour la review` : 'Aucun test configuré',
      inline: true,
    })
    .addFields({
      name: '🧮 Barème de notation (Moyenne /5)',
      value: [
        '✅ **Exactitude** : Fonctionnement correct et cas limites',
        '💬 **Commentaires** : Documentation et explications',
        '📦 **Compacité** : Code efficace sans superflu',
        '⚡ **Optimisation** : Performance et complexité',
        '🧹 **Lisibilité** : Propreté et formatage du code',
        '\n*La qualité prime sur la vitesse. Le classement est basé sur la note /5.*',
      ].join('\n'),
    })
    .setTimestamp()
    .setFooter({ text: params.footerText ?? 'Kotbo · Daily Algo' });

  return embed;
}

// ── Send Challenge Message ─────────────────────────────────────────────────────

async function sendDailyAlgoRunMessage(client: Client, run: DailyAlgoRunMessageData) {
  const channel = await client.channels.fetch(run.challengeChannelId).catch(() => null) as TextChannel | null;

  if (!channel) {
    throw new Error('Le salon du Daily Algo est introuvable.');
  }

  const dateLabel = formatDailyAlgoDate(resolveRunDateKey(run.dateKey, run.createdAt));
  const embed = buildDailyAlgoChallengeEmbed({
    title: `💻 Daily Algo du ${dateLabel}`,
    problemTitle: run.problem.title,
    description: run.problem.description,
    difficulty: run.problem.difficulty,
    functionName: run.problem.functionName,
    functionArgs: run.problem.functionArgs,
    allowedLanguages: run.problem.allowedLanguages,
    testsCount: run.problem.unitTests.length,
  });

  return channel.send({
    embeds: [embed],
    components: [getDailyAlgoButtonRow(run.id)],
  });
}

export async function refreshDailyAlgoChallengeMessageForRun(client: Client, runId: string): Promise<boolean> {
  const runRaw = await prisma.dailyAlgoRun.findUnique({
    where: { id: runId },
    select: dailyAlgoRunDispatchSelect,
  });

  const challengeMessageId = runRaw?.challengeMessageId;
  if (!challengeMessageId) {
    return false;
  }

  const run = toDailyAlgoRunMessageData(runRaw);
  const channel = await client.channels.fetch(run.challengeChannelId).catch(() => null) as TextChannel | null;
  if (!channel) {
    return false;
  }

  const message = await channel.messages.fetch(challengeMessageId).catch(() => null);
  if (!message) {
    return false;
  }

  const runDate = resolveRunDateKey(run.dateKey, run.createdAt);
  const canSubmit = isDailyAlgoRunOpenForSubmissions({
    dateKey: run.dateKey,
    createdAt: run.createdAt,
    summarySentAt: run.summarySentAt,
  });
  const embed = buildDailyAlgoChallengeEmbed({
    title: `💻 Daily Algo du ${formatDailyAlgoDate(runDate)}`,
    problemTitle: run.problem.title,
    description: run.problem.description,
    difficulty: run.problem.difficulty,
    functionName: run.problem.functionName,
    functionArgs: run.problem.functionArgs,
    allowedLanguages: run.problem.allowedLanguages,
    testsCount: run.problem.unitTests.length,
  });

  await message.edit({
    embeds: [embed],
    components: [getDailyAlgoButtonRow(run.id, !canSubmit)],
  });

  return true;
}

// ── Leaderboard Embed ──────────────────────────────────────────────────────────

function formatScoreBar(score: number): string {
  const safeScore = Number.isFinite(score) ? Math.max(0, Math.min(5, Math.trunc(score))) : 0;
  const filled = '█'.repeat(safeScore);
  const empty = '░'.repeat(5 - safeScore);
  return `${filled}${empty} ${safeScore}/5`;
}

function formatRankMedal(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

type LeaderboardSubmission = {
  id: string;
  authorId: string;
  authorName: string;
  status: string;
  submittedAt: Date;
  speedRank: number | null;
  speedBonusPoints: number | null;
  scoreCorrectness: number | null;
  scoreComments: number | null;
  scoreCompactness: number | null;
  scoreOptimization: number | null;
  scoreReadability: number | null;
  scoreFinal: number | null;
  pointsAwarded: number | null;
};

function buildLeaderboardEmbed(
  submissions: LeaderboardSubmission[],
  runCreatedAt: Date,
): EmbedBuilder {
  const approved = submissions
    .filter((s) => s.status === 'APPROVED' && s.scoreFinal !== null)
    .sort((a, b) => {
      const pointsA = resolveSubmissionPoints(a);
      const pointsB = resolveSubmissionPoints(b);
      if (pointsB !== pointsA) return pointsB - pointsA;

      const scoreA = a.scoreFinal ?? 0;
      const scoreB = b.scoreFinal ?? 0;
      if (scoreB !== scoreA) return scoreB - scoreA;

      return (a.speedRank ?? 999) - (b.speedRank ?? 999);
    });

  const pending = submissions.filter((s) => s.status === 'PENDING');
  const rejected = submissions.filter((s) => s.status === 'REJECTED');
  const dismissed = submissions.filter((s) => s.status === 'DISMISSED');
  const maxApprovedEntries = 15;
  const maxPendingEntries = 10;
  const maxRejectedEntries = 10;

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('📊 Classement du Daily Algo')
    .setTimestamp()
    .setFooter({ text: 'Kotbo · Daily Algo · Classement en direct' });

  if (submissions.length === 0) {
    embed.setDescription('*Aucune participation pour le moment. Clique sur le bouton ci-dessus pour soumettre ta solution !*');
    return embed;
  }

  const lines: string[] = [];

  // ── Ranked participants ──
  if (approved.length > 0) {
    lines.push('**🏆 Classés**\n');
    for (let i = 0; i < Math.min(approved.length, maxApprovedEntries); i++) {
      const s = approved[i]!;
      const bonus = resolveEffectiveSpeedBonus(s.speedBonusPoints);
      const totalScore = resolveSubmissionPoints(s);
      const medal = formatRankMedal(i + 1);
      const speedTag = bonus > 0
        ? ` ⚡+${bonus}`
        : '';

      lines.push(`${medal} **${s.authorName}** — **${totalScore}** pts${speedTag}`);
      lines.push(`┊ ✅ ${formatScoreBar(s.scoreCorrectness ?? 0)} · 💬 ${formatScoreBar(s.scoreComments ?? 0)}`);
      lines.push(`┊ 📦 ${formatScoreBar(s.scoreCompactness ?? 0)} · ⚡ ${formatScoreBar(s.scoreOptimization ?? 0)}`);
      lines.push(`┊ 🧹 ${formatScoreBar(s.scoreReadability ?? 0)}`);
      lines.push('');
    }

    if (approved.length > maxApprovedEntries) {
      lines.push(`… et ${approved.length - maxApprovedEntries} autre${approved.length - maxApprovedEntries > 1 ? 's' : ''} classement${approved.length - maxApprovedEntries > 1 ? 's' : ''}`);
      lines.push('');
    }
  }

  // ── Pending participants ──
  if (pending.length > 0) {
    lines.push('**⏳ En attente de classement**\n');
    for (const s of pending.slice(0, maxPendingEntries)) {
      const elapsed = timeDiff(runCreatedAt, s.submittedAt);
      const speedLabel = s.speedRank ? ` · ${formatRankMedal(s.speedRank)} arrivé` : '';
      lines.push(`⏳ **${s.authorName}** — soumis après ${elapsed}${speedLabel}`);
    }

    if (pending.length > maxPendingEntries) {
      lines.push(`… et ${pending.length - maxPendingEntries} autre${pending.length - maxPendingEntries > 1 ? 's' : ''} en attente`);
    }
    lines.push('');
  }

  // ── Off-topic participants (no points, no sanction) ──
  if (dismissed.length > 0) {
    lines.push('**🚫 Hors-sujet**\n');
    for (const s of dismissed.slice(0, maxRejectedEntries)) {
      lines.push(`${s.authorName}`);
    }

    if (dismissed.length > maxRejectedEntries) {
      lines.push(`… et ${dismissed.length - maxRejectedEntries} autre${dismissed.length - maxRejectedEntries > 1 ? 's' : ''}`);
    }
    lines.push('');
  }

  // ── Rejected participants ──
  if (rejected.length > 0) {
    lines.push('**❌ Non validés**\n');
    for (const s of rejected.slice(0, maxRejectedEntries)) {
      lines.push(`~~${s.authorName}~~`);
    }

    if (rejected.length > maxRejectedEntries) {
      lines.push(`… et ${rejected.length - maxRejectedEntries} autre${rejected.length - maxRejectedEntries > 1 ? 's' : ''} rejeté${rejected.length - maxRejectedEntries > 1 ? 's' : ''}`);
    }
  }

  embed.setDescription(truncate(lines.join('\n'), 4000));
  return embed;
}

function timeDiff(from: Date, to: Date): string {
  const diffMs = to.getTime() - from.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}min`;
  const diffH = Math.floor(diffMin / 60);
  const remainMin = diffMin % 60;
  return `${diffH}h${remainMin > 0 ? `${remainMin}min` : ''}`;
}

// ── Update Leaderboard ─────────────────────────────────────────────────────────

export async function updateDailyAlgoLeaderboard(client: Client, runId: string): Promise<void> {
  const run = await prisma.dailyAlgoRun.findUnique({
    where: { id: runId },
    include: {
      submissions: {
        orderBy: { submittedAt: 'asc' },
      },
    },
  });

  if (!run) {
    logger.debug('DailyAlgo', `Run ${runId} introuvable pour la mise à jour du leaderboard.`);
    return;
  }

  const channel = await client.channels.fetch(run.challengeChannelId).catch(() => null) as TextChannel | null;
  if (!channel) {
    logger.debug('DailyAlgo', `Canal de challenge ${run.challengeChannelId} introuvable pour le leaderboard du run ${runId}.`);
    return;
  }

  const embed = buildLeaderboardEmbed(run.submissions, run.createdAt);

  if (run.leaderboardMessageId) {
    logger.debug('DailyAlgo', `Mise à jour du message de classement ${run.leaderboardMessageId} pour le run ${runId}...`);
    const message = await channel.messages.fetch(run.leaderboardMessageId).catch(() => null);
    if (message) {
      await message.edit({
        embeds: [embed],
        components: [getDailyAlgoLeaderboardButtonRow(run.id)],
      }).catch((err) => logger.debug('DailyAlgo', `Erreur edit leaderboard message: ${err}`));
      return;
    }
  }

  // No existing leaderboard message or it was deleted → send new one
  logger.debug('DailyAlgo', `Création d'un nouveau message de classement pour le run ${runId}...`);
  const newMessage = await channel.send({
    embeds: [embed],
    components: [getDailyAlgoLeaderboardButtonRow(run.id)],
  }).catch((err) => {
    logger.debug('DailyAlgo', `Erreur send leaderboard message: ${err}`);
    return null;
  });

  if (newMessage) {
    await prisma.dailyAlgoRun.update({
      where: { id: runId },
      data: { leaderboardMessageId: newMessage.id },
    }).catch((err) => logger.debug('DailyAlgo', `Erreur update run leaderboardMessageId: ${err}`));
  }
}

// ── Queue Submission ───────────────────────────────────────────────────────────

export async function getDailyAlgoSubmissionAvailability(runId: string): Promise<{
  isOpen: boolean;
  reason: string | null;
}> {
  const run = await prisma.dailyAlgoRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      dateKey: true,
      createdAt: true,
      summarySentAt: true,
    },
  });

  if (!run) {
    return {
      isOpen: false,
      reason: 'Le Daily Algo demandé est introuvable.',
    };
  }

  const isOpen = isDailyAlgoRunOpenForSubmissions({
    dateKey: run.dateKey,
    createdAt: run.createdAt,
    summarySentAt: run.summarySentAt,
  });

  if (!isOpen) {
    return {
      isOpen: false,
      reason: 'Ce Daily Algo est clôturé. Les soumissions ne sont ouvertes que le jour même.',
    };
  }

  return {
    isOpen: true,
    reason: null,
  };
}

export async function queueDailyAlgoSubmission(params: {
  client: Client;
  runId: string;
  authorId: string;
  authorName: string;
  solution: string;
}): Promise<{ speedRank: number }> {
  const run = await prisma.dailyAlgoRun.findUnique({
    where: { id: params.runId },
    include: {
      guild: true,
      problem: true,
      submissions: {
        orderBy: { submittedAt: 'asc' },
      },
    },
  });

  if (!run) {
    throw new Error('Le Daily Algo demandé est introuvable.');
  }

  const canSubmit = isDailyAlgoRunOpenForSubmissions({
    dateKey: run.dateKey,
    createdAt: run.createdAt,
    summarySentAt: run.summarySentAt,
  });

  if (!canSubmit) {
    throw new Error('Ce Daily Algo est clôturé. Les soumissions ne sont ouvertes que le jour même.');
  }

  // Check double submission
  const alreadySubmitted = run.submissions.find((s) => s.authorId === params.authorId);
  if (alreadySubmitted) {
    throw new Error('Tu as déjà soumis une solution pour ce Daily Algo !');
  }

  // Calculate speed rank
  const currentCount = run.submissions.length;
  const speedRank = currentCount + 1;
  // Bonus brut : on le stocke tel quel. Le neutraliser ici (parce que le run est
  // celui du jour) le figeait à 0 pour toujours.
  const speedBonusPoints = getSpeedBonus(speedRank);

  const channelId = run.validationChannelId ?? run.guild.dailyAlgoValidationChannelId ?? run.challengeChannelId;
  const channel = await params.client.channels.fetch(channelId).catch(() => null) as TextChannel | null;

  if (!channel) {
    throw new Error('Le salon de validation Daily Algo est introuvable.');
  }

  const submission = await prisma.dailyAlgoSubmission.create({
    data: {
      runId: run.id,
      authorId: params.authorId,
      authorName: params.authorName,
      solution: params.solution,
      submittedAt: new Date(),
      speedRank,
      speedBonusPoints,
    },
  });

  // Send validation embed to staff channel
  const elapsed = timeDiff(run.createdAt, submission.submittedAt);
  const embed = new EmbedBuilder()
    .setColor(COLORS.warning)
    .setTitle('🧪 Réponse Daily Algo à valider')
    .addFields(
      { name: 'Auteur', value: submission.authorName, inline: true },
      { name: 'Défi', value: truncate(run.problem.title, 256), inline: true },
      {
        name: 'Rapidité',
        value: speedBonusPoints > 0
          ? `${formatRankMedal(speedRank)} (${elapsed}) +${speedBonusPoints}pts`
          : `${formatRankMedal(speedRank)} (${elapsed})`,
        inline: true,
      },
    )
    .setDescription(`\`\`\`\n${truncate(params.solution, 1800)}\n\`\`\``)
    .setTimestamp()
    .setFooter({ text: 'Kotbo · Daily Algo · En attente de notation' });

  const message = await channel.send({
    embeds: [embed],
    components: buildDailyAlgoValidationButtons(submission.id),
  });

  await prisma.dailyAlgoSubmission.update({
    where: { id: submission.id },
    data: { validationMessageId: message.id },
  });

  // Update leaderboard in challenge channel
  await updateDailyAlgoLeaderboard(params.client, run.id);

  logger.success('DailyAlgo', `Réponse de ${submission.authorName} (${formatRankMedal(speedRank)}) envoyée en validation pour la guilde ${run.guildId}`);

  // Le panel affiche la file de validation en direct : sans cet évènement, une
  // soumission postée depuis Discord n'apparaît qu'au prochain « Actualiser ».
  broadcastDashboardStateChange(run.guildId, 'daily_algo_submission_created');

  return { speedRank };
}

// ── Get Previous Run ───────────────────────────────────────────────────────────

export async function getPreviousDailyAlgoRun(guildId: string) {
  const todayKey = getLocalDateKey();

  return prisma.dailyAlgoRun.findFirst({
    where: {
      guildId,
      dateKey: {
        lt: todayKey,
      },
    },
    orderBy: {
      dateKey: 'desc',
    },
    select: {
      id: true,
      dateKey: true,
      createdAt: true,
      problem: {
        select: {
          title: true,
          description: true,
          difficulty: true,
        },
      },
    },
  });
}

export type DailyAlgoGuildRankingEntry = {
  rank: number;
  authorId: string;
  authorName: string;
  approvedCount: number;
  averageScore: number;
  bestScore: number;
  totalPoints: number;
  currentStreak: number;
  bestStreak: number;
  tier: DailyAlgoSkillTier;
};

function countStreaks(dateKeys: string[]): { current: number; best: number } {
  if (dateKeys.length === 0) {
    return { current: 0, best: 0 };
  }

  const sorted = [...new Set(dateKeys)].sort((a, b) => b.localeCompare(a));
  let current = 1;
  let best = 1;
  let run = 1;

  for (let i = 1; i < sorted.length; i++) {
    const prevDate = new Date(`${sorted[i - 1]}T00:00:00.000Z`);
    const currentDate = new Date(`${sorted[i]}T00:00:00.000Z`);
    const deltaDays = Math.round((prevDate.getTime() - currentDate.getTime()) / 86400000);

    if (deltaDays === 1) {
      run += 1;
      if (i === run - 1) {
        current = run;
      }
    } else {
      run = 1;
    }

    if (run > best) {
      best = run;
    }
  }

  return { current, best };
}

/**
 * Bornes de journées facultatives, sous forme de clés « YYYY-MM-DD ».
 * Ces clés sont triables comme des chaînes : filtrer une semaine se réduit donc à
 * une comparaison lexicographique, sans arithmétique de fuseau. La contrainte
 * `@@unique([guildId, dateKey])` sert d'index pour ce filtre.
 *
 * Attention : `DailyAlgoRun.dateKey` est nullable. Un run dont la clé est nulle
 * est donc exclu de toute plage (NULL échoue aux comparaisons SQL). Les runs créés
 * par `sendDailyAlgo` ont toujours une clé ; seules d'éventuelles données
 * anciennes pourraient manquer à l'appel d'un classement hebdomadaire.
 */
export type DailyAlgoDateKeyRange = {
  firstDateKey: string;
  lastDateKey: string;
};

export async function getGuildDailyAlgoRanking(
  guildId: string,
  range?: DailyAlgoDateKeyRange,
): Promise<DailyAlgoGuildRankingEntry[]> {
  const approvedSubmissions = await prisma.dailyAlgoSubmission.findMany({
    where: {
      status: 'APPROVED',
      run: {
        guildId,
        ...(range
          ? { dateKey: { gte: range.firstDateKey, lte: range.lastDateKey } }
          : {}),
      },
    },
    select: {
      authorId: true,
      authorName: true,
      status: true,
      speedBonusPoints: true,
      scoreFinal: true,
      pointsAwarded: true,
      run: {
        select: {
          dateKey: true,
          createdAt: true,
        },
      },
    },
    orderBy: {
      createdAt: 'asc',
    },
  });

  const byUser = new Map<string, {
    authorName: string;
    approvedCount: number;
    totalRawScore: number;
    totalPoints: number;
    bestScore: number;
    dateKeys: string[];
  }>();

  for (const submission of approvedSubmissions) {
    const score = submission.scoreFinal ?? 0;
    const points = resolveSubmissionPoints(submission);
    const existing = byUser.get(submission.authorId);

    if (!existing) {
      byUser.set(submission.authorId, {
        authorName: submission.authorName,
        approvedCount: 1,
        totalRawScore: score,
        totalPoints: points,
        bestScore: points,
        dateKeys: submission.run.dateKey ? [submission.run.dateKey] : [],
      });
      continue;
    }

    existing.approvedCount += 1;
    existing.totalRawScore += score;
    existing.totalPoints += points;
    existing.bestScore = Math.max(existing.bestScore, points);
    if (submission.run.dateKey) {
      existing.dateKeys.push(submission.run.dateKey);
    }
  }

  const ranking = [...byUser.entries()].map(([authorId, data]) => {
    const averageScore = data.approvedCount > 0
      ? Math.round((data.totalRawScore / data.approvedCount) * 10) / 10
      : 0;
    const { current, best } = countStreaks(data.dateKeys);

    return {
      rank: 0,
      authorId,
      authorName: data.authorName,
      approvedCount: data.approvedCount,
      averageScore,
      // Les points sont des entiers : une somme d'entiers l'est aussi.
      bestScore: data.bestScore,
      totalPoints: data.totalPoints,
      currentStreak: current,
      bestStreak: best,
      tier: resolveSkillTier(averageScore, data.approvedCount),
    } satisfies DailyAlgoGuildRankingEntry;
  });

  ranking.sort((a, b) => {
    if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
    if (b.averageScore !== a.averageScore) return b.averageScore - a.averageScore;
    return b.approvedCount - a.approvedCount;
  });

  return ranking.map((entry, index) => ({
    ...entry,
    rank: index + 1,
  }));
}

/**
 * Profil d'un membre, rang compris.
 *
 * Le rang impose de connaître les totaux de tous les autres : on passe donc par le
 * classement complet, il n'y a pas de raccourci. Le coût réel est le chargement de
 * l'historique intégral des soumissions approuvées du serveur — un `groupBy` ne
 * suffirait pas, les séries (`streaks`) ont besoin de la liste des journées et les
 * soumissions d'avant la v2 ont besoin du repli de calcul. La vraie correction est
 * une table d'agrégats entretenue à la notation ; tant qu'elle n'existe pas, éviter
 * d'appeler cette fonction dans une boucle.
 */
export async function getDailyAlgoUserProfile(guildId: string, authorId: string): Promise<DailyAlgoGuildRankingEntry | null> {
  const ranking = await getGuildDailyAlgoRanking(guildId);
  return ranking.find((entry) => entry.authorId === authorId) ?? null;
}

export type DailyAlgoUserParticipation = {
  submissionId: string;
  runId: string;
  dateKey: string | null;
  problemTitle: string;
  difficulty: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  submittedAt: Date;
  speedRank: number | null;
  scoreFinal: number | null;
  speedBonusPoints: number | null;
  totalPoints: number | null;
  rankInRun: number | null;
};

export async function getDailyAlgoUserParticipations(
  guildId: string,
  authorId: string,
  limit = 10,
): Promise<DailyAlgoUserParticipation[]> {
  const safeLimit = Math.max(1, Math.min(20, Math.trunc(limit)));

  const submissions = await prisma.dailyAlgoSubmission.findMany({
    where: {
      authorId,
      run: {
        guildId,
      },
    },
    orderBy: {
      submittedAt: 'desc',
    },
    take: safeLimit,
    select: {
      id: true,
      runId: true,
      status: true,
      submittedAt: true,
      speedRank: true,
      scoreFinal: true,
      speedBonusPoints: true,
      pointsAwarded: true,
      run: {
        select: {
          dateKey: true,
          createdAt: true,
          problem: {
            select: {
              title: true,
              difficulty: true,
            },
          },
        },
      },
    },
  });

  const runRankCache = new Map<string, Map<string, number>>();

  const resolveRankInRun = async (runId: string, submissionId: string): Promise<number | null> => {
    let rankMap = runRankCache.get(runId);

    if (!rankMap) {
      const approved = await prisma.dailyAlgoSubmission.findMany({
        where: {
          runId,
          status: 'APPROVED',
          scoreFinal: {
            not: null,
          },
        },
        select: {
          id: true,
          status: true,
          scoreFinal: true,
          speedBonusPoints: true,
          pointsAwarded: true,
          speedRank: true,
        },
      });

      approved.sort((a, b) => {
        const pointsA = resolveSubmissionPoints(a);
        const pointsB = resolveSubmissionPoints(b);
        if (pointsB !== pointsA) return pointsB - pointsA;

        const scoreA = a.scoreFinal ?? 0;
        const scoreB = b.scoreFinal ?? 0;
        if (scoreB !== scoreA) return scoreB - scoreA;

        return (a.speedRank ?? 999) - (b.speedRank ?? 999);
      });

      rankMap = new Map<string, number>();
      approved.forEach((entry, index) => {
        rankMap?.set(entry.id, index + 1);
      });

      runRankCache.set(runId, rankMap);
    }

    return rankMap.get(submissionId) ?? null;
  };

  const participations = await Promise.all(submissions.map(async (submission) => {
    const effectiveBonus = resolveEffectiveSpeedBonus(submission.speedBonusPoints);
    const totalPoints = submission.scoreFinal !== null
      ? resolveSubmissionPoints(submission)
      : null;
    const rankInRun = submission.status === 'APPROVED'
      ? await resolveRankInRun(submission.runId, submission.id)
      : null;

    return {
      submissionId: submission.id,
      runId: submission.runId,
      dateKey: submission.run.dateKey ?? null,
      problemTitle: submission.run.problem.title,
      difficulty: submission.run.problem.difficulty,
      status: submission.status,
      submittedAt: submission.submittedAt,
      speedRank: submission.speedRank,
      scoreFinal: submission.scoreFinal,
      speedBonusPoints: effectiveBonus,
      totalPoints,
      rankInRun,
    } satisfies DailyAlgoUserParticipation;
  }));

  return participations;
}

export type DailyAlgoSubmissionFeedback = {
  submissionId: string;
  runId: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'DISMISSED';
  problemTitle: string;
  scoreCorrectness: number | null;
  scoreComments: number | null;
  scoreCompactness: number | null;
  scoreOptimization: number | null;
  scoreReadability: number | null;
  scoreFinal: number | null;
  speedBonusPoints: number | null;
  totalPoints: number | null;
  reviewFeedback: string | null;
  validatedAt: Date | null;
};

export async function getDailyAlgoSubmissionFeedbackForUser(runId: string, authorId: string): Promise<DailyAlgoSubmissionFeedback | null> {
  const submission = await prisma.dailyAlgoSubmission.findFirst({
    where: {
      runId,
      authorId,
    },
    select: {
      id: true,
      runId: true,
      status: true,
      scoreCorrectness: true,
      scoreComments: true,
      scoreCompactness: true,
      scoreOptimization: true,
      scoreReadability: true,
      scoreFinal: true,
      speedBonusPoints: true,
      pointsAwarded: true,
      reviewFeedback: true,
      validatedAt: true,
      run: {
        select: {
          dateKey: true,
          createdAt: true,
          problem: {
            select: {
              title: true,
            },
          },
        },
      },
    },
  });

  if (!submission) {
    return null;
  }

  const effectiveBonus = resolveEffectiveSpeedBonus(submission.speedBonusPoints);
  const totalPoints = submission.scoreFinal !== null
    ? resolveSubmissionPoints(submission)
    : null;

  return {
    submissionId: submission.id,
    runId: submission.runId,
    status: submission.status,
    problemTitle: submission.run.problem.title,
    scoreCorrectness: submission.scoreCorrectness,
    scoreComments: submission.scoreComments,
    scoreCompactness: submission.scoreCompactness,
    scoreOptimization: submission.scoreOptimization,
    scoreReadability: submission.scoreReadability,
    scoreFinal: submission.scoreFinal,
    speedBonusPoints: effectiveBonus,
    totalPoints,
    reviewFeedback: submission.reviewFeedback,
    validatedAt: submission.validatedAt,
  };
}

// ── Review Submission (with scoring) ───────────────────────────────────────────

export async function reviewDailyAlgoSubmission(params: {
  client: Client;
  submissionId: string;
  /**
   * `dismiss` = hors-sujet : aucun point, mais aucune sanction. À réserver aux
   * réponses qui ne traitent pas le sujet ; une tentative maladroite mais sincère
   * doit être approuvée (elle touche alors le plancher de participation).
   */
  action: 'approve' | 'reject' | 'dismiss';
  moderatorId: string;
  allowReviewedUpdate?: boolean;
  scores?: {
    correctness: number;
    comments: number;
    compactness: number;
    optimization: number;
    readability: number;
  };
  feedback?: string;
}): Promise<boolean> {
  const submission = await prisma.dailyAlgoSubmission.findUnique({
    where: { id: params.submissionId },
    include: {
      run: {
        include: {
          guild: true,
          problem: true,
        },
      },
    },
  });

  if (!submission) {
    return false;
  }

  const todayKey = getLocalDateKey();
  const runDateKey = submission.run.dateKey ?? getLocalDateKey(submission.run.createdAt);
  const isTodayRun = runDateKey === todayKey;
  const effectiveBonus = resolveEffectiveSpeedBonus(submission.speedBonusPoints);
  const isAlreadyReviewed = submission.status === 'APPROVED'
    || submission.status === 'REJECTED'
    || submission.status === 'DISMISSED';
  const canEditReviewedSubmission = params.allowReviewedUpdate === true && isAlreadyReviewed && isTodayRun;

  if (submission.status !== 'PENDING' && !canEditReviewedSubmission) {
    return false;
  }

  const status = params.action === 'approve'
    ? 'APPROVED'
    : params.action === 'dismiss' ? 'DISMISSED' : 'REJECTED';
  const normalizedFeedback = typeof params.feedback === 'string'
    ? params.feedback.trim()
    : '';

  const updateData: Record<string, unknown> = {
    status,
    validatedAt: new Date(),
    validatedById: params.moderatorId,
  };

  if (params.action === 'approve' && params.scores) {
    // Aucune note à 0 : on est là pour apprendre, une tentative vaut au moins 1/5.
    const correctness = clampCriterionScore(params.scores.correctness);
    const comments = clampCriterionScore(params.scores.comments);
    const compactness = clampCriterionScore(params.scores.compactness);
    const optimization = clampCriterionScore(params.scores.optimization);
    const readability = clampCriterionScore(params.scores.readability);

    const clampedScores: DailyAlgoCriteriaScores = {
      correctness, comments, compactness, optimization, readability,
    };

    const hasLowScore = [correctness, comments, compactness, optimization, readability].some((score) => score < 5);

    if (hasLowScore && !normalizedFeedback) {
      throw new Error('Une explication est obligatoire quand une note est inférieure à 5/5.');
    }

    updateData.scoreCorrectness = correctness;
    updateData.scoreComments = comments;
    updateData.scoreCompactness = compactness;
    updateData.scoreOptimization = optimization;
    updateData.scoreReadability = readability;
    updateData.scoreFinal = roundCriteriaAverage(computeCriteriaAverage(clampedScores));

    // Total figé, en entier. Le bonus de rapidité y est toujours inclus : la
    // notation a lieu le jour même, on ne peut pas attendre pour le connaître.
    updateData.pointsAwarded = computeSubmissionPoints({
      scores: clampedScores,
      speedRank: submission.speedRank,
      participationPoints: submission.run.guild.dailyAlgoParticipationPoints,
      pointsMultiplier: submission.run.pointsMultiplier,
    });
    updateData.reviewFeedback = normalizedFeedback || 'Rien à redire.';
  } else if (params.action === 'reject' || params.action === 'dismiss') {
    // Aucun point. Remise à zéro explicite : la renotation du jour même peut
    // porter sur une soumission déjà approuvée, qui avait donc un total figé.
    // Testé sur l'action et non sur « pas de notes », pour qu'une approbation
    // sans notes ne vienne jamais écraser un total à 0.
    updateData.pointsAwarded = 0;

    if (normalizedFeedback) {
      updateData.reviewFeedback = normalizedFeedback;
    }
  } else if (normalizedFeedback) {
    updateData.reviewFeedback = normalizedFeedback;
  }

  await prisma.dailyAlgoSubmission.update({
    where: { id: submission.id },
    data: updateData,
  });

  // Update validation message in staff channel
  if (submission.validationMessageId) {
    const channelId = submission.run.validationChannelId ?? submission.run.guild.dailyAlgoValidationChannelId ?? submission.run.challengeChannelId;
    const channel = await params.client.channels.fetch(channelId).catch(() => null) as TextChannel | null;
    if (channel) {
      const message = await channel.messages.fetch(submission.validationMessageId).catch(() => null);
      if (message) {
        const moderator = await params.client.users.fetch(params.moderatorId).catch(() => null);

        const moderatorLabel = moderator?.globalName ?? moderator?.username ?? null;

        let footerLabel: string;
        if (params.action === 'approve' && params.scores) {
          const totalScore = Number(updateData.pointsAwarded ?? 0);
          footerLabel = moderatorLabel
            ? `✅ Noté ${totalScore}pts par ${moderatorLabel}`
            : `✅ Noté ${totalScore}pts`;
        } else if (params.action === 'dismiss') {
          footerLabel = moderatorLabel
            ? `🚫 Hors-sujet par ${moderatorLabel}`
            : '🚫 Hors-sujet';
        } else {
          footerLabel = moderatorLabel
            ? `❌ Rejeté par ${moderatorLabel}`
            : '❌ Rejeté';
        }

        // Le message de validation est en Components V2 (voir utils/patchV2.ts) :
        // `message.embeds` est vide, on reconstruit donc l'embed depuis la
        // soumission (l'énoncé/réponse seraient perdus en relisant le message).
        const elapsed = timeDiff(submission.run.createdAt, submission.submittedAt);
        const embed = new EmbedBuilder()
          .setColor(params.action === 'approve' ? COLORS.success : COLORS.danger)
          .setTitle('🧪 Réponse Daily Algo à valider')
          .addFields(
            { name: 'Auteur', value: submission.authorName, inline: true },
            { name: 'Défi', value: truncate(submission.run.problem.title, 256), inline: true },
            {
              name: 'Rapidité',
              value: (submission.speedBonusPoints ?? 0) > 0
                ? `${formatRankMedal(submission.speedRank ?? 0)} (${elapsed}) +${submission.speedBonusPoints}pts`
                : `${formatRankMedal(submission.speedRank ?? 0)} (${elapsed})`,
              inline: true,
            },
          )
          .setDescription(`\`\`\`\n${truncate(submission.solution, 1800)}\n\`\`\``)
          .setTimestamp()
          .setFooter({ text: `Kotbo · ${footerLabel}` });

        if (normalizedFeedback) {
          embed.addFields({
            name: '🗒️ Feedback staff',
            value: truncate(normalizedFeedback, 1024),
          });
        }

        await message.edit({
          embeds: [embed],
          components: buildDailyAlgoValidationButtons(submission.id, true),
        });
      }
    }
  }

  // Update leaderboard in challenge channel
  await updateDailyAlgoLeaderboard(params.client, submission.runId);

  const moderator = await params.client.users.fetch(params.moderatorId).catch(() => null);
  const author = await params.client.users.fetch(submission.authorId).catch(() => null);

  if (author) {
    const guild = params.client.guilds.cache.get(submission.run.guildId) || await params.client.guilds.fetch(submission.run.guildId).catch(() => null);
    const serverName = guild ? guild.name : '';

    const dmDescription = params.action === 'approve'
      ? 'Ta soumission a été notée par le staff.'
      : params.action === 'dismiss'
        ? 'Ta soumission a été jugée hors-sujet par le staff : elle ne rapporte pas de points, mais elle n’entraîne aucune sanction. N’hésite pas à retenter demain !'
        : 'Ta soumission a été rejetée par le staff.';

    const dmStatusLabel = params.action === 'approve'
      ? '✅ Validée'
      : params.action === 'dismiss' ? '🚫 Hors-sujet' : '❌ Rejetée';

    const dmEmbed = new EmbedBuilder()
      .setColor(params.action === 'approve'
        ? COLORS.success
        : params.action === 'dismiss' ? COLORS.warning : COLORS.danger)
      .setTitle(`📬 Retour Daily Algo · ${submission.run.problem.title}`)
      .setDescription(dmDescription)
      .addFields(
        {
          name: 'Statut',
          value: dmStatusLabel,
          inline: true,
        },
        {
          name: 'Modérateur',
          value: moderator?.globalName ?? moderator?.username ?? `ID ${params.moderatorId}`,
          inline: true,
        },
      )
      .setTimestamp()
      .setFooter({ text: serverName ? `Kotbo · Daily Algo · ${serverName}` : 'Kotbo · Daily Algo' });

    if (params.action === 'approve' && params.scores) {
      const average = Number(updateData.scoreFinal ?? 0);
      const totalPoints = Number(updateData.pointsAwarded ?? 0);
      const bonusLabel = effectiveBonus > 0 ? ` (dont ⚡+${effectiveBonus} de rapidité)` : '';

      dmEmbed.addFields(
        {
          name: 'Détail des notes',
          value: `✅ ${updateData.scoreCorrectness}/5 · 💬 ${updateData.scoreComments}/5 · 📦 ${updateData.scoreCompactness}/5 · ⚡ ${updateData.scoreOptimization}/5 · 🧹 ${updateData.scoreReadability}/5`,
          inline: false,
        },
        {
          name: 'Résultat',
          value: `Moyenne: **${average.toFixed(1)}/5** · Total: **${totalPoints} pts**${bonusLabel}`,
          inline: false,
        },
      );
    }

    if (normalizedFeedback) {
      dmEmbed.addFields({
        name: 'Feedback',
        value: truncate(normalizedFeedback, 1024),
        inline: false,
      });
    }

    await author.send({ embeds: [dmEmbed] }).catch(() => null);

    // Notification Dashboard
    await createNotification(
      submission.run.guildId,
      submission.authorId,
      `Retour Daily Algo : ${submission.run.problem.title}`,
      params.action === 'approve'
        ? `Votre soumission a été validée avec une note de ${updateData.scoreFinal}/5, soit ${updateData.pointsAwarded} pts.`
        : params.action === 'dismiss'
          ? `Votre soumission a été jugée hors-sujet (aucune sanction). Motif : ${normalizedFeedback || 'Non spécifié'}`
          : `Votre soumission a été rejetée. Motif : ${normalizedFeedback || 'Non spécifié'}`,
      params.action === 'approve' ? 'SUCCESS' : params.action === 'dismiss' ? 'WARNING' : 'ERROR',
      '/dailyalgo/ide',
      false
    ).catch(() => null);
  }

  // Notation faite depuis Discord comme depuis le panel : le classement de la
  // semaine et la file de validation changent, on prévient les onglets ouverts.
  broadcastDashboardStateChange(submission.run.guildId, 'daily_algo_submission_reviewed');

  return true;
}

// ── Summary (End of Day) ───────────────────────────────────────────────────────

export async function sendDailyAlgoSummaryForGuild(client: Client, guildId: string): Promise<void> {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);

  const runs = await prisma.dailyAlgoRun.findMany({
    where: {
      guildId,
      createdAt: { gte: startOfDay },
      summarySentAt: null,
    },
    select: {
      id: true,
      challengeChannelId: true,
      challengeMessageId: true,
      validationChannelId: true,
      dateKey: true,
      createdAt: true,
      problem: {
        select: { title: true },
      },
      submissions: {
        orderBy: { submittedAt: 'asc' },
      },
    },
  });

  if (runs.length === 0) {
    return;
  }

  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) {
    return;
  }

  const channelId = runs[0]?.challengeChannelId ?? runs[0]?.validationChannelId ?? null;
  if (!channelId) {
    return;
  }

  const channel = await client.channels.fetch(channelId).catch(() => null) as TextChannel | null;
  if (!channel) {
    return;
  }

  const dayLabel = now.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });

  // Aggregate all approved submissions across runs
  const allApproved = runs.flatMap((run) =>
    run.submissions
      .filter((s) => s.status === 'APPROVED' && s.scoreFinal !== null)
      .map((s) => ({
        ...s,
        problemTitle: run.problem.title,
        runDateKey: run.dateKey,
        runCreatedAt: run.createdAt,
      })),
  );

  const allSubmissions = runs.flatMap((run) => run.submissions);
  const totalParticipants = new Set(allSubmissions.map((s) => s.authorId)).size;
  const approvedCount = new Set(allApproved.map((s) => s.authorId)).size;

  // Sort by total score desc
  const ranked = allApproved.sort((a, b) => {
    const pointsA = resolveSubmissionPoints(a);
    const pointsB = resolveSubmissionPoints(b);
    if (pointsB !== pointsA) return pointsB - pointsA;

    const scoreA = a.scoreFinal ?? 0;
    const scoreB = b.scoreFinal ?? 0;
    if (scoreB !== scoreA) return scoreB - scoreA;

    return (a.speedRank ?? 999) - (b.speedRank ?? 999);
  });

  // Deduplicate by author (keep best score)
  const seen = new Set<string>();
  const uniqueRanked = ranked.filter((s) => {
    if (seen.has(s.authorId)) return false;
    seen.add(s.authorId);
    return true;
  });

  const title = `🏁 Bilan du Daily Algo du ${dayLabel}`;

  if (uniqueRanked.length === 0) {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(COLORS.info)
          .setTitle(title)
          .setDescription(`Aucune réponse validée aujourd'hui sur **${totalParticipants}** participant${totalParticipants > 1 ? 's' : ''}.`)
          .setTimestamp()
          .setFooter({ text: 'Kotbo · Daily Algo' }),
      ],
    });
  } else {
    const lines: string[] = [];
    lines.push(`**${approvedCount}** classé${approvedCount > 1 ? 's' : ''} sur **${totalParticipants}** participant${totalParticipants > 1 ? 's' : ''}\n`);

    for (let i = 0; i < uniqueRanked.length; i++) {
      const s = uniqueRanked[i]!;
      const effectiveBonus = resolveEffectiveSpeedBonus(s.speedBonusPoints);
      const totalScore = resolveSubmissionPoints(s);
      const medal = formatRankMedal(i + 1);
      const speedTag = effectiveBonus > 0 ? ` ⚡+${effectiveBonus}` : '';

      // Resolve display name
      const member = await guild.members.fetch(s.authorId).catch(() => null);
      const displayName = member?.displayName ?? s.authorName;

      lines.push(`${medal} **${displayName}** — **${totalScore}** pts${speedTag}`);
      lines.push(`┊ ✅ ${s.scoreCorrectness}/5 · 💬 ${s.scoreComments}/5 · 📦 ${s.scoreCompactness}/5 · ⚡ ${s.scoreOptimization}/5 · 🧹 ${s.scoreReadability}/5`);
      lines.push('');
    }

    const chunks = splitLines(lines, 3500);
    for (const [index, chunk] of chunks.entries()) {
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(COLORS.success)
            .setTitle(chunks.length > 1 ? `${title} (${index + 1}/${chunks.length})` : title)
            .setDescription(chunk)
            .setTimestamp()
            .setFooter({ text: 'Kotbo · Daily Algo' }),
        ],
      });
    }
  }

  await prisma.dailyAlgoRun.updateMany({
    where: {
      id: { in: runs.map((run) => run.id) },
      summarySentAt: null,
    },
    data: { summarySentAt: new Date() },
  });

  for (const run of runs) {
    if (!run.challengeMessageId) {
      continue;
    }

    const challengeChannel = await client.channels.fetch(run.challengeChannelId).catch(() => null) as TextChannel | null;
    if (!challengeChannel) {
      continue;
    }

    const challengeMessage = await challengeChannel.messages.fetch(run.challengeMessageId).catch(() => null);
    if (!challengeMessage) {
      continue;
    }

    await challengeMessage.edit({
      components: [getDailyAlgoButtonRow(run.id, true)],
    }).catch(() => null);
  }

  logger.success('DailyAlgo', `Bilan Daily Algo envoyé pour la guilde ${guildId}`);
}

// ── Summary Cron ───────────────────────────────────────────────────────────────

export async function runDailyAlgoSummariesForAllGuilds(client: Client): Promise<void> {
  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);

  const runs = await prisma.dailyAlgoRun.findMany({
    where: {
      createdAt: { gte: startOfDay },
      summarySentAt: null,
    },
    select: { guildId: true },
    distinct: ['guildId'],
  });

  for (const run of runs) {
    await sendDailyAlgoSummaryForGuild(client, run.guildId).catch((error) =>
      logger.error('DailyAlgo', `Erreur lors du bilan pour la guilde ${run.guildId}:`, error),
    );
  }
}

// ── splitLines utility ─────────────────────────────────────────────────────────

function splitLines(lines: string[], maxLength: number): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const line of lines) {
    const next = current.length === 0 ? line : `${current}\n${line}`;
    if (next.length > maxLength) {
      if (current.length > 0) {
        chunks.push(current);
        current = line;
      } else {
        chunks.push(line.slice(0, maxLength));
        current = '';
      }
    } else {
      current = next;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

async function ensureDailyAlgoRunButtons(client: Client, run: DailyAlgoRunMessageData): Promise<void> {
  const challengeChannel = await client.channels.fetch(run.challengeChannelId).catch(() => null) as TextChannel | null;
  if (!challengeChannel) {
    logger.debug('DailyAlgo', `Canal de challenge ${run.challengeChannelId} introuvable pour le run ${run.id}.`);
    return;
  }

  const canSubmit = isDailyAlgoRunOpenForSubmissions({
    dateKey: run.dateKey,
    createdAt: run.createdAt,
    summarySentAt: run.summarySentAt,
  });

  if (run.challengeMessageId) {
    logger.debug('DailyAlgo', `Mise à jour des boutons du challenge ${run.challengeMessageId} pour le run ${run.id}...`);
    const challengeMessage = await challengeChannel.messages.fetch(run.challengeMessageId).catch(() => null);
    if (challengeMessage) {
      await challengeMessage.edit({
        components: [getDailyAlgoButtonRow(run.id, !canSubmit)],
      }).catch((err) => logger.debug('DailyAlgo', `Erreur edit challenge message: ${err}`));
    }
  }

  if (run.leaderboardMessageId) {
    logger.debug('DailyAlgo', `Mise à jour des boutons du classement ${run.leaderboardMessageId} pour le run ${run.id}...`);
    const leaderboardMessage = await challengeChannel.messages.fetch(run.leaderboardMessageId).catch(() => null);
    if (leaderboardMessage) {
      await leaderboardMessage.edit({
        components: [getDailyAlgoLeaderboardButtonRow(run.id)],
      }).catch((err) => logger.debug('DailyAlgo', `Erreur edit leaderboard message: ${err}`));
    }
  }
}

export async function syncOngoingDailyAlgoButtons(client: Client): Promise<void> {
  const since = new Date();
  since.setDate(since.getDate() - 30);

  const activeRunsRaw = await prisma.dailyAlgoRun.findMany({
    where: {
      challengeMessageId: {
        not: null,
      },
      createdAt: {
        gte: since,
      },
    },
    select: dailyAlgoRunDispatchSelect,
  });

  for (const runRaw of activeRunsRaw) {
    const run = toDailyAlgoRunMessageData(runRaw);
    logger.debug('DailyAlgo', `Synchronisation du run ${run.id} (${run.dateKey ?? 'sans date'})...`);
    await ensureDailyAlgoRunButtons(client, run);
    if (run.leaderboardMessageId) {
      await updateDailyAlgoLeaderboard(client, run.id).catch((error) =>
        logger.warn('DailyAlgo', `Impossible de resynchroniser le leaderboard du run ${run.id}:`, error),
      );
    }
  }

  if (activeRunsRaw.length > 0) {
    logger.info('DailyAlgo', `${activeRunsRaw.length} run(s) synchronisés (soumission active uniquement pour le run du jour).`);
  }
}

// ── Send Daily Algo (dispatch) ─────────────────────────────────────────────────

export async function sendDailyAlgo(client: Client, guildId: string): Promise<DailyAlgoDispatchResult> {
  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
  });

  if (!guild) {
    throw new Error('La guilde Daily Algo est introuvable.');
  }

  if (!guild.dailyAlgoEnabled) {
    throw new Error("Le Daily Algo n'est pas activé pour ce serveur.");
  }

  const channelId = guild.dailyAlgoChannelId;
  if (!channelId) {
    throw new Error("Le salon du Daily Algo n'est pas configuré.");
  }

  const dateKey = getLocalDateKey();

  // Majoration du week-end, déterminée dans le fuseau du serveur : un serveur
  // français ne doit pas voir son samedi commencer à 02:00 du matin.
  const runMultiplier = resolveRunMultiplier({
    date: new Date(),
    timeZone: guild.dailyAlgoTimezone,
    weekendMultiplier: guild.dailyAlgoWeekendMultiplier,
  });
  const runKind = runMultiplier > 1 ? 'WEEKEND' : 'DAILY';

  const existingRunRaw = await prisma.dailyAlgoRun.findFirst({
    where: {
      guildId,
      dateKey,
    },
    select: dailyAlgoRunDispatchSelect,
  });

  const existingRun: DailyAlgoRunMessageData | null = existingRunRaw
    ? toDailyAlgoRunMessageData(existingRunRaw)
    : null;

  if (existingRun?.challengeMessageId) {
    await ensureDailyAlgoRunButtons(client, existingRun);
    logger.info('DailyAlgo', `Daily Algo déjà publié pour ${guildId} le ${dateKey}`);
    return {
      status: 'exists',
      runId: existingRun.id,
      problemTitle: existingRun.problem.title,
      dateKey,
    };
  }

  let run = existingRun;

  if (!run) {
    const problemCandidates = await prisma.dailyAlgoProblem.findMany({
      where: {
        language: 'fr',
        usedAt: null,
      },
      orderBy: [
        { createdAt: 'asc' },
        { id: 'asc' },
      ],
      select: {
        id: true,
        title: true,
        description: true,
      },
    });

    if (problemCandidates.length === 0) {
      throw new Error('Aucun Daily Algo disponible. Ajoute de nouveaux problèmes dans la base.');
    }

    const recentRuns = await prisma.dailyAlgoRun.findMany({
      where: { guildId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        problem: {
          select: {
            title: true,
            description: true,
          },
        },
      },
    });

    const recentTypes = recentRuns.map((recentRun) => detectChallengeTypeKey(recentRun.problem.title, recentRun.problem.description));

    const orderedCandidates: Array<{ id: string; title: string; description: string }> = [];
    const firstCandidate = pickProblemCandidateWithVariety({
      candidates: problemCandidates,
      recentTypeKeys: recentTypes,
    });

    if (firstCandidate) {
      orderedCandidates.push(firstCandidate);
    }

    for (const candidate of problemCandidates) {
      if (firstCandidate && candidate.id === firstCandidate.id) {
        continue;
      }
      orderedCandidates.push(candidate);
    }

    for (const candidate of orderedCandidates) {
      try {
        const createdRunRaw = await prisma.$transaction(async (tx) => {
          const createdRun = await tx.dailyAlgoRun.create({
            data: {
              guildId: guild.id,
              dateKey,
              problemId: candidate.id,
              challengeChannelId: channelId,
              validationChannelId: guild.dailyAlgoValidationChannelId ?? null,
              kind: runKind,
              // Figé au tirage : ajuster le réglage plus tard ne réécrit pas les
              // points déjà attribués sur ce run.
              pointsMultiplier: runMultiplier,
            },
            select: dailyAlgoRunDispatchSelect,
          });

          const reservedProblem = await tx.dailyAlgoProblem.updateMany({
            where: {
              id: candidate.id,
              usedAt: null,
            },
            data: {
              usedAt: new Date(),
            },
          });

          if (reservedProblem.count === 0) {
            throw new Error('Le problème Daily Algo a déjà été utilisé.');
          }

          return createdRun;
        });

        const createdRun = toDailyAlgoRunMessageData(createdRunRaw);

        run = createdRun;

        break;
      } catch (error) {
        logger.warn('DailyAlgo', `Impossible de réserver le problème ${candidate.id}, nouvel essai...`, error);

        const currentRunRaw = await prisma.dailyAlgoRun.findFirst({
          where: {
            guildId,
            dateKey,
          },
          select: dailyAlgoRunDispatchSelect,
        });

        const currentRun: DailyAlgoRunMessageData | null = currentRunRaw
          ? toDailyAlgoRunMessageData(currentRunRaw)
          : null;
        if (currentRun) {
          run = currentRun;
          break;
        }
      }
    }

    if (!run) {
      throw new Error('Impossible de réserver un Daily Algo disponible.');
    }
  }

  if (!run.challengeMessageId) {
    const message = await sendDailyAlgoRunMessage(client, run);

    await prisma.dailyAlgoRun.update({
      where: { id: run.id },
      data: { challengeMessageId: message.id },
    });

    logger.success('DailyAlgo', `Daily Algo envoyé pour la guilde ${guildId}`);

    return {
      status: existingRun ? 'resent' : 'created',
      runId: run.id,
      problemTitle: run.problem.title,
      dateKey,
    };
  }

  return {
    status: 'exists',
    runId: run.id,
    problemTitle: run.problem.title,
    dateKey,
  };
}
export async function runDailyAlgoForAllGuilds(client: Client): Promise<void> {
  const now = new Date();
  const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const allGuilds = await prisma.guild.findMany({
    where: { dailyAlgoEnabled: true },
  });

  logger.debug('DailyAlgo', `${allGuilds.length} guilds avec daily algo activé`);

  const matchingGuilds = allGuilds.filter((guild) => {
    const normalizedTime = normalizeTime(guild.dailyAlgoTime);
    return normalizedTime === currentTime;
  });

  if (matchingGuilds.length > 0) {
    logger.info('DailyAlgo', `${matchingGuilds.length} guild(s) à ${currentTime}`);
  }

  for (const guild of matchingGuilds) {
    await sendDailyAlgo(client, guild.id).catch((e) =>
      logger.error('DailyAlgo', `Error for guild ${guild.id}:`, e),
    );
  }
}

function normalizeTime(time: string): string {
  if (/^([0-1][0-9]|2[0-3]):[0-5][0-9]$/.test(time)) {
    return time;
  }
  
  if (/^[0-9]:[0-5][0-9]$/.test(time)) {
    return '0' + time;
  }
  
  logger.warn('DailyAlgo', `Format d'heure invalide: "${time}", utilisant la valeur par défaut "09:00"`);
  return '09:00';
}


