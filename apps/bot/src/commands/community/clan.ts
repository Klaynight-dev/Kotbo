import {
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ActionRowBuilder,
} from 'discord.js';
import type { SlashCommandDefinition } from '../../commands.js';
import prisma from '../../utils/db.js';
import { runDistribution, runClear } from '../../services/community/clanService.js';
import { E, rankEmoji } from '../../utils/emojis.js';
import { COLORS_RAW } from '../../utils/embeds.js';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('c4_clan');

export const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription(m.c4_clan_list_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c4_clan_list_desc({}, { locale: 'fr' }) })
  )
  .addSubcommand((sub) =>
    sub
      .setName('leaderboard')
      .setDescription(m.c4_clan_leaderboard_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c4_clan_leaderboard_desc({}, { locale: 'fr' }) })
  )
  .addSubcommand((sub) =>
    sub
      .setName('info')
      .setDescription(m.c4_clan_info_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c4_clan_info_desc({}, { locale: 'fr' }) })
      .addStringOption((opt) =>
        opt
          .setName('nom')
          .setDescription(m.c4_clan_opt_nom({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c4_clan_opt_nom({}, { locale: 'fr' }) })
          .setRequired(true)
          .setAutocomplete(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('historique')
      .setDescription(m.c4_clan_historique_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c4_clan_historique_desc({}, { locale: 'fr' }) })
      .addIntegerOption((opt) =>
        opt
          .setName('saison')
          .setDescription(m.c4_clan_opt_saison({}, { locale: 'en' }))
          .setDescriptionLocalizations({ fr: m.c4_clan_opt_saison({}, { locale: 'fr' }) })
          .setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('distribute')
      .setDescription(m.c4_clan_distribute_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c4_clan_distribute_desc({}, { locale: 'fr' }) })
  )
  .addSubcommand((sub) =>
    sub
      .setName('clear')
      .setDescription(m.c4_clan_clear_desc({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.c4_clan_clear_desc({}, { locale: 'fr' }) })
  ) as any;

export async function autocomplete(interaction: AutocompleteInteraction) {
    const guildId = interaction.guildId;
    if (!guildId) return;

    const focusedValue = interaction.options.getFocused();
    const clans = await prisma.clan.findMany({
      where: {
        guildId,
        name: { contains: focusedValue, mode: 'insensitive' },
      },
      take: 25,
      select: { name: true },
    });

    await interaction.respond(
      clans.map((c) => ({ name: c.name, value: c.name }))
    );
  }

export async function execute(interaction: ChatInputCommandInteraction) {
    const guildId = interaction.guildId;
    const locale = await getEffectiveLocale(interaction);

    if (!guildId) {
      await interaction.reply({
        content: m.c4_clan_guild_only({}, { locale }),
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    const sub = interaction.options.getSubcommand();

    // Charger la configuration générale des clans pour la guilde
    const guildConfig = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { clansEnabled: true, currentClanSeason: true },
    });

    if (!guildConfig?.clansEnabled) {
      await interaction.reply({
        content: m.c4_clan_module_disabled({}, { locale }),
        flags: [MessageFlags.Ephemeral],
      });
      return;
    }

    // ── SUBCOMMAND: list ──────────────────────────────────────────────────────
    if (sub === 'list') {
      await interaction.deferReply();

      const clans = await prisma.clan.findMany({
        where: { guildId },
        orderBy: { name: 'asc' },
      });

      if (clans.length === 0) {
        await interaction.editReply(m.c4_clan_list_empty({}, { locale }));
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(COLORS_RAW.primary)
        .setTitle(m.c4_clan_list_title({ guild: interaction.guild?.name ?? '' }, { locale }))
        .setDescription(m.c4_clan_list_desc_hint({}, { locale }))
        .setTimestamp();

      for (const clan of clans) {
        const role = interaction.guild?.roles.cache.get(clan.roleId);
        const memberCount = role?.members.size ?? 0;
        embed.addFields({
          name: m.c4_clan_list_field_name({ name: clan.name, count: memberCount }, { locale }),
          value: clan.description || m.c4_clan_no_description({}, { locale }),
          inline: false,
        });
      }

      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── SUBCOMMAND: leaderboard ────────────────────────────────────────────────
    if (sub === 'leaderboard') {
      await interaction.deferReply();

      const clans = await prisma.clan.findMany({ where: { guildId } });

      if (clans.length === 0) {
        await interaction.editReply(m.c4_clan_list_empty({}, { locale }));
        return;
      }

      // Récupérer la somme des contributions pour la saison active
      const contributions = await prisma.clanMemberContribution.groupBy({
        by: ['clanId'],
        where: {
          guildId,
          season: guildConfig.currentClanSeason,
        },
        _sum: { xp: true },
      });

      const contributionsMap = new Map(contributions.map((c) => [c.clanId, c._sum.xp ?? 0]));

      // Assigner et trier
      const rankedClans = clans
        .map((clan) => {
          const role = interaction.guild?.roles.cache.get(clan.roleId);
          const memberCount = role?.members.size ?? 0;
          const xp = contributionsMap.get(clan.id) ?? 0;
          return { name: clan.name, memberCount, xp };
        })
        .sort((a, b) => b.xp - a.xp);

      const embed = new EmbedBuilder()
        .setColor(COLORS_RAW.warning)
        .setTitle(m.c4_clan_leaderboard_title({ season: guildConfig.currentClanSeason }, { locale }))
        .setTimestamp();

      let desc = '';
      for (let i = 0; i < rankedClans.length; i++) {
        const c = rankedClans[i];
        desc += `\n${rankEmoji(i + 1)} **${c.name}**\n` + m.c4_clan_leaderboard_line({ xp: c.xp.toLocaleString('fr-FR'), count: c.memberCount }, { locale }) + '\n';
      }

      embed.setDescription(desc || m.c4_clan_leaderboard_none({}, { locale }));
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    // ── SUBCOMMAND: info ──────────────────────────────────────────────────────
    if (sub === 'info') {
      await interaction.deferReply();
      const nom = interaction.options.getString('nom', true);

      const clan = await prisma.clan.findFirst({
        where: { guildId, name: { equals: nom, mode: 'insensitive' } },
      });

      if (!clan) {
        await interaction.editReply(m.c4_clan_info_not_found({ name: nom }, { locale }));
        return;
      }

      const role = interaction.guild?.roles.cache.get(clan.roleId);
      const memberCount = role?.members.size ?? 0;

      // Calculer l'XP totale cumulée pour la saison active
      const aggregate = await prisma.clanMemberContribution.aggregate({
        where: {
          guildId,
          clanId: clan.id,
          season: guildConfig.currentClanSeason,
        },
        _sum: { xp: true },
      });
      const totalXp = aggregate._sum.xp ?? 0;

      // Top 10 contributeurs du clan pour la saison active
      const topContributions = await prisma.clanMemberContribution.findMany({
        where: {
          guildId,
          clanId: clan.id,
          season: guildConfig.currentClanSeason,
        },
        orderBy: { xp: 'desc' },
        take: 10,
      });

      const embed = new EmbedBuilder()
        .setColor(role?.color ?? COLORS_RAW.primary)
        .setTitle(m.c4_clan_info_title({ name: clan.name }, { locale }))
        .setDescription(clan.description || m.c4_clan_no_description({}, { locale }))
        .addFields(
          { name: m.c4_clan_info_field_role({}, { locale }), value: role ? `@${role.name}` : `ID: ${clan.roleId}`, inline: true },
          { name: m.c4_clan_info_field_members({}, { locale }), value: `\`${memberCount}\``, inline: true },
          { name: m.c4_clan_info_field_xp({}, { locale }), value: `\`${totalXp.toLocaleString('fr-FR')} XP\``, inline: true }
        )
        .setTimestamp();

      let contributorsList = '';
      for (let i = 0; i < topContributions.length; i++) {
        const contrib = topContributions[i];
        const member = await interaction.guild?.members.fetch(contrib.userId).catch(() => null);
        const name = member ? member.displayName : m.c4_clan_unknown_user({ id: contrib.userId }, { locale });
        contributorsList += `${rankEmoji(i + 1)} **${name}** : \`${contrib.xp.toLocaleString('fr-FR')} XP\`\n`;
      }

      embed.addFields({
        name: m.c4_clan_info_top_contributors({}, { locale }),
        value: contributorsList || m.c4_clan_info_no_contributions({}, { locale }),
        inline: false,
      });

      await interaction.editReply({ embeds: [embed] });
    }

    // ── SUBCOMMAND: historique ────────────────────────────────────────────────
    if (sub === 'historique') {
      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

      const guildSettings = await prisma.guild.findUnique({
        where: { id: guildId },
        select: { currentClanSeason: true }
      });

      const currentSeason = guildSettings?.currentClanSeason ?? 1;
      if (currentSeason <= 1) {
        await interaction.editReply(m.c4_clan_historique_none({}, { locale }));
        return;
      }

      const inputSeason = interaction.options.getInteger('saison');
      const targetSeason = inputSeason !== null ? inputSeason : (currentSeason - 1);

      if (targetSeason < 1 || targetSeason >= currentSeason) {
        await interaction.editReply(m.c4_clan_historique_invalid({ max: currentSeason - 1 }, { locale }));
        return;
      }

      const embed = await renderSeasonHistoryEmbed(guildId, targetSeason, interaction.guild!, locale);

      await interaction.editReply({
        embeds: [embed]
      });
      return;
    }

    // ── SUBCOMMAND: distribute (Admin Only) ───────────────────────────────────
    if (sub === 'distribute') {
      const isExecutorAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
      if (!isExecutorAdmin) {
        await interaction.reply({
          content: m.c4_clan_admin_required({}, { locale }),
          flags: [MessageFlags.Ephemeral],
        });
        return;
      }

      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

      try {
        const initiator = `${interaction.user.username} (${interaction.user.id})`;
        const message = await runDistribution(guildId, interaction.client, initiator);
        await interaction.editReply(message);
      } catch (err: any) {
        await interaction.editReply(m.c4_clan_error({ message: err.message }, { locale }));
      }
      return;
    }

    // ── SUBCOMMAND: clear (Admin Only) ────────────────────────────────────────
    if (sub === 'clear') {
      const isExecutorAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
      if (!isExecutorAdmin) {
        await interaction.reply({
          content: m.c4_clan_admin_required({}, { locale }),
          flags: [MessageFlags.Ephemeral],
        });
        return;
      }

      await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

      try {
        const initiator = `${interaction.user.username} (${interaction.user.id})`;
        const message = await runClear(guildId, interaction.client, initiator);
        await interaction.editReply(message);
      } catch (err: any) {
        await interaction.editReply(m.c4_clan_error({ message: err.message }, { locale }));
      }
      return;
    }
}

export const clanCommand = { data, autocomplete, execute } satisfies SlashCommandDefinition;

// ── HELPER: Rendu de l'historique d'une saison ────────────────────────────────
export async function renderSeasonHistoryEmbed(guildId: string, season: number, discordGuild: any, locale: 'fr' | 'en' = 'fr') {
  // 1. Récupérer les clans
  const clans = await prisma.clan.findMany({ where: { guildId } });

  // 2. Calculer l'XP totale par clan pour cette saison
  const clansWithXp = await Promise.all(
    clans.map(async (clan) => {
      const aggregate = await prisma.clanMemberContribution.aggregate({
        where: { guildId, clanId: clan.id, season },
        _sum: { xp: true },
      });
      const totalXp = aggregate._sum.xp ?? 0;
      return { clan, totalXp };
    })
  );

  // Trier les clans par XP décroissante
  clansWithXp.sort((a, b) => b.totalXp - a.totalXp);

  // Trouver le vainqueur (XP > 0)
  let winningClan = null;
  if (clansWithXp.length > 0 && clansWithXp[0].totalXp > 0) {
    winningClan = clansWithXp[0].clan;
  }

  // 3. Trouver le meilleur contributeur pour chaque clan
  const leaders: { clanName: string; userName: string; xp: number }[] = [];
  for (const clan of clans) {
    const top = await prisma.clanMemberContribution.findFirst({
      where: { guildId, clanId: clan.id, season, userId: { not: 'system_manual_points' } },
      orderBy: { xp: 'desc' },
    });
    if (top) {
      const member = await discordGuild.members.fetch(top.userId).catch(() => null);
      const name = member ? member.displayName : m.c4_clan_unknown_user({ id: top.userId }, { locale });
      leaders.push({ clanName: clan.name, userName: name, xp: top.xp });
    }
  }

  const embed = new EmbedBuilder()
    .setColor(0xF59E0B) // Amber/Gold color
    .setTitle(m.c4_clan_history_title({ season }, { locale }))
    .setTimestamp();

  let desc = '';
  if (winningClan) {
    desc += m.c4_clan_history_winner({ name: winningClan.name, xp: clansWithXp[0].totalXp.toLocaleString('fr-FR') }, { locale }) + '\n\n';
  } else {
    desc += m.c4_clan_history_no_winner({}, { locale }) + '\n\n';
  }

  // Classement des clans
  desc += m.c4_clan_history_ranking_title({}, { locale }) + '\n';
  if (clansWithXp.length > 0 && clansWithXp.some(c => c.totalXp > 0)) {
    for (let i = 0; i < clansWithXp.length; i++) {
      const c = clansWithXp[i];
      desc += `${rankEmoji(i + 1)} **${c.clan.name}** : \`${c.totalXp.toLocaleString('fr-FR')} XP\`\n`;
    }
  } else {
    desc += m.c4_clan_history_no_points({}, { locale }) + '\n';
  }

  desc += '\n' + m.c4_clan_history_top_contributors_title({}, { locale }) + '\n';
  if (leaders.length > 0) {
    for (const leader of leaders) {
      desc += m.c4_clan_history_contributor_line({ clan: leader.clanName, user: leader.userName, xp: leader.xp.toLocaleString('fr-FR') }, { locale }) + '\n';
    }
  } else {
    desc += m.c4_clan_history_no_contributors({}, { locale });
  }

  embed.setDescription(desc);
  return embed;
}
