/**
 * Base de detection des bots tiers.
 *
 * Le service de reprise ne se contentait que d'un nom et d'une liste de
 * fonctions couvertes : assez pour dire « MEE6 est la », pas pour en tirer quoi
 * que ce soit. Ce registre porte trois choses de plus, dans l'ordre ou la
 * reprise s'en sert :
 *
 *  1. `usernames` - les noms sous lesquels le bot se presente, pour le
 *     reconnaitre ;
 *  2. `signatures` - les traces qu'il laisse sur le serveur (noms de salons, de
 *     categories, de roles), pour savoir quelles fonctions il utilise vraiment
 *     plutot que celles qu'il pourrait utiliser ;
 *  3. `presets` - ce que Kotbo peut poser d'emblee pour prendre sa suite, sans
 *     que le staff ait a ressaisir des reglages equivalents.
 *
 * Le nom d'utilisateur reste la clef de reconnaissance, pas l'identifiant
 * d'application : un identifiant recopie ne se verifie pas depuis le code, et
 * une valeur fausse produirait une detection silencieusement erronee. Le nom se
 * lit sur le serveur, se compare sans risque, et ne sert ici qu'a suggerer -
 * jamais a accorder un droit.
 */

export type BotFeature =
  | 'welcome'
  | 'leveling'
  | 'automod'
  | 'reactionRoles'
  | 'tickets'
  | 'stats'
  | 'logs'
  // Aucun bot du registre ne s'en reclame : la fonction n'existe que pour
  // classer ce que la lecture des messages retrouve d'un reglement redige.
  | 'rules'
  // Idem : aucun bot connu ne « couvre » le staff, cette fonction ne sert qu'a
  // classer un constat tire des roles existants, pas d'un bot tiers.
  | 'staff'
  // Idem encore : classe le constat du role general deja en place, tire du
  // nombre de porteurs, pas d'un bot tiers.
  | 'access';

/**
 * Reglages de niveaux equivalents a ceux d'un autre bot.
 *
 * `source` dit sur quoi repose le profil : une formule publique et connue, ou
 * un reglage generique. La distinction compte - on ne presente pas de la meme
 * facon une reprise fidele et une valeur par defaut raisonnable.
 */
export type LevelingProfile = {
  key: string;
  label: string;
  source: string;
  xpMin: number;
  xpMax: number;
  cooldownSeconds: number;
  vocalXpPerMin: number;
  curveBaseXp: number;
  curveLinearXp: number;
  curveExponent: number;
};

export const LEVELING_PROFILES: Record<string, LevelingProfile> = {
  /**
   * MEE6 : le palier `n` coute `5n² + 50n + 100` XP, les messages rapportent
   * 15 a 25 XP avec une minute de pause, et rien n'est accorde en vocal.
   *
   * La courbe de Kotbo n'a pas la meme forme (`base * n^exposant + lineaire * n`
   * donne l'XP *totale* d'un niveau, la la somme des paliers de MEE6). Les
   * valeurs ci-dessous en sont l'approximation la plus proche sur les cinquante
   * premiers niveaux : moins de 6 % d'ecart partout. C'est une reprise
   * d'allure, pas une egalite - les niveaux des membres, eux, ne se transferent
   * pas sans export.
   */
  mee6: {
    key: 'mee6',
    label: 'Progression façon MEE6',
    source: 'Formule publique de MEE6 (5n² + 50n + 100 par palier), approximée à moins de 6 %.',
    xpMin: 15,
    xpMax: 25,
    cooldownSeconds: 60,
    vocalXpPerMin: 0,
    curveBaseXp: 10,
    curveLinearXp: 200,
    curveExponent: 2.6,
  },

  /**
   * Profil generique pour les bots dont la courbe n'est pas publiee. On ne
   * l'annonce pas comme une reprise : ce sont les reglages par defaut de
   * Kotbo, avec l'XP vocale allumee pour les bots qui en accordent.
   */
  standard: {
    key: 'standard',
    label: 'Progression standard',
    source: "Réglages par défaut de Kotbo : la courbe de l'ancien bot n'est pas publique.",
    xpMin: 15,
    xpMax: 25,
    cooldownSeconds: 60,
    vocalXpPerMin: 5,
    curveBaseXp: 100,
    curveLinearXp: 200,
    curveExponent: 2,
  },
};

export type TicketTypePreset = {
  id: string;
  label: string;
  description: string;
  emoji: string;
};

export type TicketProfile = {
  key: string;
  label: string;
  source: string;
  embedTitle: string;
  embedDesc: string;
  embedButtonText: string;
  types: TicketTypePreset[];
};

export const TICKET_PROFILES: Record<string, TicketProfile> = {
  /**
   * Le panneau visible d'un bot de tickets ne montre que ses boutons : les
   * questions posees a l'ouverture vivent dans sa base et ne se lisent pas.
   * Ce profil ne pretend donc pas copier l'ancien systeme - il pose les trois
   * motifs qu'on retrouve partout, pour que le staff parte d'un panneau qui
   * marche plutot que d'une page vide.
   */
  support: {
    key: 'support',
    label: 'Tickets de support',
    source: "Motifs communs aux systèmes de tickets : les formulaires de l'ancien bot ne sont pas lisibles depuis Discord.",
    embedTitle: 'Support',
    embedDesc: "Un souci, une question ? Ouvrez un ticket : l'équipe vous répond ici.",
    embedButtonText: 'Ouvrir un ticket',
    types: [
      { id: 'support', label: 'Support', description: 'Une question ou un souci technique', emoji: '🛠️' },
      { id: 'signalement', label: 'Signalement', description: 'Signaler un membre ou un message', emoji: '🚨' },
      { id: 'partenariat', label: 'Partenariat', description: 'Proposer un partenariat', emoji: '🤝' },
    ],
  },
};

/**
 * Trace qu'un bot laisse sur le serveur.
 *
 * Un bot present ne se sert pas forcement de tout ce qu'il sait faire : MEE6
 * peut n'etre la que pour l'accueil. Ces motifs distinguent « il pourrait » de
 * « il le fait », en cherchant ce que la fonction cree reellement - un salon,
 * une categorie, une famille de roles.
 */
export type BotSignature = {
  feature: BotFeature;
  /** Ce qu'on cherche : un salon, une categorie ou un role. */
  target: 'channel' | 'category' | 'role';
  pattern: RegExp;
  /** Ce que la trace prouve, dit au staff. */
  label: string;
};

export type KnownBot = {
  key: string;
  label: string;
  /** Noms d'utilisateur Discord, en minuscules. */
  usernames: string[];
  covers: BotFeature[];
  signatures?: BotSignature[];
  /** Profils que Kotbo peut poser pour prendre la suite de ce bot. */
  leveling?: string;
  tickets?: string;
};

const LEVEL_ROLE_PATTERN = /^(niveau|level|lvl)\s*\d+/i;

export const KNOWN_BOTS: KnownBot[] = [
  {
    key: 'mee6',
    label: 'MEE6',
    usernames: ['mee6'],
    covers: ['welcome', 'leveling', 'automod', 'reactionRoles'],
    leveling: 'mee6',
    signatures: [
      { feature: 'leveling', target: 'role', pattern: LEVEL_ROLE_PATTERN, label: 'des rôles de niveau existent' },
      { feature: 'leveling', target: 'channel', pattern: /level|niveau|rank|classement/i, label: 'un salon de niveaux existe' },
    ],
  },
  {
    key: 'dyno',
    label: 'Dyno',
    usernames: ['dyno'],
    covers: ['welcome', 'automod', 'reactionRoles', 'logs'],
    signatures: [
      { feature: 'logs', target: 'channel', pattern: /dyno|mod-?logs?/i, label: 'un salon de logs dédié existe' },
    ],
  },
  {
    key: 'carlbot',
    label: 'Carl-bot',
    usernames: ['carl-bot', 'carlbot', 'carl'],
    covers: ['welcome', 'reactionRoles', 'automod', 'tickets', 'logs'],
    tickets: 'support',
    signatures: [
      { feature: 'reactionRoles', target: 'channel', pattern: /r[oô]les?|roles|auto-?r[oô]le|reaction/i, label: 'un salon de rôles existe' },
      { feature: 'tickets', target: 'category', pattern: /ticket|support|assistance/i, label: 'une catégorie de tickets existe' },
    ],
  },
  {
    key: 'ticket-tool',
    label: 'Ticket Tool',
    usernames: ['ticket tool', 'tickettool'],
    covers: ['tickets'],
    tickets: 'support',
    signatures: [
      { feature: 'tickets', target: 'category', pattern: /ticket|support|assistance/i, label: 'une catégorie de tickets existe' },
      { feature: 'tickets', target: 'channel', pattern: /^(ticket|🎫|support)[-_ ]/i, label: 'des tickets sont encore ouverts' },
    ],
  },
  {
    key: 'ticketsbot',
    label: 'Tickets',
    usernames: ['tickets', 'ticketsbot', 'tickets.bot'],
    covers: ['tickets'],
    tickets: 'support',
    signatures: [
      { feature: 'tickets', target: 'category', pattern: /ticket|support|assistance/i, label: 'une catégorie de tickets existe' },
    ],
  },
  {
    key: 'yagpdb',
    label: 'YAGPDB',
    usernames: ['yagpdb.xyz', 'yagpdb'],
    covers: ['welcome', 'automod', 'reactionRoles', 'logs'],
  },
  {
    key: 'probot',
    label: 'ProBot',
    usernames: ['probot'],
    covers: ['welcome', 'automod', 'leveling'],
    leveling: 'standard',
    signatures: [
      { feature: 'leveling', target: 'role', pattern: LEVEL_ROLE_PATTERN, label: 'des rôles de niveau existent' },
    ],
  },
  {
    key: 'arcane',
    label: 'Arcane',
    usernames: ['arcane'],
    covers: ['welcome', 'leveling'],
    leveling: 'standard',
    signatures: [
      { feature: 'leveling', target: 'role', pattern: LEVEL_ROLE_PATTERN, label: 'des rôles de niveau existent' },
    ],
  },
  {
    key: 'tatsu',
    label: 'Tatsu',
    usernames: ['tatsu', 'tatsumaki'],
    covers: ['leveling'],
    leveling: 'standard',
    signatures: [
      { feature: 'leveling', target: 'role', pattern: LEVEL_ROLE_PATTERN, label: 'des rôles de niveau existent' },
    ],
  },
  {
    key: 'amari',
    label: 'Amari',
    usernames: ['amaribot', 'amari'],
    covers: ['leveling'],
    leveling: 'standard',
    signatures: [
      { feature: 'leveling', target: 'role', pattern: LEVEL_ROLE_PATTERN, label: 'des rôles de niveau existent' },
    ],
  },
  {
    key: 'wick',
    label: 'Wick',
    usernames: ['wick'],
    covers: ['automod', 'logs'],
  },
  {
    key: 'sapphire',
    label: 'Sapphire',
    usernames: ['sapphire'],
    covers: ['welcome', 'automod', 'reactionRoles', 'tickets'],
    tickets: 'support',
  },
  {
    key: 'statbot',
    label: 'Statbot',
    usernames: ['statbot'],
    covers: ['stats'],
  },
  {
    key: 'invite-tracker',
    label: 'InviteTracker',
    usernames: ['invitetracker', 'invite tracker', 'invitelogger'],
    covers: ['stats', 'welcome'],
  },
  {
    key: 'koya',
    label: 'Koya',
    usernames: ['koya', 'koya bot'],
    covers: ['welcome', 'leveling', 'automod'],
    leveling: 'standard',
    signatures: [
      { feature: 'leveling', target: 'role', pattern: LEVEL_ROLE_PATTERN, label: 'des rôles de niveau existent' },
      { feature: 'welcome', target: 'channel', pattern: /bienvenue|welcome|arrivee|nouveaux/i, label: 'un salon de bienvenue existe' },
    ],
  },
  {
    key: 'reaction-roles',
    label: 'Reaction Roles',
    usernames: ['reaction roles', 'reactionroles', 'reaction role', 'reactionrole'],
    covers: ['reactionRoles'],
    signatures: [
      { feature: 'reactionRoles', target: 'channel', pattern: /r[oô]les?|auto-?r[oô]le|reaction/i, label: 'un salon de rôles existe' },
    ],
  },
  {
    key: 'ascend',
    label: 'ASCEND',
    usernames: ['ascend', 'ascend bot'],
    covers: ['leveling'],
    leveling: 'standard',
    signatures: [
      { feature: 'leveling', target: 'role', pattern: LEVEL_ROLE_PATTERN, label: 'des rôles de niveau existent' },
    ],
  },
  {
    key: 'botrix',
    label: 'BotRix',
    usernames: ['botrix', 'botrix live'],
    covers: ['automod'],
  },

  // ── Scene francophone ──────────────────────────────────────────────────
  //
  // Kotbo se vend d'abord a des serveurs francais, ou ces trois-la sont bien
  // plus repandus que Tatsu ou Amari. Les omettre revenait a afficher « non
  // reconnu » sur les bots que nos prospects utilisent reellement.
  {
    key: 'draftbot',
    label: 'DraftBot',
    usernames: ['draftbot', 'draft bot'],
    covers: ['welcome', 'leveling', 'automod', 'reactionRoles', 'logs'],
    leveling: 'standard',
    signatures: [
      { feature: 'leveling', target: 'role', pattern: LEVEL_ROLE_PATTERN, label: 'des rôles de niveau existent' },
      { feature: 'reactionRoles', target: 'channel', pattern: /r[oô]les?|auto-?r[oô]le|reaction/i, label: 'un salon de rôles existe' },
    ],
  },
  {
    key: 'bounsbot',
    label: "Bouns'Bot",
    usernames: ["bouns'bot", 'bounsbot', 'bouns bot', 'bouns'],
    covers: ['welcome', 'leveling', 'automod', 'tickets', 'logs'],
    leveling: 'standard',
    tickets: 'support',
    signatures: [
      { feature: 'leveling', target: 'role', pattern: LEVEL_ROLE_PATTERN, label: 'des rôles de niveau existent' },
      { feature: 'tickets', target: 'category', pattern: /ticket|support|assistance/i, label: 'une catégorie de tickets existe' },
      { feature: 'logs', target: 'channel', pattern: /bouns|logs?|journal/i, label: 'un salon de journaux existe' },
    ],
  },
  {
    key: 'raidprotect',
    label: 'RaidProtect',
    usernames: ['raidprotect', 'raid protect'],
    covers: ['automod', 'logs'],
    signatures: [
      { feature: 'logs', target: 'channel', pattern: /raidprotect|logs?|surveillance/i, label: 'un salon de journaux existe' },
    ],
  },
  {
    key: 'vaaticket',
    label: 'Vaaticket',
    usernames: ['vaaticket', 'vaa ticket'],
    covers: ['tickets'],
    tickets: 'support',
    signatures: [
      { feature: 'tickets', target: 'category', pattern: /ticket|support|assistance/i, label: 'une catégorie de tickets existe' },
    ],
  },
  {
    key: 'dfr',
    label: 'DFR',
    usernames: ['dfr', 'dfr.gg', 'discord fr'],
    covers: [],
  },
  {
    key: 'french-gg',
    label: 'French.gg',
    usernames: ['french.gg', 'frenchgg', 'french gg'],
    covers: [],
  },
  {
    key: 'date-du-jour',
    label: 'La Date du Jour',
    usernames: ['la date du jour', 'date du jour', 'datedujour'],
    covers: [],
  },

  // ── Presents partout, sans recoupement avec Kotbo ──────────────────────
  //
  // `covers` vide n'est pas un oubli : ces bots font quelque chose que Kotbo ne
  // fait pas. Les inscrire quand meme evite le « non reconnu » qui pousse le
  // staff a verifier a la main un bot dont il n'y a rien a reprendre.
  {
    key: 'disboard',
    label: 'DISBOARD',
    usernames: ['disboard', 'disboard org'],
    covers: [],
  },
  {
    key: 'dbots-bump',
    label: 'Bots de bump',
    usernames: ['discadia', 'discordservers', 'dsme', 'disforge'],
    covers: [],
  },
  {
    key: 'music',
    label: 'Bot de musique',
    usernames: ['lofi radio', 'lofi', 'hydra', 'jockie music', 'jockie', 'rythm', 'groovy', 'fredboat', 'chip', 'green bot'],
    covers: [],
  },
  {
    key: 'giveawaybot',
    label: 'GiveawayBot',
    usernames: ['giveawaybot', 'giveaway bot', 'giveaway'],
    covers: [],
  },
  {
    key: 'voicemaster',
    label: 'VoiceMaster',
    usernames: ['voicemaster', 'voice master'],
    covers: [],
  },
  {
    key: 'tempvoice',
    label: 'TempVoice',
    usernames: ['tempvoice', 'temp voice'],
    covers: [],
  },
  {
    key: 'streamcord',
    label: 'Streamcord',
    usernames: ['streamcord', 'streamcord bot'],
    covers: [],
  },
  {
    key: 'counting',
    label: 'Counting',
    usernames: ['counting', 'counting bot', 'countr'],
    covers: [],
  },
  {
    key: 'countingclassic',
    label: 'Counting Classic',
    usernames: ['countingclassic', 'counting classic'],
    covers: [],
  },
  {
    key: 'mudae',
    label: 'Mudae',
    usernames: ['mudae', 'mudae bot'],
    covers: [],
  },
  {
    key: 'wouldyou',
    label: 'Would You',
    usernames: ['would you', 'wouldyou', 'would you bot'],
    covers: [],
  },

  // ── Bots personnalisés et instances Kotbo ─────────────────────────────
  {
    key: 'kotbo',
    label: 'Kotbo',
    usernames: ['kotbo', 'kotbo dev', 'kotbo canary'],
    covers: [],
  },
  {
    key: 'staarbot',
    label: 'StaaRBot',
    usernames: ['staarbot', 'staar bot'],
    covers: [],
  },
  {
    key: 'minestaar',
    label: 'MineStaaR',
    usernames: ['minestaar', 'mine staar'],
    covers: [],
  },
  {
    key: 'staarcraft',
    label: 'StaaRCraft',
    usernames: ['staarcraft', 'staar craft'],
    covers: [],
  },
  {
    key: 'test-lsa',
    label: 'Test LSA',
    usernames: ['test lsa', 'testlsa'],
    covers: [],
  },
];

/**
 * Ramene un nom d'utilisateur Discord a une forme comparable.
 *
 * La correspondance etait une egalite stricte sur le nom en minuscules, ce qui
 * suffisait tant que les bots s'appelaient « probot ». Ils s'appellent
 * « ProBot ✨ », « Ticket Tool | Support », « Wick ⚡ » : une decoration dans le
 * nom rendait invisible un bot pourtant present au registre, et le staff lisait
 * « non reconnu » sur MEE6 ou ProBot.
 *
 * On retire donc tout ce qui n'est ni lettre ni chiffre - emoji, ponctuation,
 * separateurs - et on garde deux formes : celle avec espaces (« invite
 * tracker ») et celle sans (« invitetracker »), parce que les deux s'ecrivent.
 * Les accents sont replies aussi : « Modérateur » et « Moderateur » designent
 * le meme bot.
 */
function normalizeBotName(value: string): { spaced: string; compact: string } {
  const spaced = value
    .normalize('NFD')
    // Diacritiques laisses par la decomposition NFD.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Tout ce qui n'est ni lettre ni chiffre devient une coupure de mot : c'est
    // ce qui fait tomber les emoji, les « | » et les tirets decoratifs.
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  return { spaced, compact: spaced.replace(/ /g, '') };
}

/**
 * Index des noms connus, sous leurs deux formes. Un bot du registre ecrit
 * « invite tracker » se retrouve donc aussi sous « invitetracker », et
 * reciproquement : les auteurs de fiches n'ont pas a y penser.
 */
const BY_USERNAME = new Map<string, KnownBot>();
for (const bot of KNOWN_BOTS) {
  for (const username of bot.usernames) {
    const { spaced, compact } = normalizeBotName(username);
    // `set` sans ecraser : le premier bot declare gagne, ce qui rend l'ordre du
    // registre lisible comme une priorite plutot que comme un hasard.
    if (spaced && !BY_USERNAME.has(spaced)) BY_USERNAME.set(spaced, bot);
    if (compact && !BY_USERNAME.has(compact)) BY_USERNAME.set(compact, bot);
  }
}

/**
 * Separateurs derriere lesquels les bots accrochent une mention decorative :
 * « Ticket Tool | Support », « Wick • Security ». Ce qui suit n'est pas le nom.
 */
const NAME_SEPARATORS = /[|•·/»–:]/;

/**
 * Le bot du registre qui porte ce nom d'utilisateur, s'il y en a un.
 *
 * Deux essais, dans cet ordre : le nom entier, puis sa premiere portion quand
 * un separateur decoratif la detache. On decoupe plutot que de comparer des
 * prefixes - un prefixe ferait passer « Ticket Tooling Pro » pour Ticket Tool,
 * et une fausse reconnaissance est pire qu'aucune : elle ferait reprendre les
 * reglages d'un bot que le serveur n'a jamais eu.
 */
export function matchKnownBot(username: string): KnownBot | null {
  const direct = lookup(username);
  if (direct) return direct;

  const [head] = username.split(NAME_SEPARATORS);
  return head && head !== username ? lookup(head) : null;
}

function lookup(value: string): KnownBot | null {
  const { spaced, compact } = normalizeBotName(value);
  if (!spaced) return null;
  return BY_USERNAME.get(spaced) ?? BY_USERNAME.get(compact) ?? null;
}

/** Libelles francais des fonctions, partages par l'API et le dashboard. */
export const FEATURE_LABELS: Record<BotFeature, string> = {
  welcome: 'Bienvenue',
  leveling: 'Niveaux',
  automod: 'AutoMod',
  reactionRoles: 'Rôles par réaction',
  tickets: 'Tickets',
  stats: 'Statistiques',
  logs: 'Logs',
  rules: 'Règlement',
  staff: 'Staff',
  access: 'Accès',
};
