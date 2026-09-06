/**
 * Bibliothèque humaine - comment une automatisation se dit en français.
 *
 * Le catalogue de nœuds (`catalog.ts`) décrit ce que le moteur sait faire, en
 * termes de ports et de types. Cette bibliothèque décrit comment on le
 * *formule* : chaque déclencheur, action et condition y est une phrase à trous,
 * les trous étant des champs à remplir.
 *
 * L'éditeur ne fait rien d'autre que rendre ces phrases et laisser combler les
 * trous : il n'a aucune connaissance des ports, ce qui garantit qu'aucun jargon
 * de graphe ne remonte à l'écran.
 */

import { getNodeDef } from './catalog.js';
import type { PortDataType } from './types.js';
import type { ConditionTest, ValueRef } from './recipe.js';

// ============================================================================
// CONTEXTE DISPONIBLE
// ============================================================================

/** Une valeur que le déclencheur met à disposition des étapes suivantes. */
export interface ContextToken {
  /** Chemin utilisé dans les `ValueRef` et les jetons de texte */
  path: string;
  /** Libellé affiché, ex. « Membre › Pseudo » */
  label: string;
  type: PortDataType;
  /** Vrai pour une entité brute (`member`), faux pour une propriété (`member.tag`) */
  root: boolean;
}

/**
 * Nœud d'accès aux propriétés d'une entité.
 *
 * C'est ce qui permet d'exposer `member.accountAgeDays` sans que l'utilisateur
 * n'ait jamais à poser un nœud « Infos du membre » : la compilation l'insère.
 */
export const INFO_NODES: Partial<Record<PortDataType, { node: string; input: string }>> = {
  Member: { node: 'MemberInfo', input: 'member' },
  Message: { node: 'MessageInfo', input: 'message' },
  Channel: { node: 'ChannelInfo', input: 'channel' },
};

/** Propriétés du serveur, disponibles quel que soit le déclencheur. */
const GUILD_TOKENS: ContextToken[] = (getNodeDef('GuildInfo')?.outputs ?? []).map((port) => ({
  path: `guild.${port.id}`,
  label: `Serveur › ${port.label}`,
  type: port.type,
  root: false,
}));

/**
 * Tout ce qu'un déclencheur rend accessible, entités et propriétés comprises.
 *
 * La liste est dérivée du catalogue plutôt qu'écrite à la main : ajouter une
 * sortie à un déclencheur suffit à la rendre disponible dans l'éditeur, les
 * textes et les conditions.
 */
export function contextTokens(triggerType: string): ContextToken[] {
  const def = getNodeDef(triggerType);
  if (!def || def.category !== 'trigger') return [...GUILD_TOKENS];

  const tokens: ContextToken[] = [];

  for (const port of def.outputs) {
    if (port.type === 'Exec') continue;

    tokens.push({ path: port.id, label: port.label, type: port.type, root: true });

    const info = INFO_NODES[port.type];
    if (!info) continue;

    for (const property of getNodeDef(info.node)?.outputs ?? []) {
      tokens.push({
        path: `${port.id}.${property.id}`,
        label: `${port.label} › ${property.label}`,
        type: property.type,
        root: false,
      });
    }
  }

  return [...tokens, ...GUILD_TOKENS];
}

export function findToken(triggerType: string, path: string): ContextToken | undefined {
  return contextTokens(triggerType).find((token) => token.path === path);
}

/** Jetons compatibles avec un type de champ donné. */
export function tokensOfType(triggerType: string, type: PortDataType): ContextToken[] {
  return contextTokens(triggerType).filter((token) => token.type === type);
}

// ============================================================================
// DÉCLENCHEURS
// ============================================================================

export type TriggerGroup = 'members' | 'messages' | 'voice' | 'moderation' | 'support' | 'schedule' | 'community';

export interface TriggerPresentation {
  type: string;
  /** Phrase complète, ex. « Quand un membre rejoint le serveur » */
  sentence: string;
  /** Libellé court pour les badges et la liste */
  short: string;
  group: TriggerGroup;
  icon: string;
  /** Exemple d'usage, affiché sous la carte au moment du choix */
  example: string;
}

export const TRIGGER_GROUP_LABELS: Record<TriggerGroup, string> = {
  members: 'Membres',
  messages: 'Messages',
  voice: 'Vocal',
  moderation: 'Modération',
  support: 'Support',
  schedule: 'Planification',
  community: 'Clans et paris',
};

export const TRIGGER_LIBRARY: TriggerPresentation[] = [
  {
    type: 'OnMemberJoin',
    sentence: 'Quand un membre rejoint le serveur',
    short: 'Arrivée',
    group: 'members',
    icon: 'User',
    example: 'Souhaiter la bienvenue et donner le rôle des nouveaux.',
  },
  {
    type: 'OnMemberLeave',
    sentence: 'Quand un membre quitte le serveur',
    short: 'Départ',
    group: 'members',
    icon: 'UserCross',
    example: 'Prévenir le staff dans un salon de suivi.',
  },
  {
    type: 'OnRoleAdded',
    sentence: 'Quand un rôle est donné à un membre',
    short: 'Rôle donné',
    group: 'members',
    icon: 'Shield',
    example: 'Envoyer le règlement du staff à qui reçoit le rôle Modérateur.',
  },
  {
    type: 'OnRoleRemoved',
    sentence: 'Quand un rôle est retiré à un membre',
    short: 'Rôle retiré',
    group: 'members',
    icon: 'Shield',
    example: 'Retirer les accès liés quand un rôle disparaît.',
  },
  {
    type: 'OnLevelUp',
    sentence: 'Quand un membre monte de niveau',
    short: 'Niveau',
    group: 'members',
    icon: 'Sparkles',
    example: 'Féliciter publiquement et débloquer un rôle de palier.',
  },
  {
    type: 'OnMessageSend',
    sentence: 'Quand un message est envoyé',
    short: 'Message',
    group: 'messages',
    icon: 'MessageSquare',
    example: 'Réagir à un mot-clé dans un salon précis.',
  },
  {
    type: 'OnReactionAdd',
    sentence: 'Quand un membre réagit à un message',
    short: 'Réaction',
    group: 'messages',
    icon: 'Sparkles',
    example: 'Donner un rôle à qui réagit dans le salon des rôles.',
  },
  {
    type: 'OnVoiceJoin',
    sentence: 'Quand un membre rejoint un salon vocal',
    short: 'Vocal rejoint',
    group: 'voice',
    icon: 'Mic',
    example: 'Annoncer l\'ouverture d\'un vocal dans le salon textuel associé.',
  },
  {
    type: 'OnVoiceLeave',
    sentence: 'Quand un membre quitte un salon vocal',
    short: 'Vocal quitté',
    group: 'voice',
    icon: 'Mic',
    example: 'Récompenser les membres restés plus de trente minutes.',
  },
  {
    type: 'OnSanctionApplied',
    sentence: 'Quand une sanction est appliquée',
    short: 'Sanction',
    group: 'moderation',
    icon: 'AlertTriangle',
    example: 'Journaliser la sanction et prévenir le membre en privé.',
  },
  {
    type: 'OnSchedule',
    sentence: 'À heure fixe',
    short: 'Planification',
    group: 'schedule',
    icon: 'Clock',
    example: 'Poster le récapitulatif du jour tous les soirs à 20h.',
  },
  {
    type: 'OnTicketCreated',
    sentence: 'Quand un ticket est ouvert',
    short: 'Ticket',
    group: 'support',
    icon: 'TextBubble',
    example: 'Poster les consignes d\'accueil dans le ticket.',
  },
  {
    type: 'OnBetResolved',
    sentence: 'Quand un pari est tranché',
    short: 'Pari gagné',
    group: 'community',
    icon: 'Coins',
    example: 'Féliciter le vainqueur et annoncer son gain dans le salon des clans.',
  },
  {
    type: 'OnBetRefunded',
    sentence: 'Quand un pari est annulé',
    short: 'Pari annulé',
    group: 'community',
    icon: 'Coins',
    example: 'Prévenir le salon des clans que les mises ont été rendues.',
  },
  {
    type: 'OnClanDebtOpened',
    sentence: "Quand un membre mise des points qu'il n'a pas",
    short: 'Dette ouverte',
    group: 'community',
    icon: 'AlertTriangle',
    example: 'Alerter le staff quand quelqu\'un s\'endette lourdement.',
  },
  {
    type: 'OnClanDebtCleared',
    sentence: 'Quand un membre solde sa dette de clan',
    short: 'Dette soldée',
    group: 'community',
    icon: 'Sparkles',
    example: 'Le féliciter en privé et lui rendre un rôle retiré le temps de la dette.',
  },
];

export function getTrigger(type: string): TriggerPresentation | undefined {
  return TRIGGER_LIBRARY.find((trigger) => trigger.type === type);
}

// ============================================================================
// ACTIONS
// ============================================================================

/**
 * Nature d'un champ, qui détermine le contrôle affiché.
 *
 * `richtext` est le seul champ libre : il accepte du texte et des jetons du
 * contexte. Tous les autres sont des choix fermés, ce qui rend une étape
 * invalide impossible à écrire.
 */
export type FieldKind = 'richtext' | 'number' | 'role' | 'channel' | 'member' | 'message' | 'color';

export interface ActionField {
  key: string;
  label: string;
  kind: FieldKind;
  /** Texte grisé du champ, ex. « Bienvenue {membre} ! » */
  placeholder?: string;
  optional?: boolean;
  /**
   * Champ rangé dans la configuration du nœud plutôt que branché sur un port.
   * Concerne les réglages purement esthétiques, comme la couleur d'un embed.
   */
  option?: boolean;
  defaultValue?: unknown;
  min?: number;
  max?: number;
}

export type ActionGroup = 'communication' | 'roles' | 'moderation' | 'support' | 'timing';

export interface ActionPresentation {
  /** Type de nœud du catalogue moteur */
  type: string;
  label: string;
  /** Phrase à trous, les trous portant les clés des champs */
  sentence: string;
  group: ActionGroup;
  icon: string;
  fields: ActionField[];
}

export const ACTION_GROUP_LABELS: Record<ActionGroup, string> = {
  communication: 'Communiquer',
  roles: 'Rôles',
  moderation: 'Modérer',
  support: 'Support',
  timing: 'Rythme',
};

const MEMBER_FIELD: ActionField = { key: 'member', label: 'Membre', kind: 'member' };

export const ACTION_LIBRARY: ActionPresentation[] = [
  {
    type: 'SendMessage',
    label: 'Envoyer un message',
    sentence: 'Envoyer {text} dans {channel}',
    group: 'communication',
    icon: 'MessageSquare',
    fields: [
      { key: 'text', label: 'Message', kind: 'richtext', placeholder: 'Bienvenue {membre} !' },
      { key: 'channel', label: 'Salon', kind: 'channel' },
    ],
  },
  {
    type: 'SendDM',
    label: 'Envoyer un message privé',
    sentence: 'Envoyer {text} en privé à {member}',
    group: 'communication',
    icon: 'Send',
    fields: [
      { key: 'text', label: 'Message', kind: 'richtext', placeholder: 'Salut {membre} !' },
      MEMBER_FIELD,
    ],
  },
  {
    type: 'SendEmbed',
    label: 'Envoyer un encadré',
    sentence: 'Envoyer un encadré {title} - {description} dans {channel}',
    group: 'communication',
    icon: 'Paper',
    fields: [
      { key: 'title', label: 'Titre', kind: 'richtext', placeholder: 'Bienvenue !' },
      { key: 'description', label: 'Contenu', kind: 'richtext', placeholder: 'Passe lire le règlement.' },
      { key: 'channel', label: 'Salon', kind: 'channel' },
      { key: 'color', label: 'Couleur', kind: 'color', option: true, defaultValue: '#5865F2' },
    ],
  },
  {
    type: 'AddRole',
    label: 'Donner un rôle',
    sentence: 'Donner le rôle {role} à {member}',
    group: 'roles',
    icon: 'Shield',
    fields: [
      { key: 'role', label: 'Rôle', kind: 'role' },
      MEMBER_FIELD,
    ],
  },
  {
    type: 'RemoveRole',
    label: 'Retirer un rôle',
    sentence: 'Retirer le rôle {role} à {member}',
    group: 'roles',
    icon: 'Shield',
    fields: [
      { key: 'role', label: 'Rôle', kind: 'role' },
      MEMBER_FIELD,
    ],
  },
  {
    type: 'SetNickname',
    label: 'Changer le surnom',
    sentence: 'Renommer {member} en {nickname}',
    group: 'roles',
    icon: 'Pen',
    fields: [
      MEMBER_FIELD,
      { key: 'nickname', label: 'Surnom', kind: 'richtext', placeholder: '[Nouveau] {membre}' },
    ],
  },
  {
    type: 'TimeoutMember',
    label: 'Exclure temporairement',
    sentence: 'Exclure {member} pendant {minutes} minutes pour {reason}',
    group: 'moderation',
    icon: 'AlertTriangle',
    fields: [
      MEMBER_FIELD,
      { key: 'minutes', label: 'Durée (minutes)', kind: 'number', defaultValue: 10, min: 1, max: 40_320 },
      { key: 'reason', label: 'Motif', kind: 'richtext', optional: true, placeholder: 'Règles non respectées' },
    ],
  },
  {
    type: 'KickMember',
    label: 'Expulser du serveur',
    sentence: 'Expulser {member} pour {reason}',
    group: 'moderation',
    icon: 'UserCross',
    fields: [
      MEMBER_FIELD,
      { key: 'reason', label: 'Motif', kind: 'richtext', optional: true, placeholder: 'Compte suspect' },
    ],
  },
  {
    type: 'DeleteMessage',
    label: 'Supprimer un message',
    sentence: 'Supprimer {message}',
    group: 'moderation',
    icon: 'Trash',
    fields: [
      { key: 'message', label: 'Message', kind: 'message' },
    ],
  },
  {
    type: 'AddReaction',
    label: 'Réagir à un message',
    sentence: 'Réagir à {message} avec {emoji}',
    group: 'communication',
    icon: 'Sparkles',
    fields: [
      { key: 'message', label: 'Message', kind: 'message' },
      { key: 'emoji', label: 'Émoji', kind: 'richtext', placeholder: '👍' },
    ],
  },
  {
    type: 'PinMessage',
    label: 'Épingler un message',
    sentence: 'Épingler {message}',
    group: 'communication',
    icon: 'Pin',
    fields: [
      { key: 'message', label: 'Message', kind: 'message' },
    ],
  },
  {
    type: 'CreateThread',
    label: 'Ouvrir un fil',
    sentence: 'Ouvrir un fil {name} dans {channel}',
    group: 'communication',
    icon: 'MessageSquare',
    fields: [
      { key: 'name', label: 'Nom du fil', kind: 'richtext', placeholder: 'Discussion du jour' },
      { key: 'channel', label: 'Salon', kind: 'channel' },
    ],
  },
  {
    type: 'BanMember',
    label: 'Bannir',
    sentence: 'Bannir {member} pendant {days} jours (0 = définitif) pour {reason}',
    group: 'moderation',
    icon: 'Shield',
    fields: [
      MEMBER_FIELD,
      { key: 'days', label: 'Jours', kind: 'number', optional: true, defaultValue: 0, min: 0, max: 3650 },
      { key: 'reason', label: 'Motif', kind: 'richtext', optional: true, placeholder: 'Comportement inacceptable' },
    ],
  },
  {
    type: 'CreateTicket',
    label: 'Ouvrir un ticket',
    sentence: 'Ouvrir un ticket {subject} pour {member}',
    group: 'support',
    icon: 'TextBubble',
    fields: [
      { key: 'subject', label: 'Sujet', kind: 'richtext', placeholder: 'Vérification du compte' },
      MEMBER_FIELD,
    ],
  },
];

export function getAction(type: string): ActionPresentation | undefined {
  return ACTION_LIBRARY.find((action) => action.type === type);
}

/**
 * Actions proposables pour un déclencheur donné.
 *
 * Une action réclamant un membre n'a aucun sens si le déclencheur n'en fournit
 * pas : plutôt que de la laisser choisir puis échouer à la validation, on ne la
 * propose pas. C'est le principal garde-fou de l'éditeur simple.
 */
/**
 * Entités qu'aucun choix fixe ne peut fournir : elles viennent forcément du
 * déclencheur. Un rôle ou un salon, eux, se prennent dans une liste du serveur,
 * donc une action qui n'en demande que cela reste toujours réalisable.
 */
const CONTEXT_ONLY_FIELDS: Partial<Record<FieldKind, PortDataType>> = {
  member: 'Member',
  message: 'Message',
};

export function availableActions(triggerType: string): ActionPresentation[] {
  const roots = new Set(
    contextTokens(triggerType).filter((token) => token.root).map((token) => token.type),
  );

  return ACTION_LIBRARY.filter((action) => action.fields.every((field) => {
    const needed = CONTEXT_ONLY_FIELDS[field.kind];
    return !needed || roots.has(needed);
  }));
}

// ============================================================================
// CONDITIONS
// ============================================================================

export interface ConditionOperator {
  value: string;
  label: string;
}

/** Comparaisons numériques, formulées sans symbole mathématique. */
export const NUMBER_OPERATORS: ConditionOperator[] = [
  { value: 'lt', label: 'moins de' },
  { value: 'lte', label: 'au plus' },
  { value: 'gt', label: 'plus de' },
  { value: 'gte', label: 'au moins' },
  { value: 'eq', label: 'exactement' },
  { value: 'neq', label: 'autre chose que' },
];

/**
 * Traduction d'une condition en nœud booléen.
 *
 * `inputs` mélange volontairement chemins de contexte et valeur saisie : les
 * deux sont des `ValueRef`, donc la compilation les traite de la même façon et
 * une condition n'a aucun code de câblage qui lui soit propre.
 */
export type ConditionShape =
  | { node: string; inputs: Record<string, ValueRef>; config?: Record<string, unknown> }
  /** La condition est déjà un booléen du contexte : aucun nœud à insérer. */
  | { direct: ValueRef };

export type ConditionGroup = 'member' | 'message' | 'channel' | 'guild' | 'context';

export interface ConditionPresentation {
  key: string;
  /** Phrase à trous : `{operator}` et `{value}` sont les seuls trous possibles */
  sentence: string;
  /** Même phrase à la forme négative, pour ne jamais afficher « non (… ) » */
  negativeSentence: string;
  group: ConditionGroup;
  /** Chemins de contexte nécessaires ; la condition est masquée s'ils manquent */
  requires: string[];
  /** Nature de la valeur à saisir, absente pour une condition sans valeur */
  valueKind?: FieldKind;
  operators?: ConditionOperator[];
  defaultOperator?: string;
  build: (test: ConditionTest) => ConditionShape;
}

/** Valeur saisie par l'utilisateur, avec repli sur un texte vide. */
function userValue(test: ConditionTest): ValueRef {
  return test.value ?? { from: 'text', template: '' };
}

const ctx = (path: string): ValueRef => ({ from: 'context', path });

export const CONDITION_LIBRARY: ConditionPresentation[] = [
  {
    key: 'member.hasRole',
    sentence: 'le membre a le rôle {value}',
    negativeSentence: 'le membre n\'a pas le rôle {value}',
    group: 'member',
    requires: ['member'],
    valueKind: 'role',
    build: (test) => ({ node: 'HasRole', inputs: { member: ctx('member'), role: userValue(test) } }),
  },
  {
    key: 'member.accountAge',
    sentence: 'le compte du membre a {operator} {value} jours',
    negativeSentence: 'le compte du membre n\'a pas {operator} {value} jours',
    group: 'member',
    requires: ['member.accountAgeDays'],
    valueKind: 'number',
    operators: NUMBER_OPERATORS,
    defaultOperator: 'lt',
    build: (test) => ({
      node: 'Compare',
      inputs: { a: ctx('member.accountAgeDays'), b: userValue(test) },
      config: { operator: test.operator ?? 'lt' },
    }),
  },
  {
    key: 'member.tenure',
    sentence: 'le membre est sur le serveur depuis {operator} {value} jours',
    negativeSentence: 'le membre n\'est pas sur le serveur depuis {operator} {value} jours',
    group: 'member',
    requires: ['member.joinedDaysAgo'],
    valueKind: 'number',
    operators: NUMBER_OPERATORS,
    defaultOperator: 'gte',
    build: (test) => ({
      node: 'Compare',
      inputs: { a: ctx('member.joinedDaysAgo'), b: userValue(test) },
      config: { operator: test.operator ?? 'gte' },
    }),
  },
  {
    key: 'member.isBot',
    sentence: 'le membre est un bot',
    negativeSentence: 'le membre n\'est pas un bot',
    group: 'member',
    requires: ['member.isBot'],
    build: () => ({ direct: ctx('member.isBot') }),
  },
  {
    key: 'message.contains',
    sentence: 'le message contient {value}',
    negativeSentence: 'le message ne contient pas {value}',
    group: 'message',
    requires: ['message.content'],
    valueKind: 'richtext',
    build: (test) => ({
      node: 'TextContains',
      inputs: { text: ctx('message.content'), search: userValue(test) },
    }),
  },
  {
    key: 'message.length',
    sentence: 'le message fait {operator} {value} caractères',
    negativeSentence: 'le message ne fait pas {operator} {value} caractères',
    group: 'message',
    requires: ['message.length'],
    valueKind: 'number',
    operators: NUMBER_OPERATORS,
    defaultOperator: 'gt',
    build: (test) => ({
      node: 'Compare',
      inputs: { a: ctx('message.length'), b: userValue(test) },
      config: { operator: test.operator ?? 'gt' },
    }),
  },
  {
    key: 'channel.is',
    sentence: 'le salon est {value}',
    negativeSentence: 'le salon n\'est pas {value}',
    group: 'channel',
    requires: ['channel'],
    valueKind: 'channel',
    build: (test) => ({ node: 'ChannelEquals', inputs: { a: ctx('channel'), b: userValue(test) } }),
  },
  {
    key: 'emoji.is',
    sentence: 'l\'émoji est {value}',
    negativeSentence: 'l\'émoji n\'est pas {value}',
    group: 'context',
    requires: ['emoji'],
    valueKind: 'richtext',
    build: (test) => ({ node: 'TextEquals', inputs: { a: ctx('emoji'), b: userValue(test) } }),
  },
  {
    key: 'sanction.is',
    sentence: 'la sanction est de type {value}',
    negativeSentence: 'la sanction n\'est pas de type {value}',
    group: 'context',
    requires: ['type'],
    valueKind: 'richtext',
    build: (test) => ({ node: 'TextEquals', inputs: { a: ctx('type'), b: userValue(test) } }),
  },
  {
    key: 'guild.memberCount',
    sentence: 'le serveur compte {operator} {value} membres',
    negativeSentence: 'le serveur ne compte pas {operator} {value} membres',
    group: 'guild',
    requires: ['guild.memberCount'],
    valueKind: 'number',
    operators: NUMBER_OPERATORS,
    defaultOperator: 'gte',
    build: (test) => ({
      node: 'Compare',
      inputs: { a: ctx('guild.memberCount'), b: userValue(test) },
      config: { operator: test.operator ?? 'gte' },
    }),
  },
];

export function getCondition(key: string): ConditionPresentation | undefined {
  return CONDITION_LIBRARY.find((condition) => condition.key === key);
}

/** Conditions formulables avec le contexte d'un déclencheur donné. */
export function availableConditions(triggerType: string): ConditionPresentation[] {
  const paths = new Set(contextTokens(triggerType).map((token) => token.path));
  return CONDITION_LIBRARY.filter((condition) => condition.requires.every((path) => paths.has(path)));
}
