import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { roleGrantsAdministrator } from '../../services/moderation/adminLockService.js';
import { getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const MAX_MENTIONS = 20;

const data = new SlashCommandBuilder()
  .setName('role')
  .setDescription('🎭 Gère les rôles des membres en masse')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addSubcommand((sub) =>
    sub
      .setName('add')
      .setDescription('Ajoute un rôle à plusieurs membres')
      .addRoleOption((option) =>
        option.setName('role').setDescription('Le rôle à ajouter').setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('membres')
          .setDescription('Mentionnez les membres (ex: @user1 @user2 @user3)')
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Retire un rôle à plusieurs membres')
      .addRoleOption((option) =>
        option.setName('role').setDescription('Le rôle à retirer').setRequired(true),
      )
      .addStringOption((option) =>
        option
          .setName('membres')
          .setDescription('Mentionnez les membres (ex: @user1 @user2 @user3)')
          .setRequired(true),
      ),
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const subcommand = interaction.options.getSubcommand() as 'add' | 'remove';
  const role = interaction.options.getRole('role', true);
  const membresRaw = interaction.options.getString('membres', true);
  const guild = interaction.guild;
  const locale = await getEffectiveLocale(interaction);

  if (!guild) {
    await interaction.reply({
      embeds: [errorEmbed(m.b2_action_impossible({}, { locale }), m.b2_guild_only({}, { locale }))],
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const userIds = [...new Set(membresRaw.match(/<@!?(\d+)>/g)?.map((mention) => mention.replace(/<@!?/, '').replace(/>/, '')) ?? [])];

  if (userIds.length === 0) {
    await interaction.reply({
      embeds: [errorEmbed(m.b2_role_no_member_title({}, { locale }), m.b2_role_no_member_desc({}, { locale }))],
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  if (userIds.length > MAX_MENTIONS) {
    await interaction.reply({
      embeds: [errorEmbed(m.b2_role_too_many_title({}, { locale }), m.b2_role_too_many_desc({ max: MAX_MENTIONS }, { locale }))],
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const botMember = guild.members.me;
  if (!botMember) {
    await interaction.reply({
      embeds: [errorEmbed(m.b2_err_title({}, { locale }), m.b2_role_bot_info_error({}, { locale }))],
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const guildRole = guild.roles.cache.get(role.id);
  if (!guildRole || guildRole.managed) {
    await interaction.reply({
      embeds: [errorEmbed(m.b2_role_invalid_title({}, { locale }), m.b2_role_invalid_desc({}, { locale }))],
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  if (guildRole.position >= botMember.roles.highest.position) {
    await interaction.reply({
      embeds: [errorEmbed(m.b2_role_insufficient_title({}, { locale }), m.b2_role_insufficient_desc({}, { locale }))],
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  // Admin Permission Lock — un octroi de rôle donnant ADMINISTRATOR peut être
  // bloqué et transformé en demande d'approbation (owner / rôles sécurité).
  if (subcommand === 'add' && roleGrantsAdministrator(guildRole.permissions.bitfield)) {
    const { guardAdminGrant } = await import('../../services/moderation/adminLockService.js');

    const pendingUserIds: string[] = [];
    const nonBlockedUserIds: string[] = [];
    for (const userId of userIds) {
      const result = await guardAdminGrant({
        client: interaction.client,
        guild,
        actorId: interaction.user.id,
        requestedByTag: interaction.user.tag,
        requestedVia: 'SLASH_COMMAND',
        type: 'MEMBER_ROLE_GRANT',
        permissionBits: guildRole.permissions.bitfield,
        targetRoleId: guildRole.id,
        targetRoleName: guildRole.name,
        targetMemberId: userId,
      });
      if (result.blocked) pendingUserIds.push(userId);
      else nonBlockedUserIds.push(userId);
    }

    if (pendingUserIds.length > 0) {
      const lines = [m.b2_role_admin_grant_warning({}, { locale })];
      lines.push(
        m.b2_role_admin_grant_pending({ count: pendingUserIds.length, users: pendingUserIds.map((id) => `<@${id}>`).join(', ') }, { locale }),
      );
      if (nonBlockedUserIds.length > 0) {
        for (const userId of nonBlockedUserIds) {
          await guild.members.fetch(userId).then((member) => member.roles.add(guildRole)).catch(() => null);
        }
        lines.push(
          m.b2_role_admin_grant_applied({ count: nonBlockedUserIds.length, users: nonBlockedUserIds.map((id) => `<@${id}>`).join(', ') }, { locale }),
        );
      }
      await interaction.editReply({ embeds: [successEmbed(m.b2_role_requests_sent({}, { locale }), lines.join('\n\n'))] });
      return;
    }
    // Personne bloqué (acteur owner/bypass, ou fonctionnalité désactivée) → flux normal ci-dessous.
  }

  const succeeded: string[] = [];
  const failed: string[] = [];

  for (const userId of userIds) {
    try {
      const member = await guild.members.fetch(userId);
      if (subcommand === 'add') {
        await member.roles.add(guildRole);
      } else {
        await member.roles.remove(guildRole);
      }
      succeeded.push(`<@${userId}>`);
    } catch {
      failed.push(`<@${userId}>`);
    }
  }

  const lines: string[] = [];

  if (succeeded.length > 0) {
    lines.push(
      subcommand === 'add'
        ? m.b2_role_added({ role: guildRole.toString(), count: succeeded.length, users: succeeded.join(', ') }, { locale })
        : m.b2_role_removed({ role: guildRole.toString(), count: succeeded.length, users: succeeded.join(', ') }, { locale })
    );
  }
  if (failed.length > 0) {
    lines.push(m.b2_role_failed({ count: failed.length, users: failed.join(', ') }, { locale }));
  }

  const embed = failed.length === 0
    ? successEmbed(m.b2_role_updated_title({}, { locale }), lines.join('\n\n'))
    : errorEmbed(m.b2_role_partial_title({}, { locale }), lines.join('\n\n'));

  await interaction.editReply({ embeds: [embed] });
}

export const roleCommand = { data, execute } satisfies SlashCommandDefinition;
