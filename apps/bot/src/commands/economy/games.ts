import type { SlashCommandDefinition } from '../../commands.js';
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { kotboContainer } from '../../utils/embeds.js';
import { E } from '../../utils/emojis.js';
import { separator, v2Message } from '@arcscord/components';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('b5_games');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations);

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const locale = await getEffectiveLocale(interaction);

  await interaction.reply(v2Message(
    kotboContainer({
      color: 'primary',
      title: `${E.coins} ${m.b5_games_title({}, { locale })}`,
      fields: [
        m.b5_games_intro({}, { locale }),
        separator({ divider: true, spacing: 'small' }),
        m.b5_games_dice({ coins: E.coins, dot: E.dot }, { locale }),
        separator({ divider: true, spacing: 'small' }),
        m.b5_games_rps({ coins: E.coins, dot: E.dot }, { locale }),
        separator({ divider: true, spacing: 'small' }),
        m.b5_games_roulette({ coins: E.coins, dot: E.dot }, { locale }),
        separator({ divider: true, spacing: 'small' }),
        m.b5_games_guess({ coins: E.coins, dot: E.dot }, { locale }),
      ],
      footerOverwrite: `-# ${E.warning} ${m.b5_games_footer({}, { locale })}`,
    }),
  ));
}

export const gamesCommand = { data, execute } satisfies SlashCommandDefinition;
