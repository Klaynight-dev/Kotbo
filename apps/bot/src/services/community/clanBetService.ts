/**
 * Paris en points de clan : duel nominatif, pool à plusieurs, équipes, et paris
 * libres que n'importe qui peut rejoindre.
 *
 * Un pari est toujours un ensemble de camps qui se disputent un pot, et le duel
 * n'en est qu'un cas particulier - deux camps d'une place. Un seul moteur de
 * résolution suffit donc : le camp désigné par l'arbitre se partage le pot au
 * prorata de ce que ses membres ont réellement engagé.
 *
 * Le pari fonctionne à l'intérieur d'un clan comme entre plusieurs : les points
 * vivent sur la ligne de contribution (clan, membre, saison), donc un transfert
 * entre deux membres du même clan laisse le total du clan inchangé, tandis qu'un
 * transfert entre deux clans le déplace réellement.
 *
 * Les mises sont prélevées **à l'entrée** : chacun paie en rejoignant, l'auteur
 * comme les autres. Un prélèvement différé obligerait à réserver les points
 * promis, à revérifier la solvabilité de tout le monde à la clôture des
 * inscriptions, et à gérer un prélèvement groupé qui peut échouer à moitié. Ici,
 * on paie ce qu'on vient de voir à l'écran, et un pari qui n'aboutit pas
 * rembourse - expiration et retrait compris.
 *
 * Quand le mode dette est ouvert, la part de mise que le solde ne couvre pas
 * devient une dette de points de clan, remboursée sur les gains futurs. Cette
 * part reste de la valeur réelle dans le pot : le gagnant touche la mise
 * annoncée, endetté ou non.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  userMention,
  type ButtonInteraction,
  type Channel,
  type ChatInputCommandInteraction,
  type Client,
  type Guild as DiscordGuild,
  type GuildMember,
  type Message,
  type NewsChannel,
  type StringSelectMenuInteraction,
  type TextChannel,
} from 'discord.js';
import { Prisma } from '@prisma/client';
import type { ClanBet, ClanBetParticipant, ClanBetSide } from '@prisma/client';
import {
  BET_PARTICIPANTS_MIN,
  BET_SIDE_LABEL_MAX_LENGTH,
  BET_SUBJECT_MAX_LENGTH,
  CLAN_BET_SETTINGS_SELECT,
  buildBetThreadName,
  buildBettorStandings,
  buildSeasonLaureates,
  checkStake,
  computeBetPot,
  engagedAmount,
  nextSeatStake,
  normalizeBetSubject,
  normalizeClanBetSettings,
  parseBetSides,
  planStakeFunding,
  sideOdds,
  splitPot,
  type BetAccess,
  type BetShape,
  type BetStakeMode,
  type ClanBetSettings,
  type SettledBet,
} from '@kotbo/shared';
import { kotboEventBus } from '@kotbo/core';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { COLORS_RAW } from '../../utils/embeds.js';
import { isModuleEnabled } from '../core/moduleGate.js';
import { isStaffServerGuild } from '../staff/staffServerService.js';
import { creditClanContribution, logClanContribution, type ClanContributionSource } from './clanService.js';
import { broadcastDashboardStateChange } from '../../api/shared.js';
import { cancelClanPointDebt, getClanPointDebt, openClanPointDebt } from './clanDebtService.js';
import { buildLinkedAccountFolder, getAllLinkedUserIds } from '../moderation/altAccountService.js';

export type BetStatus =
  | 'PENDING'
  | 'LOCKED'
  | 'ACTIVE'
  | 'RESOLVED'
  | 'REFUNDED'
  | 'DECLINED'
  | 'CANCELLED'
  | 'EXPIRED';

/** États dans lesquels un pari occupe encore une place dans le quota d'un membre. */
const OPEN_STATUSES: BetStatus[] = ['PENDING', 'LOCKED', 'ACTIVE'];

/**
 * Prévient les tableaux de bord ouverts qu'un pari a bougé.
 *
 * Tout se joue sur Discord, mais l'onglet Paris regarde la même base : sans
 * cette annonce, il ne montre que l'état trouvé à son ouverture, et un
 * administrateur qui arbitre depuis le dashboard travaille sur une liste
 * périmée. Diffusion volontairement distincte de `clans_updated` : les paris
 * bougent bien plus souvent que les clans, et ne justifient pas de recharger
 * toute la page.
 */
function notifyBetsChanged(guildId: string): void {
  broadcastDashboardStateChange(guildId, 'clan_bets_updated');
}

/** Salons où le bot sait publier un pari et y ouvrir un fil. */
type BetTextChannel = TextChannel | NewsChannel;

type SideWithParticipants = ClanBetSide & { participants: ClanBetParticipant[] };
/** Un pari ne se lit jamais seul : son argent vit sur ses participants. */
export type FullBet = ClanBet & { sides: SideWithParticipants[] };

const BET_INCLUDE = {
  sides: {
    orderBy: { position: 'asc' },
    include: { participants: { orderBy: { joinedAt: 'asc' } } },
  },
} as const;

const frenchNumber = (value: number) => value.toLocaleString('fr-FR');

/** Plafond d'un champ d'embed Discord. Au-delà, l'embed entier est refusé. */
const FIELD_VALUE_LIMIT = 1024;

/**
 * Neutralise les caractères qui casseraient un libellé de lien markdown.
 * Le sujet d'un pari est du texte libre : un crochet ou une parenthèse y suffit
 * à faire dérailler le lien, qui s'afficherait alors en syntaxe brute.
 */
function escapeLinkLabel(raw: string): string {
  return raw.replace(/[[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ─── Lecture d'un pari ───────────────────────────────────────────────────────

async function loadBet(betId: string): Promise<FullBet | null> {
  return prisma.clanBet.findUnique({ where: { id: betId }, include: BET_INCLUDE });
}

/** Participants ayant réellement engagé une mise. Les invités n'ont rien payé. */
function joinedOf(side: SideWithParticipants): ClanBetParticipant[] {
  return side.participants.filter((entry) => entry.status === 'JOINED');
}

function allJoined(bet: FullBet): ClanBetParticipant[] {
  return bet.sides.flatMap(joinedOf);
}

function betPot(bet: FullBet): number {
  return computeBetPot(allJoined(bet));
}

function sideEngaged(side: SideWithParticipants): number {
  return computeBetPot(joinedOf(side));
}

function findParticipant(bet: FullBet, userKeys: string[]): ClanBetParticipant | null {
  for (const side of bet.sides) {
    const found = side.participants.find((entry) => userKeys.includes(entry.userKey));
    if (found) return found;
  }
  return null;
}

function sideById(bet: FullBet, sideId: string | null): SideWithParticipants | null {
  if (!sideId) return null;
  return bet.sides.find((side) => side.id === sideId) ?? null;
}

/** Un camp plein n'accepte plus personne ; une capacité nulle ne limite rien. */
function sideHasRoom(side: SideWithParticipants): boolean {
  if (side.capacity === null) return true;
  return side.participants.filter((entry) => entry.status !== 'DECLINED').length < side.capacity;
}

/**
 * Un pari démarre quand plus personne n'est attendu : tous les camps à effectif
 * fixe sont pleins, et au moins deux camps sont occupés.
 *
 * Sans capacité déclarée, rien ne dit que les inscriptions sont finies : c'est
 * l'échéance ou l'auteur qui déclenchent le départ.
 */
function isReadyToStart(bet: FullBet): boolean {
  if (!hasOpposition(bet)) return false;
  return bet.sides.every((side) => side.capacity !== null && !sideHasRoom(side));
}

/** Deux camps occupés au minimum : un pari à camp unique n'a pas d'adversaire. */
function hasOpposition(bet: FullBet): boolean {
  return bet.sides.filter((side) => joinedOf(side).length > 0).length >= 2;
}

/**
 * Reste-t-il quelqu'un susceptible de rejoindre ?
 *
 * Un pari sur invitation n'est ouvert qu'à ses invités : une fois le dernier
 * d'entre eux parti, ses places vides ne se rempliront jamais. Attendre
 * l'échéance immobiliserait la mise de l'auteur pour rien - or elle est
 * prélevée dès l'ouverture.
 */
function canStillFill(bet: FullBet): boolean {
  if (bet.access === 'OPEN') return bet.sides.some(sideHasRoom);
  return bet.sides.some((side) => side.participants.some((entry) => entry.status === 'INVITED'));
}

// ─── Réglages du serveur ─────────────────────────────────────────────────────

export async function getClanBetSettings(guildId: string): Promise<ClanBetSettings> {
  const row = await prisma.guild.findUnique({ where: { id: guildId }, select: CLAN_BET_SETTINGS_SELECT });
  return normalizeClanBetSettings(row);
}

/**
 * Les paris sont disponibles quand leur propre interrupteur est ouvert **et**
 * que le module de clans tourne : la mise est un point de clan, un pari sans
 * clans n'aurait rien à déplacer.
 */
async function isBettingOpen(guildId: string, settings: ClanBetSettings): Promise<boolean> {
  if (!settings.betsEnabled) return false;
  return isModuleEnabled(guildId, 'clans');
}

// ─── Accès aux points de clan ────────────────────────────────────────────────

type ClanRef = { id: string; name: string; roleId: string };

/**
 * Identifiant sous lequel les points d'un membre sont comptés. Un membre ayant
 * un double compte validé n'a qu'une seule ligne de contribution : débiter sous
 * son identifiant du moment en créerait une seconde, à côté de son score réel.
 */
async function linkedUserIds(guildId: string, userId: string): Promise<string[]> {
  const linked = await getAllLinkedUserIds(guildId, userId).catch(() => [userId]);
  return linked.length > 0 ? linked : [userId];
}

async function canonicalUserId(guildId: string, userId: string): Promise<string> {
  return (await linkedUserIds(guildId, userId)).slice().sort()[0] ?? userId;
}

async function readClanPoints(guildId: string, clanId: string, userId: string, season: number): Promise<number> {
  const row = await prisma.clanMemberContribution.findUnique({
    where: { guildId_clanId_userId_season: { guildId, clanId, userId, season } },
    select: { xp: true },
  });
  return Math.max(0, row?.xp ?? 0);
}

function findMemberClan(clans: ClanRef[], member: GuildMember): ClanRef | null {
  const role = member.roles.cache.find((entry) => clans.some((clan) => clan.roleId === entry.id));
  if (!role) return null;
  return clans.find((clan) => clan.roleId === role.id) ?? null;
}

type BetContext = { season: number; clans: ClanRef[] };

async function loadBetContext(guildId: string): Promise<BetContext | null> {
  const guildConfig = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { clansEnabled: true, currentClanSeason: true },
  });
  if (!guildConfig?.clansEnabled) return null;

  const clans = await prisma.clan.findMany({
    where: { guildId },
    select: { id: true, name: true, roleId: true },
  });
  if (clans.length === 0) return null;

  return { season: guildConfig.currentClanSeason, clans };
}

/**
 * Déplace des points de clan et journalise le mouvement pour le flux public.
 * Retourne le montant réellement inscrit, qui peut être inférieur au montant
 * demandé quand le plafond de saison s'applique.
 */
async function moveClanPoints(params: {
  guildId: string;
  clanId: string;
  userId: string;
  season: number;
  amount: number;
  skipDebt?: boolean;
  credit?: number;
  source?: ClanContributionSource;
}): Promise<{ granted: number; debtRepaid: number }> {
  const { granted, debtRepaid } = await creditClanContribution(params);

  // Le flux public reçoit le gain **brut**, pas le solde net : le remboursement
  // est journalisé séparément par `creditClanContribution`, en négatif. Loguer
  // le net ici ferait disparaître les deux lignes dans une seule, et le montant
  // affiché sur le site ne correspondrait plus à celui annoncé sur Discord.
  await logClanContribution(
    params.guildId,
    params.clanId,
    params.userId,
    granted + debtRepaid,
    params.source ?? 'BET',
    params.season,
    params.credit,
  );
  return { granted, debtRepaid };
}

// ─── Salons ──────────────────────────────────────────────────────────────────

export function asBetChannel(channel: Channel | null | undefined): BetTextChannel | null {
  if (!channel) return null;
  if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) return channel;
  return null;
}

/**
 * Salon désigné par un réglage, ou `null` quand rien n'est réglé.
 *
 * Aucune recherche par nom : un serveur qui possède un salon nommé comme celui
 * que le bot cherchait se voyait imposer une restriction qu'il n'avait jamais
 * demandée, et la seule façon de s'en défaire était de renommer le salon.
 * Un réglage vide veut dire « pas de contrainte », pas « devine ».
 */
async function resolveConfiguredChannel(
  guild: DiscordGuild,
  channelId: string | null,
): Promise<BetTextChannel | null> {
  if (!channelId) return null;

  const cached = guild.channels.cache.get(channelId);
  if (cached) return asBetChannel(cached);

  return asBetChannel(await guild.channels.fetch(channelId).catch(() => null));
}

/**
 * Salon où les paris se lancent. `null` laisse la commande utilisable partout.
 */
export async function resolveBetChannel(guild: DiscordGuild, settings: ClanBetSettings): Promise<BetTextChannel | null> {
  return resolveConfiguredChannel(guild, settings.betChannelId);
}

/**
 * Salon du récapitulatif. Sans réglage, il est publié là où le pari a été
 * ouvert : c'est le seul endroit dont on sait que les parieurs le lisent.
 */
async function resolveAnnouncementChannel(
  guild: DiscordGuild,
  settings: ClanBetSettings,
  fallbackChannelId: string,
): Promise<BetTextChannel | null> {
  const configured = await resolveConfiguredChannel(guild, settings.betAnnouncementChannelId);
  return configured ?? resolveConfiguredChannel(guild, fallbackChannelId);
}

// ─── Annonce ─────────────────────────────────────────────────────────────────

function statusLine(bet: FullBet): { text: string; color: number } {
  const pot = betPot(bet);

  switch (bet.status as BetStatus) {
    case 'PENDING': {
      const waiting = bet.sides
        .flatMap((side) => side.participants)
        .filter((entry) => entry.status === 'INVITED');
      const expiry = `expire <t:${Math.floor(bet.expiresAt.getTime() / 1000)}:R>`;

      if (waiting.length > 0) {
        const names = waiting.map((entry) => userMention(entry.userId)).join(', ');
        return { text: `⏳ En attente de ${names} · ${expiry}`, color: COLORS_RAW.warning };
      }
      return {
        text: `⏳ Inscriptions ouvertes · **${frenchNumber(pot)} points** déjà dans le pot · ${expiry}`,
        color: COLORS_RAW.warning,
      };
    }
    case 'LOCKED':
      return { text: '⏳ Traitement en cours...', color: COLORS_RAW.warning };
    case 'ACTIVE':
      return {
        text: `🔥 Pari en cours · **${frenchNumber(pot)} points** dans le pot\nSeul un arbitre peut le clore.`,
        color: COLORS_RAW.primary,
      };
    case 'RESOLVED': {
      const winning = sideById(bet, bet.winningSideId);
      const winners = winning ? joinedOf(winning) : [];
      if (winners.length === 0) return { text: '🏆 Pari tranché.', color: COLORS_RAW.success };

      // Le gain **net**, pas le versement : le pot contient la mise du gagnant,
      // qui lui appartenait déjà. Annoncer le versement brut donnerait à lire
      // une création de points là où il n'y a qu'un transfert.
      const lines = winners.map((entry) => {
        const net = entry.payout - engagedAmount(entry);
        const repaid = entry.debtRepaid > 0
          ? ` *(dont ${frenchNumber(entry.debtRepaid)} en remboursement de dette)*`
          : '';
        return `${userMention(entry.userId)} · **+${frenchNumber(net)}**${repaid}`;
      });

      return {
        text: `🏆 **${winning?.label ?? 'Camp gagnant'}** l'emporte.\n${lines.join('\n')}`,
        color: COLORS_RAW.success,
      };
    }
    case 'REFUNDED':
      // Sans `resolvedById`, personne n'a cliqué : clôture de saison, balayage,
      // ou arbitrage automatisé. Nommer une cause précise en inventerait une -
      // et l'annoncer comme une décision d'arbitre ferait chercher un
      // responsable qui n'existe pas.
      return {
        text: bet.resolvedById
          ? '↩️ Pari annulé par un arbitre : les mises ont été rendues.'
          : '↩️ Pari annulé : les mises ont été rendues.',
        color: COLORS_RAW.dark,
      };
    case 'DECLINED':
      return { text: '❌ Proposition refusée.', color: COLORS_RAW.danger };
    case 'CANCELLED':
      return { text: '🚫 Pari retiré par son auteur : les mises ont été rendues.', color: COLORS_RAW.dark };
    case 'EXPIRED':
      return { text: '🕓 Pari expiré sans adversaire : les mises ont été rendues.', color: COLORS_RAW.dark };
    default:
      return { text: bet.status, color: COLORS_RAW.dark };
  }
}

/**
 * Un camp et ses membres, avec sa cote.
 *
 * La cote est affichée pendant les inscriptions parce que c'est elle qui rend un
 * déséquilibre lisible : un camp en sous-nombre rapporte davantage, ce qui pousse
 * les arrivants vers le camp le moins peuplé. Sans elle, un 1 contre 3 passe pour
 * une injustice au lieu d'un pari plus payant.
 */
function renderSide(bet: FullBet, side: SideWithParticipants, clanNames: Map<string, string>): string {
  const pot = betPot(bet);
  const engaged = sideEngaged(side);
  const joined = joinedOf(side);
  const invited = side.participants.filter((entry) => entry.status === 'INVITED');

  const seats = side.capacity !== null ? ` (${joined.length}/${side.capacity})` : ` (${joined.length})`;
  const odds = bet.status === 'RESOLVED' || engaged <= 0 ? '' : ` · cote **x${sideOdds(engaged, pot).toFixed(2)}**`;

  const members = joined.map((entry) => {
    const clan = entry.clanId ? clanNames.get(entry.clanId) : null;
    const credit = entry.debt > 0 ? ` · 💳 ${frenchNumber(entry.debt)} à crédit` : '';
    return `${userMention(entry.userId)}${clan ? ` - *${clan}*` : ''}${credit}`;
  });
  for (const entry of invited) members.push(`${userMention(entry.userId)} - *invité, n'a pas encore répondu*`);
  if (members.length === 0) members.push('*Personne pour l\'instant.*');

  return `**${side.label}**${seats}${odds}\n${members.join('\n')}`;
}

function describeShape(bet: ClanBet): string {
  const access = bet.access === 'OPEN' ? 'ouvert à tous' : 'sur invitation';
  switch (bet.shape as BetShape) {
    case 'POOL':
      return `Pool · ${access}`;
    case 'TEAMS':
      return `Équipes · ${access}`;
    default:
      return `Duel · ${access}`;
  }
}

/**
 * Empile des lignes sans dépasser le plafond d'un champ d'embed.
 *
 * Une troncature brute couperait une mention en plein milieu et afficherait
 * « <@123456 » en clair. Les lignes entières sont donc gardées, et le reste
 * annoncé par un décompte.
 */
function capLines(lines: string[], separator = '\n'): string {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (kept.length > 0 && used + line.length + separator.length > FIELD_VALUE_LIMIT - 40) break;
    kept.push(line);
    used += line.length + separator.length;
  }
  const hidden = lines.length - kept.length;
  if (hidden > 0) kept.push(`*… et ${hidden} de plus.*`);
  return kept.join(separator) || '*Aucun.*';
}

function buildBetEmbed(bet: FullBet, clanNames: Map<string, string>): EmbedBuilder {
  const status = statusLine(bet);
  const pot = betPot(bet);

  const stakeLabel = bet.stakeMode === 'PER_SIDE'
    ? `${frenchNumber(bet.stake)} points **par camp**`
    : `${frenchNumber(bet.stake)} points **par personne**`;

  const embed = new EmbedBuilder()
    .setTitle(`⚔️ Pari : ${bet.subject}`.slice(0, 256))
    .setColor(status.color)
    .setDescription(status.text)
    .addFields(
      { name: 'Mise', value: stakeLabel, inline: true },
      { name: 'Pot', value: `${frenchNumber(pot)} points`, inline: true },
      { name: 'Format', value: describeShape(bet), inline: true },
    )
    .setFooter({ text: `Saison ${bet.season} · ID : ${bet.id}` })
    .setTimestamp(bet.createdAt);

  // Un pool est fait de camps d'une place tous équivalents : les détailler un à
  // un remplirait l'embed de « Place 4 (0/1) » et de cotes identiques. Seuls les
  // parieurs comptent, et le siège vide se résume à un décompte.
  if (bet.shape === 'POOL') {
    const seats = bet.sides.length;
    const players = allJoined(bet);
    const lines = players.map((entry) => {
      const clan = entry.clanId ? clanNames.get(entry.clanId) : null;
      const credit = entry.debt > 0 ? ` · 💳 ${frenchNumber(entry.debt)} à crédit` : '';
      const crown = entry.sideId === bet.winningSideId ? '🏆 ' : '';
      return `${crown}${userMention(entry.userId)}${clan ? ` - *${clan}*` : ''}${credit}`;
    });
    if (lines.length === 0) lines.push('*Personne pour l\'instant.*');

    embed.addFields({
      name: `Parieurs (${players.length}/${seats})`,
      value: capLines(lines),
      inline: false,
    });
  } else if (bet.sides.length <= 6) {
    // Un camp par champ tant que Discord en accepte.
    for (const side of bet.sides) {
      embed.addFields({ name: '​', value: renderSide(bet, side, clanNames).slice(0, FIELD_VALUE_LIMIT), inline: false });
    }
  } else {
    // Au-delà, la liste est repliée dans un seul champ, sans quoi l'embed entier
    // est refusé.
    embed.addFields({
      name: 'Camps',
      value: capLines(bet.sides.map((side) => renderSide(bet, side, clanNames)), '\n\n'),
      inline: false,
    });
  }

  const onCredit = allJoined(bet).reduce((sum, entry) => sum + Math.max(0, entry.debt), 0);
  if (bet.status === 'ACTIVE' && onCredit > 0) {
    embed.addFields({
      name: '💳 Mise à crédit',
      value: `${frenchNumber(onCredit)} point(s) du pot sont engagés à crédit : ils seront prélevés sur les prochains gains de leurs parieurs.`,
    });
  }

  return embed;
}

/**
 * Les messages du bot partent en Components V2 : une édition qui ne repasse pas
 * les composants les efface. Cette fonction est donc la seule source des
 * boutons, et elle renvoie une liste vide pour les paris clos.
 */
function buildBetComponents(bet: FullBet): ActionRowBuilder<ButtonBuilder>[] {
  // Le bouton d'annulation est affiché à tout le monde : le droit est vérifié au
  // clic. Le masquer supposerait de connaître les rôles de chaque lecteur au
  // moment du rendu, ce que l'édition d'un message ne permet pas.
  const voidButton = new ButtonBuilder()
    .setCustomId(`bet:void:${bet.id}`)
    .setLabel('Annuler (admin)')
    .setEmoji('↩️')
    .setStyle(ButtonStyle.Secondary);

  if (bet.status === 'ACTIVE') {
    return [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`bet:resolve:${bet.id}`).setLabel('Désigner le camp gagnant (admin)').setEmoji('⚖️').setStyle(ButtonStyle.Primary),
        voidButton,
      ),
    ];
  }

  if (bet.status !== 'PENDING') return [];

  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  const openSides = bet.sides.filter(sideHasRoom);

  if (bet.access === 'TARGETED' && bet.shape === 'DUEL') {
    // Le duel nominatif garde ses deux boutons : la place est réservée à la
    // personne défiée, un « Rejoindre » laisserait croire qu'elle est ouverte.
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`bet:accept:${bet.id}`).setLabel('Accepter').setEmoji('✅').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`bet:decline:${bet.id}`).setLabel('Refuser').setEmoji('❌').setStyle(ButtonStyle.Danger),
    ));
  } else if (bet.shape === 'DUEL') {
    // Duel ouvert : une seule place est à prendre, celle d'en face. Un bouton
    // par camp afficherait le nom de l'auteur sur un bouton grisé, à côté du
    // seul qui sert.
    const free = bet.sides.find(sideHasRoom);
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`bet:join:${bet.id}:${free?.position ?? 1}`)
        .setLabel('Relever le défi')
        .setEmoji('⚔️')
        .setStyle(ButtonStyle.Success)
        .setDisabled(!free),
    ));
  } else if (bet.shape === 'POOL') {
    // Tous les camps d'un pool sont équivalents : un bouton unique suffit, et
    // c'est le premier siège libre qui est pris.
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`bet:join:${bet.id}:*`)
        .setLabel('Rejoindre le pari')
        .setEmoji('🎲')
        .setStyle(ButtonStyle.Success)
        .setDisabled(openSides.length === 0),
    ));
  } else {
    // Un bouton par camp, cinq au plus par rangée.
    const buttons = bet.sides.map((side) =>
      new ButtonBuilder()
        .setCustomId(`bet:join:${bet.id}:${side.position}`)
        .setLabel(`Rejoindre ${side.label}`.slice(0, 80))
        .setStyle(ButtonStyle.Success)
        .setDisabled(!sideHasRoom(side)),
    );
    for (let i = 0; i < buttons.length; i += 5) {
      rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
    }
  }

  const manage: ButtonBuilder[] = [];

  // Sur un duel nominatif, l'auteur est seul inscrit et attend une réponse :
  // « Quitter » n'a personne à faire sortir et « Lancer » n'aurait aucun
  // adversaire à opposer. Les afficher inviterait à cliquer dans le vide.
  if (bet.shape !== 'DUEL' || bet.access === 'OPEN') {
    manage.push(
      new ButtonBuilder().setCustomId(`bet:leave:${bet.id}`).setLabel('Quitter').setEmoji('🚪').setStyle(ButtonStyle.Secondary),
    );
    if (hasOpposition(bet)) {
      manage.push(
        new ButtonBuilder().setCustomId(`bet:start:${bet.id}`).setLabel('Lancer (auteur)').setEmoji('▶️').setStyle(ButtonStyle.Primary),
      );
    }
  }

  manage.push(
    new ButtonBuilder().setCustomId(`bet:cancel:${bet.id}`).setLabel('Retirer').setEmoji('🚫').setStyle(ButtonStyle.Secondary),
    voidButton,
  );
  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(manage));

  return rows.slice(0, 5);
}

async function clanNamesFor(bet: FullBet): Promise<Map<string, string>> {
  const ids = [...new Set(allJoined(bet).map((entry) => entry.clanId).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();

  const clans = await prisma.clan.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  return new Map(clans.map((clan) => [clan.id, clan.name]));
}

/** Réécrit l'annonce d'un pari. Best-effort : un message supprimé ne doit pas faire échouer le règlement. */
async function refreshBetMessage(client: Client, bet: FullBet): Promise<void> {
  if (!bet.messageId) return;
  try {
    const guild = client.guilds.cache.get(bet.guildId) ?? await client.guilds.fetch(bet.guildId);
    const channel = guild.channels.cache.get(bet.channelId) ?? await guild.channels.fetch(bet.channelId);
    if (!channel?.isTextBased()) return;

    const message = await channel.messages.fetch(bet.messageId);
    const names = await clanNamesFor(bet);
    await message.edit({ embeds: [buildBetEmbed(bet, names)], components: buildBetComponents(bet) });
  } catch (err) {
    logger.warn('ClanBet', `Annonce du pari ${bet.id} non rafraîchie :`, err);
  }
}

/** Clôt le fil de discussion d'un pari réglé, après y avoir laissé le verdict. */
async function closeBetThread(client: Client, bet: FullBet, verdict: string): Promise<void> {
  if (!bet.threadId) return;
  try {
    const channel = await client.channels.fetch(bet.threadId);
    if (!channel?.isThread()) return;
    await channel.send(verdict).catch(() => undefined);
    await channel.setLocked(true).catch(() => undefined);
    await channel.setArchived(true).catch(() => undefined);
  } catch (err) {
    logger.warn('ClanBet', `Fil du pari ${bet.id} non clôturé :`, err);
  }
}

function betMessageLink(bet: ClanBet): string | null {
  if (!bet.messageId) return null;
  return `https://discord.com/channels/${bet.guildId}/${bet.channelId}/${bet.messageId}`;
}

/**
 * Récapitulatif public une fois le verdict rendu. Publié dans le salon
 * d'annonces, séparé du salon où les paris se négocient : le premier sert
 * d'historique lisible, le second est bruyant.
 */
async function announceBetOutcome(client: Client, bet: FullBet): Promise<void> {
  try {
    const guild = client.guilds.cache.get(bet.guildId) ?? await client.guilds.fetch(bet.guildId);
    const settings = await getClanBetSettings(bet.guildId);
    const channel = await resolveAnnouncementChannel(guild, settings, bet.channelId);
    if (!channel) return;

    const names = await clanNamesFor(bet);
    const resolved = bet.status === 'RESOLVED';
    const winning = sideById(bet, bet.winningSideId);

    const embed = new EmbedBuilder()
      .setTitle(resolved ? '🏆 Résultat du pari' : '↩️ Pari annulé')
      .setColor(resolved ? COLORS_RAW.success : COLORS_RAW.dark)
      .setDescription(`**${bet.subject}**`)
      .addFields(
        { name: 'Format', value: describeShape(bet), inline: true },
        { name: 'Pot', value: `${frenchNumber(betPot(bet))} points`, inline: true },
      )
      .setFooter({ text: `Saison ${bet.season} · ID : ${bet.id}` })
      .setTimestamp(bet.resolvedAt ?? new Date());

    if (resolved && winning) {
      // Gagnants et perdants sont annoncés sur la même échelle : ce que les uns
      // gagnent est exactement ce que les autres perdent. Afficher le versement
      // d'un côté et la mise de l'autre laisserait croire que des points sortent
      // de nulle part.
      const line = (entry: ClanBetParticipant, sign: '+' | '-') => {
        const amount = sign === '+' ? entry.payout - engagedAmount(entry) : engagedAmount(entry);
        const clan = entry.clanId ? names.get(entry.clanId) : null;
        const note = sign === '+' && entry.debtRepaid > 0
          ? `\n💳 ${frenchNumber(entry.debtRepaid)} partis en remboursement de sa dette`
          : sign === '-' && entry.debt > 0
            ? `\n💳 dont ${frenchNumber(entry.debt)} restent dus`
            : '';
        return `${userMention(entry.userId)}${clan ? ` - *${clan}*` : ''} · **${sign}${frenchNumber(amount)}**${note}`;
      };

      const losers = bet.sides.filter((side) => side.id !== winning.id).flatMap(joinedOf);
      embed.addFields(
        { name: `Vainqueurs - ${winning.label}`, value: joinedOf(winning).map((e) => line(e, '+')).join('\n').slice(0, FIELD_VALUE_LIMIT) || '*Aucun.*' },
        { name: 'Perdants', value: losers.map((e) => line(e, '-')).join('\n').slice(0, FIELD_VALUE_LIMIT) || '*Aucun.*' },
      );
    } else {
      embed.addFields({
        name: 'Issue',
        value: 'Mises rendues à tous les parieurs',
      });
    }

    if (bet.resolvedById) {
      embed.addFields({ name: 'Tranché par', value: userMention(bet.resolvedById), inline: true });
    }

    const link = betMessageLink(bet);
    const components = link
      ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setLabel('Voir le pari').setStyle(ButtonStyle.Link).setURL(link),
        )]
      : [];

    await channel.send({ embeds: [embed], components });
  } catch (err) {
    logger.error('ClanBet', `Annonce du résultat du pari ${bet.id} impossible :`, err);
  }
}

// ─── Commande ────────────────────────────────────────────────────────────────

async function replyEphemeral(
  interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction,
  content: string,
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content }).catch(() => undefined);
    return;
  }
  await interaction.reply({ content, flags: [MessageFlags.Ephemeral] }).catch(() => undefined);
}

function describeStakeRejection(check: Exclude<ReturnType<typeof checkStake>, { ok: true }>): string {
  switch (check.reason) {
    case 'not-integer':
      return 'La mise doit être un nombre entier de points de clan.';
    case 'below-min':
      return `La mise minimale sur ce serveur est de ${frenchNumber(check.min)} point(s) de clan.`;
    default:
      return `La mise maximale sur ce serveur est de ${frenchNumber(check.max)} points de clan.`;
  }
}

function describeFundingRejection(
  funding: Exclude<ReturnType<typeof planStakeFunding>, { ok: true }>,
  settings: ClanBetSettings,
): string {
  if (funding.reason !== 'insufficient-points') {
    return `Plafond de dette atteint : ${frenchNumber(funding.currentDebt)} point(s) déjà dus sur ${frenchNumber(funding.maxDebt)} autorisés.`;
  }

  const credit = settings.betAllowDebt
    ? ''
    : " Le mode dette n'est pas activé sur ce serveur : impossible de miser des points que tu n'as pas.";

  return `Mise trop élevée : ${frenchNumber(funding.available)} point(s) de clan disponible(s) cette saison.${credit}`;
}

/** Ce qu'un membre a le droit d'engager, après vérification de son clan. */
type Seat = { clan: ClanRef; userKey: string; member: GuildMember };

async function resolveSeat(
  guildId: string,
  context: BetContext,
  member: GuildMember,
): Promise<{ ok: true; seat: Seat } | { ok: false; message: string }> {
  const clan = findMemberClan(context.clans, member);
  if (!clan) {
    return { ok: false, message: `${member.toString()} n'appartient à aucun clan : impossible de miser des points de clan.` };
  }
  return { ok: true, seat: { clan, userKey: await canonicalUserId(guildId, member.id), member } };
}

/**
 * Paris ouverts d'un membre, comptés sur la personne et non sur le compte.
 *
 * `exceptBetId` écarte le pari en cours d'examen : une personne invitée y occupe
 * déjà une ligne, et la compter reviendrait à lui refuser d'accepter un défi qui
 * tient pourtant dans son quota.
 */
async function openBetCount(guildId: string, userKeys: string[], exceptBetId?: string): Promise<number> {
  return prisma.clanBet.count({
    where: {
      guildId,
      id: exceptBetId ? { not: exceptBetId } : undefined,
      status: { in: OPEN_STATUSES },
      participants: { some: { userKey: { in: userKeys }, status: { in: ['JOINED', 'INVITED'] } } },
    },
  });
}

// ─── Prélèvement ─────────────────────────────────────────────────────────────

/**
 * Engage la mise d'un parieur : points d'abord, crédit ensuite.
 * Retourne ce qui a été réellement prélevé et ce qui a été mis à crédit.
 *
 * Un échec après le prélèvement rend les points avant de remonter : sinon le
 * parieur perdrait sa mise sans qu'aucune place ne soit prise en face.
 */
async function stakeFor(params: {
  guildId: string;
  clanId: string;
  userKey: string;
  season: number;
  fromPoints: number;
  fromDebt: number;
}): Promise<{ escrow: number; debt: number }> {
  const escrow = params.fromPoints > 0
    ? -(await moveClanPoints({
        guildId: params.guildId,
        clanId: params.clanId,
        userId: params.userKey,
        season: params.season,
        amount: -params.fromPoints,
        // La part à crédit voyage avec la ligne de mise plutôt que dans une
        // ligne à elle : elle n'a bougé aucun score, mais sans elle le
        // remboursement qui viendra plus tard n'a aucune origine visible.
        credit: params.fromDebt,
      })).granted
    : 0;

  if (params.fromDebt > 0) {
    try {
      await openClanPointDebt({ guildId: params.guildId, userId: params.userKey, amount: params.fromDebt, source: 'BET' });
    } catch (err) {
      await unstakeFor({
        guildId: params.guildId,
        clanId: params.clanId,
        userKey: params.userKey,
        season: params.season,
        escrow,
        debt: 0,
      });
      throw err;
    }

    // Une mise entièrement à crédit ne déplace aucun point, donc
    // `moveClanPoints` n'a rien journalisé : sans cette ligne à montant nul,
    // l'engagement de ce parieur n'existerait nulle part dans le flux.
    // Journalisée après l'ouverture de la dette, pour ne rien laisser derrière
    // si celle-ci échoue.
    if (params.fromPoints <= 0) {
      await logClanContribution(params.guildId, params.clanId, params.userKey, 0, 'BET', params.season, params.fromDebt);
    }
  }

  return { escrow, debt: params.fromDebt };
}

/** Rend à un parieur ce qui lui a été pris : les points reviennent, le crédit s'efface. */
async function unstakeFor(params: {
  guildId: string;
  clanId: string | null;
  userKey: string;
  season: number;
  escrow: number;
  debt: number;
}): Promise<void> {
  if (params.clanId && params.escrow > 0) {
    // `skipDebt` : rendre une mise annulée n'est pas un gain. Sans ça, les points
    // rendus iraient solder une dette que l'annulation vient d'effacer.
    await moveClanPoints({
      guildId: params.guildId,
      clanId: params.clanId,
      userId: params.userKey,
      season: params.season,
      amount: params.escrow,
      skipDebt: true,
    }).catch((err: unknown) => {
      logger.error('ClanBet', `Remboursement de la mise de ${params.userKey} impossible :`, err);
      return { granted: 0, debtRepaid: 0 };
    });
  }
  if (params.debt > 0) {
    // Ce que l'annulation ne peut pas effacer a déjà été remboursé sur des gains
    // depuis la mise : ces points-là ont bel et bien été prélevés au parieur, et
    // s'arrêter à l'annulation lui ferait payer une mise qui n'a jamais été
    // jouée. Ils lui sont rendus en points, comme l'escrow et pour la même
    // raison.
    //
    // Zéro dès qu'une des deux lectures échoue : rendre des points sur une
    // annulation dont on ignore l'effet en fabriquerait à partir de rien.
    let unpaid = 0;
    try {
      const owed = await getClanPointDebt(params.guildId, params.userKey);
      const left = await cancelClanPointDebt(params.guildId, params.userKey, params.debt);
      unpaid = params.debt - Math.max(0, owed - left);
    } catch (err) {
      logger.error('ClanBet', `Annulation du crédit de ${params.userKey} impossible :`, err);
    }

    if (unpaid > 0 && params.clanId) {
      await moveClanPoints({
        guildId: params.guildId,
        clanId: params.clanId,
        userId: params.userKey,
        season: params.season,
        amount: unpaid,
        skipDebt: true,
      }).catch((err: unknown) => {
        logger.error('ClanBet', `Crédit déjà remboursé non rendu à ${params.userKey} :`, err);
        return { granted: 0, debtRepaid: 0 };
      });
    } else if (unpaid > 0) {
      logger.warn('ClanBet', `${unpaid} point(s) de crédit non rendus à ${params.userKey} : aucun clan sur sa mise.`);
    }
  }
}

/**
 * Fait entrer un membre dans un camp, en prélevant sa mise.
 *
 * Tout est vérifié ici plutôt qu'à la création du pari : entre les deux, son
 * solde a pu fondre, son clan changer, un autre pari l'avoir engagé. C'est le
 * seul instant où l'état est celui sur lequel il vient de cliquer.
 */
async function joinSide(params: {
  bet: FullBet;
  side: SideWithParticipants;
  seat: Seat;
  season: number;
  settings: ClanBetSettings;
}): Promise<{ ok: true; participant: ClanBetParticipant } | { ok: false; message: string }> {
  const { bet, side, seat, season, settings } = params;

  // Seules les places payées entrent dans le calcul : une invitation occupe un
  // siège sans avoir rien engagé, et un départ rend sa part au camp plutôt que
  // de la laisser manquer au total annoncé.
  const paid = joinedOf(side);
  const stake = nextSeatStake({
    stake: bet.stake,
    stakeMode: bet.stakeMode as BetStakeMode,
    capacity: side.capacity,
    seatsTaken: paid.length,
    alreadyStaked: paid.reduce((sum, entry) => sum + Math.max(0, entry.stake), 0),
  });

  const funding = planStakeFunding({
    stake,
    availablePoints: await readClanPoints(bet.guildId, seat.clan.id, seat.userKey, season),
    allowDebt: settings.betAllowDebt,
    maxDebt: settings.betMaxDebt,
    currentDebt: await getClanPointDebt(bet.guildId, seat.userKey),
  });
  if (!funding.ok) return { ok: false, message: describeFundingRejection(funding, settings) };

  const taken = await stakeFor({
    guildId: bet.guildId,
    clanId: seat.clan.id,
    userKey: seat.userKey,
    season,
    fromPoints: funding.fromPoints,
    fromDebt: funding.fromDebt,
  });

  try {
    // Une invitation déjà posée occupe la ligne : elle est complétée plutôt que
    // doublée, l'unicité par personne interdisant une seconde ligne.
    const participant = await prisma.clanBetParticipant.upsert({
      where: { betId_userKey: { betId: bet.id, userKey: seat.userKey } },
      update: {
        sideId: side.id,
        userId: seat.member.id,
        clanId: seat.clan.id,
        status: 'JOINED',
        stake,
        escrow: taken.escrow,
        debt: taken.debt,
        joinedAt: new Date(),
      },
      create: {
        betId: bet.id,
        sideId: side.id,
        userId: seat.member.id,
        userKey: seat.userKey,
        clanId: seat.clan.id,
        status: 'JOINED',
        stake,
        escrow: taken.escrow,
        debt: taken.debt,
      },
    });
    return { ok: true, participant };
  } catch (err) {
    // La place n'a pas été prise : rendre la mise, sinon le membre paie une
    // entrée qui n'existe pas.
    await unstakeFor({
      guildId: bet.guildId,
      clanId: seat.clan.id,
      userKey: seat.userKey,
      season,
      escrow: taken.escrow,
      debt: taken.debt,
    });
    logger.error('ClanBet', `Entrée de ${seat.userKey} dans le pari ${bet.id} impossible :`, err);
    return { ok: false, message: 'Impossible de rejoindre ce pari, ta mise t\'a été rendue.' };
  }
}

// ─── Création ────────────────────────────────────────────────────────────────

function describeSideParseFailure(reason: Exclude<ReturnType<typeof parseBetSides>, { ok: true }>['reason'], settings: ClanBetSettings): string {
  switch (reason) {
    case 'too-few':
      return 'Il faut au moins deux camps, séparés par une virgule. Exemple : `Rouge, Bleu`.';
    case 'too-many':
      return `Ce serveur autorise ${settings.betMaxSides} camps au maximum.`;
    case 'duplicate-label':
      return 'Deux camps ne peuvent pas porter le même nom.';
    case 'capacity-required':
      return 'La mise est fixée par camp sur ce serveur : chaque camp doit annoncer son nombre de places. Exemple : `Rouge:1, Bleu:3`.';
    case 'over-capacity':
      return `Ce serveur autorise ${settings.betMaxParticipants} participants au maximum, toutes places confondues.`;
    default:
      return 'Nombre de places invalide. Exemple : `Rouge:1, Bleu:3`.';
  }
}

interface BetDraft {
  shape: BetShape;
  access: BetAccess;
  sides: { label: string; capacity: number | null }[];
  invited: GuildMember[];
}

/**
 * Assemble le pari, y fait entrer son auteur, puis le publie.
 *
 * L'auteur paie comme les autres, avant toute publication : un pari annoncé que
 * son auteur ne peut pas financer ferait venir des adversaires sur une mise qui
 * n'existe pas.
 */
async function createBet(params: {
  interaction: ChatInputCommandInteraction;
  settings: ClanBetSettings;
  context: BetContext;
  channel: BetTextChannel;
  subject: string;
  stake: number;
  draft: BetDraft;
  author: Seat;
}): Promise<void> {
  const { interaction, settings, context, channel, subject, stake, draft, author } = params;
  const guildId = interaction.guildId as string;

  const bet = await prisma.clanBet.create({
    data: {
      guildId,
      channelId: channel.id,
      authorId: interaction.user.id,
      shape: draft.shape,
      access: draft.access,
      stakeMode: settings.betStakeMode,
      subject,
      stake,
      season: context.season,
      status: 'PENDING',
      expiresAt: new Date(Date.now() + settings.betAcceptWindowHours * 3_600_000),
      sides: {
        create: draft.sides.map((side, position) => ({ position, label: side.label, capacity: side.capacity })),
      },
    },
    include: BET_INCLUDE,
  });

  const firstSide = bet.sides[0];
  if (!firstSide) {
    await prisma.clanBet.delete({ where: { id: bet.id } }).catch(() => undefined);
    await replyEphemeral(interaction, '❌ Impossible de préparer les camps de ce pari.');
    return;
  }

  const joined = await joinSide({ bet, side: firstSide, seat: author, season: context.season, settings });
  if (!joined.ok) {
    await prisma.clanBet.delete({ where: { id: bet.id } }).catch(() => undefined);
    await replyEphemeral(interaction, `❌ ${joined.message}`);
    return;
  }

  // Les invitations ne prélèvent rien : elles réservent une place et donnent à
  // la personne défiée l'exclusivité du bouton d'acceptation.
  for (const [index, member] of draft.invited.entries()) {
    const side = bet.sides[Math.min(index + 1, bet.sides.length - 1)];
    if (!side) continue;
    await prisma.clanBetParticipant.create({
      data: {
        betId: bet.id,
        sideId: side.id,
        userId: member.id,
        userKey: await canonicalUserId(guildId, member.id),
        status: 'INVITED',
        stake: 0,
      },
    }).catch((err: unknown) => {
      logger.warn('ClanBet', `Invitation de ${member.id} au pari ${bet.id} ignorée :`, err);
      return null;
    });
  }

  const published = await loadBet(bet.id);
  if (!published) {
    await replyEphemeral(interaction, '❌ Pari introuvable après création.');
    return;
  }

  let message: Message | null = null;
  try {
    const mentions = draft.invited.map((member) => member.toString()).join(', ');
    const content = mentions
      ? `${mentions}, ${interaction.user.toString()} vous défie !`
      : `${interaction.user.toString()} ouvre un pari : qui le rejoint ?`;

    message = await channel.send({
      content,
      embeds: [buildBetEmbed(published, await clanNamesFor(published))],
      components: buildBetComponents(published),
    });

    const thread = await message.startThread({
      name: buildBetThreadName(subject),
      autoArchiveDuration: 1440,
      reason: 'Fil de discussion du pari.',
    }).catch((err: unknown) => {
      logger.warn('ClanBet', `Fil non créé pour le pari ${bet.id} :`, err);
      return null;
    });

    await prisma.clanBet.update({
      where: { id: bet.id },
      data: { messageId: message.id, threadId: thread?.id ?? null },
    });
    notifyBetsChanged(guildId);
  } catch (err) {
    // Un pari sans annonce n'a aucun bouton pour être rejoint : il ne doit ni
    // rester en base, ni garder la mise de son auteur.
    await message?.delete().catch(() => undefined);
    await unstakeFor({
      guildId,
      clanId: author.clan.id,
      userKey: author.userKey,
      season: context.season,
      escrow: joined.participant.escrow,
      debt: joined.participant.debt,
    });
    await prisma.clanBet.delete({ where: { id: bet.id } }).catch(() => undefined);
    notifyBetsChanged(guildId);
    logger.error('ClanBet', `Publication du pari ${bet.id} impossible :`, err);
    await replyEphemeral(interaction, '❌ Impossible de publier le pari dans ce salon, ta mise t\'a été rendue.');
    return;
  }

  const creditNote = joined.participant.debt > 0
    ? ` ⚠️ ${frenchNumber(joined.participant.debt)} point(s) ont été engagés à crédit.`
    : '';
  await replyEphemeral(
    interaction,
    `✅ Pari ouvert (ID : \`${bet.id}\`). Ta mise de ${frenchNumber(joined.participant.stake)} point(s) est engagée.${creditNote}`,
  );
}

export async function handleBetCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guild = interaction.guild;
  if (!guild || !interaction.guildId) {
    await replyEphemeral(interaction, '❌ Cette commande doit être utilisée sur un serveur.');
    return;
  }
  const guildId = interaction.guildId;

  if (await isStaffServerGuild(guildId)) {
    await replyEphemeral(interaction, '❌ Les paris ne sont pas disponibles sur un serveur staff.');
    return;
  }

  const settings = await getClanBetSettings(guildId);
  if (!(await isBettingOpen(guildId, settings))) {
    await replyEphemeral(interaction, '❌ Les paris sont désactivés sur ce serveur.');
    return;
  }

  const sub = interaction.options.getSubcommand(false) ?? 'duel';
  const shape: BetShape = sub === 'pool' ? 'POOL' : sub === 'equipes' ? 'TEAMS' : 'DUEL';

  if (shape === 'POOL' && !settings.betAllowPool) {
    await replyEphemeral(interaction, '❌ Les paris en pool ne sont pas activés sur ce serveur.');
    return;
  }
  if (shape === 'TEAMS' && !settings.betAllowTeams) {
    await replyEphemeral(interaction, '❌ Les paris en équipes ne sont pas activés sur ce serveur.');
    return;
  }

  const subject = normalizeBetSubject(interaction.options.getString('sujet', true));
  const stakeCheck = checkStake(interaction.options.getInteger('mise', true), settings);

  if (!stakeCheck.ok) {
    await replyEphemeral(interaction, `❌ ${describeStakeRejection(stakeCheck)}`);
    return;
  }
  if (!subject) {
    await replyEphemeral(interaction, '❌ Le sujet du pari ne peut pas être vide.');
    return;
  }
  if (subject.length > BET_SUBJECT_MAX_LENGTH) {
    await replyEphemeral(interaction, `❌ Le sujet ne peut pas dépasser ${BET_SUBJECT_MAX_LENGTH} caractères.`);
    return;
  }

  // Sans salon réglé, la commande passe partout et le pari paraît là où il a
  // été lancé. Un réglage vide veut dire « pas de contrainte » : c'est le seul
  // sens qui ne demande rien à un serveur qui n'a jamais ouvert cet onglet.
  const betChannel = await resolveBetChannel(guild, settings);
  if (betChannel && betChannel.id !== interaction.channelId) {
    await replyEphemeral(interaction, `❌ Les paris se lancent dans ${betChannel.toString()}.`);
    return;
  }
  const targetChannel = betChannel ?? asBetChannel(interaction.channel);
  if (!targetChannel) {
    await replyEphemeral(interaction, '❌ Aucun salon utilisable pour publier le pari.');
    return;
  }

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  const context = await loadBetContext(guildId);
  if (!context) {
    await replyEphemeral(interaction, "❌ Aucun clan n'est configuré sur ce serveur.");
    return;
  }

  const authorMember = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!authorMember) {
    await replyEphemeral(interaction, '❌ Tu dois être membre du serveur pour parier.');
    return;
  }
  const authorSeat = await resolveSeat(guildId, context, authorMember);
  if (!authorSeat.ok) {
    await replyEphemeral(interaction, `❌ ${authorSeat.message}`);
    return;
  }

  // Le quota vaut pour la personne, pas pour le compte : sans les comptes liés,
  // il suffit de basculer sur son double pour le doubler.
  const authorKeys = await linkedUserIds(guildId, interaction.user.id);
  if (await openBetCount(guildId, authorKeys) >= settings.betMaxOpenPerMember) {
    await replyEphemeral(
      interaction,
      `❌ Tu as déjà ${settings.betMaxOpenPerMember} pari(s) en cours : termine-les avant d'en lancer un autre.`,
    );
    return;
  }

  const draft = await buildDraft({ interaction, guild, settings, context, shape, author: authorSeat.seat });
  if (!draft.ok) {
    await replyEphemeral(interaction, `❌ ${draft.message}`);
    return;
  }

  await createBet({
    interaction,
    settings,
    context,
    channel: targetChannel,
    subject,
    stake: stakeCheck.stake,
    draft: draft.draft,
    author: authorSeat.seat,
  });
}

/** Traduit les options de la commande en camps et en invitations. */
async function buildDraft(params: {
  interaction: ChatInputCommandInteraction;
  guild: DiscordGuild;
  settings: ClanBetSettings;
  context: BetContext;
  shape: BetShape;
  author: Seat;
}): Promise<{ ok: true; draft: BetDraft } | { ok: false; message: string }> {
  const { interaction, guild, settings, shape, author } = params;

  if (shape === 'DUEL') {
    const opponentUser = interaction.options.getUser('adversaire');
    if (!opponentUser) {
      if (!settings.betAllowOpen) {
        return { ok: false, message: 'Indique un adversaire : les défis ouverts à tous ne sont pas activés ici.' };
      }
      return {
        ok: true,
        draft: {
          shape,
          access: 'OPEN',
          sides: [
            { label: author.member.displayName.slice(0, BET_SIDE_LABEL_MAX_LENGTH), capacity: 1 },
            { label: 'Challenger', capacity: 1 },
          ],
          invited: [],
        },
      };
    }

    if (opponentUser.bot) return { ok: false, message: 'Impossible de parier contre un bot.' };
    if (opponentUser.id === interaction.user.id) return { ok: false, message: 'Impossible de parier contre soi-même.' };

    const opponentMember = await guild.members.fetch(opponentUser.id).catch(() => null);
    if (!opponentMember) return { ok: false, message: 'Les deux parieurs doivent être membres du serveur.' };

    const opponentSeat = await resolveSeat(guild.id, params.context, opponentMember);
    if (!opponentSeat.ok) return { ok: false, message: opponentSeat.message };

    // Deux comptes liés partagent une seule ligne de contribution : les deux
    // mises sortiraient de la même poche et le gain y retournerait. Économiquement
    // neutre, mais ça fabrique des victoires, des défaites et des séries dans le
    // palmarès public, et ça pollue le flux des derniers scores.
    if (opponentSeat.seat.userKey === author.userKey) {
      return { ok: false, message: 'Impossible de parier contre un de tes comptes liés.' };
    }

    return {
      ok: true,
      draft: {
        shape,
        access: 'TARGETED',
        sides: [
          { label: author.member.displayName.slice(0, BET_SIDE_LABEL_MAX_LENGTH), capacity: 1 },
          { label: opponentMember.displayName.slice(0, BET_SIDE_LABEL_MAX_LENGTH), capacity: 1 },
        ],
        invited: [opponentMember],
      },
    };
  }

  if (shape === 'POOL') {
    const seats = interaction.options.getInteger('places', true);
    if (seats < BET_PARTICIPANTS_MIN || seats > settings.betMaxParticipants) {
      return {
        ok: false,
        message: `Un pool compte entre ${BET_PARTICIPANTS_MIN} et ${settings.betMaxParticipants} places sur ce serveur.`,
      };
    }
    // Un camp d'une place par participant : le pool est le cas où chacun est son
    // propre camp, ce qui laisse le moteur de résolution inchangé.
    //
    // Toujours ouvert : rien n'invite personne à un pool, donc un accès sur
    // invitation le rendrait injoignable par construction. C'est l'interrupteur
    // du serveur qui décide si la forme existe, pas celui des paris ouverts.
    return {
      ok: true,
      draft: {
        shape,
        access: 'OPEN',
        sides: Array.from({ length: seats }, (_, index) => ({ label: `Place ${index + 1}`, capacity: 1 })),
        invited: [],
      },
    };
  }

  const rawSides = interaction.options.getString('camps', true);
  const parsed = parseBetSides(rawSides, {
    maxSides: settings.betMaxSides,
    maxParticipants: settings.betMaxParticipants,
    stakeMode: settings.betStakeMode,
  });
  if (!parsed.ok) return { ok: false, message: describeSideParseFailure(parsed.reason, settings) };

  // Ouvert pour la même raison que le pool : aucun mécanisme n'invite à un camp,
  // le fermer reviendrait à publier un pari que personne ne peut rejoindre.
  return { ok: true, draft: { shape, access: 'OPEN', sides: parsed.sides, invited: [] } };
}

// ─── Boutons ─────────────────────────────────────────────────────────────────

/**
 * Prend un pari dans un état donné pour le passer en `LOCKED`.
 *
 * L'écriture conditionnelle est le verrou : deux clics simultanés entrent tous
 * les deux dans le handler, mais un seul voit `count === 1` et va toucher aux
 * points. C'est aussi ce qui empêche deux personnes de prendre le dernier siège
 * d'un camp.
 */
async function claimBet(betId: string, from: BetStatus): Promise<FullBet | null> {
  const claimed = await prisma.clanBet.updateMany({
    where: { id: betId, status: from },
    data: { status: 'LOCKED' },
  });
  if (claimed.count === 0) return null;
  return loadBet(betId);
}

/**
 * Au-delà, un pari resté en `LOCKED` n'est plus un traitement en cours mais un
 * verrou orphelin : une exception entre la prise du verrou et sa libération
 * (base indisponible, coupure) laisse le pari bloqué, ses mises prélevées et le
 * quota de ses parieurs occupé. Rien ne le ramasserait sans ce délai, puisque
 * les balayages ne regardent que `PENDING` et `ACTIVE`.
 */
const LOCKED_GRACE_MS = 5 * 60_000;

async function releaseBet(betId: string, status: BetStatus): Promise<FullBet | null> {
  const released = await prisma.clanBet
    .update({ where: { id: betId }, data: { status }, include: BET_INCLUDE })
    .catch(() => null);

  if (released) notifyBetsChanged(released.guildId);
  return released;
}

export async function handleBetButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, betId, extra] = interaction.customId.split(':');
  if (!action || !betId || !interaction.guildId) return;

  const settings = await getClanBetSettings(interaction.guildId);
  if (!(await isBettingOpen(interaction.guildId, settings))) {
    await replyEphemeral(interaction, '❌ Les paris sont désactivés sur ce serveur.');
    return;
  }

  const bet = await loadBet(betId);
  if (!bet || bet.guildId !== interaction.guildId) {
    await replyEphemeral(interaction, '❌ Pari introuvable.');
    return;
  }

  switch (action) {
    case 'join':
      await handleJoin(interaction, bet, settings, extra ?? '*');
      return;
    case 'accept':
      await handleJoin(interaction, bet, settings, 'invited');
      return;
    case 'decline':
      await declineBet(interaction, bet);
      return;
    case 'leave':
      await leaveBet(interaction, bet);
      return;
    case 'cancel':
      await cancelBet(interaction, bet);
      return;
    case 'start':
      await startBetManually(interaction, bet);
      return;
    case 'resolve':
      await promptBetResolution(interaction, bet, settings);
      return;
    case 'void':
      await promptBetVoid(interaction, bet, settings);
      return;
    case 'voidok':
      await confirmBetVoid(interaction, bet, settings);
      return;
    default:
      await replyEphemeral(interaction, '❌ Action de pari inconnue.');
  }
}

/**
 * Choisit le camp visé par un clic.
 *
 * `invited` suit la place réservée à la personne, `*` prend le premier siège
 * libre - c'est le cas du pool, où tous les camps sont équivalents et n'ont donc
 * qu'un bouton pour tous.
 */
function pickSide(bet: FullBet, selector: string, userKeys: string[]): SideWithParticipants | null {
  if (selector === 'invited') {
    return bet.sides.find((side) =>
      side.participants.some((entry) => userKeys.includes(entry.userKey) && entry.status === 'INVITED'),
    ) ?? null;
  }
  if (selector === '*') return bet.sides.find(sideHasRoom) ?? null;

  const position = Number(selector);
  if (!Number.isInteger(position)) return null;
  return bet.sides.find((side) => side.position === position) ?? null;
}

async function handleJoin(
  interaction: ButtonInteraction,
  bet: FullBet,
  settings: ClanBetSettings,
  selector: string,
): Promise<void> {
  if (bet.status !== 'PENDING') {
    await replyEphemeral(interaction, "❌ Ce pari n'accepte plus d'inscription.");
    return;
  }
  if (bet.expiresAt.getTime() <= Date.now()) {
    await replyEphemeral(interaction, '❌ Les inscriptions de ce pari sont closes.');
    return;
  }

  const guild = interaction.guild;
  if (!guild) return;

  await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

  const userKeys = await linkedUserIds(bet.guildId, interaction.user.id);
  const existing = findParticipant(bet, userKeys);
  if (existing && existing.status === 'JOINED') {
    await replyEphemeral(interaction, '❌ Tu participes déjà à ce pari.');
    return;
  }

  // Un pari sur invitation n'est ouvert qu'à ceux qui y ont une place réservée.
  if (bet.access === 'TARGETED' && !existing) {
    await replyEphemeral(interaction, "❌ Ce pari est réservé aux personnes invitées.");
    return;
  }
  if (selector === 'invited' && (!existing || existing.status !== 'INVITED')) {
    await replyEphemeral(interaction, '❌ Ce défi ne t\'est pas adressé.');
    return;
  }

  const claimed = await claimBet(bet.id, 'PENDING');
  if (!claimed) {
    await replyEphemeral(interaction, "❌ Ce pari vient d'être traité, réessaie.");
    return;
  }

  const failed = async (message: string): Promise<void> => {
    await releaseBet(bet.id, 'PENDING');
    await replyEphemeral(interaction, `❌ ${message}`);
  };

  const context = await loadBetContext(bet.guildId);
  if (!context) {
    await failed('Les clans ne sont plus disponibles sur ce serveur.');
    return;
  }

  // La saison a pu tourner depuis l'ouverture du pari : les mises déjà prélevées
  // appartiennent à un classement en train de se clore, rien ne doit s'y ajouter.
  //
  // Le pari est soldé sur place plutôt que remis en attente. La clôture de
  // saison est censée l'avoir fait, mais si on arrive ici c'est qu'elle l'a
  // manqué : le laisser ouvert immobiliserait des mises sur un classement que
  // plus personne ne regarde.
  if (context.season !== claimed.season) {
    const closed = await refundBet(claimed, null, 'REFUNDED');
    await refreshBetMessage(interaction.client, closed);
    await closeBetThread(interaction.client, closed, '🕓 Changement de saison : le pari est clos et les mises ont été rendues.');
    await replyEphemeral(interaction, '❌ La saison a changé depuis l\'ouverture de ce pari : il vient d\'être clos et remboursé.');
    return;
  }

  const side = pickSide(claimed, selector, userKeys);
  if (!side) {
    await failed('Ce camp n\'existe plus.');
    return;
  }
  if (!sideHasRoom(side) && !(existing && existing.status === 'INVITED')) {
    await failed('Ce camp est complet.');
    return;
  }

  const member = await guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member) {
    await failed('Tu dois être membre du serveur pour parier.');
    return;
  }

  const seat = await resolveSeat(bet.guildId, context, member);
  if (!seat.ok) {
    await failed(seat.message);
    return;
  }

  if (await openBetCount(bet.guildId, userKeys, bet.id) >= settings.betMaxOpenPerMember) {
    await failed(`Tu as déjà ${settings.betMaxOpenPerMember} pari(s) en cours.`);
    return;
  }

  const joined = await joinSide({ bet: claimed, side, seat: seat.seat, season: context.season, settings });
  if (!joined.ok) {
    await failed(joined.message);
    return;
  }

  const refreshed = await loadBet(bet.id);
  if (!refreshed) {
    await failed('Pari introuvable.');
    return;
  }

  // Tous les camps pleins : plus personne n'est attendu, le pari démarre sans
  // faire patienter les inscrits jusqu'à l'échéance.
  const started = isReadyToStart(refreshed);
  const settled = await releaseBet(bet.id, started ? 'ACTIVE' : 'PENDING');
  if (settled) await refreshBetMessage(interaction.client, settled);

  const creditNote = joined.participant.debt > 0
    ? ` ⚠️ ${frenchNumber(joined.participant.debt)} point(s) engagés à crédit : ils seront prélevés sur tes prochains gains.`
    : '';
  await replyEphemeral(
    interaction,
    `✅ Tu rejoins **${side.label}** avec ${frenchNumber(joined.participant.stake)} point(s).${creditNote}`
    + (started ? '\n🔥 Tous les camps sont complets : le pari démarre.' : ''),
  );
}

async function declineBet(interaction: ButtonInteraction, bet: FullBet): Promise<void> {
  const userKeys = await linkedUserIds(bet.guildId, interaction.user.id);
  const invitation = findParticipant(bet, userKeys);
  if (!invitation || invitation.status !== 'INVITED') {
    await replyEphemeral(interaction, "❌ Ce défi ne t'est pas adressé.");
    return;
  }

  const claimed = await claimBet(bet.id, 'PENDING');
  if (!claimed) {
    await replyEphemeral(interaction, "❌ Ce pari n'attend plus de réponse.");
    return;
  }

  await prisma.clanBetParticipant.update({ where: { id: invitation.id }, data: { status: 'DECLINED' } });

  // Un refus qui laisse le pari sans opposant possible le clôt : l'auteur a déjà
  // payé, ses points doivent lui revenir plutôt que d'attendre l'échéance.
  const after = await loadBet(bet.id);
  const settled = after && !canStillFill(after)
    ? await refundBet(after, null, 'DECLINED')
    : await releaseBet(bet.id, 'PENDING');

  if (settled) await refreshBetMessage(interaction.client, settled);
  await replyEphemeral(interaction, '❌ Défi refusé.');
}

/**
 * Retrait d'un participant qui n'est pas l'auteur.
 *
 * Sans cette porte de sortie, quiconque rejoint un pari libre qui ne se remplit
 * jamais voit ses points immobilisés jusqu'à l'échéance. Réservé aux
 * inscriptions : une fois le pari lancé, partir reviendrait à annuler un pari
 * qu'on est en train de perdre.
 */
async function leaveBet(interaction: ButtonInteraction, bet: FullBet): Promise<void> {
  if (bet.status !== 'PENDING') {
    await replyEphemeral(interaction, '❌ Ce pari est lancé : il est trop tard pour le quitter.');
    return;
  }
  if (interaction.user.id === bet.authorId) {
    await replyEphemeral(interaction, "❌ En tant qu'auteur, utilise « Retirer » pour clore le pari.");
    return;
  }

  const userKeys = await linkedUserIds(bet.guildId, interaction.user.id);
  const participant = findParticipant(bet, userKeys);
  if (!participant || participant.status !== 'JOINED') {
    await replyEphemeral(interaction, '❌ Tu ne participes pas à ce pari.');
    return;
  }

  const claimed = await claimBet(bet.id, 'PENDING');
  if (!claimed) {
    await replyEphemeral(interaction, "❌ Ce pari vient d'être traité.");
    return;
  }

  await unstakeFor({
    guildId: bet.guildId,
    clanId: participant.clanId,
    userKey: participant.userKey,
    season: bet.season,
    escrow: participant.escrow,
    debt: participant.debt,
  });
  await prisma.clanBetParticipant.delete({ where: { id: participant.id } }).catch(() => undefined);

  const released = await releaseBet(bet.id, 'PENDING');
  if (released) await refreshBetMessage(interaction.client, released);
  await replyEphemeral(interaction, `🚪 Tu quittes le pari, tes ${frenchNumber(engagedAmount(participant))} point(s) t'ont été rendus.`);
}

async function cancelBet(interaction: ButtonInteraction, bet: FullBet): Promise<void> {
  if (interaction.user.id !== bet.authorId) {
    await replyEphemeral(interaction, "❌ Seul l'auteur du pari peut le retirer.");
    return;
  }
  if (bet.status !== 'PENDING') {
    await replyEphemeral(interaction, '❌ Ce pari est déjà lancé ou clos.');
    return;
  }

  const claimed = await claimBet(bet.id, 'PENDING');
  if (!claimed) {
    await replyEphemeral(interaction, '❌ Ce pari vient d\'être traité.');
    return;
  }

  const cancelled = await refundBet(claimed, interaction.user.id, 'CANCELLED');
  await refreshBetMessage(interaction.client, cancelled);
  await closeBetThread(interaction.client, cancelled, '🚫 Pari retiré par son auteur : les mises ont été rendues.');
  await replyEphemeral(interaction, '🚫 Pari retiré, chaque parieur a récupéré sa mise.');
}

/**
 * Démarrage anticipé par l'auteur, quand les camps ne se rempliront pas.
 *
 * Un pari libre à effectif ouvert n'a aucun moment naturel de bascule : sans ce
 * bouton, il faudrait attendre l'échéance même une fois tout le monde présent.
 */
async function startBetManually(interaction: ButtonInteraction, bet: FullBet): Promise<void> {
  if (interaction.user.id !== bet.authorId) {
    await replyEphemeral(interaction, "❌ Seul l'auteur du pari peut le lancer.");
    return;
  }
  if (bet.status !== 'PENDING') {
    await replyEphemeral(interaction, '❌ Ce pari est déjà lancé ou clos.');
    return;
  }
  if (!hasOpposition(bet)) {
    await replyEphemeral(interaction, '❌ Il faut au moins deux camps occupés pour lancer le pari.');
    return;
  }

  const claimed = await claimBet(bet.id, 'PENDING');
  if (!claimed) {
    await replyEphemeral(interaction, "❌ Ce pari vient d'être traité.");
    return;
  }

  // Les places restées vides ne sont plus attendues : sans ce nettoyage, une
  // invitation non honorée continuerait de s'afficher comme en attente sur un
  // pari déjà lancé.
  await prisma.clanBetParticipant.updateMany({
    where: { betId: bet.id, status: 'INVITED' },
    data: { status: 'DECLINED' },
  });

  const active = await releaseBet(bet.id, 'ACTIVE');
  if (active) await refreshBetMessage(interaction.client, active);
  await replyEphemeral(interaction, '▶️ Pari lancé : les inscriptions sont closes.');
}

// ─── Arbitrage ───────────────────────────────────────────────────────────────

/**
 * Droit de trancher : administrateurs, plus les rôles désignés dans l'onglet
 * Paris. Sans cette liste, confier l'arbitrage à une équipe animation obligerait
 * à lui donner les pleins pouvoirs sur le serveur.
 */
function describeResolverRight(settings: ClanBetSettings, action: string): string {
  // Annoncer « seul un administrateur » alors que des rôles arbitres existent
  // enverrait la personne réclamer un droit qu'elle a peut-être déjà ailleurs.
  const roles = settings.betResolverRoleIds.length > 0
    ? ` ou un des rôles arbitres (${settings.betResolverRoleIds.map((id) => `<@&${id}>`).join(', ')})`
    : '';
  return `❌ Seul un administrateur${roles} peut ${action}.`;
}

function canResolveBets(interaction: ButtonInteraction | StringSelectMenuInteraction, settings: ClanBetSettings): boolean {
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return true;
  if (settings.betResolverRoleIds.length === 0) return false;

  const roles = interaction.member?.roles;
  if (!roles || Array.isArray(roles)) {
    return Array.isArray(roles) ? roles.some((id) => settings.betResolverRoleIds.includes(id)) : false;
  }
  return settings.betResolverRoleIds.some((id) => roles.cache.has(id));
}

async function promptBetResolution(interaction: ButtonInteraction, bet: FullBet, settings: ClanBetSettings): Promise<void> {
  if (!canResolveBets(interaction, settings)) {
    await replyEphemeral(interaction, describeResolverRight(settings, 'clore un pari'));
    return;
  }
  if (bet.status !== 'ACTIVE') {
    await replyEphemeral(interaction, "❌ Ce pari n'est pas en cours.");
    return;
  }

  const pot = betPot(bet);
  const occupied = bet.sides.filter((side) => joinedOf(side).length > 0);

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`bet:winner:${bet.id}`)
    .setPlaceholder('Quel camp a gagné ?')
    .addOptions(
      occupied.map((side) => {
        const members = joinedOf(side);
        const engaged = sideEngaged(side);
        const perHead = members.length > 0 ? Math.floor(pot / members.length) : 0;
        return {
          label: side.label.slice(0, 100),
          description: `${members.length} parieur(s) · ~${frenchNumber(perHead)} pts chacun`.slice(0, 100),
          value: side.position.toString(),
          emoji: '🏆',
        };
      }),
    );

  await interaction.reply({
    content: `**${bet.subject}**\nQuel camp remporte ce pari (${frenchNumber(pot)} points dans le pot) ?`
      + '\nPour l\'annuler sans gagnant, utilise « Annuler (admin) ».',
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu)],
    flags: [MessageFlags.Ephemeral],
  });
}

/**
 * Annulation par un arbitre, en deux temps.
 *
 * Le remboursement est irréversible et efface un pari que tous les parieurs ont
 * accepté : un clic isolé ne doit pas suffire, d'autant que le bouton est
 * affiché sous les yeux de tout le salon.
 */
async function promptBetVoid(interaction: ButtonInteraction, bet: FullBet, settings: ClanBetSettings): Promise<void> {
  if (!canResolveBets(interaction, settings)) {
    await replyEphemeral(interaction, describeResolverRight(settings, 'annuler un pari'));
    return;
  }
  if (bet.status !== 'ACTIVE' && bet.status !== 'PENDING') {
    await replyEphemeral(interaction, '❌ Ce pari est déjà clos.');
    return;
  }

  await interaction.reply({
    content: `**${bet.subject}**\nChaque parieur récupère sa mise, part à crédit comprise `
      + `(${frenchNumber(betPot(bet))} points au total).\nConfirmer l'annulation ?`,
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`bet:voidok:${bet.id}`).setLabel('Confirmer l\'annulation').setEmoji('↩️').setStyle(ButtonStyle.Danger),
      ),
    ],
    flags: [MessageFlags.Ephemeral],
  });
}

async function confirmBetVoid(interaction: ButtonInteraction, bet: FullBet, settings: ClanBetSettings): Promise<void> {
  if (!canResolveBets(interaction, settings)) {
    await replyEphemeral(interaction, describeResolverRight(settings, 'annuler un pari'));
    return;
  }

  // L'état a pu changer entre l'affichage de la confirmation et le clic. `LOCKED`
  // est exclu explicitement : un pari en cours de traitement ne doit pas être
  // repris ici, sinon deux règlements se marcheraient dessus.
  if (bet.status !== 'ACTIVE' && bet.status !== 'PENDING') {
    await replyEphemeral(interaction, '❌ Ce pari est déjà clos ou en cours de traitement.');
    return;
  }

  await interaction.deferUpdate();

  const claimed = await claimBet(bet.id, bet.status as BetStatus);
  if (!claimed) {
    await interaction.editReply({ content: "❌ Ce pari vient d'être traité.", components: [] });
    return;
  }

  const settled = await refundBet(claimed, interaction.user.id, 'REFUNDED');
  await refreshBetMessage(interaction.client, settled);
  await announceBetOutcome(interaction.client, settled);
  await closeBetThread(interaction.client, settled, '↩️ Pari annulé par un administrateur : les mises ont été rendues.');

  await interaction.editReply({ content: '✅ Pari annulé, chaque parieur a récupéré sa mise.', components: [] });
}

/** Camps d'un pari, tels qu'un arbitre extérieur doit les voir pour trancher. */
export function describeBetSides(bet: FullBet): Array<{
  position: number;
  label: string;
  capacity: number | null;
  engaged: number;
  members: Array<{ userId: string; engaged: number; onCredit: number }>;
}> {
  return bet.sides.map((side) => ({
    position: side.position,
    label: side.label,
    capacity: side.capacity,
    engaged: sideEngaged(side),
    members: joinedOf(side).map((entry) => ({
      userId: entry.userId,
      engaged: engagedAmount(entry),
      onCredit: Math.max(0, entry.debt),
    })),
  }));
}

/** Enjeu total d'un pari chargé, pour les lecteurs extérieurs au service. */
export function betPotOf(bet: FullBet): number {
  return betPot(bet);
}

export async function loadFullBet(betId: string): Promise<FullBet | null> {
  return loadBet(betId);
}

export async function handleBetWinnerSelect(interaction: StringSelectMenuInteraction): Promise<void> {
  const betId = interaction.customId.split(':')[2];
  const choice = interaction.values[0];
  if (!betId || choice === undefined || !interaction.guildId) return;

  const settings = await getClanBetSettings(interaction.guildId);
  if (!canResolveBets(interaction, settings)) {
    await replyEphemeral(interaction, describeResolverRight(settings, 'clore un pari'));
    return;
  }

  await interaction.deferUpdate();

  // Le menu et les outils MCP passent par la même fonction : un second chemin
  // de règlement finirait par diverger sur le verrou ou sur les annonces.
  const settled = await settleBetBySide({
    client: interaction.client,
    guildId: interaction.guildId,
    betId,
    side: Number(choice),
    resolvedById: interaction.user.id,
  });

  if (!settled.ok) {
    await interaction.editReply({ content: `❌ ${settled.message}`, components: [] });
    return;
  }

  const label = sideById(settled.bet, settled.bet.winningSideId)?.label ?? 'Le camp désigné';
  await interaction.editReply({ content: `✅ Verdict enregistré : **${label}** l'emporte.`, components: [] });
}

export type BetSettlement =
  | { ok: true; bet: FullBet }
  | { ok: false; reason: 'not-found' | 'not-active' | 'unknown-side' | 'empty-side' | 'busy'; message: string };

/**
 * Tranche un pari en désignant son camp gagnant, verrou et annonces compris.
 *
 * Exporté pour que le menu d'arbitrage et les outils MCP empruntent le même
 * chemin : un second chemin de règlement finirait par oublier le verrou, le
 * rafraîchissement de l'annonce ou la publication sur le bus.
 */
export async function settleBetBySide(params: {
  client: Client;
  guildId: string;
  betId: string;
  /** Position du camp dans l'annonce, ou son libellé exact. */
  side: number | string;
  /** `null` quand le verdict ne vient de personne : arbitrage automatisé, MCP. */
  resolvedById: string | null;
}): Promise<BetSettlement> {
  const bet = await loadBet(params.betId);
  if (!bet || bet.guildId !== params.guildId) {
    return { ok: false, reason: 'not-found', message: 'Pari introuvable sur ce serveur.' };
  }
  if (bet.status !== 'ACTIVE') {
    return { ok: false, reason: 'not-active', message: `Ce pari n'est pas en cours (statut ${bet.status}).` };
  }

  const winningSide = typeof params.side === 'number'
    ? bet.sides.find((entry) => entry.position === params.side)
    : bet.sides.find((entry) => entry.label.toLowerCase() === params.side.toString().trim().toLowerCase());

  if (!winningSide) {
    const known = bet.sides.map((entry) => `${entry.position}: ${entry.label}`).join(', ');
    return { ok: false, reason: 'unknown-side', message: `Camp inconnu. Camps de ce pari : ${known}.` };
  }
  if (joinedOf(winningSide).length === 0) {
    return {
      ok: false,
      reason: 'empty-side',
      message: `Personne ne parie sur « ${winningSide.label} » : ce camp ne peut pas l'emporter.`,
    };
  }

  const claimed = await claimBet(bet.id, 'ACTIVE');
  if (!claimed) {
    return { ok: false, reason: 'busy', message: "Ce pari vient d'être traité." };
  }

  const settled = await payoutBet(claimed, winningSide.id, params.resolvedById);
  await refreshBetMessage(params.client, settled);
  await announceBetOutcome(params.client, settled);
  await closeBetThread(
    params.client,
    settled,
    `🏆 Verdict : **${winningSide.label}** l'emporte.\n`
    + joinedOf(sideById(settled, settled.winningSideId) ?? winningSide)
      .map((entry) => `${userMention(entry.userId)} · +${frenchNumber(entry.payout - engagedAmount(entry))} points de clan`)
      .join('\n'),
  );

  return { ok: true, bet: settled };
}

/** Annule un pari et rend les mises, quel que soit son avancement. */
export async function voidBetById(params: {
  client: Client;
  guildId: string;
  betId: string;
  resolvedById: string | null;
}): Promise<BetSettlement> {
  const bet = await loadBet(params.betId);
  if (!bet || bet.guildId !== params.guildId) {
    return { ok: false, reason: 'not-found', message: 'Pari introuvable sur ce serveur.' };
  }
  if (bet.status !== 'ACTIVE' && bet.status !== 'PENDING') {
    return { ok: false, reason: 'not-active', message: `Ce pari est déjà clos (statut ${bet.status}).` };
  }

  const claimed = await claimBet(bet.id, bet.status as BetStatus);
  if (!claimed) {
    return { ok: false, reason: 'busy', message: "Ce pari vient d'être traité." };
  }

  const settled = await refundBet(claimed, params.resolvedById, 'REFUNDED');
  await refreshBetMessage(params.client, settled);
  await announceBetOutcome(params.client, settled);
  await closeBetThread(params.client, settled, '↩️ Pari annulé : les mises ont été rendues.');

  return { ok: true, bet: settled };
}

/**
 * Verse le pot aux membres du camp gagnant, sur la ligne du clan qu'ils avaient
 * en entrant. Les perdants gardent leur part à crédit : c'est précisément ce
 * qu'ils doivent.
 */
async function payoutBet(bet: FullBet, winningSideId: string, resolvedById: string | null): Promise<FullBet> {
  const winningSide = sideById(bet, winningSideId);
  const winners = winningSide ? joinedOf(winningSide) : [];
  const pot = betPot(bet);

  const shares = new Map(splitPot(pot, winners).map((share) => [share.userKey, share.payout]));

  for (const winner of winners) {
    const due = shares.get(winner.userKey) ?? 0;
    let credited = 0;
    let debtRepaid = 0;

    if (winner.clanId && due > 0) {
      // Pas de `skipDebt` : un gagnant endetté rembourse d'abord, c'est un gain.
      const moved = await moveClanPoints({
        guildId: bet.guildId,
        clanId: winner.clanId,
        userId: winner.userKey,
        season: bet.season,
        amount: due,
      }).catch((err: unknown) => {
        logger.error('ClanBet', `Versement du gain de ${winner.userKey} sur le pari ${bet.id} impossible :`, err);
        return { granted: 0, debtRepaid: 0 };
      });
      credited = moved.granted;
      debtRepaid = moved.debtRepaid;
    }

    // Ce qui est inscrit est ce qui est **arrivé**, pas ce qui était dû : le
    // plafond de saison peut avoir rogné le versement, et un échec de crédit le
    // ramène à zéro. Conserver le montant théorique afficherait un gain que
    // personne n'a touché, et le palmarès - qui lit `payout - engagé` - le
    // porterait au classement pour toute la saison.
    const received = credited + debtRepaid;
    if (received < due) {
      logger.warn(
        'ClanBet',
        `Gain de ${winner.userKey} sur le pari ${bet.id} rogné : ${received} inscrit(s) sur ${due} dû(s).`,
      );
    }

    await prisma.clanBetParticipant.update({
      where: { id: winner.id },
      data: { payout: received, debtRepaid },
    }).catch(() => undefined);
  }

  await prisma.clanBet.update({
    where: { id: bet.id },
    data: { status: 'RESOLVED', winningSideId, resolvedById, resolvedAt: new Date() },
  });
  notifyBetsChanged(bet.guildId);

  const settled = (await loadBet(bet.id)) ?? bet;

  // Publié après relecture, pour que les montants annoncés soient ceux qui ont
  // été inscrits et non ceux qui étaient dus.
  const settledWinners = winningSide ? joinedOf(sideById(settled, winningSideId) ?? winningSide) : [];
  kotboEventBus.publish('bet:resolved', {
    guildId: bet.guildId,
    betId: bet.id,
    subject: bet.subject,
    season: bet.season,
    shape: bet.shape,
    pot,
    winningSideLabel: winningSide?.label ?? '',
    winners: settledWinners.map((entry) => ({
      userId: entry.userId,
      netGain: entry.payout - engagedAmount(entry),
    })),
    losers: settled.sides
      .filter((side) => side.id !== winningSideId)
      .flatMap(joinedOf)
      .map((entry) => ({ userId: entry.userId, lost: engagedAmount(entry) })),
    resolvedById,
    timestamp: Date.now(),
  });

  return settled;
}

/** Rend à chacun ce qui lui a été pris, ni plus ni moins, crédit compris. */
async function refundBet(bet: FullBet, resolvedById: string | null, status: BetStatus): Promise<FullBet> {
  const refunded = allJoined(bet).map((entry) => ({ userId: entry.userId, amount: engagedAmount(entry) }));

  for (const participant of allJoined(bet)) {
    await unstakeFor({
      guildId: bet.guildId,
      clanId: participant.clanId,
      userKey: participant.userKey,
      season: bet.season,
      escrow: participant.escrow,
      debt: participant.debt,
    });
  }

  await prisma.clanBet.update({
    where: { id: bet.id },
    data: { status, winningSideId: null, resolvedById, resolvedAt: new Date() },
  });
  notifyBetsChanged(bet.guildId);

  // Les montants sont ceux relevés **avant** remboursement : après, les lignes
  // portent encore l'escrow mais les points sont déjà repartis, et un abonné
  // qui relirait la base ne saurait pas distinguer les deux.
  if (refunded.length > 0) {
    kotboEventBus.publish('bet:refunded', {
      guildId: bet.guildId,
      betId: bet.id,
      subject: bet.subject,
      season: bet.season,
      reason: status,
      refunded,
      timestamp: Date.now(),
    });
  }

  return (await loadBet(bet.id)) ?? bet;
}

/**
 * Crédit encore engagé dans des paris non tranchés, par membre.
 *
 * Cette part de la dette n'est pas perdue : elle s'efface si le pari est
 * annulé, expire, ou tombe à la clôture d'une saison. La séparer du reste
 * évite de lire comme une somme due un total qui va fondre de lui-même.
 *
 * La clé est `userKey`, comme la dette elle-même : un membre à comptes liés
 * n'en a qu'une.
 */
export async function getEngagedBetCredit(guildId: string, userKeys?: string[]): Promise<Map<string, number>> {
  if (userKeys && userKeys.length === 0) return new Map();

  const rows = await prisma.clanBetParticipant.groupBy({
    by: ['userKey'],
    where: {
      status: 'JOINED',
      debt: { gt: 0 },
      ...(userKeys ? { userKey: { in: userKeys } } : {}),
      bet: { guildId, status: { in: OPEN_STATUSES } },
    },
    _sum: { debt: true },
  });

  return new Map(rows.map((row) => [row.userKey, row._sum.debt ?? 0]));
}

/** Total du crédit engagé sur un serveur, sans passer par la liste des membres. */
export async function getEngagedBetCreditTotal(guildId: string): Promise<number> {
  const aggregate = await prisma.clanBetParticipant.aggregate({
    where: {
      status: 'JOINED',
      debt: { gt: 0 },
      bet: { guildId, status: { in: OPEN_STATUSES } },
    },
    _sum: { debt: true },
  });
  return aggregate._sum.debt ?? 0;
}

// ─── Balayage ────────────────────────────────────────────────────────────────

/**
 * Solde tous les paris ouverts avant la clôture d'une saison.
 *
 * Un pari ne doit jamais enjamber une fin de saison. Les mises sont prélevées
 * sur la ligne de contribution d'une saison donnée ; tranché après la bascule,
 * le pari verserait le gain sur un classement déjà clos, invisible pour tout le
 * monde. Tout est donc remboursé - à appeler **avant** le calcul des totaux,
 * pour que la saison se ferme avec les points rendus à leurs propriétaires.
 */
export async function settleOpenBetsForSeason(client: Client, guildId: string, season: number): Promise<number> {
  // Volontairement sans filtre de saison : un pari resté ouvert dont la saison
  // ne correspond plus survivrait à toutes les clôtures suivantes.
  const open = await prisma.clanBet.findMany({
    where: {
      guildId,
      OR: [
        { status: { in: ['PENDING', 'ACTIVE'] } },
        // Les verrous orphelins sont soldés ici aussi : les laisser passer la
        // clôture reviendrait à perdre définitivement les points qu'ils tiennent.
        { status: 'LOCKED', updatedAt: { lt: new Date(Date.now() - LOCKED_GRACE_MS) } },
      ],
    },
    select: { id: true, status: true },
  });

  let settled = 0;
  for (const row of open) {
    const claimed = await claimBet(row.id, row.status as BetStatus);
    if (!claimed) continue;

    const closed = await refundBet(claimed, null, 'REFUNDED');
    settled += 1;
    await refreshBetMessage(client, closed);
    await closeBetThread(client, closed, '🕓 Fin de saison : le pari est clos et les mises ont été rendues.');
  }

  if (settled > 0) {
    logger.info('ClanBet', `${settled} pari(s) soldé(s) à la clôture de la saison ${season} sur ${guildId}.`);
  }
  return settled;
}

/**
 * Clôt les inscriptions échues.
 *
 * Contrairement à l'ancien fonctionnement, une échéance ne se contente plus de
 * retirer des boutons : les mises ont été prélevées à l'entrée, donc un pari qui
 * a trouvé son opposition démarre, et un pari resté seul rembourse.
 */
export async function expireStaleBets(client: Client): Promise<void> {
  const now = new Date();
  const stale = await prisma.clanBet.findMany({
    where: {
      OR: [
        { status: 'PENDING', expiresAt: { lt: now } },
        // Un verrou qu'aucune libération n'est venue lever : le traitement qui
        // l'a posé a échoué en cours de route, le pari doit repartir.
        { status: 'LOCKED', updatedAt: { lt: new Date(now.getTime() - LOCKED_GRACE_MS) } },
      ],
    },
    select: { id: true, status: true },
    take: 100,
  });

  // Saison en cours de chaque serveur, lue une fois : le balayage est
  // multi-serveurs et interroger la base à chaque pari multiplierait les
  // allers-retours pour une valeur qui ne bouge pas pendant le passage.
  const seasonOf = new Map<string, number>();

  for (const row of stale) {
    const claimed = await claimBet(row.id, row.status as BetStatus);
    if (!claimed) continue;

    // Un pari ne doit jamais enjamber une fin de saison : ses mises viennent
    // d'un classement clos, et son verdict verserait le pot sur une saison que
    // plus personne ne consulte. La clôture est censée les avoir tous soldés,
    // mais elle peut avoir échoué - c'est le seul filet qui reste.
    if (!seasonOf.has(claimed.guildId)) {
      const guildRow = await prisma.guild.findUnique({
        where: { id: claimed.guildId },
        select: { currentClanSeason: true },
      });
      seasonOf.set(claimed.guildId, guildRow?.currentClanSeason ?? claimed.season);
    }
    if (seasonOf.get(claimed.guildId) !== claimed.season) {
      const closed = await refundBet(claimed, null, 'REFUNDED');
      await refreshBetMessage(client, closed);
      await closeBetThread(client, closed, '🕓 Ce pari appartient à une saison close : les mises ont été rendues.');
      logger.warn('ClanBet', `Pari ${claimed.id} soldé hors saison (saison ${claimed.season}) sur ${claimed.guildId}.`);
      continue;
    }

    // Un verrou orphelin dont les inscriptions courent encore reprend là où il
    // s'était arrêté : le forcer à démarrer clorait des inscriptions que
    // personne n'a demandé de clore.
    if (row.status === 'LOCKED' && claimed.expiresAt.getTime() > now.getTime()) {
      const released = await releaseBet(claimed.id, 'PENDING');
      if (released) await refreshBetMessage(client, released);
      logger.warn('ClanBet', `Verrou orphelin levé sur le pari ${claimed.id}, inscriptions rouvertes.`);
      continue;
    }

    if (hasOpposition(claimed)) {
      await prisma.clanBetParticipant.updateMany({
        where: { betId: claimed.id, status: 'INVITED' },
        data: { status: 'DECLINED' },
      });
      const active = await releaseBet(claimed.id, 'ACTIVE');
      if (active) await refreshBetMessage(client, active);
      continue;
    }

    const expired = await refundBet(claimed, null, 'EXPIRED');
    await refreshBetMessage(client, expired);
    await closeBetThread(client, expired, '🕓 Personne n\'a rejoint ce pari : les mises ont été rendues.');
  }
}

// ─── Vue personnelle ─────────────────────────────────────────────────────────

/**
 * Vue personnelle d'un membre : sa dette, ses paris en cours et son bilan.
 *
 * Sans elle, un membre endetté voit ses gains partir en remboursement sans aucun
 * moyen de vérifier ce qu'il doit : l'information n'existait que dans l'embed du
 * pari, le dashboard administrateur et la page publique.
 */
export async function buildMemberBetOverview(guild: DiscordGuild, userId: string): Promise<EmbedBuilder | null> {
  const guildId = guild.id;
  const settings = await getClanBetSettings(guildId);
  if (!(await isBettingOpen(guildId, settings))) return null;

  const context = await loadBetContext(guildId);
  // Tout ce qui suit raisonne sur la personne, pas sur le compte : les points et
  // la dette sont déjà partagés entre comptes liés, lister les paris d'un seul
  // afficherait un solde engagé sans les paris qui l'engagent.
  const userIds = await linkedUserIds(guildId, userId);
  // La saison est lue à part : `loadBetContext` renvoie `null` tant qu'aucun clan
  // n'existe, et le bilan porterait alors sur la saison 1 au lieu de la bonne.
  const guildRow = await prisma.guild.findUnique({
    where: { id: guildId },
    select: { currentClanSeason: true },
  });
  const season = context?.season ?? guildRow?.currentClanSeason ?? 1;
  const userKey = userIds.slice().sort()[0] ?? userId;
  const debt = await getClanPointDebt(guildId, userKey);

  const [open, resolved] = await Promise.all([
    prisma.clanBet.findMany({
      where: {
        guildId,
        status: { in: ['PENDING', 'ACTIVE'] },
        participants: { some: { userKey: { in: userIds }, status: { in: ['JOINED', 'INVITED'] } } },
      },
      orderBy: { createdAt: 'asc' },
      include: BET_INCLUDE,
    }),
    prisma.clanBet.findMany({
      where: {
        guildId,
        status: 'RESOLVED',
        season,
        participants: { some: { userKey: { in: userIds } } },
      },
      include: BET_INCLUDE,
    }),
  ]);

  // Les comptes liés du membre sont repliés sur un seul identifiant avant le
  // calcul : sinon ses victoires se répartiraient sur deux lignes, et sa
  // meilleure série serait coupée en deux au moindre changement de compte.
  const fold = (id: string) => (userIds.includes(id) ? userKey : id);

  const standing = buildBettorStandings(
    // Un pari tranché a toujours son camp gagnant. Sans ce filtre, une ligne
    // corrigée à la main qui n'en aurait pas compterait une défaite pour tous
    // ses participants.
    resolved.filter((bet) => bet.winningSideId !== null).map((bet) => ({
      entries: allJoined(bet).map((entry) => ({
        userId: fold(entry.userId),
        engaged: engagedAmount(entry),
        payout: entry.payout,
        won: entry.sideId === bet.winningSideId,
      })),
      resolvedAt: bet.resolvedAt ?? bet.updatedAt,
    })),
  ).find((entry) => entry.userId === userKey);

  const embed = new EmbedBuilder()
    .setTitle('🎲 Tes paris')
    .setColor(debt > 0 ? COLORS_RAW.warning : COLORS_RAW.primary)
    .setFooter({ text: `Saison ${season}` })
    .setTimestamp();

  // Solde : ce qui reste réellement misable. Les mises engagées ont déjà quitté
  // le classement, il n'y a donc plus rien à réserver.
  if (context) {
    const member = await guild.members.fetch(userId).catch(() => null);
    const clan = member ? findMemberClan(context.clans, member) : null;
    const points = clan ? await readClanPoints(guildId, clan.id, userKey, context.season) : 0;
    const committed = open.reduce((sum, bet) => {
      const mine = allJoined(bet).find((entry) => userIds.includes(entry.userKey));
      return sum + (mine ? engagedAmount(mine) : 0);
    }, 0);

    embed.addFields({
      name: 'Points misables',
      value: clan
        ? `**${frenchNumber(points)}** disponible(s)`
          + (committed > 0 ? `\n${frenchNumber(committed)} déjà engagé(s) dans des paris en cours` : '')
          + `\n*Clan ${clan.name}*`
        : "Tu n'appartiens à aucun clan : tu ne peux pas parier.",
      inline: false,
    });
  }

  if (debt > 0) {
    embed.addFields({
      name: '💳 Dette',
      value: `**${frenchNumber(debt)} point(s)** dus.\n`
        + 'Tes prochains gains de points de clan serviront à rembourser avant d\'arriver au classement.',
      inline: false,
    });
  }

  const active = open.filter((bet) => bet.status === 'ACTIVE');
  const pending = open.filter((bet) => bet.status === 'PENDING');

  /**
   * Empile des lignes sans dépasser le plafond d'un champ d'embed.
   *
   * Une ligne avec lien pèse près de 200 caractères : un nombre de lignes fixe
   * ferait déborder les 1 024 autorisés, et Discord refuse l'embed entier. La
   * place restante est donc mesurée, et le reste annoncé en clair.
   */
  const listOf = (bets: FullBet[], render: (bet: FullBet) => string) => {
    if (bets.length === 0) return null;

    const lines: string[] = [];
    let used = 0;
    for (const bet of bets) {
      const line = render(bet);
      // La marge couvre la mention « et N de plus » ajoutée ensuite.
      if (lines.length > 0 && used + line.length + 1 > FIELD_VALUE_LIMIT - 40) break;
      lines.push(line);
      used += line.length + 1;
    }

    const hidden = bets.length - lines.length;
    if (hidden > 0) lines.push(`*… et ${hidden} de plus.*`);
    return lines.join('\n');
  };

  const describe = (bet: FullBet) => {
    const link = betMessageLink(bet);
    // La mention reste **hors** du lien : Discord ne résout pas les mentions
    // dans un libellé de lien, elle s'y afficherait en `<@123...>` brut.
    const label = escapeLinkLabel(bet.subject).slice(0, 60);
    const head = link ? `[${label}](${link})` : `**${label}**`;
    const mine = allJoined(bet).find((entry) => userIds.includes(entry.userKey));
    const engaged = mine ? engagedAmount(mine) : 0;
    const opponents = allJoined(bet).filter((entry) => !userIds.includes(entry.userKey)).length;
    return `${head} · ${frenchNumber(engaged)} pts engagés · ${opponents} adversaire(s) · pot ${frenchNumber(betPot(bet))}`;
  };

  embed.addFields({
    name: `🔥 Paris en cours (${active.length})`,
    value: listOf(active, describe) ?? '*Aucun.*',
    inline: false,
  });

  embed.addFields({
    name: `⏳ Inscriptions ouvertes (${pending.length})`,
    value: listOf(
      pending,
      (bet) => `${describe(bet)} · clôture <t:${Math.floor(bet.expiresAt.getTime() / 1000)}:R>`,
    ) ?? '*Aucune.*',
    inline: false,
  });

  embed.addFields({
    name: '📊 Bilan de la saison',
    value: standing
      ? `**${standing.wins}** victoire(s) · **${standing.losses}** défaite(s)\n`
        + `Gain net : **${standing.netGain >= 0 ? '+' : ''}${frenchNumber(standing.netGain)}** point(s)`
        + (standing.bestStreak > 1 ? `\nMeilleure série : **${standing.bestStreak}** d'affilée` : '')
      : '*Aucun pari tranché cette saison.*',
    inline: false,
  });

  return embed;
}

// ─── Récompenses de fin de saison ────────────────────────────────────────────

export interface SeasonRewardOutcome {
  /** Identifiant sous lequel ses points sont comptés, comptes liés repliés. */
  userId: string;
  /**
   * Compte réellement présent sur le serveur : celui qui porte le titre et
   * qu'il faut mentionner. `null` quand le lauréat a quitté le serveur.
   */
  memberId: string | null;
  rank: number;
  netGain: number;
  wins: number;
  /** Prime prévue par les réglages. */
  reward: number;
  /**
   * Points réellement arrivés au classement. Remboursement de dette **exclu** :
   * cette part-là ne bouge aucun score, l'annoncer comme des points ferait lire
   * un gain que le classement ne montrera jamais.
   */
  credited: number;
  /** Part de la prime partie en remboursement de sa dette. */
  debtRepaid: number;
  roleGiven: boolean;
}

/**
 * Retrouve le lauréat sur le serveur.
 *
 * Le palmarès replie les comptes liés sur un seul identifiant, qui n'est pas
 * forcément celui que la personne utilise encore : chercher ce seul compte
 * faisait perdre titre et prime à quelqu'un dont le compte racine a quitté le
 * serveur, alors qu'il est bien là sous son autre compte.
 */
async function findLaureateMember(guild: DiscordGuild, userId: string): Promise<GuildMember | null> {
  const linked = await linkedUserIds(guild.id, userId);
  const candidates = [userId, ...linked.filter((id) => id !== userId)];

  for (const id of candidates) {
    const member = guild.members.cache.get(id) ?? await guild.members.fetch(id).catch(() => null);
    if (member) return member;
  }
  return null;
}

/** Taille d'une page de paris tranchés, à la lecture du palmarès d'une saison. */
const SEASON_BET_PAGE = 500;
/**
 * Garde-fou de boucle. Une saison qui l'atteint a de toute façon dépassé ce
 * qu'un palmarès sait dire de lisible, et la borne se voit dans les logs.
 */
const SEASON_BET_LIMIT = 100_000;

/**
 * Tous les paris tranchés d'une saison, réduits à ce qu'un palmarès en attend.
 *
 * Lus par pages et dans un ordre stable. Une lecture unique plafonnée laissait
 * Postgres choisir quels paris entraient dans le podium dès que la saison
 * dépassait le plafond : au-delà, le titre revenait au meilleur d'un
 * échantillon arbitraire, sans que rien ne le signale.
 */
async function readSeasonSettledBets(
  guildId: string,
  season: number,
  rootOf: (id: string) => string,
): Promise<SettledBet[]> {
  const settled: SettledBet[] = [];
  let cursor: string | null = null;

  while (settled.length < SEASON_BET_LIMIT) {
    const page: FullBet[] = await prisma.clanBet.findMany({
      where: { guildId, season, status: 'RESOLVED', winningSideId: { not: null } },
      include: BET_INCLUDE,
      orderBy: { id: 'asc' },
      take: SEASON_BET_PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (page.length === 0) break;

    for (const bet of page) {
      settled.push({
        entries: allJoined(bet).map((entry) => ({
          userId: rootOf(entry.userId),
          engaged: engagedAmount(entry),
          payout: entry.payout,
          won: entry.sideId === bet.winningSideId,
        })),
        resolvedAt: bet.resolvedAt ?? bet.updatedAt,
      });
    }

    if (page.length < SEASON_BET_PAGE) break;
    cursor = page[page.length - 1]?.id ?? null;
    if (!cursor) break;
  }

  if (settled.length >= SEASON_BET_LIMIT) {
    logger.warn('ClanBet', `Palmarès de la saison ${season} sur ${guildId} arrêté à ${SEASON_BET_LIMIT} paris.`);
  }
  return settled;
}

/** Une marche du podium, une origine : le flux public nomme la prime reçue. */
const SEASON_REWARD_SOURCES: Readonly<Record<number, ClanContributionSource>> = {
  1: 'BET_TOP1',
  2: 'BET_TOP2',
  3: 'BET_TOP3',
};

/**
 * Sacre le podium des parieurs d'une saison qui se clôt.
 *
 * Appelé après le règlement des paris ouverts : ceux-ci sont alors remboursés,
 * donc absents du palmarès, qui ne compte que des verdicts rendus.
 *
 * Les primes sont versées sur la saison **suivante**. Créditées sur celle qui
 * vient de se fermer, elles n'apparaîtraient dans aucun classement consultable ;
 * versées sur la suivante, elles récompensent visiblement et alimentent le clan
 * que le lauréat porte à ce moment-là.
 *
 * Une saison ne se récompense qu'une fois : la marque posée en base avant le
 * premier versement arrête toute clôture qui repasserait sur le même numéro.
 */
export async function awardSeasonBettors(params: {
  client: Client;
  guildId: string;
  season: number;
  nextSeason: number;
}): Promise<SeasonRewardOutcome[]> {
  const { client, guildId, season, nextSeason } = params;
  const settings = await getClanBetSettings(guildId);
  if (!settings.betsEnabled || !settings.betSeasonRewardEnabled) return [];

  // Les comptes liés sont repliés avant le calcul : sans ce repli, une personne
  // qui a parié depuis ses deux comptes apparaîtrait deux fois sur le podium et
  // toucherait deux primes.
  const rootOf = await buildLinkedAccountFolder(guildId).catch(() => (id: string) => id);

  const settledBets = await readSeasonSettledBets(guildId, season, rootOf);
  if (settledBets.length === 0) return [];

  const laureates = buildSeasonLaureates(buildBettorStandings(settledBets), settings);
  if (laureates.length === 0) return [];

  const guild = client.guilds.cache.get(guildId) ?? await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return [];

  // Marque posée avant le premier versement : deux clôtures de la même saison -
  // deux remises à zéro qui lisent le même numéro avant de l'incrémenter, un
  // cron qui repasse pendant que le précédent travaille encore - verseraient
  // sinon les primes deux fois. C'est l'unicité qui tranche, pas une lecture
  // préalable qui laisserait la place à deux clôtures simultanées.
  const claim = await prisma.clanBetSeasonAward.create({ data: { guildId, season } }).catch((err: unknown) => {
    // Seule la violation d'unicité veut dire « déjà récompensée ». Toute autre
    // panne d'écriture - migration en retard, base indisponible - ne doit pas
    // priver le podium de sa saison : elle est signalée, et le versement suit
    // son cours sans marque.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return 'duplicate' as const;
    logger.error('ClanBet', `Marque des primes de la saison ${season} non posée sur ${guildId} :`, err);
    return null;
  });
  if (claim === 'duplicate') {
    logger.warn('ClanBet', `Primes de la saison ${season} déjà versées sur ${guildId} : clôture ignorée.`);
    return [];
  }

  const context = await loadBetContext(guildId);
  const role = settings.betSeasonRewardRoleId
    ? guild.roles.cache.get(settings.betSeasonRewardRoleId)
      ?? await guild.roles.fetch(settings.betSeasonRewardRoleId).catch(() => null)
    : null;

  // Le titre est celui d'une saison, pas un acquis : ses porteurs précédents le
  // rendent avant que les nouveaux ne le reçoivent.
  if (role) {
    for (const member of [...role.members.values()]) {
      await member.roles.remove(role.id, `Clôture de la saison ${season} - rotation du titre de meilleur parieur`)
        .catch((err: unknown) => logger.warn('ClanBet', `Retrait du titre de parieur à ${member.id} impossible :`, err));
    }
  }

  const outcomes: SeasonRewardOutcome[] = [];

  for (const laureate of laureates) {
    let credited = 0;
    let debtRepaid = 0;
    let roleGiven = false;

    const member = await findLaureateMember(guild, laureate.userId);

    if (member && role && laureate.rank === 1) {
      roleGiven = await member.roles.add(role.id, `Meilleur parieur de la saison ${season}`)
        .then(() => true)
        .catch((err: unknown) => {
          logger.warn('ClanBet', `Titre de meilleur parieur non attribué à ${laureate.userId} :`, err);
          return false;
        });
    }

    // Sans clan, la prime n'a aucune ligne de contribution où atterrir : le
    // titre reste, la prime est simplement sautée.
    const clan = member && context ? findMemberClan(context.clans, member) : null;
    if (clan && laureate.reward > 0) {
      const moved = await moveClanPoints({
        guildId,
        clanId: clan.id,
        userId: laureate.userId,
        season: nextSeason,
        amount: laureate.reward,
        source: SEASON_REWARD_SOURCES[laureate.rank] ?? 'BET',
      }).catch((err: unknown) => {
        logger.error('ClanBet', `Prime de parieur non versée à ${laureate.userId} :`, err);
        return { granted: 0, debtRepaid: 0 };
      });
      // Comme partout ailleurs, ce qui compte est ce qui est arrivé : un
      // lauréat endetté voit sa prime partir d'abord en remboursement. Les deux
      // parts restent séparées, elles ne se lisent pas au même endroit - l'une
      // au classement, l'autre sur l'ardoise.
      credited = moved.granted;
      debtRepaid = moved.debtRepaid;
    }

    outcomes.push({ ...laureate, memberId: member?.id ?? null, credited, debtRepaid, roleGiven });
  }

  if (claim) {
    await prisma.clanBetSeasonAward.update({
      where: { id: claim.id },
      data: {
        laureates: outcomes.length,
        awardedPoints: outcomes.reduce((sum, outcome) => sum + outcome.credited + outcome.debtRepaid, 0),
      },
    }).catch(() => undefined);
  }

  logger.info(
    'ClanBet',
    `${outcomes.length} parieur(s) récompensé(s) à la clôture de la saison ${season} sur ${guildId}.`,
  );
  return outcomes;
}
