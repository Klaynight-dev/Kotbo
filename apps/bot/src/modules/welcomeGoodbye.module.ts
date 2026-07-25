/**
 * Welcome/Goodbye Module — Bus-based subscriber
 *
 * Handles member join/leave/boost events via the bus.
 * applyJoinAutoRole needs the full GuildMember object, so it fetches
 * from Discord cache/API as needed.
 *
 * Le rôle "tag de serveur" est géré par tagRoleService.ts / raidProtection.ts
 * (basé sur l'API officielle Discord, pas sur un pattern de pseudo).
 */

import type { Client } from 'discord.js';
import { kotboEventBus } from '@kotbo/core';
import {
  handleGuildMemberAdd,
  handleGuildMemberRemove,
  handleGuildBoost,
  applyJoinAutoRole,
} from '../services/features/welcomeGoodbyeService.js';
import { handleWelcomeThread } from '../services/features/welcomeThreadService.js';
import { checkMemberCountTriggers } from '../services/core/ctfTriggerService.js';
import { syncMemberClanFromDcLink, autoAssignClanOnJoin, awardClanPointsOnBoost } from '../services/community/clanService.js';
import { logger } from '../utils/logger.js';

const MODULE_NAME = 'welcome-goodbye';

export function registerWelcomeGoodbyeBusSubscribers(client: Client): void {
  // ── Member Join ───────────────────────────────────────────────
  kotboEventBus.subscribe('member:join', async (payload) => {
    if (payload.isBot) return;

    const guild = client.guilds.cache.get(payload.guildId);
    if (!guild) return;

    const member = guild.members.cache.get(payload.userId)
      ?? await guild.members.fetch(payload.userId).catch(() => null);
    if (!member) return;

    await applyJoinAutoRole(member);
    await syncMemberClanFromDcLink(payload.guildId, payload.userId, null);
    await autoAssignClanOnJoin(payload.guildId, member);
    await handleGuildMemberAdd(member, client);
    await handleWelcomeThread(member, client);
    await checkMemberCountTriggers(guild, client);
  }, MODULE_NAME);

  // ── Member Leave ──────────────────────────────────────────────
  kotboEventBus.subscribe('member:leave', async (payload) => {
    const guild = client.guilds.cache.get(payload.guildId);
    if (!guild) return;

    const partialMember = {
      id: payload.userId,
      guild,
      user: { id: payload.userId, tag: payload.userTag, bot: payload.isBot },
    };

    await handleGuildMemberRemove(partialMember, client);
  }, MODULE_NAME);

  // ── Member Update (boost detection) ───────────────────────────
  kotboEventBus.subscribe('member:update', async (payload) => {
    if (!payload.isBoosting) return;

    const guild = client.guilds.cache.get(payload.guildId);
    if (!guild) return;

    const member = guild.members.cache.get(payload.userId)
      ?? await guild.members.fetch(payload.userId).catch(() => null);
    if (!member) return;

    await handleGuildBoost(member, client);
    await awardClanPointsOnBoost(payload.guildId, member);
  }, MODULE_NAME);

  logger.info('Modules', `Module "${MODULE_NAME}" enregistre sur le bus d'events.`);
}
