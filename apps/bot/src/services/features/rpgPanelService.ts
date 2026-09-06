import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ContainerBuilder,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Client,
  type GuildMember,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type User,
} from 'discord.js';
import prisma from '../../utils/db.js';
import { errorMessage } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { errorEmbed, joinFieldEntries, successEmbed, truncate, COLORS } from '../../utils/embeds.js';
import { getEffectiveLocale, type BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { parseRpgRoute } from '../../handlers/interactionRoutes.js';
import { embedToV2 } from '../../utils/patchV2.js';
import { combatHpBar, gaugeBar, icon, itemTypeIcon, rarityIcon, RPG_COLORS } from './rpg/rpgIcons.js';
import {
  asClanWarScope,
  getClanWarState,
  getViewerWarTeam,
  type ClanWarScope,
  type ClanWarState,
} from './rpg/rpgClanWarService.js';
import {
  getOrCreateRpgProfile,
  getOrCreateEconomyConfig,
  claimDaily,
  startTravel,
  resolveTravel,
  chooseAdventureOutcome,
  buyShopItem,
  MAX_SHOP_BUY_QUANTITY,
  equipInventoryItem,
  consumePotionItem,
  getShopModuleState,
  createRpgGuild,
  findRpgGuildByName,
  joinRpgGuild,
  leaveRpgGuild,
  depositToRpgGuildTreasury,
  sellShopItem,
  adminSetStats,
  transferCoins,
  fish,
  isItemEquipped,
  xpRequiredForLevel,
} from './economyService.js';
import {
  CLASS_UNLOCK_LEVEL,
  RPG_CLASS_LIST,
  getRpgClass,
} from './rpg/rpgClasses.js';
import { MAX_UPGRADE_LEVEL, getEffectiveStats, type EquippedPiece } from './rpg/rpgStats.js';
import { formatEnchant } from './rpg/rpgEnchantments.js';
import {
  DISENCHANT_COST,
  applyEnchantScroll,
  getEnchantAltarState,
  removeEnchant,
} from './rpg/rpgEnchantService.js';
import {
  RECLASS_COST,
  allocateStatPoint,
  chooseRpgClass,
  craftRecipe,
  getUpgradeQuotes,
  listRecipesFor,
  upgradeEquipment,
  type AllocatableStat,
  type EquipmentSlot,
} from './rpg/rpgProgressionService.js';
import {
  findRandomMonster,
  listBosses,
  listDiscoveredMonsters,
  loadEffectiveStats,
  loadEquipment,
  simulateBattle,
} from './combatService.js';
import { getAvailableSkills } from './rpg/rpgClasses.js';
import { findGuildMonsterById, listGuildMonsters } from './rpg/rpgBestiaryService.js';
import { awardRpgTeamPoints } from './rpg/rpgTeamRewards.js';
import type { RpgQuestObjective } from './rpg/rpgQuestPolicy.js';
import { isShopItemUnlocked, rpgGuildXpNeeded, type ShopModuleState } from './economyPolicy.js';
import { attackRaid, checkRaidAssaultGrant, getRaidPanelState, getRaidState, grantRaidAssaults, RaidError } from './rpg/rpgRaidService.js';
import { buildAssaultEmbed, buildRaidEmbed, healthBar } from './rpg/rpgRaidPanel.js';
import { computeAttack } from './rpg/rpgCombatMath.js';
import {
  buyBlackMarketOffer,
  getBlackMarketState,
  getMemberBlackMarketOffers,
  type BlackMarketOfferView,
} from './rpg/rpgBlackMarketService.js';

type Locale = BotLocale;
type PanelInteraction = ButtonInteraction | StringSelectMenuInteraction | ModalSubmitInteraction;

// Coûts et verrous de combat, centralisés pour que le contrôle préalable et l'écriture
// atomique ne puissent plus diverger.
const FIGHT_ENERGY_COST = 15;
const FIGHT_COOLDOWN_MS = 2 * 60 * 1000;
const FIGHT_MIN_HEALTH = 5;
const BOSS_ENERGY_COST = 30;
const BOSS_MIN_HEALTH = 10;
const COMBAT_TURN_TIMEOUT_MS = 60 * 1000;
type PanelRow = ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>;

/**
 * Un écran du hub.
 *
 * `embeds` reste la façon normale de décrire un écran : le rendu les convertit
 * en Components V2 au dernier moment, ce qui laisse les gestionnaires poser un
 * pied de page sur `view.embeds[0]` après coup, comme avant. `container` sert
 * aux écrans qui ont besoin de composants riches - la boutique et son bouton
 * par article - que jamais un embed ne saura porter.
 */
type PanelView = {
  embeds: EmbedBuilder[];
  components: PanelRow[];
  container?: ContainerBuilder;
};

/** Charge utile prête à envoyer : un ou plusieurs conteneurs, rien d'autre. */
type PanelPayload = {
  components: ContainerBuilder[];
  flags: MessageFlags.IsComponentsV2;
  allowedMentions: { parse: [] };
};

type AdminStat = 'balance' | 'level' | 'xp';

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
  hpBonus: number;
  hpRestore: number;
  energyRestore: number;
  levelXpReward: number;
  clanPointsReward: number;
  raidAssaultBonus: number;
  price: number;
}

interface LocalInventoryEntry {
  id: string;
  rpgProfileId: string;
  itemId: string;
  quantity: number;
  item: LocalRpgItem;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

// Les barres de progression vivent désormais dans `rpgIcons` : elles sont faites
// des segments du module, et non plus de carrés Unicode répétés.

function buildHpBar(current: number, max: number): string {
  return combatHpBar(current, max);
}

function parseUserIdFromText(text: string): string | null {
  const trimmed = text.trim();
  const mention = trimmed.match(/^<@!?(\d{17,20})>$/);
  if (mention) return mention[1];
  if (/^\d{17,20}$/.test(trimmed)) return trimmed;
  return null;
}

export function isInteractionAdmin(interaction: { memberPermissions: import('discord.js').PermissionsBitField | null }): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
}

async function ensureOwner(interaction: PanelInteraction, ownerId: string, locale: Locale): Promise<boolean> {
  if (interaction.user.id === ownerId) return true;
  await interaction.reply({ content: m.rpg_hub_not_yours({}, { locale }), flags: [MessageFlags.Ephemeral] });
  return false;
}

async function replyPanelError(interaction: PanelInteraction, err: unknown, locale: Locale): Promise<void> {
  const embed = errorEmbed(m.rpg_generic_error_title({}, { locale }), errorMessage(err));

  // Les écrans qui défèrent l'interaction (combat, boss) ne peuvent plus utiliser `reply` :
  // l'appel échouait alors en silence et le joueur ne voyait jamais l'erreur.
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ embeds: [embed], flags: [MessageFlags.Ephemeral] }).catch(() => null);
    return;
  }

  await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] }).catch(() => null);
}

/**
 * Compose l'écran en un seul bloc Components V2, commandes comprises.
 *
 * Les rangées vivaient sous l'embed, dans un bloc séparé : à chaque changement
 * d'écran, le corps et les boutons se redessinaient l'un après l'autre et la
 * navigation sautait. Enfermer les commandes dans le conteneur de l'écran -
 * comme le fait `/casier` - donne une carte unique qui se remplace d'un bloc.
 *
 * Le nombre de composants ne change pas : ils sont seulement imbriqués, ce qui
 * laisse intacte la limite des 40 par message.
 */
export function renderPanelView(view: PanelView): PanelPayload {
  const containers = view.container
    ? [view.container]
    : view.embeds.map((embed) => embedToV2(embed));

  if (containers.length === 0) {
    containers.push(new ContainerBuilder().setAccentColor(RPG_COLORS.hub));
  }

  const host = containers[containers.length - 1];
  if (view.components.length > 0) {
    host.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    for (const row of view.components) {
      host.addActionRowComponents(row as ActionRowBuilder<MessageActionRowComponentBuilder>);
    }
  }

  return {
    components: containers,
    flags: MessageFlags.IsComponentsV2,
    // Les fiches de guilde et les tableaux de guerre citent des membres : un
    // embed n'a jamais notifié, un TextDisplay le ferait sans ce garde-fou.
    allowedMentions: { parse: [] },
  };
}

async function respond(interaction: PanelInteraction, view: PanelView): Promise<void> {
  const payload = renderPanelView(view);

  if (interaction.isModalSubmit() && interaction.isFromMessage()) {
    await interaction.update(payload);
    return;
  }
  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    await interaction.update(payload);
    return;
  }
  await interaction.reply(payload);
}

function backRow(ownerId: string, locale: Locale): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:hub`)
      .setLabel(m.rpg_hub_btn_back({}, { locale }))
      .setEmoji(icon('rpgBack'))
      .setStyle(ButtonStyle.Secondary),
  );
}

// ─────────────────────────────────────────────────────────────
// Hub (vue par défaut)
// ─────────────────────────────────────────────────────────────

/**
 * Libellé d'un objet équipé : niveau de forge et enchantements posés.
 * Les deux vivent sur l'instance, donc sur l'exemplaire réellement possédé.
 */
function equippedLabel(
  item: { emoji: string; name: string } | null,
  piece: EquippedPiece | null,
  locale: Locale,
): string {
  if (!item) return m.rpg_profile_no_item({}, { locale });

  const upgrade = piece?.upgrade ?? 0;
  const base = upgrade > 0 ? `${item.emoji} ${item.name} **+${upgrade}**` : `${item.emoji} ${item.name}`;

  const enchants = piece?.enchants ?? [];
  if (enchants.length === 0) return base;

  return `${base}\n${enchants.map(formatEnchant).join(' · ')}`;
}

async function buildHubEmbed(guildId: string, target: User, locale: Locale): Promise<EmbedBuilder> {
  const profile = await getOrCreateRpgProfile(guildId, target.id);
  const config = await getOrCreateEconomyConfig(guildId);

  const equippedIds = [profile.weaponId, profile.armorId, profile.accessoryId].filter((id): id is string => Boolean(id));
  const equippedItems = equippedIds.length > 0
    ? await prisma.rpgItem.findMany({ where: { id: { in: equippedIds } } })
    : [];
  const itemById = new Map(equippedItems.map((item) => [item.id, item]));
  const weapon = profile.weaponId ? itemById.get(profile.weaponId) ?? null : null;
  const armor = profile.armorId ? itemById.get(profile.armorId) ?? null : null;
  const accessory = profile.accessoryId ? itemById.get(profile.accessoryId) ?? null : null;

  // L'équipement est rechargé avec sa progression : c'est elle qui porte la forge et les
  // enchantements, et la fiche doit montrer exactement ce que le combat va utiliser.
  const equipment = await loadEquipment(profile);
  const stats = getEffectiveStats(profile, equipment);
  const rpgClass = getRpgClass(profile.className);
  const xpNeeded = xpRequiredForLevel(profile.level);
  // La fiche affiche les PV plafonnés aux PV max effectifs : déséquiper un objet qui
  // donnait des PV ne doit pas laisser un « 180/140 » incohérent à l'écran.
  const shownHp = Math.min(profile.health, stats.maxHealth);

  const embed = new EmbedBuilder()
    .setTitle(`${icon('rpgCharacter')} ${m.rpg_profile_title({ name: target.displayName }, { locale })}`)
    .setThumbnail(target.displayAvatarURL({ size: 256 }))
    .setColor(RPG_COLORS.hub)
    .setDescription(profile.isTraveling
      ? `${icon('rpgTravel')} ${m.rpg_profile_traveling({ dest: profile.travelDestination ?? '' }, { locale })}`
      : `${icon('rpgRest')} ${m.rpg_profile_resting({}, { locale })}`)
    .addFields(
      { name: m.rpg_profile_field_wallet({ emoji: config.currencyEmoji }, { locale }), value: `**${profile.balance}** ${config.currencyName}`, inline: true },
      { name: `${icon('star')} ${m.rpg_profile_field_level({}, { locale })}`, value: m.rpg_profile_level_value({ level: profile.level }, { locale }), inline: true },
      {
        name: `${icon('rpgEnchant')} ${m.rpg_profile_field_class({}, { locale })}`,
        value: rpgClass
          ? `${rpgClass.emoji} **${rpgClass.name}**\n*${rpgClass.passive.name}*`
          : m.rpg_profile_class_none({ level: CLASS_UNLOCK_LEVEL }, { locale }),
        inline: true,
      },
      { name: `${icon('rpgEnergy')} ${m.rpg_profile_field_energy({}, { locale })}`, value: `${profile.energy} / ${config.maxEnergy}\n${gaugeBar(profile.energy, config.maxEnergy, 'en')}`, inline: false },
      { name: `${icon('rpgHp')} ${m.rpg_profile_field_hp({}, { locale })}`, value: `${shownHp} / ${stats.maxHealth}\n${gaugeBar(shownHp, stats.maxHealth, 'hp')}`, inline: false },
      { name: `${icon('rpgXp')} ${m.rpg_profile_field_xp({}, { locale })}`, value: `${profile.xp} / ${xpNeeded} XP\n${gaugeBar(profile.xp, xpNeeded, 'xp')}`, inline: false },
      {
        name: `${icon('rpgFight')} ${m.rpg_profile_field_combat_stats({}, { locale })}`,
        value: `${m.rpg_profile_combat_stats_value({
          iAtk: icon('rpgAtk'), atk: stats.attack,
          iDef: icon('rpgDef'), def: stats.defense,
          iSpd: icon('rpgSpd'), spd: stats.speed,
        }, { locale })}\n`
          + m.rpg_profile_crit_value({ iCrit: icon('rpgCrit'), crit: Math.round(stats.critChance * 100) }, { locale }),
        inline: true,
      },
      {
        name: `${icon('rpgArmor')} ${m.rpg_profile_field_equipment({}, { locale })}`,
        value: m.rpg_profile_equipment_value({
          iWeapon: icon('rpgSword'), weapon: equippedLabel(weapon, equipment.weapon, locale),
          iArmor: icon('rpgArmor'), armor: equippedLabel(armor, equipment.armor, locale),
        }, { locale })
          + `\n${icon('rpgAccessory')} ${m.rpg_profile_accessory_label({}, { locale })} ${equippedLabel(accessory, equipment.accessory, locale)}`,
        inline: true,
      },
    );

  if (profile.statPoints > 0) {
    embed.addFields({
      name: `${icon('rpgXp')} ${m.rpg_profile_field_stat_points({}, { locale })}`,
      value: m.rpg_profile_stat_points_value({ points: profile.statPoints }, { locale }),
      inline: false,
    });
  }

  if (profile.rpgGuild) {
    embed.addFields({
      name: `${icon('rpgGuild')} ${m.rpg_profile_field_guild({}, { locale })}`,
      value: `${m.rpg_profile_guild_value({ emoji: profile.rpgGuild.emoji, name: profile.rpgGuild.name, level: profile.rpgGuild.level }, { locale })}\n${icon('coins')} ${m.rpg_guild_field_treasury({}, { locale })} : **${profile.rpgGuild.treasury}** ${config.currencyEmoji}`,
      inline: false,
    });
  }

  return embed;
}

/**
 * Destinations rangées dans le menu de navigation.
 *
 * Le hub alignait treize boutons sur trois rangées, dont neuf menaient à un
 * écran qu'on ouvre une fois par partie : la fiche disparaissait sous ses
 * propres commandes. Ne restent en boutons que les gestes du tour de jeu ; tout
 * ce qui se visite passe par ce menu, qui ne coûte qu'une rangée.
 *
 * `value` est le nom de section lu par `renderSection`, sauf `pay` et `sell`
 * qui ouvrent une fenêtre de saisie.
 */
function hubNavOptions(locale: Locale, isAdmin: boolean): { label: string; value: string; description?: string; emoji: string }[] {
  const options = [
    { label: m.rpg_hub_btn_character({}, { locale }), value: 'character', description: m.rpg_hub_nav_character_desc({}, { locale }), emoji: icon('rpgCharacter') },
    { label: m.rpg_hub_btn_craft({}, { locale }), value: 'craft', description: m.rpg_hub_nav_craft_desc({}, { locale }), emoji: icon('rpgCraft') },
    { label: m.rpg_hub_btn_forge({}, { locale }), value: 'forge', description: m.rpg_hub_nav_forge_desc({}, { locale }), emoji: icon('rpgForge') },
    { label: m.rpg_hub_btn_enchant({}, { locale }), value: 'enchant', description: m.rpg_hub_nav_enchant_desc({}, { locale }), emoji: icon('rpgEnchant') },
    { label: m.rpg_hub_btn_bestiary({}, { locale }), value: 'bestiary', description: m.rpg_hub_nav_bestiary_desc({}, { locale }), emoji: icon('rpgBestiary') },
    { label: m.rpg_hub_btn_guild({}, { locale }), value: 'guild', description: m.rpg_hub_nav_guild_desc({}, { locale }), emoji: icon('rpgGuild') },
    { label: m.rpg_war_title({}, { locale }), value: 'clanwar', description: m.rpg_hub_nav_war_desc({}, { locale }), emoji: icon('rpgWar') },
    { label: m.rpg_hub_btn_pay({}, { locale }), value: 'pay', description: m.rpg_hub_nav_pay_desc({}, { locale }), emoji: icon('rpgPay') },
    { label: m.rpg_hub_btn_sell({}, { locale }), value: 'sell', description: m.rpg_hub_nav_sell_desc({}, { locale }), emoji: icon('rpgSell') },
  ];

  if (isAdmin) {
    options.push({ label: m.rpg_hub_btn_admin({}, { locale }), value: 'admin', description: m.rpg_hub_nav_admin_desc({}, { locale }), emoji: icon('settings') });
  }

  return options;
}

function hubNavRow(ownerId: string, locale: Locale, isAdmin: boolean): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`rpg:navsel:${ownerId}`)
    .setPlaceholder(m.rpg_hub_nav_placeholder({}, { locale }))
    .addOptions(hubNavOptions(locale, isAdmin).map((option) => ({
      label: truncate(option.label, 100),
      value: option.value,
      description: optionDescription(option.description),
      emoji: optionEmoji(option.emoji),
    })));

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

function buildHubButtons(
  ownerId: string,
  locale: Locale,
  isAdmin: boolean,
  blackMarketOpen: boolean,
  raidOpen: boolean,
): PanelRow[] {
  // Rangée 1 : ce qui se joue. Rangée 2 : ce qui se ramasse et ce qui se porte.
  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rpg:fight:${ownerId}`).setLabel(m.rpg_hub_btn_fight({}, { locale })).setEmoji(icon('rpgFight')).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`rpg:nav:${ownerId}:boss`).setLabel(m.rpg_hub_btn_boss({}, { locale })).setEmoji(icon('rpgBoss')).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`rpg:nav:${ownerId}:travel`).setLabel(m.rpg_hub_btn_travel({}, { locale })).setEmoji(icon('rpgTravel')).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rpg:daily:${ownerId}`).setLabel(m.rpg_hub_btn_daily({}, { locale })).setEmoji(icon('rpgDaily')).setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`rpg:fish:${ownerId}`).setLabel(m.rpg_hub_btn_fish({}, { locale })).setEmoji(icon('rpgFish')).setStyle(ButtonStyle.Success),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rpg:nav:${ownerId}:inventory`).setLabel(m.rpg_hub_btn_inventory({}, { locale })).setEmoji(icon('rpgBag')).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rpg:nav:${ownerId}:shop`).setLabel(m.rpg_hub_btn_shop({}, { locale })).setEmoji(icon('rpgShop')).setStyle(ButtonStyle.Primary),
  );

  // Le marché noir n'apparaît que pendant sa fenêtre d'ouverture : c'est le seul indice
  // donné aux membres qui ne comptent pas sur l'annonce, et ça garde l'effet de surprise.
  if (blackMarketOpen) {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(`rpg:nav:${ownerId}:blackmarket`)
        .setLabel(m.rpg_blackmarket_btn({}, { locale }))
        .setEmoji(icon('rpgBlackMarket'))
        .setStyle(ButtonStyle.Danger),
    );
  }

  // Même règle pour le raid, pour la raison inverse : il se jouait uniquement depuis son
  // annonce, et qui arrivait après elle n'avait plus aucun moyen de le trouver.
  if (raidOpen) {
    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(`rpg:nav:${ownerId}:raid`)
        .setLabel(m.rpg_raid_panel_btn({}, { locale }))
        .setEmoji(icon('rpgRaid'))
        .setStyle(ButtonStyle.Danger),
    );
  }

  return [row1, row2, hubNavRow(ownerId, locale, isAdmin)];
}

export async function buildHubView(
  guildId: string,
  viewer: User,
  target: User,
  locale: Locale,
  viewerIsAdmin = false,
): Promise<PanelView> {
  const embed = await buildHubEmbed(guildId, target, locale);
  // Consulter la fiche d'un autre membre est en lecture seule : aucun bouton d'action.
  if (viewer.id !== target.id) {
    return { embeds: [embed], components: [] };
  }
  const [blackMarket, raid] = await Promise.all([
    getBlackMarketState(guildId),
    getRaidState(guildId),
  ]);
  return {
    embeds: [embed],
    components: buildHubButtons(viewer.id, locale, viewerIsAdmin, Boolean(blackMarket.session), raid.enabled && raid.open !== null),
  };
}

// ─────────────────────────────────────────────────────────────
// Inventaire
// ─────────────────────────────────────────────────────────────

async function buildInventoryView(guildId: string, ownerId: string, locale: Locale): Promise<PanelView> {
  const profile = await getOrCreateRpgProfile(guildId, ownerId);
  const inventory = profile.inventory as unknown as LocalInventoryEntry[];

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_inventory_title({}, { locale }))
    .setColor(RPG_COLORS.hub);

  if (inventory.length === 0) {
    embed.setDescription(m.rpg_inventory_empty_desc({}, { locale }));
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  embed.setDescription(m.rpg_inventory_desc({}, { locale }));

  // Les matériaux ne s'équipent ni ne se consomment : ils alimentent l'artisanat. Les
  // parchemins ne se posent qu'à l'autel. On sépare les deux pour qu'ils n'encombrent pas
  // le sélecteur d'action (limité à 25 options) avec des lignes qui n'y feraient rien.
  const usable = inventory.filter((entry) => entry.item.type !== 'MATERIAL' && entry.item.type !== 'SCROLL');
  const materials = inventory.filter((entry) => entry.item.type === 'MATERIAL');
  const scrolls = inventory.filter((entry) => entry.item.type === 'SCROLL');

  const formatLine = (entry: LocalInventoryEntry) => {
    const item = entry.item;
    let desc = `${item.emoji} **${item.name}** (x${entry.quantity}) - ${rarityIcon(item.rarity)} *${item.type}*`;
    if (isItemEquipped(profile, item.id)) desc += m.rpg_inventory_equipped_tag({}, { locale });
    return desc;
  };

  if (usable.length > 0) {
    embed.addFields({ name: m.rpg_inventory_field_content({}, { locale }), value: usable.map(formatLine).join('\n').slice(0, 1024) });
  }
  if (scrolls.length > 0) {
    embed.addFields({
      name: m.rpg_inventory_field_scrolls({}, { locale }),
      value: scrolls.map((entry) => `${entry.item.emoji} ${entry.item.name} **x${entry.quantity}**`).join('\n').slice(0, 1024),
    });
  }
  if (materials.length > 0) {
    embed.addFields({
      name: m.rpg_inventory_field_materials({}, { locale }),
      value: materials.map((entry) => `${entry.item.emoji} ${entry.item.name} **x${entry.quantity}**`).join('\n').slice(0, 1024),
    });
  }

  if (usable.length === 0) {
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`rpg:invuse:${ownerId}`)
    .setPlaceholder(m.rpg_inventory_select_placeholder({}, { locale }));

  usable.slice(0, 25).forEach((entry) => {
    const item = entry.item;
    select.addOptions({
      label: `${item.name} (x${entry.quantity})`.slice(0, 100),
      // Un objet équipé propose désormais « déséquiper » : sans cette action, il restait
      // porté à vie et `sellShopItem` refusait de le vendre.
      description: isItemEquipped(profile, item.id)
        ? m.rpg_inventory_unequip_item({}, { locale })
        : item.type === 'POTION'
          ? m.rpg_inventory_consume_potion({}, { locale })
          : m.rpg_inventory_equip_item({}, { locale }),
      value: item.id,
      emoji: optionEmoji(item.emoji),
    });
  });

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  return { embeds: [embed], components: [selectRow, backRow(ownerId, locale)] };
}

/**
 * Verse les récompenses des modules voisins portées par un objet consommé.
 *
 * L'objet a déjà quitté l'inventaire quand on arrive ici : chaque versement est isolé, une
 * panne d'un module ne doit ni emporter l'autre ni transformer la consommation en erreur.
 * Seuls les montants réellement versés sont renvoyés, pour ne rien annoncer de faux.
 */
async function grantItemModuleRewards(
  guildId: string,
  userId: string,
  item: { itemName: string; levelXpReward: number; clanPointsReward: number },
  modules: ShopModuleState,
  interaction: StringSelectMenuInteraction,
): Promise<{ levelXp: number; clanPoints: number }> {
  const granted = { levelXp: 0, clanPoints: 0 };

  if (modules.levelingEnabled && item.levelXpReward > 0) {
    try {
      const { addXp } = await import('../progression/levelingService.js');
      await addXp(guildId, userId, item.levelXpReward, interaction.client, interaction.channelId ?? undefined);
      granted.levelXp = item.levelXpReward;
    } catch (err) {
      logger.error('RpgPanel', `Échec du versement d'XP pour ${item.itemName} :`, err);
    }
  }

  if (modules.clanPointsEnabled && item.clanPointsReward > 0) {
    try {
      const { awardClanPointsToMembers } = await import('../community/clanService.js');
      const awarded = await awardClanPointsToMembers({
        guildId,
        client: interaction.client,
        source: 'RPG_ITEM',
        awards: [{ userId, amount: item.clanPointsReward }],
        reason: item.itemName,
      });
      granted.clanPoints = awarded.get(userId) ?? 0;
    } catch (err) {
      logger.error('RpgPanel', `Échec du versement de points de clan pour ${item.itemName} :`, err);
    }
  }

  return granted;
}

async function handleInventoryUse(interaction: StringSelectMenuInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const itemId = interaction.values[0];
  const profile = await getOrCreateRpgProfile(guildId, ownerId);
  const inventory = profile.inventory as unknown as LocalInventoryEntry[];
  const selectedEntry = inventory.find((e) => e.item.id === itemId);
  if (!selectedEntry) {
    await replyPanelError(interaction, new Error(m.rpg_inventory_empty_desc({}, { locale })), locale);
    return;
  }

  // L'action ne produisait aucun retour : la vue était simplement re-rendue, sans indiquer
  // ce qui venait de se passer (potion bue, objet équipé/déséquipé).
  let feedback: string;
  if (selectedEntry.item.type === 'POTION') {
    // Refus avant consommation : un module éteint entre l'achat et l'usage ne doit pas
    // faire disparaître l'objet contre une récompense que personne ne versera.
    const modules = await getShopModuleState(guildId);
    if (!isShopItemUnlocked(selectedEntry.item, modules)) {
      await replyPanelError(interaction, new Error(m.rpg_item_module_locked_desc({ item: selectedEntry.item.name }, { locale })), locale);
      return;
    }

    // Même raisonnement pour un objet qui vend des points de clan : sans clan, le versement
    // serait ignoré et l'objet perdu. On refuse tant qu'il est encore dans l'inventaire.
    if (selectedEntry.item.clanPointsReward > 0) {
      const member = interaction.guild?.members.cache.get(ownerId)
        ?? await interaction.guild?.members.fetch(ownerId).catch(() => null);
      const { memberHasClan } = await import('../community/clanService.js');
      if (!member || !(await memberHasClan(guildId, member))) {
        await replyPanelError(interaction, new Error(m.rpg_item_no_clan_desc({ item: selectedEntry.item.name }, { locale })), locale);
        return;
      }
    }

    // Une potion d'assaut ne se boit que pendant une fenêtre ouverte, et sous le plafond
    // du serveur : le contrôle passe avant la consommation, sinon l'objet disparaîtrait
    // contre un bonus que le raid refuserait ensuite.
    if (selectedEntry.item.raidAssaultBonus > 0) {
      const check = await checkRaidAssaultGrant(guildId, ownerId, selectedEntry.item.raidAssaultBonus);
      if (!check.ok) {
        await replyPanelError(interaction, new Error(check.reason ?? m.rpg_raid_panel_attack_failed({}, { locale })), locale);
        return;
      }
    }

    const used = await consumePotionItem(guildId, ownerId, itemId);
    const rewards = await grantItemModuleRewards(guildId, ownerId, used, modules, interaction);
    feedback = m.rpg_potion_consumed_desc({
      item: used.itemName,
      hp: used.restoredHp,
      newHp: used.newHp,
      energy: used.restoredEnergy,
      newEnergy: used.newEnergy,
    }, { locale });
    if (rewards.levelXp > 0) feedback += m.rpg_reward_xp_suffix({ xp: rewards.levelXp }, { locale });
    if (rewards.clanPoints > 0) feedback += m.rpg_reward_clan_points_suffix({ points: rewards.clanPoints }, { locale });

    if (used.raidAssaultBonus > 0) {
      const granted = await grantRaidAssaults(guildId, ownerId, used.raidAssaultBonus);
      if (granted > 0) feedback += m.rpg_reward_raid_assaults_suffix({ assaults: granted }, { locale });
    }
  } else {
    const toggled = await equipInventoryItem(guildId, ownerId, itemId);
    feedback = toggled.equipped
      ? m.rpg_item_equipped_desc({ item: toggled.itemName, type: toggled.type }, { locale })
      : m.rpg_item_unequipped_desc({ item: toggled.itemName }, { locale });
  }

  const view = await buildInventoryView(guildId, ownerId, locale);
  view.embeds[0].setFooter({ text: feedback });
  await respond(interaction, view);
}

// ─────────────────────────────────────────────────────────────
// Boutique
// ─────────────────────────────────────────────────────────────

/**
 * Discord refuse un message dont le texte affichable dépasse 4000 caractères, embed et
 * composants confondus (`COMPONENT_DISPLAYABLE_TEXT_SIZE_EXCEEDED`).
 *
 * La boutique n'en dépend plus : elle pagine. Reste le marché noir, qui liste
 * toutes ses offres dans un champ unique et remplit un sélecteur de 25 options
 * en regard - c'est lui que ce budget protège désormais.
 */
const SHOP_TEXT_BUDGET = 3600;

/** Marge gardée pour le pied de page ajouté après un achat. */
const SHOP_TEXT_RESERVE = 220;

/** Texte affichable déjà consommé par un embed (titre, description, champs, pied de page). */
function embedTextLength(embed: EmbedBuilder): number {
  const data = embed.data;
  return (data.title?.length ?? 0)
    + (data.description?.length ?? 0)
    + (data.footer?.text.length ?? 0)
    + (data.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0);
}

interface BudgetedOption {
  label: string;
  description?: string;
  value: string;
  emoji?: string;
}

/**
 * Remplit un sélecteur sans dépasser le budget de texte du message.
 *
 * Vingt-cinq options aux libellés et descriptions maximaux pèsent 5 000 caractères : le
 * sélecteur seul suffirait à faire refuser le message. On sacrifie donc d'abord les
 * descriptions - une option sans description reste sélectionnable - et seulement en
 * dernier recours des options entières.
 *
 * @returns Le texte consommé par les options retenues.
 */
function addOptionsWithinBudget(select: StringSelectMenuBuilder, entries: BudgetedOption[], budget: number): number {
  const cost = (entry: BudgetedOption, withDescription: boolean) =>
    entry.label.length + (withDescription ? entry.description?.length ?? 0 : 0);

  for (const withDescription of [true, false]) {
    const total = entries.reduce((sum, entry) => sum + cost(entry, withDescription), 0);
    if (total > budget) continue;
    for (const entry of entries) {
      select.addOptions({
        label: entry.label,
        description: withDescription ? entry.description : undefined,
        value: entry.value,
        emoji: entry.emoji,
      });
    }
    return total;
  }

  let used = 0;
  for (const entry of entries) {
    if (used + cost(entry, false) > budget) break;
    used += cost(entry, false);
    select.addOptions({ label: entry.label, value: entry.value, emoji: entry.emoji });
  }
  return used;
}

/**
 * Discord valide chaque option de menu et agrège ses refus en une seule erreur opaque
 * (« Received one or more errors ») qui ne nomme pas l'option fautive. Une description vide
 * ou un emoji qui n'en est pas un suffit : un objet créé au dashboard sans description, ou
 * dont le champ emoji contient du texte, rendait toute la boutique inaccessible.
 */
function optionDescription(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text ? truncate(text, 100) : undefined;
}

/** Emoji unicode, ou emoji personnalisé `<a?:nom:id>`. Tout le reste est écarté. */
function optionEmoji(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^<a?:\w{2,32}:\d{17,20}>$/.test(text)) return text;
  return /\p{Extended_Pictographic}/u.test(text) ? text : undefined;
}

/**
 * Objets par page.
 *
 * L'ancienne boutique déversait tout l'étal dans un seul embed, puis rognait
 * lignes et descriptions pour tenir sous la limite de 4 000 caractères de
 * Discord : passé la trentaine d'articles, une partie du catalogue devenait
 * simplement invisible. La pagination remplace ce rognage - chaque objet garde
 * sa place, et le budget de texte n'est plus jamais en cause.
 */
/**
 * Six, et non huit : chaque article porte désormais son propre bouton, donc
 * trois composants au lieu d'une ligne d'embed. Huit articles feraient dépasser
 * la limite de quarante composants par message une fois le filtre, la
 * pagination et le retour comptés.
 */
const SHOP_PAGE_SIZE = 6;

/** Quantités proposées à l'achat depuis la fiche d'un objet. */
const SHOP_BUY_QUANTITIES = [1, 5, 10] as const;

/** Catégories de l'étal, dans l'ordre où elles sont proposées. */
const SHOP_CATEGORIES = ['WEAPON', 'ARMOR', 'ACCESSORY', 'POTION', 'QUEST'] as const;
type ShopCategory = (typeof SHOP_CATEGORIES)[number];

function shopCategoryLabel(type: string, locale: Locale): string {
  switch (type) {
    case 'WEAPON': return m.rpg_shop_type_weapon({}, { locale });
    case 'ARMOR': return m.rpg_shop_type_armor({}, { locale });
    case 'ACCESSORY': return m.rpg_shop_type_accessory({}, { locale });
    case 'POTION': return m.rpg_shop_type_potion({}, { locale });
    case 'QUEST': return m.rpg_shop_type_quest({}, { locale });
    default: return type;
  }
}

/** Effets d'un objet, sur une ligne. Vide quand l'objet n'en a aucun. */
function shopItemStats(item: LocalRpgItem, locale: Locale): string {
  const parts: string[] = [];
  if (item.atkBonus) parts.push(m.rpg_shop_stat_atk({ v: item.atkBonus }, { locale }));
  if (item.defBonus) parts.push(m.rpg_shop_stat_def({ v: item.defBonus }, { locale }));
  if (item.spdBonus) parts.push(m.rpg_shop_stat_spd({ v: item.spdBonus }, { locale }));
  if (item.hpBonus) parts.push(m.rpg_shop_stat_maxhp({ v: item.hpBonus }, { locale }));
  if (item.hpRestore) parts.push(m.rpg_shop_stat_hp({ v: item.hpRestore }, { locale }));
  if (item.levelXpReward) parts.push(m.rpg_shop_stat_level_xp({ v: item.levelXpReward }, { locale }));
  if (item.clanPointsReward) parts.push(m.rpg_shop_stat_clan_points({ v: item.clanPointsReward }, { locale }));
  if (item.raidAssaultBonus) parts.push(m.rpg_shop_stat_raid_assaults({ v: item.raidAssaultBonus }, { locale }));
  // Les libellés traduits portent leurs propres séparateurs (« · … ») : on les
  // recolle bruts puis on retire celui de tête, sinon la ligne commence par un
  // point médian orphelin.
  return parts.join('').replace(/^[\s·]+/, '').trim();
}

type ShopState = {
  category: ShopCategory | 'ALL';
  page: number;
};

/**
 * Lit l'état de la boutique porté par un `customId`.
 *
 * Tout vient du client : une catégorie inconnue ou une page négative retombent
 * sur l'étal complet en première page plutôt que de produire une vue vide.
 */
function parseShopState(rest: string[]): ShopState {
  const rawCategory = rest[0];
  const category = (SHOP_CATEGORIES as readonly string[]).includes(rawCategory ?? '')
    ? (rawCategory as ShopCategory)
    : 'ALL';
  const page = Math.max(0, Number.parseInt(rest[1] ?? '0', 10) || 0);
  return { category, page };
}

function shopNavId(ownerId: string, state: ShopState): string {
  return `rpg:nav:${ownerId}:shop:${state.category}:${state.page}`;
}

type ShopCatalog = {
  items: LocalRpgItem[];
  /** Catégories réellement représentées, pour ne pas proposer un filtre vide. */
  categories: ShopCategory[];
};

async function loadShopCatalog(guildId: string): Promise<ShopCatalog> {
  const modules = await getShopModuleState(guildId);
  // Un objet qui verse de l'XP ou des points de clan disparaît de l'étal tant que son
  // module est éteint : l'acheter reviendrait à payer une récompense jamais versée.
  const items = (await prisma.rpgItem.findMany({
    where: { OR: [{ guildId: null }, { guildId }], purchasable: true },
    orderBy: [{ type: 'asc' }, { price: 'asc' }],
  })).filter((item) => isShopItemUnlocked(item, modules)) as unknown as LocalRpgItem[];

  const present = new Set(items.map((item) => item.type));
  return { items, categories: SHOP_CATEGORIES.filter((c) => present.has(c)) };
}

/** Corps d'une ligne d'étal : prix, effets, description, exemplaires possédés. */
function shopItemLines(
  item: LocalRpgItem,
  locale: Locale,
  currencyEmoji: string,
  ownedCount: number,
  affordable: boolean,
): string {
  const marker = affordable ? icon('success') : icon('lock');

  const lines = [
    `**${itemTypeIcon(item.type)} ${truncate(item.name, 80)}** ${rarityIcon(item.rarity)}`,
    `${marker} **${item.price}** ${currencyEmoji}${ownedCount ? m.rpg_shop_owned({ count: ownedCount }, { locale }) : ''}`,
  ];

  const stats = shopItemStats(item, locale);
  if (stats) lines.push(stats);
  if (item.description?.trim()) lines.push(`-# ${truncate(item.description.trim(), 120)}`);

  return lines.join('\n');
}

/**
 * Étal de la boutique : une page d'articles, un filtre par catégorie, et sur
 * chaque article son propre bouton.
 *
 * L'étal était un embed suivi d'un sélecteur : pour ouvrir la fiche d'un objet,
 * il fallait lire la liste, retrouver le nom dans le menu déroulant, puis le
 * choisir. Le bouton posé à côté de l'article supprime cet aller-retour - on
 * clique ce qu'on regarde - et c'est ce que les Components V2 permettent qu'un
 * embed ne permettait pas.
 */
async function buildShopView(
  guildId: string,
  ownerId: string,
  locale: Locale,
  requested: ShopState = { category: 'ALL', page: 0 },
): Promise<PanelView> {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.shopEnabled) {
    const embed = errorEmbed(m.rpg_shop_disabled_title({}, { locale }), m.rpg_shop_disabled_desc({}, { locale }));
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  const [profile, catalog] = await Promise.all([
    getOrCreateRpgProfile(guildId, ownerId),
    loadShopCatalog(guildId),
  ]);

  if (catalog.items.length === 0) {
    const embed = new EmbedBuilder()
      .setTitle(m.rpg_shop_title({}, { locale }))
      .setDescription(m.rpg_shop_empty({}, { locale }))
      .setColor(RPG_COLORS.trade);
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  // Un filtre dont la catégorie a disparu de l'étal retombe sur l'étal complet :
  // mieux vaut montrer autre chose qu'une page vide.
  const category = requested.category !== 'ALL' && catalog.categories.includes(requested.category)
    ? requested.category
    : 'ALL';
  const filtered = category === 'ALL'
    ? catalog.items
    : catalog.items.filter((item) => item.type === category);

  const pageCount = Math.max(1, Math.ceil(filtered.length / SHOP_PAGE_SIZE));
  const page = Math.min(requested.page, pageCount - 1);
  const pageItems = filtered.slice(page * SHOP_PAGE_SIZE, (page + 1) * SHOP_PAGE_SIZE);

  const owned = await prisma.rpgInventoryItem.findMany({
    where: { rpgProfileId: profile.id, itemId: { in: pageItems.map((item) => item.id) } },
    select: { itemId: true, quantity: true },
  });
  const ownedByItem = new Map(owned.map((entry) => [entry.itemId, entry.quantity]));

  const categoryLabel = category === 'ALL'
    ? m.rpg_shop_cat_all({}, { locale })
    : shopCategoryLabel(category, locale);

  const container = new ContainerBuilder().setAccentColor(RPG_COLORS.trade);
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
    `### ${icon('rpgShop')} ${m.rpg_shop_title({}, { locale })}\n`
    + m.rpg_shop_header({
      balance: profile.balance,
      emoji: config.currencyEmoji,
      category: categoryLabel,
      page: page + 1,
      pages: pageCount,
    }, { locale }),
  ));
  container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));

  if (pageItems.length === 0) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(m.rpg_shop_empty_in_category({}, { locale })));
  }

  for (const item of pageItems) {
    const affordable = profile.balance >= item.price;
    const ownedCount = ownedByItem.get(item.id) ?? 0;

    container.addSectionComponents(
      new SectionBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(shopItemLines(item, locale, config.currencyEmoji, ownedCount, affordable)),
        )
        // Un article qu'on ne peut pas s'offrir garde son bouton : la fiche dit
        // ce qu'il manque, et c'est précisément ce qu'on vient y chercher.
        .setButtonAccessory(
          new ButtonBuilder()
            .setCustomId(`rpg:shopopen:${ownerId}:${item.id}:${category}:${page}`)
            .setLabel(truncate(m.rpg_shop_item_open({}, { locale }), 80))
            .setEmoji(icon('rpgShop'))
            .setStyle(affordable ? ButtonStyle.Success : ButtonStyle.Secondary),
        ),
    );
  }

  const components: PanelRow[] = [];

  // Le filtre n'apparaît qu'à partir de deux catégories : en dessous il ne
  // filtre rien et ne fait que voler une ligne à l'étal.
  if (catalog.categories.length > 1) {
    const categorySelect = new StringSelectMenuBuilder()
      .setCustomId(`rpg:shopcat:${ownerId}`)
      .setPlaceholder(m.rpg_shop_cat_placeholder({}, { locale }))
      .addOptions([
        {
          label: truncate(m.rpg_shop_cat_all({}, { locale }), 100),
          value: 'ALL',
          emoji: optionEmoji(icon('rpgBag')),
          default: category === 'ALL',
        },
        ...catalog.categories.map((type) => ({
          label: truncate(shopCategoryLabel(type, locale), 100),
          value: type,
          emoji: optionEmoji(itemTypeIcon(type)),
          default: category === type,
        })),
      ]);
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(categorySelect));
  }

  if (pageCount > 1) {
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(shopNavId(ownerId, { category, page: Math.max(0, page - 1) }))
        .setLabel(m.rpg_shop_prev({}, { locale }))
        .setEmoji(icon('rpgPrev'))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0),
      new ButtonBuilder()
        .setCustomId(shopNavId(ownerId, { category, page: page + 1 }))
        .setLabel(m.rpg_shop_next({}, { locale }))
        .setEmoji(icon('rpgNext'))
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= pageCount - 1),
    ));
  }

  components.push(backRow(ownerId, locale));
  return { embeds: [], components, container };
}

/**
 * Fiche d'un objet : ce qu'il fait, ce qu'il coûte, ce qu'il en reste après achat.
 *
 * L'achat se faisait auparavant d'un simple clic dans un sélecteur, sans que le
 * joueur ait jamais vu les effets de l'objet ni le solde qui lui resterait.
 */
async function buildShopItemView(
  guildId: string,
  ownerId: string,
  itemId: string,
  locale: Locale,
  state: ShopState,
): Promise<PanelView> {
  const config = await getOrCreateEconomyConfig(guildId);
  const [profile, catalog] = await Promise.all([
    getOrCreateRpgProfile(guildId, ownerId),
    loadShopCatalog(guildId),
  ]);

  const item = catalog.items.find((entry) => entry.id === itemId);
  if (!item) {
    // L'objet a pu être retiré de l'étal entre l'affichage et le clic.
    return buildShopView(guildId, ownerId, locale, state);
  }

  const ownedEntry = await prisma.rpgInventoryItem.findFirst({
    where: { rpgProfileId: profile.id, itemId: item.id },
    select: { quantity: true },
  });

  const maxAffordable = item.price > 0 ? Math.floor(profile.balance / item.price) : MAX_SHOP_BUY_QUANTITY;
  const stats = shopItemStats(item, locale);

  const embed = new EmbedBuilder()
    .setTitle(truncate(`${itemTypeIcon(item.type)} ${item.name} ${rarityIcon(item.rarity)}`, 256))
    .setColor(RPG_COLORS.trade)
    .addFields([
      { name: m.rpg_shop_detail_price({}, { locale }), value: `**${item.price}** ${config.currencyEmoji}`, inline: true },
      { name: m.rpg_shop_detail_balance({}, { locale }), value: `**${profile.balance}** ${config.currencyEmoji}`, inline: true },
      { name: shopCategoryLabel(item.type, locale), value: rarityIcon(item.rarity) || '-', inline: true },
      { name: m.rpg_shop_detail_stats({}, { locale }), value: stats || m.rpg_shop_detail_no_stats({}, { locale }) },
    ]);

  if (item.description?.trim()) {
    embed.setDescription(truncate(item.description.trim(), 2000));
  }

  const notes: string[] = [];
  if (ownedEntry?.quantity) {
    notes.push(m.rpg_shop_owned({ count: ownedEntry.quantity }, { locale }).replace(/^[\s·]+/, ''));
  }
  notes.push(maxAffordable > 0
    ? m.rpg_shop_detail_max_qty({ count: Math.min(maxAffordable, MAX_SHOP_BUY_QUANTITY) }, { locale })
    : m.rpg_shop_detail_cannot_afford({ missing: item.price - profile.balance, emoji: config.currencyEmoji }, { locale }));
  embed.addFields({ name: '​', value: notes.join('\n') });

  const buyRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...SHOP_BUY_QUANTITIES.map((qty) => new ButtonBuilder()
      .setCustomId(`rpg:shopbuy:${ownerId}:${item.id}:${qty}:${state.category}:${state.page}`)
      .setLabel(m.rpg_shop_buy_qty({ qty }, { locale }))
      .setEmoji(icon('rpgShop'))
      .setStyle(qty === 1 ? ButtonStyle.Success : ButtonStyle.Secondary)
      .setDisabled(maxAffordable < qty)),
  );

  // « Tout » n'apparaît que s'il achète autre chose que ce que proposent déjà les
  // paliers : sinon c'est un doublon du bouton d'à côté.
  const maxQuantity = Math.min(maxAffordable, MAX_SHOP_BUY_QUANTITY);
  if (maxQuantity > 1 && !(SHOP_BUY_QUANTITIES as readonly number[]).includes(maxQuantity)) {
    buyRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`rpg:shopbuy:${ownerId}:${item.id}:${maxQuantity}:${state.category}:${state.page}`)
        .setLabel(m.rpg_shop_buy_max({ qty: maxQuantity }, { locale }))
        .setEmoji(icon('coins'))
        .setStyle(ButtonStyle.Primary),
    );
  }

  const backButton = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(shopNavId(ownerId, state))
      .setLabel(m.rpg_shop_back_to_shop({}, { locale }))
      .setEmoji(icon('rpgPrev'))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:hub`)
      .setLabel(m.rpg_hub_btn_back({}, { locale }))
      .setEmoji(icon('rpgBack'))
      .setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [buyRow, backButton] };
}

/**
 * Ouverture de la fiche d'un article depuis son bouton sur l'étal.
 *
 * `rest` = `[itemId, categorie, page]` : l'état de l'étal voyage avec le clic
 * pour que le retour retombe sur la page exacte qu'on regardait.
 */
async function handleShopItemOpen(
  interaction: ButtonInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  rest: string[],
): Promise<void> {
  const [itemId, ...stateParts] = rest;
  const view = await buildShopItemView(guildId, ownerId, itemId, locale, parseShopState(stateParts));
  await respond(interaction, view);
}

/**
 * Même chose depuis le sélecteur de l'étal.
 *
 * L'étal n'en propose plus, mais les messages déjà envoyés en portent un : sans
 * cette route, leur menu ne répondrait plus.
 */
async function handleShopItemSelect(
  interaction: StringSelectMenuInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  rest: string[],
): Promise<void> {
  const state = parseShopState(rest);
  const view = await buildShopItemView(guildId, ownerId, interaction.values[0], locale, state);
  await respond(interaction, view);
}

/** Changement de filtre : on repart en première page, l'ancienne n'a plus de sens. */
async function handleShopCategorySelect(
  interaction: StringSelectMenuInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
): Promise<void> {
  const view = await buildShopView(guildId, ownerId, locale, parseShopState([interaction.values[0], '0']));
  await respond(interaction, view);
}

/**
 * Achat depuis la fiche d'un objet. Le joueur revient sur la fiche, pas sur
 * l'étal : il peut vouloir en reprendre, et son nouveau solde y est déjà à jour.
 */
async function handleShopBuy(
  interaction: ButtonInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  rest: string[],
): Promise<void> {
  const [itemId, rawQty, ...stateParts] = rest;
  const quantity = Number.parseInt(rawQty ?? '1', 10) || 1;
  const state = parseShopState(stateParts);

  const purchase = await buyShopItem(guildId, ownerId, itemId, quantity);
  await trackQuest(interaction.client, guildId, ownerId, 'SHOP_PURCHASES', purchase.quantity);
  await trackQuest(interaction.client, guildId, ownerId, 'COINS_SPENT', purchase.price);

  const view = await buildShopItemView(guildId, ownerId, itemId, locale, state);
  view.embeds[0].setFooter({
    text: m.rpg_shop_bought_bulk({
      item: purchase.itemName,
      qty: purchase.quantity,
      price: purchase.price,
      balance: purchase.newBalance,
    }, { locale }).replace(/\*\*/g, ''),
  });
  await respond(interaction, view);
}

// ─────────────────────────────────────────────────────────────
// Marché noir
// ─────────────────────────────────────────────────────────────

function blackMarketOfferLine(offer: BlackMarketOfferView, locale: Locale): string {
  return m.rpg_blackmarket_offer_line({
    emoji: offer.emoji,
    name: offer.name,
    rarity: rarityIcon(offer.rarity),
    base: offer.basePrice,
    price: offer.price,
    discount: offer.discount,
    left: offer.stock - offer.purchased,
    stock: offer.stock,
  }, { locale });
}

async function buildBlackMarketView(guildId: string, ownerId: string, locale: Locale): Promise<PanelView> {
  const config = await getOrCreateEconomyConfig(guildId);
  const state = await getBlackMarketState(guildId, config);

  if (!state.enabled) {
    const embed = errorEmbed(
      m.rpg_blackmarket_disabled_title({}, { locale }),
      m.rpg_blackmarket_disabled_desc({}, { locale }),
    );
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  // Fermé : on confirme qu'une ouverture est planifiée, sans jamais donner la date -
  // sinon le marché noir devient un rendez-vous, pas une surprise.
  if (!state.session) {
    const embed = new EmbedBuilder()
      .setTitle(m.rpg_blackmarket_closed_title({}, { locale }))
      .setDescription(
        state.nextOpensAt
          ? `${m.rpg_blackmarket_closed_desc({}, { locale })}\n${m.rpg_blackmarket_closed_scheduled({}, { locale })}`
          : m.rpg_blackmarket_closed_desc({}, { locale }),
      )
      .setColor(COLORS.dark);
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  const profile = await getOrCreateRpgProfile(guildId, ownerId);
  const offers = await getMemberBlackMarketOffers(guildId, ownerId, state.session, config);

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_blackmarket_title({}, { locale }))
    .setDescription(m.rpg_blackmarket_desc({
      closes: `<t:${Math.floor(state.session.closesAt.getTime() / 1000)}:R>`,
      balance: profile.balance,
      emoji: config.currencyEmoji,
    }, { locale }))
    .setColor(COLORS.dark);

  if (offers.length === 0) {
    embed.addFields({
      name: m.rpg_blackmarket_field_offers({}, { locale }),
      value: m.rpg_blackmarket_empty_desc({}, { locale }),
    });
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  embed.addFields({
    name: m.rpg_blackmarket_field_offers({}, { locale }),
    value: offers.map((offer) => blackMarketOfferLine(offer, locale)).join('\n\n').slice(0, 1024),
  });

  const available = offers.filter((offer) => offer.purchased < offer.stock);
  if (available.length === 0) return { embeds: [embed], components: [backRow(ownerId, locale)] };

  const placeholder = m.rpg_blackmarket_select_placeholder({}, { locale });
  const select = new StringSelectMenuBuilder()
    .setCustomId(`rpg:bmbuy:${ownerId}`)
    .setPlaceholder(placeholder);

  const fixedText = placeholder.length + m.rpg_hub_btn_back({}, { locale }).length + embedTextLength(embed);
  addOptionsWithinBudget(
    select,
    available.slice(0, 25).map((offer) => ({
      label: truncate(`${offer.name} · ${offer.price} 🪙`, 100),
      description: truncate(m.rpg_blackmarket_option_desc({
        price: offer.price,
        discount: offer.discount,
        left: offer.stock - offer.purchased,
      }, { locale }), 100),
      value: offer.id,
      emoji: optionEmoji(offer.emoji),
    })),
    SHOP_TEXT_BUDGET - SHOP_TEXT_RESERVE - fixedText,
  );

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  return { embeds: [embed], components: [selectRow, backRow(ownerId, locale)] };
}

async function handleBlackMarketBuy(interaction: StringSelectMenuInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const purchase = await buyBlackMarketOffer(guildId, ownerId, interaction.values[0]);
  await trackQuest(interaction.client, guildId, ownerId, 'BLACK_MARKET_PURCHASES');
  await trackQuest(interaction.client, guildId, ownerId, 'COINS_SPENT', purchase.price);

  const view = await buildBlackMarketView(guildId, ownerId, locale);
  view.embeds[0].setFooter({
    text: m.rpg_blackmarket_buy_success({
      emoji: purchase.itemEmoji,
      item: purchase.itemName,
      price: purchase.price,
      discount: purchase.discount,
      balance: purchase.newBalance,
    }, { locale }),
  });
  await respond(interaction, view);
}

// ─────────────────────────────────────────────────────────────
// Raid
// ─────────────────────────────────────────────────────────────

type RaidPanelState = Awaited<ReturnType<typeof getRaidPanelState>>;
type RaidViewer = NonNullable<RaidPanelState['viewer']>;

/** Membre Discord du propriétaire du panneau, pour ce qui se lit sur ses rôles. */
async function panelMember(interaction: PanelInteraction, ownerId: string): Promise<GuildMember | null> {
  const guild = interaction.guild;
  if (!guild) return null;
  return guild.members.fetch(ownerId).catch(() => null);
}

/** Où en est le joueur dans le raid : la seule chose que l'annonce publique ne dit pas. */
function raidViewerLine(viewer: RaidViewer, locale: Locale): string {
  if (!viewer.teamName) {
    return viewer.mode === 'CLAN'
      ? m.rpg_raid_panel_no_clan({}, { locale })
      : m.rpg_raid_panel_no_guild({}, { locale });
  }

  if (viewer.engaged && viewer.engaged.remainingHealth <= 0) {
    return m.rpg_raid_panel_defeated({ team: viewer.teamName }, { locale });
  }
  if (viewer.assaultsLeft === 0) {
    return m.rpg_raid_panel_spent({ team: viewer.teamName }, { locale });
  }
  if (!viewer.engaged) {
    return m.rpg_raid_panel_untouched({ team: viewer.teamName, left: viewer.assaultsLeft }, { locale });
  }

  return m.rpg_raid_panel_engaged({
    team: viewer.teamName,
    bar: healthBar(viewer.engaged.remainingHealth, viewer.engaged.totalHealth),
    remaining: viewer.engaged.remainingHealth.toLocaleString('fr-FR'),
    total: viewer.engaged.totalHealth.toLocaleString('fr-FR'),
    left: viewer.assaultsLeft,
  }, { locale });
}

function raidActionRow(ownerId: string, locale: Locale, canAttack: boolean, backTo: 'hub' | 'raid'): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (canAttack) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`rpg:raidattack:${ownerId}`)
        .setLabel(m.rpg_raid_button_attack({}, { locale }))
        .setEmoji(icon('rpgFight'))
        .setStyle(ButtonStyle.Danger),
    );
  }
  return row.addComponents(
    new ButtonBuilder().setCustomId(`rpg:nav:${ownerId}:${backTo}`).setLabel(m.rpg_hub_btn_back({}, { locale })).setEmoji(icon('rpgBack')).setStyle(ButtonStyle.Secondary),
  );
}

async function buildRaidView(guildId: string, ownerId: string, member: GuildMember | null, locale: Locale): Promise<PanelView> {
  const { enabled, raid, viewer, teams, nextOpensAt } = await getRaidPanelState(guildId, ownerId, member);

  if (!enabled) {
    const embed = errorEmbed(m.rpg_raid_panel_title({}, { locale }), m.rpg_raid_panel_disabled({}, { locale }));
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  if (!raid || !viewer) {
    const embed = new EmbedBuilder()
      .setTitle(m.rpg_raid_panel_title({}, { locale }))
      .setDescription(nextOpensAt
        ? m.rpg_raid_panel_next({ when: `<t:${Math.floor(nextOpensAt.getTime() / 1000)}:R>` }, { locale })
        : m.rpg_raid_panel_none({}, { locale }))
      .setColor(RPG_COLORS.combat);
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  // L'embed public est repris tel quel : la barre d'une équipe doit dire la même chose ici
  // et dans le salon, et deux constructions divergeraient au premier changement.
  const embed = buildRaidEmbed(raid, teams, locale);
  embed.addFields({ name: m.rpg_raid_panel_field_you({}, { locale }), value: raidViewerLine(viewer, locale) });

  return { embeds: [embed], components: [raidActionRow(ownerId, locale, viewer.canAttack, 'hub')] };
}

/**
 * Livre un assaut depuis le panneau.
 *
 * L'écran est remplacé par le compte rendu, comme après un combat de boss, avec de quoi
 * frapper à nouveau sans repasser par le hub.
 */
async function handleRaidAttack(interaction: ButtonInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const member = await panelMember(interaction, ownerId);
  await interaction.deferUpdate();

  try {
    const outcome = await attackRaid(interaction.client, guildId, ownerId, member);
    const canAttackAgain = outcome.assaultsLeft > 0 && outcome.team.remainingHealth > 0;
    await interaction.editReply({
      embeds: [await buildAssaultEmbed(guildId, outcome)],
      components: [raidActionRow(ownerId, locale, canAttackAgain, 'raid')],
    });
  } catch (error) {
    // Un refus attendu - plus d'assaut, pas d'énergie, pas d'équipe - se dit au joueur et
    // le laisse sur l'écran ; le reste part au journal, dont il n'a que faire.
    if (!(error instanceof RaidError)) {
      logger.error('RpgPanel', `Assaut de raid en échec sur ${guildId}:`, error);
    }
    const reason = error instanceof RaidError ? error.message : m.rpg_raid_panel_attack_failed({}, { locale });
    await interaction.editReply({
      embeds: [errorEmbed(m.rpg_raid_panel_attack_error({}, { locale }), reason)],
      components: [raidActionRow(ownerId, locale, false, 'raid')],
    }).catch(() => null);
  }
}

// ─────────────────────────────────────────────────────────────
// Guilde
// ─────────────────────────────────────────────────────────────

/** Bouton d'accès au front, commun à tous les états de l'écran de guilde. */
function warButton(ownerId: string, locale: Locale): ButtonBuilder {
  return new ButtonBuilder()
    .setCustomId(`rpg:nav:${ownerId}:clanwar`)
    .setLabel(m.rpg_war_btn_open({}, { locale }))
    .setEmoji(icon('rpgWar'))
    .setStyle(ButtonStyle.Primary);
}

async function buildGuildView(
  guildId: string,
  ownerId: string,
  locale: Locale,
  member: GuildMember | null = null,
): Promise<PanelView> {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.guildsEnabled) {
    const embed = errorEmbed(m.rpg_guild_disabled_title({}, { locale }), m.rpg_guild_disabled_desc({}, { locale }));
    // Le front reste accessible : en mode clan, il ne dépend pas des guildes RPG.
    return {
      embeds: [embed],
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
        warButton(ownerId, locale),
        new ButtonBuilder().setCustomId(`rpg:nav:${ownerId}:hub`).setLabel(m.rpg_hub_btn_back({}, { locale })).setEmoji(icon('rpgBack')).setStyle(ButtonStyle.Secondary),
      )],
    };
  }

  const profile = await getOrCreateRpgProfile(guildId, ownerId);
  // L'appartenance d'équipe se lit à part : en mode clan elle vient des rôles
  // Discord, et une guilde RPG n'en sait rien.
  const warTeam = await getViewerWarTeam(guildId, ownerId, member);

  if (!profile.rpgGuildId) {
    const embed = new EmbedBuilder()
      .setTitle(m.rpg_guild_no_guild_title({}, { locale }))
      .setDescription(m.rpg_guild_no_guild_desc({}, { locale }))
      .setColor(RPG_COLORS.team)
      .addFields({
        name: m.rpg_guild_field_war({}, { locale }),
        value: warTeam.name
          ? m.rpg_guild_war_team({ team: warTeam.name }, { locale })
          : m.rpg_guild_war_none({}, { locale }),
      });

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`rpg:guildcreateopen:${ownerId}`).setLabel(m.rpg_hub_guild_btn_create({}, { locale })).setEmoji(icon('rpgGuild')).setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`rpg:guildjoinopen:${ownerId}`).setLabel(m.rpg_hub_guild_btn_join({}, { locale })).setEmoji(icon('rpgClan')).setStyle(ButtonStyle.Primary),
      warButton(ownerId, locale),
      new ButtonBuilder().setCustomId(`rpg:nav:${ownerId}:hub`).setLabel(m.rpg_hub_btn_back({}, { locale })).setEmoji(icon('rpgBack')).setStyle(ButtonStyle.Secondary),
    );

    return { embeds: [embed], components: [row] };
  }

  const rpgGuild = await prisma.rpgGuild.findUnique({ where: { id: profile.rpgGuildId }, include: { members: true } });
  if (!rpgGuild) {
    // Référence orpheline (guilde supprimée entre-temps) : on nettoie le profil puis on
    // ré-affiche l'écran « sans guilde ». L'ancien code se rappelait lui-même sans rien
    // corriger, ce qui bouclait à l'infini jusqu'au dépassement de pile.
    await prisma.rpgProfile.update({ where: { id: profile.id }, data: { rpgGuildId: null } });
    return buildGuildView(guildId, ownerId, locale, member);
  }

  const xpNeeded = rpgGuildXpNeeded(rpgGuild.level);
  // Le plafond de membres suit le niveau de la guilde : une grande guilde dépassait la
  // limite d'un champ d'embed, et Discord refusait l'écran entier, pas seulement la liste.
  const membersList = joinFieldEntries(
    rpgGuild.members.map((mb) => `<@${mb.userId}> (Niveau ${mb.level})`),
    { separator: ', ', more: (count) => m.rpg_guild_members_more({ count }, { locale }) },
  );

  // Place de l'équipe du joueur sur le front, résumée en une ligne : la fiche de
  // guilde était le seul écran où l'on parlait de collectif, et elle ignorait
  // complètement ce que le jeu rapportait au clan.
  const war = await getClanWarState({ guildId, userId: ownerId, member });
  const warValue = war.closure
    ? m.rpg_guild_war_off({}, { locale })
    : !warTeam.name
      ? m.rpg_guild_war_none({}, { locale })
      // En mode guilde RPG, l'équipe est la guilde qu'on regarde déjà : redire
      // son score n'apprend rien, seul son rang en dit quelque chose.
      : war.mode === 'RPG_GUILD'
        ? m.rpg_guild_war_rank({ team: warTeam.name, rank: war.viewer.rank ?? 0 }, { locale })
        : m.rpg_guild_war_standing({
          team: warTeam.name,
          rank: war.viewer.rank ?? 0,
          points: war.viewer.points,
        }, { locale });

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_guild_title({ emoji: rpgGuild.emoji, name: rpgGuild.name }, { locale }))
    .setDescription(rpgGuild.description || m.rpg_guild_no_description({}, { locale }))
    .setColor(RPG_COLORS.team)
    .addFields(
      { name: `${icon('star')} ${m.rpg_guild_field_level({}, { locale })}`, value: m.rpg_profile_level_value({ level: rpgGuild.level }, { locale }), inline: true },
      { name: `${icon('coins')} ${m.rpg_guild_field_treasury({}, { locale })}`, value: m.rpg_guild_treasury_value({ amount: rpgGuild.treasury }, { locale }), inline: true },
      { name: `${icon('rpgXp')} ${m.rpg_guild_field_xp({}, { locale })}`, value: `${rpgGuild.xp} / ${xpNeeded} XP\n${gaugeBar(rpgGuild.xp, xpNeeded, 'xp')}`, inline: false },
      { name: `${icon('rpgWar')} ${m.rpg_guild_field_war({}, { locale })}`, value: warValue, inline: false },
      { name: `${icon('rpgClan')} ${m.rpg_guild_field_members({}, { locale })}`, value: membersList || m.rpg_guild_no_members({}, { locale }) },
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rpg:guilddepositopen:${ownerId}`).setLabel(m.rpg_hub_guild_btn_deposit({}, { locale })).setEmoji(icon('coins')).setStyle(ButtonStyle.Success),
    warButton(ownerId, locale),
    new ButtonBuilder().setCustomId(`rpg:guildleaveask:${ownerId}`).setLabel(m.rpg_hub_guild_btn_leave({}, { locale })).setEmoji(icon('rpgTravel')).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`rpg:nav:${ownerId}:hub`).setLabel(m.rpg_hub_btn_back({}, { locale })).setEmoji(icon('rpgBack')).setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

// ─────────────────────────────────────────────────────────────
// Guerre de clans
// ─────────────────────────────────────────────────────────────

/** Une ligne du tableau de guerre. Le podium porte sa médaille. */
function warStandingLine(
  team: ClanWarState['standings'][number],
  rank: number,
  isViewerTeam: boolean,
  mode: ClanWarState['mode'],
  locale: Locale,
): string {
  const medal = rank === 1 ? icon('rank1') : rank === 2 ? icon('rank2') : rank === 3 ? icon('rank3') : `**#${rank}**`;
  const name = isViewerTeam ? `__${truncate(team.name, 60)}__` : truncate(team.name, 60);
  const score = mode === 'RPG_GUILD'
    ? m.rpg_war_line_guild({ level: team.level ?? 1, members: team.members }, { locale })
    : m.rpg_war_line_clan({ points: team.points, members: team.members }, { locale });

  return `${medal} ${name} - ${score}`;
}

/**
 * Tableau de guerre : ce que le RPG rapporte à chaque équipe du serveur.
 *
 * Les monstres, les boss, les quêtes et le raid versaient déjà des points aux
 * clans, mais le jeu ne les montrait nulle part : on jouait pour un classement
 * qu'on ne pouvait consulter qu'ailleurs. L'écran rend cet effort visible depuis
 * le hub, et donne à la guilde RPG la contrepartie collective qui lui manquait.
 */
async function buildClanWarView(
  guildId: string,
  ownerId: string,
  member: GuildMember | null,
  locale: Locale,
  scope: ClanWarScope = 'season',
): Promise<PanelView> {
  const war = await getClanWarState({ guildId, userId: ownerId, member, scope });

  if (war.closure) {
    const reason = war.closure === 'CLANS_OFF'
      ? m.rpg_war_closed_clans({}, { locale })
      : war.closure === 'BRIDGE_OFF'
        ? m.rpg_war_closed_bridge({}, { locale })
        : m.rpg_war_closed_guilds({}, { locale });
    return {
      embeds: [errorEmbed(m.rpg_war_title({}, { locale }), reason)],
      components: [backRow(ownerId, locale)],
    };
  }

  const embed = new EmbedBuilder()
    .setTitle(`${icon('rpgWar')} ${m.rpg_war_title({}, { locale })}`)
    .setColor(RPG_COLORS.team)
    .setDescription(war.mode === 'RPG_GUILD'
      ? m.rpg_war_desc_guild({}, { locale })
      : m.rpg_war_desc_clan({ season: war.season, scope: scope === 'week' ? m.rpg_war_scope_week({}, { locale }) : m.rpg_war_scope_season({}, { locale }) }, { locale }));

  const standings = war.standings.map((team, index) =>
    warStandingLine(team, index + 1, team.key === war.viewer.teamKey, war.mode, locale));

  embed.addFields({
    name: m.rpg_war_field_standings({}, { locale }),
    value: standings.length > 0 ? standings.join('\n') : m.rpg_war_empty({}, { locale }),
  });

  if (war.viewer.teamKey) {
    // L'écart avec la tête est la seule information qui dise s'il reste quelque
    // chose à jouer : un rang seul ne dit pas si le retard est d'une soirée ou
    // d'une saison.
    const leader = war.standings[0];
    const own = war.standings.find((team) => team.key === war.viewer.teamKey);
    const gap = leader && own && leader.key !== own.key ? leader.points - own.points : 0;

    embed.addFields({
      name: m.rpg_war_field_you({}, { locale }),
      value: [
        // En mode guilde, `points` porte le niveau du joueur et non des points
        // marqués : la même phrase y serait un contresens.
        war.mode === 'RPG_GUILD'
          ? m.rpg_war_you_line_guild({
            team: truncate(war.viewer.teamName ?? '', 60),
            rank: war.viewer.rank ?? 0,
            level: war.viewer.points,
          }, { locale })
          : m.rpg_war_you_line({
            team: truncate(war.viewer.teamName ?? '', 60),
            rank: war.viewer.rank ?? 0,
            points: war.viewer.points,
          }, { locale }),
        war.mode === 'RPG_GUILD'
          ? ''
          : gap > 0
            ? m.rpg_war_gap({ points: gap }, { locale })
            : m.rpg_war_leading({}, { locale }),
      ].filter(Boolean).join('\n'),
      inline: false,
    });

    if (war.topContributors.length > 0) {
      embed.addFields({
        name: m.rpg_war_field_top({}, { locale }),
        value: war.topContributors
          .map((entry, index) => m.rpg_war_top_line({ rank: index + 1, id: entry.userId, points: entry.points }, { locale }))
          .join('\n'),
        inline: false,
      });
    }
  } else {
    embed.addFields({ name: m.rpg_war_field_you({}, { locale }), value: m.rpg_war_no_team({}, { locale }) });
  }

  const components: PanelRow[] = [];

  // La portée ne se règle qu'en mode clan : une guilde RPG n'a pas d'historique
  // daté à découper en semaines, et le menu ne changerait rien à l'écran.
  if (war.mode === 'CLAN') {
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`rpg:warscope:${ownerId}`)
        .setPlaceholder(m.rpg_war_scope_placeholder({}, { locale }))
        .addOptions([
          {
            label: truncate(m.rpg_war_scope_season({}, { locale }), 100),
            value: 'season',
            emoji: optionEmoji(icon('trophy')),
            default: scope === 'season',
          },
          {
            label: truncate(m.rpg_war_scope_week({}, { locale }), 100),
            value: 'week',
            emoji: optionEmoji(icon('calendar')),
            default: scope === 'week',
          },
        ]),
    ));
  }

  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:clanwar:${scope}`)
      .setLabel(m.rpg_war_btn_refresh({}, { locale }))
      .setEmoji(icon('rpgRefresh'))
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:guild`)
      .setLabel(m.rpg_hub_btn_guild({}, { locale }))
      .setEmoji(icon('rpgGuild'))
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`rpg:nav:${ownerId}:hub`)
      .setLabel(m.rpg_hub_btn_back({}, { locale }))
      .setEmoji(icon('rpgBack'))
      .setStyle(ButtonStyle.Secondary),
  ));

  return { embeds: [embed], components };
}

/** Changement de fenêtre observée depuis le menu du tableau de guerre. */
async function handleWarScopeSelect(
  interaction: StringSelectMenuInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
): Promise<void> {
  const member = await panelMember(interaction, ownerId);
  const view = await buildClanWarView(guildId, ownerId, member, locale, asClanWarScope(interaction.values[0]));
  await respond(interaction, view);
}

function buildGuildLeaveConfirmView(ownerId: string, locale: Locale): PanelView {
  const embed = new EmbedBuilder()
    .setTitle(m.rpg_hub_guild_leave_confirm_title({}, { locale }))
    .setDescription(m.rpg_hub_guild_leave_confirm_desc({}, { locale }))
    .setColor(COLORS.warning);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rpg:guildleaveyes:${ownerId}`).setLabel(m.rpg_hub_guild_leave_confirm_yes({}, { locale })).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`rpg:guildleaveno:${ownerId}`).setLabel(m.rpg_hub_guild_leave_confirm_no({}, { locale })).setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row] };
}

async function handleGuildLeaveConfirm(interaction: ButtonInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  await leaveRpgGuild(guildId, ownerId);
  const view = await buildGuildView(guildId, ownerId, locale, await panelMember(interaction, ownerId));
  await respond(interaction, view);
}

function buildGuildCreateModal(ownerId: string, locale: Locale): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(`rpg:guildcreatesubmit:${ownerId}`).setTitle(m.rpg_hub_guild_create_modal_title({}, { locale }));
  const nameInput = new TextInputBuilder().setCustomId('nom').setLabel(m.rpg_hub_guild_field_name({}, { locale })).setStyle(TextInputStyle.Short).setMaxLength(32).setRequired(true);
  const descInput = new TextInputBuilder().setCustomId('description').setLabel(m.rpg_hub_guild_field_desc({}, { locale })).setStyle(TextInputStyle.Paragraph).setMaxLength(256).setRequired(false);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(descInput),
  );
  return modal;
}

function buildGuildJoinModal(ownerId: string, locale: Locale): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(`rpg:guildjoinsubmit:${ownerId}`).setTitle(m.rpg_hub_guild_join_modal_title({}, { locale }));
  const nameInput = new TextInputBuilder().setCustomId('nom').setLabel(m.rpg_hub_guild_field_name({}, { locale })).setStyle(TextInputStyle.Short).setRequired(true);
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput));
  return modal;
}

function buildGuildDepositModal(ownerId: string, locale: Locale): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(`rpg:guilddepositsubmit:${ownerId}`).setTitle(m.rpg_hub_guild_deposit_modal_title({}, { locale }));
  const amountInput = new TextInputBuilder().setCustomId('montant').setLabel(m.rpg_hub_guild_field_amount({}, { locale })).setStyle(TextInputStyle.Short).setRequired(true);
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput));
  return modal;
}

async function handleGuildCreateSubmit(interaction: ModalSubmitInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const name = interaction.fields.getTextInputValue('nom');
  const description = interaction.fields.getTextInputValue('description') || undefined;
  await createRpgGuild(guildId, ownerId, name, description);
  const view = await buildGuildView(guildId, ownerId, locale, await panelMember(interaction, ownerId));
  await respond(interaction, view);
}

async function handleGuildJoinSubmit(interaction: ModalSubmitInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const name = interaction.fields.getTextInputValue('nom');
  const targetGuild = await findRpgGuildByName(guildId, name);
  if (!targetGuild) {
    await replyPanelError(interaction, new Error(m.rpg_guild_not_found_desc({}, { locale })), locale);
    return;
  }
  await joinRpgGuild(guildId, ownerId, targetGuild.id);
  const view = await buildGuildView(guildId, ownerId, locale, await panelMember(interaction, ownerId));
  await respond(interaction, view);
}

async function handleGuildDepositSubmit(interaction: ModalSubmitInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const amount = Number.parseInt(interaction.fields.getTextInputValue('montant'), 10);
  if (!Number.isFinite(amount) || amount <= 0) {
    await replyPanelError(interaction, new Error(m.rpg_hub_invalid_amount({}, { locale })), locale);
    return;
  }
  const deposit = await depositToRpgGuildTreasury(guildId, ownerId, amount);
  const view = await buildGuildView(guildId, ownerId, locale, await panelMember(interaction, ownerId));
  view.embeds[0].setFooter({
    text: deposit.levelUp
      ? m.rpg_guild_deposit_levelup_desc({ level: deposit.levelUp }, { locale })
      : m.rpg_guild_deposit_desc({ amount: deposit.amount }, { locale }),
  });
  await respond(interaction, view);
}

// ─────────────────────────────────────────────────────────────
// Voyage
// ─────────────────────────────────────────────────────────────

function getTravelDestinations(locale: Locale): { name: string; time: number; label: string }[] {
  return [
    { name: 'Forêt Mystique', time: 5, label: m.rpg_travel_dest_forest_label({}, { locale }) },
    { name: 'Montagnes du Destin', time: 15, label: m.rpg_travel_dest_mountains_label({}, { locale }) },
    { name: 'Marécage Maudit', time: 30, label: m.rpg_travel_dest_swamp_label({}, { locale }) },
  ];
}

async function buildTravelView(guildId: string, ownerId: string, locale: Locale): Promise<PanelView> {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.rpgEnabled) {
    const embed = errorEmbed(m.rpg_travel_disabled_title({}, { locale }), m.rpg_travel_disabled_desc({}, { locale }));
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  const profile = await getOrCreateRpgProfile(guildId, ownerId);

  if (profile.isTraveling) {
    const status = await resolveTravel(guildId, ownerId);

    if (!status.complete) {
      const embed = errorEmbed(m.rpg_travel_in_progress_title({}, { locale }), m.rpg_travel_in_progress_desc({ dest: profile.travelDestination ?? '', minutes: status.remainingMinutes ?? 0 }, { locale }));
      return { embeds: [embed], components: [backRow(ownerId, locale)] };
    }

    if (status.noEvent) {
      const embed = successEmbed(m.rpg_travel_done_title({}, { locale }), m.rpg_travel_done_desc({}, { locale }));
      return { embeds: [embed], components: [backRow(ownerId, locale)] };
    }

    const event = status.event!;
    const choices = (event.choices ?? []) as Array<{ text: string; minLevel?: number }>;

    const embed = new EmbedBuilder()
      .setTitle(m.rpg_travel_event_title({ emoji: event.emoji, title: event.title }, { locale }))
      .setDescription(event.description)
      .setColor(RPG_COLORS.wild)
      .setFooter({ text: m.rpg_travel_choose_action({}, { locale }) });

    const row = new ActionRowBuilder<ButtonBuilder>();
    choices.forEach((choice, idx) => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`rpg:choice:${ownerId}:${event.id}:${idx}`)
          .setLabel(choice.text.substring(0, 80))
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(Boolean(choice.minLevel && profile.level < choice.minLevel)),
      );
    });

    return { embeds: [embed], components: [row, backRow(ownerId, locale)] };
  }

  const destinations = getTravelDestinations(locale);
  const embed = new EmbedBuilder()
    .setTitle(m.rpg_travel_start_title({}, { locale }))
    .setDescription(m.rpg_travel_start_desc({}, { locale }))
    .setColor(RPG_COLORS.wild)
    .addFields({ name: m.rpg_travel_field_energy_now({}, { locale }), value: `${profile.energy} / ${config.maxEnergy}` });

  const row = new ActionRowBuilder<ButtonBuilder>();
  destinations.forEach((dest, idx) => {
    row.addComponents(
      new ButtonBuilder().setCustomId(`rpg:dest:${ownerId}:${idx}`).setLabel(dest.label).setStyle(ButtonStyle.Primary),
    );
  });

  return { embeds: [embed], components: [row, backRow(ownerId, locale)] };
}

async function handleTravelDestinationChoice(interaction: ButtonInteraction, guildId: string, ownerId: string, locale: Locale, idxRaw: string): Promise<void> {
  const idx = Number.parseInt(idxRaw, 10);
  const dest = getTravelDestinations(locale)[idx];
  if (!dest) return;

  await startTravel(guildId, ownerId, dest.name, dest.time);
  const embed = successEmbed(m.rpg_travel_bon_voyage_title({}, { locale }), m.rpg_travel_bon_voyage_desc({ dest: dest.name, time: dest.time }, { locale }));
  await respond(interaction, { embeds: [embed], components: [backRow(ownerId, locale)] });
}

async function handleTravelEventChoice(interaction: ButtonInteraction, guildId: string, ownerId: string, locale: Locale, eventId: string, idxRaw: string): Promise<void> {
  const idx = Number.parseInt(idxRaw, 10);
  const event = await prisma.rpgAdventureEvent.findUnique({ where: { id: eventId } });
  const resolution = await chooseAdventureOutcome(guildId, ownerId, eventId, idx);
  await trackQuest(interaction.client, guildId, ownerId, 'ADVENTURES_COMPLETED');

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_travel_resolution_title({ emoji: event?.emoji ?? '🌲', title: event?.title ?? '' }, { locale }))
    .setDescription(m.rpg_travel_resolution_desc({ choice: resolution.choiceText ?? '', critical: resolution.criticalMessage || '' }, { locale }))
    .addFields(
      { name: m.rpg_travel_field_hp_effect({}, { locale }), value: `${resolution.hpEffect >= 0 ? '+' : ''}${resolution.hpEffect} PV`, inline: true },
      { name: m.rpg_travel_field_coin_effect({}, { locale }), value: `${resolution.coinEffect >= 0 ? '+' : ''}${resolution.coinEffect} 🪙`, inline: true },
      { name: m.rpg_travel_field_xp({}, { locale }), value: `+${resolution.xpEffect} XP`, inline: true },
    )
    .setColor(resolution.hpEffect < 0 ? COLORS.danger : COLORS.success);

  if (resolution.levelUp) {
    embed.addFields({ name: m.rpg_travel_field_levelup({}, { locale }), value: m.rpg_travel_levelup_value({ level: Number(resolution.levelUp) }, { locale }) });
  }

  await respond(interaction, { embeds: [embed], components: [backRow(ownerId, locale)] });
}

// ─────────────────────────────────────────────────────────────
// Daily & Pêche (actions instantanées)
// ─────────────────────────────────────────────────────────────

async function handleDailyClaim(interaction: ButtonInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const config = await getOrCreateEconomyConfig(guildId);
  const result = await claimDaily(guildId, ownerId);

  if (!result.success) {
    await interaction.reply({
      embeds: [errorEmbed(m.rpg_daily_unavailable_title({}, { locale }), m.rpg_daily_unavailable_desc({ hours: result.remainingHours ?? 0, minutes: result.remainingMinutes ?? 0 }, { locale }))],
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  await trackQuest(interaction.client, guildId, ownerId, 'DAILY_CLAIMS');

  const embed = successEmbed(m.rpg_daily_title({}, { locale }), m.rpg_daily_desc({ reward: result.reward ?? 0, emoji: config.currencyEmoji, currency: config.currencyName }, { locale }))
    .addFields({ name: m.rpg_daily_new_balance({}, { locale }), value: `**${result.newBalance}** ${config.currencyEmoji}` });

  await respond(interaction, { embeds: [embed], components: [backRow(ownerId, locale)] });
}

async function handleFishClaim(interaction: ButtonInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const config = await getOrCreateEconomyConfig(guildId);
  const result = await fish(guildId, ownerId);

  if (!result.success) {
    const embed = result.cooldown
      ? errorEmbed(m.rpg_fish_cooldown_title({}, { locale }), m.rpg_fish_cooldown_desc({ min: result.remainingMin ?? 0, sec: result.remainingSec ?? 0 }, { locale }))
      : errorEmbed(m.rpg_fish_no_energy_title({}, { locale }), m.rpg_fish_no_energy_desc({}, { locale }));
    await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
    return;
  }

  await trackQuest(interaction.client, guildId, ownerId, 'FISH_CAUGHT');

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
              COLORS.primary,
    )
    .addFields(
      { name: m.rpg_fish_field_value({ emoji: config.currencyEmoji }, { locale }), value: m.rpg_fish_field_value_value({ value: result.fish.value, currency: config.currencyName }, { locale }), inline: true },
      { name: m.rpg_fish_field_xp({}, { locale }), value: `**+${result.fish.xp}**`, inline: true },
      { name: m.rpg_fish_field_total({}, { locale }), value: m.rpg_fish_field_total_value({ count: result.totalFishCaught }, { locale }), inline: true },
    );

  await respond(interaction, { embeds: [embed], components: [backRow(ownerId, locale)] });
}

// ─────────────────────────────────────────────────────────────
// Bestiaire
// ─────────────────────────────────────────────────────────────

async function buildBestiaryView(guildId: string, ownerId: string, viewer: User, locale: Locale): Promise<PanelView> {
  const discovered = await listDiscoveredMonsters(guildId, ownerId);

  if (discovered.length === 0) {
    const embed = errorEmbed(m.rpg_bestiary_empty_title({}, { locale }), m.rpg_bestiary_empty_desc({}, { locale }));
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  // Le total suit le bestiaire actif du serveur, mais les découvertes gardent les créatures
  // depuis retirées ou personnalisées : sans ce plancher, l'affichage donnerait « 12 / 10 ».
  const allMonsters = Math.max(discovered.length, (await listGuildMonsters(guildId)).length);
  const lines = discovered.map((mo) => {
    const bossTag = mo.isBoss ? m.rpg_bestiary_boss_tag({}, { locale }) : '';
    return `${mo.emoji} **${mo.name}**${bossTag} - Niv. ${mo.level} | ❤️ ${mo.health} | ⚔️ ${mo.attack} | 🛡️ ${mo.defense}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_bestiary_title({ name: viewer.displayName }, { locale }))
    .setDescription(m.rpg_bestiary_desc({ count: discovered.length, total: allMonsters, lines: lines.join('\n') }, { locale }))
    .setColor(RPG_COLORS.wild);

  return { embeds: [embed], components: [backRow(ownerId, locale)] };
}

// ─────────────────────────────────────────────────────────────
// Combat - Monstre aléatoire (boucle interactive)
// ─────────────────────────────────────────────────────────────

/**
 * Verse au clan du vainqueur la prime portée par la créature vaincue.
 *
 * Le pont RPG vers les clans est un interrupteur de serveur distinct de `clansEnabled` :
 * le couper ne doit pas obliger à remettre à zéro la prime de chaque monstre du bestiaire.
 * Les deux interrupteurs sont vérifiés ici, avant même de charger le module des clans : une
 * prime réglée sur un serveur dont les clans sont éteints reste dormante, sans rien tenter.
 * Un vainqueur sans clan ne reçoit rien, ce dont `awardClanPointsToMembers` se charge.
 */
/**
 * Compte une victoire, et le butin qu'elle a rendu, sur les quêtes RPG en cours.
 *
 * Posé ici et non dans le service de combat, qui ne reçoit pas le client : la résolution de
 * l'équipe d'un membre passe par ses rôles Discord, comme pour les points de clan juste
 * au-dessus. Volontairement silencieux, une quête ne doit jamais faire échouer un combat
 * déjà gagné.
 */
/**
 * Fait avancer les quêtes qui visent une action, sans jamais la faire échouer.
 *
 * L'import est différé comme ailleurs dans ce fichier : le service de quêtes tire le
 * résolveur d'équipe, dont une vente en boutique n'a que faire. `trackRpgQuest` avale ses
 * propres incidents, une quête non comptée ne devant pas défaire ce que le joueur a fait.
 */
async function trackQuest(client: Client, guildId: string, userId: string, objective: RpgQuestObjective, amount = 1): Promise<void> {
  try {
    const { trackRpgQuest } = await import('./rpg/rpgQuestService.js');
    await trackRpgQuest(client, guildId, userId, objective, amount);
  } catch {
    // Déjà journalisé par le service. L'achat, la fabrication ou le combat sont derrière
    // nous : rien de ce qui suit ne doit les faire échouer après coup.
  }
}

async function trackCombatQuests(
  client: Client,
  guildId: string,
  userId: string,
  isBoss: boolean,
  itemDropped: string | null,
): Promise<void> {
  await trackQuest(client, guildId, userId, isBoss ? 'BOSS_KILLS' : 'MONSTER_KILLS');
  if (itemDropped) await trackQuest(client, guildId, userId, 'ITEMS_LOOTED');
}

async function awardMonsterTeamPoints(
  guildId: string,
  userId: string,
  monster: { name: string; clanPoints: number; isBoss: boolean },
  client: Client,
): Promise<{ amount: number; toGuild: boolean }> {
  // Court-circuit avant toute requête : la grande majorité du bestiaire ne porte pas de prime.
  if (!(monster.clanPoints > 0)) return { amount: 0, toGuild: false };

  return awardRpgTeamPoints({
    client,
    guildId,
    userId,
    amount: monster.clanPoints,
    source: monster.isBoss ? 'RPG_BOSS' : 'RPG_MOB',
    reason: monster.name,
  });
}

async function startFightSession(interaction: ButtonInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.rpgEnabled) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_travel_disabled_title({}, { locale }), m.rpg_boss_disabled_desc({}, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  const profile = await getOrCreateRpgProfile(guildId, ownerId);

  if (profile.lastBattle) {
    const diff = Date.now() - profile.lastBattle.getTime();
    if (diff < FIGHT_COOLDOWN_MS) {
      const remaining = Math.ceil((FIGHT_COOLDOWN_MS - diff) / 1000);
      await interaction.reply({ embeds: [errorEmbed(m.rpg_fight_cooldown_title({}, { locale }), m.rpg_fight_cooldown_desc({ s: remaining }, { locale }))], flags: [MessageFlags.Ephemeral] });
      return;
    }
  }

  if (profile.energy < FIGHT_ENERGY_COST) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_fight_low_energy_title({}, { locale }), m.rpg_fight_low_energy_desc({ energy: profile.energy }, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  if (profile.health <= FIGHT_MIN_HEALTH) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_fight_low_hp_title({}, { locale }), m.rpg_fight_low_hp_desc({}, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  // Débit d'énergie ET pose du verrou de combat dans la même écriture atomique :
  // `lastBattle` était auparavant écrit seulement à la fin du combat, ce qui permettait
  // de spammer le bouton pour ouvrir plusieurs sessions en parallèle sur le même profil
  // (chaque session sauvegardant ses PV à la fin, la dernière écrasant les dégâts subis).
  const battleLockedAt = new Date();
  const energySpent = await prisma.rpgProfile.updateMany({
    where: {
      guildId,
      userId: ownerId,
      energy: { gte: FIGHT_ENERGY_COST },
      OR: [
        { lastBattle: null },
        { lastBattle: { lte: new Date(battleLockedAt.getTime() - FIGHT_COOLDOWN_MS) } },
      ],
    },
    data: { energy: { decrement: FIGHT_ENERGY_COST }, lastBattle: battleLockedAt },
  });

  if (energySpent.count === 0) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_fight_low_energy_title({}, { locale }), m.rpg_fight_low_energy_desc({ energy: profile.energy }, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  /** Rend l'énergie (et libère le verrou) quand le combat ne peut pas démarrer. */
  const refundFightCost = () => prisma.rpgProfile.update({
    where: { guildId_userId: { guildId, userId: ownerId } },
    data: { energy: { increment: FIGHT_ENERGY_COST }, lastBattle: profile.lastBattle },
  }).catch(() => null);

  await interaction.deferUpdate();

  const monster = await findRandomMonster(guildId, profile.level);
  if (!monster) {
    await refundFightCost();
    await interaction.editReply({ embeds: [errorEmbed(m.rpg_fight_no_monster_title({}, { locale }), m.rpg_fight_no_monster_desc({}, { locale }))], components: [backRow(ownerId, locale)] });
    return;
  }

  // Statistiques dérivées : base du profil + équipement + forge + modificateurs de classe.
  const stats = await loadEffectiveStats(profile);
  const playerMaxHp = stats.maxHealth;
  const skills = getAvailableSkills(profile.className, profile.level);

  let playerHp = Math.min(profile.health, playerMaxHp);
  let monsterHp = monster.health;
  const monsterMaxHp = monster.health;

  // En combat, seules les potions qui rendent des PV ont un intérêt : filtrer sur
  // `hpRestore > 0` évite que le bouton consomme une potion d'énergie pour 0 soin.
  // On sert la plus faible en premier pour ne pas gaspiller un élixir sur une égratignure.
  const getPotions = () => prisma.rpgInventoryItem.findMany({
    where: {
      rpgProfileId: profile.id,
      quantity: { gte: 1 },
      item: { type: 'POTION', hpRestore: { gt: 0 } },
    },
    include: { item: true },
    orderBy: { item: { hpRestore: 'asc' } },
  });

  const getEmbed = (turnsLog: string[]) => {
    const logs = turnsLog.slice(-5).join('\n') || m.rpg_fight_combat_start_log({}, { locale });
    return new EmbedBuilder()
      .setTitle(m.rpg_fight_title({ emoji: monster.emoji, name: monster.name }, { locale }))
      .setDescription(
        `${monster.description}\n\n` +
        `${m.rpg_fight_you_label_block({}, { locale })}\n${buildHpBar(playerHp, playerMaxHp)}\n\n` +
        `${m.rpg_fight_enemy_label_block({ emoji: monster.emoji, name: monster.name, level: monster.level }, { locale })}\n${buildHpBar(monsterHp, monsterMaxHp)}\n\n` +
        `${m.rpg_fight_combat_log_label({}, { locale })}\n${logs}`,
      )
      .setColor('#5865F2');
  };

  // Tours restants avant que chaque compétence redevienne disponible.
  const skillCooldowns = new Map<string, number>(skills.map((skill) => [skill.id, 0]));

  const getActionRows = async () => {
    const userPotions = await getPotions();
    const potionsCount = userPotions.reduce((sum, p) => sum + p.quantity, 0);

    const mainRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`rpg:combat_attack:${ownerId}`).setLabel(m.rpg_fight_btn_attack({}, { locale })).setEmoji(icon('rpgAtk')).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`rpg:combat_defend:${ownerId}`).setLabel(m.rpg_fight_btn_defend({}, { locale })).setEmoji(icon('rpgDef')).setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`rpg:combat_potion:${ownerId}`).setLabel(m.rpg_fight_btn_potion({ count: potionsCount }, { locale })).setEmoji(icon('rpgPotion')).setStyle(ButtonStyle.Success).setDisabled(potionsCount === 0),
      new ButtonBuilder().setCustomId(`rpg:combat_flee:${ownerId}`).setLabel(m.rpg_fight_btn_flee({}, { locale })).setEmoji(icon('rpgSpd')).setStyle(ButtonStyle.Danger),
    );

    if (skills.length === 0) return [mainRow];

    // Une compétence en recharge reste visible mais désactivée, avec le nombre de tours
    // restants sur le libellé : le joueur peut planifier au lieu de deviner.
    const skillRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...skills.map((skill) => {
        const remaining = skillCooldowns.get(skill.id) ?? 0;
        return new ButtonBuilder()
          .setCustomId(`rpg:combat_skill_${skill.id}:${ownerId}`)
          .setLabel(remaining > 0 ? `${skill.name} (${remaining})` : skill.name)
          .setEmoji(skill.emoji)
          .setStyle(ButtonStyle.Success)
          .setDisabled(remaining > 0);
      }),
    );

    return [mainRow, skillRow];
  };

  const message = await interaction.editReply({ embeds: [getEmbed([])], components: await getActionRows() });

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) => i.user.id === ownerId && i.customId.startsWith('rpg:combat_'),
    time: COMBAT_TURN_TIMEOUT_MS,
  });

  const turnsLog: string[] = [];
  let defenseMultiplier = 1;
  let evadeNextAttack = false;
  let totalDamageDealt = 0;
  let totalDamageTaken = 0;

  /** Applique une attaque du joueur, éventuellement portée par une compétence. */
  const strike = (skill: ReturnType<typeof getAvailableSkills>[number] | null): string => {
    const { damage, critical, healed } = computeAttack({
      attack: stats.attack,
      targetDefense: monster.defense,
      speed: stats.speed,
      critChance: stats.critChance,
      armorPiercing: Math.max(stats.armorPiercing, skill?.effect.armorPiercing ?? 0),
      skillMultiplier: skill?.effect.damageMultiplier ?? 1,
      // Vol de vie de la compétence et des enchantements : deux sources distinctes, qui
      // se cumulent plutôt que de s'annuler.
      lifesteal: stats.lifesteal + (skill?.effect.lifesteal ?? 0),
    });

    monsterHp = Math.max(0, monsterHp - damage);
    totalDamageDealt += damage;

    if (healed > 0) playerHp = Math.min(playerMaxHp, playerHp + healed);

    const crit = critical ? m.rpg_fight_critical_suffix({}, { locale }) : '';
    return skill
      ? m.rpg_fight_action_skill({ emoji: skill.emoji, skill: skill.name, dmg: damage, crit, name: monster.name }, { locale })
      : m.rpg_fight_action_attack({ dmg: damage, crit, name: monster.name }, { locale });
  };

  collector.on('collect', async (btnInt) => {
    try {
      await btnInt.deferUpdate();
      collector.resetTimer();

      // Les postures ne durent qu'un tour : elles se réinitialisent à chaque action.
      defenseMultiplier = 1;
      let actionTaken = '';
      const action = btnInt.customId.split(':')[1];

      if (action === 'combat_attack') {
        actionTaken = strike(null);
      } else if (action === 'combat_defend') {
        defenseMultiplier = 2;
        actionTaken = m.rpg_fight_action_defend({}, { locale });
      } else if (action.startsWith('combat_skill_')) {
        const skillId = action.slice('combat_skill_'.length);
        const skill = skills.find((s) => s.id === skillId);
        const remaining = skill ? skillCooldowns.get(skill.id) ?? 0 : 0;

        if (!skill || remaining > 0) {
          // Le bouton est désactivé côté client : ce cas ne survient que sur un clic
          // concurrent, on ne consomme donc pas le tour.
          return;
        }

        skillCooldowns.set(skill.id, skill.cooldownTurns);
        if (skill.effect.defenseMultiplier) defenseMultiplier = skill.effect.defenseMultiplier;
        if (skill.effect.evadeNextAttack) evadeNextAttack = true;
        if (skill.effect.healPercent) {
          playerHp = Math.min(playerMaxHp, playerHp + Math.floor(playerMaxHp * skill.effect.healPercent));
        }

        actionTaken = skill.effect.damageMultiplier > 0
          ? strike(skill)
          : m.rpg_fight_action_skill_support({ emoji: skill.emoji, skill: skill.name }, { locale });
      } else if (action === 'combat_potion') {
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
      } else if (action === 'combat_flee') {
        turnsLog.push(m.rpg_fight_action_flee({}, { locale }));
        collector.stop('fled');
        return;
      }

      turnsLog.push(actionTaken);

      // Une compétence consommée fait progresser toutes les recharges d'un tour.
      for (const [id, remaining] of skillCooldowns) {
        if (remaining > 0) skillCooldowns.set(id, remaining - 1);
      }

      if (monsterHp <= 0) {
        collector.stop('victory');
        return;
      }

      if (evadeNextAttack) {
        evadeNextAttack = false;
        turnsLog.push(m.rpg_fight_monster_evaded({ emoji: monster.emoji, name: monster.name }, { locale }));
      } else {
        const { damage: monsterDamage, critical: monsterCrit, reflected } = computeAttack({
          attack: monster.attack,
          targetDefense: stats.defense,
          speed: monster.speed,
          critChance: 0.08,
          targetDefenseMultiplier: defenseMultiplier,
          targetDamageReduction: stats.damageReduction,
          targetThorns: stats.thorns,
        });

        playerHp = Math.max(0, playerHp - monsterDamage);
        totalDamageTaken += monsterDamage;
        turnsLog.push(m.rpg_fight_monster_turn_log({ emoji: monster.emoji, name: monster.name, dmg: monsterDamage, crit: monsterCrit ? m.rpg_fight_critical_suffix({}, { locale }) : '' }, { locale }));

        // Les épines répliquent même sur un coup mortel : l'armure réagit à l'impact.
        if (reflected > 0) {
          monsterHp = Math.max(0, monsterHp - reflected);
          totalDamageDealt += reflected;
          turnsLog.push(m.rpg_fight_thorns_log({ dmg: reflected, emoji: monster.emoji, name: monster.name }, { locale }));
        }

        if (monsterHp <= 0) {
          collector.stop('victory');
          return;
        }

        if (playerHp <= 0) {
          collector.stop('defeat');
          return;
        }
      }

      await interaction.editReply({ embeds: [getEmbed(turnsLog)], components: await getActionRows() });
    } catch (err) {
      console.error(err);
    }
  });

  collector.on('end', async (_, reason) => {
    try {
      // Le combat est terminé : on grise toutes les actions et on ne laisse que le retour.
      const rows = await getActionRows();
      rows.forEach((row) => row.components.forEach((c) => c.setDisabled(true)));
      const finalComponents = [...rows, backRow(ownerId, locale)];

      if (reason === 'fled' || reason === 'time') {
        await prisma.rpgProfile.update({ where: { guildId_userId: { guildId, userId: ownerId } }, data: { health: playerHp, lastBattle: new Date() } });

        const embed = reason === 'fled'
          ? new EmbedBuilder()
            .setTitle(m.rpg_fight_fled_title({ emoji: monster.emoji, name: monster.name }, { locale }))
            .setDescription(m.rpg_fight_fled_desc({ playerBar: buildHpBar(playerHp, playerMaxHp), name: monster.name, monsterBar: buildHpBar(monsterHp, monsterMaxHp) }, { locale }))
            .setColor('#FFA500')
          : new EmbedBuilder()
            .setTitle(m.rpg_fight_timeout_title({}, { locale }))
            .setDescription(m.rpg_fight_timeout_desc({}, { locale }))
            .setColor('#808080');

        await interaction.editReply({ embeds: [embed], components: finalComponents });
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

            const dropItem = await prisma.rpgItem.findFirst({ where: { OR: [{ guildId: null }, { guildId }], name: drop.itemName } });
            if (dropItem) {
              await prisma.rpgInventoryItem.upsert({
                where: { rpgProfileId_itemId: { rpgProfileId: profile.id, itemId: dropItem.id } },
                update: { quantity: { increment: 1 } },
                create: { rpgProfileId: profile.id, itemId: dropItem.id, quantity: 1 },
              });
            }
            break;
          }
        }

        await prisma.rpgProfile.update({
          where: { guildId_userId: { guildId, userId: ownerId } },
          data: {
            health: Math.max(1, playerHp),
            balance: { increment: coinsEarned },
            xp: { increment: xpEarned },
            totalMonstersKilled: !monster.isBoss ? { increment: 1 } : undefined,
            totalBossesKilled: monster.isBoss ? { increment: 1 } : undefined,
            lastBattle: new Date(),
          },
        });

        await prisma.rpgBattle.create({
          data: { guildId, userId: ownerId, monsterId: monster.id, monsterName: monster.name, won: true, damageDealt: totalDamageDealt, damageTaken: totalDamageTaken, xpEarned, coinsEarned, itemDropped },
        });

        const { checkLevelUp } = await import('./economyService.js');
        const beforeLevel = profile.level;
        await checkLevelUp(guildId, ownerId);
        const afterProfile = await prisma.rpgProfile.findUnique({ where: { guildId_userId: { guildId, userId: ownerId } } });
        const levelUp = afterProfile && afterProfile.level > beforeLevel ? afterProfile.level : null;

        const victoryEmbed = new EmbedBuilder()
          .setTitle(m.rpg_fight_victory_title({ emoji: monster.emoji, name: monster.name }, { locale }))
          .setDescription(m.rpg_fight_victory_desc({ name: monster.name, playerBar: buildHpBar(playerHp, playerMaxHp), log: turnsLog.slice(-4).join('\n') }, { locale }))
          .setColor(COLORS.success)
          .addFields(
            { name: m.rpg_fight_field_dmg_dealt({}, { locale }), value: `${totalDamageDealt}`, inline: true },
            { name: m.rpg_fight_field_dmg_taken({}, { locale }), value: `${totalDamageTaken}`, inline: true },
            { name: m.rpg_fight_field_xp_earned({}, { locale }), value: `+${xpEarned}`, inline: true },
            { name: m.rpg_fight_field_coins_earned({ emoji: '🪙' }, { locale }), value: `+${coinsEarned}`, inline: true },
          );

        const teamPoints = await awardMonsterTeamPoints(guildId, ownerId, monster, interaction.client);
        await trackCombatQuests(interaction.client, guildId, ownerId, monster.isBoss, itemDropped);

        if (itemDropped) victoryEmbed.addFields({ name: m.rpg_fight_field_drop({}, { locale }), value: `${itemDropEmoji || '📦'} **${itemDropped}**`, inline: true });
        if (teamPoints.amount > 0) {
          victoryEmbed.addFields({
            name: teamPoints.toGuild ? m.rpg_fight_field_guild_xp({}, { locale }) : m.rpg_fight_field_clan_points({}, { locale }),
            value: `+${teamPoints.amount}`,
            inline: true,
          });
        }
        if (levelUp) victoryEmbed.addFields({ name: m.rpg_fight_field_levelup({}, { locale }), value: m.rpg_fight_field_levelup_desc({ level: levelUp }, { locale }) });

        await interaction.editReply({ embeds: [victoryEmbed], components: finalComponents });
        return;
      }

      if (reason === 'defeat') {
        const xpEarned = Math.floor(monster.xpReward * 0.15);

        await prisma.rpgProfile.update({ where: { guildId_userId: { guildId, userId: ownerId } }, data: { health: 1, xp: { increment: xpEarned }, lastBattle: new Date() } });
        await prisma.rpgBattle.create({ data: { guildId, userId: ownerId, monsterId: monster.id, monsterName: monster.name, won: false, damageDealt: totalDamageDealt, damageTaken: totalDamageTaken, xpEarned, coinsEarned: 0, itemDropped: null } });

        const defeatEmbed = new EmbedBuilder()
          .setTitle(m.rpg_fight_defeat_title({ emoji: monster.emoji, name: monster.name }, { locale }))
          .setDescription(m.rpg_fight_defeat_desc({ name: monster.name, playerBar: buildHpBar(0, playerMaxHp), log: turnsLog.slice(-4).join('\n') }, { locale }))
          .setColor(COLORS.danger)
          .addFields(
            { name: m.rpg_fight_field_dmg_dealt({}, { locale }), value: `${totalDamageDealt}`, inline: true },
            { name: m.rpg_fight_field_dmg_taken({}, { locale }), value: `${totalDamageTaken}`, inline: true },
            { name: m.rpg_fight_field_xp_earned({}, { locale }), value: `+${xpEarned}`, inline: true },
          );

        await interaction.editReply({ embeds: [defeatEmbed], components: finalComponents });
      }
    } catch (err) {
      console.error(err);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Boss (résolution instantanée via select menu)
// ─────────────────────────────────────────────────────────────

async function buildBossSelectView(guildId: string, ownerId: string, locale: Locale): Promise<PanelView> {
  const config = await getOrCreateEconomyConfig(guildId);
  if (!config.rpgEnabled) {
    const embed = errorEmbed(m.rpg_travel_disabled_title({}, { locale }), m.rpg_boss_disabled_desc({}, { locale }));
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  const bosses = await listBosses(guildId);
  if (bosses.length === 0) {
    const embed = errorEmbed(m.rpg_boss_not_found_title({}, { locale }), m.rpg_hub_boss_none({}, { locale }));
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_hub_boss_select_title({}, { locale }))
    .setDescription(m.rpg_hub_boss_select_desc({}, { locale }))
    .setColor(RPG_COLORS.combat);

  const select = new StringSelectMenuBuilder()
    .setCustomId(`rpg:bossselect:${ownerId}`)
    .setPlaceholder(m.rpg_hub_boss_select_placeholder({}, { locale }));

  bosses.slice(0, 25).forEach((boss) => {
    select.addOptions({
      label: `${boss.emoji} ${boss.name}`,
      description: m.rpg_boss_autocomplete_level({ level: boss.level }, { locale }),
      value: boss.id,
      emoji: optionEmoji(boss.emoji),
    });
  });

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
  return { embeds: [embed], components: [selectRow, backRow(ownerId, locale)] };
}

async function handleBossSelect(interaction: StringSelectMenuInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const bossId = interaction.values[0];
  const boss = await findGuildMonsterById(guildId, bossId);
  if (!boss || !boss.isBoss) {
    await replyPanelError(interaction, new Error(m.rpg_boss_not_found_desc({ name: bossId }, { locale })), locale);
    return;
  }

  const config = await getOrCreateEconomyConfig(guildId);
  const profile = await getOrCreateRpgProfile(guildId, ownerId);

  if (profile.level < boss.level) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_boss_low_level_title({}, { locale }), m.rpg_boss_low_level_desc({ level: boss.level, myLevel: profile.level }, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }
  if (profile.energy < BOSS_ENERGY_COST) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_boss_low_energy_title({}, { locale }), m.rpg_boss_low_energy_desc({ energy: profile.energy }, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }
  if (profile.health <= BOSS_MIN_HEALTH) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_boss_low_hp_title({}, { locale }), m.rpg_boss_low_hp_desc({}, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  // `bossRespawnHours` existait dans le schéma mais n'était jamais appliqué : le même boss
  // pouvait être farmé en boucle. Le respawn est par joueur, calculé sur sa dernière victoire.
  if (boss.bossRespawnHours && boss.bossRespawnHours > 0) {
    const respawnMs = boss.bossRespawnHours * 60 * 60 * 1000;
    const lastWin = await prisma.rpgBattle.findFirst({
      where: { guildId, userId: ownerId, monsterId: boss.id, won: true },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    if (lastWin) {
      const remainingMs = respawnMs - (Date.now() - lastWin.createdAt.getTime());
      if (remainingMs > 0) {
        await interaction.reply({
          embeds: [errorEmbed(
            m.rpg_boss_respawn_title({}, { locale }),
            m.rpg_boss_respawn_desc({
              name: boss.name,
              hours: Math.floor(remainingMs / (60 * 60 * 1000)),
              minutes: Math.ceil((remainingMs % (60 * 60 * 1000)) / (60 * 1000)),
            }, { locale }),
          )],
          flags: [MessageFlags.Ephemeral],
        });
        return;
      }
    }
  }

  const energySpent = await prisma.rpgProfile.updateMany({ where: { guildId, userId: ownerId, energy: { gte: BOSS_ENERGY_COST } }, data: { energy: { decrement: BOSS_ENERGY_COST } } });
  if (energySpent.count === 0) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_boss_low_energy_title({}, { locale }), m.rpg_boss_low_energy_desc({ energy: profile.energy }, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  await interaction.deferUpdate();

  let result;
  try {
    result = await simulateBattle(profile, boss);
  } catch (err) {
    // Sans ce rattrapage, un échec de la simulation faisait perdre l'énergie déjà débitée.
    await prisma.rpgProfile.update({
      where: { guildId_userId: { guildId, userId: ownerId } },
      data: { energy: { increment: BOSS_ENERGY_COST } },
    }).catch(() => null);
    throw err;
  }
  const teamPoints = result.won
    ? await awardMonsterTeamPoints(guildId, ownerId, boss, interaction.client)
    : { amount: 0, toGuild: false };
  if (result.won) {
    await trackCombatQuests(interaction.client, guildId, ownerId, boss.isBoss, result.itemDropped);
  }

  const turnSummary = result.turns.slice(-8).map((t) => {
    const who = t.attacker === 'player' ? m.rpg_boss_you_label({}, { locale }) : `${boss.emoji} ${boss.name}`;
    const crit = t.critical ? m.rpg_fight_critical_suffix({}, { locale }) : '';
    return m.rpg_boss_turn_log({ who, dmg: t.damage, crit }, { locale });
  }).join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`${result.won ? m.rpg_boss_won_title({}, { locale }) : m.rpg_boss_lost_title({}, { locale })} - ${boss.emoji} ${boss.name}`)
    .setDescription(`${boss.description}\n\n${m.rpg_boss_combat_summary_label({ turns: result.turns.length }, { locale })}\n${turnSummary}`)
    .setColor(result.won ? COLORS.success : COLORS.danger)
    .addFields(
      { name: m.rpg_fight_field_dmg_dealt({}, { locale }), value: `${result.totalDamageDealt}`, inline: true },
      { name: m.rpg_fight_field_dmg_taken({}, { locale }), value: `${result.totalDamageTaken}`, inline: true },
      { name: m.rpg_fight_field_hp_remaining({}, { locale }), value: `${result.playerHpRemaining} / ${profile.maxHealth}`, inline: true },
      { name: m.rpg_fight_field_xp_earned({}, { locale }), value: `+${result.xpEarned}`, inline: true },
      { name: m.rpg_fight_field_coins_earned({ emoji: config.currencyEmoji }, { locale }), value: `+${result.coinsEarned}`, inline: true },
    );

  if (result.itemDropped) embed.addFields({ name: m.rpg_boss_field_drop({}, { locale }), value: `${result.itemDropEmoji || '📦'} **${result.itemDropped}**` });
  if (teamPoints.amount > 0) {
    embed.addFields({
      name: teamPoints.toGuild ? m.rpg_fight_field_guild_xp({}, { locale }) : m.rpg_fight_field_clan_points({}, { locale }),
      value: `+${teamPoints.amount}`,
      inline: true,
    });
  }
  if (result.levelUp) embed.addFields({ name: m.rpg_fight_field_levelup({}, { locale }), value: m.rpg_fight_field_levelup_desc({ level: result.levelUp }, { locale }) });

  await interaction.editReply({ embeds: [embed], components: [backRow(ownerId, locale)] });
}

// ─────────────────────────────────────────────────────────────
// Payer / Vendre
// ─────────────────────────────────────────────────────────────

function buildPayModal(ownerId: string, locale: Locale): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(`rpg:paysubmit:${ownerId}`).setTitle(m.rpg_hub_pay_modal_title({}, { locale }));
  const recipientInput = new TextInputBuilder().setCustomId('destinataire').setLabel(m.rpg_hub_pay_field_recipient({}, { locale })).setStyle(TextInputStyle.Short).setPlaceholder('@membre ou ID').setRequired(true);
  const amountInput = new TextInputBuilder().setCustomId('montant').setLabel(m.rpg_hub_pay_field_amount({}, { locale })).setStyle(TextInputStyle.Short).setRequired(true);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(recipientInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput),
  );
  return modal;
}

function buildSellModal(ownerId: string, locale: Locale): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(`rpg:sellsubmit:${ownerId}`).setTitle(m.rpg_hub_sell_modal_title({}, { locale }));
  const itemInput = new TextInputBuilder().setCustomId('objet').setLabel(m.rpg_hub_sell_field_item({}, { locale })).setStyle(TextInputStyle.Short).setRequired(true);
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(itemInput));
  return modal;
}

async function handlePaySubmit(interaction: ModalSubmitInteraction, guildId: string, ownerId: string, locale: Locale, client: Client): Promise<void> {
  const recipientText = interaction.fields.getTextInputValue('destinataire');
  const amount = Number.parseInt(interaction.fields.getTextInputValue('montant'), 10);

  const recipientId = parseUserIdFromText(recipientText);
  if (!recipientId) {
    await replyPanelError(interaction, new Error(m.rpg_hub_pay_invalid_recipient({}, { locale })), locale);
    return;
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    await replyPanelError(interaction, new Error(m.rpg_hub_invalid_amount({}, { locale })), locale);
    return;
  }
  if (recipientId === ownerId) {
    await replyPanelError(interaction, new Error(m.rpg_pay_no_self({}, { locale })), locale);
    return;
  }

  const recipient = await client.users.fetch(recipientId).catch(() => null);
  if (!recipient || recipient.bot) {
    await replyPanelError(interaction, new Error(m.rpg_pay_no_bot({}, { locale })), locale);
    return;
  }

  // On délègue à `transferCoins` plutôt que d'écrire les deux soldes à la main : le
  // transfert brut d'origine ignorait le plafond `maxTransferAmount`, le cooldown
  // `transferCooldownMin` et la garde atomique sur le solde du payeur.
  const transfer = await transferCoins(guildId, ownerId, recipient.id, amount);

  const config = await getOrCreateEconomyConfig(guildId);
  const embed = successEmbed(m.rpg_pay_success_title({}, { locale }), m.rpg_pay_success_desc({ amount, emoji: config.currencyEmoji, id: recipient.id }, { locale }))
    .addFields({ name: m.rpg_pay_field_your_balance({}, { locale }), value: `**${transfer.senderBalance}** ${config.currencyEmoji}` });

  await respond(interaction, { embeds: [embed], components: [backRow(ownerId, locale)] });
}

async function handleSellSubmit(interaction: ModalSubmitInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const query = interaction.fields.getTextInputValue('objet').toLowerCase();
  const profile = await getOrCreateRpgProfile(guildId, ownerId);
  const entry = (profile.inventory as unknown as LocalInventoryEntry[]).find((e) => e.item.name.toLowerCase().includes(query));

  if (!entry) {
    await replyPanelError(interaction, new Error(m.rpg_sell_not_found_desc({ query }, { locale })), locale);
    return;
  }

  const sellResult = await sellShopItem(guildId, ownerId, entry.item.id);
  const embed = successEmbed(m.rpg_sell_success_title({}, { locale }), m.rpg_sell_success_desc({ item: sellResult.itemName, price: sellResult.sellPrice }, { locale }))
    .addFields({ name: m.rpg_sell_new_balance({}, { locale }), value: `**${sellResult.newBalance}** 🪙` });

  await respond(interaction, { embeds: [embed], components: [backRow(ownerId, locale)] });
}

// ─────────────────────────────────────────────────────────────
// Admin
// ─────────────────────────────────────────────────────────────

async function buildAdminView(ownerId: string, locale: Locale): Promise<PanelView> {
  const embed = new EmbedBuilder()
    .setTitle(m.rpg_hub_admin_title({}, { locale }))
    .setDescription(m.rpg_hub_admin_desc({}, { locale }))
    .setColor(COLORS.warning);

  const resetSelect = new StringSelectMenuBuilder()
    .setCustomId(`rpg:adminresetselect:${ownerId}`)
    .setPlaceholder(m.rpg_hub_admin_reset_placeholder({}, { locale }))
    .addOptions(
      { label: m.rpg_hub_admin_reset_all({}, { locale }), value: 'all' },
      { label: m.rpg_hub_admin_reset_profiles({}, { locale }), value: 'profiles' },
      { label: m.rpg_hub_admin_reset_items({}, { locale }), value: 'items' },
      { label: m.rpg_hub_admin_reset_config({}, { locale }), value: 'config' },
      { label: m.rpg_hub_admin_reset_guilds({}, { locale }), value: 'guilds' },
    );

  const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rpg:adminsetopen:${ownerId}:balance`).setLabel(m.rpg_hub_admin_btn_balance({}, { locale })).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rpg:adminsetopen:${ownerId}:level`).setLabel(m.rpg_hub_admin_btn_level({}, { locale })).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rpg:adminsetopen:${ownerId}:xp`).setLabel(m.rpg_hub_admin_btn_xp({}, { locale })).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`rpg:admindropopen:${ownerId}`).setLabel(m.rpg_hub_admin_btn_drop({}, { locale })).setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`rpg:nav:${ownerId}:hub`).setLabel(m.rpg_hub_btn_back({}, { locale })).setEmoji(icon('rpgBack')).setStyle(ButtonStyle.Secondary),
  );

  return {
    embeds: [embed],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(resetSelect), buttonRow],
  };
}

function buildAdminSetModal(ownerId: string, stat: AdminStat, locale: Locale): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(`rpg:adminsetsubmit:${ownerId}:${stat}`).setTitle(m.rpg_hub_admin_set_modal_title({ stat }, { locale }));
  const memberInput = new TextInputBuilder().setCustomId('membre').setLabel(m.rpg_hub_admin_field_member({}, { locale })).setStyle(TextInputStyle.Short).setPlaceholder('@membre ou ID').setRequired(true);
  const valueInput = new TextInputBuilder().setCustomId('valeur').setLabel(m.rpg_hub_admin_field_value({}, { locale })).setStyle(TextInputStyle.Short).setRequired(true);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(memberInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(valueInput),
  );
  return modal;
}

function buildAdminDropModal(ownerId: string, locale: Locale): ModalBuilder {
  const modal = new ModalBuilder().setCustomId(`rpg:admindropsubmit:${ownerId}`).setTitle(m.rpg_hub_admin_drop_modal_title({}, { locale }));
  const typeInput = new TextInputBuilder().setCustomId('type').setLabel(m.rpg_hub_admin_drop_field_type({}, { locale })).setStyle(TextInputStyle.Short).setPlaceholder('COINS ou XP').setRequired(true);
  const amountInput = new TextInputBuilder().setCustomId('montant').setLabel(m.rpg_hub_admin_drop_field_amount({}, { locale })).setStyle(TextInputStyle.Short).setRequired(true);
  modal.addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(typeInput),
    new ActionRowBuilder<TextInputBuilder>().addComponents(amountInput),
  );
  return modal;
}

async function handleAdminResetSelect(interaction: StringSelectMenuInteraction, ownerId: string, locale: Locale): Promise<void> {
  if (!isInteractionAdmin(interaction)) {
    await interaction.reply({ content: m.rpg_hub_admin_only({}, { locale }), flags: [MessageFlags.Ephemeral] });
    return;
  }

  const component = interaction.values[0] as 'all' | 'profiles' | 'items' | 'config' | 'guilds';

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_admin_reset_confirm_title({}, { locale }))
    .setDescription(m.rpg_admin_reset_confirm_desc({ component }, { locale }))
    .setColor(COLORS.warning);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rpg_reset_confirm:${component}`).setLabel(m.rpg_admin_reset_confirm_button({}, { locale })).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('rpg_reset_cancel').setLabel(m.rpg_admin_reset_cancel_button({}, { locale })).setStyle(ButtonStyle.Secondary),
  );

  await respond(interaction, { embeds: [embed], components: [row] });
}

async function handleAdminSetSubmit(interaction: ModalSubmitInteraction, guildId: string, ownerId: string, stat: AdminStat, locale: Locale): Promise<void> {
  if (!isInteractionAdmin(interaction)) {
    await interaction.reply({ content: m.rpg_hub_admin_only({}, { locale }), flags: [MessageFlags.Ephemeral] });
    return;
  }

  const memberText = interaction.fields.getTextInputValue('membre');
  const value = Number.parseInt(interaction.fields.getTextInputValue('valeur'), 10);
  const targetId = parseUserIdFromText(memberText);

  if (!targetId || !Number.isFinite(value)) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_admin_modify_error_title({}, { locale }), m.rpg_hub_pay_invalid_recipient({}, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  await adminSetStats(guildId, targetId, { [stat]: value });
  await interaction.reply({ embeds: [successEmbed(m.rpg_admin_stats_updated_title({}, { locale }), m.rpg_admin_balance_set_desc({ id: targetId, value }, { locale }))], flags: [MessageFlags.Ephemeral] });
}

async function handleAdminDropSubmit(interaction: ModalSubmitInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  if (!isInteractionAdmin(interaction)) {
    await interaction.reply({ content: m.rpg_hub_admin_only({}, { locale }), flags: [MessageFlags.Ephemeral] });
    return;
  }

  const typeRaw = interaction.fields.getTextInputValue('type').trim().toUpperCase();
  const amount = Number.parseInt(interaction.fields.getTextInputValue('montant'), 10);
  const type = typeRaw === 'XP' ? 'XP' : 'COINS';

  if (!Number.isFinite(amount) || amount <= 0) {
    await interaction.reply({ embeds: [errorEmbed(m.rpg_drop_error_title({}, { locale }), m.rpg_hub_invalid_amount({}, { locale }))], flags: [MessageFlags.Ephemeral] });
    return;
  }

  const drop = await prisma.rpgDrop.create({ data: { guildId, amount, type } });
  const resourceName = type === 'COINS' ? m.rpg_drop_resource_coins({}, { locale }) : m.rpg_drop_resource_xp({}, { locale });

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_drop_title({}, { locale }))
    .setDescription(m.rpg_drop_desc({ amount, resource: resourceName }, { locale }))
    .setColor(COLORS.primary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`rpg_drop_claim:${drop.id}`).setLabel(m.rpg_drop_claim_button({}, { locale })).setStyle(ButtonStyle.Success),
  );

  if (interaction.channel?.isSendable()) {
    await interaction.channel.send({ embeds: [embed], components: [row] });
  }

  await interaction.reply({ content: m.rpg_hub_admin_drop_posted({}, { locale }), flags: [MessageFlags.Ephemeral] });
}

// ─────────────────────────────────────────────────────────────
// Personnage - classe & points de caractéristiques
// ─────────────────────────────────────────────────────────────

const STAT_ALLOCATIONS: { stat: AllocatableStat; emoji: string; label: (locale: Locale) => string }[] = [
  { stat: 'attack', emoji: '⚔️', label: (locale) => m.rpg_stat_attack({}, { locale }) },
  { stat: 'defense', emoji: '🛡️', label: (locale) => m.rpg_stat_defense({}, { locale }) },
  { stat: 'speed', emoji: '💨', label: (locale) => m.rpg_stat_speed({}, { locale }) },
  { stat: 'maxHealth', emoji: '❤️', label: (locale) => m.rpg_stat_health({}, { locale }) },
];

async function buildCharacterView(guildId: string, ownerId: string, locale: Locale): Promise<PanelView> {
  const profile = await getOrCreateRpgProfile(guildId, ownerId);
  const rpgClass = getRpgClass(profile.className);
  const skills = getAvailableSkills(profile.className, profile.level);

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_character_title({}, { locale }))
    .setColor(RPG_COLORS.hub)
    .addFields({
      name: m.rpg_character_field_base_stats({}, { locale }),
      value: m.rpg_character_base_stats_value({
        atk: profile.attack,
        def: profile.defense,
        spd: profile.speed,
        hp: profile.maxHealth,
      }, { locale }),
      inline: false,
    });

  if (rpgClass) {
    embed.setDescription(`${rpgClass.emoji} **${rpgClass.name}** - *${rpgClass.description}*`);
    embed.addFields({
      name: m.rpg_character_field_passive({}, { locale }),
      value: `**${rpgClass.passive.name}** - ${rpgClass.passive.description}`,
      inline: false,
    });

    const skillLines = rpgClass.skills.map((skill) => {
      const unlocked = skills.some((s) => s.id === skill.id);
      const status = unlocked
        ? m.rpg_character_skill_unlocked({ cooldown: skill.cooldownTurns }, { locale })
        : m.rpg_character_skill_locked({ level: skill.levelRequired }, { locale });
      return `${skill.emoji} **${skill.name}** - ${skill.description}\n${status}`;
    });
    embed.addFields({ name: m.rpg_character_field_skills({}, { locale }), value: skillLines.join('\n\n') });
  } else {
    embed.setDescription(m.rpg_character_no_class_desc({ level: CLASS_UNLOCK_LEVEL }, { locale }));
  }

  embed.addFields({
    name: m.rpg_character_field_points({}, { locale }),
    value: m.rpg_character_points_value({ points: profile.statPoints }, { locale }),
    inline: false,
  });

  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

  // Répartition des points : un bouton par caractéristique, grisé s'il ne reste rien.
  const statRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...STAT_ALLOCATIONS.map((entry) =>
      new ButtonBuilder()
        .setCustomId(`rpg:allocstat:${ownerId}:${entry.stat}`)
        .setLabel(entry.label(locale))
        .setEmoji(entry.emoji)
        .setStyle(ButtonStyle.Success)
        .setDisabled(profile.statPoints <= 0),
    ),
  );
  components.push(statRow);

  if (profile.level >= CLASS_UNLOCK_LEVEL) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`rpg:classselect:${ownerId}`)
      .setPlaceholder(
        profile.className
          ? m.rpg_character_reclass_placeholder({ cost: RECLASS_COST }, { locale })
          : m.rpg_character_class_placeholder({}, { locale }),
      )
      .addOptions(
        RPG_CLASS_LIST.map((entry) => ({
          label: entry.name,
          description: entry.passive.description.slice(0, 100),
          value: entry.id,
          emoji: entry.emoji,
          default: entry.id === profile.className,
        })),
      );
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  }

  components.push(backRow(ownerId, locale));
  return { embeds: [embed], components };
}

async function handleAllocateStat(interaction: ButtonInteraction, guildId: string, ownerId: string, locale: Locale, statRaw: string): Promise<void> {
  const entry = STAT_ALLOCATIONS.find((candidate) => candidate.stat === statRaw);
  if (!entry) return;

  const result = await allocateStatPoint(guildId, ownerId, entry.stat);
  const view = await buildCharacterView(guildId, ownerId, locale);
  view.embeds[0].setFooter({
    text: m.rpg_character_point_spent({ stat: entry.label(locale), gain: result.gain, remaining: result.remaining }, { locale }),
  });
  await respond(interaction, view);
}

async function handleClassSelect(interaction: StringSelectMenuInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const result = await chooseRpgClass(guildId, ownerId, interaction.values[0]);
  const view = await buildCharacterView(guildId, ownerId, locale);
  view.embeds[0].setFooter({
    text: result.cost > 0
      ? m.rpg_character_class_changed({ name: result.rpgClass.name, cost: result.cost }, { locale })
      : m.rpg_character_class_chosen({ name: result.rpgClass.name }, { locale }),
  });
  await respond(interaction, view);
}

// ─────────────────────────────────────────────────────────────
// Artisanat
// ─────────────────────────────────────────────────────────────

async function buildCraftView(guildId: string, ownerId: string, locale: Locale): Promise<PanelView> {
  const recipes = await listRecipesFor(guildId, ownerId);

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_craft_title({}, { locale }))
    .setDescription(m.rpg_craft_desc({}, { locale }))
    .setColor(RPG_COLORS.craft);

  if (recipes.length === 0) {
    embed.setDescription(m.rpg_craft_empty({}, { locale }));
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  // On met les recettes réalisables en tête : c'est la seule information vraiment
  // actionnable quand la liste dépasse la vingtaine d'entrées.
  const sorted = [...recipes].sort((a, b) => Number(b.craftable) - Number(a.craftable) || a.levelRequired - b.levelRequired);
  const shown = sorted.slice(0, 10);

  for (const recipe of shown) {
    const ingredients = recipe.ingredients
      .map((ing) => `${ing.owned >= ing.quantity ? '✅' : '❌'} ${ing.itemName} ${ing.owned}/${ing.quantity}`)
      .join('\n');

    embed.addFields({
      name: `${recipe.resultEmoji} ${recipe.resultName} ${rarityIcon(recipe.resultRarity)}`,
      value: `${m.rpg_craft_requirements({ level: recipe.levelRequired, cost: recipe.coinCost }, { locale })}\n${ingredients}`,
      inline: false,
    });
  }

  if (sorted.length > shown.length) {
    embed.setFooter({ text: m.rpg_craft_more({ count: sorted.length - shown.length }, { locale }) });
  }

  const craftable = sorted.filter((recipe) => recipe.craftable).slice(0, 25);
  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

  if (craftable.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(`rpg:craft:${ownerId}`)
      .setPlaceholder(m.rpg_craft_select_placeholder({}, { locale }))
      .addOptions(
        craftable.map((recipe) => ({
          label: recipe.resultName.slice(0, 100),
          description: m.rpg_craft_option_desc({ cost: recipe.coinCost }, { locale }).slice(0, 100),
          value: recipe.id,
          emoji: recipe.resultEmoji,
        })),
      );
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  }

  components.push(backRow(ownerId, locale));
  return { embeds: [embed], components };
}

async function handleCraft(interaction: StringSelectMenuInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const result = await craftRecipe(guildId, ownerId, interaction.values[0]);
  await trackQuest(interaction.client, guildId, ownerId, 'ITEMS_CRAFTED');
  await trackQuest(interaction.client, guildId, ownerId, 'COINS_SPENT', result.coinCost);

  const view = await buildCraftView(guildId, ownerId, locale);
  view.embeds[0].setFooter({
    text: m.rpg_craft_success({ emoji: result.itemEmoji, item: result.itemName, cost: result.coinCost }, { locale }),
  });
  await respond(interaction, view);
}

// ─────────────────────────────────────────────────────────────
// Forge - amélioration de l'équipement porté
// ─────────────────────────────────────────────────────────────

async function buildForgeView(guildId: string, ownerId: string, locale: Locale): Promise<PanelView> {
  const profile = await getOrCreateRpgProfile(guildId, ownerId);
  const quotes = await getUpgradeQuotes(guildId, ownerId);

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_forge_title({}, { locale }))
    .setDescription(m.rpg_forge_desc({ max: MAX_UPGRADE_LEVEL, balance: profile.balance }, { locale }))
    .setColor(RPG_COLORS.craft);

  if (quotes.length === 0) {
    embed.setDescription(m.rpg_forge_nothing_equipped({}, { locale }));
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  for (const quote of quotes) {
    embed.addFields({
      name: `${quote.itemEmoji} ${quote.itemName} (+${quote.currentLevel})`,
      value: quote.maxed
        ? m.rpg_forge_maxed({}, { locale })
        : m.rpg_forge_quote({ cost: quote.cost, chance: Math.round(quote.successChance * 100) }, { locale }),
      inline: false,
    });
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...quotes.map((quote) =>
      new ButtonBuilder()
        .setCustomId(`rpg:upgrade:${ownerId}:${quote.slot}`)
        .setLabel(`${quote.itemName.slice(0, 40)} +${quote.currentLevel}`)
        .setEmoji(icon('rpgForge'))
        .setStyle(ButtonStyle.Primary)
        .setDisabled(quote.maxed || profile.balance < quote.cost),
    ),
  );

  return { embeds: [embed], components: [row, backRow(ownerId, locale)] };
}

// ─────────────────────────────────────────────────────────────
// Autel d'enchantement
// ─────────────────────────────────────────────────────────────

function isEquipmentSlot(value: string): value is EquipmentSlot {
  return value === 'weapon' || value === 'armor' || value === 'accessory';
}

/**
 * Vue de l'autel : l'équipement porté avec ses enchantements, et les parchemins détenus.
 *
 * Un parchemin est posé en deux temps - choisir le parchemin, puis l'emplacement - parce
 * qu'un même parchemin (Célérité, Vitalité) accepte plusieurs emplacements. Le sélecteur
 * porte donc le parchemin, et une rangée de boutons propose les emplacements compatibles.
 */
async function buildEnchantView(
  guildId: string,
  ownerId: string,
  locale: Locale,
  selectedScrollId?: string,
): Promise<PanelView> {
  const state = await getEnchantAltarState(guildId, ownerId);

  const embed = new EmbedBuilder()
    .setTitle(m.rpg_enchant_title({}, { locale }))
    .setDescription(m.rpg_enchant_desc({ balance: state.balance }, { locale }))
    .setColor(RPG_COLORS.craft);

  if (state.pieces.length === 0) {
    embed.setDescription(m.rpg_enchant_nothing_equipped({}, { locale }));
    return { embeds: [embed], components: [backRow(ownerId, locale)] };
  }

  for (const piece of state.pieces) {
    const lines = piece.enchants.map((stack) => stack.label);
    for (let i = 0; i < piece.freeSlots; i++) lines.push(m.rpg_enchant_free_slot({}, { locale }));

    embed.addFields({
      name: `${piece.itemEmoji} ${piece.itemName} ${rarityIcon(piece.rarity)}`,
      value: `${lines.join('\n')}\n${m.rpg_enchant_capacity({ used: piece.enchants.length, total: piece.capacity }, { locale })}`,
      inline: false,
    });
  }

  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

  if (state.scrolls.length === 0) {
    embed.addFields({ name: m.rpg_enchant_field_scrolls({}, { locale }), value: m.rpg_enchant_no_scroll({}, { locale }) });
    components.push(backRow(ownerId, locale));
    return { embeds: [embed], components };
  }

  const select = new StringSelectMenuBuilder()
    .setCustomId(`rpg:enchantpick:${ownerId}`)
    .setPlaceholder(m.rpg_enchant_select_placeholder({}, { locale }));

  state.scrolls.slice(0, 25).forEach((scroll) => {
    select.addOptions({
      label: `${scroll.itemName} (x${scroll.quantity})`.slice(0, 100),
      description: m.rpg_enchant_scroll_option({
        cost: scroll.coinCost,
        chance: Math.round(scroll.successChance * 100),
      }, { locale }).slice(0, 100),
      value: scroll.itemId,
      default: scroll.itemId === selectedScrollId,
      emoji: optionEmoji(scroll.itemEmoji),
    });
  });

  components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));

  // Un parchemin sélectionné ouvre les emplacements où il peut réellement être posé :
  // seulement ceux que l'enchantement accepte ET où un objet est effectivement porté.
  const selected = selectedScrollId ? state.scrolls.find((scroll) => scroll.itemId === selectedScrollId) : null;
  if (selected) {
    const targets = state.pieces.filter((piece) => selected.slots.includes(piece.slot));

    embed.addFields({
      name: m.rpg_enchant_field_selected({}, { locale }),
      value: m.rpg_enchant_selected_value({
        emoji: selected.enchantEmoji,
        name: selected.enchantName,
        tier: selected.tier,
        description: selected.enchantDescription,
        cost: selected.coinCost,
        chance: Math.round(selected.successChance * 100),
      }, { locale }),
      inline: false,
    });

    if (targets.length === 0) {
      embed.addFields({ name: m.rpg_enchant_field_target({}, { locale }), value: m.rpg_enchant_no_target({}, { locale }) });
    } else {
      components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        ...targets.map((piece) =>
          new ButtonBuilder()
            .setCustomId(`rpg:enchantapply:${ownerId}:${piece.slot}:${selected.itemId}`)
            .setLabel(piece.itemName.slice(0, 60))
            .setEmoji(icon('rpgEnchant'))
            .setStyle(ButtonStyle.Primary)
            .setDisabled(state.balance < selected.coinCost),
        ),
      ));
    }
  }

  // Retrait : proposé uniquement quand il y a quelque chose à retirer, pour ne pas
  // encombrer l'écran d'un sélecteur vide au premier passage.
  const removable = state.pieces.flatMap((piece) =>
    piece.enchants.map((stack) => ({ piece, stack })),
  );

  if (removable.length > 0) {
    const removeSelect = new StringSelectMenuBuilder()
      .setCustomId(`rpg:enchantremove:${ownerId}`)
      .setPlaceholder(m.rpg_enchant_remove_placeholder({ cost: DISENCHANT_COST }, { locale }))
      .setDisabled(state.balance < DISENCHANT_COST);

    removable.slice(0, 25).forEach(({ piece, stack }) => {
      removeSelect.addOptions({
        label: `${stack.label} - ${piece.itemName}`.slice(0, 100),
        value: `${piece.slot}:${stack.id}`,
      });
    });

    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(removeSelect));
  }

  components.push(backRow(ownerId, locale));
  return { embeds: [embed], components };
}

/** Sélection d'un parchemin : on réaffiche l'autel avec les emplacements compatibles. */
async function handleEnchantPick(interaction: StringSelectMenuInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  await respond(interaction, await buildEnchantView(guildId, ownerId, locale, interaction.values[0]));
}

async function handleEnchantApply(
  interaction: ButtonInteraction,
  guildId: string,
  ownerId: string,
  locale: Locale,
  slotRaw: string,
  scrollItemId: string,
): Promise<void> {
  if (!isEquipmentSlot(slotRaw) || !scrollItemId) return;

  const result = await applyEnchantScroll(guildId, ownerId, slotRaw, scrollItemId);
  await trackQuest(interaction.client, guildId, ownerId, 'COINS_SPENT', result.coinCost);

  const view = await buildEnchantView(guildId, ownerId, locale);
  view.embeds[0].setFooter({
    text: result.success
      ? m.rpg_enchant_success({
          emoji: result.enchantEmoji,
          enchant: result.enchantName,
          tier: result.tier,
          item: result.itemName,
        }, { locale })
      : m.rpg_enchant_failure({ scroll: result.scrollName, cost: result.coinCost }, { locale }),
  });
  await respond(interaction, view);
}

async function handleEnchantRemove(interaction: StringSelectMenuInteraction, guildId: string, ownerId: string, locale: Locale): Promise<void> {
  const [slotRaw, enchantId] = interaction.values[0].split(':');
  if (!isEquipmentSlot(slotRaw) || !enchantId) return;

  const result = await removeEnchant(guildId, ownerId, slotRaw, enchantId);
  await trackQuest(interaction.client, guildId, ownerId, 'COINS_SPENT', result.coinCost);

  const view = await buildEnchantView(guildId, ownerId, locale);
  view.embeds[0].setFooter({
    text: m.rpg_enchant_removed({ enchant: result.enchantName, item: result.itemName, cost: result.coinCost }, { locale }),
  });
  await respond(interaction, view);
}

async function handleUpgrade(interaction: ButtonInteraction, guildId: string, ownerId: string, locale: Locale, slotRaw: string): Promise<void> {
  if (slotRaw !== 'weapon' && slotRaw !== 'armor' && slotRaw !== 'accessory') return;

  const result = await upgradeEquipment(guildId, ownerId, slotRaw);
  await trackQuest(interaction.client, guildId, ownerId, 'COINS_SPENT', result.cost);
  if (result.success) await trackQuest(interaction.client, guildId, ownerId, 'UPGRADES_SUCCEEDED');

  const view = await buildForgeView(guildId, ownerId, locale);
  view.embeds[0].setFooter({
    text: result.success
      ? m.rpg_forge_success({ emoji: result.itemEmoji, item: result.itemName, level: result.newLevel }, { locale })
      : m.rpg_forge_failure({ emoji: result.itemEmoji, item: result.itemName, cost: result.cost }, { locale }),
  });
  await respond(interaction, view);
}

// ─────────────────────────────────────────────────────────────
// Dispatch
// ─────────────────────────────────────────────────────────────

async function renderSection(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  guildId: string,
  ownerId: string,
  section: string,
  locale: Locale,
  rest: string[] = [],
): Promise<PanelView | null> {
  switch (section) {
    case 'hub': return buildHubView(guildId, interaction.user, interaction.user, locale, isInteractionAdmin(interaction));
    // `more` a disparu du hub avec sa rangée de boutons : les messages déjà
    // envoyés qui la visent retombent sur la fiche plutôt que sur un écran mort.
    case 'more': return buildHubView(guildId, interaction.user, interaction.user, locale, isInteractionAdmin(interaction));
    case 'inventory': return buildInventoryView(guildId, ownerId, locale);
    case 'shop': return buildShopView(guildId, ownerId, locale, parseShopState(rest));
    case 'blackmarket': return buildBlackMarketView(guildId, ownerId, locale);
    case 'travel': return buildTravelView(guildId, ownerId, locale);
    case 'guild': return buildGuildView(guildId, ownerId, locale, await panelMember(interaction, ownerId));
    case 'clanwar': return buildClanWarView(guildId, ownerId, await panelMember(interaction, ownerId), locale, asClanWarScope(rest[0]));
    case 'raid': return buildRaidView(guildId, ownerId, await panelMember(interaction, ownerId), locale);
    case 'bestiary': return buildBestiaryView(guildId, ownerId, interaction.user, locale);
    case 'boss': return buildBossSelectView(guildId, ownerId, locale);
    case 'character': return buildCharacterView(guildId, ownerId, locale);
    case 'craft': return buildCraftView(guildId, ownerId, locale);
    case 'forge': return buildForgeView(guildId, ownerId, locale);
    case 'enchant': return buildEnchantView(guildId, ownerId, locale);
    case 'admin': {
      if (!isInteractionAdmin(interaction)) {
        await interaction.reply({ content: m.rpg_hub_admin_only({}, { locale }), flags: [MessageFlags.Ephemeral] });
        return null;
      }
      return buildAdminView(ownerId, locale);
    }
    default: return null;
  }
}

export async function handleRpgButton(client: Client, customId: string, interaction: ButtonInteraction): Promise<void> {
  const route = parseRpgRoute(customId);
  if (!route) return;

  const { action, ownerId, rest } = route;
  const locale = await getEffectiveLocale(interaction);
  if (!(await ensureOwner(interaction, ownerId, locale))) return;

  const guildId = interaction.guildId;
  if (!guildId) return;

  try {
    switch (action) {
      case 'nav': {
        // Les segments qui suivent la section lui appartiennent : la boutique y
        // porte sa categorie et sa page.
        const view = await renderSection(interaction, guildId, ownerId, rest[0], locale, rest.slice(1));
        if (view) await respond(interaction, view);
        return;
      }
      case 'shopbuy': await handleShopBuy(interaction, guildId, ownerId, locale, rest); return;
      case 'shopopen': await handleShopItemOpen(interaction, guildId, ownerId, locale, rest); return;
      case 'daily': await handleDailyClaim(interaction, guildId, ownerId, locale); return;
      case 'fish': await handleFishClaim(interaction, guildId, ownerId, locale); return;
      case 'allocstat': await handleAllocateStat(interaction, guildId, ownerId, locale, rest[0]); return;
      case 'upgrade': await handleUpgrade(interaction, guildId, ownerId, locale, rest[0]); return;
      case 'enchantapply': await handleEnchantApply(interaction, guildId, ownerId, locale, rest[0], rest[1]); return;
      case 'fight': await startFightSession(interaction, guildId, ownerId, locale); return;
      case 'raidattack': await handleRaidAttack(interaction, guildId, ownerId, locale); return;
      case 'dest': await handleTravelDestinationChoice(interaction, guildId, ownerId, locale, rest[0]); return;
      case 'choice': await handleTravelEventChoice(interaction, guildId, ownerId, locale, rest[0], rest[1]); return;
      case 'paymodal': await interaction.showModal(buildPayModal(ownerId, locale)); return;
      case 'sellmodal': await interaction.showModal(buildSellModal(ownerId, locale)); return;
      case 'guildcreateopen': await interaction.showModal(buildGuildCreateModal(ownerId, locale)); return;
      case 'guildjoinopen': await interaction.showModal(buildGuildJoinModal(ownerId, locale)); return;
      case 'guilddepositopen': await interaction.showModal(buildGuildDepositModal(ownerId, locale)); return;
      case 'guildleaveask': await respond(interaction, buildGuildLeaveConfirmView(ownerId, locale)); return;
      case 'guildleaveyes': await handleGuildLeaveConfirm(interaction, guildId, ownerId, locale); return;
      case 'guildleaveno': await respond(interaction, await buildGuildView(guildId, ownerId, locale, await panelMember(interaction, ownerId))); return;
      case 'adminsetopen': {
        if (!isInteractionAdmin(interaction)) {
          await interaction.reply({ content: m.rpg_hub_admin_only({}, { locale }), flags: [MessageFlags.Ephemeral] });
          return;
        }
        await interaction.showModal(buildAdminSetModal(ownerId, rest[0] as AdminStat, locale));
        return;
      }
      case 'admindropopen': {
        if (!isInteractionAdmin(interaction)) {
          await interaction.reply({ content: m.rpg_hub_admin_only({}, { locale }), flags: [MessageFlags.Ephemeral] });
          return;
        }
        await interaction.showModal(buildAdminDropModal(ownerId, locale));
        return;
      }
      default: return;
    }
  } catch (err) {
    await replyPanelError(interaction, err, locale);
  }
}

export async function handleRpgSelectMenu(client: Client, customId: string, interaction: StringSelectMenuInteraction): Promise<void> {
  const route = parseRpgRoute(customId);
  if (!route) return;

  const { action, ownerId, rest } = route;
  const locale = await getEffectiveLocale(interaction);
  if (!(await ensureOwner(interaction, ownerId, locale))) return;

  const guildId = interaction.guildId;
  if (!guildId) return;

  try {
    switch (action) {
      case 'navsel': {
        // Le menu du hub mène soit à un écran, soit à une fenêtre de saisie :
        // « payer » et « vendre » n'ont pas d'écran à eux, seulement un modal.
        const destination = interaction.values[0];
        if (destination === 'pay') {
          await interaction.showModal(buildPayModal(ownerId, locale));
          return;
        }
        if (destination === 'sell') {
          await interaction.showModal(buildSellModal(ownerId, locale));
          return;
        }
        const view = await renderSection(interaction, guildId, ownerId, destination, locale);
        if (view) await respond(interaction, view);
        return;
      }
      case 'warscope': await handleWarScopeSelect(interaction, guildId, ownerId, locale); return;
      case 'invuse': await handleInventoryUse(interaction, guildId, ownerId, locale); return;
      case 'shopitem': await handleShopItemSelect(interaction, guildId, ownerId, locale, rest); return;
      case 'shopcat': await handleShopCategorySelect(interaction, guildId, ownerId, locale); return;
      case 'bmbuy': await handleBlackMarketBuy(interaction, guildId, ownerId, locale); return;
      case 'bossselect': await handleBossSelect(interaction, guildId, ownerId, locale); return;
      case 'classselect': await handleClassSelect(interaction, guildId, ownerId, locale); return;
      case 'craft': await handleCraft(interaction, guildId, ownerId, locale); return;
      case 'enchantpick': await handleEnchantPick(interaction, guildId, ownerId, locale); return;
      case 'enchantremove': await handleEnchantRemove(interaction, guildId, ownerId, locale); return;
      case 'adminresetselect': await handleAdminResetSelect(interaction, ownerId, locale); return;
      default: return;
    }
  } catch (err) {
    await replyPanelError(interaction, err, locale);
  }
}

export async function handleRpgModalSubmit(client: Client, customId: string, interaction: ModalSubmitInteraction): Promise<void> {
  const route = parseRpgRoute(customId);
  if (!route) return;

  const { action, ownerId, rest } = route;
  const locale = await getEffectiveLocale(interaction);
  if (!(await ensureOwner(interaction, ownerId, locale))) return;

  const guildId = interaction.guildId;
  if (!guildId) return;

  try {
    switch (action) {
      case 'guildcreatesubmit': await handleGuildCreateSubmit(interaction, guildId, ownerId, locale); return;
      case 'guildjoinsubmit': await handleGuildJoinSubmit(interaction, guildId, ownerId, locale); return;
      case 'guilddepositsubmit': await handleGuildDepositSubmit(interaction, guildId, ownerId, locale); return;
      case 'paysubmit': await handlePaySubmit(interaction, guildId, ownerId, locale, client); return;
      case 'sellsubmit': await handleSellSubmit(interaction, guildId, ownerId, locale); return;
      case 'adminsetsubmit': await handleAdminSetSubmit(interaction, guildId, ownerId, rest[0] as AdminStat, locale); return;
      case 'admindropsubmit': await handleAdminDropSubmit(interaction, guildId, ownerId, locale); return;
      default: return;
    }
  } catch (err) {
    await replyPanelError(interaction, err, locale);
  }
}
