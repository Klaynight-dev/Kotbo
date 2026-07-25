import { errorMessage } from '../../utils/errors.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import prisma from '../../utils/db.js';
import { getOrCreateRpgProfile, getOrCreateEconomyConfig, registerGambleAttempt } from '../../services/features/economyService.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const CHOICES = ['pierre', 'feuille', 'ciseaux'];

function choiceLabel(choice: string, locale: 'fr' | 'en'): string {
  if (choice === 'pierre') return m.b2_rps_rock({}, { locale });
  if (choice === 'feuille') return m.b2_rps_paper({}, { locale });
  return m.b2_rps_scissors({}, { locale });
}

const data = new SlashCommandBuilder()
  .setName('rps')
  .setDescription('🪨 Pierre, Feuille, Ciseaux pour parier et doubler vos pièces')
  .addStringOption(option =>
    option
      .setName('choix')
      .setDescription('Votre coup')
      .setRequired(true)
      .addChoices(
        { name: '🪨 Pierre', value: 'pierre' },
        { name: '📄 Feuille', value: 'feuille' },
        { name: '✂️ Ciseaux', value: 'ciseaux' }
      )
  )
  .addIntegerOption(option =>
    option
      .setName('mise')
      .setDescription('Le montant à parier')
      .setRequired(true)
      .setMinValue(1)
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const userChoice = interaction.options.getString('choix', true);
  const bet = interaction.options.getInteger('mise', true);
  const locale = await getEffectiveLocale(interaction);

  try {
    const config = await getOrCreateEconomyConfig(guildId);
    if (!config.enabled) {
      await interaction.reply({
        embeds: [errorEmbed(m.b2_economy_disabled_title({}, { locale }), m.b2_economy_disabled_desc({}, { locale }))],
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    const profile = await getOrCreateRpgProfile(guildId, userId);
    if (profile.balance < bet) {
      await interaction.reply({
        embeds: [errorEmbed(m.b2_insufficient_balance_title({}, { locale }), m.b2_rps_insufficient_desc({ bet, balance: profile.balance }, { locale }))],
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    await registerGambleAttempt(guildId, userId, bet);

    // Bot choice
    const botChoice = CHOICES[Math.floor(Math.random() * CHOICES.length)]!;

    let result = ''; // 'win', 'lose', 'draw'
    if (userChoice === botChoice) {
      result = 'draw';
    } else if (
      (userChoice === 'pierre' && botChoice === 'ciseaux') ||
      (userChoice === 'feuille' && botChoice === 'pierre') ||
      (userChoice === 'ciseaux' && botChoice === 'feuille')
    ) {
      result = 'win';
    } else {
      result = 'lose';
    }

    let multiplier = 0;
    let resultMessage = '';
    let embedColor = COLORS.info;

    if (result === 'win') {
      multiplier = 2;
      resultMessage = m.b2_rps_win({}, { locale });
      embedColor = COLORS.success;
    } else if (result === 'draw') {
      multiplier = 1;
      resultMessage = m.b2_rps_draw({}, { locale });
      embedColor = COLORS.info;
    } else {
      multiplier = 0;
      resultMessage = m.b2_rps_lose({}, { locale });
      embedColor = COLORS.danger;
    }

    const netGain = Math.floor(bet * multiplier) - bet;
    const newBalance = profile.balance + netGain;

    await prisma.rpgProfile.update({
      where: { id: profile.id },
      data: { balance: newBalance }
    });

    const embed = new EmbedBuilder()
      .setTitle(m.b2_rps_embed_title({}, { locale }))
      .setDescription(
        m.b2_rps_embed_desc({
          bet,
          emoji: config.currencyEmoji,
          userChoice: choiceLabel(userChoice, locale),
          botChoice: choiceLabel(botChoice, locale),
          result: resultMessage,
          netGain: `${netGain >= 0 ? '+' : ''}${netGain}`,
          newBalance,
        }, { locale })
      )
      .setColor(embedColor)
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  } catch (err: unknown) {
    await interaction.reply({
      embeds: [errorEmbed(m.b2_err_title({}, { locale }), errorMessage(err) || m.b2_rps_error({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
  }
}

export const rpsCommand = { data, execute } satisfies SlashCommandDefinition;
