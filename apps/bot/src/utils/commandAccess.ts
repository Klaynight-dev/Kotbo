import { PermissionFlagsBits, type ChatInputCommandInteraction } from 'discord.js';

export type CommandRestrictionRule = {
  commandName: string;
  /** Commande desactivee pour tout le serveur (administrateurs compris). */
  enabled: boolean;
  allowedChannelIds: string[];
  blockedChannelIds: string[];
  allowedRoleIds: string[];
  blockedRoleIds: string[];
  allowedUserIds: string[];
  blockedUserIds: string[];
};

export type CommandCatalogEntry = {
  name: string;
  label: string;
  description: string;
  defaultAccess: 'tout_le_monde' | 'modération' | 'administration';
};

export const COMMAND_CATALOG: CommandCatalogEntry[] = [
  { name: 'setup', label: 'Installation', description: 'Assistant de mise en route du serveur.', defaultAccess: 'administration' },
  { name: 'config', label: 'Configuration', description: 'Panneau de configuration principal du bot.', defaultAccess: 'administration' },
  { name: 'ping', label: 'Ping', description: 'Vérification de la latence du bot.', defaultAccess: 'tout_le_monde' },
  { name: 'info', label: "Infos serveur", description: "Résumé de l'état et des métriques du serveur.", defaultAccess: "tout_le_monde" },
  { name: 'excuse', label: 'Excuse dev', description: 'Affiche une excuse de développeur aléatoire.', defaultAccess: 'tout_le_monde' },
  { name: 'epoch', label: 'Epoch', description: 'Convertit les dates et les timestamps.', defaultAccess: 'tout_le_monde' },
  { name: 'devutils', label: 'Outils dev', description: 'Utilitaires de développement.', defaultAccess: 'tout_le_monde' },
  { name: 'status', label: "Statut", description: "Affichage d'un statut synthétique.", defaultAccess: "tout_le_monde" },
  { name: 'admin', label: 'Admin', description: 'Commandes administrateur du serveur.', defaultAccess: 'administration' },
  { name: 'help', label: 'Aide', description: 'Aide générale et documentation des commandes.', defaultAccess: 'tout_le_monde' },
  { name: 'dailyAlgo', label: "Daily Algo", description: "Gestion du défi d'algorithmique quotidien.", defaultAccess: "administration" },
  { name: 'profile', label: 'Profil', description: 'Affiche le profil utilisateur et la progression Daily Algo.', defaultAccess: 'tout_le_monde' },
  { name: 'sanction', label: 'Sanctions', description: 'Gestion des sanctions et des rapports.', defaultAccess: 'modération' },
  { name: 'journal', label: "Journal", description: "Publication manuelle d'articles de presse.", defaultAccess: "modération" },
];

const normalizeIdList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];

  return [...new Set(
    value
      .map((entry) => (typeof entry === 'string' ? entry.replace(/[^0-9]/g, '') : ''))
      .filter((entry) => entry.length > 0),
  )];
};

export const normalizeCommandRestrictions = (value: unknown): CommandRestrictionRule[] => {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;

      const commandName = (entry as Record<string, unknown>).commandName;
      if (typeof commandName !== 'string' || !commandName.trim()) return null;

      const enabled = (entry as Record<string, unknown>).enabled;

      return {
        commandName: commandName.trim(),
        enabled: enabled !== false,
        allowedChannelIds: normalizeIdList((entry as Record<string, unknown>).allowedChannelIds),
        blockedChannelIds: normalizeIdList((entry as Record<string, unknown>).blockedChannelIds),
        allowedRoleIds: normalizeIdList((entry as Record<string, unknown>).allowedRoleIds),
        blockedRoleIds: normalizeIdList((entry as Record<string, unknown>).blockedRoleIds),
        allowedUserIds: normalizeIdList((entry as Record<string, unknown>).allowedUserIds),
        blockedUserIds: normalizeIdList((entry as Record<string, unknown>).blockedUserIds),
      } satisfies CommandRestrictionRule;
    })
    .filter((entry): entry is CommandRestrictionRule => !!entry);
};

export function isPrivilegedCommandExecutor(interaction: ChatInputCommandInteraction): boolean {
  return !!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
    || !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

export function evaluateCommandRestriction(
  rules: CommandRestrictionRule[],
  commandName: string,
  channelId: string | null,
  roleIds: string[],
  userId: string,
  isPrivileged = false,
): { allowed: boolean; reason?: string } {
  const rule = rules.find((entry) => entry.commandName === commandName);
  if (!rule) return { allowed: true };

  // Une commande coupee l'est pour tout le monde : le garde-fou reste le
  // dashboard, qui peut toujours la rallumer.
  if (!rule.enabled) {
    return { allowed: false, reason: 'Cette commande est desactivee sur ce serveur.' };
  }

  if (isPrivileged) return { allowed: true };

  if (rule.blockedUserIds.includes(userId)) {
    return { allowed: false, reason: 'Cette commande est bloquée pour ton compte.' };
  }

  if (rule.allowedUserIds.length > 0 && !rule.allowedUserIds.includes(userId)) {
    return { allowed: false, reason: 'Cette commande est réservée à certains comptes.' };
  }

  if (channelId) {
    if (rule.blockedChannelIds.includes(channelId)) {
      return { allowed: false, reason: 'Cette commande est interdite dans ce salon.' };
    }

    if (rule.allowedChannelIds.length > 0 && !rule.allowedChannelIds.includes(channelId)) {
      return { allowed: false, reason: "Cette commande n'est autorisée que dans certains salons." };
    }
  }

  const hasBlockedRole = rule.blockedRoleIds.some((roleId) => roleIds.includes(roleId));
  if (hasBlockedRole) {
    return { allowed: false, reason: 'Un de tes rôles est explicitement interdit pour cette commande.' };
  }

  if (rule.allowedRoleIds.length > 0 && !rule.allowedRoleIds.some((roleId) => roleIds.includes(roleId))) {
    return { allowed: false, reason: "Tu n'as pas le rôle autorisé pour utiliser cette commande." };
  }

  return { allowed: true };
}