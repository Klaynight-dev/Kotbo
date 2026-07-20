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

export const data = new SlashCommandBuilder()
  .setName('clan')
  .setDescription('🛡️ Gestion et classements des clans du serveur')
  .addSubcommand((sub) =>
    sub
      .setName('list')
      .setDescription('📋 Liste tous les clans configurés sur le serveur')
  )
  .addSubcommand((sub) =>
    sub
      .setName('leaderboard')
      .setDescription('🏆 Affiche le classement des clans pour la saison active')
  )
  .addSubcommand((sub) =>
    sub
      .setName('info')
      .setDescription('ℹ️ Affiche les informations et le classement des membres d\'un clan')
      .addStringOption((opt) =>
        opt
          .setName('nom')
          .setDescription('Le nom du clan')
          .setRequired(true)
          .setAutocomplete(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName('historique')
      .setDescription('📜 Affiche l\'historique des saisons passées')
  )
  .addSubcommand((sub) =>
    sub
      .setName('distribute')
      .setDescription('🎲 (Admin) Répartit aléatoirement les membres sans clan')
  )
  .addSubcommand((sub) =>
    sub
      .setName('clear')
      .setDescription('🧹 (Admin) Retire tous les rôles de clan du serveur')
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
    if (!guildId) {
      await interaction.reply({
        content: '❌ Cette commande doit être exécutée sur un serveur.',
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
        content: '❌ Le module de clans est actuellement désactivé sur ce serveur.',
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
        await interaction.editReply('Aucun clan n\'est configuré sur ce serveur.');
        return;
      }

      const embed = new EmbedBuilder()
        .setColor(COLORS_RAW.primary)
        .setTitle(`🛡️ Clans de ${interaction.guild?.name}`)
        .setDescription('Voici la liste des clans disponibles. Utilisez `/clan info <nom>` pour voir leurs détails.')
        .setTimestamp();

      for (const clan of clans) {
        const role = interaction.guild?.roles.cache.get(clan.roleId);
        const memberCount = role?.members.size ?? 0;
        embed.addFields({
          name: `• ${clan.name} (${memberCount} membres)`,
          value: clan.description || '*Aucune description.*',
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
        await interaction.editReply('Aucun clan n\'est configuré sur ce serveur.');
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
        .setTitle(`🏆 Classement des Clans — Saison ${guildConfig.currentClanSeason}`)
        .setTimestamp();

      let desc = '';
      for (let i = 0; i < rankedClans.length; i++) {
        const c = rankedClans[i];
        desc += `\n${rankEmoji(i + 1)} **${c.name}**\n▸ Contribution : \`${c.xp.toLocaleString('fr-FR')} XP\` · Membres : \`${c.memberCount}\`\n`;
      }

      embed.setDescription(desc || '*Aucune contribution enregistrée pour le moment.*');
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
        await interaction.editReply(`❌ Le clan "${nom}" n'existe pas.`);
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
        .setTitle(`🛡️ Clan ${clan.name}`)
        .setDescription(clan.description || '*Aucune description.*')
        .addFields(
          { name: 'Rôle Discord', value: role ? `@${role.name}` : `ID: ${clan.roleId}`, inline: true },
          { name: 'Membres actifs', value: `\`${memberCount}\``, inline: true },
          { name: 'XP de Saison', value: `\`${totalXp.toLocaleString('fr-FR')} XP\``, inline: true }
        )
        .setTimestamp();

      let contributorsList = '';
      for (let i = 0; i < topContributions.length; i++) {
        const contrib = topContributions[i];
        const member = await interaction.guild?.members.fetch(contrib.userId).catch(() => null);
        const name = member ? member.displayName : `Utilisateur ${contrib.userId}`;
        contributorsList += `${rankEmoji(i + 1)} **${name}** : \`${contrib.xp.toLocaleString('fr-FR')} XP\`\n`;
      }

      embed.addFields({
        name: '🏆 Top Contributeurs de Saison',
        value: contributorsList || '*Aucune contribution pour le moment.*',
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
        await interaction.editReply('❌ Aucun historique de saison n\'est disponible pour le moment. La Saison 1 est toujours en cours !');
        return;
      }

      const targetSeason = currentSeason - 1;
      const embed = await renderSeasonHistoryEmbed(guildId, targetSeason, interaction.guild!);
      const selectRow = buildSeasonHistorySelect(guildId, currentSeason, targetSeason);

      await interaction.editReply({
        embeds: [embed],
        components: [selectRow]
      });
      return;
    }

    // ── SUBCOMMAND: distribute (Admin Only) ───────────────────────────────────
    if (sub === 'distribute') {
      const isExecutorAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
      if (!isExecutorAdmin) {
        await interaction.reply({
          content: '❌ Vous devez disposer de la permission "Gérer le serveur" pour exécuter cette commande.',
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
        await interaction.editReply(`❌ Erreur : ${err.message}`);
      }
      return;
    }

    // ── SUBCOMMAND: clear (Admin Only) ────────────────────────────────────────
    if (sub === 'clear') {
      const isExecutorAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
      if (!isExecutorAdmin) {
        await interaction.reply({
          content: '❌ Vous devez disposer de la permission "Gérer le serveur" pour exécuter cette commande.',
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
        await interaction.editReply(`❌ Erreur : ${err.message}`);
      }
      return;
    }
}

export const clanCommand = { data, autocomplete, execute } satisfies SlashCommandDefinition;

// ── HELPER: Rendu de l'historique d'une saison ────────────────────────────────
export async function renderSeasonHistoryEmbed(guildId: string, season: number, discordGuild: any) {
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
      const name = member ? member.displayName : `Utilisateur ${top.userId}`;
      leaders.push({ clanName: clan.name, userName: name, xp: top.xp });
    }
  }

  const embed = new EmbedBuilder()
    .setColor(0xF59E0B) // Amber/Gold color
    .setTitle(`📜 Historique de la Saison de Clans ${season}`)
    .setTimestamp();

  let desc = '';
  if (winningClan) {
    desc += `🏆 **Clan Vainqueur** : **${winningClan.name}** (\`${clansWithXp[0].totalXp.toLocaleString('fr-FR')} XP\`)\n\n`;
  } else {
    desc += `🏆 **Clan Vainqueur** : *Aucun vainqueur* (aucun point marqué)\n\n`;
  }

  // Classement des clans
  desc += `**📊 Classement des Clans :**\n`;
  if (clansWithXp.length > 0 && clansWithXp.some(c => c.totalXp > 0)) {
    for (let i = 0; i < clansWithXp.length; i++) {
      const c = clansWithXp[i];
      desc += `${rankEmoji(i + 1)} **${c.clan.name}** : \`${c.totalXp.toLocaleString('fr-FR')} XP\`\n`;
    }
  } else {
    desc += `*Aucun point enregistré.*\n`;
  }

  desc += `\n**👑 Meilleurs Contributeurs par Clan :**\n`;
  if (leaders.length > 0) {
    for (const leader of leaders) {
      desc += `▸ **${leader.clanName}** : **${leader.userName}** (\`${leader.xp.toLocaleString('fr-FR')} XP\`)\n`;
    }
  } else {
    desc += `*Aucun contributeur.*`;
  }

  embed.setDescription(desc);
  return embed;
}

// ── HELPER: Génération du menu déroulant ──────────────────────────────────────
export function buildSeasonHistorySelect(guildId: string, currentSeason: number, selectedSeason: number) {
  const select = new StringSelectMenuBuilder()
    .setCustomId(`clan_history_select:${guildId}`)
    .setPlaceholder('Sélectionnez une saison à consulter...');

  const maxSeason = currentSeason - 1;
  const options = [];
  const startSeason = Math.max(1, maxSeason - 24); // 25 options max pour Discord SelectMenu

  for (let s = maxSeason; s >= startSeason; s--) {
    const isDefault = s === selectedSeason;
    options.push(
      new StringSelectMenuOptionBuilder()
        .setLabel(`Saison ${s}`)
        .setValue(s.toString())
        .setDescription(`Consulter les résultats de la Saison ${s}`)
        .setDefault(isDefault)
    );
  }

  select.addOptions(options);

  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

// ── INTERACTION HANDLER: Changement de saison dans le menu déroulant ──────────
export async function handleClanHistoryInteraction(interaction: any, selectedSeason: number) {
  const guildId = interaction.guildId;
  if (!guildId) return;

  const guildSettings = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { currentClanSeason: true }
  });

  const currentSeason = guildSettings?.currentClanSeason ?? 1;
  const embed = await renderSeasonHistoryEmbed(guildId, selectedSeason, interaction.guild!);
  const selectRow = buildSeasonHistorySelect(guildId, currentSeason, selectedSeason);

  await interaction.update({
    embeds: [embed],
    components: [selectRow]
  });
}
