/**
 * Ce qu'on choisit de configurer, avant de le configurer.
 *
 * Le parcours couvrait sept sujets et les imposait tous. C'etait tenable a onze
 * ecrans ; ce ne l'est plus des qu'on veut aussi proposer l'economie, les logs,
 * l'animation ou le pilotage par IA - un serveur d'entraide n'a que faire d'une
 * monnaie, et lui faire traverser deux ecrans pour la refuser est le meilleur
 * moyen de lui faire fermer l'onglet.
 *
 * D'ou une piste par sujet, et un ecran qui les presente toutes. Ce n'est pas
 * qu'une reduction de longueur : c'est le premier moment ou l'on voit
 * l'etendue de ce que le produit sait faire, et on la voit en la choisissant
 * plutot qu'en la subissant. Cocher « L'economie » n'engage a rien, mais
 * apprend que l'economie existe - ce qu'un parcours qui l'aurait cachee
 * n'aurait jamais transmis.
 *
 * Une piste decochee ne desactive rien : on ne pose simplement pas la question.
 * Le module garde son etat par defaut et la page dediee du tableau de bord
 * reste la pour plus tard. Decocher, c'est reporter, jamais eteindre - sans
 * quoi un clic distrait suffirait a priver un serveur de sa moderation.
 */
import { m } from '../i18n';
import type { ServerKind } from './presets';

export type TrackKey =
  | 'structure'
  | 'moderation'
  | 'logs'
  | 'greeting'
  | 'rules'
  | 'tickets'
  | 'levels'
  | 'economy'
  | 'animation'
  | 'staff'
  | 'mcp';

/**
 * Les trois familles de l'ecran de selection.
 *
 * Onze cases a cocher en une colonne se lisent comme une facture. Groupees, on
 * y reconnait trois intentions differentes - tenir le serveur debout, lui
 * donner une vie, garder la main dessus - et l'on coche par intention plutot
 * qu'article par article.
 */
export type TrackGroup = 'foundation' | 'life' | 'control';

export type Track = {
  key: TrackKey;
  group: TrackGroup;
  icon: string;
  label: () => string;
  pitch: () => string;
  /**
   * Ce que la piste change reellement sur Discord, en une phrase.
   *
   * C'est la ligne qui fait cocher : « une monnaie » ne dit rien, « une monnaie,
   * une boutique et un /daily » dit ce qu'on aura demain dans ses salons.
   */
  outcome: () => string;
  /** Duree indicative, en minutes. Affichee pour que la longueur soit un choix. */
  minutes: number;
  /** Cochee d'office selon ce qu'on a observe du serveur. */
  byDefault: (kind: ServerKind) => boolean;
};

export const TRACK_GROUPS: { key: TrackGroup; label: () => string; hint: () => string }[] = [
  { key: 'foundation', label: () => m.onb_track_group_foundation(), hint: () => m.onb_track_group_foundation_hint() },
  { key: 'life', label: () => m.onb_track_group_life(), hint: () => m.onb_track_group_life_hint() },
  { key: 'control', label: () => m.onb_track_group_control(), hint: () => m.onb_track_group_control_hint() },
];

export const TRACKS: Track[] = [
  {
    key: 'structure',
    group: 'foundation',
    icon: 'layout-grid',
    label: () => m.onb_track_structure(),
    pitch: () => m.onb_track_structure_pitch(),
    outcome: () => m.onb_track_structure_outcome(),
    minutes: 2,
    byDefault: () => true,
  },
  {
    key: 'moderation',
    group: 'foundation',
    icon: 'shield',
    label: () => m.onb_track_moderation(),
    pitch: () => m.onb_track_moderation_pitch(),
    outcome: () => m.onb_track_moderation_outcome(),
    minutes: 1,
    byDefault: () => true,
  },
  {
    key: 'logs',
    group: 'foundation',
    icon: 'scroll',
    label: () => m.onb_track_logs(),
    pitch: () => m.onb_track_logs_pitch(),
    outcome: () => m.onb_track_logs_outcome(),
    minutes: 1,
    byDefault: () => true,
  },
  {
    key: 'greeting',
    group: 'life',
    icon: 'door-open',
    label: () => m.onb_track_greeting(),
    pitch: () => m.onb_track_greeting_pitch(),
    outcome: () => m.onb_track_greeting_outcome(),
    minutes: 1,
    byDefault: () => true,
  },
  {
    key: 'rules',
    group: 'life',
    icon: 'book-open',
    label: () => m.onb_track_rules(),
    pitch: () => m.onb_track_rules_pitch(),
    outcome: () => m.onb_track_rules_outcome(),
    minutes: 2,
    // Un serveur habite a deja son reglement, ecrit a la main dans un salon.
    // Lui en proposer un second est le meilleur moyen de le voir refuser tout
    // l'ecran ; il reste cochable, il n'est simplement plus suppose.
    byDefault: (kind) => kind === 'new',
  },
  {
    key: 'tickets',
    group: 'life',
    icon: 'inbox',
    label: () => m.onb_track_tickets(),
    pitch: () => m.onb_track_tickets_pitch(),
    outcome: () => m.onb_track_tickets_outcome(),
    minutes: 1,
    byDefault: () => true,
  },
  {
    key: 'levels',
    group: 'life',
    icon: 'crown',
    label: () => m.onb_track_levels(),
    pitch: () => m.onb_track_levels_pitch(),
    outcome: () => m.onb_track_levels_outcome(),
    minutes: 2,
    byDefault: () => true,
  },
  {
    key: 'economy',
    group: 'life',
    icon: 'coins',
    label: () => m.onb_track_economy(),
    pitch: () => m.onb_track_economy_pitch(),
    outcome: () => m.onb_track_economy_outcome(),
    minutes: 3,
    // Une monnaie ne se subit pas : elle se decide. Proposee decochee, elle est
    // une decouverte ; cochee d'office, elle serait une surprise a desamorcer.
    byDefault: () => false,
  },
  {
    key: 'animation',
    group: 'life',
    icon: 'sparkles',
    label: () => m.onb_track_animation(),
    pitch: () => m.onb_track_animation_pitch(),
    outcome: () => m.onb_track_animation_outcome(),
    minutes: 3,
    byDefault: () => false,
  },
  {
    key: 'staff',
    group: 'control',
    icon: 'users',
    label: () => m.onb_track_staff(),
    pitch: () => m.onb_track_staff_pitch(),
    outcome: () => m.onb_track_staff_outcome(),
    minutes: 1,
    // Un serveur neuf n'a pas encore d'equipe a declarer : la question ne se
    // pose vraiment que la ou des roles de staff existent deja.
    byDefault: (kind) => kind === 'existing',
  },
  {
    key: 'mcp',
    group: 'control',
    icon: 'command',
    label: () => m.onb_track_mcp(),
    pitch: () => m.onb_track_mcp_pitch(),
    outcome: () => m.onb_track_mcp_outcome(),
    minutes: 1,
    byDefault: () => true,
  },
];

export function trackOf(key: TrackKey): Track | undefined {
  return TRACKS.find((track) => track.key === key);
}

/** Ce qui est coche a l'ouverture de l'ecran, d'apres ce qu'on sait du serveur. */
export function defaultTracks(kind: ServerKind): TrackKey[] {
  return TRACKS.filter((track) => track.byDefault(kind)).map((track) => track.key);
}

/** Le temps annonce pour une selection, arrondi a la minute. */
export function estimatedMinutes(tracks: readonly TrackKey[]): number {
  // Trois minutes de tronc commun : bienvenue, type de serveur, langue,
  // vocation et mise en service se traversent quelle que soit la selection.
  const base = 3;
  return base + TRACKS
    .filter((track) => tracks.includes(track.key))
    .reduce((total, track) => total + track.minutes, 0);
}
