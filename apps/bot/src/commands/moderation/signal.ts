import {
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type UserContextMenuCommandInteraction,
  type Client,
  type User
} from 'discord.js';
import type { SlashCommandDefinition, ContextCommandDefinition } from '../../commands.js';
import { errorEmbed, successEmbed, COLORS } from '../../utils/embeds.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('b5_signal');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addUserOption((option) =>
    option
      .setName('membre')
      .setDescription(m.b5_signal_opt_member({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b5_signal_opt_member({}, { locale: 'fr' }) })
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName('raison')
      .setDescription(m.b5_signal_opt_reason({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b5_signal_opt_reason({}, { locale: 'fr' }) })
      .setRequired(true)
      .setMaxLength(1000),
  );

const contextData = new ContextMenuCommandBuilder()
  .setName(m.b5_signal_context_name({}, { locale: 'en' }))
  .setNameLocalizations({ fr: m.b5_signal_context_name({}, { locale: 'fr' }) })
  .setType(ApplicationCommandType.User);

export async function sendReportToAdmin(params: {
  client: Client;
  reporter: User;
  target: User;
  reason: string;
  guildName: string;
  guildId: string;
}): Promise<boolean> {
  const ownerId = process.env.DISCORD_CLIENT_OWNER_ID;
  if (!ownerId) {
    console.error('DISCORD_CLIENT_OWNER_ID non configuré.');
    return false;
  }

  try {
    const owner = await params.client.users.fetch(ownerId);
    if (!owner) return false;

    const embed = new EmbedBuilder()
      .setColor(COLORS.warning)
      .setTitle("🚨 Nouveau signalement d'utilisateur")
      .setDescription(`Un utilisateur a été signalé via le bot.`)
      .addFields(
        { name: 'Cible (Utilisateur signalé)', value: `${params.target} (\`${params.target.id}\` - @${params.target.username})`, inline: false },
        { name: 'Auteur du signalement', value: `${params.reporter} (\`${params.reporter.id}\` - @${params.reporter.username})`, inline: false },
        { name: 'Serveur (Guild)', value: `${params.guildName} (\`${params.guildId}\`)`, inline: false },
        { name: 'Raison', value: params.reason, inline: false }
      )
      .setTimestamp();

    await owner.send({ embeds: [embed] });
    return true;
  } catch (error) {
    console.error("Erreur lors de l'envoi du signalement à l'admin:", error);
    return false;
  }
}

async function executeSlash(interaction: ChatInputCommandInteraction): Promise<void> {
  const targetUser = interaction.options.getUser('membre', true);
  const reason = interaction.options.getString('raison', true);
  const locale = await getEffectiveLocale(interaction);

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  const guild = interaction.guild;
  const success = await sendReportToAdmin({
    client: interaction.client,
    reporter: interaction.user,
    target: targetUser,
    reason,
    guildName: guild?.name ?? 'Message Privé',
    guildId: guild?.id ?? 'N/A',
  });

  if (success) {
    await interaction.editReply({
      embeds: [successEmbed(m.b5_signal_sent_title({}, { locale }), m.b5_signal_sent_desc({ user: targetUser.toString() }, { locale }))],
    });
  } else {
    await interaction.editReply({
      embeds: [errorEmbed(m.b5_signal_failed_title({}, { locale }), m.b5_signal_failed_desc({}, { locale }))],
    });
  }
}

async function executeContext(interaction: UserContextMenuCommandInteraction): Promise<void> {
  const targetUser = interaction.targetUser;
  const locale = await getEffectiveLocale(interaction);

  const modal = new ModalBuilder()
    .setCustomId(`modal:signal:${targetUser.id}`)
    .setTitle(m.b5_signal_modal_title({ user: targetUser.username.slice(0, 20) }, { locale }));

  const reasonInput = new TextInputBuilder()
    .setCustomId('raison')
    .setLabel(m.b5_signal_modal_label({}, { locale }))
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder(m.b5_signal_modal_placeholder({}, { locale }))
    .setRequired(true)
    .setMaxLength(1000);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(reasonInput));

  await interaction.showModal(modal);
}

export const signalCommand = { data, execute: executeSlash } satisfies SlashCommandDefinition;
export const signalContextCommand = { data: contextData, execute: executeContext } satisfies ContextCommandDefinition;
