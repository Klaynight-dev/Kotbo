import { errorMessage } from '../../utils/errors.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, type AutocompleteInteraction, MessageFlags, PermissionFlagsBits } from 'discord.js';
import prisma from '../../utils/db.js';
import { adminRemoveItem } from '../../services/features/economyService.js';
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

const meta = getCommandMetadata('b5_removeitem');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addUserOption(option =>
    option
      .setName('membre')
      .setDescription(m.b5_removeitem_opt_member({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b5_removeitem_opt_member({}, { locale: 'fr' }) })
      .setRequired(true)
  )
  .addStringOption(option =>
    option
      .setName('objet')
      .setDescription(m.b5_removeitem_opt_item({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b5_removeitem_opt_item({}, { locale: 'fr' }) })
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addIntegerOption(option =>
    option
      .setName('quantite')
      .setDescription(m.b5_removeitem_opt_qty({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b5_removeitem_opt_qty({}, { locale: 'fr' }) })
      .setRequired(false)
      .setMinValue(1)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

async function autocomplete(interaction: AutocompleteInteraction) {
  const focusedValue = interaction.options.getFocused().toLowerCase();
  const guildId = interaction.guildId!;
  const targetUserOption = interaction.options.get('membre');
  const targetUserId = targetUserOption?.value as string | undefined;

  try {
    let items: LocalRpgItem[] = [];

    if (targetUserId) {
      // Autocomplete based on what the target user actually owns
      const profile = await prisma.rpgProfile.findUnique({
        where: { guildId_userId: { guildId, userId: targetUserId } },
        include: { inventory: { include: { item: true } } }
      });
      if (profile) {
        items = (profile.inventory as unknown as LocalInventoryEntry[]).map(entry => entry.item);
      }
    }

    if (items.length === 0) {
      // Fallback: all items in the guild/global
      items = await prisma.rpgItem.findMany({
        where: {
          OR: [
            { guildId: null },
            { guildId }
          ]
        }
      }) as unknown as LocalRpgItem[];
    }

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
      embeds: [errorEmbed(m.b5_err_title({}, { locale }), m.b5_removeitem_bot_target({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
    return;
  }

  try {
    const result = await adminRemoveItem(guildId, targetUser.id, itemId, quantity);

    await interaction.reply({
      embeds: [
        successEmbed(
          m.b5_removeitem_success_title({}, { locale }),
          m.b5_removeitem_success_desc({ quantity: result.removedQuantity, emoji: result.itemEmoji, name: result.itemName, user: `<@${targetUser.id}>`, remaining: result.remainingQuantity }, { locale })
        )
      ]
    });
  } catch (err: unknown) {
    await interaction.reply({
      embeds: [errorEmbed(m.b5_err_title({}, { locale }), errorMessage(err) || m.b5_removeitem_error({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
  }
}

export const removeItemCommand = { data, execute, autocomplete } satisfies SlashCommandDefinition;
