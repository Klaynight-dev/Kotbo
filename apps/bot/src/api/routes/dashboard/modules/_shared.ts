/**
 * Contexte et helpers partages par les sous-routeurs de `modules/`.
 *
 * Extraits de modules.ts, ou ils precedaient une fonction de ~5900 lignes.
 */
import prisma from '../../../../utils/db.js';
import { type CommandAccessLevel, type DashboardPresetKey, parseDiscordMarkdown, type SeverityLevel } from '../../../shared.js';
import { SanctionType } from '@prisma/client';
import { type Embed, type Guild } from 'discord.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Client } from 'discord.js';
import type { AuthClaims, DashboardAccess } from '../../../shared.js';

/** Tout ce qu un sous-routeur recoit du repartiteur. */
export type ModuleRouteContext = {
  req: IncomingMessage;
  res: ServerResponse;
  parts: string[];
  url: URL;
  client: Client;
  user: AuthClaims;
  guildId: string;
  access: DashboardAccess;
  method: string | undefined;
  auditUser: string;
  moduleKey: string | undefined;
};

export const PRESET_LABELS: Record<DashboardPresetKey, string> = {
  general: 'Communauté générale',
  gaming: 'Gaming/Esport',
  dev: 'Dev/Tech',
};

export const PRESET_COMMAND_OVERRIDES: Record<DashboardPresetKey, Partial<Record<string, CommandAccessLevel>>> = {
  general: {},
  gaming: {},
  dev: { dailyAlgo: 'tout_le_monde' },
};

export const _DEFAULT_SEVERITY_BY_MODULE = [
  { module: 'auth', level: 'info' as SeverityLevel },
  { module: 'moderation', level: 'attention' as SeverityLevel },
  { module: 'tickets', level: 'info' as SeverityLevel },
  { module: 'system', level: 'critique' as SeverityLevel }
];

export const _DEFAULT_MESSAGE_TEMPLATE = 'Bonjour {user}, ...';

export function resolveDailyAlgoFinalScore(submission: {
  scoreFinal: number | null;
  scoreCorrectness: number | null;
  scoreComments: number | null;
  scoreCompactness: number | null;
  scoreOptimization: number | null;
  scoreReadability: number | null;
}): number | null {
  if (submission.scoreFinal !== null) {
    return submission.scoreFinal;
  }

  const components = [
    submission.scoreCorrectness,
    submission.scoreComments,
    submission.scoreCompactness,
    submission.scoreOptimization,
    submission.scoreReadability,
  ];

  if (components.some((value) => value === null)) {
    return null;
  }

  const sum = (components as number[]).reduce((acc, value) => acc + value, 0);
  return Math.round((sum / 5) * 10) / 10;
}

export function getDailyAlgoDateKeyWithOffset(offsetDays: number, baseDate = new Date()): string {
  const anchor = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate()));
  anchor.setUTCDate(anchor.getUTCDate() + offsetDays);

  const year = anchor.getUTCFullYear();
  const month = String(anchor.getUTCMonth() + 1).padStart(2, '0');
  const day = String(anchor.getUTCDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

export async function getDailyAlgoScheduleRuns(guildId: string, daysBack: number, daysForward: number) {
  const safeDaysBack = Math.max(0, Math.trunc(daysBack));
  const safeDaysForward = Math.max(0, Math.trunc(daysForward));
  const startDateKey = getDailyAlgoDateKeyWithOffset(-safeDaysBack);
  const endDateKey = getDailyAlgoDateKeyWithOffset(safeDaysForward);

  const runs = await prisma.dailyAlgoRun.findMany({
    where: {
      guildId,
      dateKey: {
        gte: startDateKey,
        lte: endDateKey,
      },
    },
    include: {
      problem: true,
      _count: {
        select: {
          submissions: true,
        },
      },
    },
    orderBy: {
      dateKey: 'asc',
    },
  });

  return runs.map((run) => ({
    id: run.id,
    guildId: run.guildId,
    dateKey: run.dateKey,
    problemId: run.problemId,
    challengeChannelId: run.challengeChannelId,
    validationChannelId: run.validationChannelId,
    challengeMessageId: run.challengeMessageId,
    leaderboardMessageId: run.leaderboardMessageId,
    summarySentAt: run.summarySentAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    submissionsCount: run._count.submissions,
    problem: {
      id: run.problem.id,
      title: run.problem.title,
      description: run.problem.description,
      solution: run.problem.solution,
      difficulty: run.problem.difficulty,
      language: run.problem.language,
      functionName: run.problem.functionName,
      functionArgs: run.problem.functionArgs,
      unitTests: run.problem.unitTests,
      allowedLanguages: run.problem.allowedLanguages,
      usedAt: run.problem.usedAt?.toISOString() ?? null,
      createdAt: run.problem.createdAt.toISOString(),
      updatedAt: run.problem.updatedAt.toISOString(),
    },
  }));
}

export async function ensureDailyAlgoScheduleRuns(guildId: string, daysForward: number) {
  const safeDaysForward = Math.max(1, Math.trunc(daysForward));
  const guild = await prisma.guild.findUnique({
    where: { id: guildId },
    select: {
      id: true,
      dailyAlgoChannelId: true,
      dailyAlgoValidationChannelId: true,
    },
  });

  if (!guild) {
    throw new Error('Guilde introuvable.');
  }

  if (!guild.dailyAlgoChannelId) {
    return {
      createdDateKeys: [],
      createdCount: 0,
    };
  }

  const createdDateKeys: string[] = [];

  for (let offsetDays = 0; offsetDays <= safeDaysForward; offsetDays += 1) {
    const dateKey = getDailyAlgoDateKeyWithOffset(offsetDays);
    const existingRun = await prisma.dailyAlgoRun.findUnique({
      where: {
        guildId_dateKey: {
          guildId,
          dateKey,
        },
      },
    });

    if (existingRun) {
      continue;
    }

    const existingRunForDate = await prisma.dailyAlgoRun.findFirst({
      where: { dateKey },
      select: { problemId: true }
    });

    let problemId = existingRunForDate?.problemId;

    if (!problemId) {
      const problemCandidate = await prisma.dailyAlgoProblem.findFirst({
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
        },
      });

      if (!problemCandidate) {
        break;
      }
      problemId = problemCandidate.id;

      await prisma.dailyAlgoProblem.update({
        where: { id: problemId },
        data: { usedAt: new Date() }
      });
    }

    await prisma.dailyAlgoRun.create({
      data: {
        guildId,
        dateKey,
        problemId: problemId,
        challengeChannelId: guild.dailyAlgoChannelId!,
        validationChannelId: guild.dailyAlgoValidationChannelId ?? null,
      },
    });

    createdDateKeys.push(dateKey);
  }

  return {
    createdDateKeys,
    createdCount: createdDateKeys.length,
  };
}

export type DashboardSanctionType = 'WARN' | 'KICK' | 'TIMEOUT' | 'TEMP_BAN' | 'BAN' | 'SOFTBAN';

export function toSanctionType(value: DashboardSanctionType): SanctionType {
  return value as SanctionType;
}

export function normalizeBrokenRulesPayload(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';

  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      return trimmed;
    }

    const normalized = parsed
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return null;

        const snapshot = entry as Record<string, unknown>;
        const id = typeof snapshot.id === 'string' ? snapshot.id.trim() : '';
        if (!id) return null;

        const title = typeof snapshot.title === 'string'
          ? snapshot.title.trim()
          : typeof snapshot.label === 'string'
            ? snapshot.label.trim()
            : '';

        const description = typeof snapshot.description === 'string'
          ? snapshot.description.trim()
          : typeof snapshot.details === 'string'
            ? snapshot.details.trim()
            : '';

        if (!title || !description) return null;

        const emoji = typeof snapshot.emoji === 'string' && snapshot.emoji.trim() ? snapshot.emoji.trim() : null;
        const sortOrder = typeof snapshot.sortOrder === 'number' && Number.isFinite(snapshot.sortOrder) ? snapshot.sortOrder : 0;

        return {
          id,
          title,
          description,
          emoji,
          sortOrder,
        };
      })
      .filter((entry): entry is { id: string; title: string; description: string; emoji: string | null; sortOrder: number } => !!entry);

    return normalized.length > 0 ? JSON.stringify(normalized) : trimmed;
  } catch {
    return trimmed;
  }
}

export const buildModuleUpdatesForPreset = (presetKey: DashboardPresetKey) => {
  if (presetKey === 'dev') {
    return {
      dailyAlgoEnabled: true,
      codePoliceEnabled: false,
      autoNicknameModerationEnabled: false,
      sanctionSyncEnabled: false,
      translationEnabled: false,
    };
  }
  if (presetKey === 'gaming') {
    return {
      dailyAlgoEnabled: false,
      codePoliceEnabled: true,
      autoNicknameModerationEnabled: true,
      sanctionSyncEnabled: true,
      translationEnabled: true,
    };
  }
  return {
    dailyAlgoEnabled: false,
    codePoliceEnabled: false,
    autoNicknameModerationEnabled: true,
    sanctionSyncEnabled: false,
    translationEnabled: true,
  };
};

// Le builder canonique (et type) vit dans shared/core.ts. En garder une copie
// ici avait fini par produire une forme de regle que
// `normalizeCommandRestrictions` ne relisait pas.
export { buildCommandRestrictionsForPreset } from '../../../shared.js';

/**
 * Verifie la signature binaire (magic bytes) d un fichier televerse, pour ne
 * pas se fier au seul mimeType annonce par le client.
 *
 * Etait declaree au milieu du corps de handleModulesRoutes, en colonne 0.
 */
export function verifyMagicBytes(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  }
  if (mimeType === 'image/gif') {
    return buffer.length >= 4 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38;
  }
  if (mimeType === 'image/webp') {
    return buffer.length >= 12 &&
           buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 && // RIFF
           buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50; // WEBP
  }
  if (mimeType === 'application/pdf') {
    return buffer.length >= 4 && buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46; // %PDF
  }
  if (mimeType === 'video/mp4') {
    return buffer.length >= 8 && buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70; // ftyp
  }
  if (mimeType === 'video/webm') {
    return buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3; // EBML
  }
  if (mimeType === 'video/quicktime') {
    return buffer.length >= 8 && (
      (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) || // ftyp
      (buffer[4] === 0x6d && buffer[5] === 0x6f && buffer[6] === 0x6f && buffer[7] === 0x76) || // moov
      (buffer[4] === 0x6d && buffer[5] === 0x64 && buffer[6] === 0x61 && buffer[7] === 0x74)    // mdat
    );
  }
  return false;
}

export function msgEmbedsMap(embeds: Embed[], guild: Guild | null) {
  return embeds.map(e => ({
    title: e.title,
    description: e.description,
    htmlDescription: e.description ? parseDiscordMarkdown(e.description, guild) : '',
    color: e.hexColor,
    fields: e.fields ? e.fields.map((f) => ({
      name: f.name,
      value: f.value,
      htmlValue: f.value ? parseDiscordMarkdown(f.value, guild) : ''
    })) : [],
    image: e.image ? { url: e.image.url } : null,
    thumbnail: e.thumbnail ? { url: e.thumbnail.url } : null,
    video: e.video ? { url: e.video.url } : null
  }));
}
