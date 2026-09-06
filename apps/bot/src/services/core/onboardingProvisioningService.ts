/**
 * Ce que le parcours de configuration cree a la demande, ecran par ecran.
 *
 * La mise en place guidee (`serverTemplateService`) pose une maquette entiere,
 * une fois, au debut. Elle ne repond pas au cas qui arrive juste apres : un
 * ecran demande de designer un salon de journalisation ou des roles de staff,
 * et le serveur n'en a aucun. Jusqu'ici la seule issue etait de quitter le
 * parcours, aller creer la chose sur Discord, revenir et rafraichir - trois
 * gestes hors du produit au moment precis ou l'on essaie de le montrer.
 *
 * D'ou ces deux operations, volontairement petites : un salon, quelques roles.
 * Elles reprennent les memes garanties que la maquette - reprise par
 * identifiant enregistre, permissions verifiees avant d'agir, trace dans
 * `serverTemplateRefs` - pour qu'un salon cree ici ne soit pas double par une
 * mise en place lancee ensuite.
 *
 * Les noms viennent du dashboard et non d'ici : ce sont ceux qu'il a montres
 * en apercu, et l'apercu ne doit pas mentir. Ils sont donc traites comme des
 * entrees non fiables - longueur bornee, sauts de ligne et mentions retires -
 * avant d'atteindre Discord.
 */
import { PermissionFlagsBits, type Guild, type OverwriteResolvable } from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { errorMessage } from '../../utils/errors.js';
import type { BotLocale } from '../../utils/i18n.js';
import * as m from '../../lib/paraglide/messages.js';
import {
  type ProvisionedEntry,
  ensureRole,
  ensureTextChannel,
  missingProvisionPermissions,
} from './channelProvisioningService.js';
import { readServerTemplateRefs } from './serverTemplateService.js';

// ── Assainissement ───────────────────────────────────────────────────────────

/**
 * Un nom venu du navigateur, ramene a quelque chose qu'on peut poser sur
 * Discord.
 *
 * La route n'a aucune raison de supposer que le corps de requete vient de notre
 * interface. Sauts de ligne, mentions et enfilades d'espaces sont retires ; ce
 * qui reste est borne a la limite de Discord. Un nom vide fait echouer l'appel
 * plutot que de creer un salon sans nom.
 */
function cleanName(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>@`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  return cleaned.length > 0 ? cleaned : null;
}

/** Une couleur d'hexadecimal a entier, ou rien si elle n'en est pas une. */
function cleanColor(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  return match ? Number.parseInt(match[1], 16) : undefined;
}

// ── Salons crees a la demande ────────────────────────────────────────────────

export const ONBOARDING_CHANNEL_PURPOSES = ['logs', 'staffAlerts', 'drops'] as const;
export type OnboardingChannelPurpose = (typeof ONBOARDING_CHANNEL_PURPOSES)[number];

type ChannelBlueprint = {
  /**
   * Clef de trace. Celles qui existent dans la maquette la reutilisent : un
   * `#log` cree ici est ainsi reconnu par une mise en place lancee apres, qui
   * le reprendra au lieu d'en poser un second.
   */
  key: string;
  name: (locale: BotLocale) => string;
  /** Salon d'equipe, ferme a @everyone, ou salon ouvert aux membres. */
  audience: 'staff' | 'member';
};

const CHANNEL_BLUEPRINTS: Record<OnboardingChannelPurpose, ChannelBlueprint> = {
  logs: {
    key: 'staff.log',
    name: (l) => m.setup_template_channel_staff_logs({}, { locale: l }),
    audience: 'staff',
  },
  staffAlerts: {
    key: 'staff.alerts',
    name: (l) => m.setup_template_channel_staff_alerts({}, { locale: l }),
    audience: 'staff',
  },
  drops: {
    key: 'bots.drops',
    name: (l) => m.setup_template_channel_drops({}, { locale: l }),
    audience: 'member',
  },
};

export function isOnboardingChannelPurpose(value: unknown): value is OnboardingChannelPurpose {
  return typeof value === 'string' && (ONBOARDING_CHANNEL_PURPOSES as readonly string[]).includes(value);
}

export type OnboardingChannelResult = {
  id: string;
  name: string;
  /** Faux quand le salon existait deja : la page le dit plutot que de fanfaronner. */
  created: boolean;
};

/**
 * Cree - ou retrouve - le salon dont un ecran a besoin.
 *
 * Le salon d'equipe est ferme a @everyone et rouvert au role de staff
 * enregistre, exactement comme ceux de la maquette : un salon de journalisation
 * lisible de tous serait pire que pas de salon du tout. Il est range dans la
 * categorie du staff quand elle existe, pour ne pas trainer en tete de serveur.
 */
export async function provisionOnboardingChannel(input: {
  guild: Guild;
  locale: BotLocale;
  purpose: OnboardingChannelPurpose;
  /** Nom souhaite par la page. A defaut, celui de la maquette. */
  name?: unknown;
  auditUser: string;
}): Promise<OnboardingChannelResult> {
  const { guild, locale, purpose, auditUser } = input;
  const blueprint = CHANNEL_BLUEPRINTS[purpose];

  const missing = await missingProvisionPermissions(guild, [PermissionFlagsBits.ManageChannels]);
  if (missing.length > 0) {
    throw new Error(`Kotbo n'a pas les permissions nécessaires : ${missing.join(', ')}.`);
  }

  const config = await prisma.guild.findUnique({
    where: { id: guild.id },
    select: {
      serverTemplateRefs: true,
      baseStaffRoleId: true,
      moderatorRoleId: true,
      ticketStaffRoleId: true,
    },
  });
  const refs = readServerTemplateRefs(config?.serverTemplateRefs);

  // La categorie du staff n'existe que si la maquette est passee. Sans elle le
  // salon est cree a la racine : c'est moins range, ce n'est pas bloquant.
  const parentId = (() => {
    if (blueprint.audience !== 'staff') return null;
    const known = refs['staff.category'];
    return known && guild.channels.cache.has(known) ? known : null;
  })();

  const staffRoleId =
    [config?.baseStaffRoleId, config?.moderatorRoleId, config?.ticketStaffRoleId].find(
      (id): id is string => !!id && guild.roles.cache.has(id),
    ) ?? null;

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));

  const readWrite = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
  ];

  const overwrites: OverwriteResolvable[] =
    blueprint.audience === 'staff'
      ? [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          // Le refus pose sur @everyone vaut aussi pour le bot des lors qu'il
          // n'est pas administrateur : sans cette surcharge, il ne verrait pas
          // le salon qu'il vient de creer.
          ...(me ? [{ id: me.id, allow: readWrite }] : []),
          ...(staffRoleId ? [{ id: staffRoleId, allow: readWrite }] : []),
        ]
      : [];

  const { entry } = await ensureTextChannel(guild, {
    key: blueprint.key,
    existingId: refs[blueprint.key],
    name: cleanName(input.name, 90) ?? blueprint.name(locale),
    parentId,
    permissionOverwrites: overwrites.length > 0 ? overwrites : undefined,
    reason: m.setup_reason_template({ user: auditUser }, { locale }),
  });

  await rememberRefs(guild.id, { [blueprint.key]: entry.id });

  return { id: entry.id, name: entry.name, created: entry.created };
}

// ── Roles crees a la demande ─────────────────────────────────────────────────

/**
 * Ce qu'un role peut faire, en quelques echelons plutot qu'en bitfield.
 *
 * La page envoie un echelon, pas une liste de permissions : elle n'a aucune
 * raison de composer un masque de bits, et lui laisser cette liberte
 * reviendrait a accepter du navigateur la definition exacte des pouvoirs crees
 * sur le serveur. La traduction se fait ici, une fois.
 */
export const STAFF_ROLE_POWERS = ['admin', 'manage', 'moderate', 'coordinate', 'assist', 'none'] as const;
export type StaffRolePower = (typeof STAFF_ROLE_POWERS)[number];

const POWER_PERMISSIONS: Record<StaffRolePower, bigint[]> = {
  admin: [PermissionFlagsBits.Administrator],
  manage: [
    PermissionFlagsBits.ManageGuild,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ManageNicknames,
    PermissionFlagsBits.ManageEvents,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.ViewAuditLog,
    PermissionFlagsBits.MuteMembers,
    PermissionFlagsBits.DeafenMembers,
    PermissionFlagsBits.MoveMembers,
  ],
  moderate: [
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ManageNicknames,
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.ViewAuditLog,
    PermissionFlagsBits.MuteMembers,
    PermissionFlagsBits.MoveMembers,
  ],
  coordinate: [
    PermissionFlagsBits.ManageEvents,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.MentionEveryone,
    PermissionFlagsBits.MuteMembers,
    PermissionFlagsBits.MoveMembers,
  ],
  assist: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ModerateMembers],
  none: [],
};

export function isStaffRolePower(value: unknown): value is StaffRolePower {
  return typeof value === 'string' && (STAFF_ROLE_POWERS as readonly string[]).includes(value);
}

export type OnboardingRoleRequest = {
  /** Identifiant de trace, propre a la page : `staff.lead`, `level.3`… */
  key: string;
  name: string;
  color?: string;
  hoist?: boolean;
  power?: StaffRolePower;
};

export type OnboardingRoleResult = ProvisionedEntry & { color: string | null };

export type OnboardingRolesResult = {
  roles: OnboardingRoleResult[];
  /** Ce qui n'a pas pu etre accorde, dit plutot que passe sous silence. */
  warnings: string[];
};

/** Au-dela, ce n'est plus une hierarchie proposee mais un import de serveur. */
const MAX_ROLES_PER_CALL = 15;

export function parseRoleRequests(value: unknown): OnboardingRoleRequest[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const parsed: OnboardingRoleRequest[] = [];

  for (const raw of value.slice(0, MAX_ROLES_PER_CALL)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    const key = cleanName(entry.key, 60);
    const name = cleanName(entry.name, 100);
    if (!key || !name || seen.has(key)) continue;
    seen.add(key);
    parsed.push({
      key,
      name,
      color: typeof entry.color === 'string' ? entry.color : undefined,
      hoist: entry.hoist === true,
      power: isStaffRolePower(entry.power) ? entry.power : 'none',
    });
  }

  return parsed;
}

/**
 * Cree une hierarchie de roles, du plus haut au plus bas.
 *
 * L'ordre compte et n'est pas cosmetique : Discord place chaque role cree juste
 * au-dessus de `@everyone` et repousse les precedents d'un cran. Commencer par
 * le sommet laisse donc la hierarchie dans le bon sens sans avoir a la
 * reordonner ensuite - un appel REST de moins par role, et aucun moment ou le
 * serveur porte une hierarchie inversee.
 *
 * Un role ne peut pas recevoir une permission que le bot n'a pas lui-meme :
 * Discord refuserait la creation entiere. On intersecte donc avec ce que le bot
 * detient, et l'on dit ce qui a saute - un « Fondateur » sans les pleins
 * pouvoirs est utilisable, un ecran qui ne le signale pas ne l'est pas.
 */
export async function provisionOnboardingRoles(input: {
  guild: Guild;
  locale: BotLocale;
  roles: OnboardingRoleRequest[];
  auditUser: string;
}): Promise<OnboardingRolesResult> {
  const { guild, locale, roles, auditUser } = input;

  const missing = await missingProvisionPermissions(guild, [PermissionFlagsBits.ManageRoles]);
  if (missing.length > 0) {
    throw new Error(`Kotbo n'a pas les permissions nécessaires : ${missing.join(', ')}.`);
  }

  const me = guild.members.me ?? (await guild.members.fetchMe().catch(() => null));
  if (!me) throw new Error("Kotbo n'est plus membre de ce serveur.");

  const config = await prisma.guild.findUnique({
    where: { id: guild.id },
    select: { serverTemplateRefs: true },
  });
  const knownRefs = readServerTemplateRefs(config?.serverTemplateRefs);

  const reason = m.setup_reason_template({ user: auditUser }, { locale });
  const created: OnboardingRoleResult[] = [];
  const warnings: string[] = [];
  const trimmed: string[] = [];

  for (const request of roles) {
    const wanted = POWER_PERMISSIONS[request.power ?? 'none'];
    const granted = wanted.filter((flag) => me.permissions.has(flag));
    if (granted.length < wanted.length) trimmed.push(request.name);

    try {
      const { role, entry } = await ensureRole(guild, {
        key: request.key,
        existingId: knownRefs[request.key],
        name: request.name,
        color: cleanColor(request.color),
        hoist: request.hoist,
        permissions: granted,
        reason,
      });
      created.push({ ...entry, color: role.hexColor ?? null });
      // Ecrit au fil de l'eau : une coupure a mi-parcours ne doit pas laisser
      // des roles sans trace, qu'un second essai recreerait a l'identique.
      await rememberRefs(guild.id, { [request.key]: role.id });
    } catch (err) {
      logger.error(
        'OnboardingProvisioning',
        `Role "${request.name}" failed on ${guild.id}: ${errorMessage(err)}`,
      );
      warnings.push(`Le rôle « ${request.name} » n'a pas pu être créé.`);
    }
  }

  if (trimmed.length > 0) {
    warnings.push(
      `Kotbo ne détient pas lui-même toutes les permissions demandées : ${trimmed.join(', ')} ${trimmed.length > 1 ? 'ont' : 'a'} été créé${trimmed.length > 1 ? 's' : ''} avec ce qu'il pouvait accorder. Complétez depuis les paramètres du serveur.`,
    );
  }

  return { roles: created, warnings };
}

/**
 * Ajoute des identifiants a la trace de la guilde, sans ecraser le reste.
 *
 * Meme trace que la mise en place : c'est elle qui permet a une maquette posee
 * plus tard de reprendre ce qui a ete cree ici plutot que de le doubler.
 */
async function rememberRefs(guildId: string, added: Record<string, string>): Promise<void> {
  try {
    const row = await prisma.guild.findUnique({
      where: { id: guildId },
      select: { serverTemplateRefs: true },
    });
    await prisma.guild.upsert({
      where: { id: guildId },
      update: { serverTemplateRefs: { ...readServerTemplateRefs(row?.serverTemplateRefs), ...added } },
      create: { id: guildId, serverTemplateRefs: added },
    });
  } catch (err) {
    // La trace est un confort de reprise, pas une condition de reussite : le
    // salon ou le role existe deja sur Discord, echouer ici le ferait
    // disparaitre de l'ecran alors qu'il est bien la.
    logger.warn('OnboardingProvisioning', `Refs not stored for ${guildId}: ${errorMessage(err)}`);
  }
}
