/**
 * Salons du module tickets, poses par la mise en route du module comme par la
 * mise en place guidee du serveur. Les deux entrees doivent produire la meme
 * arborescence et deposer les memes textes : elles passent donc par ici plutot
 * que d'ecrire chacune leur version.
 */
import { PermissionFlagsBits, type Guild, type OverwriteResolvable } from 'discord.js';
import { Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';
import type { BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import { type ProvisionedEntry, ensureCategory, ensureTextChannel } from '../core/channelProvisioningService.js';
import { ticketDefaultTexts } from './ticketService.js';

const TICKET_TEXT_FIELDS = [
  'ticketEmbedTitle',
  'ticketEmbedDesc',
  'ticketEmbedButtonText',
  'ticketWelcomeTitle',
  'ticketWelcomeDesc',
  'ticketWelcomeFooter',
  'ticketInactivityMessage',
] as const;

export type TicketProvisionOutcome = {
  panelChannelId: string;
};

/**
 * `items` et `data` sont remplis au fur et a mesure et appartiennent a
 * l'appelant : une interruption en cours de route doit pouvoir enregistrer ce
 * qui a deja ete cree, et rendre compte de ce qui a ete fait.
 */
export async function provisionTicketChannels(guild: Guild, input: {
  locale: BotLocale;
  reason: string;
  items: ProvisionedEntry[];
  data: Prisma.GuildUpdateInput;
  persist: () => Promise<void>;
  /**
   * Restreint le panneau a ce seul role au lieu de l'ouvrir a tous. Vient de la
   * mise en place guidee, ou le serveur entier est ferme a @everyone : un
   * panneau laisse ouvert y serait le seul salon visible avant verification.
   */
  panelViewerRoleId?: string | null;
}): Promise<TicketProvisionOutcome> {
  const { locale, reason, items, data, persist, panelViewerRoleId } = input;

  const config = await prisma.guild.findUnique({
    where: { id: guild.id },
    select: {
      ticketCategoryId: true,
      ticketChannelId: true,
      ticketLogChannelId: true,
      ticketEmbedTitle: true,
      ticketEmbedDesc: true,
      ticketEmbedButtonText: true,
      ticketWelcomeTitle: true,
      ticketWelcomeDesc: true,
      ticketWelcomeFooter: true,
      ticketInactivityMessage: true,
    },
  });

  // Les textes que l'admin n'a pas ecrits sont deposes maintenant, dans la
  // langue du serveur : la mise en route doit laisser des champs remplis et
  // modifiables. Ceux qu'il a ecrits ne sont jamais touches.
  const defaults = ticketDefaultTexts(locale);
  for (const field of TICKET_TEXT_FIELDS) {
    const current = config?.[field];
    if (typeof current !== 'string' || !current.trim()) {
      (data as Record<string, string>)[field] = defaults[field];
    }
  }

  const everyoneId = guild.roles.everyone.id;
  // Le refus pose sur @everyone s'applique aussi au bot : sans surcharge a son
  // nom, il ne verrait pas la categorie ni les tickets ouverts dedans des lors
  // qu'il n'est pas administrateur du serveur.
  const botId = guild.members.me?.id;
  const botOverwrite: OverwriteResolvable[] = botId
    ? [{
        id: botId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
        ]
      }]
    : [];

  // Fermee, et fermee au staff aussi : c'est elle qui rend prives les salons de
  // ticket ouverts dedans, chacun n'etant rouvert qu'a son auteur et au staff.
  // Une surcharge posee ici pour le role staff lui montrerait tous les tickets
  // d'un coup, ce que la prise en charge ticket par ticket evite.
  const category = await ensureCategory(guild, {
    key: 'category',
    existingId: config?.ticketCategoryId,
    name: m.setup_channel_tickets_category({}, { locale }),
    permissionOverwrites: [
      { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
      ...botOverwrite,
    ],
    reason,
  });
  items.push(category.entry);
  if (category.entry.created) data.ticketCategoryId = category.channel.id;

  // Seul salon de la categorie a etre rouvert a son public : ses propres
  // surcharges priment sur celles de la categorie, qui reste fermee.
  const panel = await ensureTextChannel(guild, {
    key: 'panelChannel',
    existingId: config?.ticketChannelId,
    name: m.setup_channel_tickets_panel({}, { locale }),
    parentId: category.channel.id,
    permissionOverwrites: [
      panelViewerRoleId
        ? { id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] }
        : {
            id: everyoneId,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            deny: [PermissionFlagsBits.SendMessages],
          },
      ...(panelViewerRoleId
        ? [{
            id: panelViewerRoleId,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            deny: [PermissionFlagsBits.SendMessages],
          }]
        : []),
      ...botOverwrite,
    ],
    reason,
  });
  items.push(panel.entry);
  if (panel.entry.created) data.ticketChannelId = panel.channel.id;

  const logs = await ensureTextChannel(guild, {
    key: 'logChannel',
    existingId: config?.ticketLogChannelId,
    name: m.setup_channel_tickets_logs({}, { locale }),
    parentId: category.channel.id,
    reason,
  });
  items.push(logs.entry);
  if (logs.entry.created) data.ticketLogChannelId = logs.channel.id;

  await persist();

  return { panelChannelId: panel.channel.id };
}
