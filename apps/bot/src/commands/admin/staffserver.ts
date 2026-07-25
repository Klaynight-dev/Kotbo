import type { SlashCommandDefinition } from '../../commands.js';
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
} from 'discord.js';
import { COLORS, successEmbed, errorEmbed } from '../../utils/embeds.js';
import {
  createStaffServerLink,
  removeStaffServerLink,
  listStaffServerLinks,
  addRoleMapping,
  removeRoleMapping,
  fullSyncStaffRoles,
  autoSetupRoleMappings,
} from '../../services/staff/staffServerService.js';
import { getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

function syncModeLabel(mode: string, locale: 'fr' | 'en'): string {
  switch (mode) {
    case 'MAIN_TO_STAFF':
      return m.b4_staffserver_mode_main_to_staff({}, { locale });
    case 'STAFF_TO_MAIN':
      return m.b4_staffserver_mode_staff_to_main({}, { locale });
    case 'BIDIRECTIONAL':
      return m.b4_staffserver_mode_bidirectional({}, { locale });
    default:
      return mode;
  }
}

const data = new SlashCommandBuilder()
  .setName('staffserver')
  .setDescription('Gérer les serveurs staff liés')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName('setup')
      .setDescription('Lier un serveur staff à ce serveur principal')
      .addStringOption((opt) =>
        opt.setName('serveur-staff').setDescription('ID du serveur staff').setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('mode')
          .setDescription('Mode de synchronisation des rôles')
          .setRequired(true)
          .addChoices(
            { name: 'Principal → Staff (hiérarchie ici, rôle simple là-bas)', value: 'MAIN_TO_STAFF' },
            { name: 'Staff → Principal (hiérarchie là-bas, rôle simple ici)', value: 'STAFF_TO_MAIN' },
            { name: 'Bidirectionnel (hiérarchie synchronisée des 2 côtés)', value: 'BIDIRECTIONAL' },
          ),
      )
      .addStringOption((opt) =>
        opt.setName('hierarchie').setDescription('ID de la hiérarchie staff (optionnel, toutes par défaut)'),
      )
      .addRoleOption((opt) =>
        opt.setName('role-staff-simple').setDescription('Rôle "Staff" simple sur le serveur sans hiérarchie'),
      )
      .addChannelOption((opt) =>
        opt
          .setName('log-principal')
          .setDescription('Salon de logs sur ce serveur')
          .addChannelTypes(ChannelType.GuildText),
      )
      .addStringOption((opt) =>
        opt.setName('log-staff').setDescription('ID du salon de logs sur le serveur staff'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('mapping')
      .setDescription('Ajouter un mapping de rôle entre les 2 serveurs')
      .addStringOption((opt) =>
        opt.setName('link-id').setDescription('ID du lien staff-server').setRequired(true),
      )
      .addRoleOption((opt) =>
        opt.setName('role-principal').setDescription('Rôle Discord sur ce serveur'),
      )
      .addStringOption((opt) =>
        opt.setName('role-staff').setDescription('ID du rôle Discord sur le serveur staff'),
      )
      .addStringOption((opt) =>
        opt.setName('staff-role-id').setDescription('ID du StaffRole en base (optionnel)'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('unmap')
      .setDescription('Supprimer un mapping de rôle')
      .addStringOption((opt) =>
        opt.setName('mapping-id').setDescription('ID du mapping à supprimer').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('Lister les liens serveur staff'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('sync')
      .setDescription('Forcer une synchronisation complète des rôles')
      .addStringOption((opt) =>
        opt.setName('link-id').setDescription('ID du lien à synchroniser').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Supprimer un lien serveur staff')
      .addStringOption((opt) =>
        opt.setName('link-id').setDescription('ID du lien à supprimer').setRequired(true),
      ),
  );

async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: true });

  switch (sub) {
    case 'setup':
      return handleSetup(interaction);
    case 'mapping':
      return handleMapping(interaction);
    case 'unmap':
      return handleUnmap(interaction);
    case 'list':
      return handleList(interaction);
    case 'sync':
      return handleSync(interaction);
    case 'remove':
      return handleRemove(interaction);
  }
}

async function handleSetup(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  const staffGuildId = interaction.options.getString('serveur-staff', true);
  const syncMode = interaction.options.getString('mode', true) as 'MAIN_TO_STAFF' | 'STAFF_TO_MAIN' | 'BIDIRECTIONAL';
  const hierarchyId = interaction.options.getString('hierarchie') ?? undefined;
  const simpleStaffRole = interaction.options.getRole('role-staff-simple');
  const logChannel = interaction.options.getChannel('log-principal');
  const staffLogChannelId = interaction.options.getString('log-staff') ?? undefined;

  const staffGuild = interaction.client.guilds.cache.get(staffGuildId);
  if (!staffGuild) {
    await interaction.editReply({
      embeds: [errorEmbed(m.b4_error({}, { locale }), m.b4_staffserver_bot_not_present({}, { locale }))],
    });
    return;
  }

  const result = await createStaffServerLink({
    mainGuildId: interaction.guildId!,
    staffGuildId,
    syncMode,
    hierarchyId,
    simpleStaffRoleId: simpleStaffRole?.id,
    mainLogChannelId: logChannel?.id,
    staffLogChannelId,
    createdByUserId: interaction.user.id,
  });

  if ('error' in result) {
    await interaction.editReply({ embeds: [errorEmbed(m.b4_error({}, { locale }), result.error)] });
    return;
  }

  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(COLORS.warning).setDescription(m.b4_staffserver_link_created_progress({}, { locale }))],
  });

  const roleSetup = await autoSetupRoleMappings(result, interaction.client);
  const syncResult = await fullSyncStaffRoles(result.id, interaction.client);

  const failedLine = roleSetup.failed > 0 ? m.b4_staffserver_setup_failed_line({ failed: roleSetup.failed }, { locale }) : '';

  const embed = successEmbed(
    m.b4_staffserver_setup_success_title({}, { locale }),
    m.b4_staffserver_setup_success_desc({
      staffName: staffGuild.name,
      syncMode: syncModeLabel(syncMode, locale),
      hierarchy: hierarchyId || m.b4_staffserver_all({}, { locale }),
      simpleRole: simpleStaffRole ? `<@&${simpleStaffRole.id}>` : m.b4_staffserver_not_configured({}, { locale }),
      linkId: result.id,
      matched: roleSetup.matched,
      created: roleSetup.created,
      staffName2: staffGuild.name,
      failedLine,
      synced: syncResult.synced,
      errors: syncResult.errors,
    }, { locale }),
  );

  await interaction.editReply({ embeds: [embed] });
}

async function handleMapping(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  const linkId = interaction.options.getString('link-id', true);
  const mainRole = interaction.options.getRole('role-principal');
  const staffRoleId = interaction.options.getString('role-staff');
  const staffRoleDbId = interaction.options.getString('staff-role-id');

  if (!mainRole && !staffRoleId) {
    await interaction.editReply({
      embeds: [errorEmbed(m.b4_error({}, { locale }), m.b4_staffserver_mapping_need_role({}, { locale }))],
    });
    return;
  }

  const mapping = await addRoleMapping({
    staffServerLinkId: linkId,
    staffRoleId: staffRoleDbId ?? undefined,
    mainDiscordRoleId: mainRole?.id,
    staffDiscordRoleId: staffRoleId ?? undefined,
  });

  const embed = successEmbed(
    m.b4_staffserver_mapping_added_title({}, { locale }),
    m.b4_staffserver_mapping_added_desc({
      mappingId: mapping.id,
      mainRole: mainRole ? `<@&${mainRole.id}>` : m.b4_staffserver_unspecified({}, { locale }),
      staffRole: staffRoleId ? `\`${staffRoleId}\`` : m.b4_staffserver_unspecified({}, { locale }),
    }, { locale }),
  );

  await interaction.editReply({ embeds: [embed] });
}

async function handleUnmap(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  const mappingId = interaction.options.getString('mapping-id', true);
  await removeRoleMapping(mappingId);

  await interaction.editReply({
    embeds: [successEmbed(m.b4_staffserver_mapping_removed_title({}, { locale }), m.b4_staffserver_mapping_removed_desc({ mappingId }, { locale }))],
  });
}

async function handleList(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  const links = await listStaffServerLinks(interaction.guildId!);

  if (links.length === 0) {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(COLORS.info).setDescription(m.b4_staffserver_none_linked({}, { locale }))],
    });
    return;
  }

  const lines = links.map((l) => {
    const isMain = l.mainGuildId === interaction.guildId;
    const otherGuildId = isMain ? l.staffGuildId : l.mainGuildId;
    const otherGuild = interaction.client.guilds.cache.get(otherGuildId);
    const statusIcon = l.enabled ? '🟢' : '🔴';
    const roleLabel = isMain ? m.b4_staffserver_role_main({}, { locale }) : m.b4_staffserver_role_staff({}, { locale });
    const mappingCount = l.roleMappings.length;

    return (
      `${statusIcon} \`${l.id.slice(0, 8)}\` **${otherGuild?.name || otherGuildId}** (${roleLabel})\n` +
      m.b4_staffserver_list_line_mode({ mode: syncModeLabel(l.syncMode, locale), mappingCount }, { locale })
    );
  });

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(m.b4_staffserver_list_title({}, { locale }))
    .setDescription(lines.join('\n\n'))
    .setFooter({ text: m.b4_staffserver_list_footer({ count: links.length }, { locale }) })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleSync(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  const linkId = interaction.options.getString('link-id', true);

  await interaction.editReply({
    embeds: [new EmbedBuilder().setColor(COLORS.warning).setDescription(m.b4_staffserver_sync_progress({}, { locale }))],
  });

  const result = await fullSyncStaffRoles(linkId, interaction.client);

  const embed = successEmbed(
    m.b4_staffserver_sync_done_title({}, { locale }),
    m.b4_staffserver_sync_done_desc({ synced: result.synced, errors: result.errors }, { locale }),
  );

  await interaction.editReply({ embeds: [embed] });
}

async function handleRemove(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  const linkId = interaction.options.getString('link-id', true);
  const deleted = await removeStaffServerLink(linkId);

  if (!deleted) {
    await interaction.editReply({ embeds: [errorEmbed(m.b4_error({}, { locale }), m.b4_staffserver_link_not_found({}, { locale }))] });
    return;
  }

  await interaction.editReply({
    embeds: [successEmbed(m.b4_staffserver_link_removed_title({}, { locale }), m.b4_staffserver_link_removed_desc({ linkId }, { locale }))],
  });
}

export const staffserverCommand = { data, execute } satisfies SlashCommandDefinition;
