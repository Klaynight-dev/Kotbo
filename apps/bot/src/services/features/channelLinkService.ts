import { type APIEmbed, type Client, type Message, type MessageReaction, type TextChannel, type NewsChannel, type ThreadChannel, type User, EmbedBuilder, PermissionFlagsBits, StickerFormatType, WebhookClient } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { COLORS } from '../../utils/embeds.js';
import { cache } from '../../utils/cache.js';
import { randomBytes } from 'node:crypto';
import type { ChannelLinkGroup, ChannelLinkGroupMember, ChannelLinkInvite } from '@prisma/client';
import { isGuildActivated } from '../../utils/activation.js';
import { refreshLinkGuestGuilds } from './channelLinkGuestService.js';
import { INVITE_SOURCE, recordBotInvite } from '../analytics/inviteService.js';

const TAG = 'ChannelLink';

export type LinkGroup = ChannelLinkGroup & { members: ChannelLinkGroupMember[] };
export type LinkMemberMode = 'BOTH' | 'SEND_ONLY' | 'RECEIVE_ONLY';
export type LinkRelayMode = 'WEBHOOK' | 'EMBED';

export const LINK_NEEDS_ACTIVATED_SIDE =
  "Au moins un des serveurs du pont doit disposer d'une clé d'activation Kotbo. " +
  "Les autres n'en ont pas besoin : ils passent en mode liaison seule.";

/**
 * Un pont est toujours l'extension d'une licence existante : le serveur qui
 * possède le code invite, les autres rejoignent sans code. Un pont dont aucun
 * membre n'est activé ne peut donc pas exister.
 */
function hasActivatedMember(guildIds: string[]): boolean {
  return guildIds.some((id) => isGuildActivated(id));
}

/**
 * Le mapping message source → messages relayés n'existe que pour propager les
 * éditions, les suppressions, les réactions et les épinglages. Quand le pont ne
 * relaie rien de tout cela, l'écrire reviendrait à conserver un journal des
 * messages sans qu'aucune fonctionnalité ne s'en serve : on s'en abstient.
 */
export function needsMessageMapping(group: ChannelLinkGroup): boolean {
  return group.relayEdits || group.relayDeletes || group.relayReactions || group.relayPins;
}

// ── Cache helpers ───────────────────────────────────────────

function groupsCacheKey(guildId: string, channelId: string) {
  return `channellinkgroups:${guildId}:${channelId}`;
}

export async function getGroupsForChannel(guildId: string, channelId: string): Promise<LinkGroup[]> {
  const key = groupsCacheKey(guildId, channelId);
  const cached = await cache.get<LinkGroup[]>(key);
  if (cached) return cached;

  const groups = await prisma.channelLinkGroup.findMany({
    where: {
      enabled: true,
      members: { some: { guildId, channelId, enabled: true } },
    },
    include: { members: true },
  });

  // Le cas majoritaire est "aucun pont". Le cacher évite Redis + SQL pour
  // chaque message publié dans un salon ordinaire.
  await cache.set(key, groups, groups.length > 0 ? 120 : 30);
  return groups;
}

export async function invalidateGroupCache(group: LinkGroup) {
  await Promise.all(group.members.map((m) => cache.delete(groupsCacheKey(m.guildId, m.channelId))));
}

async function loadGroup(groupId: string): Promise<LinkGroup | null> {
  return prisma.channelLinkGroup.findUnique({ where: { id: groupId }, include: { members: true } });
}

// ── Invite code generation ──────────────────────────────────

export function generateInviteCode(): string {
  return randomBytes(6).toString('hex').toUpperCase();
}

// ── Destinataires ───────────────────────────────────────────

/**
 * Les membres qui doivent recevoir ce qui vient d'être publié dans un salon.
 *
 * Remplace l'ancien `resolveRelay`, qui ne connaissait qu'une destination : un
 * pont a maintenant N participants, et l'émetteur est exclu de sa propre
 * diffusion. `mode` filtre les deux sens indépendamment - un membre
 * `RECEIVE_ONLY` n'émet jamais, un membre `SEND_ONLY` ne reçoit jamais.
 */
function resolveTargets(group: LinkGroup, guildId: string, channelId: string) {
  const sender = group.members.find((m) => m.guildId === guildId && m.channelId === channelId);
  if (!sender || !sender.enabled || sender.mode === 'RECEIVE_ONLY') return null;

  const targets = group.members.filter(
    (m) => m.id !== sender.id && m.enabled && m.mode !== 'SEND_ONLY',
  );
  if (targets.length === 0) return null;

  return { sender, targets };
}

function memberFor(group: LinkGroup, guildId: string, channelId: string) {
  return group.members.find((m) => m.guildId === guildId && m.channelId === channelId) ?? null;
}

// ── Correspondances de messages ─────────────────────────────

async function saveMessageMapping(
  group: LinkGroup,
  sourceMessageId: string,
  sourceChannelId: string,
  target: ChannelLinkGroupMember,
  relayedMessageId: string,
  webhookId?: string | null,
) {
  // Rien à conserver si le pont ne relaie ni édition, ni suppression, ni
  // réaction : il fonctionne alors sans laisser la moindre trace en base.
  if (!needsMessageMapping(group)) return;

  await prisma.channelLinkGroupMessage.upsert({
    where: {
      groupId_sourceMessageId_relayedChannelId: {
        groupId: group.id,
        sourceMessageId,
        relayedChannelId: target.channelId,
      },
    },
    update: { relayedMessageId, relayedGuildId: target.guildId, webhookId },
    create: {
      groupId: group.id,
      sourceMessageId,
      sourceChannelId,
      relayedMessageId,
      relayedChannelId: target.channelId,
      relayedGuildId: target.guildId,
      webhookId,
    },
  }).catch((err) => logger.warn(TAG, 'Impossible de sauvegarder le mapping message', err));
}

/**
 * Le message d'origine d'un message donné.
 *
 * Un identifiant peut désigner l'original ou l'une de ses copies : dans un pont
 * à plusieurs serveurs, passer d'une copie à une autre suppose de remonter
 * d'abord à l'original, qui est le seul point commun des deux.
 */
async function resolveOrigin(groupId: string, messageId: string, channelId: string) {
  const asCopy = await prisma.channelLinkGroupMessage.findFirst({
    where: { groupId, relayedMessageId: messageId, relayedChannelId: channelId },
  });
  if (asCopy) {
    return { messageId: asCopy.sourceMessageId, channelId: asCopy.sourceChannelId, isCopy: true };
  }

  const isSource = await prisma.channelLinkGroupMessage.findFirst({
    where: { groupId, sourceMessageId: messageId, sourceChannelId: channelId },
    select: { id: true },
  });
  if (isSource) return { messageId, channelId, isCopy: false };

  return null;
}

/** Toutes les incarnations d'un message dans le pont, salon par salon. */
async function messageLocations(groupId: string, originMessageId: string, originChannelId: string) {
  const copies = await prisma.channelLinkGroupMessage.findMany({
    where: { groupId, sourceMessageId: originMessageId },
  });

  const locations = new Map<string, { messageId: string; guildId: string | null; webhookId: string | null }>();
  locations.set(originChannelId, { messageId: originMessageId, guildId: null, webhookId: null });
  for (const copy of copies) {
    locations.set(copy.relayedChannelId, {
      messageId: copy.relayedMessageId,
      guildId: copy.relayedGuildId,
      webhookId: copy.webhookId,
    });
  }
  return locations;
}

// ── Invitations ─────────────────────────────────────────────

export async function createLinkInvite(opts: {
  guildId: string;
  channelId: string;
  createdByUserId: string;
  groupId?: string | null;
  memberMode?: LinkMemberMode;
  relayMode?: LinkRelayMode;
  relayText?: boolean;
  relayImages?: boolean;
  relayEmbeds?: boolean;
  relayReactions?: boolean;
  relayEdits?: boolean;
  relayDeletes?: boolean;
  relayThreads?: boolean;
  relayPolls?: boolean;
  relayPins?: boolean;
  maxUses?: number;
  expiresInMinutes?: number;
}): Promise<ChannelLinkInvite> {
  const code = generateInviteCode();
  const expiresAt = new Date(Date.now() + (opts.expiresInMinutes ?? 30) * 60 * 1000);

  return prisma.channelLinkInvite.create({
    data: {
      code,
      guildId: opts.guildId,
      channelId: opts.channelId,
      groupId: opts.groupId ?? null,
      memberMode: opts.memberMode ?? 'BOTH',
      relayMode: opts.relayMode ?? 'WEBHOOK',
      relayText: opts.relayText ?? true,
      relayImages: opts.relayImages ?? true,
      relayEmbeds: opts.relayEmbeds ?? false,
      relayReactions: opts.relayReactions ?? false,
      relayEdits: opts.relayEdits ?? true,
      relayDeletes: opts.relayDeletes ?? true,
      relayThreads: opts.relayThreads ?? false,
      relayPolls: opts.relayPolls ?? false,
      relayPins: opts.relayPins ?? true,
      maxUses: opts.maxUses ?? 1,
      expiresAt,
      createdByUserId: opts.createdByUserId,
    },
  });
}

/**
 * Accepte une invitation : le salon rejoint le pont du serveur invitant.
 *
 * Si l'invitation ne désigne pas encore de pont (premier usage du code), il est
 * créé à ce moment-là avec le salon invitant comme premier membre. Un même code
 * peut ainsi rassembler autant de serveurs que `maxUses` l'autorise, tous dans
 * le même pont.
 */
export async function acceptLinkInvite(opts: {
  code: string;
  targetGuildId: string;
  targetChannelId: string;
  updateTopic?: boolean;
  includeTopicLink?: boolean;
  client: Client;
}): Promise<{ group: LinkGroup; invite: ChannelLinkInvite } | { error: string }> {
  const invite = await prisma.channelLinkInvite.findUnique({ where: { code: opts.code } });

  if (!invite) return { error: 'Code d\'invitation invalide.' };
  if (invite.status !== 'PENDING') return { error: 'Cette invitation a déjà été utilisée ou révoquée.' };
  if (invite.expiresAt < new Date()) {
    await prisma.channelLinkInvite.update({ where: { id: invite.id }, data: { status: 'EXPIRED' } });
    return { error: 'Cette invitation a expiré.' };
  }
  if (invite.uses >= invite.maxUses) return { error: 'Cette invitation a atteint son nombre maximum d\'utilisations.' };

  if (invite.guildId === opts.targetGuildId && invite.channelId === opts.targetChannelId) {
    return { error: 'Impossible de lier un salon à lui-même.' };
  }

  let group = invite.groupId ? await loadGroup(invite.groupId) : null;

  if (group) {
    if (memberFor(group, opts.targetGuildId, opts.targetChannelId)) {
      return { error: 'Ce salon fait déjà partie de ce pont.' };
    }
    if (!hasActivatedMember([...group.members.map((m) => m.guildId), opts.targetGuildId])) {
      return { error: LINK_NEEDS_ACTIVATED_SIDE };
    }
  } else {
    if (!hasActivatedMember([invite.guildId, opts.targetGuildId])) {
      return { error: LINK_NEEDS_ACTIVATED_SIDE };
    }

    // Un code sans pont en ouvre un nouveau : sans cette garde, deux codes
    // successifs entre les deux mêmes salons créeraient deux ponts parallèles,
    // et chaque message partirait en double.
    const alreadyBridged = await prisma.channelLinkGroup.findFirst({
      where: {
        AND: [
          { members: { some: { guildId: invite.guildId, channelId: invite.channelId } } },
          { members: { some: { guildId: opts.targetGuildId, channelId: opts.targetChannelId } } },
        ],
      },
      select: { id: true },
    });
    if (alreadyBridged) return { error: 'Ces deux salons sont déjà reliés.' };
  }

  const shouldUpdateTopic = opts.updateTopic ?? true;
  const includeLink = opts.includeTopicLink ?? true;

  if (!group) {
    const inviterWebhookId = await createRelayWebhook(opts.client, invite.guildId, invite.channelId);
    const created = await prisma.channelLinkGroup.create({
      data: {
        ownerGuildId: invite.guildId,
        relayText: invite.relayText,
        relayImages: invite.relayImages,
        relayEmbeds: invite.relayEmbeds,
        relayReactions: invite.relayReactions,
        relayEdits: invite.relayEdits,
        relayDeletes: invite.relayDeletes,
        relayThreads: invite.relayThreads,
        relayPolls: invite.relayPolls,
        relayPins: invite.relayPins,
        updateTopic: shouldUpdateTopic,
        createdByUserId: invite.createdByUserId,
        members: {
          create: {
            guildId: invite.guildId,
            channelId: invite.channelId,
            mode: invite.direction === 'UNIDIRECTIONAL' ? 'SEND_ONLY' : 'BOTH',
            relayMode: invite.relayMode,
            webhookId: inviterWebhookId,
            addedByUserId: invite.createdByUserId,
          },
        },
      },
      include: { members: true },
    });
    group = created;
    await prisma.channelLinkInvite.update({ where: { id: invite.id }, data: { groupId: created.id } });
  }

  const targetWebhookId = await createRelayWebhook(opts.client, opts.targetGuildId, opts.targetChannelId);
  await prisma.channelLinkGroupMember.create({
    data: {
      groupId: group.id,
      guildId: opts.targetGuildId,
      channelId: opts.targetChannelId,
      mode: invite.memberMode,
      relayMode: invite.relayMode,
      webhookId: targetWebhookId,
      addedByUserId: invite.createdByUserId,
    },
  });

  const uses = invite.uses + 1;
  await prisma.channelLinkInvite.update({
    where: { id: invite.id },
    data: { status: uses >= invite.maxUses ? 'ACCEPTED' : 'PENDING', uses },
  });

  const refreshed = (await loadGroup(group.id))!;
  await invalidateGroupCache(refreshed);

  // Le serveur qui vient d'accepter sans code devient un serveur invité : le
  // cache doit s'ouvrir avant le premier message, sinon la garde d'activation
  // continuerait de tout jeter.
  await refreshLinkGuestGuilds();

  if (refreshed.updateTopic) await refreshGroupTopics(opts.client, refreshed, includeLink);

  return { group: refreshed, invite };
}

// ── Création directe (admin des serveurs concernés) ─────────

export async function createDirectGroup(opts: {
  ownerGuildId: string;
  ownerChannelId: string;
  targets: { guildId: string; channelId: string; mode?: LinkMemberMode }[];
  createdByUserId: string;
  name?: string | null;
  ownerMode?: LinkMemberMode;
  relayMode?: LinkRelayMode;
  relayThreads?: boolean;
  relayPolls?: boolean;
  relayPins?: boolean;
  updateTopic?: boolean;
  includeTopicLink?: boolean;
  client: Client;
}): Promise<LinkGroup | { error: string }> {
  const seen = new Set([`${opts.ownerGuildId}:${opts.ownerChannelId}`]);
  const targets = [];
  for (const target of opts.targets) {
    const key = `${target.guildId}:${target.channelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(target);
  }

  if (targets.length === 0) return { error: 'Il faut au moins un salon distinct à relier.' };

  const guildIds = [opts.ownerGuildId, ...targets.map((t) => t.guildId)];
  if (!hasActivatedMember(guildIds)) return { error: LINK_NEEDS_ACTIVATED_SIDE };

  const alreadyLinked = await prisma.channelLinkGroupMember.findFirst({
    where: {
      guildId: opts.ownerGuildId,
      channelId: opts.ownerChannelId,
      group: { members: { some: { OR: targets.map((t) => ({ guildId: t.guildId, channelId: t.channelId })) } } },
    },
  });
  if (alreadyLinked) return { error: 'Un pont relie déjà ce salon à l\'un des salons choisis.' };

  const shouldUpdateTopic = opts.updateTopic ?? true;
  const relayMode = opts.relayMode ?? 'WEBHOOK';

  const members = await Promise.all(
    [{ guildId: opts.ownerGuildId, channelId: opts.ownerChannelId, mode: opts.ownerMode }, ...targets].map(
      async (member) => ({
        guildId: member.guildId,
        channelId: member.channelId,
        mode: member.mode ?? 'BOTH',
        relayMode,
        webhookId: await createRelayWebhook(opts.client, member.guildId, member.channelId),
        addedByUserId: opts.createdByUserId,
      }),
    ),
  );

  const group = await prisma.channelLinkGroup.create({
    data: {
      name: opts.name ?? null,
      ownerGuildId: opts.ownerGuildId,
      relayReactions: true,
      relayThreads: opts.relayThreads ?? false,
      relayPolls: opts.relayPolls ?? false,
      relayPins: opts.relayPins ?? true,
      updateTopic: shouldUpdateTopic,
      createdByUserId: opts.createdByUserId,
      members: { create: members },
    },
    include: { members: true },
  });

  await invalidateGroupCache(group);
  await refreshLinkGuestGuilds();

  if (shouldUpdateTopic) await refreshGroupTopics(opts.client, group, opts.includeTopicLink ?? true);

  return group;
}

export async function addGroupMember(opts: {
  groupId: string;
  guildId: string;
  channelId: string;
  addedByUserId: string;
  mode?: LinkMemberMode;
  relayMode?: LinkRelayMode;
  includeTopicLink?: boolean;
  client: Client;
}): Promise<LinkGroup | { error: string }> {
  const group = await loadGroup(opts.groupId);
  if (!group) return { error: 'Pont introuvable.' };

  if (memberFor(group, opts.guildId, opts.channelId)) {
    return { error: 'Ce salon fait déjà partie du pont.' };
  }
  if (!hasActivatedMember([...group.members.map((m) => m.guildId), opts.guildId])) {
    return { error: LINK_NEEDS_ACTIVATED_SIDE };
  }

  const webhookId = await createRelayWebhook(opts.client, opts.guildId, opts.channelId);
  await prisma.channelLinkGroupMember.create({
    data: {
      groupId: group.id,
      guildId: opts.guildId,
      channelId: opts.channelId,
      mode: opts.mode ?? 'BOTH',
      relayMode: opts.relayMode ?? 'WEBHOOK',
      webhookId,
      addedByUserId: opts.addedByUserId,
    },
  });

  const refreshed = (await loadGroup(group.id))!;
  await invalidateGroupCache(refreshed);
  await refreshLinkGuestGuilds();

  if (refreshed.updateTopic) await refreshGroupTopics(opts.client, refreshed, opts.includeTopicLink ?? true);

  return refreshed;
}

/**
 * Retire un salon du pont. Un pont réduit à un seul salon n'a plus d'objet : il
 * est supprimé plutôt que laissé en place à ne rien relayer.
 */
export async function removeGroupMember(groupId: string, memberId: string, client?: Client): Promise<LinkGroup | null> {
  const group = await loadGroup(groupId);
  if (!group) return null;

  const member = group.members.find((m) => m.id === memberId);
  if (!member) return group;

  await prisma.channelLinkGroupMember.delete({ where: { id: memberId } }).catch(() => null);
  await invalidateGroupCache(group);

  if (client && group.updateTopic) await clearChannelLinkTopic(client, member.guildId, member.channelId);

  // Les correspondances de messages du salon retiré n'ont plus de destinataire.
  await prisma.channelLinkGroupMessage
    .deleteMany({ where: { groupId, OR: [{ sourceChannelId: member.channelId }, { relayedChannelId: member.channelId }] } })
    .catch(() => null);
  await prisma.channelLinkGroupThread
    .deleteMany({ where: { groupId, OR: [{ sourceChannelId: member.channelId }, { relayedChannelId: member.channelId }] } })
    .catch(() => null);

  if (group.members.length - 1 < 2) {
    await removeGroup(groupId, client);
    return null;
  }

  const refreshed = (await loadGroup(groupId))!;
  await refreshLinkGuestGuilds();
  if (client && refreshed.updateTopic) await refreshGroupTopics(client, refreshed, true);

  return refreshed;
}

// ── Webhooks ────────────────────────────────────────────────

async function createRelayWebhook(
  client: Client,
  guildId: string,
  channelId: string,
): Promise<string | null> {
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return null;

    const channel = guild.channels.cache.get(channelId);
    if (!channel || !('createWebhook' in channel)) return null;

    const textChannel = channel as TextChannel | NewsChannel;

    const existingWebhooks = await textChannel.fetchWebhooks();
    const existing = existingWebhooks.find(
      (w) => w.owner?.id === client.user!.id && w.name === 'Kotbo Link Relay',
    );
    if (existing) return existing.id;

    const webhook = await textChannel.createWebhook({
      name: 'Kotbo Link Relay',
      reason: 'Cross-server channel link relay',
    });

    return webhook.id;
  } catch (err) {
    logger.warn(TAG, `Impossible de créer le webhook relay pour ${guildId}/${channelId}`, err);
    return null;
  }
}

/**
 * Le webhook par lequel un membre reçoit, en le créant si le pont ne l'a pas
 * encore obtenu.
 *
 * Sans lui, le relais retombe sur l'embed signé par le bot - et un message posté
 * par le bot n'affiche les emojis d'un autre serveur que s'il a la permission
 * « Utiliser des emojis externes » dans le salon, sans quoi ils s'affichent en
 * texte brut `<:nom:123>`. Un webhook, lui, les rend toujours : mieux vaut le
 * rattraper ici que laisser le pont se dégrader en silence.
 */
const WEBHOOK_RETRY_DELAY_MS = 10 * 60 * 1000;

// Un salon où le bot n'a pas le droit de créer de webhook échouerait à chaque
// message : deux appels Discord et un avertissement par message relayé. On note
// l'échec et on laisse passer un moment avant de réessayer.
const webhookCreationFailures = new Map<string, number>();

async function ensureTargetWebhookId(
  client: Client,
  group: LinkGroup,
  target: ChannelLinkGroupMember,
): Promise<string | null> {
  if (target.relayMode !== 'WEBHOOK') return null;
  if (target.webhookId) return target.webhookId;

  const failedAt = webhookCreationFailures.get(target.channelId);
  if (failedAt !== undefined) {
    if (Date.now() - failedAt < WEBHOOK_RETRY_DELAY_MS) return null;
    webhookCreationFailures.delete(target.channelId);
  }

  const webhookId = await createRelayWebhook(client, target.guildId, target.channelId);
  if (!webhookId) {
    webhookCreationFailures.set(target.channelId, Date.now());
    logger.warn(
      TAG,
      `Aucun webhook pour ${target.guildId}/${target.channelId} (permission Gérer les webhooks ?) : ` +
        'le relais repasse en embed, et les emojis externes peuvent y sortir en texte brut.',
    );
    return null;
  }

  webhookCreationFailures.delete(target.channelId);

  await prisma.channelLinkGroupMember.update({ where: { id: target.id }, data: { webhookId } })
    .catch((err) => logger.warn(TAG, `Impossible d'enregistrer le webhook de ${target.channelId}`, err));
  await invalidateGroupCache(group);
  target.webhookId = webhookId;

  return webhookId;
}

async function getWebhookClient(destChannel: TextChannel, webhookId: string): Promise<WebhookClient | null> {
  try {
    const webhooks = await destChannel.fetchWebhooks();
    const webhook = webhooks.get(webhookId);
    if (!webhook?.token) return null;
    return new WebhookClient({ id: webhook.id, token: webhook.token });
  } catch {
    return null;
  }
}

// ── Topics ──────────────────────────────────────────────────

const TOPIC_MARKER_START = '🔗 ──── Kotbo Link ────';
const TOPIC_MARKER_END = '──── Kotbo Link 🔗';
const TOPIC_MAX_LENGTH = 1024;

function stripLinkTopic(topic: string): string {
  const regex = new RegExp(
    `\\n?${TOPIC_MARKER_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${TOPIC_MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`,
    'g',
  );
  // L'ancien pont posait aussi l'invitation seule, hors marqueurs : sans ce
  // second passage, elle resterait indéfiniment sous le bloc réécrit.
  return topic.replace(regex, '').replace(/\n?🔗 https:\/\/discord\.gg\/\S+/g, '').trim();
}

/**
 * Réécrit le bloc de description de chaque salon du pont.
 *
 * Le bloc listait l'unique salon d'en face ; il énumère maintenant tous les
 * autres participants. Comme la description Discord est plafonnée, la liste est
 * tronquée plutôt que refusée en bloc par l'API.
 */
export async function refreshGroupTopics(client: Client, group: LinkGroup, includeLink = true): Promise<void> {
  await Promise.all(
    group.members.map(async (member) => {
      try {
        const guild = client.guilds.cache.get(member.guildId);
        const channel = guild?.channels.cache.get(member.channelId);
        if (!guild || !channel || !('setTopic' in channel)) return;

        const others = group.members.filter((m) => m.id !== member.id);
        const lines: string[] = [TOPIC_MARKER_START];
        lines.push(group.name ? `${group.name} - ${others.length} salon(s) liés` : `Lié avec ${others.length} salon(s)`);

        for (const other of others) {
          if (other.guildId === member.guildId) {
            lines.push(`• <#${other.channelId}>`);
            continue;
          }

          const otherGuild = client.guilds.cache.get(other.guildId);
          const inviteUrl = includeLink ? await createTopicInvite(client, guild.name, other) : null;
          lines.push(`• ${otherGuild?.name ?? other.guildId}${inviteUrl ? ` - ${inviteUrl}` : ''}`);
        }

        lines.push(`Par <@${group.createdByUserId}>`);
        lines.push(TOPIC_MARKER_END);

        const textChannel = channel as TextChannel;
        const cleanTopic = stripLinkTopic(textChannel.topic ?? '');

        let block = lines.join('\n');
        // Seules les lignes de salons sont sacrifiables : en dessous de cinq
        // lignes il ne reste que les marqueurs, l'en-tête et la signature.
        while (block.length > TOPIC_MAX_LENGTH && lines.length > 4) {
          lines.splice(lines.length - 3, 1);
          block = lines.join('\n');
        }

        const newTopic = cleanTopic ? `${cleanTopic}\n${block}` : block;
        await textChannel.setTopic(newTopic.slice(0, TOPIC_MAX_LENGTH)).catch((err) =>
          logger.warn(TAG, `Impossible de mettre à jour le topic de ${member.channelId}`, err),
        );
      } catch (err) {
        logger.warn(TAG, `Erreur mise à jour topic ${member.guildId}/${member.channelId}`, err);
      }
    }),
  );
}

/**
 * L'invitation permanente affichée dans la description des salons du pont.
 *
 * Chaque salon liste maintenant tous les autres : en créer une à chaque
 * réécriture reviendrait à en produire N x (N-1) par modification du pont, et à
 * autant de lignes dans les statistiques d'invitation. On réutilise donc celle
 * que le bot a déjà posée sur le salon, comme le fait `createRelayWebhook`.
 */
async function createTopicInvite(client: Client, forGuildName: string, member: ChannelLinkGroupMember): Promise<string | null> {
  try {
    const guild = client.guilds.cache.get(member.guildId);
    const channel = guild?.channels.cache.get(member.channelId);
    if (!channel || !('createInvite' in channel) || typeof channel.createInvite !== 'function') return null;

    const existing = await (channel as TextChannel).fetchInvites().catch(() => null);
    const reusable = existing?.find(
      (inv) => inv.inviterId === client.user!.id && inv.maxAge === 0 && inv.maxUses === 0,
    );
    if (reusable) return reusable.url;

    const invite = await channel.createInvite({
      maxAge: 0,
      maxUses: 0,
      reason: 'Kotbo Link: invitation pour la description des salons liés',
    });
    // L'invitation vit sur le serveur lié mais s'affiche ailleurs : sa provenance est le salon qui l'affiche.
    await recordBotInvite(invite, INVITE_SOURCE.channelLink(forGuildName));
    return invite.url;
  } catch (err) {
    logger.warn(TAG, `Impossible de créer l'invitation Discord pour ${member.guildId}/${member.channelId}`, err);
    return null;
  }
}

async function clearChannelLinkTopic(client: Client, guildId: string, channelId: string): Promise<void> {
  try {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return;
    const channel = guild.channels.cache.get(channelId);
    if (!channel || !('setTopic' in channel)) return;

    const textChannel = channel as TextChannel;
    const cleanTopic = stripLinkTopic(textChannel.topic ?? '');

    await textChannel.setTopic(cleanTopic || null).catch((err) =>
      logger.warn(TAG, `Impossible de nettoyer le topic de ${channelId}`, err),
    );
  } catch (err) {
    logger.warn(TAG, `Erreur nettoyage topic ${guildId}/${channelId}`, err);
  }
}

// ── Permissions du relais ───────────────────────────────────

type RelayPermission = { flag: bigint; key: string; label: string };

const RELAY_BOT_PERMISSIONS: RelayPermission[] = [
  { flag: PermissionFlagsBits.ViewChannel, key: 'ViewChannel', label: 'Voir le salon' },
  { flag: PermissionFlagsBits.SendMessages, key: 'SendMessages', label: 'Envoyer des messages' },
  { flag: PermissionFlagsBits.EmbedLinks, key: 'EmbedLinks', label: 'Intégrer des liens' },
  { flag: PermissionFlagsBits.AttachFiles, key: 'AttachFiles', label: 'Joindre des fichiers' },
];

const RELAY_WEBHOOK_PERMISSION: RelayPermission =
  { flag: PermissionFlagsBits.ManageWebhooks, key: 'ManageWebhooks', label: 'Gérer les webhooks' };

/**
 * Emojis et stickers d'un autre serveur, dans un salon qui reçoit par webhook.
 *
 * Un webhook n'a pas de rôle : Discord lui applique les permissions d'@everyone
 * dans le salon où il publie. Sans celles-ci, l'API retire l'emoji du message et
 * n'en laisse que le raccourci `:nom:` - le pont a bien transmis, c'est Discord
 * qui a nettoyé. En mode embed c'est le bot qui publie, la même permission est
 * donc demandée à son propre rôle.
 */
const RELAY_EXTERNAL_PERMISSIONS: RelayPermission[] = [
  { flag: PermissionFlagsBits.UseExternalEmojis, key: 'UseExternalEmojis', label: 'Utiliser des emojis externes' },
  { flag: PermissionFlagsBits.UseExternalStickers, key: 'UseExternalStickers', label: 'Utiliser des stickers externes' },
];

const RELAY_THREAD_PERMISSIONS: RelayPermission[] = [
  { flag: PermissionFlagsBits.CreatePublicThreads, key: 'CreatePublicThreads', label: 'Créer des fils publics' },
  { flag: PermissionFlagsBits.SendMessagesInThreads, key: 'SendMessagesInThreads', label: 'Envoyer des messages dans les fils' },
];

const RELAY_PIN_PERMISSION: RelayPermission =
  { flag: PermissionFlagsBits.ManageMessages, key: 'ManageMessages', label: 'Gérer les messages' };

export type MemberPermissionIssues = {
  memberId: string;
  guildId: string;
  channelId: string;
  channelMissing: boolean;
  bot: RelayPermission[];
  everyone: RelayPermission[];
};

/**
 * Ce qui manque à chaque salon du pont pour relayer complètement.
 *
 * Le pont ne peut rien y faire lui-même : ces droits appartiennent aux
 * administrateurs des serveurs reliés. Le rôle de cette fonction est qu'ils
 * n'aient pas à les deviner devant un emoji qui arrive en `:nom:`.
 */
export function inspectRelayPermissions(client: Client, group: LinkGroup): MemberPermissionIssues[] {
  const issues: MemberPermissionIssues[] = [];

  for (const member of group.members) {
    // Un serveur absent du cache n'est pas un serveur perdu : il peut vivre sur
    // un autre shard, où ce processus ne voit ni ses salons ni ses rôles.
    // Annoncer un salon introuvable serait alors une fausse alerte.
    const guild = client.guilds.cache.get(member.guildId);
    if (!guild) continue;

    const channel = guild.channels.cache.get(member.channelId);
    if (!channel || !channel.isTextBased()) {
      issues.push({
        memberId: member.id,
        guildId: member.guildId,
        channelId: member.channelId,
        channelMissing: true,
        bot: [],
        everyone: [],
      });
      continue;
    }

    const expectedBot = [...RELAY_BOT_PERMISSIONS];
    if (member.relayMode === 'WEBHOOK') expectedBot.push(RELAY_WEBHOOK_PERMISSION);
    else expectedBot.push(...RELAY_EXTERNAL_PERMISSIONS);
    if (group.relayThreads) expectedBot.push(...RELAY_THREAD_PERMISSIONS);
    if (group.relayPins) expectedBot.push(RELAY_PIN_PERMISSION);

    const botPermissions = guild.members.me ? channel.permissionsFor(guild.members.me) : null;
    const bot = botPermissions
      ? expectedBot.filter((permission) => !botPermissions.has(permission.flag))
      : [];

    const everyonePermissions = channel.permissionsFor(guild.roles.everyone);
    const everyone = member.relayMode === 'WEBHOOK' && everyonePermissions
      ? RELAY_EXTERNAL_PERMISSIONS.filter((permission) => !everyonePermissions.has(permission.flag))
      : [];

    if (bot.length > 0 || everyone.length > 0) {
      issues.push({
        memberId: member.id,
        guildId: member.guildId,
        channelId: member.channelId,
        channelMissing: false,
        bot,
        everyone,
      });
    }
  }

  return issues;
}

// ── Mentions de masse ───────────────────────────────────────

const MASS_MENTION = /@(everyone|here)/g;

/**
 * Rend inoffensive une mention de masse qui traverse le pont.
 *
 * `allowedMentions: { parse: [] }` suffit à empêcher la notification, mais il
 * faut le repasser à chaque envoi : un seul oubli, aujourd'hui ou dans une
 * modification future, et un serveur relié notifierait toute une communauté qui
 * ne lui a rien demandé - un serveur en liaison seule y compris, alors qu'il
 * n'est là que pour faire circuler des messages. L'espace de largeur nulle
 * neutralise la mention dans la chaîne elle-même : le texte se lit à
 * l'identique, et plus rien en aval ne peut la transformer en notification.
 */
export function neutralizeMassMentions(text: string): string {
  return text.replace(MASS_MENTION, '@\u200b$1');
}

// ── Emoji et stickers ───────────────────────────────────────

const CUSTOM_EMOJI_MARKUP = /<a?:(\w+):(\d+)>/g;
const EMOJI_STRIP_WARNING_DELAY_MS = 10 * 60 * 1000;
const EMOJI_STRIP_MEMORY_MS = 24 * 60 * 60 * 1000;
const EMOJI_IMAGE_FALLBACK_LIMIT = 5;

// Discord refuse un message au-dela de dix pieces jointes, et refuse le message
// entier : les images d'emoji, qui sont un pis-aller, cedent la place aux
// fichiers du message plutot que de le faire echouer.
const DISCORD_MAX_ATTACHMENTS = 10;

/**
 * Salons où Discord a été vu retirer des emojis, et dernier avertissement émis.
 *
 * L'observation prime sur la déduction : si un salon a réellement vu ses emojis
 * disparaître, le pont le traite comme tel même quand les permissions disent le
 * contraire.
 *
 * La mémoire dure un jour, et se renouvelle d'elle-même tant que le salon
 * continue de retirer des emojis - un message qui mêle texte et emojis part
 * toujours tel quel, donc le constat se refait tout seul. Quand le droit est
 * rétabli, plus rien ne la renouvelle et elle s'efface : le rendu natif revient
 * sans redémarrage ni intervention.
 */
const emojiStripObservations = new Map<string, { lastSeen: number; lastWarned: number }>();

function emojisRecentlyStripped(channelId: string): boolean {
  const observation = emojiStripObservations.get(channelId);
  if (!observation) return false;

  if (Date.now() - observation.lastSeen > EMOJI_STRIP_MEMORY_MS) {
    emojiStripObservations.delete(channelId);
    return false;
  }
  return true;
}

/**
 * Le salon de destination accepte-t-il les emojis d'un autre serveur ?
 *
 * En mode webhook la question se pose pour @everyone, dont le webhook emprunte
 * les droits ; en mode embed, pour le bot lui-même, qui publie en son nom. Dans
 * le doute - salon hors de ce shard, rôle introuvable - on répond oui : mieux
 * vaut laisser passer le message tel quel que le transformer sans raison.
 */
function externalEmojisAllowed(client: Client, target: ChannelLinkGroupMember): boolean {
  // Ce que Discord a fait vaut mieux que ce qu'on déduit des permissions : si le
  // salon a déjà vu ses emojis retirés, la question est tranchée, quelle que
  // soit la raison - y compris une règle que le pont ne connaîtrait pas.
  if (emojisRecentlyStripped(target.channelId)) return false;

  const guild = client.guilds.cache.get(target.guildId);
  const channel = guild?.channels.cache.get(target.channelId);
  if (!guild || !channel?.isTextBased()) return true;

  const actor = target.relayMode === 'WEBHOOK' ? guild.roles.everyone : guild.members.me;
  if (!actor) return true;

  return channel.permissionsFor(actor)?.has(PermissionFlagsBits.UseExternalEmojis) ?? true;
}

/**
 * Repli en image pour les emojis qu'un salon refuse d'afficher.
 *
 * Quand le salon d'arrivée refuse les emojis d'ailleurs, Discord ne refuse pas
 * le message : il en retire l'emoji et n'en laisse que `:nom:`. Le pont joint
 * alors l'image de l'emoji, que rien ne bride.
 *
 * Le texte n'est retiré que si le message ne contenait rien d'autre que des
 * emojis : là, l'image le remplace exactement. Au milieu d'une phrase, elle
 * arrive sous le texte et ne peut pas prendre la place de l'emoji - le message
 * part donc inchangé, avec les images en complément. Ce choix a un second
 * effet : ces messages continuent d'être nettoyés par Discord, donc le pont
 * continue de constater le blocage et n'oublie pas ce salon.
 */
function buildEmojiImageFallback(
  client: Client,
  target: ChannelLinkGroupMember,
  content: string,
): { content: string; files: StickerFile[] } | null {
  if (!content) return null;

  const matches = [...content.matchAll(CUSTOM_EMOJI_MARKUP)];
  if (matches.length === 0) return null;
  if (externalEmojisAllowed(client, target)) return null;

  // Un emoji du serveur d'arrivée n'est pas externe : il s'affiche sans droit
  // particulier, et le remplacer par son image serait une perte.
  const guild = client.guilds.cache.get(target.guildId);
  const external = matches.filter((match) => !guild?.emojis.cache.has(match[2]!));
  if (external.length === 0) return null;

  // Le même emoji répété ne vaut qu'une image : deux pièces jointes identiques
  // n'apprendraient rien de plus au lecteur.
  const unique = [...new Map(external.map((match) => [match[2]!, match])).values()];

  const files = unique.slice(0, EMOJI_IMAGE_FALLBACK_LIMIT).map((match) => {
    const extension = match[0].startsWith('<a:') ? 'gif' : 'png';
    return {
      attachment: `https://cdn.discordapp.com/emojis/${match[2]}.${extension}?size=64`,
      name: `${match[1]}.${extension}`,
    };
  });

  // Le texte ne disparaît que si les images le remplacent vraiment : ni emoji du
  // serveur d'arrivée, qui lui s'affiche, ni emoji laissé de côté par le plafond.
  const emojisOnly =
    external.length === matches.length
    && unique.length === files.length
    && content.replace(CUSTOM_EMOJI_MARKUP, '').trim().length === 0;

  return { content: emojisOnly ? '' : content, files };
}

/**
 * Compare ce que le pont a envoyé à ce que Discord a réellement enregistré.
 *
 * Un emoji personnalisé que l'expéditeur n'a pas le droit d'utiliser n'est pas
 * refusé : l'API le remplace silencieusement par son raccourci `:nom:`. Le pont
 * croit donc avoir relayé le message, et rien ne distingue ce cas d'un vrai
 * problème de rendu. On regarde ce qui est revenu, et on le dit une fois par
 * salon et par tranche de dix minutes.
 */
function warnOnStrippedEmojis(
  client: Client,
  target: ChannelLinkGroupMember,
  sentContent: string,
  storedContent: string | null | undefined,
): void {
  if (!sentContent || typeof storedContent !== 'string') return;

  const stripped = [...sentContent.matchAll(CUSTOM_EMOJI_MARKUP)]
    .filter((match) => !storedContent.includes(match[0]!))
    .map((match) => match[1]!);
  if (stripped.length === 0) return;

  const now = Date.now();
  const observation = emojiStripObservations.get(target.channelId) ?? { lastSeen: 0, lastWarned: 0 };
  observation.lastSeen = now;
  emojiStripObservations.set(target.channelId, observation);

  if (now - observation.lastWarned < EMOJI_STRIP_WARNING_DELAY_MS) return;
  observation.lastWarned = now;

  const guild = client.guilds.cache.get(target.guildId);
  const channel = guild?.channels.cache.get(target.channelId);
  const textChannel = channel?.isTextBased() ? channel : null;

  // Les deux états sont journalisés : si les emojis disparaissent alors
  // qu'@everyone a le droit, c'est que Discord regarde ailleurs, et la ligne le
  // dira au lieu de laisser conclure à tort.
  const describe = (permissions: { has: (flag: bigint) => boolean } | null) =>
    permissions ? (permissions.has(PermissionFlagsBits.UseExternalEmojis) ? 'accordée' : 'refusée') : 'inconnue';

  const everyoneState = describe(guild && textChannel ? textChannel.permissionsFor(guild.roles.everyone) : null);
  const botState = describe(guild?.members.me && textChannel ? textChannel.permissionsFor(guild.members.me) : null);

  logger.warn(
    TAG,
    `Discord a retiré ${stripped.length} emoji(s) externe(s) du message relayé vers ` +
      `${guild?.name ?? target.guildId}/#${textChannel?.name ?? target.channelId} : ${stripped.join(', ')}. ` +
      `« Utiliser des emojis externes » sur ce salon - @everyone : ${everyoneState}, bot : ${botState}. ` +
      "Un webhook publie avec les droits d'@everyone.",
  );
}

/**
 * Un emoji personnalisé, écrit pour un autre serveur.
 *
 * Le préfixe `a:` n'est pas décoratif : sans lui, un emoji animé s'affiche comme
 * une image cassée chez le destinataire. Discord ne donne pas toujours ce drapeau
 * dans les données d'un sondage, d'où le repli sur le cache du bot.
 */
function formatCustomEmoji(
  emoji: { id?: string | null; name?: string | null; animated?: boolean | null } | null | undefined,
  client: Client,
): string {
  if (!emoji?.name) return '';
  if (!emoji.id) return emoji.name;

  const animated = emoji.animated ?? client.emojis.cache.get(emoji.id)?.animated ?? false;
  return `<${animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;
}

type StickerFile = { attachment: string; name: string };

/**
 * Les stickers d'un message, prêts à être relayés.
 *
 * L'API n'autorise pas un webhook à envoyer un sticker : le pont relaie donc son
 * image. Les stickers Lottie n'en ont pas - ce sont des animations vectorielles -
 * et seul leur nom peut passer. Ils suivent le relais des images : un sticker est
 * une image, et un message qui n'en contenait qu'un était jusqu'ici abandonné
 * faute de contenu à envoyer.
 */
function readStickers(message: Message, group: ChannelLinkGroup): { files: StickerFile[]; note: string } {
  if (!group.relayImages) return { files: [], note: '' };

  const files: StickerFile[] = [];
  const names: string[] = [];

  for (const sticker of message.stickers.values()) {
    if (sticker.format === StickerFormatType.Lottie) {
      names.push(sticker.name);
      continue;
    }
    const extension = sticker.format === StickerFormatType.GIF ? 'gif' : 'png';
    const safeName = sticker.name.replace(/[^\w.-]+/g, '_') || 'sticker';
    files.push({ attachment: sticker.url, name: `${safeName}.${extension}` });
  }

  return { files, note: names.map((name) => `*[sticker : ${name}]*`).join('\n') };
}

// ── Messages transférés ─────────────────────────────────────

type ForwardedAttachment = { url: string; name: string; isImage: boolean };

/**
 * Un message transféré (bouton « Transférer » de Discord) ne porte ni texte ni
 * pièce jointe qui lui soient propres : tout son contenu vit dans
 * `messageSnapshots`. Le pont ne lisait que `content`/`attachments`, n'avait
 * donc rien à envoyer, et l'API rejetait le message vide : côté utilisateur, le
 * transfert disparaissait sans un mot.
 */
function readForwardedContent(message: Message, group: ChannelLinkGroup) {
  const texts: string[] = [];
  const attachments: ForwardedAttachment[] = [];
  const embeds: APIEmbed[] = [];

  for (const snapshot of message.messageSnapshots.values()) {
    if (group.relayText && snapshot.content) texts.push(snapshot.content);

    if (group.relayImages) {
      for (const file of snapshot.attachments.values()) {
        attachments.push({
          url: file.url,
          name: file.name ?? 'file',
          isImage: file.contentType?.startsWith('image/') ?? false,
        });
      }
    }

    if (group.relayEmbeds) {
      for (const embed of snapshot.embeds) embeds.push({ ...embed.data });
    }
  }

  return { text: texts.join('\n\n'), attachments, embeds };
}

const FORWARD_HEADER = '↪ *Message transféré*';

// ── Relais des messages ─────────────────────────────────────

export async function relayMessage(message: Message, client: Client): Promise<void> {
  if (message.author.bot || !message.guild) return;

  const groups = await getGroupsForChannel(message.guild.id, message.channel.id);
  if (groups.length === 0) return;

  for (const group of groups) {
    try {
      const resolved = resolveTargets(group, message.guild.id, message.channel.id);
      if (!resolved) continue;

      const forwarded = readForwardedContent(message, group);
      const stickers = readStickers(message, group);
      const ownText = group.relayText ? message.content : '';
      const ownFiles = group.relayImages
        ? message.attachments.map((a) => ({ attachment: a.url, name: a.name ?? 'file' }))
        : [];

      // Un message dont les filtres du pont ne retiennent rien ne doit pas
      // partir : l'API refuse un envoi vide, et l'erreur passait pour une panne
      // du pont alors que le lien faisait exactement ce qu'on lui demandait.
      const hasContent =
        !!ownText || !!forwarded.text || ownFiles.length > 0 || forwarded.attachments.length > 0
        || forwarded.embeds.length > 0 || stickers.files.length > 0 || !!stickers.note;
      if (!hasContent) continue;

      // Un transfert porte lui aussi une `reference`, mais elle désigne le
      // message d'origine, pas une réponse : l'annoncer comme telle mentirait.
      const repliedTo = message.reference?.messageId && message.messageSnapshots.size === 0
        ? await resolveOrigin(group.id, message.reference.messageId, message.channel.id)
        : null;
      const replyLocations = repliedTo
        ? await messageLocations(group.id, repliedTo.messageId, repliedTo.channelId)
        : null;
      const refMsg = repliedTo ? await message.fetchReference().catch(() => null) : null;

      for (const target of resolved.targets) {
        try {
          const destGuild = client.guilds.cache.get(target.guildId);
          if (!destGuild) continue;
          const destChannel = destGuild.channels.cache.get(target.channelId);
          if (!destChannel || !destChannel.isTextBased()) continue;

          const counterpart = replyLocations?.get(target.channelId);
          const replyUrl = counterpart
            ? `https://discord.com/channels/${target.guildId}/${target.channelId}/${counterpart.messageId}`
            : null;

          const targetWebhookId = await ensureTargetWebhookId(client, group, target);

          if (targetWebhookId) {
            let activeWebhookId = targetWebhookId;
            let webhookClient = await getWebhookClient(destChannel as TextChannel, activeWebhookId);
            if (!webhookClient) {
              // Le webhook a été supprimé du salon. On le recrée et on repart
              // avec : abandonner ici coûtait le message en cours.
              logger.warn(TAG, `Webhook ${activeWebhookId} introuvable pour ${target.guildId}/${target.channelId} - recréation...`);
              const newWebhookId = await createRelayWebhook(client, target.guildId, target.channelId);
              if (newWebhookId) {
                await prisma.channelLinkGroupMember.update({ where: { id: target.id }, data: { webhookId: newWebhookId } })
                  .catch((err) => logger.warn(TAG, `Impossible d'enregistrer le webhook de ${target.channelId}`, err));
                await invalidateGroupCache(group);
                target.webhookId = newWebhookId;
                activeWebhookId = newWebhookId;
                webhookClient = await getWebhookClient(destChannel as TextChannel, newWebhookId);
              }
              if (!webhookClient) continue;
            }

            const files = [
              ...ownFiles,
              ...forwarded.attachments.map((a) => ({ attachment: a.url, name: a.name })),
              ...stickers.files,
            ];

            let fullContent = '';
            if (replyUrl) {
              const refAuthor = refMsg?.author?.displayName || refMsg?.author?.username || '?';
              const refPreview = refMsg?.content?.slice(0, 50) || '';
              fullContent += `> **↩ ${refAuthor}:** ${refPreview}${(refMsg?.content?.length ?? 0) > 50 ? '…' : ''}\n> [Aller au message](${replyUrl})\n`;
            }
            if (forwarded.text) fullContent += `${FORWARD_HEADER}\n${forwarded.text}\n`;
            if (ownText) fullContent += ownText;
            if (stickers.note) fullContent += `${fullContent ? '\n' : ''}${stickers.note}`;

            const emojiFallback = buildEmojiImageFallback(client, target, fullContent);
            if (emojiFallback) {
              fullContent = emojiFallback.content;
              files.push(...emojiFallback.files);
            }

            const sent = await webhookClient.send({
              content: neutralizeMassMentions(fullContent) || undefined,
              username: message.author.displayName || message.author.username,
              avatarURL: message.author.displayAvatarURL(),
              files: files.slice(0, DISCORD_MAX_ATTACHMENTS),
              embeds: forwarded.embeds.length > 0 ? forwarded.embeds : undefined,
              allowedMentions: { parse: [] },
            });

            warnOnStrippedEmojis(client, target, fullContent, sent.content);
            await saveMessageMapping(group, message.id, message.channel.id, target, sent.id, activeWebhookId);
            webhookClient.destroy();
          } else {
            const sourceGuild = message.guild!;
            const embed = new EmbedBuilder()
              .setColor(COLORS.info)
              .setAuthor({
                name: `${message.author.displayName || message.author.username} • ${sourceGuild.name}`,
                iconURL: message.author.displayAvatarURL(),
              })
              .setTimestamp(message.createdAt)
              .setFooter({ text: `🔗 ${sourceGuild.name}`, iconURL: sourceGuild.iconURL() ?? undefined });

            let desc = '';
            if (replyUrl) desc += `> ↩ [Message cité](${replyUrl})\n\n`;
            if (forwarded.text) desc += `${FORWARD_HEADER}\n${forwarded.text}\n`;
            if (ownText) desc += ownText;
            if (stickers.note) desc += `${desc ? '\n' : ''}${stickers.note}`;
            if (desc) embed.setDescription(desc);

            const ownImage = group.relayImages
              ? message.attachments.find((a) => a.contentType?.startsWith('image/'))
              : undefined;
            // L'image d'un transfert ne prend la vignette de l'embed que si le
            // message lui-même n'en fournit pas ; sinon elle repart en pièce jointe.
            const forwardedImage = ownImage ? undefined : forwarded.attachments.find((a) => a.isImage);
            // Un sticker seul mérite la vignette de l'embed plutôt qu'une pièce
            // jointe : c'est ainsi qu'il s'affiche du côté d'où il vient.
            const stickerImage = ownImage || forwardedImage ? undefined : stickers.files[0];
            if (ownImage) embed.setImage(ownImage.url);
            else if (forwardedImage) embed.setImage(forwardedImage.url);
            else if (stickerImage) embed.setImage(stickerImage.attachment);

            const files = [
              ...(group.relayImages
                ? message.attachments.filter((a) => !a.contentType?.startsWith('image/')).map((a) => ({ attachment: a.url, name: a.name ?? 'file' }))
                : []),
              ...forwarded.attachments
                .filter((a) => a !== forwardedImage)
                .map((a) => ({ attachment: a.url, name: a.name })),
              ...stickers.files.filter((f) => f !== stickerImage),
            ];

            const emojiFallback = buildEmojiImageFallback(client, target, desc);
            if (emojiFallback) {
              // L'emoji ne prend la vignette que s'il était tout le message et
              // que rien d'autre ne l'occupe ; sinon il rejoint les pièces
              // jointes, sans toucher au texte.
              const takesThumbnail = !emojiFallback.content && !ownImage && !forwardedImage && !stickerImage;
              if (takesThumbnail) {
                embed.setDescription(null);
                embed.setImage(emojiFallback.files[0]!.attachment);
                files.push(...emojiFallback.files.slice(1));
              } else {
                files.push(...emojiFallback.files);
              }
            }

            const sent = await (destChannel as TextChannel).send({
              embeds: [embed.toJSON(), ...forwarded.embeds],
              files: files.slice(0, DISCORD_MAX_ATTACHMENTS),
              allowedMentions: { parse: [] },
            });
            await saveMessageMapping(group, message.id, message.channel.id, target, sent.id);
          }
        } catch (err) {
          logger.error(TAG, `Erreur relay message ${message.id} vers ${target.guildId}/${target.channelId}`, err);
        }
      }
    } catch (err) {
      logger.error(TAG, `Erreur relay message ${message.id} sur le pont ${group.id}`, err);
    }
  }
}

// ── Édition ─────────────────────────────────────────────────

export async function relayMessageEdit(message: Message, client: Client): Promise<void> {
  if (message.author.bot || !message.guild) return;

  const groups = (await getGroupsForChannel(message.guild.id, message.channel.id)).filter((g) => g.relayEdits);
  if (groups.length === 0) return;

  for (const group of groups) {
    try {
      const copies = await prisma.channelLinkGroupMessage.findMany({
        where: { groupId: group.id, sourceMessageId: message.id, sourceChannelId: message.channel.id },
      });
      if (copies.length === 0) continue;

      for (const copy of copies) {
        try {
          const destGuild = client.guilds.cache.get(copy.relayedGuildId);
          if (!destGuild) continue;
          const destChannel = destGuild.channels.cache.get(copy.relayedChannelId);
          if (!destChannel || !destChannel.isTextBased()) continue;

          if (copy.webhookId) {
            const webhookClient = await getWebhookClient(destChannel as TextChannel, copy.webhookId);
            if (!webhookClient) {
              logger.warn(TAG, `Webhook introuvable pour edit ${copy.webhookId}`);
              continue;
            }

            await webhookClient.editMessage(copy.relayedMessageId, {
              content: neutralizeMassMentions(message.content) || undefined,
              allowedMentions: { parse: [] },
            }).catch((err) => logger.warn(TAG, `Impossible d'éditer le message webhook ${copy.relayedMessageId}`, err));

            webhookClient.destroy();
          } else {
            const relayedMsg = await (destChannel as TextChannel).messages.fetch(copy.relayedMessageId).catch(() => null);
            if (relayedMsg?.editable) {
              // Le message relayé est en Components V2 (voir utils/patchV2.ts) :
              // `relayedMsg.embeds` est vide, on reconstruit donc l'embed à partir
              // du message source édité (mêmes en-tête/pied qu'à la création).
              const sourceGuild = message.guild!;
              const newEmbed = new EmbedBuilder()
                .setColor(COLORS.info)
                .setAuthor({
                  name: `${message.author.displayName || message.author.username} • ${sourceGuild.name}`,
                  iconURL: message.author.displayAvatarURL(),
                })
                .setTimestamp(message.createdAt)
                .setFooter({ text: `🔗 ${sourceGuild.name}`, iconURL: sourceGuild.iconURL() ?? undefined })
                .setDescription(message.content || '*[vide]*');
              await relayedMsg.edit({ embeds: [newEmbed] }).catch(() => null);
            }
          }
        } catch (err) {
          logger.error(TAG, `Erreur relay edit ${message.id} vers ${copy.relayedChannelId}`, err);
        }
      }
    } catch (err) {
      logger.error(TAG, `Erreur relay edit ${message.id}`, err);
    }
  }
}

// ── Suppression ─────────────────────────────────────────────

export async function relayMessageDelete(message: Message, client: Client): Promise<void> {
  if (message.author?.bot || !message.guild) return;

  const groups = (await getGroupsForChannel(message.guild.id, message.channel.id)).filter((g) => g.relayDeletes);
  if (groups.length === 0) return;

  for (const group of groups) {
    try {
      const copies = await prisma.channelLinkGroupMessage.findMany({
        where: { groupId: group.id, sourceMessageId: message.id, sourceChannelId: message.channel.id },
      });
      if (copies.length === 0) continue;

      for (const copy of copies) {
        try {
          const destGuild = client.guilds.cache.get(copy.relayedGuildId);
          if (!destGuild) continue;
          const destChannel = destGuild.channels.cache.get(copy.relayedChannelId);
          if (!destChannel || !destChannel.isTextBased()) continue;

          if (copy.webhookId) {
            const webhookClient = await getWebhookClient(destChannel as TextChannel, copy.webhookId);
            if (webhookClient) {
              await webhookClient.deleteMessage(copy.relayedMessageId).catch(() => null);
              webhookClient.destroy();
            }
          } else {
            const relayedMsg = await (destChannel as TextChannel).messages.fetch(copy.relayedMessageId).catch(() => null);
            if (relayedMsg?.deletable) await relayedMsg.delete().catch(() => null);
          }
        } catch (err) {
          logger.error(TAG, `Erreur relay delete ${message.id} vers ${copy.relayedChannelId}`, err);
        }
      }

      await prisma.channelLinkGroupMessage.deleteMany({
        where: { groupId: group.id, sourceMessageId: message.id },
      });
    } catch (err) {
      logger.error(TAG, `Erreur relay delete ${message.id}`, err);
    }
  }
}

// ── Réactions ───────────────────────────────────────────────

/**
 * Une réaction se propage à toutes les autres incarnations du message, quel que
 * soit le salon où elle a été posée : l'original comme les copies.
 */
export async function relayReactionAdd(reaction: MessageReaction, user: User, client: Client): Promise<void> {
  if (user.bot || !reaction.message.guild) return;

  const guildId = reaction.message.guild.id;
  const channelId = reaction.message.channel.id;
  const messageId = reaction.message.id;

  const groups = (await getGroupsForChannel(guildId, channelId)).filter((g) => g.relayReactions);
  if (groups.length === 0) return;

  const emoji = reaction.emoji.id ? `${reaction.emoji.name}:${reaction.emoji.id}` : reaction.emoji.name;
  if (!emoji) return;

  for (const group of groups) {
    try {
      // Une réaction suit le même chemin qu'un message : un salon qui ne fait que
      // recevoir n'en envoie pas, un salon qui ne fait qu'émettre n'en reçoit pas.
      const resolved = resolveTargets(group, guildId, channelId);
      if (!resolved) continue;
      const reachable = new Map(resolved.targets.map((m) => [m.channelId, m] as const));

      const origin = await resolveOrigin(group.id, messageId, channelId);
      if (!origin) continue;

      const locations = await messageLocations(group.id, origin.messageId, origin.channelId);

      for (const [locChannelId, location] of locations) {
        if (locChannelId === channelId) continue;

        const member = reachable.get(locChannelId);
        if (!member) continue;
        const destGuildId = location.guildId ?? member.guildId;

        const destGuild = client.guilds.cache.get(destGuildId);
        if (!destGuild) continue;
        const destChannel = destGuild.channels.cache.get(locChannelId);
        if (!destChannel || !destChannel.isTextBased()) continue;

        const targetMsg = await (destChannel as TextChannel).messages.fetch(location.messageId).catch(() => null);
        if (!targetMsg) continue;

        await targetMsg.react(emoji).catch(() => null);
      }
    } catch (err) {
      logger.error(TAG, `Erreur relay reaction ${reaction.emoji.name}`, err);
    }
  }
}

// ── Épinglages ──────────────────────────────────────────────

/**
 * Identifiants des messages épinglés d'un salon, ou `null` si Discord refuse la
 * lecture. La distinction compte : un salon illisible retourné comme « aucun
 * épinglé » ferait désépingler l'intégralité des salons d'en face.
 */
async function fetchPinnedMessageIds(channel: TextChannel): Promise<Set<string> | null> {
  try {
    const pins = await channel.messages.fetchPins();
    return new Set(pins.items.map((pin) => pin.message.id));
  } catch (err) {
    logger.warn(TAG, `Impossible de lire les messages épinglés de ${channel.id}`, err);
    return null;
  }
}

/**
 * Aligne les épinglages de tous les salons d'un pont.
 *
 * Discord n'annonce pas *quel* message vient d'être épinglé : `channelPinsUpdate`
 * dit seulement que la liste du salon a changé. On compare donc les listes et on
 * ne touche qu'aux messages dont le pont connaît les copies - un message épinglé
 * nativement en face n'est jamais décroché.
 *
 * La synchronisation converge d'elle-même : l'épinglage posé en face déclenche à
 * son tour un `channelPinsUpdate` qui trouve les salons déjà d'accord.
 */
export async function relayPinsUpdate(guildId: string, channelId: string, client: Client): Promise<void> {
  const groups = (await getGroupsForChannel(guildId, channelId)).filter((g) => g.relayPins);
  if (groups.length === 0) return;

  const guild = client.guilds.cache.get(guildId);
  const channel = guild?.channels.cache.get(channelId);
  if (!guild || !channel || !channel.isTextBased()) return;

  const localPinned = await fetchPinnedMessageIds(channel as TextChannel);
  if (!localPinned) return;

  for (const group of groups) {
    try {
      // Un salon qui ne fait que recevoir n'impose pas ses épinglages aux
      // autres, pas plus qu'il ne leur impose ses messages.
      const resolved = resolveTargets(group, guildId, channelId);
      if (!resolved) continue;
      const others = resolved.targets;

      const pinnedSets = new Map<string, Set<string>>();
      for (const other of others) {
        const otherGuild = client.guilds.cache.get(other.guildId);
        const otherChannel = otherGuild?.channels.cache.get(other.channelId);
        if (!otherChannel || !otherChannel.isTextBased()) continue;
        const pinned = await fetchPinnedMessageIds(otherChannel as TextChannel);
        if (pinned) pinnedSets.set(other.channelId, pinned);
      }
      if (pinnedSets.size === 0) continue;

      // Seul un message épinglé quelque part peut demander un changement :
      // inutile de relire toute la correspondance du pont.
      const candidateIds = [...localPinned, ...[...pinnedSets.values()].flatMap((s) => [...s])];
      if (candidateIds.length === 0) continue;

      const rows = await prisma.channelLinkGroupMessage.findMany({
        where: {
          groupId: group.id,
          OR: [{ sourceMessageId: { in: candidateIds } }, { relayedMessageId: { in: candidateIds } }],
        },
      });
      if (rows.length === 0) continue;

      // Un message et ses copies forment un seul objet dont chaque salon détient
      // une incarnation : c'est cet objet, et non la paire de salons, qui porte
      // l'état « épinglé ».
      const byOrigin = new Map<string, Map<string, string>>();
      for (const row of rows) {
        const key = `${row.sourceChannelId}:${row.sourceMessageId}`;
        let locations = byOrigin.get(key);
        if (!locations) {
          locations = new Map([[row.sourceChannelId, row.sourceMessageId]]);
          byOrigin.set(key, locations);
        }
        locations.set(row.relayedChannelId, row.relayedMessageId);
      }

      for (const locations of byOrigin.values()) {
        const localMessageId = locations.get(channelId);
        if (!localMessageId) continue;

        const pinnedHere = localPinned.has(localMessageId);

        for (const other of others) {
          const remoteMessageId = locations.get(other.channelId);
          const remotePinned = pinnedSets.get(other.channelId);
          if (!remoteMessageId || !remotePinned) continue;
          if (pinnedHere === remotePinned.has(remoteMessageId)) continue;

          const otherGuild = client.guilds.cache.get(other.guildId);
          const otherChannel = otherGuild?.channels.cache.get(other.channelId);
          if (!otherChannel || !otherChannel.isTextBased()) continue;

          const reason = `Kotbo Link: épinglage synchronisé depuis ${guild.name}`;
          const messages = (otherChannel as TextChannel).messages;

          if (pinnedHere) {
            await messages.pin(remoteMessageId, reason).catch((err) =>
              logger.warn(TAG, `Impossible d'épingler ${remoteMessageId} dans ${other.channelId}`, err),
            );
          } else {
            await messages.unpin(remoteMessageId, reason).catch((err) =>
              logger.warn(TAG, `Impossible de désépingler ${remoteMessageId} dans ${other.channelId}`, err),
            );
          }
        }
      }
    } catch (err) {
      logger.error(TAG, `Erreur relay pins ${guildId}/${channelId} sur le pont ${group.id}`, err);
    }
  }
}

// ── Frappe ──────────────────────────────────────────────────

export async function relayTyping(channelId: string, guildId: string, userId: string, client: Client): Promise<void> {
  const groups = await getGroupsForChannel(guildId, channelId);
  if (groups.length === 0) return;

  for (const group of groups) {
    try {
      const resolved = resolveTargets(group, guildId, channelId);
      if (!resolved) continue;

      for (const target of resolved.targets) {
        const destGuild = client.guilds.cache.get(target.guildId);
        const destChannel = destGuild?.channels.cache.get(target.channelId);
        if (!destChannel || !destChannel.isTextBased()) continue;
        await (destChannel as TextChannel).sendTyping().catch(() => null);
      }
    } catch {
      // Silent
    }
  }
}

// ── Threads ─────────────────────────────────────────────────

/**
 * Toutes les incarnations d'un fil dans le pont, salon parent par salon parent.
 * Le fil interrogé peut aussi bien être l'original que l'une de ses copies.
 */
async function threadLocations(groupId: string, threadId: string) {
  const rows = await prisma.channelLinkGroupThread.findMany({
    where: { groupId, OR: [{ sourceThreadId: threadId }, { relayedThreadId: threadId }] },
  });
  if (rows.length === 0) return null;

  const asSource = rows.find((r) => r.sourceThreadId === threadId);
  const origin = asSource
    ? { threadId: asSource.sourceThreadId, guildId: asSource.sourceGuildId, channelId: asSource.sourceChannelId }
    : { threadId: rows[0]!.sourceThreadId, guildId: rows[0]!.sourceGuildId, channelId: rows[0]!.sourceChannelId };

  const copies = asSource
    ? rows.filter((r) => r.sourceThreadId === threadId)
    : await prisma.channelLinkGroupThread.findMany({ where: { groupId, sourceThreadId: origin.threadId } });

  const locations = new Map<string, { threadId: string; guildId: string }>();
  locations.set(origin.channelId, { threadId: origin.threadId, guildId: origin.guildId });
  for (const copy of copies) {
    locations.set(copy.relayedChannelId, { threadId: copy.relayedThreadId, guildId: copy.relayedGuildId });
  }

  return { origin, locations };
}

/**
 * Fils que le relais vient de créer.
 *
 * Discord annonce la création d'un fil au bot qui l'a créé comme aux autres :
 * sans mémoire, la copie posée dans le salon d'en face repartirait aussitôt en
 * copie chez tout le monde. La ligne en base arrive juste après la création, et
 * ce jeu couvre l'instant qui les sépare.
 */
const relayCreatedThreadIds = new Set<string>();

function rememberRelayedThread(threadId: string) {
  relayCreatedThreadIds.add(threadId);
  setTimeout(() => relayCreatedThreadIds.delete(threadId), 5 * 60 * 1000).unref?.();
}

export async function relayThreadCreate(thread: ThreadChannel, client: Client): Promise<void> {
  if (!thread.parent || !thread.guild) return;
  if (relayCreatedThreadIds.has(thread.id)) return;

  const groups = (await getGroupsForChannel(thread.guild.id, thread.parent.id)).filter((g) => g.relayThreads);
  if (groups.length === 0) return;

  for (const group of groups) {
    try {
      const resolved = resolveTargets(group, thread.guild.id, thread.parent.id);
      if (!resolved) continue;

      // Le fil est déjà la copie d'un autre : le remirroiter multiplierait les
      // fils à chaque tour de pont.
      const isCopy = await prisma.channelLinkGroupThread.findFirst({
        where: { groupId: group.id, relayedThreadId: thread.id },
        select: { id: true },
      });
      if (isCopy) continue;

      const starterMessage = await thread.fetchStarterMessage().catch(() => null);

      for (const target of resolved.targets) {
        try {
          const existing = await prisma.channelLinkGroupThread.findUnique({
            where: {
              groupId_sourceThreadId_relayedChannelId: {
                groupId: group.id,
                sourceThreadId: thread.id,
                relayedChannelId: target.channelId,
              },
            },
          });
          if (existing) continue;

          const destGuild = client.guilds.cache.get(target.guildId);
          if (!destGuild) continue;
          const destChannel = destGuild.channels.cache.get(target.channelId);
          if (!destChannel || !destChannel.isTextBased()) continue;

          const textChannel = destChannel as TextChannel;
          const newThread = await textChannel.threads.create({
            name: thread.name,
            autoArchiveDuration: thread.autoArchiveDuration ?? 1440,
            reason: `Kotbo Link: thread synchronisé depuis ${thread.guild.name}`,
          });
          rememberRelayedThread(newThread.id);

          if (starterMessage?.content) {
            const starterWebhookId = await ensureTargetWebhookId(client, group, target);
            const webhookClient = starterWebhookId ? await getWebhookClient(textChannel, starterWebhookId) : null;
            if (webhookClient) {
              await webhookClient.send({
                content: neutralizeMassMentions(starterMessage.content),
                username: starterMessage.author.displayName || starterMessage.author.username,
                avatarURL: starterMessage.author.displayAvatarURL(),
                threadId: newThread.id,
                allowedMentions: { parse: [] },
              }).catch(() => null);
              webhookClient.destroy();
            } else {
              await newThread.send({
                allowedMentions: { parse: [] },
                embeds: [new EmbedBuilder()
                  .setColor(COLORS.info)
                  .setAuthor({
                    name: `${starterMessage.author.displayName || starterMessage.author.username} • ${thread.guild.name}`,
                    iconURL: starterMessage.author.displayAvatarURL(),
                  })
                  .setDescription(starterMessage.content)
                  .setTimestamp(starterMessage.createdAt)],
              }).catch(() => null);
            }
          }

          await prisma.channelLinkGroupThread.create({
            data: {
              groupId: group.id,
              sourceThreadId: thread.id,
              sourceGuildId: thread.guild.id,
              sourceChannelId: thread.parent.id,
              relayedThreadId: newThread.id,
              relayedGuildId: target.guildId,
              relayedChannelId: target.channelId,
              webhookId: target.webhookId,
            },
          });

          logger.info(TAG, `Thread ${thread.name} synchronisé: ${thread.id} → ${newThread.id}`);
        } catch (err) {
          logger.error(TAG, `Erreur relay thread create ${thread.id} vers ${target.guildId}/${target.channelId}`, err);
        }
      }
    } catch (err) {
      logger.error(TAG, `Erreur relay thread create ${thread.id}`, err);
    }
  }
}

export async function relayThreadMessage(message: Message, client: Client): Promise<void> {
  if (message.author.bot || !message.guild || !message.channel.isThread()) return;

  const thread = message.channel as ThreadChannel;
  if (!thread.parent) return;

  const groups = (await getGroupsForChannel(message.guild.id, thread.parent.id)).filter((g) => g.relayThreads);
  if (groups.length === 0) return;

  for (const group of groups) {
    try {
      const resolved = resolveTargets(group, message.guild.id, thread.parent.id);
      if (!resolved) continue;

      const threads = await threadLocations(group.id, thread.id);
      if (!threads) continue;

      const stickers = readStickers(message, group);

      for (const [parentChannelId, location] of threads.locations) {
        if (location.threadId === thread.id) continue;

        const target = group.members.find((m) => m.channelId === parentChannelId && m.enabled);
        if (!target || target.mode === 'SEND_ONLY') continue;

        try {
          const destGuild = client.guilds.cache.get(location.guildId);
          if (!destGuild) continue;

          const destThread = destGuild.channels.cache.get(location.threadId) as ThreadChannel | undefined;
          if (!destThread?.isThread()) continue;

          const parentChannel = destThread.parent as TextChannel | null;

          const threadWebhookId = parentChannel ? await ensureTargetWebhookId(client, group, target) : null;
          if (threadWebhookId && parentChannel) {
            const webhookClient = await getWebhookClient(parentChannel, threadWebhookId);
            if (webhookClient) {
              const files = [
                ...(group.relayImages
                  ? message.attachments.map((a) => ({ attachment: a.url, name: a.name ?? 'file' }))
                  : []),
                ...stickers.files,
              ];

              let threadContent = [message.content, stickers.note].filter(Boolean).join('\n');
              const emojiFallback = buildEmojiImageFallback(client, target, threadContent);
              if (emojiFallback) {
                threadContent = emojiFallback.content;
                files.push(...emojiFallback.files);
              }

              await webhookClient.send({
                content: neutralizeMassMentions(threadContent) || undefined,
                username: message.author.displayName || message.author.username,
                avatarURL: message.author.displayAvatarURL(),
                threadId: destThread.id,
                files: files.slice(0, DISCORD_MAX_ATTACHMENTS),
                allowedMentions: { parse: [] },
              });

              webhookClient.destroy();
              continue;
            }
          }

          const embed = new EmbedBuilder()
            .setColor(COLORS.info)
            .setAuthor({
              name: `${message.author.displayName || message.author.username} • ${message.guild.name}`,
              iconURL: message.author.displayAvatarURL(),
            })
            .setDescription([message.content, stickers.note].filter(Boolean).join('\n') || '*[vide]*')
            .setTimestamp(message.createdAt);

          const img = group.relayImages ? message.attachments.find((a) => a.contentType?.startsWith('image/')) : undefined;
          const stickerImage = img ? undefined : stickers.files[0];
          if (img) embed.setImage(img.url);
          else if (stickerImage) embed.setImage(stickerImage.attachment);

          const files = [
            ...(group.relayImages
              ? message.attachments.filter((a) => !a.contentType?.startsWith('image/')).map((a) => ({ attachment: a.url, name: a.name ?? 'file' }))
              : []),
            ...stickers.files.filter((f) => f !== stickerImage),
          ];

          await destThread.send({ embeds: [embed], files: files.slice(0, DISCORD_MAX_ATTACHMENTS), allowedMentions: { parse: [] } });
        } catch (err) {
          logger.error(TAG, `Erreur relay thread message ${message.id} vers ${parentChannelId}`, err);
        }
      }
    } catch (err) {
      logger.error(TAG, `Erreur relay thread message ${message.id}`, err);
    }
  }
}

export async function relayThreadDelete(thread: ThreadChannel, client: Client): Promise<void> {
  if (!thread.parent || !thread.guild) return;

  const groups = (await getGroupsForChannel(thread.guild.id, thread.parent.id)).filter((g) => g.relayThreads);
  if (groups.length === 0) return;

  for (const group of groups) {
    try {
      const copies = await prisma.channelLinkGroupThread.findMany({
        where: { groupId: group.id, sourceThreadId: thread.id },
      });
      if (copies.length === 0) continue;

      for (const copy of copies) {
        const destGuild = client.guilds.cache.get(copy.relayedGuildId);
        const destThread = destGuild?.channels.cache.get(copy.relayedThreadId) as ThreadChannel | undefined;
        if (destThread?.isThread()) await destThread.setArchived(true).catch(() => null);
      }

      await prisma.channelLinkGroupThread.deleteMany({ where: { groupId: group.id, sourceThreadId: thread.id } }).catch(() => null);
      logger.info(TAG, `Thread supprimé/archivé sur ${copies.length} salon(s) liés: ${thread.id}`);
    } catch (err) {
      logger.error(TAG, `Erreur relay thread delete ${thread.id}`, err);
    }
  }
}

// ── Sondages ────────────────────────────────────────────────

export async function relayPollMessage(message: Message, client: Client): Promise<void> {
  if (message.author.bot || !message.guild || !message.poll) return;

  const groups = (await getGroupsForChannel(message.guild.id, message.channel.id)).filter((g) => g.relayPolls);
  if (groups.length === 0) return;

  for (const group of groups) {
    try {
      const resolved = resolveTargets(group, message.guild.id, message.channel.id);
      if (!resolved) continue;

      const poll = message.poll;
      const answers = poll.answers.map((a) => `${formatCustomEmoji(a.emoji, client)} ${a.text}`.trim());

      const embed = new EmbedBuilder()
        .setColor(COLORS.info)
        .setAuthor({
          name: `${message.author.displayName || message.author.username} • ${message.guild.name}`,
          iconURL: message.author.displayAvatarURL(),
        })
        .setTitle(`📊 ${poll.question.text}`)
        .setDescription(answers.map((a, i) => `**${i + 1}.** ${a}`).join('\n'))
        .setFooter({ text: `Sondage relayé • ${poll.allowMultiselect ? 'Choix multiples' : 'Choix unique'}` })
        .setTimestamp(message.createdAt);

      if (poll.expiresAt) {
        embed.addFields({ name: 'Expire', value: `<t:${Math.floor(poll.expiresAt.getTime() / 1000)}:R>`, inline: true });
      }

      for (const target of resolved.targets) {
        const destGuild = client.guilds.cache.get(target.guildId);
        const destChannel = destGuild?.channels.cache.get(target.channelId);
        if (!destChannel || !destChannel.isTextBased()) continue;

        const sent = await (destChannel as TextChannel).send({ embeds: [embed], allowedMentions: { parse: [] } });
        await saveMessageMapping(group, message.id, message.channel.id, target, sent.id);
      }
    } catch (err) {
      logger.error(TAG, `Erreur relay poll ${message.id}`, err);
    }
  }
}

// ── Gestion des ponts ───────────────────────────────────────

export async function listGroupsForGuild(guildId: string): Promise<LinkGroup[]> {
  return prisma.channelLinkGroup.findMany({
    where: { members: { some: { guildId } } },
    include: { members: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getGroup(groupId: string): Promise<LinkGroup | null> {
  return loadGroup(groupId);
}

export async function removeGroup(groupId: string, client?: Client): Promise<LinkGroup | null> {
  const group = await loadGroup(groupId);
  if (!group) return null;

  await invalidateGroupCache(group);

  // Les correspondances et les fils tombent en cascade avec le pont : rompre un
  // pont ne doit pas laisser en base les identifiants des messages qui y ont
  // transité - exactement la trace qu'un serveur croit effacer en le retirant.
  await prisma.channelLinkGroup.delete({ where: { id: groupId } });

  // Le pont rompu, un serveur invité perd son unique raison d'être vu par le
  // bot : il redevient totalement muet pour Kotbo.
  await refreshLinkGuestGuilds();

  if (client && group.updateTopic) {
    await Promise.all(group.members.map((m) => clearChannelLinkTopic(client, m.guildId, m.channelId)));
  }

  return group;
}

export async function updateGroupConfig(
  groupId: string,
  data: Partial<Pick<ChannelLinkGroup, 'name' | 'relayText' | 'relayImages' | 'relayEmbeds' | 'relayReactions' | 'relayEdits' | 'relayDeletes' | 'relayThreads' | 'relayPolls' | 'relayPins' | 'enabled' | 'updateTopic'>>,
): Promise<LinkGroup | null> {
  const group = await loadGroup(groupId);
  if (!group) return null;

  const updated = await prisma.channelLinkGroup.update({
    where: { id: groupId },
    data,
    include: { members: true },
  });

  await invalidateGroupCache(updated);

  // Désactiver le dernier pont d'un serveur invité doit refermer la garde
  // aussitôt, comme le ferait une suppression.
  if (data.enabled !== undefined && data.enabled !== group.enabled) {
    await refreshLinkGuestGuilds();
  }

  // Couper le relais des éditions/suppressions/réactions rend le journal des
  // correspondances inutile : on le purge au lieu de le laisser vieillir.
  if (!needsMessageMapping(updated)) {
    await purgeGroupMessageMappings(groupId);
  }

  return updated;
}

export async function updateGroupMemberConfig(
  groupId: string,
  memberId: string,
  data: Partial<Pick<ChannelLinkGroupMember, 'mode' | 'relayMode' | 'enabled'>>,
): Promise<LinkGroup | null> {
  const group = await loadGroup(groupId);
  if (!group || !group.members.some((m) => m.id === memberId)) return null;

  await prisma.channelLinkGroupMember.update({ where: { id: memberId }, data });

  const refreshed = (await loadGroup(groupId))!;
  await invalidateGroupCache(refreshed);

  if (data.enabled !== undefined) await refreshLinkGuestGuilds();

  return refreshed;
}

/**
 * Efface les correspondances de messages d'un pont : soit parce qu'il cesse d'en
 * avoir besoin, soit parce qu'il disparaît.
 */
export async function purgeGroupMessageMappings(groupId: string): Promise<number> {
  const { count } = await prisma.channelLinkGroupMessage.deleteMany({ where: { groupId } });
  if (count > 0) {
    logger.info(TAG, `${count} correspondance(s) de messages purgée(s) pour le pont ${groupId}.`);
  }
  return count;
}
