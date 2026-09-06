/**
 * Mode « liaison seule » (serveur invité).
 *
 * Un serveur peut être relié au pont d'un serveur activé **sans posséder de
 * code d'activation**. Il devient alors un « serveur invité » : le bot y est
 * présent uniquement pour faire passer les messages du pont, et rien d'autre.
 *
 * La garantie n'est pas déclarative, elle est structurelle. La garde
 * d'activation d'`index.ts` intercepte tous les événements Discord ; pour un
 * serveur invité, au lieu de les jeter, elle les repousse sur `linkRelayBus` -
 * un émetteur privé auquel **seuls** les écouteurs de relais (channelLinkEvents)
 * s'abonnent. Aucun autre module (analytics, leveling, logs, modération…) n'est
 * branché dessus : il leur est donc matériellement impossible de voir passer
 * quoi que ce soit venant d'un serveur invité, même par ajout futur d'un
 * `client.on()` quelque part.
 */

import { EventEmitter } from 'node:events';
import { Events } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getClient } from '../../utils/client.js';
import { isGuildActivated } from '../../utils/activation.js';

const TAG = 'ChannelLinkGuest';

/**
 * Bus privé du relais. Ne jamais y abonner autre chose que le relais de liens :
 * ce serait contourner l'isolement du mode liaison seule.
 */
export const linkRelayBus = new EventEmitter();

// Le pont peut relayer éditions, suppressions, réactions,
// frappe, épinglages et threads : ce sont exactement les événements dont il a
// besoin, et aucun autre ne franchit la garde pour un serveur invité.
export const RELAY_ONLY_EVENTS = new Set<string | symbol>([
  Events.MessageCreate,
  Events.MessageUpdate,
  Events.MessageDelete,
  Events.MessageReactionAdd,
  Events.TypingStart,
  Events.ChannelPinsUpdate,
  Events.ThreadCreate,
  Events.ThreadDelete,
]);

/** Serveurs reliés à un serveur activé mais dépourvus de code d'activation. */
export const linkGuestGuilds = new Set<string>();

/**
 * Recalcule l'ensemble des serveurs invités.
 *
 * Un serveur est invité si, et seulement si, il participe à un pont actif dont
 * au moins un autre membre appartient à un serveur activé. Autrement dit la
 * liaison est toujours l'extension d'une licence existante : des serveurs sans
 * code ne peuvent pas se relier entre eux pour obtenir un pont gratuit.
 */
export async function loadLinkGuestGuilds(): Promise<void> {
  try {
    const groups = await prisma.channelLinkGroup.findMany({
      where: { enabled: true },
      select: { members: { where: { enabled: true }, select: { guildId: true } } },
    });

    const guests = new Set<string>();
    for (const group of groups) {
      const guildIds = [...new Set(group.members.map((m) => m.guildId))];
      if (guildIds.length < 2) continue;
      if (!guildIds.some((id) => isGuildActivated(id))) continue;

      for (const guildId of guildIds) {
        if (!isGuildActivated(guildId)) guests.add(guildId);
      }
    }

    linkGuestGuilds.clear();
    for (const id of guests) linkGuestGuilds.add(id);

    logger.success(TAG, `Mode liaison seule : ${linkGuestGuilds.size} serveur(s) invité(s) en cache.`);
  } catch (error) {
    logger.error(TAG, 'Impossible de charger les serveurs en mode liaison seule :', error);
  }
}

/**
 * Recharge le cache et propage le résultat à tous les shards : un serveur ajouté à un
 * pont depuis le shard qui héberge le serveur A doit ouvrir le pont sur celui
 * qui héberge B.
 */
export async function refreshLinkGuestGuilds(): Promise<void> {
  await loadLinkGuestGuilds();

  try {
    const client = getClient();
    if (!client.shard) return;

    const modulePath = import.meta.url;
    await client.shard
      .broadcastEval(
        async (_c: unknown, context: { modulePath: string }) => {
          const m = await import(context.modulePath);
          await m.loadLinkGuestGuilds();
        },
        { context: { modulePath } },
      )
      .catch((err: unknown) => {
        logger.error(TAG, 'Impossible de propager le cache liaison seule aux shards :', err);
      });
  } catch {
    // Contextes sans client Discord (scripts CLI, tests) : le prochain
    // ClientReady rechargera le cache de toute façon.
  }
}

export function isLinkGuestGuild(guildId: string): boolean {
  return linkGuestGuilds.has(guildId);
}

/**
 * Aiguille un événement d'un serveur invité vers le relais, et lui seul.
 * Renvoie `true` si l'événement a été transmis au relais.
 */
export function dispatchLinkGuestEvent(eventName: string | symbol, args: unknown[]): boolean {
  if (!RELAY_ONLY_EVENTS.has(eventName)) return false;
  linkRelayBus.emit(eventName as string, ...args);
  return true;
}
