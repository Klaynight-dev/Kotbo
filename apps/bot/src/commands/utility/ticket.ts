import { errorMessage } from '../../utils/errors.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { ActionRowBuilder, SlashCommandBuilder, type ChatInputCommandInteraction, PermissionFlagsBits, MessageFlags, TextChannel, Role, User, type GuildMember, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } from 'discord.js';
import prisma from '../../utils/db.js';
import { canManageTicket, renameTicketChannel, renameChannelToOpen, closeTicket } from '../../services/features/ticketService.js';
import { buildMemberCasePanel } from '../../services/moderation/memberCaseService.js';
import { generateTranscript } from '../../services/features/transcriptService.js';
import { successEmbed } from '../../utils/embeds.js';
import { isGuildActivated } from '../../utils/activation.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('c7_ticket');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addSubcommand((subcommand) =>
    subcommand
      .setName('open')
      .setDescription(m.c7_ticket_open_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c7_ticket_open_desc({}, { locale: 'fr' }) })
      .addStringOption((opt) =>
        opt
          .setName('serveur')
          .setDescription(m.c7_ticket_open_opt_serveur_desc({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c7_ticket_open_opt_serveur_desc({}, { locale: 'fr' }) }),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('claim')
      .setDescription(m.c7_ticket_claim_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c7_ticket_claim_desc({}, { locale: 'fr' }) })
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('info')
      .setDescription(m.c7_ticket_info_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c7_ticket_info_desc({}, { locale: 'fr' }) })
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('close')
      .setDescription(m.c7_ticket_close_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c7_ticket_close_desc({}, { locale: 'fr' }) })
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('reopen')
      .setDescription(m.c7_ticket_reopen_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c7_ticket_reopen_desc({}, { locale: 'fr' }) })
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('delete')
      .setDescription(m.c7_ticket_delete_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c7_ticket_delete_desc({}, { locale: 'fr' }) })
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('rename')
      .setDescription(m.c7_ticket_rename_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c7_ticket_rename_desc({}, { locale: 'fr' }) })
      .addStringOption((option) =>
        option
          .setName('nom')
          .setDescription(m.c7_ticket_rename_opt_nom_desc({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c7_ticket_rename_opt_nom_desc({}, { locale: 'fr' }) })
          .setRequired(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('add')
      .setDescription(m.c7_ticket_add_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c7_ticket_add_desc({}, { locale: 'fr' }) })
      .addMentionableOption((option) =>
        option
          .setName('cible')
          .setDescription(m.c7_ticket_add_opt_cible_desc({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c7_ticket_add_opt_cible_desc({}, { locale: 'fr' }) })
          .setRequired(true)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName('remove')
      .setDescription(m.c7_ticket_remove_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c7_ticket_remove_desc({}, { locale: 'fr' }) })
      .addMentionableOption((option) =>
        option
          .setName('cible')
          .setDescription(m.c7_ticket_remove_opt_cible_desc({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c7_ticket_remove_opt_cible_desc({}, { locale: 'fr' }) })
          .setRequired(true)
      )
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const locale = await getEffectiveLocale(interaction);

  // ─── /ticket open — fonctionne en DM et en serveur ───────
  if (subcommand === 'open') {
    return handleOpen(interaction);
  }

  const guildId = interaction.guildId;
  const channel = interaction.channel;

  if (!guildId || !channel || !(channel instanceof TextChannel)) {
    await interaction.reply({
      content: m.c7_ticket_err_not_text_channel({}, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const guildConfig = await prisma.guild.findUnique({ where: { id: guildId } });
  if (!guildConfig) {
    await interaction.reply({
      content: m.c7_ticket_err_no_guild_config({}, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const ticket = await prisma.ticket.findFirst({
    where: {
      guildId,
      channelId: channel.id,
    },
  });

  if (!ticket) {
    await interaction.reply({
      content: m.c7_ticket_err_no_ticket({}, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const canRename = canManageTicket(interaction.member, guildConfig, ticket.staffRoleId) || ticket.userId === interaction.user.id;
  const isStaff = canManageTicket(interaction.member, guildConfig, ticket.staffRoleId);
  const isOpener = ticket.userId === interaction.user.id;

  async function getStaffLevel(guildId: string, userId: string): Promise<number> {
    const staff = await prisma.staffMember.findUnique({
      where: { guildId_userId: { guildId, userId } },
    });
    if (!staff) return 0;
    const role = await prisma.staffRole.findFirst({
      where: { guildId, name: staff.grade, enabled: true },
    });
    return role ? role.level : 0;
  }

  if (subcommand === 'claim') {
    if (!isStaff) {
      await interaction.reply({
        content: m.c7_ticket_claim_err_staff_only({}, { locale }),
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    const allowOverclaim = guildConfig.ticketAllowOverclaim ?? true;
    const overclaimPermission = guildConfig.ticketOverclaimPermission || 'ANY';

    if (ticket.status === 'CLAIMED') {
      if (!allowOverclaim || overclaimPermission === 'NONE') {
        await interaction.reply({
          content: m.c7_ticket_claim_err_already_claimed({ claimedById: ticket.claimedById ?? '' }, { locale }),
          flags: [MessageFlags.Ephemeral],
        });
        return;
      }

      if (ticket.claimedById === interaction.user.id) {
        await interaction.reply({
          content: m.c7_ticket_claim_err_self_claimed({}, { locale }),
          flags: [MessageFlags.Ephemeral],
        });
        return;
      }

      if (overclaimPermission === 'SUPERIOR_OR_EQUAL') {
        const member = interaction.member as GuildMember | null;
        const claimantIsAdmin = member?.permissions?.has(PermissionFlagsBits.Administrator) ?? false;

        if (!claimantIsAdmin) {
          const claimantLevel = await getStaffLevel(guildId, interaction.user.id);
          const currentLevel = ticket.claimedById ? await getStaffLevel(guildId, ticket.claimedById) : 0;

          if (claimantLevel < currentLevel) {
            await interaction.reply({
              content: m.c7_ticket_claim_err_insufficient_grade({}, { locale }),
              flags: [MessageFlags.Ephemeral],
            });
            return;
          }
        }
      }
    }

    await prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        status: 'CLAIMED',
        claimedById: interaction.user.id,
        claimedByName: interaction.user.username,
      },
    });

    await channel.send({
      embeds: [successEmbed(m.c7_ticket_claim_embed_title({}, { locale }), m.c7_ticket_claim_embed_desc({ userId: interaction.user.id }, { locale }))],
    }).catch(() => null);

    await interaction.reply({
      content: m.c7_ticket_claim_success({}, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  if (subcommand === 'info') {
    if (!isStaff) {
      await interaction.reply({
        content: m.c7_ticket_info_err_staff_only({}, { locale }),
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    try {
      const panel = await buildMemberCasePanel(interaction.guild!, ticket.userId, 'resume', 0);
      await interaction.editReply({
        components: panel.components,
        files: panel.files,
        flags: [MessageFlags.IsComponentsV2],
      });
    } catch {
      await interaction.editReply({
        content: m.c7_ticket_info_err_failed({}, { locale }),
      });
    }
    return;
  }

  if (subcommand === 'close') {
    if (!isOpener && !isStaff) {
      await interaction.reply({
        content: m.c7_ticket_close_err_no_permission({}, { locale }),
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    if (ticket.status === 'CLOSED') {
      await interaction.reply({
        content: m.c7_ticket_close_err_already_closed({}, { locale }),
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    await closeTicket(interaction.client, ticket.id, interaction.user.id, interaction.user.username);

    await interaction.reply({
      content: m.c7_ticket_close_success({}, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  if (subcommand === 'reopen') {
    if (!isStaff) {
      await interaction.reply({
        content: m.c7_ticket_reopen_err_staff_only({}, { locale }),
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    if (ticket.status !== 'CLOSED') {
      await interaction.reply({
        content: m.c7_ticket_reopen_err_not_closed({}, { locale }),
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    await prisma.ticket.update({
      where: { id: ticket.id },
      data: {
        status: 'OPEN',
        closedById: null,
        closedByName: null,
        closedAt: null,
      },
    });

    await channel.permissionOverwrites.edit(ticket.userId, {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
    }).catch(() => null);

    await renameChannelToOpen(interaction.client, channel.id).catch(() => null);

    await channel.send({
      embeds: [successEmbed(m.c7_ticket_reopen_embed_title({}, { locale }), m.c7_ticket_reopen_embed_desc({ userId: interaction.user.id }, { locale }))],
    }).catch(() => null);

    await interaction.reply({
      content: m.c7_ticket_reopen_success({}, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  if (subcommand === 'delete') {
    if (!isStaff) {
      await interaction.reply({
        content: m.c7_ticket_delete_err_staff_only({}, { locale }),
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    try {
      const transcriptData = await generateTranscript(channel);

      await prisma.ticket.update({
        where: { id: ticket.id },
        data: {
          channelId: null,
          status: 'CLOSED',
          transcriptId: transcriptData.id,
          closedById: interaction.user.id,
          closedByName: interaction.user.username,
          closedAt: new Date(),
        },
      });

      const dashboardUrl = process.env.DASHBOARD_URL || 'http://localhost:5173';
      const publicLink = `${dashboardUrl}/transcripts/${transcriptData.id}`;

      await channel.send({
        embeds: [successEmbed(m.c7_ticket_delete_embed_title({}, { locale }), m.c7_ticket_delete_embed_desc({ link: publicLink }, { locale }))],
      }).catch(() => null);

      await interaction.editReply({
        content: m.c7_ticket_delete_success({ link: publicLink }, { locale }),
      });

      setTimeout(async () => {
        await channel.delete(`Ticket supprimé par ${interaction.user.username} (Transcript ID: ${transcriptData.id})`).catch(() => null);
      }, 3000);
    } catch (error: unknown) {
      await interaction.editReply({
        content: m.c7_ticket_delete_err_failed({ error: errorMessage(error) || m.c7_ticket_unknown_error({}, { locale }) }, { locale }),
      });
    }
    return;
  }

  if (subcommand === 'add') {
    if (!isStaff) {
      await interaction.reply({
        content: m.c7_ticket_access_err_staff_only({}, { locale }),
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    const target = interaction.options.getMentionable('cible', true) as Role | GuildMember | User;
    const targetId = target.id;

    if (!targetId) {
      await interaction.reply({
        content: m.c7_ticket_err_invalid_target({}, { locale }),
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    try {
      await channel.permissionOverwrites.edit(targetId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
        EmbedLinks: true,
        AttachFiles: true,
      });

      const isRole = target instanceof Role;
      const mentionString = isRole ? `<@&${targetId}>` : `<@${targetId}>`;

      await channel.send({
        embeds: [successEmbed(m.c7_ticket_add_embed_title({}, { locale }), m.c7_ticket_add_embed_desc({ mention: mentionString, userId: interaction.user.id }, { locale }))],
      }).catch(() => null);

      await interaction.editReply({
        content: m.c7_ticket_add_success({ mention: mentionString }, { locale }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : m.c7_ticket_unknown_error({}, { locale });
      await interaction.editReply({
        content: m.c7_ticket_add_err_failed({ error: message }, { locale }),
      });
    }
    return;
  }

  if (subcommand === 'remove') {
    if (!isStaff) {
      await interaction.reply({
        content: m.c7_ticket_access_err_staff_only({}, { locale }),
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    const target = interaction.options.getMentionable('cible', true) as Role | GuildMember | User;
    const targetId = target.id;

    if (!targetId) {
      await interaction.reply({
        content: m.c7_ticket_err_invalid_target({}, { locale }),
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    if (targetId === ticket.userId) {
      await interaction.reply({
        content: m.c7_ticket_remove_err_owner({}, { locale }),
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    try {
      await channel.permissionOverwrites.delete(targetId);

      const isRole = target instanceof Role;
      const mentionString = isRole ? `<@&${targetId}>` : `<@${targetId}>`;

      await channel.send({
        embeds: [successEmbed(m.c7_ticket_remove_embed_title({}, { locale }), m.c7_ticket_remove_embed_desc({ mention: mentionString, userId: interaction.user.id }, { locale }))],
      }).catch(() => null);

      await interaction.editReply({
        content: m.c7_ticket_remove_success({ mention: mentionString }, { locale }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : m.c7_ticket_unknown_error({}, { locale });
      await interaction.editReply({
        content: m.c7_ticket_remove_err_failed({ error: message }, { locale }),
      });
    }
    return;
  }

  if (subcommand !== 'rename') {
    await interaction.reply({
      content: m.c7_ticket_err_unknown_subcommand({}, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  if (!canRename) {
    await interaction.reply({
      content: m.c7_ticket_rename_err_no_permission({}, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const requestedName = interaction.options.getString('nom', true);

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  try {
    const finalName = await renameTicketChannel(
      interaction.client,
      ticket,
      guildConfig,
      {
        id: interaction.user.id,
        username: interaction.user.username,
      },
      requestedName,
    );

    await interaction.editReply({
      content: m.c7_ticket_rename_success({ name: finalName }, { locale }),
    });
  } catch (error: unknown) {
    await interaction.editReply({
      content: m.c7_ticket_rename_err_failed({ error: errorMessage(error) || m.c7_ticket_unknown_error({}, { locale }) }, { locale }),
    });
  }
}

async function handleOpen(interaction: ChatInputCommandInteraction): Promise<void> {
  const locale = await getEffectiveLocale(interaction);
  const isDM = !interaction.guildId;
  const explicitGuildId = interaction.options.getString('serveur');

  let targetGuildId: string | null = null;

  if (isDM) {
    if (!explicitGuildId) {
      const mutualGuilds = interaction.client.guilds.cache.filter((g) => {
        try { return g.members.cache.has(interaction.user.id); } catch { return false; }
      });

      const activatedGuilds = [...mutualGuilds.values()].filter((g) => isGuildActivated(g.id));

      if (activatedGuilds.length === 0) {
        await interaction.reply({
          content: m.c7_ticket_open_err_no_guild_found({}, { locale }),
          flags: [MessageFlags.Ephemeral],
        });
        return;
      }

      if (activatedGuilds.length === 1) {
        targetGuildId = activatedGuilds[0].id;
      } else {
        const options = activatedGuilds.slice(0, 25).map((g) => ({
          label: g.name.slice(0, 100),
          value: g.id,
          description: m.c7_ticket_open_select_option_desc({ count: g.memberCount }, { locale }),
        }));

        const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('ticket:dm_guild_select')
            .setPlaceholder(m.c7_ticket_open_select_placeholder({}, { locale }))
            .addOptions(options),
        );

        await interaction.reply({
          content: m.c7_ticket_open_select_prompt({}, { locale }),
          components: [selectRow],
          flags: [MessageFlags.Ephemeral],
        });
        return;
      }
    } else {
      targetGuildId = explicitGuildId;
    }
  } else {
    targetGuildId = interaction.guildId!;
  }

  const guild = interaction.client.guilds.cache.get(targetGuildId!);
  if (!guild) {
    await interaction.reply({
      content: m.c7_ticket_open_err_bot_not_present({}, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const guildConfig = await prisma.guild.findUnique({ where: { id: targetGuildId! } });
  if (!guildConfig) {
    await interaction.reply({
      content: m.c7_ticket_open_err_guild_not_configured({}, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const existingTicket = await prisma.ticket.findFirst({
    where: {
      guildId: targetGuildId!,
      userId: interaction.user.id,
      status: { in: ['OPEN', 'CLAIMED'] },
    },
  });

  if (existingTicket) {
    await interaction.reply({
      content: m.c7_ticket_open_err_existing_ticket({ guildName: guild.name }, { locale }),
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`modal:ticket:open:dm_direct:${targetGuildId}`)
    .setTitle(m.c7_ticket_open_modal_title({ guildName: guild.name }, { locale }).slice(0, 45));

  const reasonInput = new TextInputBuilder()
    .setCustomId('reason')
    .setLabel(m.c7_ticket_open_modal_reason_label({}, { locale }))
    .setStyle(TextInputStyle.Short)
    .setPlaceholder(m.c7_ticket_open_modal_reason_placeholder({}, { locale }))
    .setMaxLength(100)
    .setRequired(true);

  const descInput = new TextInputBuilder()
    .setCustomId('description')
    .setLabel(m.c7_ticket_open_modal_desc_label({}, { locale }))
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder(m.c7_ticket_open_modal_desc_placeholder({}, { locale }))
    .setMaxLength(1000)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(descInput),
  );

  await interaction.showModal(modal);
}

export const ticketCommand = { data, execute } satisfies SlashCommandDefinition;
