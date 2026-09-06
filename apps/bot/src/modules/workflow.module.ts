import type { Client } from 'discord.js';
import { subscribeForModule } from '../services/core/moduleScope.js';
import { dispatchEvent } from '../services/features/workflow/workflowService.js';
import { logger } from '../utils/logger.js';

/**
 * Node Workflow Builder - pont entre le bus d'événements et le moteur.
 *
 * Module indépendant : s'il échoue, aucun autre module n'est affecté. Il ne
 * touche pas au système AutoResponse, qui continue de fonctionner en parallèle.
 */

const MODULE_NAME = 'workflow';

export function registerWorkflowBusSubscribers(client: Client): void {
  subscribeForModule('workflows', 'member:join', async (payload) => {
    if (payload.isBot) return;
    await dispatchEvent(client, payload.guildId, 'member:join', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'member:leave', async (payload) => {
    if (payload.isBot) return;
    await dispatchEvent(client, payload.guildId, 'member:leave', payload as never);
  }, MODULE_NAME);

  /**
   * Discord ne publie pas d'événement dédié aux rôles : `member:update`
   * transporte déjà les rôles gagnés et perdus, on en dérive donc deux
   * déclencheurs distincts plutôt que d'ajouter des publications au bus.
   */
  subscribeForModule('workflows', 'member:update', async (payload) => {
    if (payload.addedRoles.length > 0) {
      await dispatchEvent(client, payload.guildId, 'member:role-added', payload as never);
    }
    if (payload.removedRoles.length > 0) {
      await dispatchEvent(client, payload.guildId, 'member:role-removed', payload as never);
    }
  }, MODULE_NAME);

  subscribeForModule('workflows', 'message:new', async (payload) => {
    if (payload.isBot) return;
    await dispatchEvent(client, payload.guildId, 'message:new', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'reaction:add', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'reaction:add', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'voice:join', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'voice:join', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'voice:leave', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'voice:leave', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'sanction:applied', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'sanction:applied', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'ticket:created', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'ticket:created', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'level:up', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'level:up', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'bet:resolved', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'bet:resolved', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'bet:refunded', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'bet:refunded', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'clan:debt-opened', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'clan:debt-opened', payload as never);
  }, MODULE_NAME);

  subscribeForModule('workflows', 'clan:debt-cleared', async (payload) => {
    await dispatchEvent(client, payload.guildId, 'clan:debt-cleared', payload as never);
  }, MODULE_NAME);

  logger.info('Modules', `Module "${MODULE_NAME}" enregistré sur le bus d'events.`);
}
