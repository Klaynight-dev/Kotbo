import { errorMessage } from '../../utils/errors.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, type Message, EmbedBuilder, MessageFlags } from 'discord.js';
import prisma from '../../utils/db.js';
import { getOrCreateRpgProfile, getOrCreateEconomyConfig } from '../../services/features/economyService.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const data = new SlashCommandBuilder()
  .setName('guess')
  .setDescription('🤔 Deviner un nombre mystère entre 1 et 100 pour gagner des pièces (7 essais)');

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const locale = await getEffectiveLocale(interaction);

  try {
    const config = await getOrCreateEconomyConfig(guildId);
    if (!config.enabled) {
      await interaction.reply({
        embeds: [errorEmbed(m.b3_module_disabled_title({}, { locale }), m.b3_economy_disabled_desc({}, { locale }))],
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    const secret = Math.floor(Math.random() * 100) + 1;
    let attempts = 0;
    const maxAttempts = 7;

    const initialEmbed = new EmbedBuilder()
      .setTitle(m.b3_guess_title({}, { locale }))
      .setDescription(m.b3_guess_intro({ maxAttempts }, { locale }))
      .setColor(COLORS.primary)
      .setFooter({ text: m.b3_guess_footer({}, { locale }) });

    await interaction.reply({ embeds: [initialEmbed] });

    const filter = (m: Message) => m.author.id === userId && !isNaN(parseInt(m.content, 10));
    const channel = interaction.channel;
    const collector = channel && 'createMessageCollector' in channel
      ? channel.createMessageCollector({
      filter,
          time: 60000 // 1 minute globale
        })
      : null;

    if (!collector) {
      await interaction.followUp({ content: m.b3_guess_no_collector({}, { locale }), flags: [MessageFlags.Ephemeral] });
      return;
    }

    collector.on('collect', async (msg) => {
      attempts++;
      const guess = parseInt(msg.content, 10);

      // Delete user's message to avoid cluttering if permissions allow, or just react / reply
      try {
        if (msg.deletable) await msg.delete();
      } catch {
        // Ignore delete errors
      }

      if (guess === secret) {
        collector.stop('win');
      } else if (attempts >= maxAttempts) {
        collector.stop('loss');
      } else {
        const hint = guess < secret ? m.b3_guess_hint_higher({}, { locale }) : m.b3_guess_hint_lower({}, { locale });
        await interaction.followUp({
          content: m.b3_guess_incorrect({ userId, guess, hint, attempts, maxAttempts }, { locale })
        });
      }
    });

    collector.on('end', async (_, reason) => {
      try {
        const profile = await getOrCreateRpgProfile(guildId, userId);

        if (reason === 'win') {
          // Reward formula: base 200 minus attempts
          const reward = Math.max(20, 200 - (attempts - 1) * 25);
          const newBalance = profile.balance + reward;

          await prisma.rpgProfile.update({
            where: { id: profile.id },
            data: { balance: newBalance }
          });

          const winEmbed = new EmbedBuilder()
            .setTitle(m.b3_guess_win_title({}, { locale }))
            .setDescription(m.b3_guess_win_desc({ secret, attempts, reward, currency: config.currencyEmoji, newBalance }, { locale }))
            .setColor(COLORS.success)
            .setTimestamp();

          await interaction.followUp({ embeds: [winEmbed] });
        } else if (reason === 'loss') {
          const lossEmbed = new EmbedBuilder()
            .setTitle(m.b3_guess_loss_title({}, { locale }))
            .setDescription(m.b3_guess_loss_desc({ maxAttempts, secret }, { locale }))
            .setColor(COLORS.danger)
            .setTimestamp();

          await interaction.followUp({ embeds: [lossEmbed] });
        } else {
          // Timeout
          const timeoutEmbed = new EmbedBuilder()
            .setTitle(m.b3_guess_timeout_title({}, { locale }))
            .setDescription(m.b3_guess_timeout_desc({ secret }, { locale }))
            .setColor(COLORS.warning)
            .setTimestamp();

          await interaction.followUp({ embeds: [timeoutEmbed] });
        }
      } catch (err: unknown) {
        // Handle end-of-collector db errors silently or log them
      }
    });
  } catch (err: unknown) {
    await interaction.reply({
      embeds: [errorEmbed(m.b3_error_title({}, { locale }), errorMessage(err) || m.b3_guess_start_error({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
  }
}

export const guessCommand = { data, execute } satisfies SlashCommandDefinition;
