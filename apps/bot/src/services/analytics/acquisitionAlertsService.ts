/**
 * acquisitionAlertsService.ts
 *
 * Surveillance automatique du tunnel d'acquisition et alertes Discord :
 *   - Détection proactive des risques commerciaux :
 *     * Churn mensuel supérieur au seuil configuré.
 *     * Impayés récents (abonnements Stripe 'past_due').
 *     * Résiliation / départ d'un serveur d'envergure (>= N membres).
 *     * Essais expirant sous 48 h sans moyen de paiement.
 *     * Chute anormale des arrivées sur 7 jours glissants (> 40%).
 *   - Récapitulatif hebdomadaire automatique (lundi matin) des KPIs clés
 *     (MRR, encaissement, arrivées/départs net, conversions, top canaux).
 *   - Anti-répétition : mémorisation des alertes émises dans
 *     `acquisition_alert_states` pour ne jamais spammer les administrateurs.
 */

import type { Client } from 'discord.js';
import { EmbedBuilder } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getAlertThresholds } from './adminAnalyticsService.js';
import { getDashboardOrigin } from '../../api/shared/core.js';

// Couleurs standardisées Kotbo
const COLOR_CRITICAL = 0xED4245; // Rouge vif
const COLOR_WARNING = 0xFEE75C;  // Jaune avertissement
const COLOR_INFO = 0x5865F2;     // Indigo Discord
const COLOR_SUCCESS = 0x57F287;  // Vert succès

/**
 * Transmet un embed d'alerte à tous les administrateurs globaux et au propriétaire.
 */
export async function notifyBotAdmins(client: Client, embed: EmbedBuilder): Promise<number> {
  const ownerId = process.env.DISCORD_CLIENT_OWNER_ID;
  const adminsFromDb = await prisma.globalAdmin.findMany({
    select: { userId: true },
  }).catch(() => []);

  const recipientIds = new Set<string>();
  if (ownerId) recipientIds.add(ownerId);
  for (const admin of adminsFromDb) {
    recipientIds.add(admin.userId);
  }

  if (recipientIds.size === 0) {
    logger.warn('AcquisitionAlerts', 'Aucun administrateur configuré pour recevoir les alertes.');
    return 0;
  }

  let sent = 0;
  for (const adminId of recipientIds) {
    try {
      const user = await client.users.fetch(adminId).catch(() => null);
      if (user) {
        await user.send({ embeds: [embed] });
        sent++;
      }
    } catch (err) {
      logger.warn('AcquisitionAlerts', `Échec d'envoi d'alerte à l'administrateur ${adminId}:`, err);
    }
  }

  return sent;
}

/**
 * Balayage périodique des alertes du tunnel d'acquisition et des risques commerciaux.
 */
export async function runAcquisitionAlertsCheck(client: Client): Promise<void> {
  logger.debug('AcquisitionAlerts', 'Vérification des alertes d\'acquisition et de facturation...');
  const { thresholds } = await getAlertThresholds();
  const dashboard = getDashboardOrigin();
  const now = new Date();

  // ─────────────────────────────────────────────────────────────
  // 1. Alerte : Abonnements impayés (past_due)
  // ─────────────────────────────────────────────────────────────
  try {
    const pastDueGuilds = await prisma.guild.findMany({
      where: {
        stripeSubscriptionStatus: 'past_due',
      },
      select: {
        id: true,
        plan: true,
        billingOwnerId: true,
        stripeSubscriptionId: true,
      },
    }).catch(() => []);

    for (const g of pastDueGuilds) {
      const alertKey = `alert:past_due:${g.id}`;
      const existing = await prisma.acquisitionAlertState.findUnique({
        where: { key: alertKey },
      }).catch(() => null);

      // Alerte au maximum une fois tous les 5 jours pour le même impayé
      if (existing && (now.getTime() - existing.lastFiredAt.getTime()) < 5 * 24 * 3600 * 1000) {
        continue;
      }

      const guildName = client.guilds.cache.get(g.id)?.name ?? `Serveur ${g.id}`;
      const embed = new EmbedBuilder()
        .setTitle('🚨 Alerte Facturation : Abonnement impayé')
        .setColor(COLOR_CRITICAL)
        .setDescription(`Le serveur **${guildName}** (\`${g.id}\`) est en statut **past_due** (échec de prélèvement Stripe).`)
        .addFields(
          { name: 'Offre', value: `\`${g.plan}\``, inline: true },
          { name: 'Payeur', value: g.billingOwnerId ? `<@${g.billingOwnerId}>` : 'Non renseigné', inline: true },
          { name: 'Action recommandée', value: `Consulter la fiche serveur sur [le Dashboard Kotbo](${dashboard}/admin/billing).`, inline: false },
        )
        .setTimestamp();

      const delivered = await notifyBotAdmins(client, embed);
      if (delivered > 0) {
        await prisma.acquisitionAlertState.upsert({
          where: { key: alertKey },
          update: { lastFiredAt: now },
          create: { key: alertKey, lastFiredAt: now },
        }).catch(() => null);
        logger.info('AcquisitionAlerts', `Alerte impayé envoyée pour le serveur ${g.id}.`);
      }
    }
  } catch (err) {
    logger.error('AcquisitionAlerts', 'Erreur lors de la vérification des impayés:', err);
  }

  // ─────────────────────────────────────────────────────────────
  // 2. Alerte : Churn d'un serveur d'envergure (>= largeServerChurnMembers)
  // ─────────────────────────────────────────────────────────────
  try {
    const minMembers = thresholds.largeServerChurnMembers || 1000;
    const recentChurns = await prisma.guildLifecycle.findMany({
      where: {
        churnedAt: {
          gte: new Date(now.getTime() - 24 * 3600 * 1000), // Dernières 24h
        },
        memberCount: {
          gte: minMembers,
        },
      },
      select: {
        guildId: true,
        memberCount: true,
        plan: true,
        churnReason: true,
        churnedAt: true,
      },
    }).catch(() => []);

    for (const c of recentChurns) {
      const alertKey = `alert:large_churn:${c.guildId}`;
      const existing = await prisma.acquisitionAlertState.findUnique({
        where: { key: alertKey },
      }).catch(() => null);

      if (existing) continue;

      const guildName = client.guilds.cache.get(c.guildId)?.name ?? `Serveur ${c.guildId}`;
      const embed = new EmbedBuilder()
        .setTitle('📉 Alerte Churn : Départ d\'un grand serveur')
        .setColor(COLOR_WARNING)
        .setDescription(`Le serveur **${guildName}** (\`${c.guildId}\`) de **${c.memberCount} membres** a quitté Kotbo ou résilié son offre.`)
        .addFields(
          { name: 'Ancienne offre', value: `\`${c.plan}\``, inline: true },
          { name: 'Membres', value: `${c.memberCount}`, inline: true },
          { name: 'Raison enregistrée', value: c.churnReason ?? 'Non spécifiée', inline: true },
        )
        .setTimestamp();

      const delivered = await notifyBotAdmins(client, embed);
      if (delivered > 0) {
        await prisma.acquisitionAlertState.upsert({
          where: { key: alertKey },
          update: { lastFiredAt: now, lastValue: c.memberCount },
          create: { key: alertKey, lastFiredAt: now, lastValue: c.memberCount },
        }).catch(() => null);
        logger.info('AcquisitionAlerts', `Alerte grand serveur parti émise pour ${c.guildId}.`);
      }
    }
  } catch (err) {
    logger.error('AcquisitionAlerts', 'Erreur lors de la vérification des départs de grands serveurs:', err);
  }

  // ─────────────────────────────────────────────────────────────
  // 3. Alerte : Chute anormale des arrivées de serveurs (> 40% sur 7j)
  // ─────────────────────────────────────────────────────────────
  try {
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 3600 * 1000);

    const [current7d, previous7d] = await Promise.all([
      prisma.guildLifecycle.count({
        where: { invitedAt: { gte: sevenDaysAgo, lte: now } },
      }).catch(() => 0),
      prisma.guildLifecycle.count({
        where: { invitedAt: { gte: fourteenDaysAgo, lt: sevenDaysAgo } },
      }).catch(() => 0),
    ]);

    const dropThresholdPct = thresholds.arrivalsDropPct || 40.0;
    // Vérifier seulement s'il y avait une activité significative la semaine précédente (>= 5 serveurs)
    if (previous7d >= 5) {
      const dropPct = ((previous7d - current7d) / previous7d) * 100;
      if (dropPct >= dropThresholdPct) {
        const dateKey = now.toISOString().slice(0, 10);
        const alertKey = `alert:arrivals_drop:${dateKey}`;

        const existing = await prisma.acquisitionAlertState.findUnique({
          where: { key: alertKey },
        }).catch(() => null);

        if (!existing) {
          const embed = new EmbedBuilder()
            .setTitle('📉 Alerte Acquisition : Chute des arrivées de serveurs')
            .setColor(COLOR_WARNING)
            .setDescription(`Les arrivées de serveurs sur 7 jours glissants sont en baisse de **${dropPct.toFixed(1)}%** par rapport à la période précédente.`)
            .addFields(
              { name: 'Semaine en cours', value: `**${current7d}** arrivées`, inline: true },
              { name: 'Semaine précédente', value: `**${previous7d}** arrivées`, inline: true },
              { name: 'Seuil d\'alerte', value: `-${dropThresholdPct}%`, inline: true },
            )
            .setFooter({ text: 'Consulter l\'entonnoir dans /admin/analytics pour localiser le décrochage.' })
            .setTimestamp();

          const delivered = await notifyBotAdmins(client, embed);
          if (delivered > 0) {
            await prisma.acquisitionAlertState.upsert({
              where: { key: alertKey },
              update: { lastFiredAt: now, lastValue: dropPct },
              create: { key: alertKey, lastFiredAt: now, lastValue: dropPct },
            }).catch(() => null);
            logger.warn('AcquisitionAlerts', `Alerte chute d'arrivées émise: -${dropPct.toFixed(1)}%`);
          }
        }
      }
    }
  } catch (err) {
    logger.error('AcquisitionAlerts', 'Erreur lors du contrôle de la tendance d\'arrivées:', err);
  }

  // ─────────────────────────────────────────────────────────────
  // 4. Alerte : Fin d'essai imminente (sous 48h)
  // ─────────────────────────────────────────────────────────────
  try {
    const hoursWindow = thresholds.trialExpiringHours || 48;
    const windowEnd = new Date(now.getTime() + hoursWindow * 3600 * 1000);

    const expiringTrials = await prisma.guildLifecycle.findMany({
      where: {
        trialStartedAt: { not: null },
        trialEndsAt: { gte: now, lte: windowEnd },
        trialConvertedAt: null,
        churnedAt: null,
      },
      select: {
        guildId: true,
        plan: true,
        trialEndsAt: true,
      },
    }).catch(() => []);

    for (const t of expiringTrials) {
      const alertKey = `alert:trial_expiring:${t.guildId}`;
      const existing = await prisma.acquisitionAlertState.findUnique({
        where: { key: alertKey },
      }).catch(() => null);

      if (existing) continue;

      const remainingHours = t.trialEndsAt ? Math.max(0, Math.round((t.trialEndsAt.getTime() - now.getTime()) / 3600000)) : 0;
      const guildName = client.guilds.cache.get(t.guildId)?.name ?? `Serveur ${t.guildId}`;

      const embed = new EmbedBuilder()
        .setTitle('⏳ Fin d\'essai gratuit imminente')
        .setColor(COLOR_INFO)
        .setDescription(`L'essai gratuit du serveur **${guildName}** (\`${t.guildId}\`) se termine dans **${remainingHours}h**.`)
        .addFields(
          { name: 'Offre testée', value: `\`${t.plan}\``, inline: true },
          { name: 'Échéance', value: t.trialEndsAt ? `<t:${Math.floor(t.trialEndsAt.getTime() / 1000)}:R>` : 'Imminente', inline: true },
        )
        .setTimestamp();

      const delivered = await notifyBotAdmins(client, embed);
      if (delivered > 0) {
        await prisma.acquisitionAlertState.upsert({
          where: { key: alertKey },
          update: { lastFiredAt: now, lastValue: remainingHours },
          create: { key: alertKey, lastFiredAt: now, lastValue: remainingHours },
        }).catch(() => null);
      }
    }
  } catch (err) {
    logger.error('AcquisitionAlerts', 'Erreur lors du contrôle des essais expirants:', err);
  }
}

/**
 * Envoie le récapitulatif commercial et acquisition hebdomadaire (chaque lundi matin).
 */
export async function runWeeklyAcquisitionRecap(client: Client): Promise<void> {
  logger.info('AcquisitionAlerts', 'Génération du récapitulatif hebdomadaire d\'acquisition et de revenus...');
  const dashboard = getDashboardOrigin();
  const now = new Date();

  // Clé d'idempotence basée sur l'année et le numéro de semaine
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const weekNumber = Math.ceil((((now.getTime() - startOfYear.getTime()) / 86400000) + startOfYear.getDay() + 1) / 7);
  const recapKey = `recap:weekly:${now.getFullYear()}-W${weekNumber}`;

  const existingRecap = await prisma.acquisitionAlertState.findUnique({
    where: { key: recapKey },
  }).catch(() => null);

  if (existingRecap) {
    logger.debug('AcquisitionAlerts', `Récapitulatif ${recapKey} déjà envoyé le ${existingRecap.lastFiredAt.toISOString()}.`);
    return;
  }

  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 3600 * 1000);

  try {
    // 1. Chiffres de la base
    const [
      activeLifecycles,
      newGuildsCount,
      churnedGuildsCount,
      trialsStartedCount,
      trialsConvertedCount,
      paidInvoices,
    ] = await Promise.all([
      // Tous les abonnements payants actifs
      prisma.guildLifecycle.findMany({
        where: { plan: { not: 'FREE' }, churnedAt: null },
        select: { mrrCents: true, plan: true },
      }).catch(() => []),
      // Arrivées des 7 derniers jours
      prisma.guildLifecycle.count({
        where: { invitedAt: { gte: sevenDaysAgo } },
      }).catch(() => 0),
      // Départs des 7 derniers jours
      prisma.guildLifecycle.count({
        where: { churnedAt: { gte: sevenDaysAgo } },
      }).catch(() => 0),
      // Essais démarrés sur 7 jours
      prisma.guildLifecycle.count({
        where: { trialStartedAt: { gte: sevenDaysAgo } },
      }).catch(() => 0),
      // Essais convertis sur 7 jours
      prisma.guildLifecycle.count({
        where: { trialConvertedAt: { gte: sevenDaysAgo } },
      }).catch(() => 0),
      // Encaissé réel sur 7 jours
      prisma.billingInvoice.findMany({
        where: { status: 'paid', paidAt: { gte: sevenDaysAgo } },
        select: { amountPaidCents: true },
      }).catch(() => []),
    ]);

    const totalMrrCents = activeLifecycles.reduce((acc, l) => acc + l.mrrCents, 0);
    const totalArrCents = totalMrrCents * 12;
    const collectedWeekCents = paidInvoices.reduce((acc, inv) => acc + inv.amountPaidCents, 0);
    const netGrowth = newGuildsCount - churnedGuildsCount;

    // Top provenances sur les 7 derniers jours
    const recentEvents = await prisma.acquisitionEvent.findMany({
      where: {
        occurredAt: { gte: sevenDaysAgo },
        source: { not: null },
      },
      select: { source: true },
      take: 200,
    }).catch(() => []);

    const sourceCounts: Record<string, number> = {};
    for (const ev of recentEvents) {
      if (ev.source) {
        sourceCounts[ev.source] = (sourceCounts[ev.source] || 0) + 1;
      }
    }
    const topSources = Object.entries(sourceCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([s, count]) => `• **${s}** : ${count} interactions`)
      .join('\n') || 'Aucune provenance enregistrée cette semaine';

    const embed = new EmbedBuilder()
      .setTitle(`📊 Récapitulatif Hebdomadaire Kotbo — Semaine ${weekNumber}`)
      .setColor(COLOR_INFO)
      .setDescription('Synthèse de l\'activité commerciale et du tunnel d\'acquisition sur les 7 derniers jours.')
      .addFields(
        {
          name: '💰 Revenus & MRR',
          value: [
            `• **MRR Actuel :** ${(totalMrrCents / 100).toFixed(2)} €`,
            `• **ARR Projeté :** ${(totalArrCents / 100).toFixed(2)} €`,
            `• **Encaissé sur 7j :** ${(collectedWeekCents / 100).toFixed(2)} €`,
            `• **Abonnements actifs :** ${activeLifecycles.length}`,
          ].join('\n'),
          inline: false,
        },
        {
          name: '🏰 Flotte de serveurs',
          value: [
            `• **Nouveaux arrivés :** +${newGuildsCount}`,
            `• **Départs / résiliations :** -${churnedGuildsCount}`,
            `• **Croissance nette :** ${netGrowth >= 0 ? `+${netGrowth}` : netGrowth}`,
          ].join('\n'),
          inline: true,
        },
        {
          name: '⚡ Essais & Entonnoir',
          value: [
            `• **Essais commencés :** ${trialsStartedCount}`,
            `• **Essais convertis :** ${trialsConvertedCount}`,
            `• **Taux de conversion :** ${trialsStartedCount > 0 ? ((trialsConvertedCount / trialsStartedCount) * 100).toFixed(1) : 0}%`,
          ].join('\n'),
          inline: true,
        },
        {
          name: '🎯 Top canaux d\'acquisition',
          value: topSources,
          inline: false,
        },
      )
      .setFooter({ text: 'Consulter tous les détails dans l\'administration' })
      .setTimestamp();

    const delivered = await notifyBotAdmins(client, embed);
    if (delivered > 0) {
      await prisma.acquisitionAlertState.upsert({
        where: { key: recapKey },
        update: { lastFiredAt: now, lastValue: totalMrrCents },
        create: { key: recapKey, lastFiredAt: now, lastValue: totalMrrCents },
      }).catch(() => null);
      logger.info('AcquisitionAlerts', `Récapitulatif hebdomadaire ${recapKey} délivré à ${delivered} administrateur(s).`);
    }
  } catch (err) {
    logger.error('AcquisitionAlerts', 'Erreur lors de la constitution du récapitulatif hebdo:', err);
  }
}
