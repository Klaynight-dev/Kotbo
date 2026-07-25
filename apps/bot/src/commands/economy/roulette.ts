import { errorMessage } from '../../utils/errors.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import prisma from '../../utils/db.js';
import { getOrCreateRpgProfile, getOrCreateEconomyConfig, registerGambleAttempt } from '../../services/features/economyService.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';

const data = new SlashCommandBuilder()
  .setName('roulette')
  .setDescription('🔫 Jouer à la roulette russe pour tenter de faire fructifier vos pièces (1/6 de danger)')
  .addIntegerOption(option =>
    option
      .setName('mise')
      .setDescription('Le montant à miser')
      .setRequired(true)
      .setMinValue(1)
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const bet = interaction.options.getInteger('mise', true);

  try {
    const config = await getOrCreateEconomyConfig(guildId);
    if (!config.enabled) {
      await interaction.reply({
        embeds: [errorEmbed('Module Désactivé', "Le système d'économie est désactivé sur ce serveur.")],
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    const profile = await getOrCreateRpgProfile(guildId, userId);
    if (profile.balance < bet) {
      await interaction.reply({
        embeds: [errorEmbed('Solde insuffisant', `Vous n'avez pas assez de pièces pour parier **${bet}** 🪙 (Solde actuel : **${profile.balance}** 🪙).`)],
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    if (profile.health <= 0) {
      await interaction.reply({
        embeds: [errorEmbed('Hors service', "Vous n'avez plus aucun point de vie (0 PV). Soignez-vous avec des potions avant de retenter votre chance !")],
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    await registerGambleAttempt(guildId, userId, bet);

    // Roll chamber (1 to 6)
    const firedChamber = 1;
    const rolledChamber = Math.floor(Math.random() * 6) + 1;

    const isShot = rolledChamber === firedChamber;
    let netGain = 0;
    let newHp = profile.health;
    let resultMessage = '';
    let embedColor = COLORS.success;

    if (isShot) {
      netGain = -bet;
      newHp = Math.max(0, profile.health - 50);
      resultMessage = `💥 **PAN ! Le coup part ! Vous perdez votre mise et perdez 50 PV...**`;
      embedColor = COLORS.danger;
    } else {
      // Survives: wins 1.2x their bet (20% gain)
      netGain = Math.floor(bet * 1.2) - bet;
      resultMessage = `🔫 *Clic... La chambre était vide. Vous survivez de justesse !*`;
      embedColor = COLORS.success;
    }

    const newBalance = profile.balance + netGain;

    await prisma.rpgProfile.update({
      where: { id: profile.id },
      data: {
        balance: newBalance,
        health: newHp
      }
    });

    const embed = new EmbedBuilder()
      .setTitle('🔫 Roulette Russe')
      .setDescription(
        `Vous placez le canon sur votre tempe et pressez la détente avec une mise de **${bet}** ${config.currencyEmoji}...\n\n` +
        `**Chambre testée :** ${rolledChamber}/6\n\n` +
        `${resultMessage}\n\n` +
        `**Gain net :** **${netGain >= 0 ? '+' : ''}${netGain}** ${config.currencyEmoji}\n` +
        `**Nouveau solde :** **${newBalance}** ${config.currencyEmoji}\n` +
        `**Vos PV restants :** **${newHp}** / ${profile.maxHealth} ❤️`
      )
      .setColor(embedColor)
      .setTimestamp();

    if (newHp <= 0 && isShot) {
      embed.addFields({ name: '💀 K.O.', value: 'Vous êtes tombé à 0 PV. Vous devez attendre que vos PV se restaurent passivement ou boire une potion de vie.' });
    }

    await interaction.reply({ embeds: [embed] });
  } catch (err: unknown) {
    await interaction.reply({
      embeds: [errorEmbed('Erreur', errorMessage(err) || 'Impossible de jouer à la roulette.')],
      flags: [MessageFlags.Ephemeral]
    });
  }
}

export const rouletteCommand = { data, execute } satisfies SlashCommandDefinition;
