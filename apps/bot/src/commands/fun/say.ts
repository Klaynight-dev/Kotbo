import type { SlashCommandDefinition } from '../../commands.js';
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
  EmbedBuilder,
  PermissionFlagsBits,
  TextChannel,
} from 'discord.js';
import { errorEmbed, successEmbed, COLORS } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const COLOR_CHOICES = [
  { name: '🔵 Bleu (défaut)', value: 'blue' },
  { name: '🟢 Vert', value: 'green' },
  { name: '🔴 Rouge', value: 'red' },
  { name: '🟡 Jaune', value: 'yellow' },
  { name: '🟣 Violet', value: 'purple' },
  { name: '⚫ Sombre', value: 'dark' },
  { name: '⬜ Blanc', value: 'white' },
];

const COLOR_MAP: Record<string, number> = {
  blue: 0x5865f2,
  green: 0x57f287,
  red: 0xed4245,
  yellow: 0xfee75c,
  purple: 0x9b59b6,
  dark: 0x2b2d31,
  white: 0xffffff,
};

const data = new SlashCommandBuilder()
  .setName('say')
  .setDescription('📢 Envoyer un message en tant que bot dans un salon')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addStringOption(option =>
    option
      .setName('message')
      .setDescription('Le contenu du message à envoyer')
      .setRequired(true)
      .setMaxLength(4000),
  )
  .addChannelOption(option =>
    option
      .setName('salon')
      .setDescription('Le salon cible (défaut : salon actuel)')
      .setRequired(false),
  )
  .addStringOption(option =>
    option
      .setName('titre')
      .setDescription("Titre de l'embed — si renseigné, le message sera envoyé en embed")
      .setRequired(false)
      .setMaxLength(256),
  )
  .addStringOption(option =>
    option
      .setName('couleur')
      .setDescription("Couleur de l'embed (uniquement en mode embed)")
      .setRequired(false)
      .addChoices(...COLOR_CHOICES),
  )
  .addBooleanOption(option =>
    option
      .setName('anonyme')
      .setDescription("Masquer votre nom dans le footer de l'embed (défaut : false)")
      .setRequired(false),
  );

async function execute(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);

  if (!interaction.guildId) {
    await interaction.reply({
      embeds: [errorEmbed(m.b2_err_title({}, { locale }), m.b2_guild_only({}, { locale }))],
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const message = interaction.options.getString('message', true);
  const title = interaction.options.getString('titre') ?? null;
  const colorKey = interaction.options.getString('couleur') ?? 'blue';
  const anonyme = interaction.options.getBoolean('anonyme') ?? false;
  const targetChannel = interaction.options.getChannel('salon') ?? interaction.channel;

  if (!targetChannel || !(targetChannel instanceof TextChannel)) {
    await interaction.reply({
      embeds: [errorEmbed(m.b2_say_invalid_channel_title({}, { locale }), m.b2_say_invalid_channel_desc({}, { locale }))],
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  try {
    // Mode embed : uniquement si un titre est fourni ou une couleur/anonymat est demandé
    if (title || interaction.options.getString('couleur') || anonyme) {
      const color = COLOR_MAP[colorKey] ?? COLORS.primary;

      const embed = new EmbedBuilder()
        .setColor(color as unknown)
        .setDescription(message)
        .setTimestamp();

      if (title) {
        embed.setTitle(title);
      }

      if (!anonyme) {
        embed.setFooter({
          text: m.b2_say_footer({ user: interaction.user.displayName }, { locale }),
          iconURL: interaction.user.displayAvatarURL(),
        });
      }

      await targetChannel.send({ embeds: [embed] });
    } else {
      // Mode message simple : texte brut
      await targetChannel.send({ content: message });
    }

    await interaction.reply({
      embeds: [successEmbed(m.b2_say_sent_title({}, { locale }), m.b2_say_sent_desc({ channel: `<#${targetChannel.id}>` }, { locale }))],
      flags: [MessageFlags.Ephemeral],
    });

    logger.info('Say', `${interaction.user.tag} a envoyé un message dans #${targetChannel.name} (${interaction.guildId})`);
  } catch (error) {
    logger.error('Say', "Impossible d'envoyer le message :", error);
    await interaction.reply({
      embeds: [errorEmbed(m.b2_err_title({}, { locale }), m.b2_say_error({}, { locale }))],
      flags: [MessageFlags.Ephemeral],
    });
  }
}

export const sayCommand = { data, execute } satisfies SlashCommandDefinition;
