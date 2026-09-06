import {
  BaseInteraction,
  MessageFlags,
  type InteractionEditReplyOptions,
  type InteractionReplyOptions,
  type InteractionUpdateOptions,
  type MessageCreateOptions,
  type TextChannel,
} from 'discord.js';

type RepliableInteractionLike = {
  deferred?: boolean;
  replied?: boolean;
  isRepliable: () => boolean;
  followUp: (options: InteractionReplyOptions) => Promise<unknown>;
  reply: (options: InteractionReplyOptions) => Promise<unknown>;
};

function canUpdateInteraction(value: unknown): value is { update: (options: InteractionUpdateOptions) => Promise<unknown> } {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { update?: unknown };
  return typeof candidate.update === 'function';
}

function toEditReplyOptions(payload: InteractionReplyOptions): InteractionEditReplyOptions {
  return {
    content: payload.content,
    embeds: payload.embeds,
    components: payload.components,
    files: payload.files,
    allowedMentions: payload.allowedMentions,
    flags: payload.flags as InteractionEditReplyOptions['flags'],
  };
}

function toUpdateOptions(payload: InteractionReplyOptions): InteractionUpdateOptions {
  return {
    content: payload.content,
    embeds: payload.embeds,
    components: payload.components,
    files: payload.files,
    allowedMentions: payload.allowedMentions,
    flags: payload.flags as InteractionUpdateOptions['flags'],
  };
}

function toChannelMessageOptions(payload: InteractionReplyOptions): MessageCreateOptions {
  return {
    content: payload.content,
    embeds: payload.embeds,
    components: payload.components,
    files: payload.files,
    allowedMentions: payload.allowedMentions,
    flags: payload.flags as MessageCreateOptions['flags'],
  };
}

export async function replyOrFollowUp(
  interaction: RepliableInteractionLike,
  payload: InteractionReplyOptions,
): Promise<void> {
  if (!interaction.isRepliable()) return;

  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload);
    return;
  }

  await interaction.reply(payload);
}

export async function acknowledgeInteraction(
  interaction: BaseInteraction,
  flags: InteractionReplyOptions['flags'] = [MessageFlags.Ephemeral],
): Promise<void> {
  if (!interaction.isRepliable() || interaction.deferred || interaction.replied) return;

  const candidate = interaction as unknown as { deferUpdate?: () => Promise<void>; deferReply?: (options: InteractionReplyOptions) => Promise<void> };

  if (typeof candidate.deferUpdate === 'function' && interaction.isMessageComponent()) {
    await candidate.deferUpdate();
    return;
  }

  if (typeof candidate.deferReply === 'function') {
    await candidate.deferReply({ flags });
  }
}

export async function renderPanelTarget(
  target: TextChannel | BaseInteraction,
  payload: InteractionReplyOptions,
): Promise<void> {
  if (!(target instanceof BaseInteraction)) {
    await target.send(toChannelMessageOptions(payload));
    return;
  }

  if (!target.isRepliable()) return;

  if (target.deferred || target.replied) {
    await target.editReply(toEditReplyOptions(payload));
    return;
  }

  if (target.isMessageComponent()) {
    await target.update(toUpdateOptions(payload));
    return;
  }

  if (target.isModalSubmit() && canUpdateInteraction(target)) {
    await target.update(toUpdateOptions(payload));
    return;
  }

  await target.reply({
    ...payload,
    flags: payload.flags ?? [MessageFlags.Ephemeral],
  });
}

/**
 * Ouvre un panneau sans jamais ecraser le message qui l'a declenche.
 *
 * `renderPanelTarget` repond a un composant par un `update` : c'est ce qu'il
 * faut dans un panneau ephemere, qui se remplace d'un bloc a chaque navigation.
 * Mais le meme bouton est aussi pose sur des messages publics - un log, une
 * carte de sanction - et l'`update` remplace alors ce message par le panneau :
 * le log disparait, definitivement, pour tout le serveur.
 *
 * D'ou la regle : on ne remplace que ce qui est deja ephemere. Sur un message
 * public, le panneau s'ouvre a cote, en reponse ephemere, et le message reste
 * intact.
 */
export async function renderPanelBeside(
  interaction: BaseInteraction,
  payload: InteractionReplyOptions,
): Promise<void> {
  if (!interaction.isRepliable()) return;

  const sourceMessage = interaction.isMessageComponent() ? interaction.message : null;
  const sourceIsEphemeral = !!sourceMessage?.flags?.has(MessageFlags.Ephemeral);

  if (sourceMessage && !sourceIsEphemeral) {
    // `embeds: []` n'existe que pour vider les embeds d'un panneau existant :
    // sur un message neuf il n'y a rien a vider, et Discord refuse le champ
    // quand les composants V2 sont demandes.
    const { embeds, ...rest } = payload;
    const fresh: InteractionReplyOptions =
      embeds && embeds.length > 0 ? payload : (rest as InteractionReplyOptions);

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(fresh);
      return;
    }
    await interaction.reply(fresh);
    return;
  }

  await renderPanelTarget(interaction, payload);
}
