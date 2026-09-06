import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Message,
  type TextChannel,
} from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import type { WorkflowEffects } from './engine.js';
import {
  coerceToNumber,
  coerceToString,
  isChannel,
  isMember,
  isMessage,
  isRole,
  type ChannelValue,
  type MemberValue,
  type MessageValue,
  type RoleValue,
} from './values.js';

/**
 * Pont entre le moteur de workflows et Discord.
 *
 * Le moteur ne connaît que cette interface : tout ce qui touche à discord.js
 * ou à la base est isolé ici, ce qui laisse l'interpréteur testable sans bot.
 */

// ============================================================================
// CONVERSION DEPUIS DISCORD
// ============================================================================

export function toMemberValue(member: GuildMember): MemberValue {
  return {
    kind: 'Member',
    id: member.id,
    tag: member.user.tag,
    displayName: member.displayName,
    isBot: member.user.bot,
    roleIds: [...member.roles.cache.keys()],
    accountCreatedAt: member.user.createdTimestamp ?? null,
    joinedAt: member.joinedTimestamp ?? null,
  };
}

export function toRoleValue(role: { id: string; name: string }): RoleValue {
  return { kind: 'Role', id: role.id, name: role.name };
}

export function toChannelValue(channel: {
  id: string;
  name: string;
  parent?: { name: string } | null;
}): ChannelValue {
  return {
    kind: 'Channel',
    id: channel.id,
    name: channel.name,
    categoryName: channel.parent?.name ?? null,
  };
}

export function toMessageValue(message: {
  id: string;
  content: string;
  channelId: string;
  authorId: string;
}): MessageValue {
  return {
    kind: 'Message',
    id: message.id,
    content: message.content,
    channelId: message.channelId,
    authorId: message.authorId,
  };
}

// ============================================================================
// ACTIONS
// ============================================================================

/** Une action refusée par Discord doit remonter un message exploitable. */
class WorkflowActionError extends Error {
  constructor(action: string, detail: string) {
    super(`${action} : ${detail}`);
    this.name = 'WorkflowActionError';
  }
}

async function resolveMember(guild: Guild, value: unknown): Promise<GuildMember> {
  if (!isMember(value)) throw new WorkflowActionError('Membre', 'entrée absente ou invalide');
  const member = guild.members.cache.get(value.id) ?? await guild.members.fetch(value.id).catch(() => null);
  if (!member) throw new WorkflowActionError('Membre', `${value.tag} est introuvable sur le serveur`);
  return member;
}

async function resolveTextChannel(guild: Guild, value: unknown): Promise<TextChannel> {
  if (!isChannel(value)) throw new WorkflowActionError('Salon', 'entrée absente ou invalide');
  const channel = guild.channels.cache.get(value.id) ?? await guild.channels.fetch(value.id).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    throw new WorkflowActionError('Salon', `${value.name} est introuvable ou n'accepte pas de message`);
  }
  return channel as TextChannel;
}

function parseColor(raw: unknown): number {
  const value = coerceToString(raw).replace('#', '');
  const parsed = Number.parseInt(value, 16);
  return Number.isFinite(parsed) ? parsed : 0x5865f2;
}

/** Discord refuse tout contenu vide et tronque au-delà de 2000 caractères. */
function safeContent(raw: unknown, action: string): string {
  const text = coerceToString(raw).trim();
  if (!text) throw new WorkflowActionError(action, 'le texte est vide');
  return text.slice(0, 2000);
}

/**
 * Retrouve le vrai message Discord derrière la valeur transportée.
 *
 * Le moteur ne garde qu'un instantané sérialisable : agir dessus - supprimer,
 * épingler, réagir - demande de le recharger. Un message effacé entre-temps est
 * le cas normal, pas une anomalie du workflow, mais l'action ne peut pas
 * aboutir et le dit.
 */
async function resolveMessage(guild: Guild, value: unknown, action: string): Promise<Message> {
  if (!isMessage(value)) throw new WorkflowActionError(action, 'message absent ou invalide');

  const channel = guild.channels.cache.get(value.channelId)
    ?? await guild.channels.fetch(value.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    throw new WorkflowActionError(action, 'le salon du message est introuvable');
  }

  const message = await (channel as TextChannel).messages.fetch(value.id).catch(() => null);
  if (!message) throw new WorkflowActionError(action, 'le message n\'existe plus');
  return message;
}

/**
 * Identité portée par les sanctions qu'un workflow prononce.
 *
 * Elles sont enregistrées au nom du bot : le casier du membre, les statistiques
 * et les alertes du staff doivent montrer d'où vient la décision.
 */
function botActor(guild: Guild): { id: string; tag: string } {
  const me = guild.members.me;
  return { id: me?.id ?? guild.client.user?.id ?? '0', tag: me?.user.tag ?? 'Kotbo' };
}

/** Discord attend `nom:id` pour un émoji du serveur, l'unicode tel quel. */
function normalizeEmoji(raw: unknown): string {
  const value = coerceToString(raw).trim();
  if (!value) throw new WorkflowActionError('Réagir à un message', 'aucun émoji indiqué');
  const custom = value.match(/^<a?:(\w+):(\d+)>$/);
  return custom ? `${custom[1]}:${custom[2]}` : value;
}

/**
 * Charge le service de sanctions à la demande.
 *
 * En import statique, la chaîne `sanctionService` -> `dashboardApi` -> routes
 * -> `workflowService` reviendrait sur ce fichier. Le projet dénoue ce genre de
 * boucle par un import dynamique, comme le fait déjà `sanctionService` pour le
 * service de seuil de vérification.
 */
function sanctions() {
  return import('../../moderation/sanctionService.js');
}

export function createWorkflowEffects(guild: Guild): WorkflowEffects {
  return {
    async getRole(roleId) {
      if (!roleId) return null;
      const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
      return role ? toRoleValue(role) : null;
    },

    async getChannel(channelId) {
      if (!channelId) return null;
      const channel = guild.channels.cache.get(channelId)
        ?? await guild.channels.fetch(channelId).catch(() => null);
      return channel && 'name' in channel ? toChannelValue(channel) : null;
    },

    async getMember(userId) {
      if (!userId) return null;
      const member = guild.members.cache.get(userId)
        ?? await guild.members.fetch(userId).catch(() => null);
      return member ? toMemberValue(member) : null;
    },

    async getGuildInfo() {
      return { name: guild.name, memberCount: guild.memberCount };
    },

    async runAction(type, inputs, config) {
      switch (type) {
        case 'SendMessage': {
          const channel = await resolveTextChannel(guild, inputs.channel);
          await channel.send(safeContent(inputs.text, 'Envoyer un message'));
          return {};
        }

        case 'SendEmbed': {
          const channel = await resolveTextChannel(guild, inputs.channel);
          const embed = new EmbedBuilder().setColor(parseColor(config.color));
          const title = coerceToString(inputs.title).slice(0, 256);
          const description = coerceToString(inputs.description).slice(0, 4096);
          if (title) embed.setTitle(title);
          if (description) embed.setDescription(description);
          if (!title && !description) throw new WorkflowActionError('Envoyer un embed', 'titre et description vides');
          await channel.send({ embeds: [embed] });
          return {};
        }

        case 'SendDM': {
          const member = await resolveMember(guild, inputs.member);
          // Des MP fermés sont un cas normal, pas une erreur de workflow.
          await member.send(safeContent(inputs.text, 'Envoyer un message privé')).catch(() => {
            logger.debug('Workflow', `MP impossible vers ${member.user.tag} (messages privés fermés).`);
          });
          return {};
        }

        case 'AddRole':
        case 'RemoveRole': {
          const member = await resolveMember(guild, inputs.member);
          const roleValue = inputs.role;
          if (!isRole(roleValue)) throw new WorkflowActionError('Rôle', 'entrée absente ou invalide');

          const role = guild.roles.cache.get(roleValue.id) ?? await guild.roles.fetch(roleValue.id).catch(() => null);
          if (!role) throw new WorkflowActionError('Rôle', `${roleValue.name} est introuvable`);

          const me = guild.members.me;
          if (!me?.permissions.has(PermissionFlagsBits.ManageRoles) || role.position >= me.roles.highest.position) {
            throw new WorkflowActionError('Rôle', `le bot ne peut pas gérer ${role.name} (hiérarchie ou permission)`);
          }

          if (type === 'AddRole') await member.roles.add(role, 'Workflow');
          else await member.roles.remove(role, 'Workflow');
          return {};
        }

        case 'SetNickname': {
          const member = await resolveMember(guild, inputs.member);
          if (!member.manageable) {
            throw new WorkflowActionError('Changer le surnom', `${member.user.tag} est au-dessus du bot`);
          }
          await member.setNickname(coerceToString(inputs.nickname).slice(0, 32) || null, 'Workflow');
          return {};
        }

        /**
         * Les trois sanctions passent par `sanctionService` plutôt que par
         * discord.js seul : c'est lui qui tient le casier du membre, les
         * statistiques de modération, l'alerte du staff et la propagation aux
         * comptes liés. Agir en direct laissait ces actions sans aucune trace,
         * invisibles de la fiche membre comme des rapports.
         */
        case 'TimeoutMember': {
          const member = await resolveMember(guild, inputs.member);
          const minutes = Math.max(1, Math.min(40_320, coerceToNumber(inputs.minutes)));
          if (!member.moderatable) {
            throw new WorkflowActionError('Exclure temporairement', `${member.user.tag} ne peut pas être modéré`);
          }

          // `registerTimeoutSanction` applique l'exclusion elle-même.
          await (await sanctions()).registerTimeoutSanction({
            guildId: guild.id,
            target: { id: member.id, tag: member.user.tag },
            moderator: botActor(guild),
            reason: coerceToString(inputs.reason) || 'Automatisation',
            durationMs: minutes * 60_000,
            member,
            client: guild.client,
          });
          return {};
        }

        case 'KickMember': {
          const member = await resolveMember(guild, inputs.member);
          if (!member.kickable) {
            throw new WorkflowActionError('Expulser', `${member.user.tag} ne peut pas être expulsé`);
          }

          const reason = coerceToString(inputs.reason) || 'Automatisation';
          const target = { id: member.id, tag: member.user.tag };
          await member.kick(reason);
          await (await sanctions()).registerKickSanction({
            guildId: guild.id,
            target,
            moderator: botActor(guild),
            reason,
            client: guild.client,
          }).catch(() => null);
          return {};
        }

        case 'BanMember': {
          const member = await resolveMember(guild, inputs.member);
          if (!member.bannable) {
            throw new WorkflowActionError('Bannir', `${member.user.tag} ne peut pas être banni`);
          }

          const days = Math.max(0, Math.min(3650, coerceToNumber(inputs.days)));
          const reason = coerceToString(inputs.reason) || 'Automatisation';
          const target = { id: member.id, tag: member.user.tag };

          await member.ban({ reason, deleteMessageSeconds: 0 });
          await (await sanctions()).registerBanSanction({
            guildId: guild.id,
            target,
            moderator: botActor(guild),
            reason,
            // Zéro jour vaut bannissement définitif : le service choisit
            // BAN ou TEMP_BAN selon la présence d'une durée.
            temporaryDurationMs: days > 0 ? days * 86_400_000 : undefined,
            client: guild.client,
          }).catch(() => null);
          return {};
        }

        case 'DeleteMessage': {
          const message = await resolveMessage(guild, inputs.message, 'Supprimer un message');
          if (!message.deletable) {
            throw new WorkflowActionError('Supprimer un message', 'le bot n\'a pas le droit de le supprimer');
          }
          await message.delete();
          return {};
        }

        case 'AddReaction': {
          const message = await resolveMessage(guild, inputs.message, 'Réagir à un message');
          const emoji = normalizeEmoji(inputs.emoji);
          try {
            await message.react(emoji);
          } catch {
            // Un émoji d'un autre serveur ou mal orthographié : Discord répond
            // par une erreur peu lisible, on la reformule.
            throw new WorkflowActionError('Réagir à un message', `émoji « ${coerceToString(inputs.emoji)} » refusé par Discord`);
          }
          return {};
        }

        case 'PinMessage': {
          const message = await resolveMessage(guild, inputs.message, 'Épingler un message');
          if (message.pinned) return {};
          try {
            await message.pin();
          } catch {
            // Deux causes se ressemblent de l'extérieur : le plafond de
            // cinquante épingles par salon, et le droit manquant. Les nommer
            // toutes deux vaut mieux que d'en affirmer une au hasard.
            throw new WorkflowActionError(
              'Épingler un message',
              'refusé par Discord : salon plein (50 épingles) ou permission « Gérer les messages » manquante',
            );
          }
          return {};
        }

        case 'CreateThread': {
          const channel = await resolveTextChannel(guild, inputs.channel);
          const name = coerceToString(inputs.name).trim().slice(0, 100);
          if (!name) throw new WorkflowActionError('Ouvrir un fil', 'le nom du fil est vide');
          if (typeof channel.threads?.create !== 'function') {
            throw new WorkflowActionError('Ouvrir un fil', `${channel.name} n'accepte pas de fil`);
          }

          const thread = await channel.threads.create({
            name,
            autoArchiveDuration: 1440,
            reason: 'Automatisation',
          });
          return { thread: toChannelValue(thread) };
        }

        case 'CreateTicket': {
          const member = await resolveMember(guild, inputs.member);
          const subject = coerceToString(inputs.subject).slice(0, 100) || 'Ticket automatique';
          const channel = await createTicketChannel(guild, member, subject);
          return { channel: toChannelValue(channel) };
        }

        default:
          throw new WorkflowActionError(type, 'action inconnue');
      }
    },
  };
}

/**
 * Ouvre un salon de ticket au nom d'un membre.
 *
 * Le service de tickets historique part d'une interaction Discord, dont un
 * workflow ne dispose pas : on recrée donc ici le strict nécessaire, en
 * réutilisant la catégorie et le rôle staff configurés pour le serveur.
 */
async function createTicketChannel(guild: Guild, member: GuildMember, subject: string): Promise<TextChannel> {
  const config = await prisma.guild.findUnique({
    where: { id: guild.id },
    select: { ticketCategoryId: true, ticketStaffRoleId: true },
  });

  const channel = await guild.channels.create({
    name: `ticket-${member.user.username}`.slice(0, 100),
    type: ChannelType.GuildText,
    parent: config?.ticketCategoryId ?? undefined,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: member.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      },
      ...(config?.ticketStaffRoleId
        ? [{
          id: config.ticketStaffRoleId,
          allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
        }]
        : []),
    ],
  });

  await prisma.ticket.create({
    data: {
      guildId: guild.id,
      channelId: channel.id,
      mode: 'CHANNEL',
      userId: member.id,
      username: member.user.username,
      reason: subject,
      description: 'Ticket ouvert automatiquement par un workflow.',
      staffRoleId: config?.ticketStaffRoleId ?? null,
      categoryId: config?.ticketCategoryId ?? null,
    },
  });

  await channel.send({
    content: `${member}${config?.ticketStaffRoleId ? ` <@&${config.ticketStaffRoleId}>` : ''}`,
    embeds: [
      new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle('🎫 Ticket ouvert automatiquement')
        .setDescription(subject),
    ],
  }).catch(() => null);

  return channel;
}
