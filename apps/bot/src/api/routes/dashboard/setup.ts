/**
 * Parcours de configuration : ce qui est en place, ce qui manque, et ou aller.
 *
 * Kotbo a une centaine de reglages repartis sur autant de pages. Un serveur qui
 * vient de l'activer n'a aucun moyen de savoir par ou commencer, ni de verifier
 * qu'il n'a rien oublie d'essentiel. Cette route repond aux deux questions au
 * meme endroit, en lisant la configuration reelle plutot qu'en tenant un
 * compteur d'etapes franchies - un reglage efface doit redevenir « a faire ».
 */
import { IncomingMessage, ServerResponse } from 'node:http';
import { Client } from 'discord.js';
import prisma from '../../../utils/db.js';
import { logger } from '../../../utils/logger.js';
import { json, resolveDashboardAccess, type AuthClaims } from '../../shared.js';

type SetupStep = {
  key: string;
  /** Regroupement affiche : l'ordre des groupes est l'ordre conseille. */
  group: 'essentiel' | 'moderation' | 'engagement';
  label: string;
  /** Ce que le serveur y gagne. Sans cela, une case a cocher n'est qu'une corvee. */
  why: string;
  done: boolean;
  /** Page ou regler le point. */
  href: string;
  /** Ce qui manque precisement, quand ce n'est pas evident. */
  detail?: string;
};

/** Vrai si la chaine porte une valeur exploitable. */
function filled(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

export async function handleSetupRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  _url: URL,
  client: Client,
  user: AuthClaims,
): Promise<boolean> {
  if (parts[4] !== 'setup') return false;
  if (req.method !== 'GET' || parts.length !== 5) return false;

  const guildId = parts[3];

  const access = await resolveDashboardAccess(client, guildId, user.userId);
  if (!access.canManageSettings) {
    json(res, 403, { error: 'Accès refusé' });
    return true;
  }

  try {
    const [guild, features] = await Promise.all([
      prisma.guild.findUnique({
        where: { id: guildId },
        select: {
          logChannelId: true,
          moderatorRoleId: true,
          regulationChannelId: true,
          publicChannelId: true,
          timezone: true,
          language: true,
          ticketCategoryId: true,
          ticketStaffRoleId: true,
          ticketChannelId: true,
          sanctionAlertChannelId: true,
          ticketQuotaOpenEnabled: true,
        },
      }),
      prisma.dashboardFeatureConfig.findMany({
        where: { guildId },
        select: { featureKey: true, enabled: true },
      }),
    ]);

    if (!guild) {
      json(res, 404, { error: 'Serveur introuvable' });
      return true;
    }

    // Un module sans ligne de configuration est actif : c'est la convention du
    // reste du code, un serveur neuf ne doit pas apparaitre tout eteint.
    const enabled = (key: string) => features.find((f) => f.featureKey === key)?.enabled ?? true;

    const steps: SetupStep[] = [
      {
        key: 'logs',
        group: 'essentiel',
        label: 'Salon de logs',
        why: "Sans lui, aucune trace de ce que fait le bot ni de ce qui se passe sur le serveur.",
        done: filled(guild.logChannelId),
        href: '/logs',
      },
      {
        key: 'moderator-role',
        group: 'essentiel',
        label: 'Rôle modérateur',
        why: "Il décide qui peut sanctionner et prendre en charge un ticket. Sans lui, seuls les administrateurs le peuvent.",
        done: filled(guild.moderatorRoleId),
        href: '/security/sanctions',
      },
      {
        key: 'timezone',
        group: 'essentiel',
        label: 'Fuseau horaire',
        why: "Le bot tourne en UTC : sans fuseau, toute date affichée ou saisie est décalée.",
        // `timezone` a une valeur par defaut : le point est fait, il est
        // rappele pour que personne ne decouvre le decalage apres coup.
        done: filled(guild.timezone),
        href: '/settings',
        detail: guild.timezone ?? undefined,
      },
      {
        key: 'regulation',
        group: 'moderation',
        label: 'Règlement publié',
        why: "Une sanction sans règle écrite se conteste. Le règlement sert aussi de référence aux rapports.",
        done: filled(guild.regulationChannelId),
        href: '/regulation',
      },
      {
        key: 'security',
        group: 'moderation',
        label: 'Protection activée',
        why: "Filtres AutoMod et anti-raid. Un niveau de protection les règle tous d'un coup.",
        done: enabled('automod') && enabled('raid_protection'),
        href: '/security/quick-setup',
      },
      {
        key: 'sanction-alerts',
        group: 'moderation',
        label: 'Salon des alertes de sanction',
        why: "Le staff voit passer les sanctions au lieu de les découvrir dans le casier.",
        done: filled(guild.sanctionAlertChannelId),
        href: '/security/sanctions',
      },
      {
        key: 'tickets',
        group: 'engagement',
        label: 'Tickets opérationnels',
        why: "Catégorie, rôle du staff et salon du panneau : sans les trois, un membre ne peut pas ouvrir de ticket.",
        done: enabled('tickets')
          && filled(guild.ticketCategoryId)
          && filled(guild.ticketStaffRoleId)
          && filled(guild.ticketChannelId),
        href: '/tickets/config',
        detail: [
          filled(guild.ticketCategoryId) ? null : 'catégorie',
          filled(guild.ticketStaffRoleId) ? null : 'rôle du staff',
          filled(guild.ticketChannelId) ? null : 'salon du panneau',
        ].filter(Boolean).join(', ') || undefined,
      },
      {
        key: 'ticket-quotas',
        group: 'engagement',
        label: 'Quotas de tickets',
        why: "Sans quota, rien n'empêche un membre d'ouvrir dix tickets d'affilée.",
        done: guild.ticketQuotaOpenEnabled,
        href: '/tickets/config',
      },
      {
        key: 'welcome',
        group: 'engagement',
        label: 'Accueil des arrivants',
        why: "Un serveur qui n'accueille pas perd la moitié de ses arrivants dans la première heure.",
        done: enabled('welcome_goodbye') && filled(guild.publicChannelId),
        href: '/welcome-goodbye',
      },
    ];

    const done = steps.filter((s) => s.done).length;

    json(res, 200, {
      steps,
      progress: { done, total: steps.length },
    });
  } catch (err) {
    logger.error('SetupAPI', 'Erreur GET setup:', err);
    json(res, 500, { error: 'Erreur lors du calcul du parcours' });
  }
  return true;
}
