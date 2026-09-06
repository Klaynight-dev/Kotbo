/** Outils MCP - write tickets new (permission WRITE_TICKETS). */
import prisma from '../../../utils/db.js';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { z } from 'zod';
import { type McpToolContext, err, ok, resolveMember } from '../toolkit.js';
import { clampCommentTimeout } from '../../../services/features/ticketSatisfactionService.js';

export function registerWriteTicketsNewTools(ctx: McpToolContext) {
  const { server, guildId, client, shouldRegister, guard, audit, toolMeta } = ctx;

  // ── WRITE_TICKETS (NEW) ────────────────────────────────────────────────────
  if (shouldRegister('WRITE_TICKETS')) {
    // 1. create_ticket
    server.registerTool(
      'create_ticket',
      {
        description: 'Crée un ticket d\'assistance privé pour un membre et y ajoute des membres optionnels.',
        inputSchema: {
          opener: z.string().describe('ID Discord, mention, ou nom du créateur/bénéficiaire du ticket'),
          reason: z.string().describe('Sujet court du ticket'),
          description: z.string().describe('Description détaillée du problème'),
          extra_members: z.array(z.string()).default([]).describe('Membres supplémentaires à ajouter au salon (ID, mention, username)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_TICKETS', async ({ opener, reason, description, extra_members, key_name }) => {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return err('Serveur Discord introuvable');

        const resolvedOpener = await resolveMember(guildId, opener);
        if (!resolvedOpener.ok) return resolvedOpener.response;

        // Récupérer le membre Discord opener
        const openerMember = await guild.members.fetch(resolvedOpener.userId).catch(() => null);
        if (!openerMember) return err('Créateur du ticket introuvable sur Discord');

        // Récupérer la config du ticket
        const guildConfig = await prisma.guild.findUnique({
          where: { id: guildId },
          select: {
            ticketCategoryId: true,
            ticketLogChannelId: true,
            ticketStaffRoleId: true,
            ticketEmbedColor: true,
          }
        });

        // Configurer les permissions
        const permissionOverwrites: any[] = [
          {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel]
          },
          {
            id: resolvedOpener.userId,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.EmbedLinks,
              PermissionFlagsBits.AttachFiles
            ]
          }
        ];

        // Ajouter les membres supplémentaires
        const extraResolved: string[] = [];
        for (const rawMem of extra_members) {
          const resolved = await resolveMember(guildId, rawMem);
          if (resolved.ok) {
            permissionOverwrites.push({
              id: resolved.userId,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.EmbedLinks,
                PermissionFlagsBits.AttachFiles
              ]
            });
            extraResolved.push(resolved.label);
          }
        }

        // Ajouter le rôle staff si configuré
        const staffRoleId = guildConfig?.ticketStaffRoleId;
        if (staffRoleId) {
          permissionOverwrites.push({
            id: staffRoleId,
            allow: [
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessages,
              PermissionFlagsBits.ReadMessageHistory,
              PermissionFlagsBits.EmbedLinks,
              PermissionFlagsBits.AttachFiles,
              PermissionFlagsBits.ManageMessages
            ]
          });
        }

        try {
          const cleanedUsername = openerMember.user.username.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || 'membre';
          const chName = `ticket-${cleanedUsername}`;

          const ticketChannel = await guild.channels.create({
            name: chName,
            type: ChannelType.GuildText,
            parent: guildConfig?.ticketCategoryId || null,
            permissionOverwrites,
            reason: `Ticket créé via MCP pour ${openerMember.user.tag}`
          });

          // Créer le ticket en base de données
          const ticket = await prisma.ticket.create({
            data: {
              guildId,
              channelId: ticketChannel.id,
              userId: resolvedOpener.userId,
              username: openerMember.user.username,
              reason,
              description,
              status: 'OPEN'
            }
          });

          // Envoyer l'embed de bienvenue
          const welcomeEmbed = new EmbedBuilder()
            .setTitle(`🎫 Ticket d'Assistance · ${reason}`)
            .setDescription(`Bonjour <@${resolvedOpener.userId}> !\nUn membre du personnel va prendre en charge votre demande.\n\n**Description :**\n${description}\n\n${extraResolved.length > 0 ? `**Membres ajoutés :** ${extraResolved.map(m => `\`${m}\``).join(', ')}` : ''}`)
            .setColor(guildConfig?.ticketEmbedColor as any || 0x5865F2)
            .setTimestamp()
            .setFooter({ text: `Kotbo · Ticket ID: ${ticket.id}` });

          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder().setCustomId(`ticket:claim:${ticket.id}`).setLabel('Prendre en charge').setStyle(ButtonStyle.Primary).setEmoji('🛠️'),
            new ButtonBuilder().setCustomId(`ticket:info:${ticket.id}`).setLabel('Infos Membre').setStyle(ButtonStyle.Secondary).setEmoji('🔍'),
            new ButtonBuilder().setCustomId(`ticket:close:${ticket.id}`).setLabel('Fermer').setStyle(ButtonStyle.Danger).setEmoji('🔒')
          );

          await ticketChannel.send({
            content: `${staffRoleId ? `<@&${staffRoleId}> ` : ''}<@${resolvedOpener.userId}> 🔔 Bienvenue dans votre ticket d'assistance.`,
            embeds: [welcomeEmbed],
            components: [row]
          });

          await audit(key_name, 'Création ticket MCP', ticket.id, `Cible: ${openerMember.user.tag} | Salon: #${ticketChannel.name}`);
          return ok({ ok: true, ticketId: ticket.id, channelId: ticketChannel.id, channelName: ticketChannel.name });
        } catch (e) {
          return err(`Erreur lors de la création du ticket : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 2. get_ticket_system_config
    server.registerTool(
      'get_ticket_system_config',
      {
        description: 'Récupère la configuration globale du système de tickets sur le serveur.',
        inputSchema: {},
        _meta: toolMeta,
      },
      guard('WRITE_TICKETS', async () => {
        const guild = await prisma.guild.findUnique({
          where: { id: guildId },
          select: {
            ticketCategoryId: true,
            ticketLogChannelId: true,
            ticketStaffRoleId: true,
            ticketChannelId: true,
            ticketEmbedTitle: true,
            ticketEmbedDesc: true,
            ticketEmbedButtonText: true,
            ticketEmbedColor: true,
            ticketEmbedType: true,
            ticketMode: true,
            ticketDmRelayChannelId: true,
            ticketTypes: true,
            ticketAllowOverclaim: true,
            ticketInactivityEnabled: true,
            ticketInactivityHours: true,
            ticketSatisfactionCommentEnabled: true,
            ticketSatisfactionCommentQuestion: true,
            ticketSatisfactionCommentTimeout: true,
            ticketSatisfactionLogChannelId: true,
            ticketSatisfactionLogAnonymous: true,
          }
        });
        return ok(guild);
      })
    );

    // 3. update_ticket_system_config
    server.registerTool(
      'update_ticket_system_config',
      {
        description: 'Met à jour la configuration générale du système de tickets.',
        inputSchema: {
          category_id: z.string().optional().describe('Catégorie Discord où ranger les salons de tickets'),
          log_channel_id: z.string().optional().describe('Salon de logs des tickets'),
          staff_role_id: z.string().optional().describe('Rôle du staff par défaut pour gérer les tickets'),
          channel_id: z.string().optional().describe('Salon d\'ouverture des tickets (contenant le panel)'),
          mode: z.enum(['CHANNEL', 'DM', 'THREAD']).optional().describe('Mode de tickets (salon dédié, messages privés ou fil de discussion)'),
          embed_title: z.string().optional(),
          embed_desc: z.string().optional(),
          embed_button_text: z.string().optional(),
          embed_color: z.string().optional().describe('Couleur hexadécimale'),
          inactivity_enabled: z.boolean().optional(),
          inactivity_hours: z.number().int().min(1).optional(),
          satisfaction_comment_enabled: z.boolean().optional().describe('Poser une question commentaire facultative après la note du sondage de satisfaction'),
          satisfaction_comment_question: z.string().max(200).optional().describe('Question posée. Vide = texte par défaut dans la langue du serveur'),
          satisfaction_comment_timeout: z.number().int().min(30).max(900).optional().describe('Délai en secondes avant expiration du bouton de commentaire (30 à 900)'),
          satisfaction_log_channel_id: z.string().optional().describe('Salon où republier chaque avis de satisfaction en embed. Chaîne vide = relais désactivé'),
          satisfaction_log_anonymous: z.boolean().optional().describe("Masquer l'auteur de l'avis dans l'embed publié (le dashboard continue de l'afficher)"),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_TICKETS', async ({ category_id, log_channel_id, staff_role_id, channel_id, mode, embed_title, embed_desc, embed_button_text, embed_color, inactivity_enabled, inactivity_hours, satisfaction_comment_enabled, satisfaction_comment_question, satisfaction_comment_timeout, satisfaction_log_channel_id, satisfaction_log_anonymous, key_name }) => {
        try {
          await prisma.guild.update({
            where: { id: guildId },
            data: {
              ...(category_id !== undefined ? { ticketCategoryId: category_id || null } : {}),
              ...(log_channel_id !== undefined ? { ticketLogChannelId: log_channel_id || null } : {}),
              ...(staff_role_id !== undefined ? { ticketStaffRoleId: staff_role_id || null } : {}),
              ...(channel_id !== undefined ? { ticketChannelId: channel_id || null } : {}),
              ...(mode !== undefined ? { ticketMode: mode } : {}),
              ...(embed_title !== undefined ? { ticketEmbedTitle: embed_title } : {}),
              ...(embed_desc !== undefined ? { ticketEmbedDesc: embed_desc } : {}),
              ...(embed_button_text !== undefined ? { ticketEmbedButtonText: embed_button_text } : {}),
              ...(embed_color !== undefined ? { ticketEmbedColor: embed_color } : {}),
              ...(inactivity_enabled !== undefined ? { ticketInactivityEnabled: inactivity_enabled } : {}),
              ...(inactivity_hours !== undefined ? { ticketInactivityHours: inactivity_hours } : {}),
              ...(satisfaction_comment_enabled !== undefined ? { ticketSatisfactionCommentEnabled: satisfaction_comment_enabled } : {}),
              ...(satisfaction_comment_question !== undefined ? { ticketSatisfactionCommentQuestion: satisfaction_comment_question.trim().slice(0, 200) } : {}),
              ...(satisfaction_comment_timeout !== undefined ? { ticketSatisfactionCommentTimeout: clampCommentTimeout(satisfaction_comment_timeout) } : {}),
              ...(satisfaction_log_channel_id !== undefined ? { ticketSatisfactionLogChannelId: satisfaction_log_channel_id || null } : {}),
              ...(satisfaction_log_anonymous !== undefined ? { ticketSatisfactionLogAnonymous: satisfaction_log_anonymous } : {}),
            }
          });

          await audit(key_name, 'Configuration tickets MCP', 'Mise à jour des paramètres globaux', '');
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur de mise à jour: ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 4. create_ticket_type
    server.registerTool(
      'create_ticket_type',
      {
        description: 'Ajoute un nouveau type/sujet de ticket pour le sélecteur d\'ouverture de tickets.',
        inputSchema: {
          id: z.string().describe('ID unique du type (ex: "recrut")'),
          label: z.string().describe('Nom du bouton/menu (ex: "Recrutement")'),
          description: z.string().describe('Courte description de ce type de ticket'),
          category_id: z.string().optional().describe('Catégorie spécifique pour ranger ce type de ticket'),
          staff_role_id: z.string().optional().describe('Rôle staff spécifique pour ce type de ticket'),
          emoji: z.string().optional().describe('Emoji du type'),
          fields: z.array(z.object({
            id: z.string().describe('ID unique de l\'input/question'),
            label: z.string().describe('Intitulé de la question'),
            placeholder: z.string().optional().describe('Texte d\'aide / placeholder'),
            style: z.enum(['SHORT', 'PARAGRAPH']).default('SHORT').describe('Type d\'input (SHORT ou PARAGRAPH)'),
            required: z.boolean().default(true),
            max_length: z.number().int().optional(),
            min_length: z.number().int().optional(),
          })).optional().describe('Champs personnalisés du formulaire modal (max 5 champs)'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_TICKETS', async ({ id, label, description, category_id, staff_role_id, emoji, fields, key_name }) => {
        try {
          const guild = await prisma.guild.findUnique({ where: { id: guildId }, select: { ticketTypes: true } });
          const currentTypes: any[] = Array.isArray(guild?.ticketTypes) ? (guild.ticketTypes as any[]) : [];

          // Enlever si ID existe déjà pour mise à jour
          const filtered = currentTypes.filter(t => t.id !== id);
          filtered.push({
            id,
            label,
            description,
            categoryId: category_id || null,
            staffRoleId: staff_role_id || null,
            emoji: emoji || null,
            fields: fields || null,
          });

          await prisma.guild.update({
            where: { id: guildId },
            data: { ticketTypes: filtered }
          });

          await audit(key_name, 'Configuration tickets MCP', `Nouveau type de ticket: ${label}`, `ID: ${id}`);
          return ok({ ok: true, ticketTypes: filtered });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    // 5. setup_ticket_system_message
    server.registerTool(
      'setup_ticket_system_message',
      {
        description: 'Envoie l\'embed d\'ouverture officiel avec les boutons/sélecteurs dans le salon de support.',
        inputSchema: {
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_TICKETS', async ({ key_name }) => {
        try {
          const { sendTicketSetupEmbed } = await import('../../../services/features/ticketService.js');
          await sendTicketSetupEmbed(client, guildId);

          await audit(key_name, 'Configuration tickets MCP', 'Embed d\'ouverture de tickets envoyé', '');
          return ok({ ok: true });
        } catch (e) {
          return err(`Erreur d'envoi du panel : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );

    server.registerTool(
      'delete_ticket_type',
      {
        description: 'Supprime un type/sujet de ticket configuré. Requiert WRITE_TICKETS.',
        inputSchema: {
          id: z.string().describe('ID unique du type de ticket à supprimer'),
          key_name: z.string().optional(),
        },
        _meta: toolMeta,
      },
      guard('WRITE_TICKETS', async ({ id, key_name }) => {
        try {
          const guild = await prisma.guild.findUnique({ where: { id: guildId }, select: { ticketTypes: true } });
          const currentTypes: any[] = Array.isArray(guild?.ticketTypes) ? (guild.ticketTypes as any[]) : [];

          const filtered = currentTypes.filter(t => t.id !== id);

          await prisma.guild.update({
            where: { id: guildId },
            data: { ticketTypes: filtered }
          });

          await audit(key_name, 'Configuration tickets MCP', `Type de ticket supprimé: ${id}`, `ID: ${id}`);
          return ok({ ok: true, ticketTypes: filtered });
        } catch (e) {
          return err(`Erreur : ${e instanceof Error ? e.message : String(e)}`);
        }
      })
    );
  }
}
