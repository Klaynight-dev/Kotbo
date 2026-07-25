import {
  SlashCommandBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { errorContainer, kotboContainer } from '../../utils/embeds.js';
import { E, rankEmoji } from '../../utils/emojis.js';
import { giveRep, getReputation, getReputationLeaderboard, REP_DAILY_VOTE_LIMIT } from '../../services/community/reputationService.js';
import { incrementQuestProgress } from '../../services/community/questService.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { separator, v2Message } from '@arcscord/components'
import { getEffectiveLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const data = new SlashCommandBuilder()
  .setName('rep')
  .setDescription('Système de réputation communautaire')
  .addSubcommand((sub) =>
    sub.setName('give')
      .setDescription('Donner un +rep à un membre')
      .addUserOption((opt) => opt.setName('membre').setDescription('Le membre à récompenser').setRequired(true))
      .addStringOption((opt) => opt.setName('raison').setDescription('Raison du +rep')))
  .addSubcommand((sub) =>
    sub.setName('check')
      .setDescription('Voir la réputation d\'un membre')
      .addUserOption((opt) => opt.setName('membre').setDescription('Le membre à consulter')))
  .addSubcommand((sub) =>
    sub.setName('top')
      .setDescription('Classement des réputations'));

async function execute(interaction: ChatInputCommandInteraction) {
  const subcommand = interaction.options.getSubcommand();
  const guildId = interaction.guildId!;
  const locale = await getEffectiveLocale(interaction);

  if (subcommand === 'give') {
    const target = interaction.options.getUser('membre', true);
    const reason = interaction.options.getString('raison') ?? undefined;

    const result = await giveRep(guildId, interaction.user.id, target.id, reason);

    if (!result.success) {
      await interaction.reply({
        components: [errorContainer(m.b2_rep_impossible({}, { locale }), result.error)],
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
      });
      return;
    }

    incrementQuestProgress(guildId, interaction.user.id, 'GIVE_REP').catch(() => { });

    await interaction.reply(v2Message(
      kotboContainer({
        color: 'success',
        title: `${E.star} ${m.b2_rep_give_title({}, { locale })}`,
        fields: [
          m.b2_rep_give_field({ from: `<@${interaction.user.id}>`, to: `<@${target.id}>` }, { locale }) + (reason ? `\n${E.dot} *${reason}*` : ''),
        ],
        footerTitle: m.b2_rep_give_footer({ user: `<@${target.id}>`, total: result.newTotal ?? 0 }, { locale })
      })
    ));
  }

  if (subcommand === 'check') {
    const target = interaction.options.getUser('membre') ?? interaction.user;
    const profile = await getReputation(guildId, target.id);

    await interaction.reply(v2Message(
      kotboContainer({
        color: 'primary',
        title: `${E.star} ${m.b2_rep_reputation({}, { locale })} · <@${target.id}>`,
        titleThumbnail: { url: target.displayAvatarURL() },
        fields: [
          separator({ divider: true, spacing: 'small' }),
          [
            `${E.arrow} **${m.b2_rep_total({}, { locale })}** · **${profile.totalRep}** rep`,
            `${E.arrow} **${m.b2_rep_rank({}, { locale })}** · #${profile.rank}`,
            `${E.arrow} **${m.b2_rep_votes_left({}, { locale })}** · ${REP_DAILY_VOTE_LIMIT - profile.votesGivenToday}/${REP_DAILY_VOTE_LIMIT}`,
          ].join('\n'),
        ],
        footerTitle: m.b2_rep_reputation({}, { locale })
      })
    ));
  }

  if (subcommand === 'top') {
    await interaction.deferReply();
    const lb = await getReputationLeaderboard(guildId, 10);

    if (lb.entries.length === 0) {
      await interaction.editReply(v2Message(
        kotboContainer({
          color: 'dark',
          title: `${E.trophy} ${m.b2_rep_leaderboard_title({}, { locale })}`,
          fields: [
            `${E.info} ${m.b2_rep_leaderboard_empty({}, { locale })}`,
          ],
          footerTitle: m.b2_rep_reputation({}, { locale })
        })
      ));
      return;
    }

    const lines = lb.entries.map((e) => {
      const medal = rankEmoji(e.rank);
      return `${medal} <@${e.userId}> — **${e.totalRep}** rep`;
    });

    await interaction.editReply(v2Message(
      kotboContainer({
        color: 'primary',
        title: `${E.trophy} ${m.b2_rep_leaderboard_title({}, { locale })}`,
        fields: [
          separator({ divider: true, spacing: 'small' }),
          lines.join('\n'),
        ],
        footerTitle: m.b2_rep_leaderboard_footer({ count: lb.totalVoters }, { locale })
      })
    ));
  }
}

export const repCommand = { data, execute } satisfies SlashCommandDefinition;
