/** Routes dashboard du module `settings`. */
import { applyRegulationLock } from '../../../../services/staff/regulationService.js';
import { cache } from '../../../../utils/cache.js';
import prisma from '../../../../utils/db.js';
import { logger } from '../../../../utils/logger.js';
import { extractDiscordSnowflake, getGuildName, getOrCreateRuntime, json, pushAudit, readJsonBody } from '../../../shared.js';
import { type ModuleRouteContext } from './_shared.js';

export async function handleSettingsRoutes(ctx: ModuleRouteContext): Promise<boolean> {
  const { req, res, parts, client, guildId, method, auditUser, moduleKey } = ctx;

  // PATCH/PUT /api/dashboard/guilds/:guildId/settings
  if (moduleKey === 'settings' && parts.length === 5 && (method === 'PATCH' || method === 'PUT')) {
    try {
      const body = await readJsonBody<{
        discordChannel?: string;
        logChannelId?: string | null;
        logIgnoredChannelIds?: unknown;
        moderatorRoleId?: string | null;
        sanctionAlertChannelId?: string | null;
        regulationChannelId?: string | null;
        propagateSanctions?: boolean;
        crossServerSanctionsEnabled?: boolean;
        messageTemplate?: string;
        sidebarFavorites?: unknown;
        configChannelId?: string | null;
        publicChannelId?: string | null;
        newsChannelId?: string | null;
        digestChannelId?: string | null;
        dailyAlgoChannelId?: string | null;
        meetingAnnouncementChannelId?: string | null;
        meetingVoiceChannelId?: string | null;
        baseStaffRoleId?: string | null;
        testStaffRoleId?: string | null;
        translationEnabled?: boolean;
        codePoliceEnabled?: boolean;
        dailyAlgoEnabled?: boolean;
        analyticsEnabled?: boolean;
        // ── Daily Algo v2 : barème, semaine, sanctions, pont clans ──
        dailyAlgoTimezone?: string;
        dailyAlgoParticipationPoints?: number;
        dailyAlgoWeekendMultiplier?: number;
        dailyAlgoWeeklyRewardsEnabled?: boolean;
        dailyAlgoWeekRole1Id?: string | null;
        dailyAlgoWeekRole2Id?: string | null;
        dailyAlgoWeekRole3Id?: string | null;
        dailyAlgoWeekRoleRotate?: boolean;
        dailyAlgoWeekXp1?: number;
        dailyAlgoWeekXp2?: number;
        dailyAlgoWeekXp3?: number;
        dailyAlgoWeekParticipationXp?: number;
        dailyAlgoWeekAnnouncementChannelId?: string | null;
        dailyAlgoSanctionType?: string;
        dailyAlgoSanctionWeight?: number;
        dailyAlgoSanctionDurationMinutes?: number;
        clanPointsFromDailyAlgo?: boolean;
        clanPointsFromDailyAlgoRate?: number;
        clanPointsDailyAlgoTop1?: number;
        clanPointsDailyAlgoTop2?: number;
        clanPointsDailyAlgoTop3?: number;
        githubReleasesEnabled?: boolean;
        digestEnabled?: boolean;
        youtubeEnabled?: boolean;
        autoThreadEnabled?: boolean;
        twitchEnabled?: boolean;
        socialNetworksEnabled?: boolean;
        regulationVerificationEnabled?: boolean;
        regulationRoleId?: string | null;
        regulationLockEnabled?: boolean;
        sanctionReportEnabled?: boolean;
        sanctionReportSkipBots?: boolean;
      }>(req);

      if (!body) {
        json(res, 400, { error: 'Payload settings invalide' });
        return true;
      }

      const oldGuild = await prisma.guild.findUnique({
        where: { id: guildId },
        select: {
          regulationVerificationEnabled: true,
          regulationRoleId: true,
          regulationLockEnabled: true,
          regulationChannelId: true,
        },
      });

      const data: Record<string, unknown> = {};
      let applyLockChanged = false;
      if (Object.prototype.hasOwnProperty.call(body, 'discordChannel')) {
        data.statusCheckChannelId = extractDiscordSnowflake(body.discordChannel);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'logChannelId')) {
        data.logChannelId = extractDiscordSnowflake(body.logChannelId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'logIgnoredChannelIds')) {
        if (!Array.isArray(body.logIgnoredChannelIds)) {
          json(res, 400, { error: 'logIgnoredChannelIds doit être un tableau de salons.' });
          return true;
        }
        const ids = body.logIgnoredChannelIds
          .filter((id): id is string => typeof id === 'string')
          .map((id) => extractDiscordSnowflake(id))
          .filter((id): id is string => !!id);
        data.logIgnoredChannelIds = [...new Set(ids)];
      }
      if (Object.prototype.hasOwnProperty.call(body, 'moderatorRoleId')) {
        data.moderatorRoleId = extractDiscordSnowflake(body.moderatorRoleId);
      }
      // Le salon ou tombent sanctions, signalements et alertes de raid. La
      // colonne existait et la liste de prise en main la reclamait deja ; aucune
      // route ne l'ecrivait, ce qui laissait une case impossible a cocher.
      if (Object.prototype.hasOwnProperty.call(body, 'sanctionAlertChannelId')) {
        data.sanctionAlertChannelId = extractDiscordSnowflake(body.sanctionAlertChannelId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'regulationChannelId')) {
        data.regulationChannelId = extractDiscordSnowflake(body.regulationChannelId);
        applyLockChanged = true;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'regulationVerificationEnabled')) {
        data.regulationVerificationEnabled = !!body.regulationVerificationEnabled;
        applyLockChanged = true;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'regulationRoleId')) {
        data.regulationRoleId = extractDiscordSnowflake(body.regulationRoleId);
        applyLockChanged = true;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'regulationLockEnabled')) {
        data.regulationLockEnabled = !!body.regulationLockEnabled;
        applyLockChanged = true;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'propagateSanctions')) {
        data.propagateSanctions = !!body.propagateSanctions;
        data.sanctionSyncEnabled = !!body.propagateSanctions;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'crossServerSanctionsEnabled')) {
        data.crossServerSanctionsEnabled = !!body.crossServerSanctionsEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'sanctionReportEnabled')) {
        data.sanctionReportEnabled = !!body.sanctionReportEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'sanctionReportSkipBots')) {
        data.sanctionReportSkipBots = !!body.sanctionReportSkipBots;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'analyticsEnabled')) {
        data.analyticsEnabled = !!body.analyticsEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'configChannelId')) {
        data.configChannelId = extractDiscordSnowflake(body.configChannelId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'publicChannelId')) {
        data.publicChannelId = extractDiscordSnowflake(body.publicChannelId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'newsChannelId')) {
        data.newsChannelId = extractDiscordSnowflake(body.newsChannelId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'digestChannelId')) {
        data.digestChannelId = extractDiscordSnowflake(body.digestChannelId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoChannelId')) {
        data.dailyAlgoChannelId = extractDiscordSnowflake(body.dailyAlgoChannelId);
      }

      // ── Daily Algo v2 ────────────────────────────────────────────────────────
      // Toutes ces valeurs sont réglables depuis le panel : rien n'est codé en dur
      // côté bot. Les bornes ci-dessous évitent qu'une saisie farfelue casse le
      // barème (multiplicateur nul, XP négative, taux de conversion à zéro…).
      const readClampedInt = (value: unknown, min: number, max: number, fallback: number): number => {
        const parsed = Math.trunc(Number(value));
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(max, Math.max(min, parsed));
      };

      const readClampedFloat = (value: unknown, min: number, max: number, fallback: number): number => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(max, Math.max(min, parsed));
      };

      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoTimezone')) {
        const candidate = typeof body.dailyAlgoTimezone === 'string' ? body.dailyAlgoTimezone.trim() : '';
        // Un fuseau invalide ferait échouer tous les calculs de semaine : on le
        // vérifie ici plutôt que de le découvrir à la clôture du lundi.
        let isValidTimeZone = false;
        if (candidate) {
          try {
            new Intl.DateTimeFormat('en-US', { timeZone: candidate });
            isValidTimeZone = true;
          } catch {
            isValidTimeZone = false;
          }
        }

        if (!isValidTimeZone) {
          json(res, 400, { error: `Fuseau horaire invalide : « ${candidate} ».` });
          return true;
        }

        data.dailyAlgoTimezone = candidate;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoParticipationPoints')) {
        data.dailyAlgoParticipationPoints = readClampedInt(body.dailyAlgoParticipationPoints, 0, 50, 1);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoWeekendMultiplier')) {
        data.dailyAlgoWeekendMultiplier = readClampedFloat(body.dailyAlgoWeekendMultiplier, 1, 10, 1.5);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoWeeklyRewardsEnabled')) {
        data.dailyAlgoWeeklyRewardsEnabled = !!body.dailyAlgoWeeklyRewardsEnabled;
      }
      // Rôles du podium : facultatifs. Vider le champ = aucun rôle attribué, le
      // reste des récompenses continue de fonctionner.
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoWeekRole1Id')) {
        data.dailyAlgoWeekRole1Id = extractDiscordSnowflake(body.dailyAlgoWeekRole1Id);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoWeekRole2Id')) {
        data.dailyAlgoWeekRole2Id = extractDiscordSnowflake(body.dailyAlgoWeekRole2Id);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoWeekRole3Id')) {
        data.dailyAlgoWeekRole3Id = extractDiscordSnowflake(body.dailyAlgoWeekRole3Id);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoWeekRoleRotate')) {
        data.dailyAlgoWeekRoleRotate = !!body.dailyAlgoWeekRoleRotate;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoWeekXp1')) {
        data.dailyAlgoWeekXp1 = readClampedInt(body.dailyAlgoWeekXp1, 0, 1_000_000, 500);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoWeekXp2')) {
        data.dailyAlgoWeekXp2 = readClampedInt(body.dailyAlgoWeekXp2, 0, 1_000_000, 300);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoWeekXp3')) {
        data.dailyAlgoWeekXp3 = readClampedInt(body.dailyAlgoWeekXp3, 0, 1_000_000, 150);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoWeekParticipationXp')) {
        data.dailyAlgoWeekParticipationXp = readClampedInt(body.dailyAlgoWeekParticipationXp, 0, 1_000_000, 100);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoWeekAnnouncementChannelId')) {
        data.dailyAlgoWeekAnnouncementChannelId = extractDiscordSnowflake(body.dailyAlgoWeekAnnouncementChannelId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoSanctionType')) {
        data.dailyAlgoSanctionType = body.dailyAlgoSanctionType === 'TIMEOUT' ? 'TIMEOUT' : 'WARN';
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoSanctionWeight')) {
        data.dailyAlgoSanctionWeight = readClampedInt(body.dailyAlgoSanctionWeight, 1, 3, 1);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoSanctionDurationMinutes')) {
        data.dailyAlgoSanctionDurationMinutes = readClampedInt(body.dailyAlgoSanctionDurationMinutes, 1, 40_320, 60);
      }
      // Pont Daily Algo → Clans : troisième interrupteur, indépendant de
      // `clansEnabled` et `dailyAlgoEnabled`.
      if (Object.prototype.hasOwnProperty.call(body, 'clanPointsFromDailyAlgo')) {
        data.clanPointsFromDailyAlgo = !!body.clanPointsFromDailyAlgo;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'clanPointsFromDailyAlgoRate')) {
        data.clanPointsFromDailyAlgoRate = readClampedFloat(body.clanPointsFromDailyAlgoRate, 0.1, 100, 1);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'clanPointsDailyAlgoTop1')) {
        data.clanPointsDailyAlgoTop1 = readClampedInt(body.clanPointsDailyAlgoTop1, 0, 100_000, 30);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'clanPointsDailyAlgoTop2')) {
        data.clanPointsDailyAlgoTop2 = readClampedInt(body.clanPointsDailyAlgoTop2, 0, 100_000, 20);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'clanPointsDailyAlgoTop3')) {
        data.clanPointsDailyAlgoTop3 = readClampedInt(body.clanPointsDailyAlgoTop3, 0, 100_000, 10);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'meetingAnnouncementChannelId')) {
        data.meetingAnnouncementChannelId = extractDiscordSnowflake(body.meetingAnnouncementChannelId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'meetingVoiceChannelId')) {
        data.meetingVoiceChannelId = extractDiscordSnowflake(body.meetingVoiceChannelId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'baseStaffRoleId')) {
        data.baseStaffRoleId = extractDiscordSnowflake(body.baseStaffRoleId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'testStaffRoleId')) {
        data.testStaffRoleId = extractDiscordSnowflake(body.testStaffRoleId);
      }
      if (Object.prototype.hasOwnProperty.call(body, 'translationEnabled')) {
        data.translationEnabled = !!body.translationEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'codePoliceEnabled')) {
        data.codePoliceEnabled = !!body.codePoliceEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'dailyAlgoEnabled')) {
        data.dailyAlgoEnabled = !!body.dailyAlgoEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'githubReleasesEnabled')) {
        data.githubReleasesEnabled = !!body.githubReleasesEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'digestEnabled')) {
        data.digestEnabled = !!body.digestEnabled;
      }
      if (Object.prototype.hasOwnProperty.call(body, 'autoThreadEnabled')) {
        data.autoThreadEnabled = !!body.autoThreadEnabled;
      }

      if (Object.keys(data).length > 0) {
        await prisma.guild.update({ where: { id: guildId }, data });
        // La ligne du serveur est servie depuis `getCachedGuild` par le bot
        // comme par le controle d'acces du dashboard : sans purge, un reglage
        // enregistre ici restait sans effet jusqu'a l'expiration du cache.
        await cache.invalidateGuild(guildId);
      }

      if (applyLockChanged) {
        const finalGuild = await prisma.guild.findUnique({
          where: { id: guildId },
          select: {
            regulationVerificationEnabled: true,
            regulationRoleId: true,
            regulationLockEnabled: true,
            regulationChannelId: true,
          },
        });
        if (finalGuild) {
          const discordGuild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
          if (discordGuild) {
            let verifiedRoleId = finalGuild.regulationRoleId;
            if (finalGuild.regulationVerificationEnabled && !verifiedRoleId) {
              let role = discordGuild.roles.cache.find((r) => r.name === 'Vérifié') ?? null;
              if (!role) {
                try {
                  role = await discordGuild.roles.create({
                    name: 'Vérifié',
                    reason: 'Créé automatiquement pour le règlement du serveur.',
                  });
                } catch (err) {
                  logger.error('SettingsAPI', `Impossible de créer le rôle 'Vérifié' :`, err);
                }
              }
              if (role) {
                verifiedRoleId = role.id;
                await prisma.guild.update({
                  where: { id: guildId },
                  data: { regulationRoleId: role.id },
                });
              }
            }

            const oldLocked = !!(oldGuild?.regulationVerificationEnabled && oldGuild?.regulationLockEnabled);
            const newLocked = !!(finalGuild.regulationVerificationEnabled && finalGuild.regulationLockEnabled);
            const lockStateChanged = oldLocked !== newLocked;
            const roleChanged = oldGuild?.regulationRoleId !== finalGuild.regulationRoleId;
            const channelChanged = oldGuild?.regulationChannelId !== finalGuild.regulationChannelId;

            if (verifiedRoleId && finalGuild.regulationChannelId && (lockStateChanged || roleChanged || channelChanged)) {
              // Run in background to prevent API timeout / rate limit blocks
              applyRegulationLock(
                discordGuild,
                verifiedRoleId,
                finalGuild.regulationChannelId,
                newLocked
              ).catch((err) => {
                logger.error('SettingsAPI', `Error in applyRegulationLock background task:`, err);
              });
            }
          }
        }
      }

      // Les valeurs viennent de l'accumulateur `data`, alimente champ par champ
      // depuis le corps de requete : on les normalise ici plutot qu'a chacun des
      // ~20 appels.
      const syncFeature = async (featureKey: string, featureName: string, rawEnabled?: unknown, rawChannelId?: unknown, rawSecondaryChannelId?: unknown) => {
        const enabled = typeof rawEnabled === 'boolean' ? rawEnabled : undefined;
        const channelId = rawChannelId === undefined ? undefined : (typeof rawChannelId === 'string' ? rawChannelId : null);
        const secondaryChannelId = rawSecondaryChannelId === undefined ? undefined : (typeof rawSecondaryChannelId === 'string' ? rawSecondaryChannelId : null);

        const updateData: Record<string, unknown> = {};
        if (enabled !== undefined) updateData.enabled = enabled;
        if (channelId !== undefined) updateData.channelId = channelId;
        if (secondaryChannelId !== undefined) updateData.secondaryChannelId = secondaryChannelId;

        if (Object.keys(updateData).length > 0) {
          await prisma.dashboardFeatureConfig.upsert({
            where: { guildId_featureKey: { guildId, featureKey } },
            create: {
              guildId,
              featureKey,
              featureName,
              enabled: enabled ?? true,
              channelId: channelId ?? null,
              secondaryChannelId: secondaryChannelId ?? null,
              loggingEnabled: true,
              userActivityTracking: true,
              notifyViaDiscordChannel: true,
            },
            update: updateData,
          });
        }
      };

      await syncFeature('daily_algo', 'Daily Algo', data.dailyAlgoEnabled, data.dailyAlgoChannelId, undefined);
      await syncFeature('digest', 'Digest', data.digestEnabled, data.digestChannelId, undefined);
      await syncFeature('translation', 'Translation', data.translationEnabled, undefined, undefined);
      await syncFeature('codepolice', 'Code Police', data.codePoliceEnabled, undefined, undefined);
      await syncFeature('logs', 'Logs Discord', undefined, data.logChannelId, undefined);
      await syncFeature('regulation', 'Règlement', undefined, data.regulationChannelId, undefined);
      await syncFeature('meetings', 'Réunions', undefined, data.meetingAnnouncementChannelId, data.meetingVoiceChannelId);
      await syncFeature('settings', 'Paramètres', undefined, data.configChannelId, undefined);
      await syncFeature('dashboard', "Vue d'ensemble", undefined, data.publicChannelId, undefined);
      await syncFeature('news', 'Actualités & RSS', undefined, data.newsChannelId, undefined);
      await syncFeature('auto_thread', 'Auto-Thread', data.autoThreadEnabled, undefined, undefined);
      
      if (body.youtubeEnabled !== undefined) {
        await syncFeature('youtube', 'YouTube', body.youtubeEnabled, undefined, undefined);
      }

      if (body.twitchEnabled !== undefined) {
        await syncFeature('twitch', 'Twitch', body.twitchEnabled, undefined, undefined);
      }

      if (body.socialNetworksEnabled !== undefined) {
        await syncFeature('social_networks', 'Réseaux Sociaux', body.socialNetworksEnabled, undefined, undefined);
      }

      const _runtime = await getOrCreateRuntime(guildId);
      const dashboardSettingsPatch: { messageTemplate?: string; sidebarFavorites?: string[] } = {};
      if (typeof body.messageTemplate === 'string') {
        dashboardSettingsPatch.messageTemplate = body.messageTemplate;
      }

      if (Object.prototype.hasOwnProperty.call(body, 'sidebarFavorites')) {
        if (!Array.isArray(body.sidebarFavorites)) {
          json(res, 400, { error: 'sidebarFavorites doit être un tableau de chemins.' });
          return true;
        }

        dashboardSettingsPatch.sidebarFavorites = body.sidebarFavorites
          .filter((entry): entry is string => typeof entry === 'string' && entry.startsWith('/'))
          .map((entry) => entry.trim())
          .filter((entry, index, arr) => entry.length > 0 && arr.indexOf(entry) === index)
          .slice(0, 80);
      }

      if (Object.keys(dashboardSettingsPatch).length > 0) {
        await prisma.dashboardSettings.update({
          where: { guildId },
          data: dashboardSettingsPatch
        });
      }

      await pushAudit(guildId, {
        user: auditUser,
        action: 'Sauvegarde paramètres globaux',
        context: getGuildName(client, guildId),
        module: 'Dashboard',
        eventType: 'Manuel',
        details: 'Paramètres globaux mis à jour.',
        channelId: null
      });

      json(res, 200, { ok: true });
    } catch (err) {
      logger.error('SettingsAPI', 'Error updating settings:', err);
      json(res, 500, { error: 'Erreur lors de la mise à jour des paramètres' });
    }
    return true;
  }

  return false;
}
