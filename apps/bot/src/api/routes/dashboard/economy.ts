import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { resolveMemberAvatarUrl } from '../../../services/moderation/memberIdentityService.js';
import { logger } from '../../../utils/logger.js';
import { getOrCreateEconomyConfig, adminDeleteShopItem } from '../../../services/features/economyService.js';
import { json, readJsonBody, getGuildName, pushAudit, type AuthClaims, type DashboardAccess } from '../../shared.js';
import {
  BestiaryError,
  deleteGuildMonster,
  listGuildMonsters,
  saveGuildMonster,
  setGuildMonsterEnabled,
  syncDropReferences,
} from '../../../services/features/rpg/rpgBestiaryService.js';
import { parseMonsterDrops, type MonsterInput } from '../../../services/features/rpg/rpgBestiaryPolicy.js';
import {
  asDifficulty,
  isDifficulty,
  recommendDifficulty,
} from '../../../services/features/rpg/rpgDifficultyPolicy.js';
import {
  applyBestiaryDifficulty,
  applyShopDifficulty,
  findDifficultyDrift,
  getBestiaryBattleStats,
  summarizeBattles,
} from '../../../services/features/rpg/rpgDifficultyService.js';
import {
  exportGuildBestiary,
  importGuildBestiary,
} from '../../../services/features/rpg/rpgBestiaryTransferService.js';
import {
  deleteGuildRaidBoss,
  getOpenRaid,
  getRaidRecap,
  getRaidState,
  listGuildRaidBosses,
  listRaidHistory,
  listRaidTeams,
  RaidError,
  saveGuildRaidBoss,
  seedGuildRaidBosses,
  startRaidNow,
} from '../../../services/features/rpg/rpgRaidService.js';
import { announceOpenRaid } from '../../../services/features/rpg/rpgRaidPanel.js';
import {
  deleteGuildRecipe,
  listGuildRecipes,
  RecipeError,
  saveGuildRecipe,
  syncRecipeReferences,
} from '../../../services/features/rpg/rpgRecipeService.js';
import { RAID_SPELLS } from '../../../services/features/rpg/rpgRaidContent.js';
import {
  deleteGuildQuest,
  listGuildQuests,
  QuestError,
  saveGuildQuest,
} from '../../../services/features/rpg/rpgQuestService.js';
import {
  questWindowBounds,
  RPG_QUEST_OBJECTIVES,
  RPG_QUEST_SCOPES,
  type RpgQuestInput,
} from '../../../services/features/rpg/rpgQuestPolicy.js';
import {
  asRaidTeamMode,
  isRaidTeamMode,
  RAID_ASSAULTS_RANGE,
  RAID_BOUGHT_ASSAULTS_RANGE,
  RAID_CLAN_POINTS_RANGE,
  RAID_CONSOLATION_RANGE,
  RAID_DURATION_RANGE,
  RAID_ENERGY_RANGE,
  RAID_HEALTH_BOUND_RANGE,
  RAID_HEALTH_PER_MEMBER_RANGE,
  RAID_HOUR_RANGE,
  RAID_REWARD_RANGE,
  RAID_WEEKDAY_RANGE,
  type RaidBossInput,
} from '../../../services/features/rpg/rpgRaidPolicy.js';
import type { RecipeInput } from '../../../services/features/rpg/rpgRecipePolicy.js';
import {
  CLAN_POINTS_REWARD_RANGE,
  hasModuleReward,
  LEVEL_XP_REWARD_RANGE,
  RAID_ASSAULT_BONUS_RANGE,
} from '../../../services/features/economyPolicy.js';
import {
  clampInt,
  DISCOUNT_RANGE,
  DURATION_MIN_RANGE,
  INTERVAL_DAYS_RANGE,
  MAX_QUANTITY_RANGE,
  OFFER_COUNT_RANGE,
} from '../../../services/features/rpg/rpgBlackMarketPolicy.js';

const BLACK_MARKET_ANNOUNCE_MODES = new Set(['NONE', 'CHANNEL', 'CHANNEL_ROLE']);

/** Le type du corps de requête ne vaut qu'à la compilation : la valeur reçue est vérifiée. */
const RESET_COMPONENTS = new Set(['all', 'profiles', 'items', 'config', 'guilds', 'bestiary']);

/** Fenêtre d'observation des combats : assez large pour un petit serveur, assez courte pour
 *  qu'un réglage récent ne reste pas jugé sur l'ancien équilibrage. */
const BATTLE_STATS_DAYS = 30;

/**
 * Ajoute à la configuration économique l'état des modules voisins.
 *
 * Ces réglages ne vivent pas sur `EconomyConfig` : `clansEnabled` et `levelingEnabled` ne
 * sont là que pour dire à la page quelles options proposer, seul `clanPointsFromRpg` s'écrit.
 */
async function withModuleFlags<T extends object>(guildId: string, config: T) {
  const [guild, levelConfig] = await Promise.all([
    prisma.guild.findUnique({
      where: { id: guildId },
      select: { clansEnabled: true, clanPointsFromRpg: true },
    }),
    prisma.levelConfig.findUnique({ where: { guildId }, select: { enabled: true } }),
  ]);

  return {
    ...config,
    clansEnabled: guild?.clansEnabled ?? false,
    clanPointsFromRpg: guild?.clanPointsFromRpg ?? false,
    levelingEnabled: levelConfig?.enabled ?? false,
  };
}

/** Le module Clans ne vit pas sur `EconomyConfig` : son état se lit sur le serveur. */
async function areClansEnabled(guildId: string): Promise<boolean> {
  const guild = await prisma.guild.findUnique({ where: { id: guildId }, select: { clansEnabled: true } });
  return guild?.clansEnabled ?? false;
}

/** Applique les bornes du marché noir sans écraser un champ que le client n'a pas envoyé. */
function clampOptional(value: number | undefined, range: { min: number; max: number }): number | undefined {
  return value === undefined ? undefined : clampInt(value, range, range.min);
}

interface LocalPlayerProfile {
  userId: string;
  balance: number;
  level: number;
  xp: number;
  health: number;
  energy: number;
  attack: number;
  defense: number;
  speed: number;
  weaponId?: string | null;
  armorId?: string | null;
  rpgGuild?: unknown;
}

export async function handleEconomyRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  client: Client,
  user: AuthClaims,
  guildId: string,
  _access: DashboardAccess
): Promise<boolean> {
  const method = req.method;
  const auditUser = `${user.username} (${user.userId})`;
  
  // parts[4] === 'economy'
  const subAction = parts[5]; // config | items | monsters | players

  // 1. Economy Configuration Routes
  if (subAction === 'config') {
    // GET /api/dashboard/guilds/:guildId/economy/config
    if (parts.length === 6 && method === 'GET') {
      try {
        const config = await getOrCreateEconomyConfig(guildId);
        json(res, 200, { config: await withModuleFlags(guildId, config) });
      } catch (err) {
        logger.error('EconomyAPI', 'Error fetching economy config:', err);
        json(res, 500, { error: "Erreur lors de la récupération de la configuration de l'économie." });
      }
      return true;
    }

    // PATCH /api/dashboard/guilds/:guildId/economy/config
    if (parts.length === 6 && method === 'PATCH') {
      try {
        const body = await readJsonBody<{
          enabled?: boolean;
          rpgEnabled?: boolean;
          guildsEnabled?: boolean;
          shopEnabled?: boolean;
          currencyName?: string;
          currencyEmoji?: string;
          currencyIcon?: string | null;
          dailyRewardMin?: number;
          dailyRewardMax?: number;
          dailyCooldownHour?: number;
          adventureCooldownMin?: number;
          maxEnergy?: number;
          energyRecoveryPerHour?: number;
          maxBetAmount?: number;
          maxDailyBets?: number;
          maxTransferAmount?: number;
          transferCooldownMin?: number;
          blackMarketEnabled?: boolean;
          blackMarketIntervalDays?: number;
          blackMarketDurationMin?: number;
          blackMarketOfferCount?: number;
          blackMarketMaxQuantity?: number;
          blackMarketDiscountMin?: number;
          blackMarketDiscountMax?: number;
          blackMarketAnnounce?: string;
          blackMarketChannelId?: string | null;
          blackMarketRoleId?: string | null;
          clanPointsFromRpg?: boolean;
          raidEnabled?: boolean;
          raidAutoSchedule?: boolean;
          raidTeamMode?: string;
          raidBossName?: string | null;
          raidHealthPerMember?: number;
          raidHealthFloor?: number;
          raidHealthCap?: number;
          raidAssaultsPerMember?: number;
          raidBoughtAssaultsMax?: number;
          raidConsolationShare?: number;
          raidEnergyCost?: number;
          raidWeekday?: number;
          raidHour?: number;
          raidDurationHours?: number;
          raidXpReward?: number;
          raidCoinReward?: number;
          raidClanPoints?: number;
          raidAnnounce?: string;
          raidChannelId?: string | null;
          raidRoleId?: string | null;
        }>(req);

        if (!body) {
          json(res, 400, { error: 'Corps de requête manquant.' });
          return true;
        }

        if (body.blackMarketAnnounce !== undefined && !BLACK_MARKET_ANNOUNCE_MODES.has(body.blackMarketAnnounce)) {
          json(res, 400, { error: "Mode d'annonce du marché noir invalide." });
          return true;
        }

        if (body.raidAnnounce !== undefined && !BLACK_MARKET_ANNOUNCE_MODES.has(body.raidAnnounce)) {
          json(res, 400, { error: "Mode d'annonce du raid invalide." });
          return true;
        }
        if (body.raidTeamMode !== undefined && !isRaidTeamMode(body.raidTeamMode)) {
          json(res, 400, { error: "Mode d'équipe du raid invalide." });
          return true;
        }

        // Un mode d'annonce sans destinataire produirait un marché noir « annoncé » qui
        // ne s'annonce jamais : on refuse la combinaison au lieu de la laisser passer.
        const current = await getOrCreateEconomyConfig(guildId);
        const announceMode = body.blackMarketAnnounce ?? current.blackMarketAnnounce;
        const announceChannel = body.blackMarketChannelId !== undefined ? body.blackMarketChannelId : current.blackMarketChannelId;
        const announceRole = body.blackMarketRoleId !== undefined ? body.blackMarketRoleId : current.blackMarketRoleId;
        if (announceMode !== 'NONE' && !announceChannel) {
          json(res, 400, { error: "Sélectionnez un salon d'annonce pour le marché noir." });
          return true;
        }
        if (announceMode === 'CHANNEL_ROLE' && !announceRole) {
          json(res, 400, { error: 'Sélectionnez un rôle à mentionner pour le marché noir.' });
          return true;
        }

        const raidOn = body.raidEnabled ?? current.raidEnabled;
        const raidAnnounceMode = body.raidAnnounce ?? current.raidAnnounce;
        const raidChannel = body.raidChannelId !== undefined ? body.raidChannelId : current.raidChannelId;
        const raidRole = body.raidRoleId !== undefined ? body.raidRoleId : current.raidRoleId;
        const raidMode = asRaidTeamMode(body.raidTeamMode ?? current.raidTeamMode);
        const rpgGuildsOn = body.guildsEnabled ?? current.guildsEnabled;

        /**
         * Le corps change-t-il vraiment ce réglage ?
         *
         * La page renvoie la configuration entière à chaque enregistrement : « le champ est
         * présent » ne dit donc rien. Ce qui compte est qu'il *change*, sinon un serveur
         * déjà dans un état bancal ne pourrait plus rien enregistrer de l'onglet - pas même
         * le nom de sa monnaie - tant qu'il n'aurait pas réparé son raid. Le fichier prend
         * déjà ce parti pour le pont RPG vers les clans, quelques lignes plus haut.
         */
        const changes = (field: keyof typeof current, sent: unknown): boolean =>
          sent !== undefined && sent !== current[field];

        // Le raid se joue depuis le bouton de son annonce : sans annonce ni salon, la
        // fenêtre s'ouvre et se referme sans que personne n'ait pu frapper.
        const touchesAnnounce = changes('raidEnabled', body.raidEnabled)
          || changes('raidAnnounce', body.raidAnnounce)
          || changes('raidChannelId', body.raidChannelId)
          || changes('raidRoleId', body.raidRoleId);

        if (raidOn && touchesAnnounce) {
          if (raidAnnounceMode === 'NONE') {
            json(res, 400, { error: "Le raid se joue depuis le bouton de son annonce : choisissez un mode d'annonce." });
            return true;
          }
          if (!raidChannel) {
            json(res, 400, { error: "Sélectionnez un salon d'annonce pour le raid." });
            return true;
          }
          if (raidAnnounceMode === 'CHANNEL_ROLE' && !raidRole) {
            json(res, 400, { error: 'Sélectionnez un rôle à mentionner pour le raid.' });
            return true;
          }
        }

        // Un raid ne peut pas opposer des équipes que le serveur n'a pas : en mode guilde
        // RPG sans guildes du jeu, ou en mode clan sans module Clans, la fenêtre s'ouvre et
        // tout le monde se voit répondre qu'il n'appartient à aucune équipe.
        const touchesTeamMode = changes('raidEnabled', body.raidEnabled)
          || changes('raidTeamMode', body.raidTeamMode)
          || changes('guildsEnabled', body.guildsEnabled);

        if (raidOn && touchesTeamMode) {
          if (raidMode === 'RPG_GUILD' && !rpgGuildsOn) {
            json(res, 400, { error: 'Activez les guildes RPG, faites jouer le raid en mode clan, ou désactivez le raid.' });
            return true;
          }
          if (raidMode === 'CLAN' && !(await areClansEnabled(guildId))) {
            json(res, 400, { error: 'Activez le module Clans, faites jouer le raid en mode guilde RPG, ou désactivez le raid.' });
            return true;
          }
        }

        const config = await prisma.economyConfig.update({
          where: { guildId },
          data: {
            enabled: body.enabled,
            rpgEnabled: body.rpgEnabled,
            guildsEnabled: body.guildsEnabled,
            shopEnabled: body.shopEnabled,
            currencyName: body.currencyName,
            currencyEmoji: body.currencyEmoji,
            currencyIcon: body.currencyIcon,
            dailyRewardMin: body.dailyRewardMin,
            dailyRewardMax: body.dailyRewardMax,
            dailyCooldownHour: body.dailyCooldownHour,
            adventureCooldownMin: body.adventureCooldownMin,
            maxEnergy: body.maxEnergy,
            energyRecoveryPerHour: body.energyRecoveryPerHour,
            maxBetAmount: body.maxBetAmount,
            maxDailyBets: body.maxDailyBets,
            maxTransferAmount: body.maxTransferAmount,
            transferCooldownMin: body.transferCooldownMin,
            blackMarketEnabled: body.blackMarketEnabled,
            // Les bornes sont celles qu'applique le tirage : les faire respecter ici évite
            // qu'une saisie aberrante ne soit silencieusement corrigée à chaque ouverture.
            blackMarketIntervalDays: clampOptional(body.blackMarketIntervalDays, INTERVAL_DAYS_RANGE),
            blackMarketDurationMin: clampOptional(body.blackMarketDurationMin, DURATION_MIN_RANGE),
            blackMarketOfferCount: clampOptional(body.blackMarketOfferCount, OFFER_COUNT_RANGE),
            blackMarketMaxQuantity: clampOptional(body.blackMarketMaxQuantity, MAX_QUANTITY_RANGE),
            blackMarketDiscountMin: clampOptional(body.blackMarketDiscountMin, DISCOUNT_RANGE),
            blackMarketDiscountMax: clampOptional(body.blackMarketDiscountMax, DISCOUNT_RANGE),
            blackMarketAnnounce: body.blackMarketAnnounce,
            blackMarketChannelId: body.blackMarketChannelId,
            blackMarketRoleId: body.blackMarketRoleId,
            raidEnabled: body.raidEnabled,
            raidAutoSchedule: body.raidAutoSchedule,
            raidTeamMode: body.raidTeamMode,
            // Une chaîne vide vaut « aucun boss fixé », donc tirage au sort : sans cette
            // conversion, le raid chercherait un boss nommé « ».
            raidBossName: body.raidBossName === undefined ? undefined : (body.raidBossName?.trim() || null),
            raidHealthPerMember: clampOptional(body.raidHealthPerMember, RAID_HEALTH_PER_MEMBER_RANGE),
            raidHealthFloor: clampOptional(body.raidHealthFloor, RAID_HEALTH_BOUND_RANGE),
            raidHealthCap: clampOptional(body.raidHealthCap, RAID_HEALTH_BOUND_RANGE),
            raidAssaultsPerMember: clampOptional(body.raidAssaultsPerMember, RAID_ASSAULTS_RANGE),
            raidBoughtAssaultsMax: clampOptional(body.raidBoughtAssaultsMax, RAID_BOUGHT_ASSAULTS_RANGE),
            raidConsolationShare: clampOptional(body.raidConsolationShare, RAID_CONSOLATION_RANGE),
            raidEnergyCost: clampOptional(body.raidEnergyCost, RAID_ENERGY_RANGE),
            raidWeekday: clampOptional(body.raidWeekday, RAID_WEEKDAY_RANGE),
            raidHour: clampOptional(body.raidHour, RAID_HOUR_RANGE),
            raidDurationHours: clampOptional(body.raidDurationHours, RAID_DURATION_RANGE),
            raidXpReward: clampOptional(body.raidXpReward, RAID_REWARD_RANGE),
            raidCoinReward: clampOptional(body.raidCoinReward, RAID_REWARD_RANGE),
            raidClanPoints: clampOptional(body.raidClanPoints, RAID_CLAN_POINTS_RANGE),
            raidAnnounce: body.raidAnnounce,
            raidChannelId: body.raidChannelId,
            raidRoleId: body.raidRoleId
          }
        });

        // Ouvrir le pont RPG vers les clans exige des clans actifs ; le refermer est
        // toujours permis. La demande est ignorée plutôt que refusée : la page renvoie la
        // configuration entière à chaque enregistrement, et un serveur ayant éteint ses
        // clans après avoir ouvert le pont verrait sinon toutes ses sauvegardes rejetées.
        const guildRow = await prisma.guild.findUnique({
          where: { id: guildId },
          select: { clansEnabled: true }
        });
        const clanPointsFromRpg = body.clanPointsFromRpg === true && !guildRow?.clansEnabled
          ? undefined
          : body.clanPointsFromRpg;

        // Also sync the main Guild model toggle
        if (body.enabled !== undefined || clanPointsFromRpg !== undefined) {
          await prisma.guild.update({
            where: { id: guildId },
            data: { economyEnabled: body.enabled, clanPointsFromRpg }
          });
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Mise à jour configuration Économie',
          context: getGuildName(client, guildId),
          module: 'Économie',
          eventType: 'Manuel',
          details: `Config éco mise à jour. Économie active: ${config.enabled}, RPG: ${config.rpgEnabled}`,
          channelId: null
        });

        json(res, 200, { config: await withModuleFlags(guildId, config) });
      } catch (err) {
        logger.error('EconomyAPI', 'Error updating economy config:', err);
        json(res, 500, { error: "Erreur lors de la mise à jour de la configuration de l'économie." });
      }
      return true;
    }
  }

  // 2. Shop Items Routes
  if (subAction === 'items') {
    // GET /api/dashboard/guilds/:guildId/economy/items
    if (parts.length === 6 && method === 'GET') {
      try {
        const items = await prisma.rpgItem.findMany({
          where: {
            OR: [
              { guildId: null },
              { guildId }
            ]
          },
          orderBy: { price: 'asc' }
        });
        json(res, 200, { items });
      } catch (err) {
        logger.error('EconomyAPI', 'Error fetching shop items:', err);
        json(res, 500, { error: 'Erreur lors de la récupération des objets de la boutique.' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/economy/items (Create/Update Item)
    if (parts.length === 6 && method === 'POST') {
      try {
        const body = await readJsonBody<{
          id?: string;
          name: string;
          description: string;
          emoji?: string;
          type: 'WEAPON' | 'ARMOR' | 'POTION' | 'QUEST';
          atkBonus?: number;
          defBonus?: number;
          spdBonus?: number;
          hpRestore?: number;
          energyRestore?: number;
          levelXpReward?: number;
          clanPointsReward?: number;
          raidAssaultBonus?: number;
          price: number;
          purchasable?: boolean;
          blackMarketEligible?: boolean;
        }>(req);

        if (!body || !body.name?.trim() || !body.type || body.price === undefined) {
          json(res, 400, { error: 'Champs obligatoires manquants.' });
          return true;
        }
        // Discord refuse une option de menu sans description : un objet qui en manque
        // rendait la boutique entière inaccessible côté bot.
        if (!body.description?.trim()) {
          json(res, 400, { error: "La description de l'objet est obligatoire : elle s'affiche dans la boutique." });
          return true;
        }

        // Seuls les consommables sont bus : une récompense de module posée sur une arme ne
        // serait jamais versée, mais suffirait à retirer l'arme de la boutique.
        const moduleRewards = body.type === 'POTION'
          ? {
            levelXpReward: clampInt(body.levelXpReward ?? 0, LEVEL_XP_REWARD_RANGE, 0),
            clanPointsReward: clampInt(body.clanPointsReward ?? 0, CLAN_POINTS_REWARD_RANGE, 0),
            raidAssaultBonus: clampInt(body.raidAssaultBonus ?? 0, RAID_ASSAULT_BONUS_RANGE, 0)
          }
          : { levelXpReward: 0, clanPointsReward: 0, raidAssaultBonus: 0 };

        // Le marché noir brade de 20 à 50 % : un objet qui vend de l'XP ou des points de
        // clan en sort par défaut, le prix fixé étant justement l'équilibrage. Le choix
        // explicite du client prime, dans les deux sens.
        const blackMarketEligible = body.blackMarketEligible ?? !hasModuleReward(moduleRewards);

        let item;
        if (body.id) {
          // Le catalogue global est partagé par tous les serveurs : sans ce contrôle, une
          // requête forgée modifiait l'objet de tout le monde depuis un seul dashboard.
          const existing = await prisma.rpgItem.findUnique({
            where: { id: body.id },
            select: { guildId: true, name: true }
          });
          if (!existing) {
            json(res, 404, { error: 'Objet introuvable.' });
            return true;
          }
          if (existing.guildId !== guildId) {
            json(res, 403, { error: 'Vous ne pouvez modifier que les objets spécifiques à votre serveur.' });
            return true;
          }

          item = await prisma.rpgItem.update({
            where: { id: body.id },
            data: {
              name: body.name.trim(),
              description: body.description.trim(),
              emoji: body.emoji?.trim() || '📦',
              type: body.type,
              atkBonus: body.atkBonus ?? 0,
              defBonus: body.defBonus ?? 0,
              spdBonus: body.spdBonus ?? 0,
              hpRestore: body.hpRestore ?? 0,
              energyRestore: body.energyRestore ?? 0,
              ...moduleRewards,
              price: body.price,
              purchasable: body.purchasable ?? true,
              blackMarketEligible
            }
          });

          // Les butins désignent leur objet par son nom : le renommage doit les suivre.
          // L'objet est déjà renommé à ce stade : un incident ici ne doit pas transformer un
          // enregistrement réussi en erreur, il est journalisé et la réponse reste un succès.
          if (existing.name !== item.name) {
            await syncDropReferences(guildId, existing.name, item.name).catch((err) => {
              logger.error('EconomyAPI', `Butins non mis à jour après le renommage de ${existing.name}:`, err);
            });
            // Les matériaux d'une recette désignent eux aussi leur objet par son nom :
            // sans ce suivi, renommer un minerai rendait ses recettes infabriquables.
            await syncRecipeReferences(guildId, existing.name, item.name).catch((err) => {
              logger.error('EconomyAPI', `Recettes non mises à jour après le renommage de ${existing.name}:`, err);
            });
          }
        } else {
          // Create
          item = await prisma.rpgItem.create({
            data: {
              guildId,
              name: body.name.trim(),
              description: body.description.trim(),
              emoji: body.emoji?.trim() || '📦',
              type: body.type,
              atkBonus: body.atkBonus ?? 0,
              defBonus: body.defBonus ?? 0,
              spdBonus: body.spdBonus ?? 0,
              hpRestore: body.hpRestore ?? 0,
              energyRestore: body.energyRestore ?? 0,
              ...moduleRewards,
              price: body.price,
              purchasable: body.purchasable ?? true,
              blackMarketEligible
            }
          });
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: body.id ? 'Modification objet boutique' : 'Création objet boutique',
          context: getGuildName(client, guildId),
          module: 'Économie',
          eventType: 'Manuel',
          details: `Objet: ${body.name} (${body.type}) - Prix: ${body.price}`,
          channelId: null
        });

        json(res, 200, { item });
      } catch (err) {
        logger.error('EconomyAPI', 'Error saving shop item:', err);
        json(res, 500, { error: "Erreur lors de la sauvegarde de l'objet." });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/economy/items/difficulty
    if (parts.length === 7 && parts[6] === 'difficulty' && method === 'POST') {
      try {
        const body = await readJsonBody<{ difficulty?: string; preview?: boolean }>(req);
        if (!body || !isDifficulty(body.difficulty)) {
          json(res, 400, { error: 'Palier de difficulté inconnu.' });
          return true;
        }

        const config = await getOrCreateEconomyConfig(guildId);
        const from = asDifficulty(config.shopDifficulty);
        const dryRun = body.preview === true;

        const { updated, preview, protectedItems } = await applyShopDifficulty(
          guildId,
          { from, to: body.difficulty, dryRun },
        );

        if (!dryRun) {
          await pushAudit(guildId, {
            user: auditUser,
            action: 'Difficulté des prix RPG',
            context: getGuildName(client, guildId),
            module: 'Économie',
            eventType: 'Manuel',
            details: `Boutique : ${from} vers ${body.difficulty} - ${updated} prix modifié(s)`,
            channelId: null
          });
        }

        json(res, 200, { success: true, difficulty: body.difficulty, updated, preview, protectedItems, dryRun });
      } catch (err) {
        logger.error('EconomyAPI', 'Error applying shop difficulty:', err);
        json(res, 500, { error: "Erreur lors de l'application de la difficulté." });
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/economy/items/:itemId
    if (parts.length === 7 && method === 'DELETE') {
      const itemId = parts[6];
      try {
        const { item, unequippedCount, cleanedMonsters } = await adminDeleteShopItem(guildId, itemId);

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Suppression objet boutique',
          context: getGuildName(client, guildId),
          module: 'Économie',
          eventType: 'Manuel',
          details: `Objet ${item.name} supprimé.${unequippedCount > 0 ? ` Déséquipé de ${unequippedCount} profil(s).` : ''}`
            + `${cleanedMonsters > 0 ? ` Retiré du butin de ${cleanedMonsters} créature(s).` : ''}`,
          channelId: null
        });

        json(res, 200, { success: true });
      } catch (err) {
        if (err instanceof Error && err.message === 'Objet introuvable.') {
          json(res, 404, { error: err.message });
          return true;
        }
        if (err instanceof Error && err.message.startsWith('Vous ne pouvez supprimer')) {
          json(res, 403, { error: err.message });
          return true;
        }
        logger.error('EconomyAPI', 'Error deleting shop item:', err);
        json(res, 500, { error: "Erreur lors de la suppression de l'objet." });
      }
      return true;
    }
  }

  // 3. Bestiaire (monstres et boss)
  if (subAction === 'monsters') {
    // GET /api/dashboard/guilds/:guildId/economy/monsters
    if (parts.length === 6 && method === 'GET') {
      try {
        const [monsters, config] = await Promise.all([
          listGuildMonsters(guildId, { includeDisabled: true }),
          getOrCreateEconomyConfig(guildId),
        ]);
        const difficulty = {
          boss: asDifficulty(config.bossDifficulty),
          monster: asDifficulty(config.monsterDifficulty),
        };

        // Le taux de victoire et la dérive ne servent qu'à la page de réglage : ils
        // accompagnent la liste plutôt que de coûter un aller-retour de plus.
        const [battles, drift] = await Promise.all([
          getBestiaryBattleStats(guildId, BATTLE_STATS_DAYS),
          findDifficultyDrift(monsters, difficulty),
        ]);

        const samples = {
          boss: summarizeBattles(monsters.filter((monster) => monster.isBoss), battles),
          monster: summarizeBattles(monsters.filter((monster) => !monster.isBoss), battles),
        };

        json(res, 200, {
          monsters: monsters.map((monster) => ({
            ...monster,
            drops: parseMonsterDrops(monster.drops),
            battles: battles[monster.name] ?? { battles: 0, wins: 0 },
            offDifficulty: drift[monster.id] ?? null,
          })),
          battleStatsDays: BATTLE_STATS_DAYS,
          samples,
          recommendations: {
            boss: recommendDifficulty(samples.boss),
            monster: recommendDifficulty(samples.monster),
          },
        });
      } catch (err) {
        logger.error('EconomyAPI', 'Error fetching monsters:', err);
        json(res, 500, { error: 'Erreur lors de la récupération du bestiaire.' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/economy/monsters (création ou personnalisation)
    if (parts.length === 6 && method === 'POST') {
      try {
        const body = await readJsonBody<MonsterInput & { id?: string }>(req);
        if (!body) {
          json(res, 400, { error: 'Corps de requête manquant.' });
          return true;
        }

        const { monster, created, overrode } = await saveGuildMonster(guildId, body, body.id);

        await pushAudit(guildId, {
          user: auditUser,
          action: created ? 'Création monstre RPG' : 'Modification monstre RPG',
          context: getGuildName(client, guildId),
          module: 'Économie',
          eventType: 'Manuel',
          details: `${monster.isBoss ? 'Boss' : 'Monstre'} : ${monster.name} (niv. ${monster.level})`
            + `${overrode ? ' - copie propre au serveur du monstre livré de base' : ''}`,
          channelId: null
        });

        json(res, 200, { monster: { ...monster, drops: parseMonsterDrops(monster.drops) } });
      } catch (err) {
        if (err instanceof BestiaryError) {
          json(res, err.status, { error: err.message });
          return true;
        }
        logger.error('EconomyAPI', 'Error saving monster:', err);
        json(res, 500, { error: 'Erreur lors de la sauvegarde du monstre.' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/economy/monsters/difficulty
    if (parts.length === 7 && parts[6] === 'difficulty' && method === 'POST') {
      try {
        const body = await readJsonBody<{ scope?: string; difficulty?: string; preview?: boolean }>(req);
        if (!body || (body.scope !== 'boss' && body.scope !== 'monster')) {
          json(res, 400, { error: "Champ « scope » manquant : « boss » ou « monster »." });
          return true;
        }
        if (!isDifficulty(body.difficulty)) {
          json(res, 400, { error: 'Palier de difficulté inconnu.' });
          return true;
        }

        const isBoss = body.scope === 'boss';
        const config = await getOrCreateEconomyConfig(guildId);
        const from = asDifficulty(isBoss ? config.bossDifficulty : config.monsterDifficulty);
        const dryRun = body.preview === true;

        const { updated, preview, protectedDrops } = await applyBestiaryDifficulty(
          guildId,
          { isBoss, from, to: body.difficulty, dryRun },
        );

        // Un essai à blanc ne change rien : le journaliser noierait les vraies
        // modifications sous les allers-retours de la page de réglage.
        if (!dryRun) {
          await pushAudit(guildId, {
            user: auditUser,
            action: 'Difficulté du bestiaire RPG',
            context: getGuildName(client, guildId),
            module: 'Économie',
            eventType: 'Manuel',
            details: `${isBoss ? 'Boss' : 'Monstres'} : ${from} vers ${body.difficulty}`
              + ` - ${updated} fiche(s) réécrite(s)`,
            channelId: null
          });
        }

        json(res, 200, { success: true, difficulty: body.difficulty, updated, preview, protectedDrops, dryRun });
      } catch (err) {
        if (err instanceof BestiaryError) {
          json(res, err.status, { error: err.message });
          return true;
        }
        logger.error('EconomyAPI', 'Error applying bestiary difficulty:', err);
        json(res, 500, { error: "Erreur lors de l'application de la difficulté." });
      }
      return true;
    }

    // GET /api/dashboard/guilds/:guildId/economy/monsters/export
    if (parts.length === 7 && parts[6] === 'export' && method === 'GET') {
      try {
        json(res, 200, await exportGuildBestiary(guildId));
      } catch (err) {
        logger.error('EconomyAPI', 'Error exporting bestiary:', err);
        json(res, 500, { error: "Erreur lors de l'export du bestiaire." });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/economy/monsters/import
    if (parts.length === 7 && parts[6] === 'import' && method === 'POST') {
      try {
        const body = await readJsonBody<unknown>(req);
        if (!body) {
          json(res, 400, { error: 'Corps de requête manquant.' });
          return true;
        }

        const report = await importGuildBestiary(guildId, body);

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Import du bestiaire RPG',
          context: getGuildName(client, guildId),
          module: 'Économie',
          eventType: 'Manuel',
          details: `${report.created} créature(s) ajoutée(s), ${report.updated} remplacée(s)`
            + `${report.droppedLoot > 0 ? ` - ${report.droppedLoot} butin(s) retiré(s), objet inconnu ici` : ''}`,
          channelId: null
        });

        json(res, 200, { success: true, ...report });
      } catch (err) {
        if (err instanceof BestiaryError) {
          json(res, err.status, { error: err.message });
          return true;
        }
        logger.error('EconomyAPI', 'Error importing bestiary:', err);
        json(res, 500, { error: "Erreur lors de l'import du bestiaire." });
      }
      return true;
    }

    // PATCH /api/dashboard/guilds/:guildId/economy/monsters/:monsterId (activation)
    if (parts.length === 7 && method === 'PATCH') {
      try {
        const body = await readJsonBody<{ enabled?: boolean }>(req);
        if (!body || typeof body.enabled !== 'boolean') {
          json(res, 400, { error: "Champ « enabled » manquant." });
          return true;
        }

        const monster = await setGuildMonsterEnabled(guildId, parts[6], body.enabled);

        await pushAudit(guildId, {
          user: auditUser,
          action: body.enabled ? 'Réactivation monstre RPG' : 'Désactivation monstre RPG',
          context: getGuildName(client, guildId),
          module: 'Économie',
          eventType: 'Manuel',
          details: `${monster.isBoss ? 'Boss' : 'Monstre'} : ${monster.name}`,
          channelId: null
        });

        json(res, 200, { monster: { ...monster, drops: parseMonsterDrops(monster.drops) } });
      } catch (err) {
        if (err instanceof BestiaryError) {
          json(res, err.status, { error: err.message });
          return true;
        }
        logger.error('EconomyAPI', 'Error toggling monster:', err);
        json(res, 500, { error: "Erreur lors de la mise à jour du monstre." });
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/economy/monsters/:monsterId
    if (parts.length === 7 && method === 'DELETE') {
      try {
        const { monster, restoredGlobal } = await deleteGuildMonster(guildId, parts[6]);

        await pushAudit(guildId, {
          user: auditUser,
          action: restoredGlobal ? 'Restauration monstre RPG par défaut' : 'Suppression monstre RPG',
          context: getGuildName(client, guildId),
          module: 'Économie',
          eventType: 'Manuel',
          details: `${monster.isBoss ? 'Boss' : 'Monstre'} : ${monster.name}`,
          channelId: null
        });

        json(res, 200, { success: true, restoredGlobal });
      } catch (err) {
        if (err instanceof BestiaryError) {
          json(res, err.status, { error: err.message });
          return true;
        }
        logger.error('EconomyAPI', 'Error deleting monster:', err);
        json(res, 500, { error: 'Erreur lors de la suppression du monstre.' });
      }
      return true;
    }
  }

  // 4. Quêtes RPG
  if (subAction === 'quests') {
    // GET /api/dashboard/guilds/:guildId/economy/quests
    if (parts.length === 6 && method === 'GET') {
      try {
        const quests = await listGuildQuests(guildId);
        json(res, 200, {
          quests: quests.map((quest) => ({
            ...quest,
            // La fin de fenêtre est calculée ici : elle depend de l'heure, pas de la fiche,
            // et le dashboard n'a pas a refaire ce calcul de son cote.
            windowEndsAt: questWindowBounds(quest.windowHours).endsAt,
          })),
          objectives: RPG_QUEST_OBJECTIVES,
          scopes: RPG_QUEST_SCOPES,
        });
      } catch (err) {
        logger.error('EconomyAPI', 'Error fetching quests:', err);
        json(res, 500, { error: 'Erreur lors de la récupération des quêtes.' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/economy/quests
    if (parts.length === 6 && method === 'POST') {
      try {
        const body = await readJsonBody<RpgQuestInput & { id?: string }>(req);
        if (!body) {
          json(res, 400, { error: 'Corps de requête manquant.' });
          return true;
        }

        const { quest, created } = await saveGuildQuest(guildId, body, body.id);

        await pushAudit(guildId, {
          user: auditUser,
          action: created ? 'Création quête RPG' : 'Modification quête RPG',
          context: getGuildName(client, guildId),
          module: 'Économie',
          eventType: 'Manuel',
          details: `${quest.name} - ${quest.objective} x${quest.target}`
            + `${quest.scope === 'TEAM' ? ' (équipe)' : ''}`,
          channelId: null
        });

        json(res, 200, { quest });
      } catch (err) {
        if (err instanceof QuestError) {
          json(res, err.status, { error: err.message });
          return true;
        }
        logger.error('EconomyAPI', 'Error saving quest:', err);
        json(res, 500, { error: 'Erreur lors de la sauvegarde de la quête.' });
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/economy/quests/:questId
    if (parts.length === 7 && method === 'DELETE') {
      try {
        const { name } = await deleteGuildQuest(guildId, parts[6]);

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Suppression quête RPG',
          context: getGuildName(client, guildId),
          module: 'Économie',
          eventType: 'Manuel',
          details: name,
          channelId: null
        });

        json(res, 200, { success: true });
      } catch (err) {
        if (err instanceof QuestError) {
          json(res, err.status, { error: err.message });
          return true;
        }
        logger.error('EconomyAPI', 'Error deleting quest:', err);
        json(res, 500, { error: 'Erreur lors de la suppression de la quête.' });
      }
      return true;
    }
  }

  // 5. Recettes d'artisanat
  if (subAction === 'recipes') {
    // GET /api/dashboard/guilds/:guildId/economy/recipes
    if (parts.length === 6 && method === 'GET') {
      try {
        json(res, 200, { recipes: await listGuildRecipes(guildId) });
      } catch (err) {
        logger.error('EconomyAPI', 'Error fetching recipes:', err);
        json(res, 500, { error: 'Erreur lors de la récupération des recettes.' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/economy/recipes (création ou modification)
    if (parts.length === 6 && method === 'POST') {
      try {
        const body = await readJsonBody<RecipeInput & { id?: string }>(req);
        if (!body) {
          json(res, 400, { error: 'Corps de requête manquant.' });
          return true;
        }

        const { recipe, created } = await saveGuildRecipe(guildId, body, body.id);

        await pushAudit(guildId, {
          user: auditUser,
          action: created ? 'Création recette RPG' : 'Modification recette RPG',
          context: getGuildName(client, guildId),
          module: 'Économie',
          eventType: created ? 'Création' : 'Modification',
          details: recipe.id,
          channelId: null
        });

        json(res, 200, { success: true, recipe });
      } catch (err) {
        if (err instanceof RecipeError) {
          json(res, err.status, { error: err.message });
          return true;
        }
        logger.error('EconomyAPI', 'Error saving recipe:', err);
        json(res, 500, { error: 'Erreur lors de la sauvegarde de la recette.' });
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/economy/recipes/:recipeId
    if (parts.length === 7 && method === 'DELETE') {
      try {
        const { name } = await deleteGuildRecipe(guildId, parts[6]);

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Suppression recette RPG',
          context: getGuildName(client, guildId),
          module: 'Économie',
          eventType: 'Suppression',
          details: name,
          channelId: null
        });

        json(res, 200, { success: true });
      } catch (err) {
        if (err instanceof RecipeError) {
          json(res, err.status, { error: err.message });
          return true;
        }
        logger.error('EconomyAPI', 'Error deleting recipe:', err);
        json(res, 500, { error: 'Erreur lors de la suppression de la recette.' });
      }
      return true;
    }
  }

  // 6. Raid hebdomadaire
  if (subAction === 'raid') {
    // GET /api/dashboard/guilds/:guildId/economy/raid
    if (parts.length === 6 && method === 'GET') {
      try {
        // Le catalogue livré est déposé à la première consultation : sans ça, une page de
        // réglage vide donnerait l'impression qu'il faut tout écrire soi-même.
        await seedGuildRaidBosses(guildId);
        const [bosses, state, recap, history] = await Promise.all([
          listGuildRaidBosses(guildId),
          getRaidState(guildId),
          // Sans borne d'âge : côté réglages, le bilan de la dernière fenêtre reste tant
          // que la suivante n'a pas ouvert, puisque c'est sur lui qu'on ajuste la prochaine.
          getRaidRecap(guildId),
          // L'historique, lui, ne périme pas : sans lui l'onglet se vidait dès que le
          // bilan expirait, sans plus rien dire des semaines passées.
          listRaidHistory(guildId),
        ]);

        // Le bilan ne porte que des identifiants : la page afficherait sinon une colonne de
        // nombres, là où le classement d'un raid n'a d'intérêt qu'avec des noms.
        // Un raid en cours chasse le bilan du précédent : c'est celui qui tourne qui
        // intéresse, et les deux côte à côte se confondraient.
        const discordGuild = client.guilds.cache.get(guildId);
        const recapWithNames = recap && !state.open && {
          ...recap,
          strikers: recap.strikers.map((striker) => ({
            ...striker,
            displayName: discordGuild?.members.cache.get(striker.userId)?.displayName
              ?? `Utilisateur ${striker.userId}`,
          })),
        };

        json(res, 200, {
          bosses,
          spells: RAID_SPELLS,
          state: {
            enabled: state.enabled,
            teamMode: state.teamMode,
            nextOpensAt: state.nextOpensAt,
            open: state.open,
            teams: state.open ? await listRaidTeams(state.open.id) : [],
          },
          recap: recapWithNames || null,
          history,
        });
      } catch (err) {
        logger.error('EconomyAPI', 'Error fetching raid:', err);
        json(res, 500, { error: 'Erreur lors de la récupération du raid.' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/economy/raid/bosses (création ou modification)
    if (parts.length === 7 && parts[6] === 'bosses' && method === 'POST') {
      try {
        const body = await readJsonBody<RaidBossInput & { id?: string }>(req);
        if (!body) {
          json(res, 400, { error: 'Corps de requête manquant.' });
          return true;
        }

        const { boss, created } = await saveGuildRaidBoss(guildId, body, body.id);

        await pushAudit(guildId, {
          user: auditUser,
          action: created ? 'Création boss de raid' : 'Modification boss de raid',
          context: getGuildName(client, guildId),
          module: 'Économie',
          eventType: 'Manuel',
          details: `${boss.name} (niv. ${boss.level})`,
          channelId: null
        });

        json(res, 200, { boss });
      } catch (err) {
        if (err instanceof RaidError) {
          json(res, err.status, { error: err.message });
          return true;
        }
        logger.error('EconomyAPI', 'Error saving raid boss:', err);
        json(res, 500, { error: 'Erreur lors de la sauvegarde du boss de raid.' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/economy/raid/seed (rétablit les fiches livrées)
    if (parts.length === 7 && parts[6] === 'seed' && method === 'POST') {
      try {
        const restored = await seedGuildRaidBosses(guildId);

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Restauration des boss de raid',
          context: getGuildName(client, guildId),
          module: 'Économie',
          eventType: 'Manuel',
          details: `${restored} boss livré(s) de base rétabli(s)`,
          channelId: null
        });

        json(res, 200, { success: true, restored });
      } catch (err) {
        logger.error('EconomyAPI', 'Error seeding raid bosses:', err);
        json(res, 500, { error: 'Erreur lors de la restauration des boss.' });
      }
      return true;
    }

    // POST /api/dashboard/guilds/:guildId/economy/raid/start (lancement manuel)
    if (parts.length === 7 && parts[6] === 'start' && method === 'POST') {
      try {
        const config = await getOrCreateEconomyConfig(guildId);
        const { id } = await startRaidNow(guildId, config);

        // L'annonce part tout de suite : le cycle l'aurait publiée, mais jusqu'à une
        // minute plus tard, et un lancement manuel se fait justement parce que l'équipe
        // est là maintenant.
        const raid = await getOpenRaid(guildId);
        if (raid) {
          await announceOpenRaid(client, raid, config.raidAnnounce, config.raidRoleId);
        }

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Lancement manuel du raid',
          context: getGuildName(client, guildId),
          module: 'Économie',
          eventType: 'Manuel',
          details: raid ? `${raid.bossName} jusqu'au ${raid.closesAt.toISOString()}` : id,
          channelId: null
        });

        json(res, 200, { success: true, raid });
      } catch (err) {
        if (err instanceof RaidError) {
          json(res, err.status, { error: err.message });
          return true;
        }
        logger.error('EconomyAPI', 'Error starting raid:', err);
        json(res, 500, { error: 'Erreur lors du lancement du raid.' });
      }
      return true;
    }

    // DELETE /api/dashboard/guilds/:guildId/economy/raid/bosses/:bossId
    if (parts.length === 8 && parts[6] === 'bosses' && method === 'DELETE') {
      try {
        const { name } = await deleteGuildRaidBoss(guildId, parts[7]);

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Suppression boss de raid',
          context: getGuildName(client, guildId),
          module: 'Économie',
          eventType: 'Manuel',
          details: name,
          channelId: null
        });

        json(res, 200, { success: true });
      } catch (err) {
        if (err instanceof RaidError) {
          json(res, err.status, { error: err.message });
          return true;
        }
        logger.error('EconomyAPI', 'Error deleting raid boss:', err);
        json(res, 500, { error: 'Erreur lors de la suppression du boss de raid.' });
      }
      return true;
    }
  }

  // 7. Players / Profiles Routes
  if (subAction === 'players') {
    // GET /api/dashboard/guilds/:guildId/economy/players
    if (parts.length === 6 && method === 'GET') {
      try {
        const players = await prisma.rpgProfile.findMany({
          where: { guildId },
          include: { rpgGuild: true },
          orderBy: { balance: 'desc' }
        });

        const items = await prisma.rpgItem.findMany({
          where: { OR: [{ guildId: null }, { guildId }] }
        });

        // Resolve Discord tags/usernames from cache if possible
        const discordGuild = client.guilds.cache.get(guildId);
        const playerDetails = players.map((player: unknown) => {
          const p = player as LocalPlayerProfile;
          const member = discordGuild?.members.cache.get(p.userId);
          const weapon = items.find(i => i.id === p.weaponId);
          const armor = items.find(i => i.id === p.armorId);
          return {
            ...p,
            username: member?.user?.username ?? `Utilisateur ${p.userId}`,
            displayName: member?.displayName ?? `Utilisateur ${p.userId}`,
            avatarUrl: resolveMemberAvatarUrl(member, 128),
            weapon: weapon ? { name: weapon.name, emoji: weapon.emoji, atkBonus: weapon.atkBonus } : null,
            armor: armor ? { name: armor.name, emoji: armor.emoji, defBonus: armor.defBonus } : null
          };
        });

        json(res, 200, { players: playerDetails });
      } catch (err) {
        logger.error('EconomyAPI', 'Error fetching players:', err);
        json(res, 500, { error: 'Erreur lors de la récupération des joueurs.' });
      }
      return true;
    }

    // PATCH /api/dashboard/guilds/:guildId/economy/players/:userId
    if (parts.length === 7 && method === 'PATCH') {
      const targetUserId = parts[6];
      try {
        const body = await readJsonBody<{
          balance?: number;
          level?: number;
          xp?: number;
          health?: number;
          energy?: number;
          attack?: number;
          defense?: number;
          speed?: number;
        }>(req);

        if (!body) {
          json(res, 400, { error: 'Corps de requête manquant.' });
          return true;
        }

        const profile = await prisma.rpgProfile.findUnique({
          where: { guildId_userId: { guildId, userId: targetUserId } }
        });

        if (!profile) {
          json(res, 404, { error: 'Profil RPG introuvable pour cet utilisateur.' });
          return true;
        }

        const updatedProfile = await prisma.rpgProfile.update({
          where: { id: profile.id },
          data: {
            balance: body.balance,
            level: body.level,
            xp: body.xp,
            health: body.health,
            energy: body.energy,
            attack: body.attack,
            defense: body.defense,
            speed: body.speed
          }
        });

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Modification profil RPG joueur',
          context: getGuildName(client, guildId),
          module: 'Économie',
          eventType: 'Manuel',
          details: `Modifié joueur ${targetUserId}. Solde: ${updatedProfile.balance}, Niveau: ${updatedProfile.level}`,
          channelId: null
        });

        json(res, 200, { player: updatedProfile });
      } catch (err) {
        logger.error('EconomyAPI', 'Error updating player profile:', err);
        json(res, 500, { error: 'Erreur lors de la mise à jour du profil du joueur.' });
      }
      return true;
    }
  }

  // 8. Reset Economy Route
  if (subAction === 'reset') {
    // POST /api/dashboard/guilds/:guildId/economy/reset
    if (parts.length === 6 && method === 'POST') {
      try {
        const body = await readJsonBody<{
          component: 'all' | 'profiles' | 'items' | 'config' | 'guilds' | 'bestiary';
        }>(req);

        if (!body || !body.component) {
          json(res, 400, { error: 'Composant de réinitialisation manquant.' });
          return true;
        }
        // Sans ce contrôle, un composant inconnu ne réinitialisait rien tout en repartant
        // avec un 200 et une entrée d'audit annonçant une remise à zéro qui n'a pas eu lieu.
        if (!RESET_COMPONENTS.has(body.component)) {
          json(res, 400, { error: 'Composant de réinitialisation inconnu.' });
          return true;
        }

        const { adminResetGuildEconomy } = await import('../../../services/features/economyService.js');
        const { restored } = await adminResetGuildEconomy(guildId, body.component);

        const componentLabels: Record<string, string> = {
          all: 'Global (tout réinitialiser)',
          profiles: 'Profils des joueurs',
          items: 'Objets de la boutique',
          config: 'Configuration',
          guilds: 'Guildes RPG',
          bestiary: 'Bestiaire du serveur'
        };

        await pushAudit(guildId, {
          user: auditUser,
          action: 'Réinitialisation Économie/RPG',
          context: getGuildName(client, guildId),
          module: 'Économie',
          eventType: 'Manuel',
          details: restored.players > 0
            ? `Composant réinitialisé : ${componentLabels[body.component] || body.component} - ${restored.coins} pièces de niveau restituées à ${restored.players} membre(s)`
            : `Composant réinitialisé : ${componentLabels[body.component] || body.component}`,
          channelId: null
        });

        json(res, 200, { success: true });
      } catch (err) {
        logger.error('EconomyAPI', 'Error resetting guild economy:', err);
        json(res, 500, { error: "Erreur lors de la réinitialisation de l'économie." });
      }
      return true;
    }
  }

  return false;
}
