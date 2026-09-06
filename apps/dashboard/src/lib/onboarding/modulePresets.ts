/**
 * La matiere des ecrans ajoutes : economie, journalisation, equipe, animation.
 *
 * Meme principe que `presets.ts`, applique aux modules que le parcours ne
 * couvrait pas. Aucun de ces ecrans ne demande de saisir un bareme : on choisit
 * une allure parmi trois, et la page dediee du tableau de bord garde le detail
 * pour le jour ou l'on saura quoi corriger. Un curseur d'XP par message pose le
 * jour de la decouverte est un curseur pose au hasard.
 */
import { m } from '../i18n';

// ── Écran « économie » ───────────────────────────────────────────────────────

export type EconomyRhythm = 'discreet' | 'standard' | 'generous';

/**
 * Le rythme des gains, en trois reglages plutot qu'en cinq champs.
 *
 * Ce qui distingue reellement deux economies de serveur, c'est la vitesse a
 * laquelle on accumule : une monnaie qui pleut ne s'echange plus contre rien,
 * une monnaie rare ne circule pas. Les trois allures encadrent le `/daily` et
 * sa recharge, le reste suit.
 */
export const ECONOMY_RHYTHMS: {
  key: EconomyRhythm;
  icon: string;
  label: () => string;
  pitch: () => string;
  detail: () => string;
  config: { dailyRewardMin: number; dailyRewardMax: number; dailyCooldownHour: number };
}[] = [
  {
    key: 'discreet',
    icon: 'feather',
    label: () => m.onb_economy_rhythm_discreet(),
    pitch: () => m.onb_economy_rhythm_discreet_pitch(),
    detail: () => m.onb_economy_rhythm_discreet_detail(),
    config: { dailyRewardMin: 20, dailyRewardMax: 60, dailyCooldownHour: 24 },
  },
  {
    key: 'standard',
    icon: 'sliders-horizontal',
    label: () => m.onb_economy_rhythm_standard(),
    pitch: () => m.onb_economy_rhythm_standard_pitch(),
    detail: () => m.onb_economy_rhythm_standard_detail(),
    config: { dailyRewardMin: 50, dailyRewardMax: 150, dailyCooldownHour: 20 },
  },
  {
    key: 'generous',
    icon: 'zap',
    label: () => m.onb_economy_rhythm_generous(),
    pitch: () => m.onb_economy_rhythm_generous_pitch(),
    detail: () => m.onb_economy_rhythm_generous_detail(),
    config: { dailyRewardMin: 120, dailyRewardMax: 300, dailyCooldownHour: 12 },
  },
];

/**
 * Quelques monnaies toutes faites, parce que nommer sa monnaie est la premiere
 * chose amusante du parcours et la derniere qu'on veuille rater.
 *
 * Le champ reste libre : ces propositions ne sont la que pour eviter la page
 * blanche, et l'une d'elles reprend le nom du serveur des qu'on le connait.
 */
export const CURRENCY_SUGGESTIONS: { name: string; emoji: string }[] = [
  { name: 'Pièces', emoji: '🪙' },
  { name: 'Gemmes', emoji: '💎' },
  { name: 'Jetons', emoji: '🎟️' },
  { name: 'Étoiles', emoji: '⭐' },
  { name: 'Cœurs', emoji: '❤️' },
];

export type ShopPreset = {
  key: string;
  emoji: string;
  name: string;
  description: string;
  type: 'MATERIAL' | 'POTION' | 'ACCESSORY';
  price: number;
  rarity: 'COMMON' | 'UNCOMMON' | 'RARE';
  /** Ce que l'objet rend a la consommation. Zero : purement decoratif. */
  effect: { hpRestore?: number; energyRestore?: number; levelXpReward?: number };
  byDefault: boolean;
};

/**
 * Une boutique de depart, pas un catalogue.
 *
 * Trois objets suffisent a rendre une monnaie credible : quelque chose qui se
 * consomme, quelque chose qui aide, quelque chose qui se montre. Le reste
 * s'ajoute depuis la page Economie, une fois qu'on a vu ce que les membres
 * achetent reellement.
 */
export const SHOP_PRESETS: ShopPreset[] = [
  {
    key: 'potion',
    emoji: '🧪',
    name: 'Potion de soin',
    description: "Rend des points de vie pendant une aventure.",
    type: 'POTION',
    price: 120,
    rarity: 'COMMON',
    effect: { hpRestore: 50 },
    byDefault: true,
  },
  {
    key: 'energy',
    emoji: '⚡',
    name: "Fiole d'énergie",
    description: "Rend de l'énergie pour repartir à l'aventure plus tôt.",
    type: 'POTION',
    price: 200,
    rarity: 'UNCOMMON',
    effect: { energyRestore: 40 },
    byDefault: true,
  },
  {
    key: 'xp-boost',
    emoji: '📘',
    name: "Manuel d'expérience",
    description: "Verse un lot d'XP directement sur votre niveau.",
    type: 'MATERIAL',
    price: 350,
    rarity: 'RARE',
    effect: { levelXpReward: 500 },
    byDefault: true,
  },
  {
    key: 'trophy',
    emoji: '🏆',
    name: 'Trophée de collection',
    description: "Ne sert à rien, et c'est tout l'intérêt : il se possède.",
    type: 'ACCESSORY',
    price: 1000,
    rarity: 'RARE',
    effect: {},
    byDefault: false,
  },
];

// ── Écran « journalisation » ─────────────────────────────────────────────────

export type RetentionKey = 'short' | 'standard' | 'long';

/**
 * Combien de temps on garde ce qui s'est dit.
 *
 * Ce n'est pas qu'un reglage de stockage : c'est la fenetre pendant laquelle un
 * message supprime reste consultable. Trop courte, un signalement arrive apres
 * la disparition de la preuve ; trop longue, on conserve des annees de
 * conversations privees sans raison. Trente jours couvrent la quasi-totalite
 * des signalements.
 */
export const RETENTIONS: {
  key: RetentionKey;
  days: number;
  icon: string;
  label: () => string;
  pitch: () => string;
  detail: () => string;
}[] = [
  {
    key: 'short',
    days: 7,
    icon: 'clock',
    label: () => m.onb_logs_retention_short(),
    pitch: () => m.onb_logs_retention_short_pitch(),
    detail: () => m.onb_logs_retention_short_detail(),
  },
  {
    key: 'standard',
    days: 30,
    icon: 'calendar',
    label: () => m.onb_logs_retention_standard(),
    pitch: () => m.onb_logs_retention_standard_pitch(),
    detail: () => m.onb_logs_retention_standard_detail(),
  },
  {
    key: 'long',
    days: 90,
    icon: 'archive',
    label: () => m.onb_logs_retention_long(),
    pitch: () => m.onb_logs_retention_long_pitch(),
    detail: () => m.onb_logs_retention_long_detail(),
  },
];

// ── Écran « quêtes » ─────────────────────────────────────────────────────────

export type QuestPreset = {
  key: string;
  emoji: string;
  name: string;
  description: string;
  type: 'SEND_MESSAGES' | 'VOICE_MINUTES' | 'REACT_MESSAGES' | 'REPLY_MESSAGES' | 'CREATE_THREADS';
  frequency: 'DAILY' | 'WEEKLY';
  target: number;
  rewardCoins: number;
  rewardXp: number;
  byDefault: boolean;
};

/**
 * Cinq quetes qui donnent une raison de revenir demain.
 *
 * Elles visent des gestes ordinaires - parler, repondre, passer en vocal - et
 * non des exploits : une quete qu'on accomplit sans y penser est une quete
 * qu'on remarque en la validant, et c'est cette notification-la qui ramene.
 */
export const QUEST_PRESETS: QuestPreset[] = [
  {
    key: 'daily-messages',
    emoji: '💬',
    name: 'Prendre la parole',
    description: 'Envoyer 15 messages dans la journée.',
    type: 'SEND_MESSAGES',
    frequency: 'DAILY',
    target: 15,
    rewardCoins: 60,
    rewardXp: 100,
    byDefault: true,
  },
  {
    key: 'daily-voice',
    emoji: '🎧',
    name: 'Passer en vocal',
    description: 'Rester 20 minutes en vocal avec les autres.',
    type: 'VOICE_MINUTES',
    frequency: 'DAILY',
    target: 20,
    rewardCoins: 80,
    rewardXp: 150,
    byDefault: true,
  },
  {
    key: 'daily-react',
    emoji: '👍',
    name: 'Réagir aux autres',
    description: 'Réagir à 10 messages.',
    type: 'REACT_MESSAGES',
    frequency: 'DAILY',
    target: 10,
    rewardCoins: 30,
    rewardXp: 50,
    byDefault: true,
  },
  {
    key: 'daily-reply',
    emoji: '↩️',
    name: 'Répondre à quelqu’un',
    description: 'Répondre à 5 messages de membres.',
    type: 'REPLY_MESSAGES',
    frequency: 'DAILY',
    target: 5,
    rewardCoins: 40,
    rewardXp: 70,
    byDefault: false,
  },
  {
    key: 'weekly-threads',
    emoji: '🧵',
    name: 'Lancer une discussion',
    description: 'Ouvrir 3 fils dans la semaine.',
    type: 'CREATE_THREADS',
    frequency: 'WEEKLY',
    target: 3,
    rewardCoins: 250,
    rewardXp: 500,
    byDefault: false,
  },
];

// ── Écran « drops » ──────────────────────────────────────────────────────────

export type DropRhythm = 'rare' | 'standard' | 'frequent';

/**
 * A quelle frequence quelque chose tombe dans le salon.
 *
 * Un drop est une interruption : c'est ce qui fait sa valeur et ce qui fait son
 * danger. Toutes les six heures, on leve la tete ; toutes les vingt minutes, on
 * coupe le salon.
 */
export const DROP_RHYTHMS: {
  key: DropRhythm;
  intervalMinutes: number;
  icon: string;
  label: () => string;
  pitch: () => string;
  detail: () => string;
}[] = [
  {
    key: 'rare',
    intervalMinutes: 720,
    icon: 'moon',
    label: () => m.onb_drops_rhythm_rare(),
    pitch: () => m.onb_drops_rhythm_rare_pitch(),
    detail: () => m.onb_drops_rhythm_rare_detail(),
  },
  {
    key: 'standard',
    intervalMinutes: 240,
    icon: 'sun',
    label: () => m.onb_drops_rhythm_standard(),
    pitch: () => m.onb_drops_rhythm_standard_pitch(),
    detail: () => m.onb_drops_rhythm_standard_detail(),
  },
  {
    key: 'frequent',
    intervalMinutes: 90,
    icon: 'zap',
    label: () => m.onb_drops_rhythm_frequent(),
    pitch: () => m.onb_drops_rhythm_frequent_pitch(),
    detail: () => m.onb_drops_rhythm_frequent_detail(),
  },
];

// ── Écran « pilotage par IA » ────────────────────────────────────────────────

export type McpScope = 'read' | 'moderate' | 'full';

/**
 * Ce qu'une IA connectee a le droit de faire du serveur.
 *
 * La cle donne un acces reel : la question n'est pas decorative. Le perimetre
 * de lecture suffit a repondre a « qui a poste quoi cette semaine » sans qu'un
 * modele puisse bannir qui que ce soit, et c'est celui qu'on propose.
 */
export const MCP_SCOPES: {
  key: McpScope;
  icon: string;
  label: () => string;
  pitch: () => string;
  detail: () => string;
  permissions: string[];
}[] = [
  {
    key: 'read',
    icon: 'eye',
    label: () => m.onb_mcp_scope_read(),
    pitch: () => m.onb_mcp_scope_read_pitch(),
    detail: () => m.onb_mcp_scope_read_detail(),
    permissions: [
      'READ_STATS',
      'READ_MEMBERS',
      'READ_ANALYTICS',
      'READ_COMMUNITY',
      'READ_TICKETS',
      'READ_ECONOMY',
    ],
  },
  {
    key: 'moderate',
    icon: 'shield',
    label: () => m.onb_mcp_scope_moderate(),
    pitch: () => m.onb_mcp_scope_moderate_pitch(),
    detail: () => m.onb_mcp_scope_moderate_detail(),
    permissions: [
      'READ_STATS',
      'READ_MEMBERS',
      'READ_ANALYTICS',
      'READ_COMMUNITY',
      'READ_TICKETS',
      'READ_ECONOMY',
      'READ_SANCTIONS',
      'READ_MODERATION',
      'READ_STAFF',
      'WRITE_SANCTIONS',
      'WRITE_TICKETS',
    ],
  },
  {
    key: 'full',
    icon: 'command',
    label: () => m.onb_mcp_scope_full(),
    pitch: () => m.onb_mcp_scope_full_pitch(),
    detail: () => m.onb_mcp_scope_full_detail(),
    // Toutes celles que le bot connait. `WRITE_MESSAGES` en fait partie : c'est
    // ce qui permet a une IA de publier une annonce, et c'est aussi ce qui la
    // rend capable d'ecrire n'importe quoi dans n'importe quel salon. Le
    // perimetre le dit, l'ecran le repete.
    permissions: [
      'READ_STATS',
      'READ_MEMBERS',
      'READ_SANCTIONS',
      'READ_STAFF',
      'READ_TICKETS',
      'READ_COMMUNITY',
      'READ_ECONOMY',
      'READ_MODERATION',
      'READ_ANALYTICS',
      'READ_WORKFLOWS',
      'WRITE_SANCTIONS',
      'WRITE_MESSAGES',
      'WRITE_TICKETS',
      'WRITE_COMMUNITY',
      'WRITE_MEMBERS',
      'WRITE_WORKFLOWS',
    ],
  },
];
