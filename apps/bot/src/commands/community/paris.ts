import { SlashCommandBuilder, type ChatInputCommandInteraction, type SlashCommandSubcommandBuilder } from 'discord.js';
import type { SlashCommandDefinition } from '../../commands.js';
import { getCommandMetadata } from '../../utils/i18n.js';
import { handleBetCommand } from '../../services/community/clanBetService.js';
import {
  BET_PARTICIPANTS_CEILING,
  BET_PARTICIPANTS_MIN,
  BET_STAKE_CEILING,
  BET_STAKE_FLOOR,
  BET_SUBJECT_MAX_LENGTH,
} from '@kotbo/shared';
import * as m from '../../lib/paraglide/messages.js';

const meta = getCommandMetadata('c4_paris');

const localized = (key: 'sujet' | 'mise' | 'adversaire' | 'places' | 'camps') => {
  const message = {
    sujet: m.c4_paris_opt_sujet,
    mise: m.c4_paris_opt_mise,
    adversaire: m.c4_paris_opt_adversaire,
    places: m.c4_paris_opt_places,
    camps: m.c4_paris_opt_camps,
  }[key];
  return { en: message({}, { locale: 'en' }), fr: message({}, { locale: 'fr' }) };
};

/**
 * Sujet et mise sont demandés par toutes les formes de pari : les répéter dans
 * chaque sous-commande ferait diverger leurs libellés à la première retouche.
 */
function withCommonOptions(sub: SlashCommandSubcommandBuilder): SlashCommandSubcommandBuilder {
  const subject = localized('sujet');
  const stake = localized('mise');

  return sub
    .addStringOption((opt) =>
      opt
        .setName('sujet')
        .setDescription(subject.en)
        .setDescriptionLocalizations({ fr: subject.fr })
        .setRequired(true)
        .setMaxLength(BET_SUBJECT_MAX_LENGTH)
    )
    .addIntegerOption((opt) =>
      opt
        .setName('mise')
        .setDescription(stake.en)
        .setDescriptionLocalizations({ fr: stake.fr })
        .setRequired(true)
        // Bornes absolues : les mises mini et maxi du serveur sont vérifiées à
        // l'exécution, Discord ne sachant pas les faire varier par serveur.
        .setMinValue(BET_STAKE_FLOOR)
        .setMaxValue(BET_STAKE_CEILING)
    );
}

// Pas de `setDefaultMemberPermissions` : la commande s'adresse à tout le monde,
// seul le verdict est réservé aux administrateurs.
export const data = new SlashCommandBuilder()
  .setName(meta.name)
  .setNameLocalizations(meta.nameLocalizations)
  .setDescription(meta.description)
  .setDescriptionLocalizations(meta.descriptionLocalizations)
  .addSubcommand((sub) => {
    const opponent = localized('adversaire');
    return withCommonOptions(
      sub
        .setName('duel')
        .setDescription(m.c4_paris_sub_duel({}, { locale: 'en' }))
        .setDescriptionLocalizations({ fr: m.c4_paris_sub_duel({}, { locale: 'fr' }) })
    ).addUserOption((opt) =>
      // Volontairement facultatif : sans adversaire, le défi est ouvert au
      // premier qui le relève, quand le serveur l'autorise.
      opt
        .setName('adversaire')
        .setDescription(opponent.en)
        .setDescriptionLocalizations({ fr: opponent.fr })
        .setRequired(false)
    );
  })
  .addSubcommand((sub) => {
    const seats = localized('places');
    return withCommonOptions(
      sub
        .setName('pool')
        .setDescription(m.c4_paris_sub_pool({}, { locale: 'en' }))
        .setDescriptionLocalizations({ fr: m.c4_paris_sub_pool({}, { locale: 'fr' }) })
    )
      .addIntegerOption((opt) =>
        opt
          .setName('places')
          .setDescription(seats.en)
          .setDescriptionLocalizations({ fr: seats.fr })
          .setRequired(true)
          .setMinValue(BET_PARTICIPANTS_MIN)
          .setMaxValue(BET_PARTICIPANTS_CEILING)
      );
  })
  .addSubcommand((sub) => {
    const sides = localized('camps');
    return withCommonOptions(
      sub
        .setName('equipes')
        .setDescription(m.c4_paris_sub_equipes({}, { locale: 'en' }))
        .setDescriptionLocalizations({ fr: m.c4_paris_sub_equipes({}, { locale: 'fr' }) })
    )
      .addStringOption((opt) =>
        opt
          .setName('camps')
          .setDescription(sides.en)
          .setDescriptionLocalizations({ fr: sides.fr })
          .setRequired(true)
          .setMaxLength(400)
      );
  });

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  await handleBetCommand(interaction);
}

export const parisCommand = { data, execute } satisfies SlashCommandDefinition;
