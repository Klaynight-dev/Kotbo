import type { SlashCommandDefinition } from '../../commands.js';
import {
  SlashCommandBuilder,
  AttachmentBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { getMemberRankData, generateRankCard } from '../../services/progression/levelingService.js';
import { extractTrackingInfo, resolveModuleFromCommand, wrapModuleTracking } from '../../utils/moduleTracking.js';
import { kotboContainer } from '../../utils/embeds.js';
import { E } from '../../utils/emojis.js';
import { mediaGallery, v2Message } from '@arcscord/components';
import { getEffectiveLocale, getCommandMetadata } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('b5_rank');

const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addUserOption((option) =>
    option
      .setName('membre')
      .setDescription(m.b5_rank_opt_member({}, { locale: 'en' }))
      .setDescriptionLocalizations({ fr: m.b5_rank_opt_member({}, { locale: 'fr' }) })
      .setRequired(false),
  );

async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  const { guildId, userId } = extractTrackingInfo(interaction);
  const moduleName = resolveModuleFromCommand('rank');

  await wrapModuleTracking(moduleName, executeInternal, [interaction], {
    actionType: 'command',
    actionName: 'rank',
    guildId,
    userId,
  });
}

async function executeInternal(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  const locale = await getEffectiveLocale(interaction);
  if (!guildId) {
    await interaction.reply({
      content: `${E.error} ${m.b5_guild_only({}, { locale })}`,
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  await interaction.deferReply();

  const targetUser = interaction.options.getUser('membre') || interaction.user;
  const member = await interaction.guild?.members.fetch(targetUser.id).catch(() => null);
  if (!member) {
    await interaction.editReply({ content: `${E.error} ${m.b5_rank_member_not_found({}, { locale })}` });
    return;
  }

  try {
    const rankData = await getMemberRankData(guildId, targetUser.id);
    const imageBuffer = await generateRankCard(member, rankData.level, rankData.xp, rankData.rank);
    const attachment = new AttachmentBuilder(imageBuffer, { name: 'rank-card.png' });

    await interaction.editReply({
      ...v2Message(
        kotboContainer({
          color: 'primary',
          fields: [
            mediaGallery({ items: [{ media: { url: 'attachment://rank-card.png' } }] }),
          ],
        }),
      ),
      files: [attachment],
    });
  } catch {
    await interaction.editReply({ content: `${E.error} ${m.b5_rank_gen_error({}, { locale })}` });
  }
}

export const rankCommand = { data, execute } satisfies SlashCommandDefinition;
