/**
 * Campagnes marketing : une suite de messages programmes, adressee a une
 * audience choisie, dont on mesure la portee.
 *
 * Ce qui la distingue d'un message programme : elle enchaine plusieurs envois
 * autour d'une date de depart, elle sait a qui elle parle, et elle rend compte
 * de ce qu'elle a produit.
 *
 * Le cycle (`runCampaignCycle`) est balaye chaque minute. Un balayage plutot
 * qu'une tache cron par campagne : la liste change a chaque enregistrement, et
 * un balayage reprend tout seul apres un redemarrage.
 */
import {
  EmbedBuilder,
  type ColorResolvable,
  type Client,
  type Guild,
  type GuildMember,
} from 'discord.js';
import type { Campaign, CampaignStep } from '@prisma/client';
import { CampaignStatus, CampaignStepStatus } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';

/** Pause entre deux MP. Discord ferme le robinet bien avant, sans cela. */
const DM_THROTTLE_MS = 1_100;

/** Plafond de MP par etape, pour qu'une erreur de ciblage reste rattrapable. */
const DM_HARD_CAP = 2_000;

// ─── Audience ────────────────────────────────────────────────────────────────

export type AudienceCriteria = Pick<
  Campaign,
  'audienceRoleIds' | 'audienceExcludeRoleIds' | 'audienceMinLevel' | 'audienceMinTenureDays' | 'audienceInactiveDays'
>;

/**
 * Membres retenus par le ciblage. Les criteres se cumulent.
 *
 * Les bots sont toujours ecartes : une campagne s'adresse a des gens. Sans
 * aucun critere, tout le serveur ressort - ce qui n'a de sens que pour une
 * diffusion en salon, et l'API refuse ce cas pour un envoi en MP.
 */
export async function resolveAudience(guild: Guild, criteria: AudienceCriteria): Promise<GuildMember[]> {
  const members = await guild.members.fetch().catch(() => guild.members.cache);
  let pool = Array.from(members.values()).filter((member) => !member.user.bot);

  if (criteria.audienceRoleIds.length > 0) {
    pool = pool.filter((member) => criteria.audienceRoleIds.some((id) => member.roles.cache.has(id)));
  }
  if (criteria.audienceExcludeRoleIds.length > 0) {
    pool = pool.filter((member) => !criteria.audienceExcludeRoleIds.some((id) => member.roles.cache.has(id)));
  }

  if (criteria.audienceMinTenureDays !== null && criteria.audienceMinTenureDays !== undefined) {
    const cutoff = Date.now() - criteria.audienceMinTenureDays * 86_400_000;
    // Une date d'arrivee inconnue ne prouve pas l'anciennete : on ecarte.
    pool = pool.filter((member) => member.joinedTimestamp !== null && member.joinedTimestamp <= cutoff);
  }

  // Les deux derniers criteres se lisent en base : une requete par critere,
  // sur l'ensemble du vivier plutot qu'un aller-retour par membre.
  if (criteria.audienceMinLevel !== null && criteria.audienceMinLevel !== undefined) {
    const eligible = await prisma.memberLevel.findMany({
      where: { guildId: guild.id, level: { gte: criteria.audienceMinLevel } },
      select: { userId: true },
    });
    const ids = new Set(eligible.map((row) => row.userId));
    pool = pool.filter((member) => ids.has(member.id));
  }

  if (criteria.audienceInactiveDays !== null && criteria.audienceInactiveDays !== undefined) {
    const cutoff = new Date(Date.now() - criteria.audienceInactiveDays * 86_400_000);
    const active = await prisma.memberProfile.findMany({
      where: { guildId: guild.id, lastMessageAt: { gt: cutoff } },
      select: { userId: true },
    });
    const recentlyActive = new Set(active.map((row) => row.userId));
    // Jamais vu poster = inactif : c'est precisement la cible d'une relance.
    pool = pool.filter((member) => !recentlyActive.has(member.id));
  }

  return pool;
}

// ─── Rendu ───────────────────────────────────────────────────────────────────

type StepEmbed = { title?: unknown; description?: unknown; color?: unknown; imageUrl?: unknown };

/** Construit l'embed d'une etape, ou `null` si aucun champ utile n'est rempli. */
function buildEmbed(raw: unknown): EmbedBuilder | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as StepEmbed;

  const embed = new EmbedBuilder();
  let filled = false;

  if (typeof data.title === 'string' && data.title.trim()) {
    embed.setTitle(data.title.trim().slice(0, 256));
    filled = true;
  }
  if (typeof data.description === 'string' && data.description.trim()) {
    embed.setDescription(data.description.trim().slice(0, 4096));
    filled = true;
  }
  if (typeof data.imageUrl === 'string' && /^https:\/\//.test(data.imageUrl)) {
    embed.setImage(data.imageUrl);
    filled = true;
  }
  if (typeof data.color === 'string' && /^#[0-9a-f]{6}$/i.test(data.color)) {
    embed.setColor(data.color as ColorResolvable);
  }

  return filled ? embed : null;
}

/** Substitutions offertes au texte d'une etape. */
function render(content: string, vars: { guildName: string; memberMention?: string; memberName?: string }): string {
  const table: Record<string, string> = {
    server: vars.guildName,
    user: vars.memberMention ?? '',
    username: vars.memberName ?? '',
  };
  return content.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(table, key) ? table[key]! : match,
  );
}

// ─── Envoi ───────────────────────────────────────────────────────────────────

type StepOutcome = {
  recipients: number;
  delivered: number;
  failed: number;
  messageId: string | null;
  error: string | null;
};

/**
 * Diffuse une etape en salon, sur le serveur de la campagne et sur chacun des
 * serveurs supplementaires ou le bot est present.
 *
 * `messageId` ne retient que le message du serveur d'origine : c'est celui dont
 * on relira les reactions. Les mentions sont coupees - une campagne touche par
 * construction beaucoup de monde, un @everyone y serait rarement voulu.
 */
async function sendChannelStep(client: Client, campaign: Campaign, step: CampaignStep): Promise<StepOutcome> {
  if (!step.channelId) {
    return { recipients: 0, delivered: 0, failed: 1, messageId: null, error: 'Aucun salon de destination' };
  }

  const guildIds = [campaign.guildId, ...campaign.targetGuildIds.filter((id) => id !== campaign.guildId)];
  const embed = buildEmbed(step.embed);

  let delivered = 0;
  let failed = 0;
  let messageId: string | null = null;
  let error: string | null = null;

  for (const guildId of guildIds) {
    const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => null));
    if (!guild) {
      // Serveur partenaire ou le bot n'est plus : compte comme un echec, sans
      // interrompre la diffusion sur les autres.
      failed += 1;
      continue;
    }

    // Sur un serveur supplementaire, l'identifiant de salon de l'etape ne
    // designe rien : on ne poste que si le salon existe bien la-bas.
    const channel = await guild.channels.fetch(step.channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      failed += 1;
      if (guildId === campaign.guildId) error = 'Salon introuvable ou non textuel';
      continue;
    }

    try {
      const message = await channel.send({
        content: render(step.content, { guildName: guild.name }) || undefined,
        embeds: embed ? [embed] : [],
        allowedMentions: { parse: [] },
      });
      delivered += 1;
      if (guildId === campaign.guildId) messageId = message.id;
    } catch (err) {
      failed += 1;
      if (guildId === campaign.guildId) error = err instanceof Error ? err.message : 'Envoi refusé';
      logger.error('Campaign', `Étape ${step.id} refusée sur ${guildId}`, err);
    }
  }

  return { recipients: guildIds.length, delivered, failed, messageId, error };
}

/**
 * Envoie l'etape en message prive a chaque membre de l'audience.
 *
 * Le debit est volontairement lent : Discord coupe les MP en masse bien avant
 * la limite theorique, et une campagne qui se fait couper au tiers laisse une
 * audience a moitie prevenue, ce qui est pire que rien.
 */
async function sendDmStep(guild: Guild, campaign: Campaign, step: CampaignStep): Promise<StepOutcome> {
  const audience = await resolveAudience(guild, campaign);
  const targets = audience.slice(0, DM_HARD_CAP);
  const embed = buildEmbed(step.embed);

  let delivered = 0;
  let failed = 0;

  for (const member of targets) {
    try {
      await member.send({
        content: render(step.content, {
          guildName: guild.name,
          memberMention: `<@${member.id}>`,
          memberName: member.user.username,
        }) || undefined,
        embeds: embed ? [embed] : [],
      });
      delivered += 1;
    } catch {
      // MP fermes : c'est le cas courant, pas une anomalie a journaliser.
      failed += 1;
    }
    await new Promise((resolve) => setTimeout(resolve, DM_THROTTLE_MS));
  }

  return {
    recipients: audience.length,
    delivered,
    failed,
    messageId: null,
    error: audience.length > DM_HARD_CAP ? `Audience tronquée à ${DM_HARD_CAP} membres` : null,
  };
}

// ─── Cycle ───────────────────────────────────────────────────────────────────

/**
 * Fait avancer toutes les campagnes en cours.
 *
 * Une etape est due quand `startAt + offsetMinutes` est passe. Les etapes en
 * retard partent quand meme : une coupure du bot ne doit pas faire sauter une
 * annonce, elle doit la retarder.
 */
export async function runCampaignCycle(client: Client): Promise<void> {
  const now = new Date();

  const campaigns = await prisma.campaign.findMany({
    where: {
      status: { in: [CampaignStatus.SCHEDULED, CampaignStatus.RUNNING] },
      startAt: { not: null },
    },
    include: { steps: { orderBy: { offsetMinutes: 'asc' } } },
  });

  for (const campaign of campaigns) {
    if (!campaign.startAt) continue;

    const guild = client.guilds.cache.get(campaign.guildId)
      ?? (await client.guilds.fetch(campaign.guildId).catch(() => null));
    if (!guild) continue;

    const pending = campaign.steps.filter((step) => step.status === CampaignStepStatus.PENDING);
    const due = pending.filter(
      (step) => campaign.startAt!.getTime() + step.offsetMinutes * 60_000 <= now.getTime(),
    );

    if (due.length === 0) {
      // Plus rien en attente : la campagne est allee au bout.
      if (pending.length === 0 && campaign.status !== CampaignStatus.COMPLETED) {
        await prisma.campaign.update({
          where: { id: campaign.id },
          data: { status: CampaignStatus.COMPLETED },
        });
      }
      continue;
    }

    if (campaign.status === CampaignStatus.SCHEDULED) {
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: CampaignStatus.RUNNING },
      });
    }

    for (const step of due) {
      try {
        const outcome = step.delivery === 'DM'
          ? await sendDmStep(guild, campaign, step)
          : await sendChannelStep(client, campaign, step);

        await prisma.campaignStep.update({
          where: { id: step.id },
          data: {
            // Zero envoi reussi = echec : marquer « envoye » masquerait le
            // probleme derriere un compteur a zero que personne ne relit.
            status: outcome.delivered > 0 ? CampaignStepStatus.SENT : CampaignStepStatus.FAILED,
            sentAt: new Date(),
            messageId: outcome.messageId,
            recipientCount: outcome.recipients,
            deliveredCount: outcome.delivered,
            failedCount: outcome.failed,
            lastError: outcome.error,
          },
        });
      } catch (err) {
        logger.error('Campaign', `Étape ${step.id} échouée`, err);
        await prisma.campaignStep.update({
          where: { id: step.id },
          data: {
            status: CampaignStepStatus.FAILED,
            sentAt: new Date(),
            lastError: err instanceof Error ? err.message : 'Erreur inconnue',
          },
        }).catch(() => null);
      }
    }
  }

  await refreshCampaignMetrics(client).catch((err) => {
    logger.error('Campaign', 'Rafraîchissement des mesures échoué', err);
  });
}

/**
 * Relit les reactions des messages postes par les campagnes en cours.
 *
 * Les reactions sont le seul signal d'attention que Discord expose sans
 * privilege particulier : ni vue, ni clic sur un lien ne sont mesurables. Les
 * annoncer comme tels evite de laisser croire a un suivi qu'on n'a pas.
 */
export async function refreshCampaignMetrics(client: Client): Promise<void> {
  const steps = await prisma.campaignStep.findMany({
    where: {
      status: CampaignStepStatus.SENT,
      messageId: { not: null },
      channelId: { not: null },
      campaign: { status: { in: [CampaignStatus.RUNNING, CampaignStatus.COMPLETED] } },
    },
    include: { campaign: { select: { guildId: true } } },
    // Les campagnes closes depuis longtemps ne bougent plus : on relit les
    // plus recentes d'abord et on s'arrete la.
    orderBy: { sentAt: 'desc' },
    take: 50,
  });

  for (const step of steps) {
    const guild = client.guilds.cache.get(step.campaign.guildId);
    const channel = guild ? await guild.channels.fetch(step.channelId!).catch(() => null) : null;
    if (!channel?.isTextBased()) continue;

    const message = await channel.messages.fetch(step.messageId!).catch(() => null);
    if (!message) continue;

    const reactionCount = message.reactions.cache.reduce((sum, reaction) => sum + reaction.count, 0);
    if (reactionCount === step.reactionCount) continue;

    await prisma.campaignStep.update({
      where: { id: step.id },
      data: { reactionCount, metricsAt: new Date() },
    }).catch(() => null);
  }
}

export type CampaignReport = {
  recipients: number;
  delivered: number;
  failed: number;
  reactions: number;
  /** Arrivees creditees au code d'invitation de la campagne depuis son depart. */
  joins: number;
};

/**
 * Indicateurs consolides d'une campagne.
 *
 * Les conversions ne sont comptees que si la campagne porte un code
 * d'invitation : sans lui, rien ne relie une arrivee a la campagne, et un
 * chiffre invente serait pire qu'un chiffre absent.
 */
export async function getCampaignReport(campaignId: string): Promise<CampaignReport | null> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    include: { steps: true },
  });
  if (!campaign) return null;

  const totals = campaign.steps.reduce(
    (acc, step) => ({
      recipients: acc.recipients + step.recipientCount,
      delivered: acc.delivered + step.deliveredCount,
      failed: acc.failed + step.failedCount,
      reactions: acc.reactions + step.reactionCount,
    }),
    { recipients: 0, delivered: 0, failed: 0, reactions: 0 },
  );

  let joins = 0;
  if (campaign.inviteCode && campaign.startAt) {
    joins = await prisma.memberInvite.count({
      where: {
        guildId: campaign.guildId,
        inviteCode: campaign.inviteCode,
        joinedAt: { gte: campaign.startAt },
      },
    });
  }

  return { ...totals, joins };
}
