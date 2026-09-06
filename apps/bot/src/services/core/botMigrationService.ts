/**
 * Reprise de configuration depuis les autres bots du serveur.
 *
 * Quand Kotbo arrive sur un serveur deja equipe, tout est a refaire a la main :
 * les tickets, le message de bienvenue, les roles par reaction. Ce service
 * repond a trois questions, dans cet ordre :
 *
 *  1. quels bots sont la, et que couvrent-ils (`detectBots`) ;
 *  2. qu'est-ce qui est lisible du serveur lui-meme (`scanServerConfig`) ;
 *  3. que peut-on reprendre automatiquement, et que faudra-t-il refaire
 *     a la main (`buildMigrationPlan`, `applyMigrationPlan`).
 *
 * Rien n'est applique sans que le staff n'ait coche la proposition : un import
 * approximatif qui ecrase une configuration existante coute plus cher que la
 * saisie manuelle qu'il pretend eviter.
 */
import { ChannelType, type Guild, type GuildBasedChannel } from 'discord.js';
import type { Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import {
  LEVELING_PROFILES,
  TICKET_PROFILES,
  matchKnownBot,
  type BotFeature,
  type BotSignature,
  type KnownBot,
} from './botRegistry.js';
import { inspectMessages, type InspectionPayload } from './botMessageInspector.js';
import { createReactionRoleMenu } from '../features/reactionRoleService.js';
import { createStaffHierarchy, createStaffRole, importRoleMembers } from '../staff/staffManagementService.js';
import { readServerTemplateRefs } from './serverTemplateService.js';

export type DetectedBot = {
  id: string;
  username: string;
  /** Nom du bot reconnu, ou `null` s'il ne figure pas au registre. */
  label: string | null;
  /** Clef du registre, `null` pour un bot inconnu. Sert a nommer ses propositions. */
  key: string | null;
  /**
   * Photo de profil reelle du bot, telle que Discord la sert.
   *
   * Une icone generique ne distingue pas MEE6 de Dyno : la liste des bots
   * presents se lit d'un coup d'oeil quand chaque ligne porte la vignette que
   * le staff voit deja dans sa liste de membres.
   */
  avatarUrl: string;
  covers: BotFeature[];
  /** Fonctions dont une trace a ete trouvee sur le serveur, avec ce qui la prouve. */
  activeFeatures: { feature: BotFeature; evidence: string }[];
};

/**
 * Bots presents sur le serveur, les connus d'abord.
 *
 * Salons et roles sont charges au passage pour y chercher les traces de chaque
 * bot : un bot present ne se sert pas forcement de tout ce qu'il sait faire, et
 * une reprise batie sur ses capacites theoriques proposerait de reprendre ce
 * que personne n'utilise ici.
 */
export async function detectBots(guild: Guild): Promise<DetectedBot[]> {
  // `fetch` plutot que le cache : sans l'intent des membres, le cache ne
  // contient souvent que le bot lui-meme.
  const members = await guild.members.fetch({ time: 8000 }).catch(() => guild.members.cache);
  if (guild.channels.cache.size === 0) await guild.channels.fetch().catch(() => null);

  const bots = Array.from(members.values())
    .filter((member) => member.user.bot && member.user.id !== guild.client.user?.id)
    .map((member) => {
      const known = matchKnownBot(member.user.username);
      return {
        id: member.user.id,
        username: member.user.username,
        label: known?.label ?? null,
        key: known?.key ?? null,
        avatarUrl: member.user.displayAvatarURL({ size: 64, extension: 'png' }),
        covers: known?.covers ?? [],
        activeFeatures: known ? findBotSignatures(guild, known) : [],
      };
    });

  return bots.sort((a, b) => Number(!!b.label) - Number(!!a.label) || a.username.localeCompare(b.username));
}

/** Traces du bot effectivement trouvees sur le serveur, une par fonction. */
function findBotSignatures(guild: Guild, bot: KnownBot): { feature: BotFeature; evidence: string }[] {
  const found = new Map<BotFeature, string>();

  for (const signature of bot.signatures ?? []) {
    if (found.has(signature.feature)) continue;
    if (matchesSignature(guild, signature)) found.set(signature.feature, signature.label);
  }

  return Array.from(found.entries()).map(([feature, evidence]) => ({ feature, evidence }));
}

function matchesSignature(guild: Guild, signature: BotSignature): boolean {
  if (signature.target === 'role') {
    return guild.roles.cache.some((role) => signature.pattern.test(role.name ?? ''));
  }

  const wantedType = signature.target === 'category' ? ChannelType.GuildCategory : ChannelType.GuildText;
  return guild.channels.cache.some(
    (channel) => channel.type === wantedType && signature.pattern.test(channel.name ?? ''),
  );
}

export type ScanFinding = {
  /** Identifiant stable, utilise par l'UI pour cocher la proposition. */
  key: string;
  feature: BotFeature;
  title: string;
  detail: string;
  /** Ce que Kotbo ecrira si la proposition est retenue. */
  action: string | null;
  /** Salons ou entites reperes, pour que le staff verifie avant d'appliquer. */
  entities: { id: string; name: string }[];
  /**
   * Contenu relu dans les messages du serveur, quand le constat en vient.
   *
   * C'est litteralement ce qui sera ecrit : le dashboard l'affiche tel quel
   * pour qu'on relise avant d'appliquer. Absent sur les constats qui ne font
   * que designer un salon.
   */
  payload?: InspectionPayload;
};

/** Motifs de nom qui trahissent un salon dedie a une fonction. */
const NAME_HINTS = {
  ticketCategory: /ticket|support|assistance/i,
  welcome: /welcome|bienvenue|arriv|hello|entr[ée]e/i,
  reactionRoles: /r[oô]les?|roles|auto-?r[oô]le|reaction/i,
  logs: /logs?|journal|audit/i,
  rules: /r[eè]gle|reglement|règlement|rules|charte|conditions/i,
} as const;

function channelName(channel: GuildBasedChannel): string {
  return channel.name ?? '';
}

/**
 * Lit du serveur ce qui se devine sans deviner.
 *
 * Le nom d'un salon ou d'une categorie est un indice, pas une preuve : chaque
 * constat est presente comme une proposition a verifier, et nomme les salons
 * concernes pour que le staff tranche.
 */
export async function scanServerConfig(guild: Guild, bots: DetectedBot[] = []): Promise<ScanFinding[]> {
  if (guild.channels.cache.size === 0) await guild.channels.fetch().catch(() => null);

  const findings: ScanFinding[] = [...buildPresetFindings(bots)];
  const channels = Array.from(guild.channels.cache.values());

  // ── Tickets ───────────────────────────────────────────────────────────────
  const ticketCategories = channels.filter(
    (ch) => ch.type === ChannelType.GuildCategory && NAME_HINTS.ticketCategory.test(channelName(ch)),
  );
  if (ticketCategories.length > 0) {
    const category = ticketCategories[0]!;
    findings.push({
      key: 'tickets.category',
      feature: 'tickets',
      title: 'Catégorie de tickets existante',
      detail: `La catégorie « ${category.name} » ressemble à celle d'un système de tickets. Kotbo peut y créer les siens, à côté de ceux de l'ancien bot.`,
      action: 'Définir cette catégorie comme catégorie des tickets Kotbo',
      entities: ticketCategories.map((c) => ({ id: c.id, name: c.name })),
    });
  }

  const openTicketChannels = channels.filter(
    (ch) => ch.type === ChannelType.GuildText && /^(ticket|🎫|support)[-_ ]/i.test(channelName(ch)),
  );
  if (openTicketChannels.length > 0) {
    findings.push({
      key: 'tickets.open',
      feature: 'tickets',
      // Sans action : reprendre des tickets ouverts par un autre bot demande de
      // recreer leur historique, que Kotbo n'a pas.
      title: `${openTicketChannels.length} ticket(s) encore ouvert(s)`,
      detail: "Ces salons appartiennent à l'ancien système. Fermez-les avant de basculer, sinon leurs auteurs auront deux tickets en cours et le staff deux fils à suivre.",
      action: null,
      entities: openTicketChannels.slice(0, 10).map((c) => ({ id: c.id, name: c.name })),
    });
  }

  // ── Bienvenue ─────────────────────────────────────────────────────────────
  const welcomeChannels = channels.filter(
    (ch) => ch.type === ChannelType.GuildText && NAME_HINTS.welcome.test(channelName(ch)),
  );
  if (welcomeChannels.length > 0) {
    findings.push({
      key: 'welcome.channel',
      feature: 'welcome',
      title: "Salon d'accueil repéré",
      detail: `« ${welcomeChannels[0]!.name} » sert visiblement à accueillir les arrivants. Kotbo peut y poster ses propres messages de bienvenue.`,
      action: "Définir ce salon comme salon de bienvenue",
      entities: welcomeChannels.map((c) => ({ id: c.id, name: c.name })),
    });
  }

  // ── Roles par reaction ────────────────────────────────────────────────────
  const roleChannels = channels.filter(
    (ch) => ch.type === ChannelType.GuildText && NAME_HINTS.reactionRoles.test(channelName(ch)),
  );
  if (roleChannels.length > 0) {
    findings.push({
      key: 'reactionRoles.channel',
      feature: 'reactionRoles',
      // Sans action : les associations emoji/role vivent dans la base de
      // l'ancien bot, pas sur Discord. On ne peut que montrer ou chercher.
      title: 'Salon de rôles par réaction',
      detail: `« ${roleChannels[0]!.name} » contient probablement des menus de rôles. Les correspondances emoji/rôle ne sont lisibles que depuis l'ancien bot : elles sont à ressaisir dans Kotbo.`,
      action: null,
      entities: roleChannels.map((c) => ({ id: c.id, name: c.name })),
    });
  }

  // ── AutoMod natif ─────────────────────────────────────────────────────────
  try {
    const rules = await guild.autoModerationRules.fetch();
    const enabled = rules.filter((rule) => rule.enabled);
    if (enabled.size > 0) {
      findings.push({
        key: 'automod.native',
        feature: 'automod',
        title: `${enabled.size} règle(s) AutoMod Discord actives`,
        detail: "Ces règles sont portées par Discord, pas par un bot : elles continueront de s'appliquer à côté de l'AutoMod de Kotbo. Vérifiez qu'elles ne font pas doublon.",
        action: null,
        entities: enabled.map((rule) => ({ id: rule.id, name: rule.name })).slice(0, 10),
      });
    }
  } catch {
    // Permission « Gérer le serveur » manquante : le constat est simplement absent.
  }

  // ── Salons de logs ────────────────────────────────────────────────────────
  const logChannels = channels.filter(
    (ch) => ch.type === ChannelType.GuildText && NAME_HINTS.logs.test(channelName(ch)),
  );
  if (logChannels.length > 0) {
    findings.push({
      key: 'logs.channel',
      feature: 'stats',
      title: 'Salon de logs repéré',
      detail: `« ${logChannels[0]!.name} » reçoit déjà des journaux. Kotbo peut y écrire les siens, ou vous pouvez lui en donner un autre.`,
      action: 'Définir ce salon comme salon de logs Kotbo',
      entities: logChannels.map((c) => ({ id: c.id, name: c.name })),
    });
  }

  // ── Ce qui est deja ecrit ─────────────────────────────────────────────────
  // Les constats ci-dessus disent ou ; ceux-la disent quoi. Ils viennent en
  // dernier parce qu'ils coutent des appels reseau, et parce qu'ils se servent
  // des memes salons, deja reperes par leur nom.
  const rulesChannels = unique([
    guild.rulesChannel,
    ...channels.filter((ch) => ch.type === ChannelType.GuildText && NAME_HINTS.rules.test(channelName(ch))),
  ]);

  // Le panneau de tickets ne vit pas dans la categorie des tickets : elle
  // n'accueille que les tickets ouverts. Il est dans un salon qui porte le meme
  // vocabulaire, ou dans celui ou l'on invite a en ouvrir un.
  const ticketPanelChannels = unique(
    channels.filter(
      (ch) =>
        ch.type === ChannelType.GuildText &&
        (NAME_HINTS.ticketCategory.test(channelName(ch)) || /ouvrir|cr[ée]er|open|create/i.test(channelName(ch))) &&
        !/^(ticket|🎫|support)[-_ ]/i.test(channelName(ch)),
    ),
  );

  findings.push(
    ...(await inspectMessages(guild, {
      welcome: unique([...welcomeChannels, guild.systemChannel]),
      rules: rulesChannels,
      tickets: ticketPanelChannels,
      roles: unique(roleChannels),
    })),
  );

  // ── Roles de niveau ───────────────────────────────────────────────────────
  const levelRewards = detectLevelRoleRewards(guild);
  if (levelRewards.length >= 2) {
    const existingLevels = new Set(
      (
        await prisma.levelRoleReward.findMany({ where: { guildId: guild.id }, select: { level: true } })
      ).map((reward) => reward.level),
    );
    const missing = levelRewards.filter((reward) => !existingLevels.has(reward.level));
    if (missing.length > 0) {
      findings.push({
        key: 'leveling.roleRewards',
        feature: 'leveling',
        title: `${missing.length} rôle(s) de niveau repéré(s)`,
        detail:
          `Ces rôles portent un niveau dans leur nom (${missing.slice(0, 3).map((r) => r.roleName).join(', ')}` +
          `${missing.length > 3 ? '…' : ''}). Kotbo peut les distribuer automatiquement une fois ce niveau atteint ` +
          "- les niveaux déjà acquis par les membres, eux, ne se transfèrent pas.",
        action: 'Débloquer chaque rôle au niveau que son nom annonce',
        entities: missing.map((reward) => ({ id: reward.roleId, name: reward.roleName })),
      });
    }
  }

  // ── Hierarchie de staff ───────────────────────────────────────────────────
  const staffLadder = detectStaffLadder(guild);
  if (staffLadder.length >= 2) {
    const hasHierarchy = (await prisma.staffHierarchy.count({ where: { guildId: guild.id } })) > 0;
    if (!hasHierarchy) {
      findings.push({
        key: 'staff.hierarchy',
        feature: 'staff',
        title: `Hiérarchie de ${staffLadder.length} rôle(s) de staff repérée`,
        detail:
          `Ces rôles, classés du plus haut au plus bas dans Discord, ressemblent à une équipe de modération. ` +
          "Kotbo peut les cataloguer comme hiérarchie et y importer les membres qui les portent déjà - le grade " +
          'reste ensuite modifiable depuis la page Staff.',
        action: 'Créer cette hiérarchie et y importer les membres',
        entities: staffLadder.map((role) => ({ id: role.roleId, name: role.roleName })),
      });
    }
  }

  // ── Role general deja en place ───────────────────────────────────────────
  const existingMemberRole = await detectExistingMemberRoleIfUntracked(guild);
  if (existingMemberRole) {
    findings.push({
      key: 'roles.member',
      feature: 'access',
      title: 'Rôle général déjà en place',
      detail:
        `« ${existingMemberRole.roleName} » est déjà porté par ${Math.round(existingMemberRole.coverage * 100)} %` +
        " des membres humains. C'est probablement déjà lui qui ouvre le serveur : Kotbo peut le reprendre comme " +
        "rôle Membre plutôt que d'en créer un autre et de le redistribuer à tout le monde.",
      action: 'Utiliser ce rôle comme rôle Membre de Kotbo',
      entities: [{ id: existingMemberRole.roleId, name: existingMemberRole.roleName }],
    });
  }

  return findings;
}

/** Salons distincts, dans l'ordre donne, les absents ecartes. */
function unique(channels: (GuildBasedChannel | null | undefined)[]): GuildBasedChannel[] {
  const seen = new Map<string, GuildBasedChannel>();
  for (const channel of channels) {
    if (channel && !seen.has(channel.id)) seen.set(channel.id, channel);
  }
  return Array.from(seen.values());
}

/** Reconnait un role de palier de niveau et le niveau qu'il porte dans son nom. */
const LEVEL_ROLE_NUMBER = /^(?:niveau|level|lvl)\W{0,3}(\d{1,3})\b/i;

/**
 * Roles de niveau deja presents sur le serveur, quel que soit celui qui les a
 * crees - certains sont poses a la main, sans qu'aucun bot connu ne soit la
 * pour les expliquer. Le nom est la seule preuve lisible depuis Discord :
 * l'XP qui les debloquait, elle, reste dans la base de l'ancien systeme.
 *
 * A niveau egal, deux roles ne devraient pas coexister ; si c'est le cas,
 * celui que Discord place le plus haut l'emporte - un doublon de ce genre est
 * en general un reliquat, pas le role encore utilise.
 */
function detectLevelRoleRewards(guild: Guild): { roleId: string; roleName: string; level: number }[] {
  const byLevel = new Map<number, { roleId: string; roleName: string; level: number; position: number }>();

  for (const role of guild.roles.cache.values()) {
    const match = role.name.match(LEVEL_ROLE_NUMBER);
    if (!match) continue;
    const level = Number(match[1]);
    if (!Number.isInteger(level) || level <= 0 || level > 999) continue;

    const existing = byLevel.get(level);
    if (!existing || role.position > existing.position) {
      byLevel.set(level, { roleId: role.id, roleName: role.name, level, position: role.position });
    }
  }

  return Array.from(byLevel.values())
    .sort((a, b) => a.level - b.level)
    .map(({ roleId, roleName, level }) => ({ roleId, roleName, level }));
}

/** Motif d'un role de staff, partage avec l'ecran d'onboarding qui coche les memes roles. */
const STAFF_ROLE_PATTERN = /mod|admin|staff|resp|helper|support/i;
/** Au-dela, la liste des membres nomme deja tout le monde : une hierarchie a vingt echelons n'aide personne. */
const STAFF_LADDER_LIMIT = 8;

/**
 * Roles qui ressemblent a une equipe de moderation, du plus haut au plus bas.
 *
 * Le nom est le seul indice qu'on puisse lire sans se tromper : les
 * permissions d'un role ne disent pas s'il est reserve au staff ou prete a un
 * partenaire. La position, elle, donne l'ordre - Discord affiche deja les
 * roles du plus haut au plus bas, et c'est l'ordre que le staff a choisi en
 * les creant.
 */
function detectStaffLadder(guild: Guild): { roleId: string; roleName: string; color: string | null }[] {
  return Array.from(guild.roles.cache.values())
    .filter((role) => role.id !== guild.id && !role.managed && STAFF_ROLE_PATTERN.test(role.name))
    .sort((a, b) => b.position - a.position)
    .slice(0, STAFF_LADDER_LIMIT)
    .map((role) => ({
      roleId: role.id,
      roleName: role.name,
      color: role.hexColor !== '#000000' ? role.hexColor : null,
    }));
}

/** En dessous, un role qui couvre « presque tout le monde » ne prouve rien : un serveur neuf n'a encore que ses fondateurs. */
const MEMBER_ROLE_MIN_HUMANS = 25;
/** Au-dela, la couverture designe manifestement un role general, pas un role de niche (evenement, jeu, notification). */
const MEMBER_ROLE_MIN_COVERAGE = 0.6;

/**
 * Role qui joue deja le role du role Membre sur un serveur existant : celui
 * que la quasi-totalite des membres humains portent deja.
 *
 * La mise en place ferme tous les salons a @everyone et les rouvre au seul
 * role Membre, puis le distribue a qui ne l'a pas (`memberAccessService.ts`).
 * En creer un nouveau sur un serveur qui a deja cette fonction assuree
 * distribuerait ce role a des milliers de membres pour rien, et laisserait
 * l'ancien en place a cote - deux roles pour la meme fonction. Le nom ne dit
 * rien de fiable (un role renomme ou traduit differemment echapperait a toute
 * recherche par intitule) : c'est le nombre de porteurs qui trahit ce role.
 */
function detectExistingMemberRole(guild: Guild): { roleId: string; roleName: string; coverage: number } | null {
  const humans = guild.members.cache.filter((member) => !member.user.bot);
  if (humans.size < MEMBER_ROLE_MIN_HUMANS) return null;

  let best: { roleId: string; roleName: string; count: number } | null = null;
  for (const role of guild.roles.cache.values()) {
    if (role.id === guild.id) continue; // @everyone n'est le constat de personne
    if (role.managed) continue; // role de bot ou de boost, pas un choix du staff
    if (STAFF_ROLE_PATTERN.test(role.name)) continue; // deja classe comme staff, pas comme role general

    const count = role.members.filter((member) => !member.user.bot).size;
    if (!best || count > best.count) best = { roleId: role.id, roleName: role.name, count };
  }

  if (!best || best.count === 0) return null;

  const coverage = best.count / humans.size;
  if (coverage < MEMBER_ROLE_MIN_COVERAGE) return null;

  return { roleId: best.roleId, roleName: best.roleName, coverage };
}

/**
 * Le constat ci-dessus, ecarte si un role Membre est deja trace : le reposer
 * apres coup reviendrait a remettre en cause un choix deja fait, ici ou
 * pendant la mise en place guidee.
 */
async function detectExistingMemberRoleIfUntracked(
  guild: Guild,
): Promise<{ roleId: string; roleName: string; coverage: number } | null> {
  const guildRow = await prisma.guild.findUnique({ where: { id: guild.id }, select: { serverTemplateRefs: true } });
  const knownId = readServerTemplateRefs(guildRow?.serverTemplateRefs)['role.member'];
  if (knownId && guild.roles.cache.has(knownId)) return null;

  return detectExistingMemberRole(guild);
}

/**
 * Prefixe des constats qui posent un prereglage plutot qu'un identifiant.
 *
 * Les autres constats designent un salon existant : leur application ecrit une
 * colonne de la guilde avec cet identifiant. Ceux-la n'ont pas d'entite - ils
 * posent une configuration entiere, tiree du registre des bots.
 */
const PRESET_PREFIX = 'preset:';

/**
 * Ce que Kotbo peut poser d'emblee pour prendre la suite des bots detectes.
 *
 * Une proposition n'apparait que si le bot laisse une trace de la fonction sur
 * le serveur : MEE6 present mais sans un seul role de niveau ne justifie pas de
 * proposer une courbe d'XP. La trace est citee dans le constat, pour que le
 * staff sache sur quoi repose la suggestion.
 */
function buildPresetFindings(bots: DetectedBot[]): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const seen = new Set<string>();

  for (const bot of bots) {
    if (!bot.key || !bot.label) continue;
    const known = matchKnownBot(bot.username);
    if (!known) continue;

    const active = new Set(bot.activeFeatures.map((entry) => entry.feature));
    const evidenceOf = (feature: BotFeature) =>
      bot.activeFeatures.find((entry) => entry.feature === feature)?.evidence ?? '';

    const levelingProfile = known.leveling ? LEVELING_PROFILES[known.leveling] : null;
    if (levelingProfile && active.has('leveling') && !seen.has('leveling')) {
      seen.add('leveling');
      findings.push({
        key: `${PRESET_PREFIX}leveling:${levelingProfile.key}`,
        feature: 'leveling',
        title: `Reprendre la progression de ${bot.label}`,
        detail: `${bot.label} gère les niveaux ici (${evidenceOf('leveling')}). ${levelingProfile.source} Les niveaux déjà acquis, eux, ne se transfèrent pas : seule la façon de progresser est reprise.`,
        action: `Activer les niveaux Kotbo avec le profil « ${levelingProfile.label} »`,
        entities: [],
      });
    }

    const ticketProfile = known.tickets ? TICKET_PROFILES[known.tickets] : null;
    if (ticketProfile && active.has('tickets') && !seen.has('tickets')) {
      seen.add('tickets');
      findings.push({
        key: `${PRESET_PREFIX}tickets:${ticketProfile.key}`,
        feature: 'tickets',
        title: `Préparer les tickets à la place de ${bot.label}`,
        detail: `${bot.label} gère les tickets ici (${evidenceOf('tickets')}). ${ticketProfile.source} Kotbo pose un panneau et ${ticketProfile.types.length} sujets prêts à l'emploi, à ajuster ensuite depuis la page Tickets.`,
        action: `Poser le panneau et les ${ticketProfile.types.length} sujets du profil « ${ticketProfile.label} »`,
        entities: [],
      });
    }
  }

  return findings;
}

export type MigrationPlan = {
  bots: DetectedBot[];
  findings: ScanFinding[];
  /** Fonctionnalites couvertes par un bot present et que Kotbo sait reprendre. */
  manualSteps: { feature: string; label: string; why: string }[];
};

/**
 * Ce que Kotbo ne peut pas lire du serveur et qu'il faudra ressaisir.
 *
 * Ces donnees vivent dans la base de l'ancien bot : aucune inspection du
 * serveur ne les rend. Les annoncer des le depart evite de croire la reprise
 * terminee alors que l'essentiel manque.
 */
type ManualStep = {
  label: string;
  why: string;
  /**
   * Ce qu'il reste a faire quand la lecture des messages a deja rendu le gros.
   *
   * `null` quand il ne reste rien : la ressaisie annoncee n'a plus lieu d'etre,
   * et la laisser affichee ferait douter d'une reprise qui a pourtant marche.
   */
  recovered?: { label: string; why: string } | null;
};

const MANUAL_STEPS: Record<string, ManualStep> = {
  leveling: {
    label: "Niveaux et XP des membres",
    why: "L'XP accumulée vit dans la base de l'ancien bot. La plupart proposent un export ; sans lui, les compteurs repartent de zéro.",
  },
  reactionRoles: {
    label: 'Correspondances emoji → rôle',
    why: "Discord ne stocke que les réactions, pas le rôle qu'elles accordent. À recréer menu par menu.",
  },
  welcome: {
    label: "Texte et embed du message de bienvenue",
    why: "Le message n'est composé qu'au moment où quelqu'un arrive : il n'existe que dans le salon d'accueil, s'il y en a un.",
    recovered: null,
  },
  tickets: {
    label: 'Types de tickets et formulaires',
    why: "Le panneau visible ne montre que ses boutons. Les questions posées à l'ouverture sont à ressaisir.",
    recovered: {
      label: "Formulaires d'ouverture des tickets",
      why: "Les sujets ont été lus dans le panneau, mais pas les questions posées à l'ouverture : elles vivent dans la base de l'ancien bot.",
    },
  },
  automod: {
    label: 'Listes de mots et règles personnalisées',
    why: "Les filtres d'un bot tiers ne sont pas exposés par Discord.",
  },
  stats: {
    label: 'Historique de statistiques',
    why: "Kotbo commence ses mesures à son arrivée ; l'antériorité ne se transfère pas.",
  },
};

/**
 * Constats de lecture qui repondent deja a une ressaisie annoncee.
 *
 * Annoncer une migration complete puis laisser decouvrir trois trous un mois
 * plus tard est la meilleure facon de perdre quelqu'un. L'inverse coute aussi :
 * annoncer une ressaisie qu'on vient d'eviter fait passer pour manuel ce qui a
 * marche tout seul.
 */
const RECOVERED_BY: Record<string, string> = {
  'welcome.message': 'welcome',
  'tickets.panel': 'tickets',
  'reactionRoles.menu': 'reactionRoles',
};

export async function buildMigrationPlan(guild: Guild): Promise<MigrationPlan> {
  // Sequentiel et non parallele : le scan a besoin des bots detectes pour en
  // tirer les prereglages, et `detectBots` a deja charge salons et roles.
  const bots = await detectBots(guild);
  const findings = await scanServerConfig(guild, bots);

  const recovered = new Set(
    findings.map((finding) => RECOVERED_BY[finding.key]).filter((feature): feature is string => !!feature),
  );

  const covered = new Set(bots.flatMap((bot) => bot.covers));
  const manualSteps = Array.from(covered)
    .map((feature) => {
      const step = MANUAL_STEPS[feature];
      if (!step) return null;
      const narrowed = recovered.has(feature) ? step.recovered ?? step : step;
      return narrowed ? { feature, label: narrowed.label, why: narrowed.why } : null;
    })
    .filter((step): step is NonNullable<typeof step> => step !== null);

  return { bots, findings, manualSteps };
}

/**
 * Applique les propositions retenues.
 *
 * Chaque cle correspond a un constat qui porte une `action`. Un constat sans
 * action est ignore meme s'il est coche : il n'existe que pour informer.
 */
export async function applyMigrationPlan(
  guild: Guild,
  keys: string[],
): Promise<{ applied: string[]; skipped: string[] }> {
  const bots = await detectBots(guild);
  const findings = await scanServerConfig(guild, bots);
  const selected = findings.filter((f) => keys.includes(f.key) && f.action);

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const finding of selected) {
    if (finding.payload) {
      try {
        const done = await applyInspection(guild, finding.payload);
        if (done) applied.push(finding.title);
        else skipped.push(finding.key);
      } catch (err) {
        logger.error('BotMigration', `Reprise de contenu ${finding.key} impossible sur ${guild.id}`, err);
        skipped.push(finding.key);
      }
      continue;
    }

    if (finding.key.startsWith(PRESET_PREFIX)) {
      try {
        const done = await applyPreset(guild, finding.key);
        if (done) applied.push(finding.title);
        else skipped.push(finding.key);
      } catch (err) {
        logger.error('BotMigration', `Prereglage ${finding.key} impossible sur ${guild.id}`, err);
        skipped.push(finding.key);
      }
      continue;
    }

    if (finding.key === 'leveling.roleRewards') {
      try {
        const done = await applyLevelRoleRewards(guild);
        if (done) applied.push(finding.title);
        else skipped.push(finding.key);
      } catch (err) {
        logger.error('BotMigration', `Reprise des rôles de niveau impossible sur ${guild.id}`, err);
        skipped.push(finding.key);
      }
      continue;
    }

    if (finding.key === 'staff.hierarchy') {
      try {
        const done = await applyStaffLadder(guild);
        if (done) applied.push(finding.title);
        else skipped.push(finding.key);
      } catch (err) {
        logger.error('BotMigration', `Reprise de la hiérarchie de staff impossible sur ${guild.id}`, err);
        skipped.push(finding.key);
      }
      continue;
    }

    if (finding.key === 'roles.member') {
      try {
        const done = await applyExistingMemberRole(guild, finding.entities[0]?.id);
        if (done) applied.push(finding.title);
        else skipped.push(finding.key);
      } catch (err) {
        logger.error('BotMigration', `Reprise du rôle général existant impossible sur ${guild.id}`, err);
        skipped.push(finding.key);
      }
      continue;
    }

    const target = finding.entities[0];
    if (!target) {
      skipped.push(finding.key);
      continue;
    }

    try {
      const data = migrationUpdateFor(finding.key, target.id);
      if (!data) {
        skipped.push(finding.key);
        continue;
      }
      await prisma.guild.update({ where: { id: guild.id }, data });
      applied.push(finding.title);
    } catch (err) {
      logger.error('BotMigration', `Reprise ${finding.key} impossible sur ${guild.id}`, err);
      skipped.push(finding.key);
    }
  }

  return { applied, skipped };
}

/**
 * Ecrit ce qui a ete relu dans les messages du serveur.
 *
 * Meme garde-fou partout : on ne touche pas a ce que le staff a deja renseigne
 * dans Kotbo. Un texte relu ailleurs, si bien devine soit-il, ne vaut pas une
 * decision prise ici - et une reprise qui efface du travail deja fait coute
 * plus cher que la saisie qu'elle pretend eviter.
 *
 * Rend `false` quand il n'y avait rien a poser : la proposition est alors
 * comptee comme ignoree, pas comme appliquee.
 */
async function applyInspection(guild: Guild, payload: InspectionPayload): Promise<boolean> {
  const guildId = guild.id;

  if (payload.kind === 'welcome') {
    const existing = await prisma.welcomeConfig.findUnique({
      where: { guildId },
      select: { welcomeEnabled: true },
    });
    // Un accueil deja actif veut dire un texte deja choisi ici.
    if (existing?.welcomeEnabled) return false;

    const values = {
      welcomeEnabled: true,
      welcomeChannelId: payload.channelId,
      welcomeMessage: payload.message,
    };
    await prisma.welcomeConfig.upsert({
      where: { guildId },
      update: values,
      create: { guildId, ...values },
    });
    return true;
  }

  if (payload.kind === 'rules') {
    // On complete un reglement vide, jamais un reglement commence : l'ordre des
    // articles et leur numerotation appartiennent a qui les a ecrits.
    const existing = await prisma.guildRegulationArticle.count({ where: { guildId } });
    if (existing > 0) return false;

    await prisma.guildRegulationArticle.createMany({
      data: payload.articles.map((article, index) => ({
        guildId,
        title: article.title,
        description: article.description,
        emoji: article.emoji,
        sortOrder: index,
      })),
    });

    const current = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { regulationChannelId: true },
    });
    if (!current?.regulationChannelId) {
      await prisma.guild.update({
        where: { id: guildId },
        data: { regulationChannelId: payload.channelId },
      });
    }
    return true;
  }

  if (payload.kind === 'ticketPanel') {
    const current = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { ticketTypes: true },
    });
    const existingTypes: Prisma.JsonArray = Array.isArray(current?.ticketTypes)
      ? (current.ticketTypes as Prisma.JsonArray)
      : [];
    const existingIds = new Set(
      existingTypes
        .map((type) => (type && typeof type === 'object' ? (type as { id?: unknown }).id : null))
        .filter((id): id is string => typeof id === 'string'),
    );

    const added = payload.types
      .filter((type) => !existingIds.has(type.id))
      .map((type) => ({
        id: type.id,
        label: type.label,
        description: type.description,
        emoji: type.emoji,
        categoryId: null,
        staffRoleId: null,
        fields: null,
      }));

    // Le panneau n'est repris que s'il n'a jamais ete touche : un titre deja
    // personnalise appartient au staff, pas a un message lu ailleurs.
    const takePanel = existingTypes.length === 0;
    if (added.length === 0 && !takePanel) return false;

    await prisma.guild.update({
      where: { id: guildId },
      data: {
        ...(added.length > 0
          ? { ticketTypes: [...existingTypes, ...added] satisfies Prisma.JsonArray }
          : {}),
        ...(takePanel
          ? {
              ticketEmbedTitle: payload.title,
              ticketEmbedDesc: payload.description,
              ticketEmbedButtonText: payload.buttonText,
              ticketEmbedType: payload.embedType,
              ...(payload.color ? { ticketEmbedColor: payload.color } : {}),
            }
          : {}),
      },
    });
    return true;
  }

  if (payload.kind === 'reactionRoles') {
    // Publier deux fois le meme menu dans le meme salon ferait de Kotbo la
    // source du desordre qu'il vient ranger.
    const existing = await prisma.reactionRoleMenu.count({
      where: { guildId, channelId: payload.channelId },
    });
    if (existing > 0) return false;

    await createReactionRoleMenu(
      guild.client,
      guildId,
      payload.channelId,
      payload.title,
      payload.options,
    );
    return true;
  }

  return false;
}

/**
 * Pose un prereglage du registre.
 *
 * Deux garde-fous, communs aux deux profils : on n'ecrase jamais une
 * configuration que le staff a deja renseignee dans Kotbo, et on ne remplace
 * jamais des sujets de tickets existants - on complete. Une reprise qui efface
 * du travail deja fait coute plus cher que la saisie qu'elle pretend eviter.
 *
 * Rend `false` quand il n'y a rien a poser : la proposition est alors comptee
 * comme ignoree, pas comme appliquee.
 */
async function applyPreset(guild: Guild, key: string): Promise<boolean> {
  const [, kind, profileKey] = key.split(':');

  if (kind === 'leveling') {
    const profile = LEVELING_PROFILES[profileKey ?? ''];
    if (!profile) return false;

    const existing = await prisma.levelConfig.findUnique({
      where: { guildId: guild.id },
      select: { enabled: true },
    });
    // Des niveaux deja actifs veulent dire une courbe deja choisie : la
    // remplacer deplacerait tous les membres d'un coup.
    if (existing?.enabled) return false;

    const values = {
      enabled: true,
      xpMin: profile.xpMin,
      xpMax: profile.xpMax,
      cooldownSeconds: profile.cooldownSeconds,
      vocalXpPerMin: profile.vocalXpPerMin,
      curveBaseXp: profile.curveBaseXp,
      curveLinearXp: profile.curveLinearXp,
      curveExponent: profile.curveExponent,
    };

    await prisma.levelConfig.upsert({
      where: { guildId: guild.id },
      update: values,
      create: { guildId: guild.id, ...values },
    });
    return true;
  }

  if (kind === 'tickets') {
    const profile = TICKET_PROFILES[profileKey ?? ''];
    if (!profile) return false;

    const current = await prisma.guild.findUnique({
      where: { id: guild.id },
      select: { ticketTypes: true },
    });
    const existingTypes: Prisma.JsonArray = Array.isArray(current?.ticketTypes)
      ? (current.ticketTypes as Prisma.JsonArray)
      : [];
    const existingIds = new Set(
      existingTypes
        .map((type) => (type && typeof type === 'object' ? (type as { id?: unknown }).id : null))
        .filter((id): id is string => typeof id === 'string'),
    );

    const added = profile.types
      .filter((type) => !existingIds.has(type.id))
      .map((type) => ({
        id: type.id,
        label: type.label,
        description: type.description,
        emoji: type.emoji,
        categoryId: null,
        staffRoleId: null,
        fields: null,
      }));

    if (added.length === 0) return false;

    await prisma.guild.update({
      where: { id: guild.id },
      data: {
        ticketTypes: [...existingTypes, ...added] satisfies Prisma.JsonArray,
        // Le panneau n'est repris que s'il n'a jamais ete touche : un titre
        // deja personnalise appartient au staff, pas au prereglage.
        ...(existingTypes.length === 0
          ? {
              ticketEmbedTitle: profile.embedTitle,
              ticketEmbedDesc: profile.embedDesc,
              ticketEmbedButtonText: profile.embedButtonText,
              ticketEmbedType: 'DROPDOWN',
            }
          : {}),
      },
    });
    return true;
  }

  return false;
}

/**
 * Pose les recompenses de niveau retrouvees dans les roles existants.
 *
 * Ne cree que ce qui manque : un niveau deja recompense par un role appartient
 * a un choix fait ici, pas a une lecture ailleurs.
 *
 * Rend `false` quand il n'y avait rien a poser : la proposition est alors
 * comptee comme ignoree, pas comme appliquee.
 */
async function applyLevelRoleRewards(guild: Guild): Promise<boolean> {
  const rewards = detectLevelRoleRewards(guild);
  if (rewards.length === 0) return false;

  const existingLevels = new Set(
    (
      await prisma.levelRoleReward.findMany({ where: { guildId: guild.id }, select: { level: true } })
    ).map((reward) => reward.level),
  );
  const added = rewards.filter((reward) => !existingLevels.has(reward.level));
  if (added.length === 0) return false;

  await prisma.levelRoleReward.createMany({
    data: added.map((reward) => ({ guildId: guild.id, level: reward.level, roleId: reward.roleId })),
  });
  return true;
}

/**
 * Pose la hierarchie de staff detectee, puis y importe les membres deja
 * porteurs de chaque role - une hierarchie sans personne dedans ne serait
 * qu'un organigramme vide.
 *
 * Ne s'applique que si le serveur n'a encore aucune hierarchie : en poser une
 * a cote de celle que le staff a deja construite dans Kotbo doublerait son
 * travail plutot que de le lui epargner.
 */
async function applyStaffLadder(guild: Guild): Promise<boolean> {
  const ladder = detectStaffLadder(guild);
  if (ladder.length === 0) return false;

  const hasHierarchy = (await prisma.staffHierarchy.count({ where: { guildId: guild.id } })) > 0;
  if (hasHierarchy) return false;

  const hierarchy = await createStaffHierarchy(guild.id, 'Repris de Discord');

  for (const [index, role] of ladder.entries()) {
    await createStaffRole(
      guild.id,
      role.roleName,
      ladder.length - index,
      role.roleId,
      role.color ?? undefined,
      hierarchy.id,
      index === 0,
    );
    await importRoleMembers(guild.id, hierarchy.id, role.roleId, role.roleName).catch(() => null);
  }

  return true;
}

/**
 * Trace le role designe comme role Membre, sans creer ni redistribuer quoi que
 * ce soit : la mise en place guidee (`serverTemplateService.ts`) et le
 * rattrapage d'acces (`memberAccessService.ts`) liront cette trace ensuite et
 * s'en tiendront a ce role, faute de quoi ils en auraient cree un autre.
 *
 * Rend `false` si le role a disparu entre le constat et l'application, ou si
 * un role Membre a ete trace entre-temps par un autre chemin - l'ecraser
 * reviendrait a remettre en cause un choix deja fait ailleurs.
 */
async function applyExistingMemberRole(guild: Guild, roleId: string | undefined): Promise<boolean> {
  if (!roleId || !guild.roles.cache.has(roleId)) return false;

  const current = await prisma.guild.findUnique({ where: { id: guild.id }, select: { serverTemplateRefs: true } });
  const refs = readServerTemplateRefs(current?.serverTemplateRefs);
  if (refs['role.member']) return false;

  await prisma.guild.update({
    where: { id: guild.id },
    data: { serverTemplateRefs: { ...refs, 'role.member': roleId } },
  });
  return true;
}

/** Colonne de la guilde a ecrire pour une proposition donnee. */
function migrationUpdateFor(key: string, channelId: string): Record<string, string> | null {
  switch (key) {
    case 'tickets.category': return { ticketCategoryId: channelId };
    case 'welcome.channel': return { publicChannelId: channelId };
    case 'logs.channel': return { logChannelId: channelId };
    default: return null;
  }
}
