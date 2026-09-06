/**
 * securityAuditService.ts - Audit de sécurité complet d'un serveur.
 *
 * L'audit parcourt huit familles de contrôles (DISCORD, PERMISSIONS, BOTS,
 * WEBHOOKS, INVITES, MODULES, BOT_PERMS, HYGIENE) et produit :
 *   - un score global 0-100 et une note A-F ;
 *   - un sous-score par catégorie (pour la vue radar du dashboard) ;
 *   - des constats typés, avec les entités concernées (rôles, salons, membres) ;
 *   - quand c'est possible, un descripteur de correctif applicable en un clic.
 *
 * Chaque contrôle est isolé : une permission manquante côté bot dégrade le
 * contrôle concerné (listé dans `degraded`) sans faire échouer l'audit entier.
 */

import {
  type Guild,
  type GuildMember,
  type Role,
  GuildVerificationLevel,
  GuildExplicitContentFilter,
  GuildMFALevel,
  GuildDefaultMessageNotifications,
  AutoModerationRuleTriggerType,
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { getCachedGuild } from '../../utils/cache.js';
import { getRaidProtectionConfig } from './raidProtectionService.js';

// ─── Types ──────────────────────────────────────────────────────────────────────

export type AuditSeverity = 'CRITICAL' | 'WARNING' | 'INFO' | 'OK';

export type AuditCategory =
  | 'DISCORD'
  | 'PERMISSIONS'
  | 'BOTS'
  | 'WEBHOOKS'
  | 'INVITES'
  | 'MODULES'
  | 'BOT_PERMS'
  | 'HYGIENE';

export type AuditEntityType = 'role' | 'channel' | 'member' | 'bot' | 'webhook' | 'invite';

export type AuditEntity = { id: string; name: string; type: AuditEntityType; detail?: string };

/**
 * Correctif applicable automatiquement. `risky` marque les correctifs qui
 * modifient des permissions existantes : le dashboard demande confirmation.
 */
export type AuditFix = {
  action:
    | 'enable_raid_module'
    | 'enable_automod_module'
    | 'enable_guild_module'
    | 'discord_setting'
    | 'strip_everyone_permissions'
    | 'unmention_roles'
    | 'disable_widget';
  label: string;
  payload?: Record<string, unknown>;
  risky?: boolean;
};

/**
 * Renvoi vers la page qui permet de traiter le constat a la main. Sert aux
 * constats qui demandent une decision humaine plutot qu'un correctif : les
 * annoncer sans donner le chemin obligeait a chercher la page soi-meme.
 * `href` est une route interne du dashboard, jamais une URL externe.
 */
export type AuditLink = {
  href: string;
  label: string;
};

export type AuditFinding = {
  /** Identifiant stable, utilisé par l'UI pour cibler un correctif. */
  id: string;
  category: AuditCategory;
  severity: AuditSeverity;
  title: string;
  detail: string;
  recommendation?: string;
  /** Points retirés du score global (0 pour les constats OK). */
  weight: number;
  entities?: AuditEntity[];
  fix?: AuditFix;
  link?: AuditLink;
};

export type AuditCategoryScore = {
  category: AuditCategory;
  label: string;
  score: number;
  lost: number;
  max: number;
  counts: { critical: number; warning: number; info: number; ok: number };
};

export type SecurityAuditResult = {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  categories: AuditCategoryScore[];
  findings: AuditFinding[];
  /** Contrôles qui n'ont pas pu tourner (permission manquante, serveur trop gros…). */
  degraded: string[];
  stats: {
    memberCount: number;
    roleCount: number;
    channelCount: number;
    botCount: number;
    webhookCount: number | null;
    inviteCount: number | null;
    adminMemberCount: number;
    nativeAutoModRules: number | null;
  };
  generatedAt: string;
  durationMs: number;
};

export type AuditOptions = {
  /**
   * Contrôles nécessitant la liste complète des membres (admins dormants,
   * admins hors staff…). Coûteux sur les gros serveurs.
   */
  deep?: boolean;
};

export const CATEGORY_LABELS: Record<AuditCategory, string> = {
  DISCORD: 'Configuration Discord',
  PERMISSIONS: 'Permissions & rôles',
  BOTS: 'Bots & intégrations',
  WEBHOOKS: 'Webhooks',
  INVITES: 'Invitations',
  MODULES: 'Modules Kotbo',
  BOT_PERMS: 'Permissions du bot',
  HYGIENE: 'Hygiène du serveur',
};

/** Budget de points par catégorie (sert au sous-score). */
const CATEGORY_MAX: Record<AuditCategory, number> = {
  DISCORD: 45,
  PERMISSIONS: 60,
  BOTS: 30,
  WEBHOOKS: 20,
  INVITES: 20,
  MODULES: 55,
  BOT_PERMS: 30,
  HYGIENE: 15,
};

/** Au-delà de ce nombre de membres, les contrôles « deep » sont désactivés. */
const DEEP_MEMBER_LIMIT = 25_000;
/** Un admin sans aucune activité depuis ce délai est considéré comme dormant. */
const DORMANT_ADMIN_DAYS = 90;

const DANGEROUS_PERMISSIONS = [
  { flag: PermissionFlagsBits.Administrator, label: 'Administrateur', critical: true },
  { flag: PermissionFlagsBits.ManageGuild, label: 'Gérer le serveur', critical: true },
  { flag: PermissionFlagsBits.ManageRoles, label: 'Gérer les rôles', critical: true },
  { flag: PermissionFlagsBits.ManageChannels, label: 'Gérer les salons', critical: true },
  { flag: PermissionFlagsBits.ManageWebhooks, label: 'Gérer les webhooks', critical: true },
  { flag: PermissionFlagsBits.ManageGuildExpressions, label: 'Gérer les expressions', critical: false },
  { flag: PermissionFlagsBits.BanMembers, label: 'Bannir des membres', critical: true },
  { flag: PermissionFlagsBits.KickMembers, label: 'Expulser des membres', critical: true },
  { flag: PermissionFlagsBits.ModerateMembers, label: 'Exclure temporairement', critical: false },
  { flag: PermissionFlagsBits.ManageMessages, label: 'Gérer les messages', critical: false },
  { flag: PermissionFlagsBits.ManageThreads, label: 'Gérer les fils', critical: false },
  { flag: PermissionFlagsBits.MentionEveryone, label: 'Mentionner @everyone', critical: false },
  { flag: PermissionFlagsBits.ManageEvents, label: 'Gérer les événements', critical: false },
  { flag: PermissionFlagsBits.MoveMembers, label: 'Déplacer des membres', critical: false },
] as const;

// ─── Collecteur ─────────────────────────────────────────────────────────────────

class AuditCollector {
  readonly findings: AuditFinding[] = [];
  readonly degraded: string[] = [];

  add(finding: AuditFinding): void {
    this.findings.push(finding);
  }

  /** Constat conforme : poids 0, sert à afficher ce qui va bien. */
  ok(id: string, category: AuditCategory, title: string, detail: string): void {
    this.findings.push({ id, category, severity: 'OK', title, detail, weight: 0 });
  }

  skip(label: string): void {
    this.degraded.push(label);
  }
}

function grade(score: number): SecurityAuditResult['grade'] {
  if (score >= 90) return 'A';
  if (score >= 78) return 'B';
  if (score >= 64) return 'C';
  if (score >= 50) return 'D';
  if (score >= 35) return 'E';
  return 'F';
}

function entityFromRole(role: Role): AuditEntity {
  return { id: role.id, name: role.name, type: 'role' };
}

function listNames(names: string[], max = 6): string {
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown} … (+${names.length - max})` : shown;
}

// ─── DISCORD : configuration native du serveur ─────────────────────────────────

async function checkDiscordSettings(guild: Guild, c: AuditCollector): Promise<number | null> {
  // Niveau de vérification
  if (guild.verificationLevel <= GuildVerificationLevel.Low) {
    c.add({
      id: 'discord.verification_level',
      category: 'DISCORD',
      severity: 'CRITICAL',
      title: 'Niveau de vérification trop bas',
      detail: `Le niveau de vérification est **${GuildVerificationLevel[guild.verificationLevel]}** : un compte tout juste créé peut écrire immédiatement.`,
      recommendation: 'Passer au moins en « Moyen » (compte Discord vérifié depuis 5 minutes).',
      weight: 10,
      fix: { action: 'discord_setting', label: 'Passer en niveau Moyen', payload: { setting: 'verificationLevel', value: GuildVerificationLevel.Medium } },
    });
  } else {
    c.ok('discord.verification_level', 'DISCORD', 'Niveau de vérification', `Niveau **${GuildVerificationLevel[guild.verificationLevel]}**.`);
  }

  // 2FA modération
  if (guild.mfaLevel === GuildMFALevel.None) {
    c.add({
      id: 'discord.mfa',
      category: 'DISCORD',
      severity: 'CRITICAL',
      title: '2FA non requise pour la modération',
      detail: 'Un compte modérateur compromis peut bannir, supprimer des salons ou modifier les rôles sans obstacle.',
      recommendation: 'Paramètres du serveur → Sécurité → exiger la 2FA. Action réservée au propriétaire.',
      weight: 10,
    });
  } else {
    c.ok('discord.mfa', 'DISCORD', '2FA modération', 'La 2FA est exigée pour les actions de modération.');
  }

  // Filtre de contenu explicite
  if (guild.explicitContentFilter !== GuildExplicitContentFilter.AllMembers) {
    c.add({
      id: 'discord.explicit_filter',
      category: 'DISCORD',
      severity: 'WARNING',
      title: 'Filtre de contenu explicite incomplet',
      detail: `Réglage actuel : **${GuildExplicitContentFilter[guild.explicitContentFilter]}**. Les médias explicites ne sont pas analysés pour tous les membres.`,
      recommendation: 'Paramètres → Modération → analyser les médias de tous les membres.',
      weight: 4,
      fix: { action: 'discord_setting', label: 'Analyser tous les médias', payload: { setting: 'explicitContentFilter', value: GuildExplicitContentFilter.AllMembers } },
    });
  } else {
    c.ok('discord.explicit_filter', 'DISCORD', 'Filtre de contenu explicite', 'Tous les médias sont analysés.');
  }

  // Notifications par défaut : ALL_MESSAGES amplifie tout spam
  if (guild.defaultMessageNotifications === GuildDefaultMessageNotifications.AllMessages) {
    c.add({
      id: 'discord.default_notifications',
      category: 'DISCORD',
      severity: 'INFO',
      title: 'Notifications par défaut sur « Tous les messages »',
      detail: 'Chaque message notifie tous les membres qui n\'ont pas changé le réglage : un spam devient immédiatement massif.',
      recommendation: 'Passer sur « Mentions uniquement ».',
      weight: 2,
      fix: { action: 'discord_setting', label: 'Mentions uniquement', payload: { setting: 'defaultMessageNotifications', value: GuildDefaultMessageNotifications.OnlyMentions } },
    });
  }

  // Widget : expose membres en ligne + invitation instantanée
  if (guild.widgetEnabled) {
    c.add({
      id: 'discord.widget',
      category: 'DISCORD',
      severity: 'INFO',
      title: 'Widget serveur activé',
      detail: 'Le widget expose publiquement la liste des membres en ligne et génère une invitation permanente.',
      recommendation: 'Le désactiver s\'il n\'est pas utilisé sur un site externe.',
      weight: 3,
      fix: { action: 'disable_widget', label: 'Désactiver le widget' },
    });
  }

  // Vanity URL : cible classique de détournement
  if (guild.vanityURLCode) {
    c.add({
      id: 'discord.vanity_url',
      category: 'DISCORD',
      severity: 'INFO',
      title: 'URL personnalisée active',
      detail: `Le serveur utilise \`discord.gg/${guild.vanityURLCode}\`. Une prise de contrôle du serveur permet de la voler définitivement.`,
      recommendation: 'Vérifier que « Gérer le serveur » est restreint à un minimum de rôles et surveiller les logs.',
      weight: 1,
    });
  }

  // Écran d'accueil / règles
  if (guild.features.includes('COMMUNITY') && !guild.rulesChannelId) {
    c.add({
      id: 'discord.rules_channel',
      category: 'DISCORD',
      severity: 'INFO',
      title: 'Aucun salon de règles défini',
      detail: 'Le serveur est en mode Communauté mais aucun salon de règles n\'est déclaré.',
      recommendation: 'Définir un salon de règles pour activer l\'écran d\'accueil.',
      weight: 2,
    });
  }

  // AutoMod natif de Discord
  let nativeRuleCount: number | null = null;
  try {
    const rules = await guild.autoModerationRules.fetch();
    nativeRuleCount = rules.size;
    const enabled = rules.filter((r) => r.enabled);

    if (enabled.size === 0) {
      c.add({
        id: 'discord.automod_rules',
        category: 'DISCORD',
        severity: 'WARNING',
        title: 'Aucune règle AutoMod native active',
        detail: 'L\'AutoMod de Discord bloque les messages avant leur envoi, sans latence. Aucune règle n\'est active.',
        recommendation: 'Activer les filtres depuis le module AutoMod de Kotbo (ils sont synchronisés vers Discord).',
        weight: 6,
        fix: { action: 'enable_automod_module', label: 'Activer le filtre de profanités', payload: { field: 'profanityEnabled' } },
      });
    } else {
      c.ok('discord.automod_rules', 'DISCORD', 'AutoMod natif', `${enabled.size} règle(s) active(s) sur ${rules.size}.`);
    }

    const hasMentionSpam = enabled.some((r) => r.triggerType === AutoModerationRuleTriggerType.MentionSpam);
    if (!hasMentionSpam) {
      c.add({
        id: 'discord.automod_mention_raid',
        category: 'DISCORD',
        severity: 'WARNING',
        title: 'Protection anti-raid de mentions absente',
        detail: 'Aucune règle AutoMod ne limite le nombre de mentions par message : c\'est le vecteur de raid de mentions le plus courant.',
        recommendation: 'Activer la limite de mentions dans le module AutoMod.',
        weight: 5,
        fix: { action: 'enable_automod_module', label: 'Activer la limite de mentions', payload: { field: 'mentionsEnabled' } },
      });
    }
  } catch {
    c.skip('Règles AutoMod natives (permission « Gérer le serveur » manquante)');
  }

  return nativeRuleCount;
}

// ─── PERMISSIONS : rôles, @everyone, overwrites ────────────────────────────────

function checkPermissions(guild: Guild, c: AuditCollector): { adminRoles: Role[] } {
  const everyone = guild.roles.everyone;

  // @everyone : permissions dangereuses
  const everyoneDangerous = DANGEROUS_PERMISSIONS.filter((p) => everyone.permissions.has(p.flag));
  if (everyoneDangerous.length > 0) {
    const hasCritical = everyoneDangerous.some((p) => p.critical);
    c.add({
      id: 'permissions.everyone_dangerous',
      category: 'PERMISSIONS',
      severity: hasCritical ? 'CRITICAL' : 'WARNING',
      title: 'Permissions dangereuses accordées à @everyone',
      detail: `@everyone possède : ${everyoneDangerous.map((p) => `**${p.label}**`).join(', ')}. N'importe quel membre - y compris un compte de raid - en hérite.`,
      recommendation: 'Retirer ces permissions de @everyone et les accorder par rôle.',
      weight: hasCritical ? 18 : 6,
      fix: {
        action: 'strip_everyone_permissions',
        label: 'Retirer ces permissions de @everyone',
        payload: { permissions: everyoneDangerous.map((p) => p.label) },
        risky: true,
      },
    });
  } else {
    c.ok('permissions.everyone_dangerous', 'PERMISSIONS', 'Permissions @everyone', 'Aucune permission sensible sur @everyone.');
  }

  // Rôles Administrateur
  const adminRoles = [...guild.roles.cache.values()].filter(
    (r) => r.permissions.has(PermissionFlagsBits.Administrator) && !r.managed && r.id !== guild.id
  );
  const adminHolders = new Set(adminRoles.flatMap((r) => [...r.members.keys()]));

  if (adminRoles.length > 3) {
    c.add({
      id: 'permissions.admin_roles',
      category: 'PERMISSIONS',
      severity: 'WARNING',
      title: 'Trop de rôles Administrateur',
      detail: `**${adminRoles.length} rôles** portent la permission Administrateur (${adminHolders.size} détenteurs). Chacun est un point de compromission totale.`,
      recommendation: 'Limiter à 1-2 rôles de confiance et découper le reste en permissions granulaires.',
      weight: 8,
      entities: adminRoles.map(entityFromRole),
    });
  } else {
    c.ok('permissions.admin_roles', 'PERMISSIONS', 'Rôles Administrateur', `${adminRoles.length} rôle(s) admin, ${adminHolders.size} détenteur(s).`);
  }

  // Rôles sensibles mentionnables par tous
  const mentionableDangerous = [...guild.roles.cache.values()].filter(
    (r) => r.mentionable && r.id !== guild.id && DANGEROUS_PERMISSIONS.some((p) => p.critical && r.permissions.has(p.flag))
  );
  if (mentionableDangerous.length > 0) {
    c.add({
      id: 'permissions.mentionable_privileged',
      category: 'PERMISSIONS',
      severity: 'WARNING',
      title: 'Rôles privilégiés mentionnables par tout le monde',
      detail: `${listNames(mentionableDangerous.map((r) => r.name))}. Ces rôles sont une cible directe de harcèlement et de ping-spam.`,
      recommendation: 'Désactiver « Autoriser tout le monde à mentionner ce rôle ».',
      weight: 4,
      entities: mentionableDangerous.map(entityFromRole),
      fix: { action: 'unmention_roles', label: 'Rendre ces rôles non mentionnables', payload: { roleIds: mentionableDangerous.map((r) => r.id) } },
    });
  }

  // Rôles privilégiés sans aucun détenteur : surface d'attaque dormante
  const orphanPrivileged = [...guild.roles.cache.values()].filter(
    (r) =>
      !r.managed &&
      r.id !== guild.id &&
      r.members.size === 0 &&
      DANGEROUS_PERMISSIONS.some((p) => p.critical && r.permissions.has(p.flag))
  );
  if (orphanPrivileged.length > 0) {
    c.add({
      id: 'permissions.orphan_privileged_roles',
      category: 'PERMISSIONS',
      severity: 'INFO',
      title: 'Rôles privilégiés sans détenteur',
      detail: `${listNames(orphanPrivileged.map((r) => r.name))}. Un rôle vide mais puissant est une cible discrète : l'attribuer passe souvent inaperçu.`,
      recommendation: 'Supprimer ces rôles ou leur retirer les permissions sensibles.',
      weight: 3,
      entities: orphanPrivileged.map(entityFromRole),
    });
  }

  // Overwrites de salon accordant des permissions dangereuses à @everyone
  const leakyChannels: AuditEntity[] = [];
  for (const channel of guild.channels.cache.values()) {
    // Les fils héritent des permissions de leur salon parent : pas d'overwrites propres.
    if (!('permissionOverwrites' in channel)) continue;
    const overwrite = channel.permissionOverwrites.cache.get(guild.id);
    if (!overwrite) continue;
    const granted = DANGEROUS_PERMISSIONS.filter((p) => p.critical && overwrite.allow.has(p.flag));
    if (granted.length > 0) {
      leakyChannels.push({
        id: channel.id,
        name: channel.name,
        type: 'channel',
        detail: granted.map((p) => p.label).join(', '),
      });
    }
  }
  if (leakyChannels.length > 0) {
    c.add({
      id: 'permissions.channel_overwrites',
      category: 'PERMISSIONS',
      severity: 'CRITICAL',
      title: 'Salons accordant des permissions sensibles à @everyone',
      detail: `${leakyChannels.length} salon(s) surchargent les permissions de @everyone : ${listNames(leakyChannels.map((e) => `#${e.name} (${e.detail})`), 4)}.`,
      recommendation: 'Revoir les permissions de ces salons : une surcharge de salon prime sur le rôle.',
      weight: 12,
      entities: leakyChannels,
    });
  } else {
    c.ok('permissions.channel_overwrites', 'PERMISSIONS', 'Surcharges de salon', 'Aucune surcharge dangereuse pour @everyone.');
  }

  // Hiérarchie du bot
  const me = guild.members.me;
  if (me) {
    const botPosition = me.roles.highest.position;
    const rolesAbove = [...guild.roles.cache.values()].filter((r) => r.position > botPosition && r.id !== guild.id && !r.managed);
    const membersUnreachable = new Set(rolesAbove.flatMap((r) => [...r.members.keys()])).size;
    if (rolesAbove.length > 5) {
      c.add({
        id: 'permissions.bot_hierarchy',
        category: 'PERMISSIONS',
        severity: membersUnreachable > 0 ? 'WARNING' : 'INFO',
        title: 'Rôle du bot trop bas dans la hiérarchie',
        detail: `${rolesAbove.length} rôles sont au-dessus de Kotbo (${membersUnreachable} membres concernés) : il ne peut ni les sanctionner ni gérer leurs rôles.`,
        recommendation: 'Remonter le rôle du bot juste sous le rôle du propriétaire.',
        weight: membersUnreachable > 0 ? 6 : 2,
        entities: rolesAbove.slice(0, 10).map(entityFromRole),
      });
    } else {
      c.ok('permissions.bot_hierarchy', 'PERMISSIONS', 'Hiérarchie du bot', 'Le bot est suffisamment haut pour modérer.');
    }
  }

  return { adminRoles };
}

// ─── PERMISSIONS (deep) : membres admin ────────────────────────────────────────

async function checkAdminMembers(
  guild: Guild,
  members: Map<string, GuildMember>,
  c: AuditCollector
): Promise<number> {
  const admins = [...members.values()].filter((m) => !m.user.bot && m.permissions.has(PermissionFlagsBits.Administrator));
  if (admins.length === 0) return 0;

  // Admins hors staff déclaré dans Kotbo
  const guildConfig = (await getCachedGuild(guild.id)) as
    | { moderatorRoleId?: string | null; baseStaffRoleId?: string | null; testStaffRoleId?: string | null }
    | null;
  const staffRoleIds = [guildConfig?.moderatorRoleId, guildConfig?.baseStaffRoleId, guildConfig?.testStaffRoleId].filter(
    (id): id is string => Boolean(id)
  );

  if (staffRoleIds.length > 0) {
    const unknownAdmins = admins.filter(
      (m) => m.id !== guild.ownerId && !staffRoleIds.some((roleId) => m.roles.cache.has(roleId))
    );
    if (unknownAdmins.length > 0) {
      c.add({
        id: 'permissions.admins_outside_staff',
        category: 'PERMISSIONS',
        severity: 'WARNING',
        title: 'Administrateurs hors du staff déclaré',
        detail: `${unknownAdmins.length} membre(s) sont administrateurs sans porter de rôle staff Kotbo : ${listNames(unknownAdmins.map((m) => m.user.username), 5)}.`,
        recommendation: 'Soit les intégrer au staff (pour qu\'ils apparaissent dans les logs et évaluations), soit leur retirer la permission.',
        weight: 6,
        entities: unknownAdmins.slice(0, 10).map((m) => ({ id: m.id, name: m.user.username, type: 'member' as const })),
      });
    }
  }

  // Admins dormants : compte privilégié inutilisé = compte à voler
  try {
    const cutoff = new Date(Date.now() - DORMANT_ADMIN_DAYS * 24 * 60 * 60 * 1000);
    const profiles = await prisma.memberProfile.findMany({
      where: { guildId: guild.id, userId: { in: admins.map((m) => m.id) } },
      select: { userId: true, lastMessageAt: true, lastSeenAt: true },
    });
    const profileByUser = new Map(profiles.map((p) => [p.userId, p]));
    const dormant = admins.filter((m) => {
      if (m.id === guild.ownerId) return false;
      const p = profileByUser.get(m.id);
      if (!p) return false;
      const last = p.lastMessageAt ?? p.lastSeenAt;
      return last != null && last < cutoff;
    });

    if (dormant.length > 0) {
      c.add({
        id: 'permissions.dormant_admins',
        category: 'PERMISSIONS',
        severity: 'WARNING',
        title: 'Comptes administrateurs dormants',
        detail: `${dormant.length} administrateur(s) n'ont aucune activité depuis plus de ${DORMANT_ADMIN_DAYS} jours : ${listNames(dormant.map((m) => m.user.username), 5)}. Un compte privilégié inactif est la cible idéale d'un vol de session.`,
        recommendation: 'Retirer les permissions des comptes inactifs - elles se réattribuent en dix secondes au retour.',
        weight: 6,
        entities: dormant.slice(0, 10).map((m) => ({ id: m.id, name: m.user.username, type: 'member' as const })),
      });
    } else {
      c.ok('permissions.dormant_admins', 'PERMISSIONS', 'Administrateurs actifs', 'Aucun compte administrateur dormant.');
    }
  } catch (err) {
    logger.debug('SecurityAudit', `Contrôle des admins dormants impossible: ${String(err)}`);
    c.skip('Administrateurs dormants (données de profil indisponibles)');
  }

  return admins.length;
}

// ─── BOTS ───────────────────────────────────────────────────────────────────────

function checkBots(guild: Guild, members: Map<string, GuildMember> | null, c: AuditCollector, antiBotEnabled: boolean): number {
  const bots = members
    ? [...members.values()].filter((m) => m.user.bot)
    : [...guild.members.cache.values()].filter((m) => m.user.bot);

  const adminBots = bots.filter((b) => b.id !== guild.members.me?.id && b.permissions.has(PermissionFlagsBits.Administrator));
  if (adminBots.length > 0) {
    c.add({
      id: 'bots.admin_bots',
      category: 'BOTS',
      severity: 'CRITICAL',
      title: 'Bots avec la permission Administrateur',
      detail: `${adminBots.length} bot(s) sont administrateurs : ${listNames(adminBots.map((b) => b.user.username), 5)}. Une compromission de leur éditeur ou de leur token détruit le serveur.`,
      recommendation: 'Remplacer Administrateur par les permissions réellement nécessaires à chaque bot.',
      weight: 12,
      entities: adminBots.map((b) => ({ id: b.id, name: b.user.username, type: 'bot' as const })),
    });
  } else {
    c.ok('bots.admin_bots', 'BOTS', 'Bots privilégiés', 'Aucun bot tiers n\'est administrateur.');
  }

  const dangerousBots = bots.filter(
    (b) =>
      b.id !== guild.members.me?.id &&
      !b.permissions.has(PermissionFlagsBits.Administrator) &&
      (b.permissions.has(PermissionFlagsBits.ManageGuild) ||
        b.permissions.has(PermissionFlagsBits.ManageWebhooks) ||
        b.permissions.has(PermissionFlagsBits.ManageRoles))
  );
  if (dangerousBots.length > 0) {
    c.add({
      id: 'bots.privileged_bots',
      category: 'BOTS',
      severity: 'WARNING',
      title: 'Bots aux permissions étendues',
      detail: `${dangerousBots.length} bot(s) peuvent gérer le serveur, les rôles ou les webhooks : ${listNames(dangerousBots.map((b) => b.user.username), 5)}.`,
      recommendation: 'Auditer ces permissions : « Gérer les webhooks » suffit à contourner tout l\'AutoMod.',
      weight: 5,
      entities: dangerousBots.map((b) => ({ id: b.id, name: b.user.username, type: 'bot' as const })),
    });
  }

  if (bots.length > 15) {
    c.add({
      id: 'bots.count',
      category: 'BOTS',
      severity: 'INFO',
      title: 'Nombre de bots élevé',
      detail: `${bots.length} bots sont présents. Chaque bot est une surface d'attaque supplémentaire et un risque de fuite de données.`,
      recommendation: 'Retirer les bots redondants ou inutilisés.',
      weight: 3,
    });
  }

  if (!antiBotEnabled) {
    c.add({
      id: 'bots.antibot_disabled',
      category: 'BOTS',
      severity: 'WARNING',
      title: 'Protection anti-ajout de bot désactivée',
      detail: 'N\'importe quel membre disposant de « Gérer le serveur » peut ajouter un bot malveillant sans alerte.',
      recommendation: 'Activer l\'anti-bot du module AutoMod : tout bot ajouté hors liste blanche est expulsé.',
      weight: 6,
      fix: { action: 'enable_automod_module', label: 'Activer l\'anti-bot', payload: { field: 'antiBotEnabled' } },
    });
  } else {
    c.ok('bots.antibot_disabled', 'BOTS', 'Anti-ajout de bot', 'Les ajouts de bots non autorisés sont bloqués.');
  }

  return bots.length;
}

// ─── WEBHOOKS ───────────────────────────────────────────────────────────────────

async function checkWebhooks(guild: Guild, c: AuditCollector, inviteGuardEnabled: boolean): Promise<number | null> {
  try {
    const webhooks = await guild.fetchWebhooks();
    const count = webhooks.size;

    if (count === 0) {
      c.ok('webhooks.count', 'WEBHOOKS', 'Webhooks', 'Aucun webhook enregistré.');
      return 0;
    }

    // Un webhook contourne intégralement l'AutoMod : il poste sans passer par un compte.
    if (count > 10) {
      c.add({
        id: 'webhooks.count',
        category: 'WEBHOOKS',
        severity: 'WARNING',
        title: 'Nombre de webhooks élevé',
        detail: `${count} webhooks existent. Une URL de webhook fuitée permet de poster dans le salon sans compte, sans passer par l'AutoMod.`,
        recommendation: 'Supprimer les webhooks inutilisés et faire tourner les URLs des webhooks restants.',
        weight: 6,
      });
    } else {
      c.ok('webhooks.count', 'WEBHOOKS', 'Webhooks', `${count} webhook(s) enregistré(s).`);
    }

    // Webhooks dans des salons visibles de @everyone
    const publicWebhooks = webhooks.filter((w) => {
      const channel = w.channelId ? guild.channels.cache.get(w.channelId) : null;
      if (!channel || channel.type !== ChannelType.GuildText) return false;
      return channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel) ?? false;
    });
    if (publicWebhooks.size > 0) {
      c.add({
        id: 'webhooks.public_channels',
        category: 'WEBHOOKS',
        severity: 'INFO',
        title: 'Webhooks dans des salons publics',
        detail: `${publicWebhooks.size} webhook(s) publient dans des salons visibles par tous : une fuite d'URL devient immédiatement visible par l'ensemble du serveur.`,
        recommendation: 'Restreindre ces webhooks aux salons privés quand c\'est possible.',
        weight: 3,
        entities: publicWebhooks.map((w) => ({ id: w.id, name: w.name, type: 'webhook' as const })),
      });
    }

    if (!inviteGuardEnabled) {
      c.add({
        id: 'webhooks.no_guard',
        category: 'WEBHOOKS',
        severity: 'INFO',
        title: 'Aucune surveillance des créations de webhook',
        detail: 'La création d\'un webhook par un compte compromis ne déclenche aucune alerte.',
        recommendation: 'Activer l\'Invite Guard : il surveille aussi les créations sensibles.',
        weight: 3,
        fix: { action: 'enable_raid_module', label: 'Activer l\'Invite Guard', payload: { field: 'inviteGuardEnabled' } },
      });
    }

    return count;
  } catch {
    c.skip('Webhooks (permission « Gérer les webhooks » manquante)');
    return null;
  }
}

// ─── INVITES ────────────────────────────────────────────────────────────────────

async function checkInvites(guild: Guild, c: AuditCollector, config: { inviteGuardEnabled?: boolean; inviteRequireUnitary?: boolean } | null): Promise<number | null> {
  try {
    const invites = await guild.invites.fetch();
    const count = invites.size;

    const permanent = invites.filter((i) => i.maxAge === 0);
    const unlimited = invites.filter((i) => i.maxUses === 0);

    if (permanent.size > 0) {
      c.add({
        id: 'invites.permanent',
        category: 'INVITES',
        severity: 'WARNING',
        title: 'Invitations permanentes',
        detail: `${permanent.size} invitation(s) n'expirent jamais. Une invitation permanente qui fuite dans un lister de serveurs alimente les raids pendant des années.`,
        recommendation: 'Préférer des invitations à durée et usages limités ; activer « invitations unitaires » dans l\'Invite Guard.',
        weight: 7,
        entities: permanent.first(10).map((i) => ({ id: i.code, name: i.code, type: 'invite' as const, detail: i.inviter?.username })),
      });
    } else {
      c.ok('invites.permanent', 'INVITES', 'Durée des invitations', 'Toutes les invitations expirent.');
    }

    if (unlimited.size > 3) {
      c.add({
        id: 'invites.unlimited_uses',
        category: 'INVITES',
        severity: 'INFO',
        title: 'Invitations à usages illimités',
        detail: `${unlimited.size} invitation(s) acceptent un nombre illimité d'utilisations : impossible de tracer la source d'un raid.`,
        // Constat purement informatif : pas de poids, pas de correctif.
        // Exiger des invitations unitaires casse le partage ordinaire d'un lien
        // entre membres - le cout pour les utilisateurs depasse le gain de
        // tracabilite, donc on signale sans recommander ni proposer
        // d'activation en un clic.
        weight: 0,
      });
    }

    if (count > 50) {
      c.add({
        id: 'invites.count',
        category: 'INVITES',
        severity: 'INFO',
        title: 'Beaucoup d\'invitations actives',
        detail: `${count} invitations sont actives. La surface de diffusion du serveur est difficile à maîtriser.`,
        recommendation: 'Faire le ménage régulièrement depuis le module Invitations.',
        weight: 2,
      });
    }

    if (!config?.inviteGuardEnabled) {
      c.add({
        id: 'invites.guard_disabled',
        category: 'INVITES',
        severity: 'WARNING',
        title: 'Invite Guard désactivé',
        detail: 'Les créations d\'invitations ne sont ni contrôlées ni journalisées : un compte compromis peut ouvrir le serveur en silence.',
        recommendation: 'Activer l\'Invite Guard.',
        weight: 7,
        fix: { action: 'enable_raid_module', label: 'Activer l\'Invite Guard', payload: { field: 'inviteGuardEnabled' } },
      });
    } else {
      c.ok('invites.guard_disabled', 'INVITES', 'Invite Guard', 'Le contrôle des invitations est actif.');
    }

    return count;
  } catch {
    c.skip('Invitations (permission « Gérer le serveur » manquante)');
    return null;
  }
}

// ─── MODULES KOTBO ──────────────────────────────────────────────────────────────

type ModuleCheck = {
  id: string;
  enabled: boolean;
  severity: Exclude<AuditSeverity, 'OK'>;
  title: string;
  detail: string;
  recommendation: string;
  weight: number;
  fix?: AuditFix;
  okDetail: string;
};

async function checkKotboModules(guild: Guild, c: AuditCollector): Promise<void> {
  const [guildConfig, protection, autoMod] = await Promise.all([
    getCachedGuild(guild.id) as Promise<Record<string, unknown> | null>,
    getRaidProtectionConfig(guild.id),
    prisma.autoModConfig.findUnique({ where: { guildId: guild.id } }).catch(() => null),
  ]);

  const raidFix = (field: string, label: string): AuditFix => ({ action: 'enable_raid_module', label, payload: { field } });
  const autoModFix = (field: string, label: string): AuditFix => ({ action: 'enable_automod_module', label, payload: { field } });
  const guildFix = (field: string, label: string): AuditFix => ({ action: 'enable_guild_module', label, payload: { field } });

  const checks: ModuleCheck[] = [
    {
      id: 'modules.antiraid',
      enabled: Boolean(protection?.antiRaidEnabled),
      severity: 'CRITICAL',
      title: 'Anti-raid désactivé',
      detail: 'Aucune détection des vagues d\'arrivées : un raid de 50 comptes passe sans déclencher quoi que ce soit.',
      recommendation: 'Activer l\'anti-raid et définir un salon d\'alerte.',
      weight: 10,
      fix: raidFix('antiRaidEnabled', 'Activer l\'anti-raid'),
      okDetail: `Seuil : ${protection?.antiRaidJoinThreshold ?? '?'} arrivées / ${protection?.antiRaidJoinWindowSec ?? '?'} s.`,
    },
    {
      id: 'modules.captcha',
      enabled: Boolean(protection?.captchaEnabled),
      severity: 'WARNING',
      title: 'Captcha désactivé',
      detail: 'Les nouveaux membres accèdent au serveur sans aucune vérification anti-bot.',
      recommendation: 'Activer le captcha image ou vocal.',
      weight: 6,
      fix: raidFix('captchaEnabled', 'Activer le captcha'),
      okDetail: `Mode ${protection?.captchaMode ?? 'IMAGE'}.`,
    },
    {
      id: 'modules.scam_filter',
      enabled: Boolean(protection?.scamFilterEnabled),
      severity: 'WARNING',
      title: 'Filtre anti-arnaque désactivé',
      detail: 'Les liens de phishing (faux Nitro, faux Steam) ne sont pas filtrés.',
      recommendation: 'Activer le filtre anti-arnaque.',
      weight: 7,
      fix: raidFix('scamFilterEnabled', 'Activer le filtre anti-arnaque'),
      okDetail: `Action : ${protection?.scamFilterAction ?? '-'}.`,
    },
    {
      id: 'modules.scam_images',
      enabled: Boolean(protection?.scamImageFilterEnabled),
      severity: 'INFO',
      title: 'Filtre d\'images d\'arnaque désactivé',
      detail: 'Les captures de phishing déjà identifiées sur le serveur peuvent être repostées librement.',
      recommendation: 'Activer la comparaison des images avec la base d\'arnaques connues.',
      weight: 3,
      fix: raidFix('scamImageFilterEnabled', 'Activer le filtre d\'images'),
      okDetail: 'Les images d\'arnaque connues sont bloquées.',
    },
    {
      id: 'modules.scam_qr',
      enabled: Boolean(protection?.scamQrFilterEnabled),
      severity: 'WARNING',
      title: 'Filtre de codes QR désactivé',
      detail:
        'Le phishing par QR de connexion Discord ne contient aucun lien : ni le filtre de domaines, ni l\'AutoMod natif ne peuvent l\'intercepter. C\'est aujourd\'hui l\'une des campagnes de vol de compte les plus actives.',
      recommendation: 'Activer le filtre de codes QR : seuls les comptes sans historique sont concernés.',
      weight: 5,
      fix: raidFix('scamQrFilterEnabled', 'Activer le filtre de codes QR'),
      okDetail: 'Les codes QR des comptes sans historique sont bloqués.',
    },
    {
      id: 'modules.honeypot',
      enabled: Boolean(guildConfig?.honeypotEnabled),
      severity: 'WARNING',
      title: 'Honeypot désactivé',
      detail: 'Aucun salon piège : les comptes compromis ne sont détectés qu\'après avoir spammé de vrais salons.',
      recommendation: 'Configurer un salon piège invisible pour les membres légitimes.',
      weight: 5,
      fix: guildFix('honeypotEnabled', 'Activer le honeypot'),
      okDetail: 'Le salon piège alimente aussi la base d\'images d\'arnaque.',
    },
    {
      id: 'modules.admin_lock',
      enabled: Boolean(autoMod?.adminLockEnabled),
      severity: 'CRITICAL',
      title: 'Verrou de permission Administrateur désactivé',
      detail: 'Rien n\'empêche l\'octroi non autorisé de la permission Administrateur : c\'est le premier geste d\'une prise de contrôle.',
      recommendation: 'Activer le verrou admin : toute attribution non validée est annulée automatiquement.',
      weight: 9,
      fix: autoModFix('adminLockEnabled', 'Activer le verrou admin'),
      okDetail: 'Les octrois de permission Administrateur sont contrôlés.',
    },
    {
      id: 'modules.burst_suspend',
      enabled: Boolean(autoMod?.burstSuspendEnabled),
      severity: 'WARNING',
      title: 'Suspension anti-nuke désactivée',
      detail: 'Un compte staff compromis peut supprimer salons et rôles en rafale sans être arrêté.',
      recommendation: 'Activer la suspension automatique en cas d\'activité destructrice en rafale.',
      weight: 7,
      fix: autoModFix('burstSuspendEnabled', 'Activer la suspension anti-nuke'),
      okDetail: `Seuil : ${autoMod?.burstSuspendFastLimit ?? '?'} actions / ${autoMod?.burstSuspendFastWindowSec ?? '?'} s.`,
    },
    {
      id: 'modules.automod_spam',
      enabled: Boolean(autoMod?.spamEnabled),
      severity: 'WARNING',
      title: 'Anti-spam désactivé',
      detail: 'Aucune limite de débit de messages : le flood n\'est pas sanctionné.',
      recommendation: 'Activer l\'anti-spam du module AutoMod.',
      weight: 6,
      fix: autoModFix('spamEnabled', 'Activer l\'anti-spam'),
      okDetail: `${autoMod?.spamLimit ?? '?'} messages / ${autoMod?.spamIntervalSeconds ?? '?'} s.`,
    },
    {
      id: 'modules.automod_mentions',
      enabled: Boolean(autoMod?.mentionsEnabled),
      severity: 'WARNING',
      title: 'Limite de mentions désactivée',
      detail: 'Un seul message peut mentionner des dizaines de membres : c\'est le vecteur de harcèlement le plus direct.',
      recommendation: 'Activer la limite de mentions.',
      weight: 4,
      fix: autoModFix('mentionsEnabled', 'Activer la limite de mentions'),
      okDetail: `Maximum ${autoMod?.mentionsLimit ?? '?'} mentions.`,
    },
    {
      id: 'modules.automod_invites',
      enabled: Boolean(autoMod?.inviteFilterEnabled || autoMod?.linksEnabled),
      severity: 'INFO',
      title: 'Filtrage des invitations Discord désactivé',
      detail: 'La publicité pour d\'autres serveurs et les invitations vers des serveurs de scam ne sont pas filtrées.',
      recommendation: 'Activer le filtre d\'invitations.',
      weight: 3,
      fix: autoModFix('inviteFilterEnabled', 'Activer le filtre d\'invitations'),
      okDetail: 'Les invitations externes sont filtrées.',
    },
    {
      id: 'modules.profanity',
      enabled: Boolean(autoMod?.profanityEnabled || autoMod?.customWordsEnabled),
      severity: 'INFO',
      title: 'Aucun filtre de mots',
      detail: 'Ni le filtre de profanités natif ni la liste de mots personnalisés ne sont actifs.',
      recommendation: 'Activer au moins le filtre de profanités.',
      weight: 3,
      fix: autoModFix('profanityEnabled', 'Activer le filtre de profanités'),
      okDetail: 'Le filtrage lexical est actif.',
    },
    {
      id: 'modules.nickname',
      enabled: Boolean(guildConfig?.autoNicknameModerationEnabled),
      severity: 'INFO',
      title: 'Modération des pseudonymes désactivée',
      detail: 'Les pseudos publicitaires, insultants ou usurpant un rôle staff ne sont pas contrôlés.',
      recommendation: 'Activer la modération automatique des pseudonymes.',
      weight: 2,
      fix: guildFix('autoNicknameModerationEnabled', 'Activer la modération des pseudos'),
      okDetail: 'Les pseudonymes sont contrôlés à l\'arrivée et au changement.',
    },
    {
      id: 'modules.reports',
      enabled: Boolean(protection?.reportsEnabled),
      severity: 'INFO',
      title: 'Signalements communautaires désactivés',
      detail: 'Les membres n\'ont aucun moyen structuré de signaler un abus : le staff découvre les incidents en retard.',
      recommendation: 'Activer les signalements vers un salon staff.',
      weight: 3,
      fix: raidFix('reportsEnabled', 'Activer les signalements'),
      okDetail: 'Les membres peuvent signaler des abus.',
    },
  ];

  for (const check of checks) {
    if (check.enabled) {
      c.ok(check.id, 'MODULES', check.title.replace(/ désactivée?$/, '').replace(/^Aucun/, 'Filtre'), check.okDetail);
    } else {
      c.add({
        id: check.id,
        category: 'MODULES',
        severity: check.severity,
        title: check.title,
        detail: check.detail,
        recommendation: check.recommendation,
        weight: check.weight,
        fix: check.fix,
      });
    }
  }

  // Salon de logs : sans lui, tout le reste est aveugle
  const logChannelId = guildConfig?.logChannelId as string | undefined;
  if (!logChannelId) {
    c.add({
      id: 'modules.log_channel',
      category: 'MODULES',
      severity: 'CRITICAL',
      title: 'Aucun salon de logs configuré',
      detail: 'Les sanctions, alertes de raid et détections n\'ont aucune destination : les incidents passent inaperçus.',
      recommendation: 'Définir un salon de logs dans les paramètres généraux.',
      weight: 8,
    });
  } else {
    const channel = guild.channels.cache.get(logChannelId);
    if (!channel) {
      c.add({
        id: 'modules.log_channel',
        category: 'MODULES',
        severity: 'CRITICAL',
        title: 'Salon de logs introuvable',
        detail: `Le salon configuré (\`${logChannelId}\`) n'existe plus : toutes les alertes sont perdues silencieusement.`,
        recommendation: 'Reconfigurer le salon de logs.',
        weight: 8,
      });
    } else {
      const me = guild.members.me;
      const perms = me ? channel.permissionsFor(me) : null;
      if (perms && !perms.has(PermissionFlagsBits.SendMessages)) {
        c.add({
          id: 'modules.log_channel',
          category: 'MODULES',
          severity: 'CRITICAL',
          title: 'Le bot ne peut pas écrire dans le salon de logs',
          detail: `Kotbo n'a pas la permission d'envoyer des messages dans <#${logChannelId}> : les alertes échouent en silence.`,
          recommendation: 'Accorder « Envoyer des messages » et « Intégrer des liens » au bot sur ce salon.',
          weight: 8,
          entities: [{ id: channel.id, name: channel.name, type: 'channel' }],
        });
      } else {
        c.ok('modules.log_channel', 'MODULES', 'Salon de logs', `Les alertes sont envoyées dans #${channel.name}.`);
      }
    }
  }

  // Salon d'alerte anti-raid distinct
  if (protection?.antiRaidEnabled && !protection.antiRaidAlertChannelId) {
    c.add({
      id: 'modules.raid_alert_channel',
      category: 'MODULES',
      severity: 'WARNING',
      title: 'Anti-raid sans salon d\'alerte',
      detail: 'La détection de raid est active mais aucune alerte n\'est envoyée : personne n\'est prévenu quand le mode raid s\'enclenche.',
      recommendation: 'Définir un salon d\'alerte anti-raid.',
      weight: 5,
    });
  }
}

// ─── BOT_PERMS : le bot peut-il faire ce qu'on lui demande ? ───────────────────

async function checkBotCapabilities(guild: Guild, c: AuditCollector): Promise<void> {
  const me = guild.members.me;
  if (!me) {
    c.skip('Permissions du bot (membre introuvable)');
    return;
  }

  const [guildConfig, protection, autoMod] = await Promise.all([
    getCachedGuild(guild.id) as Promise<Record<string, unknown> | null>,
    getRaidProtectionConfig(guild.id),
    prisma.autoModConfig.findUnique({ where: { guildId: guild.id } }).catch(() => null),
  ]);

  // Chaque entrée : permission requise, module qui en dépend, gravité si absente.
  const requirements: { perm: bigint; label: string; needed: boolean; reason: string; weight: number }[] = [
    {
      perm: PermissionFlagsBits.ManageGuild,
      label: 'Gérer le serveur',
      needed: Boolean(autoMod?.discordAutoModEnabled),
      reason: 'synchroniser les règles AutoMod natives de Discord',
      weight: 8,
    },
    {
      perm: PermissionFlagsBits.ModerateMembers,
      label: 'Exclure temporairement',
      needed:
        autoMod?.spamAction === 'TIMEOUT' ||
        protection?.scamFilterAction === 'DELETE_AND_TIMEOUT' ||
        Boolean(guildConfig?.honeypotEnabled),
      reason: 'appliquer les timeouts décidés par l\'AutoMod, le filtre anti-arnaque ou le honeypot',
      weight: 7,
    },
    {
      perm: PermissionFlagsBits.ManageMessages,
      label: 'Gérer les messages',
      needed: Boolean(autoMod?.spamEnabled || protection?.scamFilterEnabled || guildConfig?.honeypotEnabled),
      reason: 'supprimer les messages de spam et d\'arnaque',
      weight: 7,
    },
    {
      perm: PermissionFlagsBits.ManageRoles,
      label: 'Gérer les rôles',
      needed: Boolean(protection?.captchaEnabled || protection?.tagRoleEnabled),
      reason: 'attribuer les rôles de vérification et de tag',
      weight: 6,
    },
    {
      perm: PermissionFlagsBits.KickMembers,
      label: 'Expulser des membres',
      needed: Boolean(protection?.captchaEnabled || protection?.joinLockKick || protection?.antiRaidAction === 'KICK'),
      reason: 'expulser les échecs de captcha et les arrivées pendant un verrouillage',
      weight: 6,
    },
    {
      perm: PermissionFlagsBits.BanMembers,
      label: 'Bannir des membres',
      needed: true,
      reason: 'appliquer les bannissements décidés par la modération',
      weight: 5,
    },
    {
      perm: PermissionFlagsBits.ManageNicknames,
      label: 'Gérer les pseudonymes',
      needed: Boolean(guildConfig?.autoNicknameModerationEnabled),
      reason: 'renommer les pseudonymes non conformes',
      weight: 4,
    },
    {
      perm: PermissionFlagsBits.ViewAuditLog,
      label: 'Voir les logs d\'audit',
      needed: true,
      reason: 'attribuer les actions (qui a supprimé quoi) dans les logs et l\'anti-nuke',
      weight: 5,
    },
    {
      perm: PermissionFlagsBits.ManageWebhooks,
      label: 'Gérer les webhooks',
      needed: Boolean(protection?.inviteGuardEnabled),
      reason: 'auditer et nettoyer les webhooks',
      weight: 3,
    },
  ];

  const missing = requirements.filter((r) => r.needed && !me.permissions.has(r.perm));

  if (missing.length === 0) {
    c.ok('bot_perms.all', 'BOT_PERMS', 'Permissions du bot', 'Kotbo dispose de toutes les permissions requises par les modules activés.');
    return;
  }

  for (const req of missing) {
    c.add({
      id: `bot_perms.${req.label.toLowerCase().replace(/[^a-z]+/g, '_')}`,
      category: 'BOT_PERMS',
      severity: req.weight >= 6 ? 'CRITICAL' : 'WARNING',
      title: `Permission manquante : ${req.label}`,
      detail: `Un module actif en a besoin pour ${req.reason}. Sans elle, la fonctionnalité échoue silencieusement à chaque déclenchement.`,
      recommendation: `Accorder « ${req.label} » au rôle de Kotbo.`,
      weight: req.weight,
    });
  }
}

// ─── HYGIENE ────────────────────────────────────────────────────────────────────

async function checkHygiene(guild: Guild, c: AuditCollector): Promise<void> {
  // Sanctions sans motif : impossible de justifier une décision en appel
  try {
    const [total, withoutReason] = await Promise.all([
      prisma.sanction.count({ where: { guildId: guild.id } }),
      prisma.sanction.count({ where: { guildId: guild.id, OR: [{ reason: '' }, { reason: { equals: 'Aucune raison fournie' } }] } }),
    ]);
    if (total > 20 && withoutReason / total > 0.25) {
      c.add({
        id: 'hygiene.sanctions_without_reason',
        category: 'HYGIENE',
        severity: 'INFO',
        title: 'Sanctions sans motif documenté',
        detail: `${Math.round((withoutReason / total) * 100)} % des sanctions n'ont pas de motif exploitable. En cas d'appel, la décision est indéfendable.`,
        recommendation: 'Rendre le motif obligatoire dans les commandes de sanction.',
        weight: 3,
      });
    } else if (total > 0) {
      c.ok('hygiene.sanctions_without_reason', 'HYGIENE', 'Traçabilité des sanctions', 'Les sanctions sont documentées.');
    }
  } catch {
    c.skip('Hygiène des sanctions (base indisponible)');
  }

  // Détection de doubles comptes en attente de décision : la boucle
  // d'apprentissage ne progresse pas tant que le staff ne tranche pas.
  try {
    const pending = await prisma.dcDetectionSample.count({ where: { guildId: guild.id, label: null } });
    if (pending > 25) {
      c.add({
        id: 'hygiene.pending_dc_samples',
        category: 'HYGIENE',
        severity: 'INFO',
        title: 'Détections de doubles comptes non tranchées',
        detail: `${pending} détections attendent une décision staff. Sans label, les poids du moteur ne se recalibrent pas et la précision stagne.`,
        recommendation: 'Traiter la file depuis la page Doubles comptes.',
        weight: 3,
        link: { href: '/security/accounts/detections', label: 'Voir les détections' },
      });
    }
  } catch {
    /* module optionnel */
  }

  // Signalements en souffrance
  try {
    const pendingReports = await prisma.memberReport.count({ where: { guildId: guild.id, status: 'PENDING' } });
    if (pendingReports > 10) {
      c.add({
        id: 'hygiene.pending_reports',
        category: 'HYGIENE',
        severity: 'WARNING',
        title: 'Signalements non traités',
        detail: `${pendingReports} signalements sont en attente. Les membres cessent de signaler quand rien ne se passe.`,
        recommendation: 'Traiter la file des signalements.',
        weight: 4,
      });
    }
  } catch {
    /* module optionnel */
  }

  // Rôles non gérés en excès : complexité = erreurs de permission
  const roleCount = guild.roles.cache.size;
  if (roleCount > 150) {
    c.add({
      id: 'hygiene.role_count',
      category: 'HYGIENE',
      severity: 'INFO',
      title: 'Nombre de rôles très élevé',
      detail: `${roleCount} rôles existent. Au-delà de ~150, les permissions effectives deviennent difficiles à auditer et les erreurs passent inaperçues.`,
      recommendation: 'Fusionner ou supprimer les rôles redondants.',
      weight: 2,
    });
  }
}

// ─── Orchestration ──────────────────────────────────────────────────────────────

export async function runSecurityAudit(guild: Guild, options: AuditOptions = {}): Promise<SecurityAuditResult> {
  const startedAt = Date.now();
  const c = new AuditCollector();

  const nativeAutoModRules = await checkDiscordSettings(guild, c);
  checkPermissions(guild, c);

  // Contrôles nécessitant la liste complète des membres.
  const deepRequested = options.deep !== false;
  const memberCount = guild.memberCount ?? guild.members.cache.size;
  let members: Map<string, GuildMember> | null = null;
  let adminMemberCount = 0;

  if (deepRequested && memberCount <= DEEP_MEMBER_LIMIT) {
    try {
      const fetched = await guild.members.fetch();
      members = new Map(fetched.map((m) => [m.id, m]));
    } catch {
      c.skip('Analyse des membres (intent GUILD_MEMBERS ou cache indisponible)');
    }
  } else if (deepRequested) {
    c.skip(`Analyse des membres (serveur de ${memberCount} membres, au-delà de la limite de ${DEEP_MEMBER_LIMIT})`);
  }

  if (members) {
    adminMemberCount = await checkAdminMembers(guild, members, c);
  }

  const [guildConfigRaw, protection, autoMod] = await Promise.all([
    getCachedGuild(guild.id) as Promise<Record<string, unknown> | null>,
    getRaidProtectionConfig(guild.id),
    prisma.autoModConfig.findUnique({ where: { guildId: guild.id } }).catch(() => null),
  ]);
  void guildConfigRaw;

  const botCount = checkBots(guild, members, c, Boolean(autoMod?.antiBotEnabled));
  const webhookCount = await checkWebhooks(guild, c, Boolean(protection?.inviteGuardEnabled));
  const inviteCount = await checkInvites(guild, c, protection);
  await checkKotboModules(guild, c);
  await checkBotCapabilities(guild, c);
  await checkHygiene(guild, c);

  // ── Agrégation des scores ───────────────────────────────────────────────────
  const categories: AuditCategoryScore[] = (Object.keys(CATEGORY_LABELS) as AuditCategory[]).map((category) => {
    const items = c.findings.filter((f) => f.category === category);
    const lost = Math.min(
      CATEGORY_MAX[category],
      items.reduce((sum, f) => sum + f.weight, 0)
    );
    const max = CATEGORY_MAX[category];
    return {
      category,
      label: CATEGORY_LABELS[category],
      score: max === 0 ? 100 : Math.round(((max - lost) / max) * 100),
      lost,
      max,
      counts: {
        critical: items.filter((f) => f.severity === 'CRITICAL').length,
        warning: items.filter((f) => f.severity === 'WARNING').length,
        info: items.filter((f) => f.severity === 'INFO').length,
        ok: items.filter((f) => f.severity === 'OK').length,
      },
    };
  });

  // Score global : moyenne des catégories pondérée par leur budget de points.
  const totalMax = categories.reduce((s, cat) => s + cat.max, 0);
  const totalLost = categories.reduce((s, cat) => s + cat.lost, 0);
  const score = Math.max(0, Math.min(100, Math.round(((totalMax - totalLost) / totalMax) * 100)));

  const severityRank: Record<AuditSeverity, number> = { CRITICAL: 0, WARNING: 1, INFO: 2, OK: 3 };
  const findings = [...c.findings].sort(
    (a, b) => severityRank[a.severity] - severityRank[b.severity] || b.weight - a.weight
  );

  return {
    score,
    grade: grade(score),
    categories,
    findings,
    degraded: c.degraded,
    stats: {
      memberCount,
      roleCount: guild.roles.cache.size,
      channelCount: guild.channels.cache.size,
      botCount,
      webhookCount,
      inviteCount,
      adminMemberCount,
      nativeAutoModRules,
    },
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
  };
}

// ─── Application des correctifs ─────────────────────────────────────────────────

export type FixOutcome = { ok: boolean; message: string };

/** Champs autorisés par action, pour empêcher toute écriture arbitraire. */
const ALLOWED_RAID_FIELDS = new Set([
  'antiRaidEnabled',
  'captchaEnabled',
  'scamFilterEnabled',
  'scamImageFilterEnabled',
  'scamQrFilterEnabled',
  'reportsEnabled',
  'inviteGuardEnabled',
  'inviteRequireUnitary',
]);

const ALLOWED_AUTOMOD_FIELDS = new Set([
  'spamEnabled',
  'mentionsEnabled',
  'inviteFilterEnabled',
  'profanityEnabled',
  'antiBotEnabled',
  'adminLockEnabled',
  'burstSuspendEnabled',
]);

const ALLOWED_GUILD_FIELDS = new Set(['honeypotEnabled', 'autoNicknameModerationEnabled']);

/**
 * Applique le correctif associé à un constat d'audit.
 * Refuse toute action non décrite par l'audit courant : le descripteur est
 * revalidé côté serveur, jamais pris tel quel depuis le client.
 */
export async function applyAuditFix(guild: Guild, findingId: string, reason: string): Promise<FixOutcome> {
  const audit = await runSecurityAudit(guild, { deep: false });
  const finding = audit.findings.find((f) => f.id === findingId);
  if (!finding?.fix) {
    return { ok: false, message: 'Ce constat n\'a pas de correctif automatique (ou n\'est plus d\'actualité).' };
  }
  return executeAuditFix(guild, finding, reason);
}

/**
 * Applique en une passe tous les correctifs sans risque du rapport.
 *
 * Les correctifs `risky` touchent des permissions existantes : ils restent
 * volontairement hors du lot et gardent leur confirmation individuelle - un
 * bouton « tout activer » ne doit pas pouvoir retirer des droits en silence.
 *
 * L'audit n'est lance qu'une fois pour tout le lot : passer par `applyAuditFix`
 * en boucle l'aurait relance a chaque correctif.
 */
export async function applySafeAuditFixes(
  guild: Guild,
  reason: string,
): Promise<{
  applied: { id: string; title: string; message: string }[];
  failed: { id: string; title: string; message: string }[];
}> {
  const audit = await runSecurityAudit(guild, { deep: false });
  const targets = audit.findings.filter((f) => f.severity !== 'OK' && f.fix && !f.fix.risky);

  const applied: { id: string; title: string; message: string }[] = [];
  const failed: { id: string; title: string; message: string }[] = [];

  // En sequence, pas en parallele : plusieurs correctifs ecrivent la meme ligne
  // de configuration (autoModConfig, guild), et deux upserts concurrents sur la
  // meme cle se marchent dessus.
  for (const finding of targets) {
    const outcome = await executeAuditFix(guild, finding, reason);
    const entry = { id: finding.id, title: finding.title, message: outcome.message };
    if (outcome.ok) applied.push(entry);
    else failed.push(entry);
  }

  return { applied, failed };
}

/** Execute le correctif d'un constat deja resolu, sans relancer l'audit. */
async function executeAuditFix(guild: Guild, finding: AuditFinding, reason: string): Promise<FixOutcome> {
  const fix = finding.fix;
  if (!fix) return { ok: false, message: "Ce constat n'a pas de correctif automatique." };
  const findingId = finding.id;
  const payload = fix.payload ?? {};

  try {
    switch (fix.action) {
      case 'enable_raid_module': {
        const field = String(payload.field ?? '');
        if (!ALLOWED_RAID_FIELDS.has(field)) return { ok: false, message: 'Champ non autorisé.' };
        const { upsertRaidProtectionConfig } = await import('./raidProtectionService.js');
        await upsertRaidProtectionConfig(guild.id, { [field]: true } as Record<string, boolean>);
        return { ok: true, message: `Module activé (${field}).` };
      }

      case 'enable_automod_module': {
        const field = String(payload.field ?? '');
        if (!ALLOWED_AUTOMOD_FIELDS.has(field)) return { ok: false, message: 'Champ non autorisé.' };
        await prisma.autoModConfig.upsert({
          where: { guildId: guild.id },
          create: { guildId: guild.id, [field]: true },
          update: { [field]: true },
        });
        const { invalidateAutoModCache } = await import('./autoModService.js');
        invalidateAutoModCache(guild.id);
        return { ok: true, message: `Filtre AutoMod activé (${field}).` };
      }

      case 'enable_guild_module': {
        const field = String(payload.field ?? '');
        if (!ALLOWED_GUILD_FIELDS.has(field)) return { ok: false, message: 'Champ non autorisé.' };
        await prisma.guild.update({ where: { id: guild.id }, data: { [field]: true } });
        return { ok: true, message: `Module activé (${field}).` };
      }

      case 'discord_setting': {
        const setting = String(payload.setting ?? '');
        const value = payload.value;
        if (typeof value !== 'number') return { ok: false, message: 'Valeur invalide.' };
        if (setting === 'verificationLevel') {
          await guild.setVerificationLevel(value as GuildVerificationLevel, reason);
        } else if (setting === 'explicitContentFilter') {
          await guild.setExplicitContentFilter(value as GuildExplicitContentFilter, reason);
        } else if (setting === 'defaultMessageNotifications') {
          await guild.setDefaultMessageNotifications(value as GuildDefaultMessageNotifications, reason);
        } else {
          return { ok: false, message: 'Paramètre Discord non pris en charge.' };
        }
        return { ok: true, message: 'Paramètre Discord mis à jour.' };
      }

      case 'disable_widget': {
        await guild.setWidgetSettings({ enabled: false, channel: null }, reason);
        return { ok: true, message: 'Widget désactivé.' };
      }

      case 'unmention_roles': {
        const roleIds = Array.isArray(payload.roleIds) ? (payload.roleIds as string[]) : [];
        let changed = 0;
        for (const roleId of roleIds) {
          const role = guild.roles.cache.get(roleId);
          if (!role || !role.editable) continue;
          await role.setMentionable(false, reason);
          changed++;
        }
        return { ok: changed > 0, message: `${changed} rôle(s) rendus non mentionnables.` };
      }

      case 'strip_everyone_permissions': {
        const everyone = guild.roles.everyone;
        const toRemove = DANGEROUS_PERMISSIONS.filter((p) => everyone.permissions.has(p.flag));
        if (toRemove.length === 0) return { ok: true, message: 'Rien à retirer.' };
        let next = everyone.permissions.bitfield;
        for (const p of toRemove) next &= ~p.flag;
        await everyone.setPermissions(next, reason);
        return { ok: true, message: `${toRemove.length} permission(s) retirée(s) de @everyone.` };
      }

      default:
        return { ok: false, message: 'Action inconnue.' };
    }
  } catch (err) {
    logger.error('SecurityAudit', `Correctif ${findingId} échoué sur ${guild.id}`, err);
    return { ok: false, message: err instanceof Error ? err.message : 'Le correctif a échoué.' };
  }
}
