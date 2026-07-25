import { errorMessage } from '../../utils/errors.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, type AutocompleteInteraction, MessageFlags } from 'discord.js';

import { getOrCreateRpgProfile, consumePotionItem, equipInventoryItem } from '../../services/features/economyService.js';
import { errorEmbed, successEmbed } from '../../utils/embeds.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

interface LocalRpgItem {
  id: string;
  name: string;
  emoji: string;
  type: string;
}

interface LocalInventoryEntry {
  itemId: string;
  item: LocalRpgItem;
}

const meta = getCommandMetadata('b5_use');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addStringOption(option =>
    option
      .setName('objet')
      .setDescription(m.b5_use_opt_item({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b5_use_opt_item({}, { locale: 'fr' }) })
      .setRequired(true)
      .setAutocomplete(true)
  );

async function autocomplete(interaction: AutocompleteInteraction) {
  const focusedValue = interaction.options.getFocused().toLowerCase();
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  try {
    const profile = await getOrCreateRpgProfile(guildId, userId);
    const inventory = profile.inventory as unknown as LocalInventoryEntry[];

    const choices = inventory
      .map(entry => entry.item)
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
  const userId = interaction.user.id;
  const itemId = interaction.options.getString('objet', true);
  const locale = await getEffectiveLocale(interaction);

  try {
    const profile = await getOrCreateRpgProfile(guildId, userId);
    const selectedEntry = (profile.inventory as unknown as LocalInventoryEntry[]).find(
      entry => entry.itemId === itemId
    );

    if (!selectedEntry) {
      await interaction.reply({
        embeds: [errorEmbed(m.b5_use_not_found_title({}, { locale }), m.b5_use_not_found_desc({}, { locale }))],
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    const item = selectedEntry.item;

    if (item.type === 'POTION') {
      const result = await consumePotionItem(guildId, userId, itemId);
      await interaction.reply({
        embeds: [
          successEmbed(
            m.b5_use_potion_title({}, { locale }),
            m.b5_use_potion_desc({ name: result.itemName, hp: result.restoredHp, newHp: result.newHp, energy: result.restoredEnergy, newEnergy: result.newEnergy }, { locale })
          )
        ]
      });
    } else if (item.type === 'WEAPON' || item.type === 'ARMOR') {
      const result = await equipInventoryItem(guildId, userId, itemId);
      await interaction.reply({
        embeds: [
          successEmbed(
            m.b5_use_equip_title({}, { locale }),
            m.b5_use_equip_desc({ name: result.itemName, type: result.type === 'WEAPON' ? m.b5_use_type_weapon({}, { locale }) : m.b5_use_type_armor({}, { locale }) }, { locale })
          )
        ]
      });
    } else {
      await interaction.reply({
        embeds: [errorEmbed(m.b5_use_cannot_title({}, { locale }), m.b5_use_cannot_desc({ name: item.name }, { locale }))],
        flags: [MessageFlags.Ephemeral]
      });
    }
  } catch (err: unknown) {
    await interaction.reply({
      embeds: [errorEmbed(m.b5_err_title({}, { locale }), errorMessage(err) || m.b5_use_error({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
  }
}

export const useCommand = { data, execute, autocomplete } satisfies SlashCommandDefinition;
