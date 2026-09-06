import prisma from './db.js';
import { logger } from './logger.js';
import { broadcastDashboardStateChange } from '../api/shared/sharding.js';

export interface AuditLogInput {
  guildId: string;
  channelId?: string | null;
  user: string;
  action: string;
  context: string;
  module: string;
  eventType: string;
  details: string;
  dateIso?: Date;
}

let auditLogQueue: AuditLogInput[] = [];
let flushTimeout: NodeJS.Timeout | null = null;

export function queueAuditLog(log: AuditLogInput): void {
  auditLogQueue.push(log);
  if (auditLogQueue.length >= 50) {
    void flushAuditLogs();
  } else if (!flushTimeout) {
    flushTimeout = setTimeout(() => {
      void flushAuditLogs();
    }, 5000);
  }
}

export async function flushAuditLogs(): Promise<void> {
  if (flushTimeout) {
    clearTimeout(flushTimeout);
    flushTimeout = null;
  }

  const logsToInsert = [...auditLogQueue];
  auditLogQueue = [];

  if (logsToInsert.length === 0) return;

  try {
    await prisma.dashboardAuditLog.createMany({
      data: logsToInsert.map(log => ({
        guildId: log.guildId,
        channelId: log.channelId ?? null,
        user: log.user,
        action: log.action,
        context: log.context,
        module: log.module,
        eventType: log.eventType,
        details: log.details,
        dateIso: log.dateIso ?? new Date(),
      })),
    });

    const affectedGuilds = new Set(logsToInsert.map(log => log.guildId).filter(Boolean));
    for (const guildId of affectedGuilds) {
      broadcastDashboardStateChange(guildId, 'audit_logs_updated');
    }
  } catch (error) {
    logger.error('AuditLogger', "Erreur lors du flush des logs d'audit en BDD", error);
  }
}

process.on('beforeExit', () => {
  void flushAuditLogs();
});
