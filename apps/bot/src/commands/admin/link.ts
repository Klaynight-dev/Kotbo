import type { SlashCommandDefinition } from '../../commands.js';
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
} from 'discord.js';
import { COLORS, successEmbed, errorEmbed } from '../../utils/embeds.js';
import {
  createLinkInvite,
  acceptLinkInvite,
  createDirectGroup,
  addGroupMember,
  getGroup,
  inspectRelayPermissions,
  listGroupsForGuild,
  needsMessageMapping,
  removeGroup,
  removeGroupMember,
  updateGroupConfig,
  type LinkGroup,
  type LinkMemberMode,
} from '../../services/features/channelLinkService.js';
import { isGuildActivated } from '../../utils/activation.js';
import { isLinkGuestGuild } from '../../services/features/channelLinkGuestService.js';
import { INVITE_SOURCE, recordBotInvite } from '../../services/analytics/inviteService.js';

const MODE_CHOICES = [
  { name: 'Émet et reçoit', value: 'BOTH' },
  { name: 'Émet seulement', value: 'SEND_ONLY' },
  { name: 'Reçoit seulement', value: 'RECEIVE_ONLY' },
];

const RELAY_MODE_CHOICES = [
  { name: 'Webhook (pseudo + avatar miroir)', value: 'WEBHOOK' },
  { name: 'Embed (message dans un embed signé)', value: 'EMBED' },
];

const data = new SlashCommandBuilder()
  .setName('link')
  .setDescription('Gérer les ponts entre salons de différents serveurs')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName('invite')
      .setDescription('Générer un code pour qu\'un ou plusieurs serveurs rejoignent un pont')
      .addChannelOption((opt) =>
        opt
          .setName('salon')
          .setDescription('Le salon à relier')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('pont')
          .setDescription('ID d\'un pont existant à rejoindre (par défaut : nouveau pont)'),
      )
      .addStringOption((opt) =>
        opt
          .setName('participation')
          .setDescription('Ce que fera le salon qui utilise le code')
          .addChoices(...MODE_CHOICES),
      )
      .addIntegerOption((opt) =>
        opt
          .setName('utilisations')
          .setDescription('Nombre de serveurs pouvant utiliser ce code (défaut: 1)')
          .setMinValue(1)
          .setMaxValue(25),
      )
      .addStringOption((opt) =>
        opt
          .setName('mode')
          .setDescription('Mode de relay')
          .addChoices(...RELAY_MODE_CHOICES),
      )
      .addBooleanOption((opt) =>
        opt
          .setName('invitation-serveur')
          .setDescription('Créer aussi une invitation Discord pour rejoindre ce serveur'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('accept')
      .setDescription('Rejoindre un pont avec un code d\'invitation')
      .addStringOption((opt) =>
        opt.setName('code').setDescription('Le code d\'invitation').setRequired(true),
      )
      .addChannelOption((opt) =>
        opt
          .setName('salon')
          .setDescription('Le salon de ce serveur à relier')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('salon')
      .setDescription('Relier deux salons de ce serveur')
      .addChannelOption((opt) =>
        opt
          .setName('salon-source')
          .setDescription('Premier salon')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      )
      .addChannelOption((opt) =>
        opt
          .setName('salon-cible')
          .setDescription('Second salon')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('participation')
          .setDescription('Ce que fait le salon source')
          .addChoices(...MODE_CHOICES),
      )
      .addStringOption((opt) =>
        opt
          .setName('mode')
          .setDescription('Mode de relay')
          .addChoices(...RELAY_MODE_CHOICES),
      )
      .addBooleanOption((opt) =>
        opt.setName('modifier-topic').setDescription('Mettre à jour la description des salons (défaut: oui)'),
      )
      .addBooleanOption((opt) =>
        opt.setName('lien-dans-topic').setDescription('Inclure un lien cliquable vers les salons liés dans le topic (défaut: oui)'),
      )
      .addBooleanOption((opt) =>
        opt.setName('threads').setDescription('Synchroniser les threads et leurs messages (défaut: non)'),
      )
      .addBooleanOption((opt) =>
        opt.setName('sondages').setDescription('Relayer les sondages (défaut: non)'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('direct')
      .setDescription('Ouvrir un pont avec un salon d\'un autre serveur (sans code)')
      .addChannelOption((opt) =>
        opt
          .setName('salon-source')
          .setDescription('Le salon de ce serveur')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('serveur-cible').setDescription('ID du serveur cible').setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('salon-cible').setDescription('ID du salon cible').setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('nom').setDescription('Nom du pont (facultatif)'),
      )
      .addStringOption((opt) =>
        opt
          .setName('participation')
          .setDescription('Ce que fait le salon de ce serveur')
          .addChoices(...MODE_CHOICES),
      )
      .addStringOption((opt) =>
        opt
          .setName('mode')
          .setDescription('Mode de relay')
          .addChoices(...RELAY_MODE_CHOICES),
      )
      .addBooleanOption((opt) =>
        opt.setName('modifier-topic').setDescription('Mettre à jour la description des salons (défaut: oui)'),
      )
      .addBooleanOption((opt) =>
        opt.setName('lien-dans-topic').setDescription('Inclure un lien cliquable vers les salons liés dans le topic (défaut: oui)'),
      )
      .addBooleanOption((opt) =>
        opt.setName('threads').setDescription('Synchroniser les threads et leurs messages (défaut: non)'),
      )
      .addBooleanOption((opt) =>
        opt.setName('sondages').setDescription('Relayer les sondages (défaut: non)'),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('ajouter')
      .setDescription('Ajouter un salon d\'un autre serveur à un pont existant')
      .addStringOption((opt) =>
        opt.setName('id').setDescription('ID du pont').setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('serveur').setDescription('ID du serveur à ajouter').setRequired(true),
      )
      .addStringOption((opt) =>
        opt.setName('salon').setDescription('ID du salon à ajouter').setRequired(true),
      )
      .addStringOption((opt) =>
        opt
          .setName('participation')
          .setDescription('Ce que fera ce salon dans le pont')
          .addChoices(...MODE_CHOICES),
      )
      .addStringOption((opt) =>
        opt
          .setName('mode')
          .setDescription('Mode de relay')
          .addChoices(...RELAY_MODE_CHOICES),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('retirer')
      .setDescription('Retirer un salon de ce serveur d\'un pont')
      .addStringOption((opt) =>
        opt.setName('id').setDescription('ID du pont').setRequired(true),
      )
      .addChannelOption((opt) =>
        opt
          .setName('salon')
          .setDescription('Le salon à retirer')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('Lister les ponts de ce serveur'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('status')
      .setDescription('Ce que le bot fait, et ne fait pas, sur ce serveur'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('remove')
      .setDescription('Supprimer un pont entier')
      .addStringOption((opt) =>
        opt.setName('id').setDescription('ID du pont à supprimer').setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName('config')
      .setDescription('Configurer ce qu\'un pont relaie')
      .addStringOption((opt) =>
        opt.setName('id').setDescription('ID du pont').setRequired(true),
      )
      .addStringOption((opt) => opt.setName('nom').setDescription('Nom du pont'))
      .addBooleanOption((opt) => opt.setName('texte').setDescription('Relayer le texte'))
      .addBooleanOption((opt) => opt.setName('images').setDescription('Relayer les images'))
      .addBooleanOption((opt) => opt.setName('embeds').setDescription('Relayer les embeds'))
      .addBooleanOption((opt) => opt.setName('reactions').setDescription('Relayer les réactions'))
      .addBooleanOption((opt) => opt.setName('edits').setDescription('Relayer les modifications'))
      .addBooleanOption((opt) => opt.setName('deletes').setDescription('Relayer les suppressions'))
      .addBooleanOption((opt) => opt.setName('actif').setDescription('Activer/désactiver le pont'))
      .addBooleanOption((opt) => opt.setName('threads').setDescription('Synchroniser les threads'))
      .addBooleanOption((opt) => opt.setName('sondages').setDescription('Relayer les sondages'))
      .addBooleanOption((opt) => opt.setName('epingles').setDescription('Synchroniser les messages épinglés'))
      .addBooleanOption((opt) => opt.setName('modifier-topic').setDescription('Mettre à jour auto le topic des salons')),
  );

/**
 * Sous-commandes accessibles à un serveur sans code d'activation.
 *
 * `/link` franchit la garde d'activation (voir `GATE_EXEMPT_COMMANDS` dans
 * index.ts) pour qu'un serveur invité puisse rejoindre un pont sans code, puis
 * le consulter et le quitter. Il ne gagne pas pour autant le droit d'ouvrir des
 * ponts pour son propre compte : `invite`, `salon`, `direct` et `ajouter`
 * restent réservés aux serveurs disposant d'une licence.
 */
const SUBCOMMANDS_WITHOUT_ACTIVATION = new Set(['accept', 'list', 'remove', 'retirer', 'status']);

function readMode(value: string | null, fallback: LinkMemberMode = 'BOTH'): LinkMemberMode {
  return value === 'SEND_ONLY' || value === 'RECEIVE_ONLY' || value === 'BOTH' ? value : fallback;
}

/** Le mode symétrique de celui choisi pour le salon d'origine. */
function mirrorMode(mode: LinkMemberMode): LinkMemberMode {
  if (mode === 'SEND_ONLY') return 'RECEIVE_ONLY';
  if (mode === 'RECEIVE_ONLY') return 'SEND_ONLY';
  return 'BOTH';
}

function modeIcon(mode: string) {
  if (mode === 'SEND_ONLY') return '→';
  if (mode === 'RECEIVE_ONLY') return '←';
  return '↔️';
}

function describeMembers(group: LinkGroup, interaction: ChatInputCommandInteraction): string {
  return group.members
    .map((member) => {
      const isLocal = member.guildId === interaction.guildId;
      const guild = interaction.client.guilds.cache.get(member.guildId);
      const channelLabel = isLocal ? `<#${member.channelId}>` : `#${guild?.channels.cache.get(member.channelId)?.name ?? member.channelId}`;
      const guildLabel = isLocal ? 'ce serveur' : `**${guild?.name ?? member.guildId}**`;
      const paused = member.enabled ? '' : ' *(en pause)*';
      return `${modeIcon(member.mode)} ${channelLabel} - ${guildLabel}${paused}`;
    })
    .join('\n');
}

/**
 * Les permissions qui manquent au pont, dites à l'endroit où l'administrateur
 * vient de le manipuler. Sans ce rappel, le symptôme le plus courant - un emoji
 * d'un autre serveur réduit à `:nom:` par Discord faute de droit sur le salon
 * qui reçoit - n'a aucune explication visible.
 */
const EMBED_DESCRIPTION_LIMIT = 4096;

/**
 * Discord rejette l'embed entier au-dela de 4096 caracteres : sur un serveur qui
 * cumule les ponts, la liste doit se couper plutot que de ne rien afficher.
 */
function clampDescription(text: string): string {
  if (text.length <= EMBED_DESCRIPTION_LIMIT) return text;
  const suffix = '\n\n*(liste tronquée)*';
  return `${text.slice(0, EMBED_DESCRIPTION_LIMIT - suffix.length)}${suffix}`;
}

function describePermissionIssues(group: LinkGroup, interaction: ChatInputCommandInteraction): string {
  const issues = inspectRelayPermissions(interaction.client, group);
  if (issues.length === 0) return '';

  const lines = issues.map((issue) => {
    const isLocal = issue.guildId === interaction.guildId;
    const guild = interaction.client.guilds.cache.get(issue.guildId);
    const channelLabel = isLocal
      ? `<#${issue.channelId}>`
      : `#${guild?.channels.cache.get(issue.channelId)?.name ?? issue.channelId} (${guild?.name ?? issue.guildId})`;

    if (issue.channelMissing) return `• ${channelLabel} : salon introuvable pour le bot.`;

    const parts: string[] = [];
    if (issue.bot.length > 0) parts.push(`au bot : ${issue.bot.map((p) => p.label).join(', ')}`);
    if (issue.everyone.length > 0) parts.push(`à @everyone : ${issue.everyone.map((p) => p.label).join(', ')}`);

    return `• ${channelLabel} - manque ${parts.join(' ; ')}`;
  });

  return `\n\n⚠️ **Permissions incomplètes**\n${lines.join('\n')}`;
}

async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: true });

  if (
    interaction.guildId &&
    !isGuildActivated(interaction.guildId) &&
    !SUBCOMMANDS_WITHOUT_ACTIVATION.has(sub)
  ) {
    await interaction.editReply({
      embeds: [
        errorEmbed(
          'Serveur non activé',
          "Ce serveur n'a pas de clé d'activation Kotbo.\n\n" +
            "Il peut malgré tout rejoindre le pont d'un serveur activé : demandez-y `/link invite`, " +
            'puis lancez ici `/link accept code:<code>`.\n\n' +
            'Utilisez `/link status` pour voir ce que le bot fait - et ne fait pas - sur ce serveur.',
        ),
      ],
    });
    return;
  }

  switch (sub) {
    case 'invite':
      return handleInvite(interaction);
    case 'accept':
      return handleAccept(interaction);
    case 'salon':
      return handleSameServer(interaction);
    case 'direct':
      return handleDirect(interaction);
    case 'ajouter':
      return handleAddMember(interaction);
    case 'retirer':
      return handleRemoveMember(interaction);
    case 'list':
      return handleList(interaction);
    case 'status':
      return handleStatus(interaction);
    case 'remove':
      return handleRemove(interaction);
    case 'config':
      return handleConfig(interaction);
  }
}

async function handleInvite(interaction: ChatInputCommandInteraction) {
  const channel = interaction.options.getChannel('salon', true);
  const groupId = interaction.options.getString('pont');
  const memberMode = readMode(interaction.options.getString('participation'));
  const relayMode = (interaction.options.getString('mode') ?? 'WEBHOOK') as 'WEBHOOK' | 'EMBED';
  const maxUses = interaction.options.getInteger('utilisations') ?? 1;
  const createServerInvite = interaction.options.getBoolean('invitation-serveur') ?? false;

  if (groupId) {
    const group = await getGroup(groupId);
    if (!group || !group.members.some((mb) => mb.guildId === interaction.guildId)) {
      await interaction.editReply({ embeds: [errorEmbed('Erreur', 'Pont introuvable sur ce serveur.')] });
      return;
    }
  }

  const invite = await createLinkInvite({
    guildId: interaction.guildId!,
    channelId: channel.id,
    createdByUserId: interaction.user.id,
    groupId,
    memberMode,
    relayMode,
    maxUses,
  });

  let serverInviteUrl = '';
  if (createServerInvite) {
    try {
      const guild = interaction.guild!;
      const targetChannel = guild.channels.cache.get(channel.id);
      if (targetChannel && 'createInvite' in targetChannel && typeof targetChannel.createInvite === 'function') {
        const discordInvite = await targetChannel.createInvite({
          maxAge: 24 * 60 * 60,
          maxUses: 5,
          reason: `Kotbo Link: Invitation pour relier le salon #${channel.id}`,
        });
        serverInviteUrl = discordInvite.url;
        // Le serveur distant n'est pas encore connu à ce stade de l'appairage.
        await recordBotInvite(discordInvite, INVITE_SOURCE.channelLinkPairing());
      }
    } catch {
      serverInviteUrl = '';
    }
  }

  const description = [
    `**Code :** \`${invite.code}\``,
    `**Salon :** <#${channel.id}>`,
    groupId ? `**Pont :** \`${groupId}\`` : '**Pont :** nouveau, créé à la première utilisation',
    `**Participation du serveur invité :** ${MODE_CHOICES.find((c) => c.value === memberMode)!.name}`,
    `**Mode :** ${relayMode === 'WEBHOOK' ? 'Webhook (miroir)' : 'Embed'}`,
    `**Utilisations :** ${maxUses}`,
    `**Expire :** <t:${Math.floor(invite.expiresAt.getTime() / 1000)}:R>`,
    '',
    maxUses > 1
      ? `Chaque serveur qui lance \`/link accept code:${invite.code}\` rejoint le même pont.`
      : `Utilisez \`/link accept code:${invite.code}\` sur l'autre serveur pour compléter le pont.`,
  ];

  if (serverInviteUrl) {
    description.push('', `**Invitation serveur :** ${serverInviteUrl}`);
  }

  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle('🔗 Invitation de pont créée')
    .setDescription(description.join('\n'))
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleAccept(interaction: ChatInputCommandInteraction) {
  const code = interaction.options.getString('code', true).trim().toUpperCase();
  const channel = interaction.options.getChannel('salon', true);

  const result = await acceptLinkInvite({
    code,
    targetGuildId: interaction.guildId!,
    targetChannelId: channel.id,
    updateTopic: true,
    includeTopicLink: true,
    client: interaction.client,
  });

  if ('error' in result) {
    await interaction.editReply({ embeds: [errorEmbed('Erreur', result.error)] });
    return;
  }

  const lines = [
    `Le salon <#${channel.id}> fait maintenant partie du pont :`,
    '',
    describeMembers(result.group, interaction),
    '',
    `**ID du pont :** \`${result.group.id}\``,
  ];

  // Ce serveur n'a pas de code : le préciser franchement évite qu'on croie
  // avoir activé Kotbo en entier en rejoignant un pont.
  if (!isGuildActivated(interaction.guildId!)) {
    lines.push(
      '',
      '🔒 **Mode liaison seule.** Ce serveur reste sans clé d\'activation : le bot n\'y fait ' +
        'circuler que les messages du salon relié. Aucun autre module n\'est actif et aucune ' +
        'donnée d\'activité n\'est enregistrée.',
      'Détail complet : `/link status`.',
    );
  }

  await interaction.editReply({
    embeds: [successEmbed('🔗 Pont rejoint !', lines.join('\n') + describePermissionIssues(result.group, interaction))],
  });
}

async function handleSameServer(interaction: ChatInputCommandInteraction) {
  const sourceChannel = interaction.options.getChannel('salon-source', true);
  const targetChannel = interaction.options.getChannel('salon-cible', true);
  const ownerMode = readMode(interaction.options.getString('participation'));
  const relayMode = (interaction.options.getString('mode') ?? 'WEBHOOK') as 'WEBHOOK' | 'EMBED';
  const updateTopic = interaction.options.getBoolean('modifier-topic') ?? true;
  const includeTopicLink = interaction.options.getBoolean('lien-dans-topic') ?? true;

  if (sourceChannel.id === targetChannel.id) {
    await interaction.editReply({
      embeds: [errorEmbed('Erreur', 'Impossible de lier un salon à lui-même.')],
    });
    return;
  }

  const result = await createDirectGroup({
    ownerGuildId: interaction.guildId!,
    ownerChannelId: sourceChannel.id,
    targets: [{ guildId: interaction.guildId!, channelId: targetChannel.id, mode: mirrorMode(ownerMode) }],
    createdByUserId: interaction.user.id,
    ownerMode,
    relayMode,
    relayThreads: interaction.options.getBoolean('threads') ?? false,
    relayPolls: interaction.options.getBoolean('sondages') ?? false,
    updateTopic,
    includeTopicLink,
    client: interaction.client,
  });

  if ('error' in result) {
    await interaction.editReply({ embeds: [errorEmbed('Erreur', result.error)] });
    return;
  }

  const topicInfo = updateTopic ? '\n**Topic :** Mis à jour automatiquement ✅' : '';
  const embed = successEmbed(
    '🔗 Salons reliés !',
    `${describeMembers(result, interaction)}\n` +
    `**Mode :** ${relayMode === 'WEBHOOK' ? 'Webhook (miroir)' : 'Embed'}` +
    topicInfo +
    `\n**ID :** \`${result.id}\`` +
    describePermissionIssues(result, interaction),
  );

  await interaction.editReply({ embeds: [embed] });
}

async function handleDirect(interaction: ChatInputCommandInteraction) {
  const sourceChannel = interaction.options.getChannel('salon-source', true);
  const targetGuildId = interaction.options.getString('serveur-cible', true);
  const targetChannelId = interaction.options.getString('salon-cible', true);
  const ownerMode = readMode(interaction.options.getString('participation'));
  const relayMode = (interaction.options.getString('mode') ?? 'WEBHOOK') as 'WEBHOOK' | 'EMBED';

  const targetGuild = interaction.client.guilds.cache.get(targetGuildId);
  if (!targetGuild) {
    await interaction.editReply({
      embeds: [errorEmbed('Erreur', 'Le bot n\'est pas présent sur le serveur cible.')],
    });
    return;
  }

  const targetChannel = targetGuild.channels.cache.get(targetChannelId);
  if (!targetChannel || !targetChannel.isTextBased()) {
    await interaction.editReply({
      embeds: [errorEmbed('Erreur', 'Le salon cible est introuvable ou n\'est pas un salon texte.')],
    });
    return;
  }

  const result = await createDirectGroup({
    ownerGuildId: interaction.guildId!,
    ownerChannelId: sourceChannel.id,
    targets: [{ guildId: targetGuildId, channelId: targetChannelId, mode: mirrorMode(ownerMode) }],
    createdByUserId: interaction.user.id,
    name: interaction.options.getString('nom'),
    ownerMode,
    relayMode,
    relayThreads: interaction.options.getBoolean('threads') ?? false,
    relayPolls: interaction.options.getBoolean('sondages') ?? false,
    updateTopic: interaction.options.getBoolean('modifier-topic') ?? true,
    includeTopicLink: interaction.options.getBoolean('lien-dans-topic') ?? true,
    client: interaction.client,
  });

  if ('error' in result) {
    await interaction.editReply({ embeds: [errorEmbed('Erreur', result.error)] });
    return;
  }

  const embed = successEmbed(
    '🔗 Pont créé !',
    `${describeMembers(result, interaction)}\n\n` +
    `**Mode :** ${relayMode === 'WEBHOOK' ? 'Webhook' : 'Embed'}\n` +
    `**ID :** \`${result.id}\`\n\n` +
    `Ajoutez d'autres serveurs avec \`/link ajouter id:${result.id}\` ou \`/link invite pont:${result.id}\`.` +
    describePermissionIssues(result, interaction),
  );

  await interaction.editReply({ embeds: [embed] });
}

async function handleAddMember(interaction: ChatInputCommandInteraction) {
  const groupId = interaction.options.getString('id', true);
  const memberGuildId = interaction.options.getString('serveur', true);
  const memberChannelId = interaction.options.getString('salon', true);

  const group = await getGroup(groupId);
  if (!group || !group.members.some((mb) => mb.guildId === interaction.guildId)) {
    await interaction.editReply({ embeds: [errorEmbed('Erreur', 'Pont introuvable sur ce serveur.')] });
    return;
  }

  const memberGuild = interaction.client.guilds.cache.get(memberGuildId);
  const memberChannel = memberGuild?.channels.cache.get(memberChannelId);
  if (!memberGuild || !memberChannel || !memberChannel.isTextBased()) {
    await interaction.editReply({
      embeds: [errorEmbed('Erreur', 'Serveur ou salon introuvable pour le bot.')],
    });
    return;
  }

  const result = await addGroupMember({
    groupId,
    guildId: memberGuildId,
    channelId: memberChannelId,
    addedByUserId: interaction.user.id,
    mode: readMode(interaction.options.getString('participation')),
    relayMode: (interaction.options.getString('mode') ?? 'WEBHOOK') as 'WEBHOOK' | 'EMBED',
    client: interaction.client,
  });

  if ('error' in result) {
    await interaction.editReply({ embeds: [errorEmbed('Erreur', result.error)] });
    return;
  }

  await interaction.editReply({
    embeds: [
      successEmbed('🔗 Serveur ajouté au pont', describeMembers(result, interaction) + describePermissionIssues(result, interaction)),
    ],
  });
}

async function handleRemoveMember(interaction: ChatInputCommandInteraction) {
  const groupId = interaction.options.getString('id', true);
  const channel = interaction.options.getChannel('salon', true);

  const group = await getGroup(groupId);
  const member = group?.members.find(
    (mb) => mb.guildId === interaction.guildId && mb.channelId === channel.id,
  );
  if (!group || !member) {
    await interaction.editReply({
      embeds: [errorEmbed('Erreur', 'Ce salon ne fait pas partie de ce pont.')],
    });
    return;
  }

  const remaining = await removeGroupMember(groupId, member.id, interaction.client);

  await interaction.editReply({
    embeds: [
      successEmbed(
        '🚪 Salon retiré du pont',
        remaining
          ? `<#${channel.id}> ne fait plus partie du pont \`${groupId}\`.\n\n${describeMembers(remaining, interaction)}`
          : `<#${channel.id}> ne fait plus partie du pont, qui n'avait plus assez de salons et a été supprimé.`,
      ),
    ],
  });
}

async function handleList(interaction: ChatInputCommandInteraction) {
  const groups = await listGroupsForGuild(interaction.guildId!);

  if (groups.length === 0) {
    await interaction.editReply({
      embeds: [new EmbedBuilder().setColor(COLORS.info).setDescription('Aucun pont de salons configuré.')],
    });
    return;
  }

  const blocks = groups.map((group) => {
    const statusIcon = group.enabled ? '🟢' : '🔴';
    const title = group.name ?? `Pont de ${group.members.length} salons`;
    return `${statusIcon} **${title}** \`${group.id.slice(0, 8)}\`\n${describeMembers(group, interaction)}`
      + describePermissionIssues(group, interaction);
  });

  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle('🔗 Ponts de salons')
    .setDescription(clampDescription(blocks.join('\n\n')))
    .setFooter({ text: `${groups.length} pont(s)` })
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

/**
 * Rend lisible, pour un administrateur du serveur relié, ce que le bot fait
 * réellement chez lui. La question posée par les communautés attachées à leur
 * vie privée n'est pas « quelles options ai-je cochées » mais « qu'est-ce qui
 * est écrit quelque part » : c'est donc à cela que cet écran répond.
 */
async function handleStatus(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId!;
  const activated = isGuildActivated(guildId);
  const groups = await listGroupsForGuild(guildId);
  const activeGroups = groups.filter((g) => g.enabled);

  if (activated) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('🔓 Serveur activé')
      .setDescription(
        'Ce serveur dispose d\'une clé d\'activation : les modules Kotbo y sont disponibles ' +
          'selon la configuration du dashboard.\n\n' +
          `**Ponts de salons :** ${activeGroups.length} actif(s) sur ${groups.length}.\n` +
          'La collecte de statistiques d\'activité se coupe depuis le dashboard ' +
          '(Paramètres généraux → *Statistiques d\'activité*) ; une fois désactivée, plus rien ' +
          'n\'est enregistré sur les membres.',
      )
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (!isLinkGuestGuild(guildId)) {
    const embed = new EmbedBuilder()
      .setColor(COLORS.warning)
      .setTitle('⚪ Bot inactif sur ce serveur')
      .setDescription(
        "Ce serveur n'a ni clé d'activation, ni pont avec un serveur activé : le bot n'y fait " +
          'strictement rien et n\'enregistre rien.\n\n' +
          'Pour rejoindre un pont : demandez `/link invite` sur le serveur activé, puis lancez ici ' +
          '`/link accept code:<code>`.',
      )
      .setTimestamp();
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const storesMapping = activeGroups.some((g) => needsMessageMapping(g));
  const bridged = activeGroups.map((group) => describeMembers(group, interaction)).join('\n');

  const embed = new EmbedBuilder()
    .setColor(COLORS.success)
    .setTitle('🔒 Mode liaison seule')
    .setDescription(
      clampDescription(
        'Ce serveur **ne possède pas de clé d\'activation**. Le bot y est présent pour une seule ' +
          'raison : faire circuler les messages des salons reliés ci-dessous.\n\n' +
          `${bridged || '*Aucun pont actif.*'}`,
      ),
    )
    .addFields(
      {
        name: '✅ Ce que le bot fait',
        value:
          'Recopier les messages des salons reliés, entre tous les serveurs du pont, avec le ' +
          'pseudo et l\'avatar de leur auteur.',
      },
      {
        name: '🚫 Ce qu\'il ne fait pas',
        value:
          "Aucun module n'est actif ici : ni statistiques, ni niveaux, ni économie, ni " +
          "modération, ni journalisation. Les événements de ce serveur n'atteignent même pas " +
          'ces modules - ils sont écartés avant, et seul le relais les reçoit.',
      },
      {
        name: '💾 Ce qui est enregistré',
        value: storesMapping
          ? "Uniquement la correspondance entre l'identifiant d'un message et ceux de ses copies, " +
            'nécessaire pour propager les modifications, suppressions et réactions. Aucun contenu, ' +
            'aucun profil, aucune statistique. Désactivez ces trois relais pour que même cette ' +
            'correspondance cesse d\'être écrite.'
          : 'Rien. Ces ponts ne relaient ni modification, ni suppression, ni réaction : aucune ' +
            'ligne n\'est écrite en base pour les messages qui transitent.',
      },
      {
        name: '🚪 Pour tout arrêter',
        value: '`/link retirer id:<id> salon:<salon>` ou l\'expulsion du bot met fin au pont immédiatement.',
      },
    )
    .setTimestamp();

  await interaction.editReply({ embeds: [embed] });
}

async function handleRemove(interaction: ChatInputCommandInteraction) {
  const groupId = interaction.options.getString('id', true);

  const group = await getGroup(groupId);
  if (!group || !group.members.some((mb) => mb.guildId === interaction.guildId)) {
    await interaction.editReply({ embeds: [errorEmbed('Erreur', 'Pont introuvable sur ce serveur.')] });
    return;
  }

  await removeGroup(groupId, interaction.client);

  await interaction.editReply({
    embeds: [successEmbed('🗑️ Pont supprimé', `Le pont \`${groupId}\` et tous ses salons ont été déliés.`)],
  });
}

async function handleConfig(interaction: ChatInputCommandInteraction) {
  const groupId = interaction.options.getString('id', true);

  const group = await getGroup(groupId);
  if (!group || !group.members.some((mb) => mb.guildId === interaction.guildId)) {
    await interaction.editReply({ embeds: [errorEmbed('Erreur', 'Pont introuvable sur ce serveur.')] });
    return;
  }

  const updates: Record<string, boolean | string | undefined> = {};
  const nom = interaction.options.getString('nom');
  const texte = interaction.options.getBoolean('texte');
  const images = interaction.options.getBoolean('images');
  const embeds = interaction.options.getBoolean('embeds');
  const reactions = interaction.options.getBoolean('reactions');
  const edits = interaction.options.getBoolean('edits');
  const deletes = interaction.options.getBoolean('deletes');
  const actif = interaction.options.getBoolean('actif');
  const threads = interaction.options.getBoolean('threads');
  const sondages = interaction.options.getBoolean('sondages');
  const epingles = interaction.options.getBoolean('epingles');
  const modifierTopic = interaction.options.getBoolean('modifier-topic');

  if (nom !== null) updates.name = nom;
  if (texte !== null) updates.relayText = texte;
  if (images !== null) updates.relayImages = images;
  if (embeds !== null) updates.relayEmbeds = embeds;
  if (reactions !== null) updates.relayReactions = reactions;
  if (edits !== null) updates.relayEdits = edits;
  if (deletes !== null) updates.relayDeletes = deletes;
  if (actif !== null) updates.enabled = actif;
  if (threads !== null) updates.relayThreads = threads;
  if (sondages !== null) updates.relayPolls = sondages;
  if (epingles !== null) updates.relayPins = epingles;
  if (modifierTopic !== null) updates.updateTopic = modifierTopic;

  if (Object.keys(updates).length === 0) {
    await interaction.editReply({
      embeds: [errorEmbed('Erreur', 'Aucune option de configuration spécifiée.')],
    });
    return;
  }

  const updated = await updateGroupConfig(groupId, updates as any);
  if (!updated) {
    await interaction.editReply({ embeds: [errorEmbed('Erreur', 'Pont introuvable.')] });
    return;
  }

  const configLines = [
    `📝 Texte : ${updated.relayText ? '✅' : '❌'}`,
    `🖼️ Images : ${updated.relayImages ? '✅' : '❌'}`,
    `📦 Embeds : ${updated.relayEmbeds ? '✅' : '❌'}`,
    `😀 Réactions : ${updated.relayReactions ? '✅' : '❌'}`,
    `✏️ Éditions : ${updated.relayEdits ? '✅' : '❌'}`,
    `🗑️ Suppressions : ${updated.relayDeletes ? '✅' : '❌'}`,
    `⚡ Actif : ${updated.enabled ? '✅' : '❌'}`,
    `🧵 Threads : ${updated.relayThreads ? '✅' : '❌'}`,
    `📊 Sondages : ${updated.relayPolls ? '✅' : '❌'}`,
    `📌 Épinglages : ${updated.relayPins ? '✅' : '❌'}`,
    `🏷️ Topic auto : ${updated.updateTopic ? '✅' : '❌'}`,
  ];

  const embed = successEmbed(
    '⚙️ Configuration mise à jour',
    `**Pont :** \`${groupId}\`\n\n${configLines.join('\n')}`,
  );

  await interaction.editReply({ embeds: [embed] });
}

export const linkCommand = { data, execute } satisfies SlashCommandDefinition;
