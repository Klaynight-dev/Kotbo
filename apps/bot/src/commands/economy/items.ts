import { errorMessage } from '../../utils/errors.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { getOrCreateRpgProfile, getOrCreateEconomyConfig } from '../../services/features/economyService.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

interface LocalRpgItem {
  id: string;
  name: string;
  description: string;
  emoji: string;
  type: string;
}

interface LocalInventoryEntry {
  id: string;
  rpgProfileId: string;
  itemId: string;
  quantity: number;
  item: LocalRpgItem;
}

const data = new SlashCommandBuilder()
  .setName('items')
  .setDescription('🎒 Liste les objets que tu as achetés dans la boutique');

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const locale = await getEffectiveLocale(interaction);

  try {
    const profile = await getOrCreateRpgProfile(guildId, userId);
    const _config = await getOrCreateEconomyConfig(guildId);
    const inventory = profile.inventory as unknown as LocalInventoryEntry[];

    if (inventory.length === 0) {
      await interaction.reply({
        embeds: [
          errorEmbed(
            m.b3_items_empty_title({}, { locale }),
            m.b3_items_empty_desc({}, { locale })
          )
        ]
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(m.b3_items_title({}, { locale }))
      .setDescription(m.b3_items_desc({}, { locale }))
      .setColor(COLORS.primary)
      .setTimestamp();

    const list = inventory
      .map((entry) => {
        const item = entry.item;
        let desc = `${item.emoji} **${item.name}** (x${entry.quantity}) - *${item.type}*`;
        if (item.id === profile.weaponId) desc += m.b3_items_equipped_weapon({}, { locale });
        if (item.id === profile.armorId) desc += m.b3_items_equipped_armor({}, { locale });
        return desc;
      })
      .join('\n');

    embed.addFields({ name: m.b3_items_field_content({}, { locale }), value: list });

    await interaction.reply({ embeds: [embed] });
  } catch (err: unknown) {
    await interaction.reply({
      embeds: [errorEmbed(m.b3_error_title({}, { locale }), errorMessage(err) || m.b3_items_error_desc({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
  }
}

export const itemsCommand = { data, execute } satisfies SlashCommandDefinition;
