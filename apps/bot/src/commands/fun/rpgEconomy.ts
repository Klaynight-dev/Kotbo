import { errorMessage } from '../../utils/errors.js';
import type { SlashCommandDefinition } from '../../commands.js';
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ComponentType,
  PermissionFlagsBits,
} from 'discord.js';
import prisma from '../../utils/db.js';
import { errorEmbed, successEmbed, COLORS } from '../../utils/embeds.js';
import { getOrCreateRpgProfile, claimDaily, startTravel, resolveTravel, chooseAdventureOutcome, buyShopItem, equipInventoryItem, consumePotionItem, createRpgGuild, joinRpgGuild, leaveRpgGuild, depositToRpgGuildTreasury, getOrCreateEconomyConfig, sellShopItem, adminSetStats, fish } from '../../services/features/economyService.js';
import {
  findRandomMonster,
  findBoss,
  listBosses,
  listDiscoveredMonsters,
  simulateBattle,
} from '../../services/features/combatService.js';
import { getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

type Locale = 'fr' | 'en';

// Local interfaces to satisfy ESLint without using any
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

interface LocalInventoryEntry {
  id: string;
  rpgProfileId: string;
  itemId: string;
  quantity: number;
  item: LocalRpgItem;
}

interface LocalGuildMember {
  userId: string;
  level: number;
}

// Progress bar helper
function getProgressBar(current: number, max: number, length = 10, fillEmoji = '🟩', emptyEmoji = '⬛'): string {
  const percent = Math.max(0, Math.min(1, current / max));
  const fillCount = Math.round(percent * length);
  const emptyCount = length - fillCount;
  return `${fillEmoji.repeat(fillCount)}${emptyEmoji.repeat(emptyCount)} (${Math.round(percent * 100)}%)`;
}

// Check if economy module is enabled
async function checkEconomyEnabled(interaction: ChatInputCommandInteraction, locale: Locale): Promise<boolean> {
  const config = await getOrCreateEconomyConfig(interaction.guildId!);
  if (!config.enabled) {
    await interaction.reply({
      embeds: [errorEmbed(m.rpg_module_disabled_title({}, { locale }), m.rpg_module_disabled_desc({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
    return false;
  }
  return true;
}

// 1. RPG PROFILE COMMAND
const rpgProfileData = new SlashCommandBuilder()
  .setName('rpg-profile')
  .setDescription("🛡️ Consulter votre profil RPG et votre solde d'économie")
  .addUserOption(option =>
    option
      .setName('membre')
      .setDescription('Le membre à inspecter (défaut : vous-même)')
      .setRequired(false)
  );

async function rpgProfileExecute(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  if (!await checkEconomyEnabled(interaction, locale)) return;

  const targetUser = interaction.options.getUser('membre') ?? interaction.user;
  const profile = await getOrCreateRpgProfile(interaction.guildId!, targetUser.id);
  const config = await getOrCreateEconomyConfig(interaction.guildId!);

  // Fetch equip details
  const weapon = profile.weaponId ? await prisma.rpgItem.findUnique({ where: { id: profile.weaponId } }) : null;
  const armor = profile.armorId ? await prisma.rpgItem.findUnique({ where: { id: profile.armorId } }) : null;

  const xpNeeded = profile.level * 100;

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_profile_title({ name: targetUser.displayName }, { locale }))
    .setThumbnail(targetUser.displayAvatarURL({ size: 256 }))
    .setColor(COLORS.primary)
    .setDescription(profile.isTraveling ? m.rpg_profile_traveling({ dest: (profile.travelDestination ?? '') }, { locale }) : m.rpg_profile_resting({}, { locale }))
    .addFields(
      { name: m.rpg_profile_field_wallet({ emoji: config.currencyEmoji }, { locale }), value: `**${profile.balance}** ${config.currencyName}`, inline: true },
      { name: m.rpg_profile_field_level({}, { locale }), value: m.rpg_profile_level_value({ level: profile.level }, { locale }), inline: true },
      { name: m.rpg_profile_field_energy({}, { locale }), value: `${profile.energy} / ${config.maxEnergy}\n${getProgressBar(profile.energy, config.maxEnergy, 10, '⚡', '⚫')}`, inline: false },
      { name: m.rpg_profile_field_hp({}, { locale }), value: `${profile.health} / ${profile.maxHealth}\n${getProgressBar(profile.health, profile.maxHealth, 10, '❤️', '🖤')}`, inline: false },
      { name: m.rpg_profile_field_xp({}, { locale }), value: `${profile.xp} / ${xpNeeded} XP\n${getProgressBar(profile.xp, xpNeeded, 10, '🟦', '⬛')}`, inline: false },
      {
        name: m.rpg_profile_field_combat_stats({}, { locale }),
        value: m.rpg_profile_combat_stats_value({ atk: profile.attack, def: profile.defense, spd: profile.speed }, { locale }),
        inline: true
      },
      {
        name: m.rpg_profile_field_equipment({}, { locale }),
        value: m.rpg_profile_equipment_value({
          weapon: weapon ? weapon.emoji + ' ' + weapon.name : m.rpg_profile_no_item({}, { locale }),
          armor: armor ? armor.emoji + ' ' + armor.name : m.rpg_profile_no_item({}, { locale }),
        }, { locale }),
        inline: true
      }
    );

  if (profile.rpgGuild) {
    embed.addFields({ name: m.rpg_profile_field_guild({}, { locale }), value: m.rpg_profile_guild_value({ emoji: profile.rpgGuild.emoji, name: profile.rpgGuild.name, level: profile.rpgGuild.level }, { locale }), inline: false });
  }

  await interaction.reply({ embeds: [embed] });
}

export const rpgProfileCommand = { data: rpgProfileData, execute: rpgProfileExecute } satisfies SlashCommandDefinition;


// 2. DAILY COMMAND
const rpgDailyData = new SlashCommandBuilder()
  .setName('rpg-daily')
  .setDescription('🪙 Récupérer vos pièces quotidiennes gratuites');

async function rpgDailyExecute(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  if (!await checkEconomyEnabled(interaction, locale)) return;

  const result = await claimDaily(interaction.guildId!, interaction.user.id);
  const config = await getOrCreateEconomyConfig(interaction.guildId!);

  if (!result.success) {
    await interaction.reply({
      embeds: [errorEmbed(m.rpg_daily_unavailable_title({}, { locale }), m.rpg_daily_unavailable_desc({ hours: (result.remainingHours ?? 0), minutes: (result.remainingMinutes ?? 0) }, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_daily_title({}, { locale }))
    .setDescription(m.rpg_daily_desc({ reward: (result.reward ?? 0), emoji: config.currencyEmoji, currency: config.currencyName }, { locale }))
    .addFields({ name: m.rpg_daily_new_balance({}, { locale }), value: `**${result.newBalance}** ${config.currencyEmoji}` })
    .setColor(COLORS.success)
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}

export const rpgDailyCommand = { data: rpgDailyData, execute: rpgDailyExecute } satisfies SlashCommandDefinition;


// 3. TRAVEL / ADVENTURE COMMAND
const rpgTravelData = new SlashCommandBuilder()
  .setName('rpg-travel')
  .setDescription("✈️ Démarrer ou résoudre un voyage d'aventure");

async function rpgTravelExecute(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  if (!await checkEconomyEnabled(interaction, locale)) return;

  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const config = await getOrCreateEconomyConfig(guildId);

  if (!config.rpgEnabled) {
    await interaction.reply({
      embeds: [errorEmbed(m.rpg_travel_disabled_title({}, { locale }), m.rpg_travel_disabled_desc({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
    return;
  }

  const profile = await getOrCreateRpgProfile(guildId, userId);

  // Case 1: Active Travel
  if (profile.isTraveling) {
    const status = await resolveTravel(guildId, userId);

    if (!status.complete) {
      await interaction.reply({
        embeds: [errorEmbed(m.rpg_travel_in_progress_title({}, { locale }), m.rpg_travel_in_progress_desc({ dest: (profile.travelDestination ?? ''), minutes: (status.remainingMinutes ?? 0) }, { locale }))],
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    if (status.noEvent) {
      await interaction.reply({
        embeds: [successEmbed(m.rpg_travel_done_title({}, { locale }), m.rpg_travel_done_desc({}, { locale }))]
      });
      return;
    }

    const event = status.event!;
    const choices = (event.choices ?? []) as Array<{ text: string; minLevel?: number }>;

    const embed = new EmbedBuilder()
      .setTitle(m.rpg_travel_event_title({ emoji: event.emoji, title: event.title }, { locale }))
      .setDescription(event.description)
      .setColor(COLORS.primary)
      .setFooter({ text: m.rpg_travel_choose_action({}, { locale }) });

    const row = new ActionRowBuilder<ButtonBuilder>();
    choices.forEach((choice, idx) => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`rpg_choice:${event.id}:${idx}`)
          .setLabel(choice.text.substring(0, 80))
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(Boolean(choice.minLevel && profile.level < choice.minLevel))
      );
    });

    const response = await interaction.reply({
      embeds: [embed],
      components: [row]
    });

    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 60000 // 1 minute to choose
    });

    collector.on('collect', async (i) => {
      if (i.user.id !== interaction.user.id) {
        await i.reply({ content: m.rpg_travel_not_your_adventure({}, { locale }), flags: [MessageFlags.Ephemeral] });
        return;
      }

      await i.deferUpdate();
      const [_, evId, idxStr] = i.customId.split(':');
      const idx = parseInt(idxStr, 10);

      try {
        const resolution = await chooseAdventureOutcome(guildId, userId, evId, idx);

        const resolutionEmbed = new EmbedBuilder()
          .setTitle(m.rpg_travel_resolution_title({ emoji: event.emoji, title: event.title }, { locale }))
          .setDescription(m.rpg_travel_resolution_desc({ choice: resolution.choiceText, critical: resolution.criticalMessage || '' }, { locale }))
          .addFields(
            { name: m.rpg_travel_field_hp_effect({}, { locale }), value: `${resolution.hpEffect >= 0 ? '+' : ''}${resolution.hpEffect} PV`, inline: true },
            { name: m.rpg_travel_field_coin_effect({}, { locale }), value: `${resolution.coinEffect >= 0 ? '+' : ''}${resolution.coinEffect} 🪙`, inline: true },
            { name: m.rpg_travel_field_xp({}, { locale }), value: `+${resolution.xpEffect} XP`, inline: true }
          )
          .setColor(resolution.hpEffect < 0 ? COLORS.danger : COLORS.success);

        if (resolution.levelUp) {
          resolutionEmbed.addFields({ name: m.rpg_travel_field_levelup({}, { locale }), value: m.rpg_travel_levelup_value({ level: resolution.levelUp }, { locale }) });
        }

        await interaction.editReply({
          embeds: [resolutionEmbed],
          components: []
        });
        collector.stop();
      } catch (err: unknown) {
        await interaction.editReply({
          embeds: [errorEmbed(m.rpg_travel_resolution_error_title({}, { locale }), errorMessage(err) || m.rpg_travel_generic_error({}, { locale }))],
          components: []
        });
        collector.stop();
      }
    });

    return;
  }

  // Case 2: Inactive Travel — Choose destination
  const destinations = [
    { name: 'Forêt Mystique', time: 5, label: m.rpg_travel_dest_forest_label({}, { locale }) },
    { name: 'Montagnes du Destin', time: 15, label: m.rpg_travel_dest_mountains_label({}, { locale }) },
    { name: 'Marécage Maudit', time: 30, label: m.rpg_travel_dest_swamp_label({}, { locale }) }
  ];

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_travel_start_title({}, { locale }))
    .setDescription(m.rpg_travel_start_desc({}, { locale }))
    .setColor(COLORS.primary)
    .addFields({ name: m.rpg_travel_field_energy_now({}, { locale }), value: `${profile.energy} / ${config.maxEnergy}` });

  const row = new ActionRowBuilder<ButtonBuilder>();
  destinations.forEach((dest, idx) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`rpg_dest:${idx}`)
        .setLabel(dest.label)
        .setStyle(ButtonStyle.Primary)
    );
  });

  const response = await interaction.reply({
    embeds: [embed],
    components: [row],
    flags: [MessageFlags.Ephemeral]
  });

  const collector = response.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 30000
  });

  collector.on('collect', async (i) => {
    await i.deferUpdate();
    const idx = parseInt(i.customId.split(':')[1], 10);
    const dest = destinations[idx];

    try {
      await startTravel(guildId, userId, dest.name, dest.time);
      await interaction.editReply({
        embeds: [successEmbed(m.rpg_travel_bon_voyage_title({}, { locale }), m.rpg_travel_bon_voyage_desc({ dest: dest.name, time: dest.time }, { locale }))],
        components: []
      });
      collector.stop();
    } catch (err: unknown) {
      await interaction.editReply({
        embeds: [errorEmbed(m.rpg_travel_energy_insufficient_title({}, { locale }), errorMessage(err) || m.rpg_travel_cannot_travel({}, { locale }))],
        components: []
      });
      collector.stop();
    }
  });
}

export const rpgTravelCommand = { data: rpgTravelData, execute: rpgTravelExecute } satisfies SlashCommandDefinition;


// 4. SHOP COMMAND
const rpgShopData = new SlashCommandBuilder()
  .setName('rpg-shop')
  .setDescription('🛒 Consulter la boutique et acheter des objets RPG');

async function rpgShopExecute(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  if (!await checkEconomyEnabled(interaction, locale)) return;

  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const config = await getOrCreateEconomyConfig(guildId);

  if (!config.shopEnabled) {
    await interaction.reply({
      embeds: [errorEmbed(m.rpg_shop_disabled_title({}, { locale }), m.rpg_shop_disabled_desc({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
    return;
  }

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
    await interaction.reply({ content: m.rpg_shop_empty({}, { locale }), flags: [MessageFlags.Ephemeral] });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_shop_title({}, { locale }))
    .setDescription(m.rpg_shop_desc({ balance: profile.balance, emoji: config.currencyEmoji }, { locale }))
    .setColor(COLORS.primary);

  // Group items by type for nice display
  const typesMap: Record<string, string> = {
    WEAPON: m.rpg_shop_type_weapon({}, { locale }),
    ARMOR: m.rpg_shop_type_armor({}, { locale }),
    POTION: m.rpg_shop_type_potion({}, { locale }),
    QUEST: m.rpg_shop_type_quest({}, { locale }),
  };
  const groupedItems = items.reduce((acc: Record<string, LocalRpgItem[]>, item: unknown) => {
    const localItem = item as LocalRpgItem;
    acc[localItem.type] = acc[localItem.type] || [];
    acc[localItem.type].push(localItem);
    return acc;
  }, {} as Record<string, LocalRpgItem[]>);

  for (const [type, itemArray] of Object.entries(groupedItems)) {
    const list = itemArray.map((item: LocalRpgItem) => {
      let stats = '';
      if (item.atkBonus) stats += m.rpg_shop_stat_atk({ v: item.atkBonus }, { locale });
      if (item.defBonus) stats += m.rpg_shop_stat_def({ v: item.defBonus }, { locale });
      if (item.hpRestore) stats += m.rpg_shop_stat_hp({ v: item.hpRestore }, { locale });
      return `${item.emoji} **${item.name}** - **${item.price}** 🪙\n*${item.description}*${stats}`;
    }).join('\n');
    embed.addFields({ name: typesMap[type] || type, value: list || m.rpg_shop_empty_category({}, { locale }) });
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId('rpg_buy')
    .setPlaceholder(m.rpg_shop_select_placeholder({}, { locale }));

  items.slice(0, 25).forEach((item: unknown) => {
    const localItem = item as LocalRpgItem;
    select.addOptions({
      label: localItem.name,
      description: `${localItem.price} coins — ${localItem.description.substring(0, 60)}`,
      value: localItem.id,
      emoji: localItem.emoji
    });
  });

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

  const response = await interaction.reply({
    embeds: [embed],
    components: [selectRow],
    flags: [MessageFlags.Ephemeral]
  });

  const collector = response.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: 30000
  });

  collector.on('collect', async (i) => {
    await i.deferUpdate();
    const itemId = i.values[0];

    try {
      const buyResult = await buyShopItem(guildId, userId, itemId);
      await interaction.editReply({
        embeds: [successEmbed(m.rpg_shop_buy_success_title({}, { locale }), m.rpg_shop_buy_success_desc({ item: buyResult.itemName, price: buyResult.price, balance: buyResult.newBalance }, { locale }))],
        components: []
      });
      collector.stop();
    } catch (err: unknown) {
      await interaction.editReply({
        embeds: [errorEmbed(m.rpg_shop_buy_failed_title({}, { locale }), errorMessage(err) || m.rpg_shop_buy_failed_desc({}, { locale }))],
        components: []
      });
      collector.stop();
    }
  });
}

export const rpgShopCommand = { data: rpgShopData, execute: rpgShopExecute } satisfies SlashCommandDefinition;


// 5. INVENTORY COMMAND
const rpgInventoryData = new SlashCommandBuilder()
  .setName('rpg-inventory')
  .setDescription('🎒 Gérer votre sac à dos, équiper vos armes et utiliser vos potions');

async function rpgInventoryExecute(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  if (!await checkEconomyEnabled(interaction, locale)) return;

  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  const profile = await getOrCreateRpgProfile(guildId, userId);
  const inventory = profile.inventory;

  if (inventory.length === 0) {
    await interaction.reply({
      embeds: [errorEmbed(m.rpg_inventory_empty_title({}, { locale }), m.rpg_inventory_empty_desc({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_inventory_title({}, { locale }))
    .setDescription(m.rpg_inventory_desc({}, { locale }))
    .setColor(COLORS.primary);

  const list = inventory.map((entry: unknown) => {
    const localEntry = entry as LocalInventoryEntry;
    const item = localEntry.item;
    let desc = `${item.emoji} **${item.name}** (x${localEntry.quantity}) - *${item.type}*`;
    if (item.id === profile.weaponId) desc += m.rpg_inventory_equipped_tag({}, { locale });
    if (item.id === profile.armorId) desc += m.rpg_inventory_equipped_tag({}, { locale });
    return desc;
  }).join('\n');

  embed.addFields({ name: m.rpg_inventory_field_content({}, { locale }), value: list });

  const select = new StringSelectMenuBuilder()
    .setCustomId('rpg_use')
    .setPlaceholder(m.rpg_inventory_select_placeholder({}, { locale }));

  inventory.forEach((entry: unknown) => {
    const localEntry = entry as LocalInventoryEntry;
    const item = localEntry.item;
    const isEquipped = item.id === profile.weaponId || item.id === profile.armorId;
    select.addOptions({
      label: `${item.name} (x${localEntry.quantity})`,
      description: isEquipped ? m.rpg_inventory_already_equipped({}, { locale }) : item.type === 'POTION' ? m.rpg_inventory_consume_potion({}, { locale }) : m.rpg_inventory_equip_item({}, { locale }),
      value: item.id,
      emoji: item.emoji
    });
  });

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);

  const response = await interaction.reply({
    embeds: [embed],
    components: [row],
    flags: [MessageFlags.Ephemeral]
  });

  const collector = response.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: 30000
  });

  collector.on('collect', async (i) => {
    await i.deferUpdate();
    const itemId = i.values[0];
    const selectedEntry = inventory.find((e: unknown) => (e as LocalInventoryEntry).item.id === itemId) as LocalInventoryEntry | undefined;

    if (!selectedEntry) return;

    try {
      const item = selectedEntry.item;
      if (item.type === 'POTION') {
        const result = await consumePotionItem(guildId, userId, itemId);
        await interaction.editReply({
          embeds: [successEmbed(m.rpg_potion_consumed_title({}, { locale }), m.rpg_potion_consumed_desc({ item: result.itemName, hp: result.restoredHp, newHp: result.newHp, energy: result.restoredEnergy, newEnergy: result.newEnergy }, { locale }))],
          components: []
        });
      } else {
        const result = await equipInventoryItem(guildId, userId, itemId);
        await interaction.editReply({
          embeds: [successEmbed(m.rpg_item_equipped_title({}, { locale }), m.rpg_item_equipped_desc({ item: result.itemName, type: result.type }, { locale }))],
          components: []
        });
      }
      collector.stop();
    } catch (err: unknown) {
      await interaction.editReply({
        embeds: [errorEmbed(m.rpg_action_failed_title({}, { locale }), errorMessage(err) || m.rpg_action_failed_desc({}, { locale }))],
        components: []
      });
      collector.stop();
    }
  });
}

export const rpgInventoryCommand = { data: rpgInventoryData, execute: rpgInventoryExecute } satisfies SlashCommandDefinition;


// 6. GUILD COMMANDS
const rpgGuildData = new SlashCommandBuilder()
  .setName('rpg-guild')
  .setDescription('🛡️ Gérer votre guilde RPG et vos trésors')
  .addSubcommand(sub =>
    sub
      .setName('info')
      .setDescription('Consulter les informations de votre guilde')
  )
  .addSubcommand(sub =>
    sub
      .setName('create')
      .setDescription('Créer une nouvelle guilde RPG (Coût: 500 Coins)')
      .addStringOption(opt =>
        opt
          .setName('nom')
          .setDescription('Nom de la guilde')
          .setRequired(true)
          .setMaxLength(32)
      )
      .addStringOption(opt =>
        opt
          .setName('description')
          .setDescription('Brève description')
          .setRequired(false)
          .setMaxLength(256)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('join')
      .setDescription('Rejoindre une guilde existante')
      .addStringOption(opt =>
        opt
          .setName('nom')
          .setDescription('Le nom exact de la guilde cible')
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub
      .setName('leave')
      .setDescription('Quitter votre guilde actuelle')
  )
  .addSubcommand(sub =>
    sub
      .setName('deposit')
      .setDescription('Faire un don de KotboCoins à la trésorerie de votre guilde')
      .addIntegerOption(opt =>
        opt
          .setName('montant')
          .setDescription('Le montant à déposer')
          .setRequired(true)
          .setMinValue(1)
      )
  );

async function rpgGuildExecute(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  if (!await checkEconomyEnabled(interaction, locale)) return;

  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const config = await getOrCreateEconomyConfig(guildId);

  if (!config.guildsEnabled) {
    await interaction.reply({
      embeds: [errorEmbed(m.rpg_guild_disabled_title({}, { locale }), m.rpg_guild_disabled_desc({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
    return;
  }

  const sub = interaction.options.getSubcommand();

  // A. INFO
  if (sub === 'info') {
    const profile = await getOrCreateRpgProfile(guildId, userId);
    if (!profile.rpgGuildId) {
      await interaction.reply({
        embeds: [errorEmbed(m.rpg_guild_no_guild_title({}, { locale }), m.rpg_guild_no_guild_desc({}, { locale }))],
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    const rpgGuild = await prisma.rpgGuild.findUnique({
      where: { id: profile.rpgGuildId },
      include: { members: true }
    });

    if (!rpgGuild) return;

    const xpNeeded = rpgGuild.level * 1000;
    const membersList = rpgGuild.members.map((mb: unknown) => `<@${(mb as LocalGuildMember).userId}> (Niveau ${(mb as LocalGuildMember).level})`).join(', ');

    const embed = new EmbedBuilder()
      .setTitle(m.rpg_guild_title({ emoji: rpgGuild.emoji, name: rpgGuild.name }, { locale }))
      .setDescription(rpgGuild.description || m.rpg_guild_no_description({}, { locale }))
      .setColor(COLORS.primary)
      .addFields(
        { name: m.rpg_guild_field_level({}, { locale }), value: m.rpg_profile_level_value({ level: rpgGuild.level }, { locale }), inline: true },
        { name: m.rpg_guild_field_treasury({}, { locale }), value: m.rpg_guild_treasury_value({ amount: rpgGuild.treasury }, { locale }), inline: true },
        { name: m.rpg_guild_field_xp({}, { locale }), value: `${rpgGuild.xp} / ${xpNeeded} XP\n${getProgressBar(rpgGuild.xp, xpNeeded, 10, '🟨', '⬛')}`, inline: false },
        { name: m.rpg_guild_field_members({}, { locale }), value: membersList || m.rpg_guild_no_members({}, { locale }) }
      );

    await interaction.reply({ embeds: [embed] });
    return;
  }

  // B. CREATE
  if (sub === 'create') {
    const name = interaction.options.getString('nom', true);
    const desc = interaction.options.getString('description') ?? undefined;

    try {
      const rpgGuild = await createRpgGuild(guildId, userId, name, desc);
      await interaction.reply({
        embeds: [successEmbed(m.rpg_guild_created_title({}, { locale }), m.rpg_guild_created_desc({ name: rpgGuild.name }, { locale }))]
      });
    } catch (err: unknown) {
      await interaction.reply({
        embeds: [errorEmbed(m.rpg_guild_create_failed_title({}, { locale }), errorMessage(err) || m.rpg_guild_create_failed_desc({}, { locale }))],
        flags: [MessageFlags.Ephemeral]
      });
    }
    return;
  }

  // C. JOIN
  if (sub === 'join') {
    const name = interaction.options.getString('nom', true);

    const targetGuild = await prisma.rpgGuild.findFirst({
      where: { guildId, name: { equals: name, mode: 'insensitive' } }
    });

    if (!targetGuild) {
      await interaction.reply({
        embeds: [errorEmbed(m.rpg_guild_not_found_title({}, { locale }), m.rpg_guild_not_found_desc({}, { locale }))],
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    try {
      await joinRpgGuild(guildId, userId, targetGuild.id);
      await interaction.reply({
        embeds: [successEmbed(m.rpg_guild_welcome_title({}, { locale }), m.rpg_guild_welcome_desc({ name: targetGuild.name }, { locale }))]
      });
    } catch (err: unknown) {
      await interaction.reply({
        embeds: [errorEmbed(m.rpg_action_failed_title({}, { locale }), errorMessage(err) || m.rpg_guild_action_failed_desc_join({}, { locale }))],
        flags: [MessageFlags.Ephemeral]
      });
    }
    return;
  }

  // D. LEAVE
  if (sub === 'leave') {
    try {
      const result = await leaveRpgGuild(guildId, userId);
      if (result.dissolved) {
        await interaction.reply({
          embeds: [successEmbed(m.rpg_guild_dissolved_title({}, { locale }), m.rpg_guild_dissolved_desc({}, { locale }))]
        });
      } else {
        await interaction.reply({
          embeds: [successEmbed(m.rpg_guild_left_title({}, { locale }), m.rpg_guild_left_desc({ name: (result.guildName ?? '') }, { locale }))]
        });
      }
    } catch (err: unknown) {
      await interaction.reply({
        embeds: [errorEmbed(m.rpg_generic_error_title({}, { locale }), errorMessage(err) || m.rpg_guild_leave_error_desc({}, { locale }))],
        flags: [MessageFlags.Ephemeral]
      });
    }
    return;
  }

  // E. DEPOSIT
  if (sub === 'deposit') {
    const amount = interaction.options.getInteger('montant', true);

    try {
      const depositResult = await depositToRpgGuildTreasury(guildId, userId, amount);
      const resEmbed = successEmbed(m.rpg_guild_deposit_title({}, { locale }), m.rpg_guild_deposit_desc({ amount: depositResult.amount }, { locale }));
      if (depositResult.levelUp) {
        resEmbed.addFields({ name: m.rpg_guild_deposit_levelup_title({}, { locale }), value: m.rpg_guild_deposit_levelup_desc({ level: depositResult.levelUp }, { locale }) });
      }
      await interaction.reply({ embeds: [resEmbed] });
    } catch (err: unknown) {
      await interaction.reply({
        embeds: [errorEmbed(m.rpg_guild_deposit_failed_title({}, { locale }), errorMessage(err) || m.rpg_guild_deposit_failed_desc({}, { locale }))],
        flags: [MessageFlags.Ephemeral]
      });
    }
    return;
  }
}

export const rpgGuildCommand = { data: rpgGuildData, execute: rpgGuildExecute } satisfies SlashCommandDefinition;


// 7. PAY COMMAND
const rpgPayData = new SlashCommandBuilder()
  .setName('rpg-pay')
  .setDescription('💸 Envoyer des KotboCoins à un autre membre')
  .addUserOption(option =>
    option
      .setName('membre')
      .setDescription('Le membre destinataire')
      .setRequired(true)
  )
  .addIntegerOption(option =>
    option
      .setName('montant')
      .setDescription('Le montant de pièces à envoyer')
      .setRequired(true)
      .setMinValue(1)
  );

async function rpgPayExecute(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  if (!await checkEconomyEnabled(interaction, locale)) return;

  const guildId = interaction.guildId!;
  const senderId = interaction.user.id;
  const receiver = interaction.options.getUser('membre', true);
  const amount = interaction.options.getInteger('montant', true);

  if (receiver.bot) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_generic_error_title({}, { locale }), m.rpg_pay_no_bot({}, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  if (receiver.id === senderId) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_generic_error_title({}, { locale }), m.rpg_pay_no_self({}, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  const senderProfile = await getOrCreateRpgProfile(guildId, senderId);

  if (senderProfile.balance < amount) {
    await interaction.reply({
      embeds: [errorEmbed(m.rpg_pay_insufficient_title({}, { locale }), m.rpg_pay_insufficient_desc({ balance: senderProfile.balance }, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
    return;
  }

  const receiverProfile = await getOrCreateRpgProfile(guildId, receiver.id);

  await prisma.$transaction([
    prisma.rpgProfile.update({
      where: { id: senderProfile.id },
      data: { balance: { decrement: amount } }
    }),
    prisma.rpgProfile.update({
      where: { id: receiverProfile.id },
      data: { balance: { increment: amount } }
    })
  ]);

  const config = await getOrCreateEconomyConfig(guildId);
  const embed = successEmbed(m.rpg_pay_success_title({}, { locale }), m.rpg_pay_success_desc({ amount, emoji: config.currencyEmoji, id: receiver.id }, { locale }))
    .addFields(
      { name: m.rpg_pay_field_your_balance({}, { locale }), value: `**${senderProfile.balance - amount}** ${config.currencyEmoji}`, inline: true },
      { name: m.rpg_pay_field_their_balance({}, { locale }), value: `**${receiverProfile.balance + amount}** ${config.currencyEmoji}`, inline: true }
    );

  await interaction.reply({ embeds: [embed] });
}

export const rpgPayCommand = { data: rpgPayData, execute: rpgPayExecute } satisfies SlashCommandDefinition;

// 8. SELL COMMAND
const rpgSellData = new SlashCommandBuilder()
  .setName('rpg-sell')
  .setDescription('🪙 Revendre un objet de votre inventaire à 50% de sa valeur boutique')
  .addStringOption(option =>
    option
      .setName('objet')
      .setDescription("Le nom de l'objet à vendre")
      .setRequired(true)
  );

async function rpgSellExecute(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  if (!await checkEconomyEnabled(interaction, locale)) return;

  const guildId = interaction.guildId!;
  const userId = interaction.user.id;
  const query = interaction.options.getString('objet', true).toLowerCase();

  try {
    const profile = await getOrCreateRpgProfile(guildId, userId);

    // Find matching item in inventory
    const entry = profile.inventory.find((e: unknown) =>
      (e as LocalInventoryEntry).item.name.toLowerCase().includes(query)
    ) as LocalInventoryEntry | undefined;

    if (!entry) {
      await interaction.reply({
        embeds: [errorEmbed(m.rpg_sell_not_found_title({}, { locale }), m.rpg_sell_not_found_desc({ query }, { locale }))],
        flags: [MessageFlags.Ephemeral]
      });
      return;
    }

    const sellResult = await sellShopItem(guildId, userId, entry.item.id);

    const embed = successEmbed(m.rpg_sell_success_title({}, { locale }), m.rpg_sell_success_desc({ item: sellResult.itemName, price: sellResult.sellPrice }, { locale }))
      .addFields({ name: m.rpg_sell_new_balance({}, { locale }), value: `**${sellResult.newBalance}** 🪙` });

    await interaction.reply({ embeds: [embed] });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : m.rpg_sell_error_desc({}, { locale });
    await interaction.reply({
      embeds: [errorEmbed(m.rpg_sell_error_title({}, { locale }), errMsg)],
      flags: [MessageFlags.Ephemeral]
    });
  }
}

export const rpgSellCommand = { data: rpgSellData, execute: rpgSellExecute } satisfies SlashCommandDefinition;

// 9. DROP COMMAND
const rpgDropData = new SlashCommandBuilder()
  .setName('rpg-drop')
  .setDescription("🎁 Faire tomber des KotboCoins ou de l'XP RPG dans le salon")
  .addStringOption(option =>
    option
      .setName('type')
      .setDescription('Type de ressource à drop')
      .setRequired(true)
      .addChoices(
        { name: 'KotboCoins 🪙', value: 'COINS' },
        { name: 'Expérience ⭐', value: 'XP' }
      )
  )
  .addIntegerOption(option =>
    option
      .setName('quantite')
      .setDescription('Le montant à drop')
      .setRequired(true)
      .setMinValue(1)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

async function rpgDropExecute(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  if (!await checkEconomyEnabled(interaction, locale)) return;

  const type = interaction.options.getString('type', true);
  const amount = interaction.options.getInteger('quantite', true);
  const guildId = interaction.guildId!;

  try {
    const drop = await prisma.rpgDrop.create({
      data: {
        guildId,
        amount,
        type
      }
    });

    const isCoins = type === 'COINS';
    const resourceName = isCoins ? m.rpg_drop_resource_coins({}, { locale }) : m.rpg_drop_resource_xp({}, { locale });

    const embed = new EmbedBuilder()
      .setTitle(m.rpg_drop_title({}, { locale }))
      .setDescription(m.rpg_drop_desc({ amount, resource: resourceName }, { locale }))
      .setColor(COLORS.primary)
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`rpg_drop_claim:${drop.id}`)
        .setLabel(m.rpg_drop_claim_button({}, { locale }))
        .setStyle(ButtonStyle.Success)
    );

    await interaction.reply({
      embeds: [embed],
      components: [row]
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : m.rpg_drop_error_desc({}, { locale });
    await interaction.reply({
      embeds: [errorEmbed(m.rpg_drop_error_title({}, { locale }), errMsg)],
      flags: [MessageFlags.Ephemeral]
    });
  }
}

export const rpgDropCommand = { data: rpgDropData, execute: rpgDropExecute } satisfies SlashCommandDefinition;

// 10. ADMIN COMMANDS
const rpgAdminData = new SlashCommandBuilder()
  .setName('rpg-admin')
  .setDescription("⚙️ Gérer le système RPG et d'économie (Admin uniquement)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(sub =>
    sub
      .setName('set-balance')
      .setDescription("Modifier le solde d'un joueur")
      .addUserOption(opt => opt.setName('membre').setDescription('Le membre cible').setRequired(true))
      .addIntegerOption(opt => opt.setName('solde').setDescription('Le nouveau solde').setRequired(true).setMinValue(0))
  )
  .addSubcommand(sub =>
    sub
      .setName('set-level')
      .setDescription("Modifier le niveau RPG d'un joueur")
      .addUserOption(opt => opt.setName('membre').setDescription('Le membre cible').setRequired(true))
      .addIntegerOption(opt => opt.setName('niveau').setDescription('Le nouveau niveau').setRequired(true).setMinValue(1))
  )
  .addSubcommand(sub =>
    sub
      .setName('set-xp')
      .setDescription("Modifier les points d'expérience RPG d'un joueur")
      .addUserOption(opt => opt.setName('membre').setDescription('Le membre cible').setRequired(true))
      .addIntegerOption(opt => opt.setName('xp').setDescription("Le nouveau montant d'XP").setRequired(true).setMinValue(0))
  )
  .addSubcommand(sub =>
    sub
      .setName('reset')
      .setDescription('Réinitialiser un composant du système RPG/économie')
      .addStringOption(opt =>
        opt
          .setName('composant')
          .setDescription('Le composant à réinitialiser')
          .setRequired(true)
          .addChoices(
            { name: 'Tout réinitialiser (Global)', value: 'all' },
            { name: 'Profils des joueurs (Comptes, inventaires...)', value: 'profiles' },
            { name: 'Objets de la boutique', value: 'items' },
            { name: "Configuration de l'économie", value: 'config' },
            { name: 'Guildes RPG', value: 'guilds' }
          )
      )
  );

async function rpgAdminExecute(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  if (!await checkEconomyEnabled(interaction, locale)) return;

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId!;

  if (sub === 'reset') {
    const component = interaction.options.getString('composant', true) as 'all' | 'profiles' | 'items' | 'config' | 'guilds';

    // Send a confirmation prompt to avoid accidental deletion
    const embed = new EmbedBuilder()
      .setTitle(m.rpg_admin_reset_confirm_title({}, { locale }))
      .setDescription(m.rpg_admin_reset_confirm_desc({ component }, { locale }))
      .setColor(COLORS.warning);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`rpg_reset_confirm:${component}`)
        .setLabel(m.rpg_admin_reset_confirm_button({}, { locale }))
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('rpg_reset_cancel')
        .setLabel(m.rpg_admin_reset_cancel_button({}, { locale }))
        .setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
      embeds: [embed],
      components: [row],
      flags: [MessageFlags.Ephemeral]
    });
    return;
  }

  const targetUser = interaction.options.getUser('membre', true);
  if (targetUser.bot) {
    await interaction.reply({
      embeds: [errorEmbed(m.rpg_generic_error_title({}, { locale }), m.rpg_admin_bot_error_desc({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
    return;
  }

  try {
    const stats: Parameters<typeof adminSetStats>[2] = {};
    let desc = '';

    if (sub === 'set-balance') {
      const balance = interaction.options.getInteger('solde', true);
      stats.balance = balance;
      desc = m.rpg_admin_balance_set_desc({ id: targetUser.id, value: balance }, { locale });
    } else if (sub === 'set-level') {
      const level = interaction.options.getInteger('niveau', true);
      stats.level = level;
      desc = m.rpg_admin_level_set_desc({ id: targetUser.id, value: level }, { locale });
    } else if (sub === 'set-xp') {
      const xp = interaction.options.getInteger('xp', true);
      stats.xp = xp;
      desc = m.rpg_admin_xp_set_desc({ id: targetUser.id, value: xp }, { locale });
    }

    await adminSetStats(guildId, targetUser.id, stats);
    await interaction.reply({
      embeds: [successEmbed(m.rpg_admin_stats_updated_title({}, { locale }), desc)]
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : m.rpg_admin_modify_error_desc({}, { locale });
    await interaction.reply({
      embeds: [errorEmbed(m.rpg_admin_modify_error_title({}, { locale }), errMsg)],
      flags: [MessageFlags.Ephemeral]
    });
  }
}

export const rpgAdminCommand = { data: rpgAdminData, execute: rpgAdminExecute } satisfies SlashCommandDefinition;


// ============================================================================
// RPG-FIGHT — Combat contre un monstre aléatoire
// ============================================================================

const rpgFightData = new SlashCommandBuilder()
  .setName('rpg-fight')
  .setDescription('⚔️ Combattre un monstre aléatoire adapté à votre niveau');

async function rpgFightExecute(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  if (!await checkEconomyEnabled(interaction, locale)) return;
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.rpgEnabled) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_travel_disabled_title({}, { locale }), m.rpg_boss_disabled_desc({}, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  const profile = await getOrCreateRpgProfile(guildId, userId);

  if (profile.lastBattle) {
    const diff = Date.now() - profile.lastBattle.getTime();
    if (diff < 2 * 60 * 1000) {
      const remaining = Math.ceil((2 * 60 * 1000 - diff) / 1000);
      await interaction.reply({ embeds: [errorEmbed(m.rpg_fight_cooldown_title({}, { locale }), m.rpg_fight_cooldown_desc({ s: remaining }, { locale }))], flags: [MessageFlags.Ephemeral] });
      return;
    }
  }

  if (profile.energy < 15) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_fight_low_energy_title({}, { locale }), m.rpg_fight_low_energy_desc({ energy: profile.energy }, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  if (profile.health <= 5) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_fight_low_hp_title({}, { locale }), m.rpg_fight_low_hp_desc({}, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  // Atomic guard: only spend energy if the row still has enough at write time, so two
  // near-simultaneous energy-consuming actions can't both pass a stale check and push
  // energy below zero.
  const energySpent = await prisma.rpgProfile.updateMany({
    where: { guildId, userId, energy: { gte: 15 } },
    data: { energy: { decrement: 15 } }
  });

  if (energySpent.count === 0) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_fight_low_energy_title({}, { locale }), m.rpg_fight_low_energy_desc({ energy: profile.energy }, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  await interaction.deferReply();

  const monster = await findRandomMonster(guildId, profile.level);
  if (!monster) {
    await interaction.editReply({ embeds: [errorEmbed(m.rpg_fight_no_monster_title({}, { locale }), m.rpg_fight_no_monster_desc({}, { locale }))] });
    return;
  }

  const weapon = profile.weaponId
    ? await prisma.rpgItem.findUnique({ where: { id: profile.weaponId } })
    : null;
  const armor = profile.armorId
    ? await prisma.rpgItem.findUnique({ where: { id: profile.armorId } })
    : null;

  const playerAtk = profile.attack + (weapon?.atkBonus ?? 0);
  const playerDef = profile.defense + (armor?.defBonus ?? 0);
  const playerSpd = profile.speed + (weapon?.spdBonus ?? 0) + (armor?.spdBonus ?? 0);
  const playerMaxHp = profile.maxHealth;

  let playerHp = profile.health;
  let monsterHp = monster.health;
  const monsterMaxHp = monster.health;

  const getPotions = () => prisma.rpgInventoryItem.findMany({
    where: {
      rpgProfileId: profile.id,
      item: { type: 'POTION' },
      quantity: { gte: 1 }
    },
    include: { item: true }
  });

  const buildHpBar = (current: number, max: number) => {
    const barsCount = 10;
    const filled = Math.max(0, Math.min(barsCount, Math.round((current / max) * barsCount)));
    const empty = barsCount - filled;
    return `[${'🟩'.repeat(filled)}${'🟥'.repeat(empty)}] \`${current}/${max} PV\``;
  };

  const getEmbed = (turnsLog: string[]) => {
    const logs = turnsLog.slice(-5).join('\n') || m.rpg_fight_combat_start_log({}, { locale });
    return new EmbedBuilder()
      .setTitle(m.rpg_fight_title({ emoji: monster.emoji, name: monster.name }, { locale }))
      .setDescription(
        `${monster.description}\n\n` +
        `${m.rpg_fight_you_label_block({}, { locale })}\n${buildHpBar(playerHp, playerMaxHp)}\n\n` +
        `${m.rpg_fight_enemy_label_block({ emoji: monster.emoji, name: monster.name, level: monster.level }, { locale })}\n${buildHpBar(monsterHp, monsterMaxHp)}\n\n` +
        `${m.rpg_fight_combat_log_label({}, { locale })}\n${logs}`
      )
      .setColor('#5865F2')
      .setTimestamp();
  };

  const getActionRow = async () => {
    const userPotions = await getPotions();
    const potionsCount = userPotions.reduce((sum, p) => sum + p.quantity, 0);

    const attackBtn = new ButtonBuilder()
      .setCustomId('combat_attack')
      .setLabel(m.rpg_fight_btn_attack({}, { locale }))
      .setEmoji('⚔️')
      .setStyle(ButtonStyle.Primary);

    const defendBtn = new ButtonBuilder()
      .setCustomId('combat_defend')
      .setLabel(m.rpg_fight_btn_defend({}, { locale }))
      .setEmoji('🛡️')
      .setStyle(ButtonStyle.Secondary);

    const potionBtn = new ButtonBuilder()
      .setCustomId('combat_potion')
      .setLabel(m.rpg_fight_btn_potion({ count: potionsCount }, { locale }))
      .setEmoji('🧪')
      .setStyle(ButtonStyle.Success)
      .setDisabled(potionsCount === 0);

    const fleeBtn = new ButtonBuilder()
      .setCustomId('combat_flee')
      .setLabel(m.rpg_fight_btn_flee({}, { locale }))
      .setEmoji('🏃')
      .setStyle(ButtonStyle.Danger);

    return new ActionRowBuilder<ButtonBuilder>().addComponents(attackBtn, defendBtn, potionBtn, fleeBtn);
  };

  const message = await interaction.editReply({
    embeds: [getEmbed([])],
    components: [await getActionRow()]
  });

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) => i.user.id === userId,
    time: 60 * 1000
  });

  const turnsLog: string[] = [];
  let isDefending = false;
  let totalDamageDealt = 0;
  let totalDamageTaken = 0;

  collector.on('collect', async (btnInt) => {
    try {
      await btnInt.deferUpdate();
      collector.resetTimer();

      isDefending = false;
      let actionTaken = '';

      if (btnInt.customId === 'combat_attack') {
        const critical = Math.random() < 0.1;
        const baseDmg = Math.max(1, playerAtk - Math.floor(monster.defense / 2)) + Math.floor(Math.random() * Math.max(1, Math.floor(playerSpd / 3)));
        const damage = critical ? Math.floor(baseDmg * 1.5) : baseDmg;
        monsterHp = Math.max(0, monsterHp - damage);
        totalDamageDealt += damage;
        actionTaken = m.rpg_fight_action_attack({ dmg: damage, crit: critical ? m.rpg_fight_critical_suffix({}, { locale }) : '', name: monster.name }, { locale });
      } else if (btnInt.customId === 'combat_defend') {
        isDefending = true;
        actionTaken = m.rpg_fight_action_defend({}, { locale });
      } else if (btnInt.customId === 'combat_potion') {
        const userPotions = await getPotions();
        if (userPotions.length === 0) {
          actionTaken = m.rpg_fight_no_potions({}, { locale });
        } else {
          const potItem = userPotions[0];
          const restored = potItem.item.hpRestore;
          playerHp = Math.min(playerMaxHp, playerHp + restored);

          if (potItem.quantity > 1) {
            await prisma.rpgInventoryItem.update({ where: { id: potItem.id }, data: { quantity: { decrement: 1 } } });
          } else {
            await prisma.rpgInventoryItem.delete({ where: { id: potItem.id } });
          }
          actionTaken = m.rpg_fight_action_potion({ item: potItem.item.name, hp: restored }, { locale });
        }
      } else if (btnInt.customId === 'combat_flee') {
        turnsLog.push(m.rpg_fight_action_flee({}, { locale }));
        collector.stop('fled');
        return;
      }

      turnsLog.push(actionTaken);

      if (monsterHp <= 0) {
        collector.stop('victory');
        return;
      }

      // Tour du monstre
      const monsterCrit = Math.random() < 0.08;
      const monsterBaseDmg = Math.max(1, monster.attack - Math.floor((playerDef * (isDefending ? 2 : 1)) / 2)) + Math.floor(Math.random() * Math.max(1, Math.floor(monster.speed / 3)));
      const monsterDamage = monsterCrit ? Math.floor(monsterBaseDmg * 1.5) : monsterBaseDmg;
      playerHp = Math.max(0, playerHp - monsterDamage);
      totalDamageTaken += monsterDamage;
      turnsLog.push(m.rpg_fight_monster_turn_log({ emoji: monster.emoji, name: monster.name, dmg: monsterDamage, crit: monsterCrit ? m.rpg_fight_critical_suffix({}, { locale }) : '' }, { locale }));

      if (playerHp <= 0) {
        collector.stop('defeat');
        return;
      }

      await interaction.editReply({
        embeds: [getEmbed(turnsLog)],
        components: [await getActionRow()]
      });

    } catch (err) {
      console.error(err);
    }
  });

  collector.on('end', async (_, reason) => {
    try {
      const row = await getActionRow();
      row.components.forEach(c => c.setDisabled(true));

      if (reason === 'fled') {
        await prisma.rpgProfile.update({
          where: { guildId_userId: { guildId, userId } },
          data: { health: playerHp, lastBattle: new Date() }
        });

        const fledEmbed = new EmbedBuilder()
          .setTitle(m.rpg_fight_fled_title({ emoji: monster.emoji, name: monster.name }, { locale }))
          .setDescription(m.rpg_fight_fled_desc({ playerBar: buildHpBar(playerHp, playerMaxHp), name: monster.name, monsterBar: buildHpBar(monsterHp, monsterMaxHp) }, { locale }))
          .setColor('#FFA500')
          .setTimestamp();

        await interaction.editReply({ embeds: [fledEmbed], components: [row] });
        return;
      }

      if (reason === 'time') {
        await prisma.rpgProfile.update({
          where: { guildId_userId: { guildId, userId } },
          data: { health: playerHp, lastBattle: new Date() }
        });

        const timeoutEmbed = new EmbedBuilder()
          .setTitle(m.rpg_fight_timeout_title({}, { locale }))
          .setDescription(m.rpg_fight_timeout_desc({}, { locale }))
          .setColor('#808080')
          .setTimestamp();

        await interaction.editReply({ embeds: [timeoutEmbed], components: [row] });
        return;
      }

      if (reason === 'victory') {
        const xpEarned = monster.xpReward + Math.floor(Math.random() * Math.floor(monster.xpReward * 0.3));
        let coinsEarned = monster.coinReward + Math.floor(Math.random() * Math.floor(monster.coinReward * 0.3));

        let itemDropped: string | null = null;
        let itemDropEmoji: string | null = null;

        const drops = (Array.isArray(monster.drops) ? monster.drops : JSON.parse(String(monster.drops || '[]'))) as { itemName: string; chance: number; emoji?: string; coinBonus?: number }[];
        for (const drop of drops) {
          if (Math.random() < drop.chance) {
            itemDropped = drop.itemName;
            itemDropEmoji = drop.emoji || null;
            if (drop.coinBonus) coinsEarned += drop.coinBonus;

            const dropItem = await prisma.rpgItem.findFirst({
              where: {
                OR: [{ guildId: null }, { guildId }],
                name: drop.itemName
              }
            });
            if (dropItem) {
              await prisma.rpgInventoryItem.upsert({
                where: { rpgProfileId_itemId: { rpgProfileId: profile.id, itemId: dropItem.id } },
                update: { quantity: { increment: 1 } },
                create: { rpgProfileId: profile.id, itemId: dropItem.id, quantity: 1 }
              });
            }
            break;
          }
        }

        await prisma.rpgProfile.update({
          where: { guildId_userId: { guildId, userId } },
          data: {
            health: Math.max(1, playerHp),
            balance: { increment: coinsEarned },
            xp: { increment: xpEarned },
            totalMonstersKilled: !monster.isBoss ? { increment: 1 } : undefined,
            totalBossesKilled: monster.isBoss ? { increment: 1 } : undefined,
            lastBattle: new Date()
          }
        });

        await prisma.rpgBattle.create({
          data: {
            guildId, userId, monsterId: monster.id, monsterName: monster.name, won: true,
            damageDealt: totalDamageDealt, damageTaken: totalDamageTaken, xpEarned, coinsEarned, itemDropped
          }
        });

        const { checkLevelUp } = await import('../../services/features/economyService.js');
        const beforeLevel = profile.level;
        await checkLevelUp(guildId, userId);
        const afterProfile = await prisma.rpgProfile.findUnique({ where: { guildId_userId: { guildId, userId } } });
        const levelUp = afterProfile && afterProfile.level > beforeLevel ? afterProfile.level : null;

        const victoryEmbed = new EmbedBuilder()
          .setTitle(m.rpg_fight_victory_title({ emoji: monster.emoji, name: monster.name }, { locale }))
          .setDescription(m.rpg_fight_victory_desc({ name: monster.name, playerBar: buildHpBar(playerHp, playerMaxHp), log: turnsLog.slice(-4).join('\n') }, { locale }))
          .setColor(COLORS.success)
          .addFields(
            { name: m.rpg_fight_field_dmg_dealt({}, { locale }), value: `${totalDamageDealt}`, inline: true },
            { name: m.rpg_fight_field_dmg_taken({}, { locale }), value: `${totalDamageTaken}`, inline: true },
            { name: m.rpg_fight_field_xp_earned({}, { locale }), value: `+${xpEarned}`, inline: true },
            { name: m.rpg_fight_field_coins_earned({ emoji: config.currencyEmoji }, { locale }), value: `+${coinsEarned}`, inline: true },
          )
          .setTimestamp();

        if (itemDropped) {
          victoryEmbed.addFields({ name: m.rpg_fight_field_drop({}, { locale }), value: `${itemDropEmoji || '📦'} **${itemDropped}**`, inline: true });
        }

        if (levelUp) {
          victoryEmbed.addFields({ name: m.rpg_fight_field_levelup({}, { locale }), value: m.rpg_fight_field_levelup_desc({ level: levelUp }, { locale }) });
        }

        await interaction.editReply({ embeds: [victoryEmbed], components: [row] });
        return;
      }

      if (reason === 'defeat') {
        const xpEarned = Math.floor(monster.xpReward * 0.15);

        await prisma.rpgProfile.update({
          where: { guildId_userId: { guildId, userId } },
          data: {
            health: 1,
            xp: { increment: xpEarned },
            lastBattle: new Date()
          }
        });

        await prisma.rpgBattle.create({
          data: {
            guildId, userId, monsterId: monster.id, monsterName: monster.name, won: false,
            damageDealt: totalDamageDealt, damageTaken: totalDamageTaken, xpEarned, coinsEarned: 0, itemDropped: null
          }
        });

        const defeatEmbed = new EmbedBuilder()
          .setTitle(m.rpg_fight_defeat_title({ emoji: monster.emoji, name: monster.name }, { locale }))
          .setDescription(m.rpg_fight_defeat_desc({ name: monster.name, playerBar: buildHpBar(0, playerMaxHp), log: turnsLog.slice(-4).join('\n') }, { locale }))
          .setColor(COLORS.danger)
          .addFields(
            { name: m.rpg_fight_field_dmg_dealt({}, { locale }), value: `${totalDamageDealt}`, inline: true },
            { name: m.rpg_fight_field_dmg_taken({}, { locale }), value: `${totalDamageTaken}`, inline: true },
            { name: m.rpg_fight_field_xp_earned({}, { locale }), value: `+${xpEarned}`, inline: true },
          )
          .setTimestamp();

        await interaction.editReply({ embeds: [defeatEmbed], components: [row] });
        return;
      }
    } catch (err) {
      console.error(err);
    }
  });
}

export const rpgFightCommand = { data: rpgFightData, execute: rpgFightExecute } satisfies SlashCommandDefinition;


// ============================================================================
// RPG-BOSS — Combat de boss
// ============================================================================

const rpgBossData = new SlashCommandBuilder()
  .setName('rpg-boss')
  .setDescription('🐲 Affronter un boss puissant')
  .addStringOption(option =>
    option.setName('boss').setDescription('Nom du boss à affronter').setRequired(true).setAutocomplete(true)
  );

async function rpgBossExecute(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  if (!await checkEconomyEnabled(interaction, locale)) return;
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.rpgEnabled) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_travel_disabled_title({}, { locale }), m.rpg_boss_disabled_desc({}, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  const bossName = interaction.options.getString('boss', true);
  const boss = await findBoss(guildId, bossName);
  if (!boss) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_boss_not_found_title({}, { locale }), m.rpg_boss_not_found_desc({ name: bossName }, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  const profile = await getOrCreateRpgProfile(guildId, userId);

  if (profile.level < boss.level) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_boss_low_level_title({}, { locale }), m.rpg_boss_low_level_desc({ level: boss.level, myLevel: profile.level }, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  if (profile.energy < 30) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_boss_low_energy_title({}, { locale }), m.rpg_boss_low_energy_desc({ energy: profile.energy }, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  if (profile.health <= 10) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_boss_low_hp_title({}, { locale }), m.rpg_boss_low_hp_desc({}, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  // Atomic guard: only spend energy if the row still has enough at write time, so two
  // near-simultaneous energy-consuming actions can't both pass a stale check and push
  // energy below zero.
  const energySpent = await prisma.rpgProfile.updateMany({
    where: { guildId, userId, energy: { gte: 30 } },
    data: { energy: { decrement: 30 } }
  });

  if (energySpent.count === 0) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_boss_low_energy_title({}, { locale }), m.rpg_boss_low_energy_desc({ energy: profile.energy }, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  await interaction.deferReply();

  const result = await simulateBattle(profile, boss);
  const turnSummary = result.turns.slice(-8).map(t => {
    const who = t.attacker === 'player' ? m.rpg_boss_you_label({}, { locale }) : `${boss.emoji} ${boss.name}`;
    const crit = t.critical ? m.rpg_fight_critical_suffix({}, { locale }) : '';
    return m.rpg_boss_turn_log({ who, dmg: t.damage, crit }, { locale });
  }).join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`${result.won ? m.rpg_boss_won_title({}, { locale }) : m.rpg_boss_lost_title({}, { locale })} — ${boss.emoji} ${boss.name}`)
    .setDescription(
      `${boss.description}\n\n` +
      `${m.rpg_boss_combat_summary_label({ turns: result.turns.length }, { locale })}\n${turnSummary}`
    )
    .setColor(result.won ? COLORS.success : COLORS.danger)
    .addFields(
      { name: m.rpg_fight_field_dmg_dealt({}, { locale }), value: `${result.totalDamageDealt}`, inline: true },
      { name: m.rpg_fight_field_dmg_taken({}, { locale }), value: `${result.totalDamageTaken}`, inline: true },
      { name: m.rpg_fight_field_hp_remaining({}, { locale }), value: `${result.playerHpRemaining} / ${profile.maxHealth}`, inline: true },
      { name: m.rpg_fight_field_xp_earned({}, { locale }), value: `+${result.xpEarned}`, inline: true },
      { name: m.rpg_fight_field_coins_earned({ emoji: config.currencyEmoji }, { locale }), value: `+${result.coinsEarned}`, inline: true },
    )
    .setTimestamp();

  if (result.itemDropped) {
    embed.addFields({ name: m.rpg_boss_field_drop({}, { locale }), value: `${result.itemDropEmoji || '📦'} **${result.itemDropped}**` });
  }

  if (result.levelUp) {
    embed.addFields({ name: m.rpg_fight_field_levelup({}, { locale }), value: m.rpg_fight_field_levelup_desc({ level: result.levelUp }, { locale }) });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function rpgBossAutocomplete(interaction: AutocompleteInteraction) {
  const locale = await getEffectiveLocale(interaction as unknown as ChatInputCommandInteraction);
  const guildId = interaction.guildId;
  if (!guildId) return;
  const focused = interaction.options.getFocused().toLowerCase();
  const bosses = await listBosses(guildId);
  const filtered = bosses
    .filter(b => b.name.toLowerCase().includes(focused))
    .slice(0, 25)
    .map(b => ({ name: `${b.emoji} ${b.name}${m.rpg_boss_autocomplete_level({ level: b.level }, { locale })}`, value: b.name }));
  await interaction.respond(filtered);
}

export const rpgBossCommand = { data: rpgBossData, execute: rpgBossExecute, autocomplete: rpgBossAutocomplete } satisfies SlashCommandDefinition;


// ============================================================================
// RPG-BESTIARY — Bestiaire des monstres découverts
// ============================================================================

const rpgBestiaryData = new SlashCommandBuilder()
  .setName('rpg-bestiary')
  .setDescription('📖 Consulter votre bestiaire de monstres découverts');

async function rpgBestiaryExecute(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  if (!await checkEconomyEnabled(interaction, locale)) return;
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  await interaction.deferReply();

  const discovered = await listDiscoveredMonsters(guildId, userId);

  if (discovered.length === 0) {
    await interaction.editReply({ embeds: [errorEmbed(m.rpg_bestiary_empty_title({}, { locale }), m.rpg_bestiary_empty_desc({}, { locale }))] });
    return;
  }

  const allMonsters = await prisma.rpgMonster.count({
    where: { OR: [{ guildId: null }, { guildId }] }
  });

  const lines = discovered.map(mo => {
    const bossTag = mo.isBoss ? m.rpg_bestiary_boss_tag({}, { locale }) : '';
    return `${mo.emoji} **${mo.name}**${bossTag} — Niv. ${mo.level} | ❤️ ${mo.health} | ⚔️ ${mo.attack} | 🛡️ ${mo.defense}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_bestiary_title({ name: interaction.user.displayName }, { locale }))
    .setDescription(m.rpg_bestiary_desc({ count: discovered.length, total: allMonsters, lines: lines.join('\n') }, { locale }))
    .setColor(COLORS.primary)
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

export const rpgBestiaryCommand = { data: rpgBestiaryData, execute: rpgBestiaryExecute } satisfies SlashCommandDefinition;


// ============================================================================
// FISH — Pêche
// ============================================================================

const fishData = new SlashCommandBuilder()
  .setName('fish')
  .setDescription('🎣 Pêcher un poisson et gagner des pièces');

async function fishExecute(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  if (!await checkEconomyEnabled(interaction, locale)) return;
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  const config = await getOrCreateEconomyConfig(guildId);

  try {
    const result = await fish(guildId, userId);

    if (!result.success) {
      if (result.cooldown) {
        await interaction.reply({
          embeds: [errorEmbed(m.rpg_fish_cooldown_title({}, { locale }), m.rpg_fish_cooldown_desc({ min: (result.remainingMin ?? 0), sec: (result.remainingSec ?? 0) }, { locale }))],
          flags: [MessageFlags.Ephemeral]
        });
        return;
      }
      if (result.noEnergy) {
        await interaction.reply({
          embeds: [errorEmbed(m.rpg_fish_no_energy_title({}, { locale }), m.rpg_fish_no_energy_desc({}, { locale }))],
          flags: [MessageFlags.Ephemeral]
        });
        return;
      }
      return;
    }

    const rarityLabels: Record<string, string> = {
      COMMON: m.rpg_fish_rarity_common({}, { locale }),
      UNCOMMON: m.rpg_fish_rarity_uncommon({}, { locale }),
      RARE: m.rpg_fish_rarity_rare({}, { locale }),
      EPIC: m.rpg_fish_rarity_epic({}, { locale }),
      LEGENDARY: m.rpg_fish_rarity_legendary({}, { locale }),
    };

    const embed = new EmbedBuilder()
      .setTitle(m.rpg_fish_title({}, { locale }))
      .setDescription(m.rpg_fish_desc({ emoji: result.fish.emoji, name: result.fish.name, rarityIcon: result.rarityIcon, rarity: rarityLabels[result.fish.rarity] || result.fish.rarity }, { locale }))
      .setColor(
        result.fish.rarity === 'LEGENDARY' ? 0xffd700 :
        result.fish.rarity === 'EPIC' ? 0x9b59b6 :
        result.fish.rarity === 'RARE' ? 0x3498db :
        result.fish.rarity === 'UNCOMMON' ? 0x2ecc71 :
        COLORS.primary
      )
      .addFields(
        { name: m.rpg_fish_field_value({ emoji: config.currencyEmoji }, { locale }), value: m.rpg_fish_field_value_value({ value: result.fish.value, currency: config.currencyName }, { locale }), inline: true },
        { name: m.rpg_fish_field_xp({}, { locale }), value: `**+${result.fish.xp}**`, inline: true },
        { name: m.rpg_fish_field_total({}, { locale }), value: m.rpg_fish_field_total_value({ count: result.totalFishCaught }, { locale }), inline: true },
      )
      .setTimestamp();

    await interaction.reply({ embeds: [embed] });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : m.rpg_fish_error({}, { locale });
    await interaction.reply({ embeds: [errorEmbed(m.rpg_generic_error_title({}, { locale }), errMsg)], flags: [MessageFlags.Ephemeral] });
  }
}

export const fishCommand = { data: fishData, execute: fishExecute } satisfies SlashCommandDefinition;
