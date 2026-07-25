import type { SlashCommandDefinition } from '../../commands.js';
import { ApplicationCommandOptionType, MessageFlags, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, PermissionsBitField, ModalBuilder, TextInputBuilder, TextInputStyle, type AutocompleteInteraction, type ChatInputCommandInteraction, type ButtonInteraction, type AnySelectMenuInteraction, type ModalSubmitInteraction } from 'discord.js';
import { COLORS_RAW, kotboContainer } from '../../utils/embeds.js';
import { E } from '../../utils/emojis.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import { ContainerChild, separator, v2Message } from '@arcscord/components';
import * as m from '../../lib/paraglide/messages.js';

type Locale = 'fr' | 'en';

interface CommandOption {
  name: string;
  description: string;
  type: ApplicationCommandOptionType;
  required?: boolean;
  options?: CommandOption[];
}

interface CommandJson {
  name: string;
  description: string;
  default_member_permissions?: string | null;
  options?: CommandOption[];
}

const CATEGORY_IDS = ['getting_started', 'feeds', 'mod', 'profile', 'fun'] as const;
type CategoryId = typeof CATEGORY_IDS[number];

const CATEGORY_META: Record<CategoryId, { emoji: string }> = {
  getting_started: { emoji: E.settings },
  feeds: { emoji: E.news },
  mod: { emoji: E.shield },
  profile: { emoji: E.profile },
  fun: { emoji: E.star },
};

function categoryLabel(id: CategoryId, locale: Locale) {
  return (m as any)[`help_category_${id}`]({}, { locale }) as string;
}

function categoryDesc(id: CategoryId, locale: Locale) {
  return (m as any)[`help_category_${id}_desc`]({}, { locale }) as string;
}

const CATEGORY_COLORS: Record<CategoryId, number> = {
  getting_started: COLORS_RAW.primary,
  feeds: COLORS_RAW.warning,
  mod: COLORS_RAW.danger,
  profile: COLORS_RAW.success,
  fun: COLORS_RAW.info,
};

const OPTION_TYPE_KEY: Record<number, string> = {
  [ApplicationCommandOptionType.Subcommand]: 'help_opt_subcommand',
  [ApplicationCommandOptionType.SubcommandGroup]: 'help_opt_group',
  [ApplicationCommandOptionType.String]: 'help_opt_string',
  [ApplicationCommandOptionType.Integer]: 'help_opt_integer',
  [ApplicationCommandOptionType.Boolean]: 'help_opt_boolean',
  [ApplicationCommandOptionType.User]: 'help_opt_user',
  [ApplicationCommandOptionType.Channel]: 'help_opt_channel',
  [ApplicationCommandOptionType.Role]: 'help_opt_role',
  [ApplicationCommandOptionType.Mentionable]: 'help_opt_mentionable',
  [ApplicationCommandOptionType.Number]: 'help_opt_number',
  [ApplicationCommandOptionType.Attachment]: 'help_opt_attachment',
};

function optionTypeLabel(type: number, locale: Locale) {
  const key = OPTION_TYPE_KEY[type] ?? 'help_opt_default';
  return (m as any)[key]({}, { locale }) as string;
}

let cachedCommands: SlashCommandDefinition[] | null = null;

async function getCommands(): Promise<SlashCommandDefinition[]> {
  if (!cachedCommands) {
    const { commands } = await import('../../commands.js');
    cachedCommands = commands.filter((c) => c.data && typeof c.data.name === 'string');
  }
  return cachedCommands;
}

function getCommandCategory(name: string): CategoryId {
  const adminAndMod = ['admin', 'sanction', 'dc', 'rescan', 'casier', 'absent', 'meeting', 'note', 'transcript', 'clear', 'channel', 'signal', 'demission', 'ticket'];
  const gettingStarted = ['setup', 'config', 'ping', 'info', 'dashboard', 'serverstats', 'stats', 'activate'];
  const feedAndNews = ['post', 'daily-algo', 'suggest', 'suggestion-config', 'event'];
  const profileAndRpg = ['profile', 'profil', 'leaderboard', 'invites', 'rank'];
  if (name.startsWith('rpg-')) return 'profile';
  if (gettingStarted.includes(name)) return 'getting_started';
  if (feedAndNews.includes(name)) return 'feeds';
  if (adminAndMod.includes(name)) return 'mod';
  if (profileAndRpg.includes(name)) return 'profile';
  return 'fun';
}

function trunc(str: string, max: number) {
  return str.length > max ? str.slice(0, max - 3) + '...' : str;
}

function formatPermissions(permBitfieldStr: string | null | undefined, locale: Locale) {
  const everyone = m.help_perm_everyone({}, { locale });
  if (!permBitfieldStr) return everyone;
  try {
    const bitfield = BigInt(permBitfieldStr);
    const perms = new PermissionsBitField(bitfield).toArray();
    return perms.length === 0 ? everyone : perms.map(p => `\`${p}\``).join(', ');
  } catch { return everyone; }
}

function buildCommandSyntax(command: CommandJson): string {
  const name = command.name;
  const options = command.options || [];
  if (options.length === 0) return `\`/${name}\``;

  const hasSubcommands = options.some(opt => opt.type === ApplicationCommandOptionType.Subcommand || opt.type === ApplicationCommandOptionType.SubcommandGroup);
  if (hasSubcommands) {
    const lines: string[] = [];
    for (const opt of options) {
      if (opt.type === ApplicationCommandOptionType.Subcommand) {
        const optStr = (opt.options || []).map(so => so.required ? `<${so.name}>` : `[${so.name}]`).join(' ');
        lines.push(`\`/${name} ${opt.name}${optStr ? ' ' + optStr : ''}\``);
      } else if (opt.type === ApplicationCommandOptionType.SubcommandGroup) {
        for (const sc of opt.options || []) {
          const optStr = (sc.options || []).map(so => so.required ? `<${so.name}>` : `[${so.name}]`).join(' ');
          lines.push(`\`/${name} ${opt.name} ${sc.name}${optStr ? ' ' + optStr : ''}\``);
        }
      }
    }
    return lines.join('\n');
  }

  const optStr = options.map(opt => opt.required ? `<${opt.name}>` : `[${opt.name}]`).join(' ');
  return `\`/${name} ${optStr}\``;
}

function formatCommandOptionsTree(command: CommandJson, locale: Locale): string {
  const options = command.options || [];
  if (options.length === 0) return m.help_opt_none({}, { locale });

  const required = m.help_required({}, { locale });
  const optional = m.help_optional({}, { locale });
  const noDesc = m.help_no_description({}, { locale });

  const lines: string[] = [];
  for (const opt of options) {
    if (opt.type === ApplicationCommandOptionType.Subcommand) {
      lines.push(`${E.arrow} **${m.help_opt_subcommand({}, { locale })}** \`${opt.name}\` — *${opt.description}*`);
      if (opt.options?.length) {
        for (const subOpt of opt.options) {
          lines.push(`  └ \`${subOpt.name}\` *(${optionTypeLabel(subOpt.type, locale)}, ${subOpt.required ? required : optional})* — ${subOpt.description}`);
        }
      }
    } else if (opt.type === ApplicationCommandOptionType.SubcommandGroup) {
      lines.push(`${E.arrow} **${m.help_opt_group({}, { locale })}** \`${opt.name}\` — *${opt.description}*`);
      if (opt.options?.length) {
        for (const subCmd of opt.options) {
          lines.push(`  ├ **${m.help_opt_subcommand({}, { locale })}** \`${subCmd.name}\` — *${subCmd.description}*`);
          if (subCmd.options?.length) {
            for (const subOpt of subCmd.options) {
              lines.push(`  │  └ \`${subOpt.name}\` *(${optionTypeLabel(subOpt.type, locale)}, ${subOpt.required ? required : optional})* — ${subOpt.description}`);
            }
          }
        }
      }
    } else {
      const typeLabel = optionTypeLabel(opt.type, locale);
      const reqLabel = opt.required ? required : optional;
      lines.push(`${E.arrow} \`${opt.name}\` *(${typeLabel}, ${reqLabel})*\n  └ ${opt.description || noDesc}`);
    }
  }
  return trunc(lines.join('\n'), 1800);
}

function buildHomeView(commands: SlashCommandDefinition[], locale: Locale) {
  const fields: ContainerChild[] = [
    m.help_home_welcome({}, { locale }),
    separator({ divider: true, spacing: 'small' }),
  ];

  for (const id of CATEGORY_IDS) {
    const catCmds = commands.filter(c => getCommandCategory(c.data.name) === id);
    fields.push(`${CATEGORY_META[id].emoji} **${categoryLabel(id, locale)}** (${catCmds.length})\n${categoryDesc(id, locale)}`);
  }

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('help_category_select')
    .setPlaceholder(m.help_select_category_placeholder({}, { locale }))
    .addOptions(CATEGORY_IDS.map(id => ({ label: categoryLabel(id, locale), value: `cat:${id}`, emoji: '📁' })));

  const row1 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
  const searchBtn = new ButtonBuilder().setCustomId('help_search').setLabel(m.help_btn_search({}, { locale })).setEmoji('🔍').setStyle(ButtonStyle.Success);
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(searchBtn);

  return v2Message(
    kotboContainer({
      color: 'primary',
      title: `${E.info} ${m.help_home_title({}, { locale })}`,
      fields,
      footerOverwrite: `-# ${E.kotbo} ${m.help_commands_available({ count: commands.length }, { locale })}`,
    }),
    row1,
    row2,
  );
}

function buildCategoryView(commands: SlashCommandDefinition[], categoryId: CategoryId, locale: Locale) {
  const id = CATEGORY_IDS.includes(categoryId) ? categoryId : CATEGORY_IDS[0];
  const catCmds = commands.filter(c => getCommandCategory(c.data.name) === id).sort((a, b) => a.data.name.localeCompare(b.data.name));
  const accentColor = CATEGORY_COLORS[id];

  const cmdList = catCmds.length > 0
    ? catCmds.map(c => `${E.arrow} \`/${c.data.name}\` — ${c.data.description}`).join('\n')
    : m.help_no_commands_in_category({}, { locale });

  const selectCategory = new StringSelectMenuBuilder()
    .setCustomId('help_category_select')
    .setPlaceholder(m.help_select_other_category_placeholder({}, { locale }))
    .addOptions(CATEGORY_IDS.map(c => ({ label: categoryLabel(c, locale), value: `cat:${c}`, emoji: '📁', default: c === id })));

  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectCategory)];

  if (catCmds.length > 0) {
    const selectCommand = new StringSelectMenuBuilder()
      .setCustomId('help_command_select')
      .setPlaceholder(m.help_select_command_placeholder({}, { locale }))
      .addOptions(catCmds.slice(0, 25).map(c => ({ label: `/${c.data.name}`, value: `cmd:${c.data.name}`, description: trunc(c.data.description || '', 100) })));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectCommand));
  }

  const homeBtn = new ButtonBuilder().setCustomId('help_home').setLabel('Accueil').setEmoji('🏠').setStyle(ButtonStyle.Primary);
  const searchBtn = new ButtonBuilder().setCustomId('help_search').setLabel('Rechercher').setEmoji('🔍').setStyle(ButtonStyle.Success);
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(homeBtn, searchBtn));

  return v2Message(
    kotboContainer({
      color: accentColor,
      title: `${CATEGORY_META[id].emoji} ${categoryLabel(id, locale)}`,
      fields: [
        `*${categoryDesc(id, locale)}*`,
        separator({ divider: true, spacing: 'small' }),
        cmdList,
      ],
      footerOverwrite: `-# ${m.help_commands_in_category({ count: catCmds.length }, { locale })}`,
    }),
    ...rows,
  );
}

function buildCommandView(commands: SlashCommandDefinition[], commandName: string, locale: Locale) {
  const command = commands.find(c => c.data.name.toLowerCase() === commandName.toLowerCase());
  if (!command) return buildHomeView(commands, locale);

  const category = getCommandCategory(command.data.name);
  const accentColor = CATEGORY_COLORS[category];

  const commandJson = (command.data.toJSON ? command.data.toJSON() : command.data) as CommandJson;
  const syntax = buildCommandSyntax(commandJson);
  const optionsTree = formatCommandOptionsTree(commandJson, locale);
  const permissions = formatPermissions(commandJson.default_member_permissions, locale);

  const catCmds = commands.filter(c => getCommandCategory(c.data.name) === category).sort((a, b) => a.data.name.localeCompare(b.data.name));
  const currentIndex = catCmds.findIndex(c => c.data.name === command.data.name);
  const prevCmd = catCmds[(currentIndex - 1 + catCmds.length) % catCmds.length];
  const nextCmd = catCmds[(currentIndex + 1) % catCmds.length];

  const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [];

  const selectCategory = new StringSelectMenuBuilder()
    .setCustomId('help_category_select')
    .setPlaceholder(m.help_select_other_category_placeholder({}, { locale }))
    .addOptions(CATEGORY_IDS.map(c => ({ label: categoryLabel(c, locale), value: `cat:${c}`, emoji: '📁', default: c === category })));
  rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectCategory));

  const selectCommand = new StringSelectMenuBuilder()
    .setCustomId('help_command_select')
    .setPlaceholder(m.help_select_other_command_placeholder({}, { locale }))
    .addOptions(catCmds.slice(0, 25).map(c => ({ label: `/${c.data.name}`, value: `cmd:${c.data.name}`, description: trunc(c.data.description || '', 100), default: c.data.name === command.data.name })));
  rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectCommand));

  const prevBtn = new ButtonBuilder().setCustomId(`help_prev:${category}:${prevCmd.data.name}`).setEmoji('◀️').setLabel(`/${prevCmd.data.name}`).setStyle(ButtonStyle.Secondary);
  const homeBtn = new ButtonBuilder().setCustomId('help_home').setLabel(m.help_btn_home({}, { locale })).setEmoji('🏠').setStyle(ButtonStyle.Primary);
  const searchBtn = new ButtonBuilder().setCustomId('help_search').setLabel(m.help_btn_search({}, { locale })).setEmoji('🔍').setStyle(ButtonStyle.Success);
  const nextBtn = new ButtonBuilder().setCustomId(`help_next:${category}:${nextCmd.data.name}`).setEmoji('▶️').setLabel(`/${nextCmd.data.name}`).setStyle(ButtonStyle.Secondary);
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(prevBtn, homeBtn, searchBtn, nextBtn));

  return v2Message(
    kotboContainer({
      color: accentColor,
      title: `${CATEGORY_META[category].emoji} /${command.data.name}`,
      fields: [
        command.data.description || m.help_no_description({}, { locale }),
        separator({ divider: true, spacing: 'small' }),
        [
          `**${E.arrow} ${m.help_label_category({}, { locale })}** · ${categoryLabel(category, locale)}`,
          `**${E.lock} ${m.help_label_permissions({}, { locale })}** · ${permissions}`,
        ].join('\n'),
        `**${E.info} ${m.help_label_syntax({}, { locale })}**\n${syntax}`,
        `**${E.settings} ${m.help_label_options({}, { locale })}**\n${optionsTree}`,
      ],
      footerOverwrite: `-# ${m.help_footer_detail({}, { locale })}`,
    }),
    ...rows,
  );
}

function buildHelpView(commands: SlashCommandDefinition[], state: string, locale: Locale) {
  if (state === 'home') return buildHomeView(commands, locale);
  if (state.startsWith('cat:')) return buildCategoryView(commands, state.slice(4) as CategoryId, locale);
  if (state.startsWith('cmd:')) return buildCommandView(commands, state.slice(4), locale);
  return buildHomeView(commands, locale);
}

export async function handleHelpInteraction(
  interaction: ButtonInteraction | AnySelectMenuInteraction | ModalSubmitInteraction,
) {
  const commands = await getCommands();
  const customId = interaction.customId;
  const locale = await getEffectiveLocale(interaction);

  if (interaction.isButton()) {
    if (customId === 'help_home') {
      await interaction.update(buildHelpView(commands, 'home', locale));
      return;
    }
    if (customId === 'help_search') {
      const modal = new ModalBuilder().setCustomId('help_search_modal').setTitle(m.help_search_modal_title({}, { locale }));
      const input = new TextInputBuilder()
        .setCustomId('command_name')
        .setLabel(m.help_search_input_label({}, { locale }))
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(m.help_search_input_placeholder({}, { locale }))
        .setRequired(true)
        .setMaxLength(32);
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
      await interaction.showModal(modal);
      return;
    }
    if (customId.startsWith('help_prev:') || customId.startsWith('help_next:')) {
      const [, , commandName] = customId.split(':');
      await interaction.update(buildHelpView(commands, `cmd:${commandName}`, locale));
      return;
    }
  }

  if (interaction.isAnySelectMenu()) {
    if (customId === 'help_category_select' || customId === 'help_command_select') {
      await interaction.update(buildHelpView(commands, interaction.values[0], locale));
      return;
    }
  }

  if (interaction.isModalSubmit() && customId === 'help_search_modal') {
    const searchName = interaction.fields.getTextInputValue('command_name').trim().toLowerCase();
    const found = commands.find(c => c.data.name.toLowerCase() === searchName) ||
                  commands.find(c => c.data.name.toLowerCase().includes(searchName)) ||
                  commands.find(c => searchName.includes(c.data.name.toLowerCase()));

    if (found) {
      await interaction.update(buildHelpView(commands, `cmd:${found.data.name}`, locale));
    } else {
      await interaction.reply({
        content: `${E.error} ${m.help_command_not_found({ name: searchName }, { locale })}`,
        flags: [MessageFlags.Ephemeral],
      });
    }
  }
}

const meta = getCommandMetadata('help');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addStringOption(o =>
    o.setName('cmd')
      .setDescription(m.help_option_cmd_description({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.help_option_cmd_description({}, { locale: 'fr' }) })
      .setAutocomplete(true),
  );

async function autocomplete(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const commands = await getCommands();
  const choices = commands.map(cmd => cmd.data.name).filter(name => name.toLowerCase().includes(focused)).slice(0, 25).map(name => ({ name: `/${name}`, value: name }));
  await interaction.respond(choices);
}

async function execute(interaction: ChatInputCommandInteraction) {
  const requestedCmd = interaction.options.getString('cmd', false)?.trim().toLowerCase();
  const commands = await getCommands();
  const locale = await getEffectiveLocale(interaction);

  let state = 'home';
  if (requestedCmd) {
    const found = commands.find(cmd => cmd.data.name.toLowerCase() === requestedCmd);
    if (found) {
      state = `cmd:${found.data.name}`;
    } else {
      await interaction.reply({ content: `${E.error} ${m.help_command_unknown({ name: requestedCmd }, { locale })}`, flags: [MessageFlags.Ephemeral] });
      state = 'home';
    }
  }

  const view = buildHelpView(commands, state, locale);
  if (interaction.replied) {
    await interaction.followUp({ ...view, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
  } else {
    await interaction.reply({ ...view, flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral });
  }
}

export const helpCommand = { data, execute, autocomplete } satisfies SlashCommandDefinition;
