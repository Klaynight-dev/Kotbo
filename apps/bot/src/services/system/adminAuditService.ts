/**
 * Journal des actions sensibles de la console admin globale.
 *
 * Les endpoints `/api/admin/*` agissent sur l'ensemble des serveurs (depart
 * force, redemarrage de shard, broadcast, blacklist...). Sans trace horodatee
 * nommant l'auteur, une action destructrice est indistinguable d'un bug.
 */
import type { IncomingMessage } from 'node:http';
import type { Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

export type AdminAuditOutcome = 'OK' | 'FAILED';

export interface AdminAuditEntry {
  actorId: string;
  actorName?: string | null;
  /** Identifiant stable en `domaine.action`, ex: `broadcast.send`. */
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  summary: string;
  metadata?: Prisma.InputJsonValue | null;
  outcome?: AdminAuditOutcome;
  ip?: string | null;
}

/**
 * Extrait l'IP appelante en tenant compte du reverse proxy nginx place devant
 * l'API en production.
 */
export function resolveRequestIp(req: IncomingMessage): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0].split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? null;
}

/**
 * Ecrit une entree d'audit. Volontairement non bloquant : un incident sur la
 * table de journal ne doit jamais empecher l'action d'aboutir ni renvoyer une
 * erreur a l'admin.
 */
export async function recordAdminAudit(entry: AdminAuditEntry): Promise<void> {
  try {
    await prisma.adminAuditLog.create({
      data: {
        actorId: entry.actorId,
        actorName: entry.actorName ?? null,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        summary: entry.summary.slice(0, 500),
        metadata: entry.metadata ?? undefined,
        outcome: entry.outcome ?? 'OK',
        ip: entry.ip ?? null,
      },
    });
  } catch (err) {
    logger.warn('AdminAudit', `Ecriture du journal impossible (${entry.action}): ${(err as Error).message}`);
  }
}

export interface AdminAuditQuery {
  action?: string;
  actorId?: string;
  targetId?: string;
  outcome?: AdminAuditOutcome;
  search?: string;
  since?: Date;
  limit?: number;
  cursor?: string;
}

export async function listAdminAudit(query: AdminAuditQuery) {
  const where: Prisma.AdminAuditLogWhereInput = {};
  if (query.action) where.action = query.action;
  if (query.actorId) where.actorId = query.actorId;
  if (query.targetId) where.targetId = query.targetId;
  if (query.outcome) where.outcome = query.outcome;
  if (query.since) where.createdAt = { gte: query.since };
  if (query.search) {
    where.OR = [
      { summary: { contains: query.search, mode: 'insensitive' } },
      { action: { contains: query.search, mode: 'insensitive' } },
      { actorName: { contains: query.search, mode: 'insensitive' } },
      { targetId: { contains: query.search } },
    ];
  }

  const take = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const rows = await prisma.adminAuditLog.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: take + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  });

  const hasMore = rows.length > take;
  const page = hasMore ? rows.slice(0, take) : rows;

  return {
    entries: page.map((row) => ({
      id: row.id,
      actorId: row.actorId,
      actorName: row.actorName,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      summary: row.summary,
      metadata: row.metadata,
      outcome: row.outcome,
      ip: row.ip,
      createdAt: row.createdAt.toISOString(),
    })),
    nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
  };
}

/** Actions distinctes presentes en base, pour alimenter le filtre du dashboard. */
export async function listAdminAuditActions(): Promise<{ action: string; count: number }[]> {
  const grouped = await prisma.adminAuditLog.groupBy({
    by: ['action'],
    _count: { action: true },
    orderBy: { _count: { action: 'desc' } },
    take: 60,
  });
  return grouped.map((row) => ({ action: row.action, count: row._count.action }));
}
