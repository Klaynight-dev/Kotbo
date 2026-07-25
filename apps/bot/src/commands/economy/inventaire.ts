import type { SlashCommandDefinition } from '../../commands.js';
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from 'discord.js';
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
  rarity: string;
  atkBonus: number;
  defBonus: number;
  spdBonus: number;
  hpRestore: number;
  energyRestore: number;
  price: number;
}

interface LocalInventoryEntry {
  id: string;
  rpgProfileId: string;
  itemId: string;
  quantity: number;
  item: LocalRpgItem;
}

const RARITY_EMOJI: Record<string, string> = {
  COMMON: '⬜', UNCOMMON: '🟩', RARE: '🟦', EPIC: '🟪', LEGENDARY: '🟨'
};

const data = new SlashCommandBuilder()
  .setName('inventaire')
  .setDescription('🎒 Afficher votre inventaire RPG détaillé')
  .addUserOption(option =>
    option.setName('membre').setDescription('Voir l\'inventaire d\'un autre membre').setRequired(false)
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const targetUser = interaction.options.getUser('membre') ?? interaction.user;
  const locale = await getEffectiveLocale(interaction);

  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.enabled) {
    await interaction.reply({ embeds: [errorEmbed(m.b3_inv_disabled_title({}, { locale }), m.b3_inv_disabled_desc({}, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  const profile = await getOrCreateRpgProfile(guildId, targetUser.id);
  const inventory = profile.inventory as unknown as LocalInventoryEntry[];

  if (inventory.length === 0) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle(m.b3_inv_title({ name: targetUser.displayName }, { locale }))
          .setDescription(m.b3_inv_empty_desc({}, { locale }))
          .setColor(COLORS.dark)
          .setThumbnail(targetUser.displayAvatarURL({ size: 128 }))
      ]
    });
    return;
  }

  // Catégoriser
  const weapons = inventory.filter(e => e.item.type === 'WEAPON');
  const armors = inventory.filter(e => e.item.type === 'ARMOR');
  const potions = inventory.filter(e => e.item.type === 'POTION');
  const others = inventory.filter(e => !['WEAPON', 'ARMOR', 'POTION'].includes(e.item.type));

  // Stats totales de l'équipement actif
  const equippedWeapon = inventory.find(e => e.itemId === profile.weaponId);
  const equippedArmor = inventory.find(e => e.itemId === profile.armorId);
  const totalAtkBonus = (equippedWeapon?.item.atkBonus ?? 0);
  const totalDefBonus = (equippedArmor?.item.defBonus ?? 0);
  const totalSpdBonus = (equippedWeapon?.item.spdBonus ?? 0) + (equippedArmor?.item.spdBonus ?? 0);

  function formatItem(entry: LocalInventoryEntry): string {
    const item = entry.item;
    const equipped = entry.itemId === profile.weaponId || entry.itemId === profile.armorId;
    const equippedTag = equipped ? m.b3_inv_equipped_tag({}, { locale }) : '';
    const rarity = RARITY_EMOJI[item.rarity] || '⬜';
    const qty = entry.quantity > 1 ? ` x${entry.quantity}` : '';

    let stats = '';
    if (item.atkBonus > 0) stats += ` ⚔️+${item.atkBonus}`;
    if (item.defBonus > 0) stats += ` 🛡️+${item.defBonus}`;
    if (item.spdBonus > 0) stats += ` 👟+${item.spdBonus}`;
    if (item.hpRestore > 0) stats += ` ❤️+${item.hpRestore}`;
    if (item.energyRestore > 0) stats += ` ⚡+${item.energyRestore}`;

    return `${rarity} ${item.emoji} **${item.name}**${qty}${stats}${equippedTag}`;
  }

  const pages: EmbedBuilder[] = [];

  // Page principale
  const mainEmbed = new EmbedBuilder()
    .setTitle(m.b3_inv_title({ name: targetUser.displayName }, { locale }))
    .setThumbnail(targetUser.displayAvatarURL({ size: 128 }))
    .setColor(COLORS.primary)
    .setFooter({ text: m.b3_inv_footer({ total: inventory.reduce((s, e) => s + e.quantity, 0) }, { locale }) })
    .setTimestamp();

  // Stats d'équipement actif
  if (totalAtkBonus > 0 || totalDefBonus > 0 || totalSpdBonus > 0) {
    mainEmbed.setDescription(
      m.b3_inv_equip_bonus({ atk: totalAtkBonus, def: totalDefBonus, spd: totalSpdBonus }, { locale })
    );
  }

  if (weapons.length > 0) {
    mainEmbed.addFields({ name: m.b3_inv_field_weapons({ count: weapons.length }, { locale }), value: weapons.map(formatItem).join('\n') });
  }
  if (armors.length > 0) {
    mainEmbed.addFields({ name: m.b3_inv_field_armors({ count: armors.length }, { locale }), value: armors.map(formatItem).join('\n') });
  }
  if (potions.length > 0) {
    mainEmbed.addFields({ name: m.b3_inv_field_potions({ count: potions.length }, { locale }), value: potions.map(formatItem).join('\n') });
  }
  if (others.length > 0) {
    mainEmbed.addFields({ name: m.b3_inv_field_others({ count: others.length }, { locale }), value: others.map(formatItem).join('\n') });
  }

  pages.push(mainEmbed);

  // Si beaucoup d'items, ajouter une page de détails
  if (inventory.length > 12) {
    const overflowItems = inventory.slice(12);
    const overflowEmbed = new EmbedBuilder()
      .setTitle(m.b3_inv_title_more({ name: targetUser.displayName }, { locale }))
      .setColor(COLORS.primary)
      .setDescription(overflowItems.map(formatItem).join('\n'))
      .setTimestamp();
    pages.push(overflowEmbed);
  }

  if (pages.length === 1) {
    await interaction.reply({ embeds: [pages[0]] });
    return;
  }

  // Pagination
  let currentPage = 0;
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('inv_prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId('inv_page').setLabel(`1/${pages.length}`).setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId('inv_next').setLabel('▶').setStyle(ButtonStyle.Secondary),
  );

  const response = await interaction.reply({ embeds: [pages[0]], components: [row] });

  const collector = response.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 120000,
    filter: i => i.user.id === interaction.user.id,
  });

  collector.on('collect', async (i) => {
    if (i.customId === 'inv_next') currentPage = Math.min(currentPage + 1, pages.length - 1);
    if (i.customId === 'inv_prev') currentPage = Math.max(currentPage - 1, 0);

    const updatedRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('inv_prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === 0),
      new ButtonBuilder().setCustomId('inv_page').setLabel(`${currentPage + 1}/${pages.length}`).setStyle(ButtonStyle.Primary).setDisabled(true),
      new ButtonBuilder().setCustomId('inv_next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === pages.length - 1),
    );

    await i.update({ embeds: [pages[currentPage]], components: [updatedRow] });
  });

  collector.on('end', async () => {
    const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('inv_prev').setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId('inv_page').setLabel(`${currentPage + 1}/${pages.length}`).setStyle(ButtonStyle.Primary).setDisabled(true),
      new ButtonBuilder().setCustomId('inv_next').setLabel('▶').setStyle(ButtonStyle.Secondary).setDisabled(true),
    );
    await interaction.editReply({ components: [disabledRow] }).catch(() => null);
  });
}

export const inventaireCommand = { data, execute } satisfies SlashCommandDefinition;
