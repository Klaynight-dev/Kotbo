import { errorMessage } from '../../utils/errors.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import prisma from '../../utils/db.js';
import { getOrCreateEconomyConfig, getOrCreateRpgProfile } from '../../services/features/economyService.js';
import { errorEmbed, COLORS } from '../../utils/embeds.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

interface LocalRpgItem {
  id: string;
  name: string;
  description: string;
  emoji: string;
  type: string;
  atkBonus: number;
  defBonus: number;
  spdBonus: number;
  hpRestore: number;
  energyRestore: number;
  price: number;
}

const meta = getCommandMetadata('b5_shop');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations);

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const locale = await getEffectiveLocale(interaction);

  try {
    const config = await getOrCreateEconomyConfig(guildId);
    const profile = await getOrCreateRpgProfile(guildId, userId);

    const items = await prisma.rpgItem.findMany({
      where: {
        OR: [
          { guildId: null },
          { guildId }
        ],
        purchasable: true
      },
      orderBy: { price: 'asc' }
    });

    if (items.length === 0) {
      await interaction.reply({
        content: m.b5_shop_empty({}, { locale }),
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(m.b5_shop_title({}, { locale }))
      .setDescription(m.b5_shop_desc({ balance: profile.balance, emoji: config.currencyEmoji }, { locale }))
      .setColor(COLORS.primary)
      .setTimestamp();

    const typesMap: Record<string, string> = {
      WEAPON: m.b5_shop_type_weapon({}, { locale }),
      ARMOR: m.b5_shop_type_armor({}, { locale }),
      POTION: m.b5_shop_type_potion({}, { locale }),
      QUEST: m.b5_shop_type_quest({}, { locale }),
    };

    // Group items by type
    const groupedItems = items.reduce((acc: Record<string, LocalRpgItem[]>, item: unknown) => {
      const localItem = item as LocalRpgItem;
      acc[localItem.type] = acc[localItem.type] || [];
      acc[localItem.type].push(localItem);
      return acc;
    }, {} as Record<string, LocalRpgItem[]>);

    for (const [type, itemArray] of Object.entries(groupedItems)) {
      const list = itemArray
        .map((item: LocalRpgItem) => {
          let stats = '';
          if (item.atkBonus) stats += ` (+${item.atkBonus} ATK)`;
          if (item.defBonus) stats += ` (+${item.defBonus} DEF)`;
          if (item.hpRestore) stats += ` (${m.b5_shop_restores({}, { locale })} ${item.hpRestore} HP)`;
          if (item.energyRestore) stats += ` (${m.b5_shop_restores({}, { locale })} ${item.energyRestore} ${m.b5_shop_energy({}, { locale })})`;
          return `${item.emoji} **${item.name}** - **${item.price}** 🪙\n*${item.description}*${stats}`;
        })
        .join('\n\n');
      embed.addFields({ name: typesMap[type] || type, value: list || m.b5_shop_empty_category({}, { locale }) });
    }

    await interaction.reply({ embeds: [embed] });
  } catch (err: unknown) {
    await interaction.reply({
      embeds: [errorEmbed(m.b5_err_title({}, { locale }), errorMessage(err) || m.b5_shop_error({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
  }
}

export const shopCommand = { data, execute } satisfies SlashCommandDefinition;
