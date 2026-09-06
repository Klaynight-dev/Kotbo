/**
 * Les reponses toutes faites du parcours, decrites une fois.
 *
 * Ce fichier ne connait ni l'ordre des ecrans ni leur nombre : il ne porte que
 * la matiere qu'ils presentent - vocations, niveaux de moderation, articles de
 * reglement, motifs de ticket, couleurs, rythmes de progression. L'ordre vit
 * dans `steps.ts`, ce qu'on choisit de configurer dans `tracks.ts`.
 *
 * Rien ici n'est une page blanche. Personne ne redige huit articles de
 * reglement ni ne calibre une courbe d'XP le jour ou il decouvre un bot : on
 * part de quelque chose de deja juste, et c'est de l'avoir ajuste qui fait
 * qu'on le considere comme sien.
 */
import type { ServerTemplateSection, StaffRolePower } from '../api';

export type ServerKind = 'new' | 'existing';
export type ThemeKey = 'gaming' | 'communaute' | 'entraide' | 'creation';
export type ModerationLevel = 'light' | 'standard' | 'strict';
export type LevelRhythm = 'calm' | 'standard' | 'intense';

export type Theme = {
  key: ThemeKey;
  label: string;
  pitch: string;
  icon: string;
  /**
   * Sections de la maquette retenues. `access` et `staff` n'en sont jamais
   * absentes : la premiere porte le role Membre a qui tous les salons fermes
   * sont rouverts, la seconde le role sans lequel les salons du staff ne
   * seraient visibles que du bot.
   */
  sections: ServerTemplateSection[];
};

export const THEMES: Theme[] = [
  {
    key: 'communaute',
    label: 'Une communauté',
    pitch: 'On discute, on se retrouve, on organise des choses ensemble.',
    icon: 'users',
    sections: ['access', 'security', 'staff', 'tickets', 'welcome', 'stats', 'text', 'fun', 'voice'],
  },
  {
    key: 'gaming',
    label: 'Du jeu',
    pitch: 'Des vocaux, des niveaux, une économie et de quoi se classer.',
    icon: 'trophy',
    sections: ['access', 'security', 'staff', 'tickets', 'welcome', 'stats', 'text', 'fun', 'bots', 'voice'],
  },
  {
    key: 'entraide',
    label: "De l'entraide",
    pitch: "On pose des questions, on y répond. Les tickets font le gros du travail.",
    icon: 'help-circle',
    sections: ['access', 'security', 'staff', 'tickets', 'welcome', 'text'],
  },
  {
    key: 'creation',
    label: 'De la création',
    pitch: 'On publie, on montre, on commente. Salons médias et vocaux ouverts.',
    icon: 'sparkles',
    sections: ['access', 'security', 'staff', 'tickets', 'welcome', 'stats', 'text', 'fun', 'voice'],
  },
];

export const MODERATION_LEVELS: {
  key: ModerationLevel;
  label: string;
  pitch: string;
  detail: string;
  icon: string;
}[] = [
  {
    key: 'light',
    label: 'Souple',
    pitch: 'Le strict nécessaire',
    detail:
      "Liens d'invitation et spam évident sont bloqués, le reste passe. À choisir si votre communauté est petite et se connaît.",
    icon: 'smile',
  },
  {
    key: 'standard',
    label: 'Équilibré',
    pitch: 'Ce que choisissent la plupart des serveurs',
    detail:
      "Filtres d'insultes, de liens et de spam, plus une détection de vague d'arrivées suspecte. Assez ferme sans être pénible.",
    icon: 'shield',
  },
  {
    key: 'strict',
    label: 'Strict',
    pitch: 'Pour un serveur exposé',
    detail:
      "Tous les filtres, seuils anti-raid resserrés, comptes trop récents mis à l'écart. À choisir si vous avez déjà subi des raids.",
    icon: 'lock',
  },
];

// ── Écran « langue » ─────────────────────────────────────────────────────────

/**
 * Une poignee de fuseaux, pas la liste complete.
 *
 * Le runtime du bot en connait plusieurs centaines et la page de reglages les
 * propose tous. Ici, un menu de six cents entrees serait une question a laquelle
 * personne ne repond : on montre les fuseaux qui couvrent la francophonie et
 * l'Europe, et le reglage complet reste dans le tableau de bord.
 */
export const COMMON_TIMEZONES: { value: string; label: string }[] = [
  { value: 'Europe/Paris', label: 'Paris, Bruxelles, Madrid' },
  { value: 'Europe/London', label: 'Londres, Lisbonne' },
  { value: 'Europe/Zurich', label: 'Genève, Zurich' },
  { value: 'America/Montreal', label: 'Montréal, Québec' },
  { value: 'Africa/Casablanca', label: 'Casablanca, Rabat' },
  { value: 'Indian/Reunion', label: 'La Réunion' },
  { value: 'America/New_York', label: 'New York, Toronto' },
  { value: 'UTC', label: 'UTC (heure universelle)' },
];

// ── Écran « règlement » ──────────────────────────────────────────────────────

export type RulePreset = {
  key: string;
  emoji: string;
  title: string;
  description: string;
  /** Retenu d'office a l'ouverture de l'ecran. */
  byDefault: boolean;
};

/**
 * Un reglement pret a publier, qu'on ajuste plutot qu'on ne redige.
 *
 * Personne n'ecrit huit articles depuis une page blanche le jour ou il decouvre
 * un bot. Ceux-ci couvrent ce qu'on retrouve sur presque tous les serveurs ; ils
 * s'editent sur place, et c'est cette edition qui fait qu'on les considere comme
 * les siens.
 */
export const RULE_PRESETS: RulePreset[] = [
  {
    key: 'respect',
    emoji: '🤝',
    title: 'Respect de tous',
    description:
      "Insultes, harcèlement, propos haineux, discriminations : aucun n'a sa place ici. On peut être en désaccord sans être désagréable.",
    byDefault: true,
  },
  {
    key: 'spam',
    emoji: '🔇',
    title: 'Pas de spam',
    description:
      "Messages répétés, mentions en rafale, majuscules permanentes : gardez les salons lisibles pour les autres.",
    byDefault: true,
  },
  {
    key: 'pub',
    emoji: '📢',
    title: 'Pas de publicité',
    description:
      "Aucune invitation vers un autre serveur ni promotion personnelle sans l'accord du staff, messages privés compris.",
    byDefault: true,
  },
  {
    key: 'nsfw',
    emoji: '🚫',
    title: 'Contenu interdit',
    description:
      "Rien de choquant, illégal ou à caractère sexuel. Cela vaut aussi pour les pseudos, avatars et bannières.",
    byDefault: true,
  },
  {
    key: 'channels',
    emoji: '🗂️',
    title: 'Chaque salon a son sujet',
    description:
      "Postez au bon endroit : c'est ce qui permet de retrouver une discussion plus tard sans tout relire.",
    byDefault: true,
  },
  {
    key: 'privacy',
    emoji: '🔒',
    title: 'Vie privée',
    description:
      "Ne publiez jamais d'informations personnelles, les vôtres ou celles d'un autre membre, sans son accord explicite.",
    byDefault: false,
  },
  {
    key: 'staff',
    emoji: '🛡️',
    title: 'Décisions du staff',
    description:
      "L'équipe tranche et peut sanctionner. Un désaccord se discute en ticket, pas en public.",
    byDefault: false,
  },
  {
    key: 'discord-tos',
    emoji: '📜',
    title: 'Conditions de Discord',
    description:
      "Les règles de Discord s'appliquent en plus des nôtres, et vous devez avoir l'âge minimum requis pour utiliser la plateforme.",
    byDefault: false,
  },
];

// ── Écran « support » ────────────────────────────────────────────────────────

export type TicketPreset = {
  key: string;
  emoji: string;
  label: string;
  description: string;
  /** Vocations pour lesquelles ce motif est coche d'office. */
  themes: ThemeKey[];
};

/**
 * Les motifs d'ouverture proposes sur le panneau de tickets.
 *
 * Coches d'apres la vocation deja choisie : un serveur d'entraide n'a pas les
 * memes demandes qu'un serveur de creation, et re-poser la question serait
 * demander deux fois la meme chose.
 */
export const TICKET_PRESETS: TicketPreset[] = [
  {
    key: 'question',
    emoji: '❓',
    label: 'Une question',
    description: 'Pour tout ce qui ne rentre nulle part ailleurs.',
    themes: ['communaute', 'gaming', 'entraide', 'creation'],
  },
  {
    key: 'help',
    emoji: '🆘',
    label: "Demande d'aide",
    description: "Un problème à résoudre, un coup de main à demander.",
    themes: ['entraide'],
  },
  {
    key: 'report',
    emoji: '⚠️',
    label: 'Signaler un membre',
    description: "Un comportement à porter à la connaissance du staff.",
    themes: ['communaute', 'gaming', 'entraide', 'creation'],
  },
  {
    key: 'bug',
    emoji: '🐛',
    label: 'Signaler un bug',
    description: "Quelque chose ne marche pas comme prévu.",
    themes: ['entraide', 'gaming'],
  },
  {
    key: 'apply',
    emoji: '📝',
    label: 'Candidature',
    description: "Rejoindre le staff, une équipe ou un projet.",
    themes: ['communaute', 'gaming'],
  },
  {
    key: 'partner',
    emoji: '🤝',
    label: 'Partenariat',
    description: "Proposer une collaboration entre serveurs ou créateurs.",
    themes: ['communaute', 'creation'],
  },
  {
    key: 'feedback',
    emoji: '💡',
    label: 'Suggestion',
    description: "Une idée pour améliorer le serveur.",
    themes: ['creation'],
  },
];

export function defaultTicketKeys(theme: ThemeKey): string[] {
  return TICKET_PRESETS.filter((entry) => entry.themes.includes(theme)).map((entry) => entry.key);
}

/**
 * La couleur des panneaux que le bot publie.
 *
 * Discord ne connait pas de couleur d'accent de serveur : cette teinte est
 * celle des embeds que Kotbo poste - panneau de tickets d'abord. C'est le seul
 * reglage du parcours qui ne change rien au fonctionnement, et c'est aussi
 * celui qu'on ouvre en premier : choisir une couleur, c'est commencer a
 * s'approprier ce qu'on installe.
 */
export const PANEL_COLORS: { value: string; label: string }[] = [
  { value: '#5865F2', label: 'Discord' },
  { value: '#00E5FF', label: 'Kotbo' },
  { value: '#10B981', label: 'Émeraude' },
  { value: '#F59E0B', label: 'Ambre' },
  { value: '#EF4444', label: 'Rouge' },
  { value: '#EC4899', label: 'Rose' },
  { value: '#8B5CF6', label: 'Violet' },
  { value: '#64748B', label: 'Ardoise' },
];

// ── Écran « progression » ────────────────────────────────────────────────────

/**
 * Le rythme des niveaux, en trois reglages plutot qu'en six curseurs.
 *
 * La page Niveaux du tableau de bord expose l'XP par message, le palier vocal,
 * le delai anti-farm et la courbe. Ici, on choisit une allure : le detail se
 * regle apres, quand on a vu tourner le systeme et qu'on sait ce qu'on veut
 * corriger.
 */
export const LEVEL_RHYTHMS: {
  key: LevelRhythm;
  label: string;
  pitch: string;
  detail: string;
  icon: string;
  config: { xpMin: number; xpMax: number; cooldownSeconds: number; vocalXpPerMin: number };
}[] = [
  {
    key: 'calm',
    label: 'Calme',
    pitch: 'Les niveaux montent lentement',
    detail:
      "Un palier se mérite sur plusieurs semaines. À choisir si les rôles de niveau doivent rester rares.",
    icon: 'smile',
    config: { xpMin: 5, xpMax: 10, cooldownSeconds: 90, vocalXpPerMin: 2 },
  },
  {
    key: 'standard',
    label: 'Équilibré',
    pitch: 'Le rythme par défaut de Kotbo',
    detail:
      "Un membre actif tous les jours passe les premiers niveaux dans la semaine, puis la courbe se resserre.",
    icon: 'sliders-horizontal',
    config: { xpMin: 15, xpMax: 25, cooldownSeconds: 60, vocalXpPerMin: 5 },
  },
  {
    key: 'intense',
    label: 'Nerveux',
    pitch: 'Ça monte vite, ça se voit',
    detail:
      "Les montées de niveau sont fréquentes et animent le salon. À choisir sur un serveur qui parle beaucoup.",
    icon: 'zap',
    config: { xpMin: 25, xpMax: 40, cooldownSeconds: 30, vocalXpPerMin: 10 },
  },
];

/** Les paliers proposes quand on rattache des roles existants. */
export const REWARD_TIERS = [5, 15, 30] as const;

