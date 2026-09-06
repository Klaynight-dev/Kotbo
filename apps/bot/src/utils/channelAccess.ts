/**
 * Se rendre capable d'ecrire dans un salon avant d'y publier.
 *
 * La mise en place ferme le serveur entier a @everyone et rouvre chaque salon
 * a qui de droit, le bot compris. Mais tous les salons ne naissent pas de la
 * meme main : ceux des tickets viennent de leur propre service, le salon des
 * regles est repris a Discord plutot que cree, et un administrateur reste libre
 * de resserrer les droits apres coup. Le resultat etait un 403 opaque au moment
 * de publier - « Missing Access » sur le panneau de tickets, « Missing
 * Permissions » sur le reglement - alors que le bot a, sur le serveur, tout ce
 * qu'il faut pour se rouvrir la porte lui-meme.
 *
 * On la lui fait donc ouvrir. Poser la surcharge coute un appel, echoue
 * proprement quand « Gerer les roles » manque, et remplace une erreur illisible
 * par une phrase qui dit quelle permission donner.
 */
import {
  PermissionFlagsBits,
  type Guild,
  type GuildBasedChannel,
  type NonThreadGuildBasedChannel,
  type PermissionResolvable,
} from 'discord.js';
import { logger } from './logger.js';

/** Le minimum pour poster un panneau : le voir, y ecrire, y mettre un embed. */
const REQUIRED: PermissionResolvable[] = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ReadMessageHistory,
];

/**
 * Rend le salon utilisable par le bot, ou explique pourquoi il ne l'est pas.
 *
 * Ne touche a rien quand les droits sont deja la : le cas courant ne coute
 * aucun appel a Discord.
 */
export async function ensureBotCanPost(
  guild: Guild,
  channel: GuildBasedChannel,
  reason: string,
): Promise<void> {
  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  if (!me) return;

  // Un fil n'a pas de surcharges a lui : ce sont celles de son salon parent qui
  // decident, et c'est donc lui qu'il faudrait ouvrir. Aucun panneau ne se
  // publie dans un fil, on s'arrete la plutot que d'inventer un comportement.
  if (channel.isThread()) return;
  const target = channel as NonThreadGuildBasedChannel;

  const permissions = target.permissionsFor(me);
  const missing = permissions ? permissions.missing(REQUIRED) : REQUIRED;
  if (missing.length === 0) return;

  // Sans « Gerer les roles », poser la surcharge echouerait de toute facon :
  // autant nommer tout de suite la permission qui manque au serveur plutot que
  // celles qui manquent au salon.
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error(
      `Kotbo ne peut pas écrire dans #${target.name} `
      + `et n'a pas la permission « Gérer les rôles » pour s'y autoriser. `
      + `Donnez-lui l'accès à ce salon, ou la permission « Gérer les rôles » sur le serveur.`,
    );
  }

  try {
    await target.permissionOverwrites.edit(me.id, {
      ViewChannel: true,
      SendMessages: true,
      EmbedLinks: true,
      ReadMessageHistory: true,
    }, { reason });
    logger.info('ChannelAccess', `Surcharge posee pour Kotbo sur #${target.name} (${guild.id})`);
  } catch (err) {
    throw new Error(
      `Kotbo n'a pas pu s'ouvrir l'accès à #${target.name} : `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
