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
import { pingCommand } from './commands/utility/ping.js';
import { postCommand } from './commands/utility/post.js';
import { profilCommand } from './commands/profile/profil.js';
import { profileCommand } from './commands/profile/profile.js';
import { rankCommand } from './commands/profile/rank.js';
import { rescanCommand } from './commands/moderation/rescan.js';
import { roleCommand } from './commands/moderation/role.js';
import { sanctionCommand, sanctionContextCommand } from './commands/moderation/sanction.js';
import { requestVerificationCommand, requestVerificationContextCommand } from './commands/moderation/request-verification.js';
import { sayCommand } from './commands/fun/say.js';
import { mpsayCommand } from './commands/fun/mpsay.js';
import { buyCommand } from './commands/economy/buy.js';
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
import { shopCommand } from './commands/economy/shop.js';
import { spawnItemCommand } from './commands/economy/spawnItem.js';
import { useCommand } from './commands/economy/use.js';
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
import { repCommand } from './commands/community/rep.js';
import { marketCommand } from './commands/economy/market.js';
import { questsCommand } from './commands/community/quests.js';
import { clanCommand } from './commands/community/clan.js';
import { rpgProfileCommand, rpgDailyCommand, rpgTravelCommand, rpgShopCommand, rpgInventoryCommand, rpgGuildCommand, rpgPayCommand, rpgSellCommand, rpgDropCommand, rpgAdminCommand, rpgFightCommand, rpgBossCommand, rpgBestiaryCommand, fishCommand } from './commands/fun/rpgEconomy.js';
import { topCommand } from './commands/profile/top.js';
import { inventaireCommand } from './commands/economy/inventaire.js';
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
  giveawayCommand,
  suggestCommand,
  suggestionConfigCommand,
  clearCommand,
  channelCommand,
  signalCommand,
  roleCommand,
  dashboardCommand,
  buyCommand,
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
  shopCommand,
  spawnItemCommand,
  useCommand,
  workCommand,
  linkCommand,
  staffserverCommand,
  channelhealthCommand,
  repCommand,
  marketCommand,
  questsCommand,
  clanCommand,
  rpgProfileCommand,
  rpgDailyCommand,
  rpgTravelCommand,
  rpgShopCommand,
  rpgInventoryCommand,
  rpgGuildCommand,
  rpgPayCommand,
  rpgSellCommand,
  rpgDropCommand,
  rpgAdminCommand,
  rpgFightCommand,
  rpgBossCommand,
  rpgBestiaryCommand,
  fishCommand,
  topCommand,
  inventaireCommand,
  widgetCommand,
  seasonsCommand,
  pulseCommand,
  evaluationsCommand,
  rappelCommand,
  levelingCommand,
  protectionCommand,
  auditCommand,
  reportCommand,
];

/**
 * Menus contextuels déployés globalement.
 *
 * Discord plafonne une application à 5 entrées de type User et 5 de type
 * Message au global — ces deux listes sont donc pleines et toute nouvelle
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
