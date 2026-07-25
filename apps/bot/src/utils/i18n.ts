import * as m from '../lib/paraglide/messages.js';
import { getCachedGuild } from './cache.js';

// `guildLocale` vaut `null` hors serveur cote discord.js (et `locale` est un
// enum Locale, compatible string) : le type doit accepter les deux.
export function getLocale(interaction: { locale?: string | null; guildLocale?: string | null }): 'fr' | 'en' {
  const code = interaction.locale ?? interaction.guildLocale ?? 'fr';
  return code.startsWith('fr') ? 'fr' : 'en';
}

/**
 * Comme `getLocale`, mais tient compte de la langue explicitement choisie
 * par un admin pour ce serveur via `/language` (`Guild.language`), qui prime
 * sur la locale Discord de l'utilisateur/serveur.
 */
export async function getEffectiveLocale(interaction: {
  locale?: string | null;
  guildLocale?: string | null;
  guildId?: string | null;
}): Promise<'fr' | 'en'> {
  if (interaction.guildId) {
    const guild = await getCachedGuild(interaction.guildId);
    if (guild?.language === 'fr' || guild?.language === 'en') {
      return guild.language;
    }
  }
  return getLocale(interaction);
}

export function getCommandMetadata(keyPrefix: string) {
  const enName = (m as any)[`${keyPrefix}_name`]?.({}, { locale: 'en' }) || keyPrefix;
  const frName = (m as any)[`${keyPrefix}_name`]?.({}, { locale: 'fr' }) || keyPrefix;
  const enDesc = (m as any)[`${keyPrefix}_description`]?.({}, { locale: 'en' }) || 'No description';
  const frDesc = (m as any)[`${keyPrefix}_description`]?.({}, { locale: 'fr' }) || 'Pas de description';

  return {
    name: enName,
    nameLocalizations: {
      fr: frName,
    },
    description: enDesc,
    descriptionLocalizations: {
      fr: frDesc,
    },
  };
}
