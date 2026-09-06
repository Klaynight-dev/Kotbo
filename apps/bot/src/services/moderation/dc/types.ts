/**
 * dc/types.ts - Types partagés du moteur intelligent de détection de double comptes.
 *
 * Le moteur produit des "signaux" (Signal). Chaque signal appartient à une
 * *famille* (SignalFamily). Le scoring combine les signaux en tenant compte des
 * familles : redondance à l'intérieur d'une famille (pénalité), corroboration
 * entre familles différentes (bonus).
 */

// ─── Types de signaux ──────────────────────────────────────────────────────────
export type DcSignalType =
  // Identité
  | 'username_similarity'
  | 'username_numeric_suffix'
  | 'shared_avatar'
  | 'no_profile_picture'
  // Temporel (métadonnées de compte)
  | 'young_account'
  | 'creation_proximity'
  | 'join_proximity'
  | 'sequential_ids'
  | 'role_pattern'
  // Réseau / graphe social
  | 'invite_link'
  | 'invite_loop'
  | 'inviter_is_suspected_dc'
  | 'same_inviter_multiple'
  | 'mention_network'
  | 'never_interact'
  // Comportemental (analyse des messages)
  | 'stylometry_match'
  | 'ngram_match'
  | 'activity_heatmap'
  | 'temporal_exclusivity'
  | 'cadence_match'
  | 'daily_pattern'
  // Technique (vérif OAuth)
  | 'shared_ip'
  | 'ip_subnet'
  | 'device_fingerprint'
  | 'oauth_connections'
  | 'cross_server_alt'
  // Modération
  | 'banned_alt'
  | 'repeat_rejoiner'
  | 'shared_sanction_history'
  | 'cross_server_link'
  // Vocal
  | 'voice_alternation'
  | 'shared_locale'
  | 'low_activity_pair';

export type SignalFamily =
  | 'IDENTITY'
  | 'TEMPORAL'
  | 'NETWORK'
  | 'BEHAVIORAL'
  | 'TECHNICAL'
  | 'MODERATION'
  | 'VOICE';

/** Mappe chaque type de signal à sa famille (pour corroboration/redondance). */
export const SIGNAL_FAMILY: Record<DcSignalType, SignalFamily> = {
  username_similarity: 'IDENTITY',
  username_numeric_suffix: 'IDENTITY',
  shared_avatar: 'IDENTITY',
  no_profile_picture: 'IDENTITY',

  young_account: 'TEMPORAL',
  creation_proximity: 'TEMPORAL',
  join_proximity: 'TEMPORAL',
  sequential_ids: 'TEMPORAL',
  role_pattern: 'IDENTITY',

  invite_link: 'NETWORK',
  invite_loop: 'NETWORK',
  inviter_is_suspected_dc: 'NETWORK',
  same_inviter_multiple: 'NETWORK',
  mention_network: 'NETWORK',
  never_interact: 'NETWORK',

  stylometry_match: 'BEHAVIORAL',
  ngram_match: 'BEHAVIORAL',
  activity_heatmap: 'BEHAVIORAL',
  temporal_exclusivity: 'BEHAVIORAL',
  cadence_match: 'BEHAVIORAL',
  daily_pattern: 'BEHAVIORAL',

  shared_ip: 'TECHNICAL',
  ip_subnet: 'TECHNICAL',
  device_fingerprint: 'TECHNICAL',
  oauth_connections: 'TECHNICAL',
  cross_server_alt: 'TECHNICAL',

  banned_alt: 'MODERATION',
  repeat_rejoiner: 'MODERATION',
  shared_sanction_history: 'MODERATION',
  // Un lien posé par le staff d'un autre serveur est une décision de modération,
  // pas une empreinte technique : famille MODERATION, distincte de cross_server_alt.
  cross_server_link: 'MODERATION',

  voice_alternation: 'VOICE',
  shared_locale: 'BEHAVIORAL',
  low_activity_pair: 'BEHAVIORAL',
};

export type DcSignal = {
  type: DcSignalType;
  /** Score brut 0-100 (confiance intrinsèque du signal). */
  score: number;
  label: string;
  matchedUserId?: string;
  detail?: string;
};

// ─── Profil comportemental d'un membre (extrait des MessageLog) ─────────────────
export type BehavioralProfile = {
  userId: string;
  messageCount: number;
  /** Heatmap d'activité aplatie sur 168 slots (7 jours × 24 h), normalisée (somme = 1). */
  heatmap: number[];
  /** Timestamps (ms) arrondis à la minute - pour l'exclusivité temporelle. */
  activeMinutes: Set<number>;
  /** Vecteur stylométrique : { feature → fréquence }. */
  styleVector: Record<string, number>;
  /** Ensemble des trigrammes de caractères les plus fréquents. */
  trigrams: Set<string>;
  /** Statistiques de cadence. */
  cadence: {
    avgLength: number;
    avgWords: number;
    emojiRate: number;
    capsRate: number;
    punctuationRate: number;
    medianGapSeconds: number; // intervalle médian entre messages consécutifs
  };
  /** IDs mentionnés dans les messages (graphe social). */
  mentions: Set<string>;
  /** Salons où le membre a été actif. */
  channels: Set<string>;
  /** Fenêtre temporelle couverte (premier / dernier message, ms). */
  firstMessageAt: number;
  lastMessageAt: number;
};

/** Seuil minimal de messages pour qu'un profil comportemental soit exploitable. */
export const MIN_MESSAGES_FOR_BEHAVIORAL = 20;
