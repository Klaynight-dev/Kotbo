import { errorMessage } from '../../utils/errors.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, type AutocompleteInteraction, MessageFlags, PermissionFlagsBits } from 'discord.js';
import prisma from '../../utils/db.js';
import { adminSpawnItem } from '../../services/features/economyService.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const data = new SlashCommandBuilder()
  .setName('spawn-item')
  .setDescription("⚙️ Faire apparaître un objet de la base de données dans l'inventaire de quelqu'un")
  .addUserOption(option =>
    option
      .setName('membre')
      .setDescription('Le membre cible')
      .setRequired(true)
  )
  .addStringOption(option =>
    option
      .setName('objet')
      .setDescription("L'objet à faire apparaître")
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addIntegerOption(option =>
    option
      .setName('quantite')
      .setDescription("La quantité d'objets à faire apparaître (défaut : 1)")
      .setRequired(false)
      .setMinValue(1)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

async function autocomplete(interaction: AutocompleteInteraction) {
  const focusedValue = interaction.options.getFocused().toLowerCase();
  const guildId = interaction.guildId!;

  try {
    const items = await prisma.rpgItem.findMany({
      where: {
        OR: [
          { guildId: null },
          { guildId }
        ]
      }
    });

    const choices = items
      .filter(item => item.name.toLowerCase().includes(focusedValue))
      .slice(0, 25)
      .map(item => ({
        name: `${item.emoji} ${item.name} (${item.type})`,
        value: item.id
      }));

    await interaction.respond(choices);
  } catch {
    await interaction.respond([]);
  }
}

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const targetUser = interaction.options.getUser('membre', true);
  const itemId = interaction.options.getString('objet', true);
  const quantity = interaction.options.getInteger('quantite') ?? 1;
  const locale = await getEffectiveLocale(interaction);

  if (targetUser.bot) {
    await interaction.reply({
      embeds: [errorEmbed(m.b3_error_title({}, { locale }), m.b3_spawnitem_bot_error({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
    return;
  }

  try {
    const result = await adminSpawnItem(guildId, targetUser.id, itemId, quantity);

    await interaction.reply({
      embeds: [
        successEmbed(
          m.b3_spawnitem_success_title({}, { locale }),
          m.b3_spawnitem_success_desc({ quantity, itemEmoji: result.itemEmoji, itemName: result.itemName, userId: targetUser.id }, { locale })
        )
      ]
    });
  } catch (err: unknown) {
    await interaction.reply({
      embeds: [errorEmbed(m.b3_error_title({}, { locale }), errorMessage(err) || m.b3_spawnitem_error_desc({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
  }
}

export const spawnItemCommand = { data, execute, autocomplete } satisfies SlashCommandDefinition;
