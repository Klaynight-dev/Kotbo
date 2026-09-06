import { Client, EmbedBuilder, type ColorResolvable, type Guild } from 'discord.js';
import cron from 'node-cron';
import { ScheduledTask } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

const activeCronJobs = new Map<string, cron.ScheduledTask>();

export async function initializeScheduler(client: Client): Promise<void> {
  logger.info('Scheduler', 'Initialisation du service de planification...');
  
  // Arrêter proprement les tâches existantes
  for (const job of activeCronJobs.values()) {
    job.stop();
  }
  activeCronJobs.clear();

  try {
    const activeTasks = await prisma.scheduledTask.findMany({
      where: { enabled: true }
    });

    logger.info('Scheduler', `${activeTasks.length} tâche(s) planifiée(s) active(s) trouvée(s).`);

    for (const task of activeTasks) {
      await startSchedule(client, task);
    }
  } catch (error) {
    logger.error('Scheduler', "Erreur lors de l'initialisation du planificateur:", error);
  }
}

export async function startSchedule(client: Client, task: ScheduledTask): Promise<void> {
  // Arrêter l'ancienne planification si elle existe déjà
  if (activeCronJobs.has(task.id)) {
    activeCronJobs.get(task.id)!.stop();
    activeCronJobs.delete(task.id);
  }

  if (!task.enabled) return;

  // Valider l'expression cron
  if (!cron.validate(task.cron)) {
    logger.error('Scheduler', `Expression cron invalide "${task.cron}" pour la tâche "${task.name}" (${task.id})`);
    return;
  }

  try {
    const job = cron.schedule(task.cron, async () => {
      try {
        await executeSchedule(client, task.id);
      } catch (err) {
        logger.error('Scheduler', `Erreur lors de l'exécution automatique de la tâche ${task.id}:`, err);
      }
    });

    activeCronJobs.set(task.id, job);
    logger.info('Scheduler', `Tâche "${task.name}" (${task.id}) planifiée avec le motif : "${task.cron}"`);
  } catch (error) {
    logger.error('Scheduler', `Impossible de planifier la tâche ${task.id}:`, error);
  }
}

export function stopSchedule(scheduleId: string): void {
  if (activeCronJobs.has(scheduleId)) {
    activeCronJobs.get(scheduleId)!.stop();
    activeCronJobs.delete(scheduleId);
    logger.info('Scheduler', `Tâche planifiée arrêtée et retirée de la mémoire : ${scheduleId}`);
  }
}

export async function reloadSchedule(client: Client, scheduleId: string): Promise<void> {
  stopSchedule(scheduleId);
  
  const task = await prisma.scheduledTask.findUnique({
    where: { id: scheduleId }
  });

  if (task && task.enabled) {
    await startSchedule(client, task);
  }
}

/** Forme attendue de `messageEmbed`. Tout champ absent est simplement ignore. */
type ScheduledEmbed = {
  title?: unknown;
  description?: unknown;
  color?: unknown;
  imageUrl?: unknown;
};

/**
 * Poste le message d'une tache `SEND_MESSAGE` dans son salon cible.
 *
 * Les mentions sont coupees par defaut : une tache qui se repete chaque jour ne
 * doit pas pouvoir pinger tout le serveur parce que quelqu'un a colle un
 * `@everyone` dans le texte. `allowMentions` reouvre la porte volontairement.
 */
async function sendScheduledMessage(guild: Guild, schedule: ScheduledTask): Promise<void> {
  if (!schedule.targetId) throw new Error('Salon de destination manquant pour le message programmé');

  const channel = await guild.channels.fetch(schedule.targetId).catch(() => null);
  if (!channel) throw new Error(`Salon de destination ${schedule.targetId} non trouvé`);
  if (!channel.isTextBased()) throw new Error(`Le salon ${schedule.targetId} doit être un salon textuel`);

  const content = schedule.message?.trim() || undefined;
  const raw = (schedule.messageEmbed ?? null) as ScheduledEmbed | null;

  const embeds: EmbedBuilder[] = [];
  if (raw && typeof raw === 'object') {
    const embed = new EmbedBuilder();
    let filled = false;

    if (typeof raw.title === 'string' && raw.title.trim()) {
      embed.setTitle(raw.title.trim().slice(0, 256));
      filled = true;
    }
    if (typeof raw.description === 'string' && raw.description.trim()) {
      embed.setDescription(raw.description.trim().slice(0, 4096));
      filled = true;
    }
    if (typeof raw.imageUrl === 'string' && /^https:\/\//.test(raw.imageUrl)) {
      embed.setImage(raw.imageUrl);
      filled = true;
    }
    if (typeof raw.color === 'string' && /^#[0-9a-f]{6}$/i.test(raw.color)) {
      embed.setColor(raw.color as ColorResolvable);
    }

    if (filled) embeds.push(embed);
  }

  if (!content && embeds.length === 0) {
    throw new Error('Le message programmé est vide : ni texte ni embed');
  }

  await channel.send({
    content,
    embeds,
    allowedMentions: schedule.allowMentions ? undefined : { parse: [] },
  });
}

export async function executeSchedule(client: Client, scheduleId: string): Promise<void> {
  const schedule = await prisma.scheduledTask.findUnique({
    where: { id: scheduleId }
  });
  
  if (!schedule) return;

  const guild = client.guilds.cache.get(schedule.guildId) || await client.guilds.fetch(schedule.guildId).catch(() => null);
  if (!guild) {
    logger.warn('Scheduler', `Serveur ${schedule.guildId} introuvable pour la tâche planifiée ${schedule.id}`);
    return;
  }

  logger.info('Scheduler', `Début d'exécution de la tâche "${schedule.name}" (${schedule.type}) pour le serveur "${guild.name}"`);

  try {
    if (schedule.type === 'CHANNEL_RESET') {
      if (!schedule.targetId) throw new Error("ID du salon cible manquant pour la réinitialisation");
      const channel = await guild.channels.fetch(schedule.targetId).catch(() => null);
      if (!channel) throw new Error(`Salon cible ${schedule.targetId} non trouvé`);

      if (channel.isThread()) {
        throw new Error(`La réinitialisation de salons de type thread n'est pas supportée (salon ${channel.id})`);
      }
      
      const newChannel = await channel.clone({
        reason: `Réinitialisation planifiée : ${schedule.name}`
      });
      await channel.delete(`Réinitialisation planifiée : ${schedule.name}`);
      
      if (newChannel.isTextBased()) {
        await newChannel.send({
          content: `🔄 **Ce salon a été réinitialisé automatiquement par Kotbo.**\n*Nom de la tâche : ${schedule.name}*`
        }).catch(() => null);
      }
    } else if (schedule.type === 'SERVER_BACKUP') {
      const { createBackup } = await import('./backupService.js');
      const backupOptions = {
        name: schedule.name,
        description: `Sauvegarde planifiée automatique (${schedule.cron})`,
        includeMessages: false,
        includeMembers: true,
        includeRoles: true,
        includeChannels: true,
        includeEmojis: true,
        includeStickers: true,
        createdByUserId: client.user!.id,
        createdByUsername: client.user!.username,
        createdByTag: '0000',
      };
      await createBackup(guild, backupOptions);
    } else if (schedule.type === 'DATA_EXPORT') {
      if (!schedule.targetId) throw new Error("ID du salon cible manquant pour l'export");
      const channel = await guild.channels.fetch(schedule.targetId).catch(() => null);
      if (!channel) throw new Error(`Salon de destination ${schedule.targetId} non trouvé`);
      if (!channel.isTextBased()) throw new Error(`Le salon de destination ${schedule.targetId} doit être un salon textuel`);

      // Récupérer les données de la guilde depuis la DB
      const memberProfiles = await prisma.memberProfile.findMany({ where: { guildId: guild.id } });
      const sanctions = await prisma.sanction.findMany({ where: { guildId: guild.id } });
      const tickets = await prisma.ticket.findMany({ where: { guildId: guild.id } });
      const suggestions = await prisma.suggestion.findMany({ where: { guildId: guild.id } });
      const memberLevels = await prisma.memberLevel.findMany({ where: { guildId: guild.id } });

      const exportData = {
        exportDate: new Date().toISOString(),
        guildId: guild.id,
        guildName: guild.name,
        stats: {
          membersCount: memberProfiles.length,
          sanctionsCount: sanctions.length,
          ticketsCount: tickets.length,
          suggestionsCount: suggestions.length,
          levelsCount: memberLevels.length,
        },
        data: {
          memberProfiles,
          sanctions,
          tickets,
          suggestions,
          memberLevels,
        }
      };

      const buffer = Buffer.from(JSON.stringify(exportData, null, 2), 'utf-8');
      await channel.send({
        content: `📦 **Export automatique des données complété !**\n*Planification : ${schedule.name}*`,
        files: [{
          attachment: buffer,
          name: `kotbo_export_${guild.id}_${Date.now()}.json`
        }]
      });
    } else if (schedule.type === 'SEND_MESSAGE') {
      await sendScheduledMessage(guild, schedule);
    } else {
      throw new Error(`Type de tâche planifiée inconnu : ${schedule.type}`);
    }

    // Une tâche à usage unique s'éteint dès qu'elle a servi : son expression
    // cron désigne une date précise, elle se redéclencherait sinon l'an prochain.
    await prisma.scheduledTask.update({
      where: { id: scheduleId },
      data: { lastRun: new Date(), ...(schedule.runOnce ? { enabled: false } : {}) }
    });

    if (schedule.runOnce) stopSchedule(scheduleId);

    logger.info('Scheduler', `Tâche "${schedule.name}" exécutée avec succès`);
  } catch (error) {
    logger.error('Scheduler', `Erreur lors de l'exécution de la tâche planifiée ${schedule.id}:`, error);
    throw error;
  }
}
