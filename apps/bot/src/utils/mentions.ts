import type { Guild, MessageMentionOptions } from 'discord.js';

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convertit les "@NomDeRôle" et "#nom-de-salon" écrits en texte brut (ex: saisis
 * dans un textarea du dashboard) en mentions Discord réelles (<@&id> / <#id>).
 *
 * Utilisé pour les descriptions d'embed : dans un embed, une mention rendue ainsi
 * s'affiche et est cliquable mais ne notifie jamais personne (Discord ne déclenche
 * les notifications que pour les mentions présentes dans `content`, jamais dans un embed).
 */
export function resolveTextMentions(guild: Guild | null | undefined, text: string | null | undefined): string {
  if (!text) return '';
  if (!guild) return text;

  let result = text;

  const channels = [...guild.channels.cache.values()]
    .filter((c): c is typeof c & { name: string } => typeof (c as { name?: unknown }).name === 'string')
    .sort((a, b) => b.name.length - a.name.length);

  for (const channel of channels) {
    const pattern = new RegExp(`#${escapeRegExp(channel.name)}\\b`, 'gi');
    result = result.replace(pattern, `<#${channel.id}>`);
  }

  const roles = [...guild.roles.cache.values()]
    .filter((r) => r.name !== '@everyone')
    .sort((a, b) => b.name.length - a.name.length);

  for (const role of roles) {
    const pattern = new RegExp(`@${escapeRegExp(role.name)}\\b`, 'gi');
    result = result.replace(pattern, `<@&${role.id}>`);
  }

  return result;
}

/**
 * Normalise une mention de ping configuree depuis le dashboard.
 *
 * La valeur est recopiee telle quelle dans le `content` du message : seule une
 * mention Discord valide peut reellement notifier. On n'accepte donc que
 * `@everyone`, `@here` et un role (balise `<@&id>` ou ID brut) ; un nom de role
 * tape a la main est rejete plutot que stocke inerte.
 */
export function normalizeRoleMention(value?: string | null): string | null {
  const raw = (value || '').trim();
  if (!raw) return null;
  if (raw === '@everyone' || raw === '@here') return raw;
  const tagged = raw.match(/^<@&(\d{5,})>$/);
  if (tagged) return `<@&${tagged[1]}>`;
  if (/^\d{5,}$/.test(raw)) return `<@&${raw}>`;
  return null;
}

/**
 * Autorise le ping du seul role configure. Le message reprend des contenus
 * tiers (titre de video, de stream) : sans cette restriction, un titre
 * contenant `@everyone` pourrait notifier tout le serveur.
 */
export function allowedMentionsFor(mention?: string | null): MessageMentionOptions {
  const normalized = normalizeRoleMention(mention);
  if (!normalized) return { parse: [] };
  if (normalized === '@everyone' || normalized === '@here') return { parse: ['everyone'] };
  return { parse: [], roles: [normalized.slice(3, -1)] };
}
