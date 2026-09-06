import {
  SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { getOrCreateFeatureConfigs, updateFeatureConfig } from '../../services/core/dashboardManagementService.js';
import { setDashboardModuleStatus } from '../../services/core/moduleActivationService.js';
import { successEmbed, errorEmbed } from '../../utils/embeds.js';
import { SlashCommandDefinition } from '../../commands.js';
import { getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('b5_suggestcfg');
const enableMeta = getCommandMetadata('b5_suggestcfg_enable');
const disableMeta = getCommandMetadata('b5_suggestcfg_disable');
const statusMeta = getCommandMetadata('b5_suggestcfg_status');
const sendEmbedMeta = getCommandMetadata('b5_suggestcfg_sendembed');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand
      .setName(enableMeta.name)
      .setNameLocalizations(enableMeta.nameLocalizations)
      .setDescription(enableMeta.description)
      .setDescriptionLocalizations(enableMeta.descriptionLocalizations)
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription(m.b5_suggestcfg_enable_opt_channel({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.b5_suggestcfg_enable_opt_channel({}, { locale: 'fr' }) })
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText)
      )
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName(disableMeta.name)
      .setNameLocalizations(disableMeta.nameLocalizations)
      .setDescription(disableMeta.description)
      .setDescriptionLocalizations(disableMeta.descriptionLocalizations)
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName(statusMeta.name)
      .setNameLocalizations(statusMeta.nameLocalizations)
      .setDescription(statusMeta.description)
      .setDescriptionLocalizations(statusMeta.descriptionLocalizations)
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName(sendEmbedMeta.name)
      .setNameLocalizations(sendEmbedMeta.nameLocalizations)
      .setDescription(sendEmbedMeta.description)
      .setDescriptionLocalizations(sendEmbedMeta.descriptionLocalizations)
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription(m.b5_suggestcfg_sendembed_opt_channel({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.b5_suggestcfg_sendembed_opt_channel({}, { locale: 'fr' }) })
          .setRequired(true)
          .addChannelTypes(ChannelType.GuildText)
      )
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: '❌ Cette commande doit être utilisée sur un serveur.',
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'enable') {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    const channel = interaction.options.getChannel('channel', true);

    try {
      await getOrCreateFeatureConfigs(guildId);
      // `setDashboardModuleStatus` et non la ligne de configuration : lui seul
      // propage la cascade, refuse un module hors offre et purge le cache que
      // la garde de lecture consulte.
      await setDashboardModuleStatus(guildId, 'suggestions', true);
      await updateFeatureConfig(guildId, 'suggestions', {
        channelId: channel.id,
      });

      await interaction.editReply({
        embeds: [
          successEmbed(
            'Module de suggestions activé',
            `Les suggestions seront envoyées dans <#${channel.id}>. Les membres peuvent utiliser la commande \`/suggest\` ou cliquer sur l'embed de suggestions.`
          ),
        ],
      });
    } catch (err) {
      await interaction.editReply({
        embeds: [errorEmbed('Erreur', "Impossible d'activer le module de suggestions.")],
      });
    }
  } else if (subcommand === 'disable') {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    try {
      await getOrCreateFeatureConfigs(guildId);
      await setDashboardModuleStatus(guildId, 'suggestions', false);
      await updateFeatureConfig(guildId, 'suggestions', {
        channelId: null,
      });

      await interaction.editReply({
        embeds: [
          successEmbed(
            'Module de suggestions désactivé',
            'Le système de suggestions est maintenant désactivé. Les membres ne pourront plus soumettre de suggestions.'
          ),
        ],
      });
    } catch (err) {
      await interaction.editReply({
        embeds: [errorEmbed('Erreur', 'Impossible de désactiver le module de suggestions.')],
      });
    }
  } else if (subcommand === 'status') {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    try {
      const configs = await getOrCreateFeatureConfigs(guildId);
      const config = configs.find((c) => c.featureKey === 'suggestions');

      if (!config) {
        await interaction.editReply({
          embeds: [errorEmbed('Erreur', 'Configuration introuvable.')],
        });
        return;
      }

      const statusText = config.enabled
        ? `✅ **Activé**\nSalon: ${config.channelId ? `<#${config.channelId}>` : 'Non configuré'}`
        : '❌ **Désactivé**';

      await interaction.editReply({
        embeds: [
          successEmbed('Statut du module de suggestions', statusText),
        ],
      });
    } catch (err) {
      await interaction.editReply({
        embeds: [errorEmbed('Erreur', 'Impossible de récupérer le statut.')],
      });
    }
  } else if (subcommand === 'send-embed') {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

    const channel = interaction.options.getChannel('channel', true);

    try {
      const configs = await getOrCreateFeatureConfigs(guildId);
      const config = configs.find((c) => c.featureKey === 'suggestions');

      if (!config || !config.enabled) {
        await interaction.editReply({
          embeds: [
            errorEmbed(
              'Module désactivé',
              "Le module de suggestions doit être activé avant d'envoyer l'embed. Utilisez `/suggestion-config enable`."
            ),
          ],
        });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('💡 Suggestions')
        .setDescription('Cliquez sur le bouton ci-dessous pour soumettre une suggestion pour améliorer le serveur.')
        .setColor('#FE75C2')
        .addFields(
          { name: 'Comment ça marche ?', value: '1. Cliquez sur le bouton\n2. Remplissez le formulaire\n3. Votre suggestion sera publiée et les membres pourront voter', inline: false },
          { name: 'Règles', value: '- Soyez constructif\n- Respectez les autres\n- Évitez les suggestions inappropriées', inline: false }
        )
        .setFooter({ text: 'Système de suggestions Kotbo' })
        .setTimestamp();

      const button = new ButtonBuilder()
        .setCustomId('suggest_form_open')
        .setLabel('📝 Soumettre une suggestion')
        .setStyle(ButtonStyle.Primary);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

      const targetChannel = interaction.guild?.channels.cache.get(channel.id);
      if (!targetChannel || !targetChannel.isTextBased()) {
        await interaction.editReply({
          embeds: [errorEmbed('Erreur', 'Salon introuvable ou invalide.')],
        });
        return;
      }

      await targetChannel.send({ embeds: [embed], components: [row], allowedMentions: { parse: [] } });

      await interaction.editReply({
        embeds: [
          successEmbed(
            'Embed envoyé',
            `L'embed de suggestions a été envoyé dans <#${channel.id}>.`
          ),
        ],
      });
    } catch (err) {
      await interaction.editReply({
        embeds: [errorEmbed('Erreur', "Impossible d'envoyer l'embed.")],
      });
    }
  }
}

export const suggestionConfigCommand = { data, execute } satisfies SlashCommandDefinition;
