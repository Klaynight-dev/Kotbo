import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { errorEmbed, COLORS, baseEmbed } from '../../utils/embeds.js';
import prisma from '../../utils/db.js';
import fs from 'fs/promises';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const packagePath = new URL('../../package.json', import.meta.url);

const meta = getCommandMetadata('c6_info');

async function getVersion() {
  try {
    const raw = await fs.readFile(packagePath, 'utf8');
    const pkg = JSON.parse(raw);
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function formatUptime(totalSeconds: number): string {
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}j`);
  parts.push(`${hours}h`, `${minutes}m`, `${seconds}s`);
  return parts.join(' ');
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

function boolChip(enabled: boolean, locale: 'fr' | 'en'): string {
  return enabled ? m.c6_bool_enabled({}, { locale }) : m.c6_bool_disabled({}, { locale });
}

function channelRef(channelId: string | null | undefined, locale: 'fr' | 'en'): string {
  return channelId ? `<#${channelId}>` : m.c6_info_not_set({}, { locale });
}

function truncate(value: string, max = 120): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations);

async function execute(interaction: ChatInputCommandInteraction) {
  const locale = await getEffectiveLocale(interaction);
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      embeds: [errorEmbed(m.c6_info_no_guild_title({}, { locale }), m.c6_info_no_guild_desc({}, { locale }))],
      flags: [MessageFlags.Ephemeral]
    });
    return;
  }

  const [
    guild,
    version,
    dailyAlgoRuns,
    dailyAlgoSubmissions,
  ] = await Promise.all([
    prisma.guild.findUnique({ where: { id: guildId } }),
    getVersion(),
    prisma.dailyAlgoRun.count({ where: { guildId } }),
    prisma.dailyAlgoSubmission.count({ where: { run: { guildId } } }),
  ]);

  const uptime = process.uptime();
  const memory = process.memoryUsage();

  const guildCreated = interaction.guild?.createdTimestamp
    ? `<t:${Math.floor(interaction.guild.createdTimestamp / 1000)}:R>`
    : m.c6_info_unknown({}, { locale });

  const reposPreview = guild?.githubRepositories?.length
    ? truncate(guild.githubRepositories.slice(0, 3).join(' • '), 140)
    : m.c6_info_no_repos({}, { locale });

  const embed = baseEmbed(COLORS.info, { user: interaction.user })
    .setTitle(m.c6_info_title({}, { locale }))
    .setDescription(m.c6_info_desc({}, { locale }))
    .setThumbnail(interaction.client.user?.displayAvatarURL() ?? null)
    .addFields(
      {
        name: m.c6_info_field_runtime_title({}, { locale }),
        value: m.c6_info_field_runtime_body({
          version,
          node: process.version,
          uptime: formatUptime(uptime),
          ping: interaction.client.ws.ping,
          heapUsed: formatMb(memory.heapUsed),
          heapTotal: formatMb(memory.heapTotal),
          platform: process.platform,
        }, { locale }),
        inline: true,
      },
      {
        name: m.c6_info_field_server_title({}, { locale }),
        value: m.c6_info_field_server_body({
          name: interaction.guild?.name ?? m.c6_info_unknown({}, { locale }),
          created: guildCreated,
          memberCount: interaction.guild?.memberCount ?? 0,
          guildCount: interaction.client.guilds.cache.size,
          userCount: interaction.client.users.cache.size,
        }, { locale }),
        inline: true,
      },
      {
        name: m.c6_info_field_modules_title({}, { locale }),
        value: m.c6_info_field_modules_body({
          translation: boolChip(guild?.translationEnabled ?? false, locale),
          translateTo: guild?.defaultTranslateTo ?? 'FR',
          codePolice: boolChip(guild?.codePoliceEnabled ?? false, locale),
          dailyAlgo: boolChip(guild?.dailyAlgoEnabled ?? false, locale),
          githubReleases: boolChip(guild?.githubReleasesEnabled ?? false, locale),
        }, { locale }),
        inline: false,
      },
      {
        name: m.c6_info_field_metrics_title({}, { locale }),
        value: m.c6_info_field_metrics_body({
          runs: dailyAlgoRuns,
          submissions: dailyAlgoSubmissions,
        }, { locale }),
        inline: true,
      },
      {
        name: m.c6_info_field_channels_title({}, { locale }),
        value: m.c6_info_field_channels_body({
          dailyAlgo: channelRef(guild?.dailyAlgoChannelId, locale),
          dailyAlgoValidation: channelRef(guild?.dailyAlgoValidationChannelId, locale),
          statusCheck: channelRef(guild?.statusCheckChannelId, locale),
        }, { locale }),
        inline: true,
      },
      {
        name: m.c6_info_field_github_title({}, { locale }),
        value: m.c6_info_field_github_body({
          channel: channelRef(guild?.githubReleasesChannelId, locale),
          repoCount: guild?.githubRepositories?.length ?? 0,
          preview: reposPreview,
        }, { locale }),
        inline: false,
      }
    )
    .setFooter({ text: m.c6_info_footer({}, { locale }), iconURL: interaction.guild?.iconURL() ?? undefined })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
}

export const infoCommand = { data, execute } satisfies SlashCommandDefinition;
