/**
 * Nom et description affichables d'un module.
 *
 * Les deux sources qui les portent sont en francais en dur : le registre
 * (`MODULE_REGISTRY`, cote contrats) et la colonne `DashboardFeatureConfig
 * .featureName`, ecrite une fois pour toutes a la creation de la ligne. Ni
 * l'une ni l'autre ne peut etre bilingue - une colonne ne porte qu'une langue,
 * et le registre sert aussi au bot. La traduction se fait donc a l'affichage,
 * sur la cle du module, qui est la meme des deux cotes.
 *
 * Le repli renvoie la valeur d'origine : une cle inconnue des messages - un
 * module ajoute au registre sans sa paire de traductions - s'affiche sous son
 * nom francais plutot que sous son identifiant brut.
 */
import { m } from './i18n';

export function moduleName(key: string | undefined | null, fallback = ''): string {
  if (!key) return fallback;
  return (m as any)[`mod_${key}_name`]?.() ?? (fallback || key);
}

export function moduleDescription(key: string | undefined | null, fallback = ''): string {
  if (!key) return fallback;
  return (m as any)[`mod_${key}_desc`]?.() ?? fallback;
}
