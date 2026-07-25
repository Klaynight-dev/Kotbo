import { errorMessage } from '../../utils/errors.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags, EmbedBuilder } from 'discord.js';
import { work, getOrCreateEconomyConfig } from '../../services/features/economyService.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('b5_work');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations);

const WORK_MESSAGE_KEYS = [
  'b5_work_msg_1', 'b5_work_msg_2', 'b5_work_msg_3', 'b5_work_msg_4', 'b5_work_msg_5',
  'b5_work_msg_6', 'b5_work_msg_7', 'b5_work_msg_8', 'b5_work_msg_9', 'b5_work_msg_10',
] as const;

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const locale = await getEffectiveLocale(interaction);

  try {
    const result = await work(guildId, userId);
    const config = await getOrCreateEconomyConfig(guildId);

    if (result.cooldown) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            m.b5_work_tired_title({}, { locale }),
            m.b5_work_cooldown_desc({ minutes: result.remainingMinutes ?? 0, seconds: result.remainingSeconds ?? 0 }, { locale })
          )
        ],
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    const workMessageKey = WORK_MESSAGE_KEYS[Math.floor(Math.random() * WORK_MESSAGE_KEYS.length)]!;
    const workMessage = (m as unknown as Record<string, (args: object, opts: { locale: 'fr' | 'en' }) => string>)[workMessageKey]({}, { locale });

    const embed = new EmbedBuilder()
      .setTitle(m.b5_work_done_title({}, { locale }))
      .setDescription(m.b5_work_done_desc({ story: workMessage, salary: result.salary ?? 0, emoji: config.currencyEmoji, name: config.currencyName, xp: result.xpReward ?? 0 }, { locale }))
      .addFields({ name: m.b5_work_new_balance({}, { locale }), value: `**${result.newBalance}** ${config.currencyEmoji}` })
      .setColor(COLORS.success)
      .setTimestamp();

    if (result.levelUp) {
      embed.addFields({
        name: m.b5_work_levelup_title({}, { locale }),
        value: m.b5_work_levelup_desc({ level: result.levelUp }, { locale })
      });
    }

    await interaction.reply({ embeds: [embed] });
  } catch (err: unknown) {
    await interaction.reply({
      embeds: [errorEmbed(m.b5_err_title({}, { locale }), errorMessage(err) || m.b5_work_error({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
  }
}

export const workCommand = { data, execute } satisfies SlashCommandDefinition;
