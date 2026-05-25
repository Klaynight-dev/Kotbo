import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from 'discord.js';
import { isNicknameProblematic, SAFE_NICKNAME, buildRenameReason, loadBannedWords } from '../services/nicknameModerationService.js';
import { errorEmbed, infoEmbed, COLORS } from '../utils/embeds.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Définition de la commande slash
// ---------------------------------------------------------------------------

export const data = new SlashCommandBuilder()
  .setName('verifpseudo')
  .setDescription('🔍 Vérifie et renomme tous les pseudos non conformes du serveur')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Nombre de membres traités par batch pour éviter les rate limits Discord. */
const BATCH_SIZE = 10;

/** Délai entre chaque batch (ms). Discord impose ~10 req/10s sur PATCH /members/:id, au-delà → HTTP 429 + risque de ban temporaire. */
const BATCH_DELAY_MS = 2_000;

/** Nombre max de pseudos renommés affichés en détail dans l'embed. */
const MAX_DISPLAYED = 25;

// ---------------------------------------------------------------------------
// Verrou par serveur — empêche les scans concurrents sur un même serveur
// qui doubleraient les requêtes API et provoqueraient un rate limit / ban.
// Chaque serveur a son propre bucket de rate limit Discord, donc des scans
// sur des serveurs différents en parallèle ne posent pas de problème.
// ---------------------------------------------------------------------------

const activeScans = new Set<string>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Renomme un membre si son pseudo est non conforme.
 * Retourne les infos du renommage, ou null si pas de problème.
 */
async function tryRenameMember(
  member: GuildMember,
  bannedWords: string[],
  botMember: GuildMember,
): Promise<{ member: GuildMember; originalName: string } | null> {
  // Ignorer les bots
  if (member.user.bot) return null;

  // Ignorer le propriétaire du serveur (impossible à renommer)
  if (member.guild.ownerId === member.id) return null;

  // Ignorer les membres dont le rôle est plus élevé que le bot
  if (member.roles.highest.position >= botMember.roles.highest.position) return null;

  // Pseudo effectif : nickname > globalName > username
  const effectiveName = member.nickname ?? member.user.globalName ?? member.user.username;
  if (!effectiveName) return null;

  // Déjà le pseudo safe ? On skip
  if (effectiveName === SAFE_NICKNAME) return null;

  if (!isNicknameProblematic(effectiveName, bannedWords)) return null;

  await member.setNickname(SAFE_NICKNAME, buildRenameReason(effectiveName));
  return { member, originalName: effectiveName };
}

// ---------------------------------------------------------------------------
// Exécution de la commande
// ---------------------------------------------------------------------------

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guild || !interaction.guildId) {
    await interaction.reply({
      embeds: [errorEmbed('Serveur requis', 'Cette commande ne peut être utilisée qu\'en serveur.')],
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  const guildId = interaction.guildId;

  // ── Verrou : un seul scan à la fois par serveur ──
  if (activeScans.has(guildId)) {
    await interaction.reply({
      embeds: [errorEmbed(
        'Scan déjà en cours',
        'Un scan de pseudos est déjà en cours ou s\'est terminé récemment sur ce serveur.\nAttends un moment avant d\'en relancer un.',
      )],
      flags: [MessageFlags.Ephemeral],
    });
    return;
  }

  activeScans.add(guildId);

  // Déclaration du collector hors du try pour pouvoir l'arrêter proprement
  let collector: any = null;

  try {
    // Réponse différée car l'opération est longue
    await interaction.deferReply();

    const guild = interaction.guild;

    // Vérification des permissions du bot
    const botMember = await guild.members.fetchMe().catch(() => null);
    if (!botMember?.permissions.has(PermissionFlagsBits.ManageNicknames)) {
      await interaction.editReply({
        embeds: [errorEmbed(
          'Permission manquante',
          'Le bot n\'a pas la permission **Gérer les pseudos** sur ce serveur.',
        )],
      });
      return;
    }

    // Chargement des mots bannis (global + serveur)
    const bannedWords = await loadBannedWords(guildId);
    if (bannedWords.length === 0) {
      await interaction.editReply({
        embeds: [infoEmbed(
          'Aucun mot banni configuré',
          'Aucune liste de mots bannis n\'est configurée pour ce serveur.\nAjoutez des mots via le **Dashboard** ou vérifiez la configuration.',
        )],
      });
      return;
    }

    // Récupération de tous les membres (force le fetch complet)
    await interaction.editReply({
      embeds: [infoEmbed('Scan en cours...', '⏳ Récupération des membres du serveur...')],
    });

    const members = await guild.members.fetch().catch(() => null);
    if (!members || members.size === 0) {
      await interaction.editReply({
        embeds: [errorEmbed('Erreur', 'Impossible de récupérer les membres du serveur.')],
      });
      return;
    }

    // Filtrer seulement les non-bots
    const humanMembers = members.filter((m) => !m.user.bot);
    const totalMembers = humanMembers.size;

    // Bouton pour arrêter le scan
    const stopButton = new ButtonBuilder()
      .setCustomId(`verifpseudo:stop:${interaction.id}`)
      .setLabel('Arrêter le scan')
      .setStyle(ButtonStyle.Danger);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(stopButton);

    const reply = await interaction.editReply({
      embeds: [infoEmbed(
        'Scan en cours...',
        `⏳ Vérification de **${totalMembers}** membre${totalMembers > 1 ? 's' : ''}...\nCela peut prendre un moment.`,
      )],
      components: [row],
    });

    let isAborted = false;

    // Collector pour le bouton Arrêter
    collector = reply.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 15 * 60 * 1000, // 15 minutes max
    });

    collector.on('collect', async (buttonInteraction) => {
      const member = buttonInteraction.member as GuildMember;
      const isAuthor = buttonInteraction.user.id === interaction.user.id;
      const hasPerm = member?.permissions.has(PermissionFlagsBits.Administrator);

      if (!isAuthor && !hasPerm) {
        await buttonInteraction.reply({
          embeds: [errorEmbed('Action refusée', 'Seul l\'auteur de la commande ou un membre Administrateur peut arrêter ce scan.')],
          flags: [MessageFlags.Ephemeral],
        });
        return;
      }

      isAborted = true;
      collector.stop('aborted');

      await buttonInteraction.reply({
        embeds: [infoEmbed('Scan annulé', 'Le scan de pseudos a été arrêté par l\'utilisateur.')],
        flags: [MessageFlags.Ephemeral],
      });
    });

    // Traitement par batches
    const memberArray = [...humanMembers.values()];
    const renamed: Array<{ tag: string; originalName: string }> = [];
    const errors: Array<{ tag: string; error: string }> = [];
    let processed = 0;

    for (let i = 0; i < memberArray.length; i += BATCH_SIZE) {
      if (isAborted) break;

      const batch = memberArray.slice(i, i + BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map((member) => tryRenameMember(member, bannedWords, botMember)),
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === 'fulfilled' && result.value) {
          renamed.push({
            tag: result.value.member.user.tag,
            originalName: result.value.originalName,
          });
        } else if (result.status === 'rejected') {
          errors.push({
            tag: batch[j]?.user?.tag ?? 'Inconnu',
            error: result.reason instanceof Error ? result.reason.message : 'Erreur inconnue',
          });
        }
      }

      processed += batch.length;

      if (isAborted) break;

      // Mise à jour de la progression
      if (i > 0 && i % (BATCH_SIZE * 5) === 0) {
        await interaction.editReply({
          embeds: [infoEmbed(
            'Scan en cours...',
            `⏳ **${processed}** / **${totalMembers}** membres vérifiés...\n🔄 **${renamed.length}** pseudo(s) renommé(s) jusqu'ici.`,
          )],
          components: [row],
        }).catch(() => null);
      }

      // Rate-limit entre les batches
      if (i + BATCH_SIZE < memberArray.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    if (collector && !collector.ended) {
      collector.stop('finished');
    }

    // Construction de l'embed de résultat final
    const embed = new EmbedBuilder()
      .setTimestamp()
      .setFooter({ text: `Kotbo • Vérification demandée par ${interaction.user.tag}` });

    if (isAborted) {
      embed
        .setColor(0xe76f51) // orange/red
        .setTitle('⏹️ Scan annulé')
        .setDescription(
          `Le scan de pseudos a été arrêté avant la fin.\n\n` +
          `• **Membres vérifiés** : ${processed} / ${totalMembers}\n` +
          `• **Pseudos renommés** : ${renamed.length}`,
        );
    } else if (renamed.length === 0) {
      embed
        .setColor(COLORS.success as number)
        .setTitle('✅ Aucun pseudo non conforme')
        .setDescription(
          `**${totalMembers}** membre${totalMembers > 1 ? 's' : ''} vérifié${totalMembers > 1 ? 's' : ''}, aucun pseudo problématique détecté.`,
        );
    } else {
      const displayedRenames = renamed.slice(0, MAX_DISPLAYED);
      const renamedList = displayedRenames
        .map((r) => `• \`${r.originalName}\` → \`${SAFE_NICKNAME}\` *(${r.tag})*`)
        .join('\n');

      const overflow = renamed.length > MAX_DISPLAYED
        ? `\n\n*... et ${renamed.length - MAX_DISPLAYED} autre(s) non affiché(s).*`
        : '';

      embed
        .setColor(0xf4a261)
        .setTitle('🔍 Vérification des pseudos terminée')
        .setDescription(
          `**${totalMembers}** membre${totalMembers > 1 ? 's' : ''} vérifié${totalMembers > 1 ? 's' : ''}.`,
        )
        .addFields(
          {
            name: `🔄 ${renamed.length} pseudo(s) renommé(s)`,
            value: renamedList + overflow,
            inline: false,
          },
        );
    }

    if (errors.length > 0) {
      const errorList = errors
        .slice(0, 10)
        .map((e) => `• ${e.tag}: ${e.error}`)
        .join('\n');
      const errorOverflow = errors.length > 10 ? `\n*... et ${errors.length - 10} autre(s).*` : '';

      embed.addFields({
        name: `⚠️ ${errors.length} erreur(s)`,
        value: errorList + errorOverflow,
        inline: false,
      });
    }

    // Log serveur
    logger.info(
      'VerifPseudo',
      `Scan ${isAborted ? 'annulé' : 'terminé'} sur "${guild.name}": ${processed} vérifiés, ${renamed.length} renommés, ${errors.length} erreurs`,
    );

    // Audit dashboard
    try {
      const prisma = (await import('../utils/db.js')).default;
      await prisma.dashboardAuditLog.create({
        data: {
          guildId: guild.id,
          channelId: interaction.channelId,
          user: interaction.user.tag,
          action: isAborted ? 'Vérification manuelle des pseudos (annulée)' : 'Vérification manuelle des pseudos',
          context: guild.name,
          module: 'Modération des pseudos',
          eventType: 'Manuel',
          details: `${processed} membres vérifiés, ${renamed.length} renommés, ${errors.length} erreurs`,
          dateIso: new Date(),
        },
      });
    } catch {
      logger.warn('VerifPseudo', 'Impossible de créer l\'audit log');
    }

    await interaction.editReply({ embeds: [embed], components: [] });
  } finally {
    // Cooldown de 5 secondes après la fin du scan pour éviter le spam immédiat
    setTimeout(() => {
      activeScans.delete(guildId);
    }, 5_000);
  }
}
