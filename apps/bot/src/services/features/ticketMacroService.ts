/**
 * Macros de ticket : reponses pre-ecrites, avec actions attachees.
 *
 * Quatre usages partagent ce service pour que le texte envoye et les actions
 * appliquees soient rigoureusement les memes d'une surface a l'autre :
 *  - le staff insere une macro depuis le selecteur du salon de ticket ;
 *  - une macro `autoSendOnOpen` est postee des l'ouverture ;
 *  - les macros dont un mot-cle correspond sont suggerees au staff ;
 *  - le dashboard les administre.
 */
import type { Client, Guild, GuildMember, TextBasedChannel } from 'discord.js';
import type { Ticket, TicketMacro } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

/** Nombre d'entrees tenables dans un selecteur Discord. */
export const MACRO_SELECT_LIMIT = 25;

/**
 * Substitutions offertes au texte d'une macro.
 *
 * Toute variable inconnue est laissee telle quelle : ecrire `{prix}` dans une
 * macro tarifaire doit rester possible sans que le bot ne l'efface.
 */
export function renderMacroContent(
  content: string,
  vars: {
    ticket: Pick<Ticket, 'id' | 'userId' | 'username' | 'ticketTypeLabel' | 'reason'>;
    staffTag: string;
    guildName: string;
  },
): string {
  const table: Record<string, string> = {
    user: `<@${vars.ticket.userId}>`,
    username: vars.ticket.username,
    staff: vars.staffTag,
    ticket_id: vars.ticket.id,
    ticket_type: vars.ticket.ticketTypeLabel || 'Ticket',
    ticket_reason: vars.ticket.reason || '',
    server: vars.guildName,
  };

  return content.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(table, key) ? table[key]! : match,
  );
}

/**
 * Macros utilisables dans ce ticket par ce membre du staff.
 *
 * Le tri met en tete les plus utilisees : dans un selecteur limite a 25 entrees,
 * ce sont celles-la qu'on veut voir sans chercher. `position` departage a usage
 * egal, pour que le staff garde la main sur l'ordre des macros neuves.
 */
export async function listUsableMacros(params: {
  guildId: string;
  ticketTypeId: string | null;
  staffRoleIds: string[];
}): Promise<TicketMacro[]> {
  const macros = await prisma.ticketMacro.findMany({
    where: { guildId: params.guildId, enabled: true },
    orderBy: [{ usageCount: 'desc' }, { position: 'asc' }, { name: 'asc' }],
  });

  return macros.filter((macro) => matchesTicketType(macro, params.ticketTypeId) && isAllowedFor(macro, params.staffRoleIds));
}

/** Une liste de ciblage vide vaut « tous » : c'est le reglage par defaut. */
function matchesTicketType(macro: TicketMacro, ticketTypeId: string | null): boolean {
  if (macro.ticketTypeIds.length === 0) return true;
  return ticketTypeId !== null && macro.ticketTypeIds.includes(ticketTypeId);
}

function isAllowedFor(macro: TicketMacro, staffRoleIds: string[]): boolean {
  if (macro.allowedRoleIds.length === 0) return true;
  return staffRoleIds.some((id) => macro.allowedRoleIds.includes(id));
}

/**
 * Macros dont un mot-cle apparait dans la demande du membre.
 *
 * La comparaison est faite sur du texte normalise (minuscules, sans accents) :
 * un membre qui ecrit « REMBOURSEMENT » doit declencher le mot-cle
 * « remboursement ». Le resultat est une suggestion, jamais une action.
 */
export function suggestMacros(macros: TicketMacro[], ticketText: string): TicketMacro[] {
  const haystack = normalize(ticketText);
  if (!haystack) return [];

  return macros.filter(
    (macro) => macro.keywords.length > 0 && macro.keywords.some((kw) => {
      const needle = normalize(kw);
      return needle.length > 0 && haystack.includes(needle);
    }),
  );
}

function normalize(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim();
}

export type MacroApplyResult = {
  /** Texte effectivement poste, deja substitue. */
  content: string;
  /** Actions realisees, pour le journal du ticket. */
  applied: string[];
  /** Vrai si la macro a ferme le ticket : l'appelant doit s'arreter la. */
  closed: boolean;
};

/**
 * Applique les actions attachees a une macro, apres l'envoi de son texte.
 *
 * Chaque action est isolee : une macro qui pose un role supprime depuis
 * l'interface Discord ne doit pas empecher la fermeture du ticket qui suit.
 * La fermeture vient en dernier, les autres actions ayant besoin d'un ticket
 * encore ouvert.
 */
export async function applyMacroActions(params: {
  client: Client;
  guild: Guild;
  macro: TicketMacro;
  ticket: Ticket;
  actor: { id: string; username: string };
}): Promise<string[]> {
  const { guild, macro, ticket } = params;
  const applied: string[] = [];

  if (macro.setTicketTypeId) {
    await prisma.ticket
      .update({ where: { id: ticket.id }, data: { ticketTypeId: macro.setTicketTypeId } })
      .then(() => applied.push(`type → ${macro.setTicketTypeId}`))
      .catch((err) => logger.error('TicketMacro', `Requalification impossible (${macro.id})`, err));
  }

  if (macro.addRoleId || macro.removeRoleId) {
    const member = await guild.members.fetch(ticket.userId).catch(() => null);
    if (member) {
      if (macro.addRoleId) {
        await grantRole(member, macro.addRoleId, 'add', applied);
      }
      if (macro.removeRoleId) {
        await grantRole(member, macro.removeRoleId, 'remove', applied);
      }
    }
  }

  if (macro.requestSatisfaction) {
    try {
      const { sendSatisfactionSurvey } = await import('./ticketSatisfactionService.js');
      await sendSatisfactionSurvey(params.client, guild.id, ticket.id, ticket.userId, params.actor.id);
      applied.push('enquête de satisfaction');
    } catch (err) {
      logger.error('TicketMacro', `Enquête de satisfaction impossible (${macro.id})`, err);
    }
  }

  return applied;
}

async function grantRole(
  member: GuildMember,
  roleId: string,
  direction: 'add' | 'remove',
  applied: string[],
): Promise<void> {
  const role = member.guild.roles.cache.get(roleId);
  // `editable` couvre a la fois la permission du bot et la hierarchie : sans ce
  // test, l'echec ne se voit qu'au log alors qu'il est previsible.
  if (!role || !role.editable) {
    logger.warn('TicketMacro', `Rôle ${roleId} absent ou non modifiable sur ${member.guild.id}`);
    return;
  }

  try {
    if (direction === 'add') {
      await member.roles.add(role, 'Macro de ticket');
      applied.push(`+@${role.name}`);
    } else {
      await member.roles.remove(role, 'Macro de ticket');
      applied.push(`-@${role.name}`);
    }
  } catch (err) {
    logger.error('TicketMacro', `Rôle ${roleId} non appliqué`, err);
  }
}

/** Incremente les compteurs d'usage. Un echec ici ne doit rien interrompre. */
export async function markMacroUsed(macroId: string): Promise<void> {
  await prisma.ticketMacro
    .update({
      where: { id: macroId },
      data: { usageCount: { increment: 1 }, lastUsedAt: new Date() },
    })
    .catch(() => null);
}

/**
 * Poste les macros a envoi automatique pour un ticket qui vient d'ouvrir.
 *
 * Leurs actions ne sont volontairement pas appliquees : une macro qui ferme le
 * ticket ou pose un role au moment meme de l'ouverture ferait plus de degats
 * qu'elle n'en previent. Seul le texte part.
 */
export async function sendAutoMacros(params: {
  channel: TextBasedChannel & { send: (options: { content: string }) => Promise<unknown> };
  guildId: string;
  guildName: string;
  ticket: Ticket;
}): Promise<void> {
  const macros = await prisma.ticketMacro.findMany({
    where: { guildId: params.guildId, enabled: true, autoSendOnOpen: true },
    orderBy: { position: 'asc' },
  });

  for (const macro of macros) {
    if (!matchesTicketType(macro, params.ticket.ticketTypeId)) continue;

    const content = renderMacroContent(macro.content, {
      ticket: params.ticket,
      staffTag: 'le staff',
      guildName: params.guildName,
    });

    await params.channel.send({ content }).catch((err) => {
      logger.error('TicketMacro', `Envoi automatique impossible (${macro.id})`, err);
    });
    await markMacroUsed(macro.id);
  }
}
