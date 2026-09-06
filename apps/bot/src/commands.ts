import type { AutocompleteInteraction, ChatInputCommandInteraction, MessageContextMenuCommandInteraction, UserContextMenuCommandInteraction } from 'discord.js';
import { absentCommand } from './commands/admin/absent.js';
import { activateCommand } from './commands/admin/activate.js';
import { adminCommand } from './commands/admin/admin.js';
import { casierCommand, casierContextCommand } from './commands/moderation/casier.js';
import { configCommand } from './commands/admin/config.js';
import { dailyAlgoCommand } from './commands/fun/dailyAlgo.js';
import { dcCommand } from './commands/moderation/dc.js';
import { demissionCommand } from './commands/admin/demission.js';
import { devutilsCommand } from './commands/admin/devutils.js';
import { epochCommand } from './commands/utility/epoch.js';
import { eventCommand } from './commands/utility/event.js';
import { ctfCommand } from './commands/fun/ctf.js';
import { excuseCommand } from './commands/fun/excuse.js';
import { giveawayCommand } from './commands/fun/giveaway.js';
import { helpCommand } from './commands/utility/help.js';
import { infoCommand } from './commands/utility/info.js';
import { invitesCommand } from './commands/utility/invites.js';
import { languageCommand } from './commands/utility/language.js';
import { leaderboardCommand } from './commands/profile/leaderboard.js';
import { meetingCommand } from './commands/admin/meeting.js';
import { noteCommand, noteContextCommand } from './commands/moderation/note.js';
import { optOutCommand } from './commands/utility/optout.js';
import { privacyCommand } from './commands/utility/privacy.js';
import { pingCommand } from './commands/utility/ping.js';
import { postCommand } from './commands/utility/post.js';
import { profilCommand } from './commands/profile/profil.js';
import { profileCommand } from './commands/profile/profile.js';
import { rankCommand } from './commands/profile/rank.js';
import { prestigeCommand } from './commands/profile/prestige.js';
import { prestigeAdminCommand } from './commands/admin/prestige-admin.js';
import { rescanCommand } from './commands/moderation/rescan.js';
import { roleCommand } from './commands/moderation/role.js';
import { sanctionCommand, sanctionContextCommand } from './commands/moderation/sanction.js';
import { requestVerificationCommand, requestVerificationContextCommand } from './commands/moderation/request-verification.js';
import { sayCommand } from './commands/fun/say.js';
import { mpsayCommand } from './commands/fun/mpsay.js';
import { dailyCommand } from './commands/economy/daily.js';
import { coinsCommand } from './commands/economy/coins.js';
import { diceCommand } from './commands/economy/dice.js';
import { economyInfoCommand } from './commands/economy/economyInfo.js';
import { gamesCommand } from './commands/economy/games.js';
import { giveCoinsCommand } from './commands/economy/giveCoins.js';
import { giveItemCommand } from './commands/economy/giveItem.js';
import { guessCommand } from './commands/economy/guess.js';
import { itemsCommand } from './commands/economy/items.js';
import { removeCoinsCommand } from './commands/economy/removeCoins.js';
import { removeItemCommand } from './commands/economy/removeItem.js';
import { richestCommand } from './commands/economy/richest.js';
import { rpsCommand } from './commands/economy/rps.js';
import { rouletteCommand } from './commands/economy/roulette.js';
import { spawnItemCommand } from './commands/economy/spawnItem.js';
import { workCommand } from './commands/economy/work.js';
import { levelingCommand } from './commands/admin/leveling.js';
import { serverstatsCommand } from './commands/utility/serverstats.js';
import { setupCommand } from './commands/admin/setup.js';
import { statsCommand } from './commands/utility/stats.js';
import { statusCommand } from './commands/admin/status.js';
import { suggestCommand } from './commands/utility/suggest.js';
import { ticketCommand } from './commands/utility/ticket.js';
import { transcriptCommand } from './commands/moderation/transcript.js';
import { suggestionConfigCommand } from './commands/utility/suggestion-config.js';
import { clearCommand } from './commands/moderation/clear.js';
import { channelCommand } from './commands/moderation/channel.js';
import { signalCommand, signalContextCommand } from './commands/moderation/signal.js';
import { dashboardCommand } from './commands/utility/dashboard.js';
import { linkCommand } from './commands/admin/link.js';
import { staffserverCommand } from './commands/admin/staffserver.js';
import { channelhealthCommand } from './commands/admin/channelhealth.js';
import { simulationCommand } from './commands/admin/simulation.js';
import { repCommand } from './commands/community/rep.js';
import { marketCommand } from './commands/economy/market.js';
import { questsCommand } from './commands/community/quests.js';
import { clanCommand } from './commands/community/clan.js';
import { parisCommand } from './commands/community/paris.js';
import { rpgCommand } from './commands/fun/rpg.js';
import { raidCommand } from './commands/fun/raid.js';
import { topCommand } from './commands/profile/top.js';
import { widgetCommand } from './commands/profile/widget.js';
import { seasonsCommand } from './commands/community/seasons.js';
import { pulseCommand } from './commands/admin/pulse.js';
import { evaluationsCommand } from './commands/admin/evaluations.js';
import { rappelCommand } from './commands/utility/rappel.js';
import { messageTranscriptContextCommand, messageTranscriptFromContextCommand } from './commands/moderation/messageTranscript.js';
import { messageHubContextCommand, userHubContextCommand } from './commands/context/hub.js';
import { protectionCommand } from './commands/admin/protection.js';
import { auditCommand } from './commands/admin/audit.js';
import { reportCommand, reportMessageContextCommand } from './commands/moderation/report.js';

export type SlashCommandDefinition = {
  data: { name: string; description: string; toJSON: () => unknown };
  execute: (interaction: ChatInputCommandInteraction) => Promise<unknown>;
  autocomplete?: (interaction: AutocompleteInteraction) => Promise<unknown>;
};

export type ContextCommandDefinition = {
  data: { name: string; toJSON: () => unknown };
  execute:
    | ((interaction: UserContextMenuCommandInteraction) => Promise<unknown>)
    | ((interaction: MessageContextMenuCommandInteraction) => Promise<unknown>);
};

export type ApplicationCommandDefinition = SlashCommandDefinition | ContextCommandDefinition;

export const commands: SlashCommandDefinition[] = [
  setupCommand,
  configCommand,
  pingCommand,
  languageCommand,
  infoCommand,
  excuseCommand,
  epochCommand,
  devutilsCommand,
  statusCommand,
  adminCommand,
  postCommand,
  helpCommand,
  dailyAlgoCommand,
  profileCommand,
  profilCommand,
  sanctionCommand,
  requestVerificationCommand,
  dcCommand,
  rescanCommand,
  casierCommand,
  absentCommand,
  meetingCommand,
  statsCommand,
  invitesCommand,
  leaderboardCommand,
  serverstatsCommand,
  noteCommand,
  eventCommand,
  ctfCommand,
  activateCommand,
  transcriptCommand,
  ticketCommand,
  sayCommand,
  mpsayCommand,
  demissionCommand,
  rankCommand,
  prestigeCommand,
  prestigeAdminCommand,
  giveawayCommand,
  suggestCommand,
  suggestionConfigCommand,
  clearCommand,
  channelCommand,
  signalCommand,
  roleCommand,
  dashboardCommand,
  dailyCommand,
  coinsCommand,
  diceCommand,
  economyInfoCommand,
  gamesCommand,
  giveCoinsCommand,
  giveItemCommand,
  guessCommand,
  itemsCommand,
  removeCoinsCommand,
  removeItemCommand,
  richestCommand,
  rpsCommand,
  rouletteCommand,
  spawnItemCommand,
  workCommand,
  linkCommand,
  staffserverCommand,
  channelhealthCommand,
  simulationCommand,
  repCommand,
  marketCommand,
  questsCommand,
  clanCommand,
  parisCommand,
  rpgCommand,
  raidCommand,
  topCommand,
  widgetCommand,
  seasonsCommand,
  pulseCommand,
  evaluationsCommand,
  rappelCommand,
  levelingCommand,
  protectionCommand,
  auditCommand,
  reportCommand,
  optOutCommand,
  privacyCommand,
];

/**
 * Menus contextuels déployés globalement.
 *
 * Discord plafonne une application à 5 entrées de type User et 5 de type
 * Message au global - ces deux listes sont donc pleines et toute nouvelle
 * feature passe par le hub (`services/core/contextActionRegistry.ts`) ou par le
 * scope guilde ci-dessous.
 */
export const globalContextCommands: ContextCommandDefinition[] = [
  // User (5/5)
  sanctionContextCommand,
  casierContextCommand,
  noteContextCommand,
  requestVerificationContextCommand,
  userHubContextCommand,
  // Message (3/5)
  messageTranscriptFromContextCommand,
  messageTranscriptContextCommand,
  messageHubContextCommand,
];

/**
 * Menus contextuels déployés par serveur, sur les guilds activées uniquement.
 * Chaque guild dispose de son propre quota de 5 User + 5 Message, distinct du
 * quota global.
 */
export const guildContextCommands: ContextCommandDefinition[] = [
  // User (1/5)
  signalContextCommand,
  // Message (1/5)
  reportMessageContextCommand,
];

export const contextCommands: ContextCommandDefinition[] = [
  ...globalContextCommands,
  ...guildContextCommands,
];

export const applicationCommands: ApplicationCommandDefinition[] = [
  ...commands,
  ...globalContextCommands,
];

export const guildApplicationCommands: ApplicationCommandDefinition[] = [
  ...guildContextCommands,
];

/**
 * Module propriétaire de chaque commande, pour la garde d'exécution.
 *
 * L'index porte sur l'objet de définition et non sur le nom : celui-ci vient de
 * `getCommandMetadata()` et change avec la langue de l'instance, si bien qu'une
 * table `'ticket' -> 'tickets'` cesserait de correspondre dès qu'un serveur
 * bascule en anglais.
 *
 * Les commandes absentes de cette table ne dépendent d'aucun module et restent
 * disponibles quoi qu'il arrive : administration, aide, ping, profil.
 */
export const COMMAND_MODULES = new Map<ApplicationCommandDefinition, string>([
  // Modération & sécurité
  [sanctionCommand, 'sanctions'],
  [sanctionContextCommand, 'sanctions'],
  [casierCommand, 'sanctions'],
  [casierContextCommand, 'sanctions'],
  [noteCommand, 'sanctions'],
  [noteContextCommand, 'sanctions'],
  [reportCommand, 'sanctions'],
  [reportMessageContextCommand, 'sanctions'],
  [signalCommand, 'sanctions'],
  [signalContextCommand, 'sanctions'],
  [dcCommand, 'double_accounts'],
  [rescanCommand, 'nickname_moderation'],
  [protectionCommand, 'raid_protection'],
  [requestVerificationCommand, 'security_verification'],
  [requestVerificationContextCommand, 'security_verification'],
  [transcriptCommand, 'logs'],
  [messageTranscriptContextCommand, 'logs'],
  [messageTranscriptFromContextCommand, 'logs'],
  [auditCommand, 'logs'],

  // Staff
  [absentCommand, 'absences'],
  [meetingCommand, 'meetings'],
  [demissionCommand, 'staff_directory'],
  [evaluationsCommand, 'evaluations'],
  [staffserverCommand, 'staff_server'],

  // Communauté
  [dailyAlgoCommand, 'daily_algo'],
  [ticketCommand, 'tickets'],
  [giveawayCommand, 'giveaways'],
  [suggestCommand, 'suggestions'],
  [suggestionConfigCommand, 'suggestions'],
  [eventCommand, 'events'],
  [ctfCommand, 'events'],
  [rankCommand, 'leveling'],
  [levelingCommand, 'leveling'],
  [leaderboardCommand, 'leveling'],
  [topCommand, 'leveling'],
  [seasonsCommand, 'seasons'],
  [clanCommand, 'clans'],
  [questsCommand, 'quests'],
  [repCommand, 'reputation'],
  [marketCommand, 'marketplace'],
  [rpgCommand, 'economy'],
  [raidCommand, 'economy'],
  [dailyCommand, 'economy'],
  [coinsCommand, 'economy'],
  [diceCommand, 'economy'],
  [economyInfoCommand, 'economy'],
  [gamesCommand, 'economy'],
  [giveCoinsCommand, 'economy'],
  [giveItemCommand, 'economy'],
  [guessCommand, 'economy'],
  [itemsCommand, 'economy'],
  [removeCoinsCommand, 'economy'],
  [removeItemCommand, 'economy'],
  [richestCommand, 'economy'],
  [rpsCommand, 'economy'],
  [rouletteCommand, 'economy'],
  [spawnItemCommand, 'economy'],
  [workCommand, 'economy'],
  [excuseCommand, 'fun'],

  // Contenu & intégrations
  [channelCommand, 'auto_thread'],
  [channelhealthCommand, 'channel_health'],
  [serverstatsCommand, 'analytics'],
  [statsCommand, 'analytics'],
  [invitesCommand, 'analytics'],
  [widgetCommand, 'analytics'],
  [pulseCommand, 'analytics'],
  [postCommand, 'news'],
  [linkCommand, 'channel_links'],
]);

const COMMAND_MODULE_BY_NAME = new Map<string, string>();
for (const [definition, moduleKey] of COMMAND_MODULES) {
  COMMAND_MODULE_BY_NAME.set(definition.data.name, moduleKey);
}

/**
 * Résolution par le nom effectivement déployé, celui que porte l'interaction.
 * La table est construite à partir des mêmes objets, donc la langue de
 * l'instance est déjà prise en compte au démarrage.
 */
export function getCommandModuleKey(commandName: string): string | undefined {
  return COMMAND_MODULE_BY_NAME.get(commandName);
}

/**
 * Portée de déploiement d'une commande.
 *
 * Discord ne sait pas retirer une commande *globale* sur un seul serveur : tant
 * que les commandes étaient toutes globales, éteindre un module laissait ses
 * commandes visibles partout, et le bot ne pouvait que les refuser à
 * l'exécution. Les commandes passent donc au scope guilde, où le déploiement
 * lui-même n'envoie que celles des modules allumés.
 *
 * - `guild`  : déployée serveur par serveur, selon l'état de son module. Défaut.
 * - `global` : reste globale. Réservé à ce qui doit fonctionner *avant* qu'un
 *              serveur soit activé (il n'a alors aucune commande de guilde) ou
 *              en dehors de tout serveur.
 * - `guild+dm` : deux exemplaires. Celui de guilde suit son module ; l'exemplaire
 *              global est restreint aux contextes privés, pour ne pas réapparaître
 *              dans les serveurs où le module est coupé.
 */
export type CommandDeploymentScope = 'guild' | 'global' | 'guild+dm';

const COMMAND_DEPLOYMENT = new Map<ApplicationCommandDefinition, CommandDeploymentScope>([
  // Amorçage : un serveur non activé ne reçoit aucune commande de guilde, il
  // lui faut donc une commande globale pour s'activer, et pour accepter le pont
  // d'un serveur déjà activé.
  [activateCommand, 'global'],
  [linkCommand, 'global'],

  // Utilitaires sans serveur : répondent en message privé, où les commandes de
  // guilde n'existent pas.
  [helpCommand, 'global'],
  [dashboardCommand, 'global'],
  [pingCommand, 'global'],
  [optOutCommand, 'global'],
  [privacyCommand, 'global'],

  // `/ticket open` sait ouvrir un ticket depuis les MP en choisissant parmi les
  // serveurs communs (commands/utility/ticket.ts). Le retirer du scope global
  // aurait supprimé ce parcours ; le garder seulement global aurait empêché de
  // le dépublier serveur par serveur. D'où les deux exemplaires.
  [ticketCommand, 'guild+dm'],
]);

export function getCommandDeploymentScope(
  command: ApplicationCommandDefinition,
): CommandDeploymentScope {
  return COMMAND_DEPLOYMENT.get(command) ?? 'guild';
}

/**
 * Menus contextuels laissés globaux.
 *
 * Discord plafonne à 5 entrées User et 5 Message *par scope*. Les huit menus
 * globaux plus les deux menus de guilde donneraient 6 User sur un même serveur,
 * au-delà du plafond : ils ne peuvent pas tous descendre au scope guilde. Leur
 * garde reste donc celle de l'exécution (`enforceModuleGate`).
 */
export const globalOnlyContextCommands: ContextCommandDefinition[] = globalContextCommands;

/** Commandes slash candidates au déploiement par serveur. */
export const guildScopedCommands: SlashCommandDefinition[] = commands.filter(
  (command) => getCommandDeploymentScope(command) !== 'global',
);

/** Commandes qui restent publiées globalement, menus contextuels compris. */
export const globalScopedCommands: ApplicationCommandDefinition[] = [
  ...commands.filter((command) => getCommandDeploymentScope(command) !== 'guild'),
  ...globalOnlyContextCommands,
];
