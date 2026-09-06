import type { NodeDef, PortDataType, PortDef, TextSlot, WorkflowGraph, WorkflowNode } from './types.js';

/**
 * Catalogue des nœuds disponibles.
 *
 * Source de vérité unique : l'éditeur en déduit la palette et la forme des
 * blocs, le moteur en déduit les ports à évaluer. Ajouter un nœud ici sans
 * écrire son exécuteur côté bot le fera échouer à la validation.
 */

const EXEC_IN: PortDef = { id: 'exec', label: '', type: 'Exec' };
const EXEC_OUT: PortDef = { id: 'next', label: '', type: 'Exec' };

// ============================================================================
// DÉCLENCHEURS - sans entrée d'exécution, ils démarrent le graphe
// ============================================================================

const TRIGGERS: NodeDef[] = [
  {
    type: 'OnMemberJoin',
    label: 'Arrivée d\'un membre',
    category: 'trigger',
    description: 'Se déclenche quand un membre rejoint le serveur.',
    event: 'member:join',
    inputs: [],
    outputs: [EXEC_OUT, { id: 'member', label: 'Membre', type: 'Member' }],
  },
  {
    type: 'OnMemberLeave',
    label: 'Départ d\'un membre',
    category: 'trigger',
    description: 'Se déclenche quand un membre quitte le serveur.',
    event: 'member:leave',
    inputs: [],
    outputs: [EXEC_OUT, { id: 'member', label: 'Membre', type: 'Member' }],
  },
  {
    type: 'OnRoleAdded',
    label: 'Rôle attribué',
    category: 'trigger',
    description: 'Se déclenche quand un rôle est ajouté à un membre.',
    event: 'member:role-added',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'role', label: 'Rôle', type: 'Role' },
    ],
  },
  {
    type: 'OnRoleRemoved',
    label: 'Rôle retiré',
    category: 'trigger',
    description: 'Se déclenche quand un rôle est retiré à un membre.',
    event: 'member:role-removed',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'role', label: 'Rôle', type: 'Role' },
    ],
  },
  {
    type: 'OnMessageSend',
    label: 'Message envoyé',
    category: 'trigger',
    description: 'Se déclenche à chaque message posté par un humain.',
    event: 'message:new',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'message', label: 'Message', type: 'Message' },
      { id: 'member', label: 'Auteur', type: 'Member' },
      { id: 'channel', label: 'Salon', type: 'Channel' },
    ],
  },
  {
    type: 'OnReactionAdd',
    label: 'Réaction ajoutée',
    category: 'trigger',
    description: 'Se déclenche quand un membre réagit à un message.',
    event: 'reaction:add',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'emoji', label: 'Émoji', type: 'String' },
      { id: 'channel', label: 'Salon', type: 'Channel' },
    ],
  },
  {
    type: 'OnVoiceJoin',
    label: 'Arrivée en vocal',
    category: 'trigger',
    description: 'Se déclenche quand un membre rejoint un salon vocal.',
    event: 'voice:join',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'channel', label: 'Salon', type: 'Channel' },
    ],
  },
  {
    type: 'OnVoiceLeave',
    label: 'Départ du vocal',
    category: 'trigger',
    description: 'Se déclenche quand un membre quitte un salon vocal.',
    event: 'voice:leave',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'channel', label: 'Salon', type: 'Channel' },
      { id: 'minutes', label: 'Durée (min)', type: 'Number' },
    ],
  },
  {
    type: 'OnTicketCreated',
    label: 'Ticket créé',
    category: 'trigger',
    description: 'Se déclenche à l\'ouverture d\'un ticket de support.',
    event: 'ticket:created',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Auteur', type: 'Member' },
      { id: 'channel', label: 'Salon du ticket', type: 'Channel' },
      { id: 'subject', label: 'Sujet', type: 'String' },
    ],
  },
  {
    type: 'OnSanctionApplied',
    label: 'Sanction appliquée',
    category: 'trigger',
    description: 'Se déclenche quand une sanction est prononcée.',
    event: 'sanction:applied',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Sanctionné', type: 'Member' },
      { id: 'type', label: 'Type', type: 'String' },
      { id: 'reason', label: 'Motif', type: 'String' },
    ],
  },
  {
    /**
     * Seul déclencheur qui ne vient pas du bus : un balayage passe chaque
     * minute et lance les workflows planifiés dont le motif tombe. Le nom
     * d'événement ci-dessous ne sert donc qu'à indexer la table, il n'est
     * jamais publié - s'y abonner ne recevrait rien.
     */
    type: 'OnSchedule',
    label: 'Planification',
    category: 'trigger',
    description: 'Se déclenche à heure fixe, selon une planification récurrente.',
    event: 'schedule:fired',
    inputs: [],
    outputs: [EXEC_OUT],
    config: [
      { key: 'cron', label: 'Planification', type: 'text', defaultValue: '0 9 * * *', placeholder: '0 9 * * *' },
    ],
  },
  {
    type: 'OnLevelUp',
    label: 'Passage de niveau',
    category: 'trigger',
    description: 'Se déclenche quand un membre gagne un niveau.',
    event: 'level:up',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'level', label: 'Niveau', type: 'Number' },
    ],
  },
  {
    /**
     * Le port `member` porte le premier vainqueur, pas le camp entier : les
     * actions du catalogue s'adressent à un membre, et un port `List` ne
     * saurait pas les alimenter. Le décompte reste disponible à côté pour les
     * paris à plusieurs.
     */
    type: 'OnBetResolved',
    label: 'Pari tranché',
    category: 'trigger',
    description: 'Se déclenche quand un arbitre désigne le camp gagnant d\'un pari en points de clan.',
    event: 'bet:resolved',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Vainqueur', type: 'Member' },
      { id: 'subject', label: 'Sujet', type: 'String' },
      { id: 'side', label: 'Camp gagnant', type: 'String' },
      { id: 'netGain', label: 'Gain net', type: 'Number' },
      { id: 'pot', label: 'Pot', type: 'Number' },
      { id: 'winnerCount', label: 'Nombre de vainqueurs', type: 'Number' },
    ],
  },
  {
    type: 'OnBetRefunded',
    label: 'Pari annulé',
    category: 'trigger',
    description: 'Se déclenche quand un pari se clôt sans vainqueur et que les mises sont rendues.',
    event: 'bet:refunded',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'subject', label: 'Sujet', type: 'String' },
      { id: 'reason', label: 'Motif', type: 'String' },
      { id: 'refunded', label: 'Points rendus', type: 'Number' },
    ],
  },
  {
    type: 'OnClanDebtOpened',
    label: 'Dette de clan creusée',
    category: 'trigger',
    description: 'Se déclenche quand un membre mise des points de clan qu\'il ne possède pas.',
    event: 'clan:debt-opened',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'amount', label: 'Montant emprunté', type: 'Number' },
      { id: 'total', label: 'Dette totale', type: 'Number' },
    ],
  },
  {
    type: 'OnClanDebtCleared',
    label: 'Dette de clan soldée',
    category: 'trigger',
    description: 'Se déclenche quand un membre finit de rembourser sa dette de points de clan.',
    event: 'clan:debt-cleared',
    inputs: [],
    outputs: [
      EXEC_OUT,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'repaid', label: 'Dernier remboursement', type: 'Number' },
    ],
  },
];

// ============================================================================
// CONTRÔLE DE FLUX
// ============================================================================

const FLOW: NodeDef[] = [
  {
    type: 'If',
    label: 'Si',
    category: 'flow',
    description: 'Oriente l\'exécution selon une condition booléenne.',
    inputs: [EXEC_IN, { id: 'condition', label: 'Condition', type: 'Boolean' }],
    outputs: [
      { id: 'true', label: 'Vrai', type: 'Exec' },
      { id: 'false', label: 'Faux', type: 'Exec' },
    ],
  },
  {
    type: 'Switch',
    label: 'Aiguillage',
    category: 'flow',
    description: 'Compare une valeur texte à une liste de cas et suit la sortie correspondante.',
    inputs: [EXEC_IN, { id: 'value', label: 'Valeur', type: 'String' }],
    // Les sorties par cas sont générées à partir de la configuration ;
    // « Sinon » est toujours présent.
    outputs: [{ id: 'default', label: 'Sinon', type: 'Exec' }],
    config: [
      { key: 'cases', label: 'Cas', type: 'cases', defaultValue: [] },
    ],
  },
  {
    type: 'ForEach',
    label: 'Pour chaque',
    category: 'flow',
    description: 'Parcourt une liste et exécute le corps de boucle pour chaque élément.',
    inputs: [EXEC_IN, { id: 'list', label: 'Liste', type: 'List' }],
    outputs: [
      { id: 'body', label: 'Corps', type: 'Exec' },
      { id: 'done', label: 'Terminé', type: 'Exec' },
      { id: 'item', label: 'Élément', type: 'String' },
      { id: 'index', label: 'Index', type: 'Number' },
    ],
  },
  {
    type: 'Delay',
    label: 'Attendre',
    category: 'flow',
    description: 'Suspend l\'exécution ; elle reprend même après un redémarrage du bot.',
    inputs: [EXEC_IN, { id: 'seconds', label: 'Secondes', type: 'Number', optional: true }],
    outputs: [EXEC_OUT],
    config: [
      { key: 'seconds', label: 'Secondes', type: 'number', defaultValue: 60, min: 1, max: 2_592_000 },
    ],
  },
];

// ============================================================================
// ACTIONS
// ============================================================================

const ACTIONS: NodeDef[] = [
  {
    type: 'SendMessage',
    label: 'Envoyer un message',
    category: 'action',
    description: 'Poste un message texte dans un salon.',
    inputs: [
      EXEC_IN,
      { id: 'channel', label: 'Salon', type: 'Channel' },
      { id: 'text', label: 'Texte', type: 'String' },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'SendEmbed',
    label: 'Envoyer un embed',
    category: 'action',
    description: 'Poste un message enrichi dans un salon.',
    inputs: [
      EXEC_IN,
      { id: 'channel', label: 'Salon', type: 'Channel' },
      { id: 'title', label: 'Titre', type: 'String' },
      { id: 'description', label: 'Description', type: 'String' },
    ],
    outputs: [EXEC_OUT],
    config: [
      { key: 'color', label: 'Couleur', type: 'text', placeholder: '#5865F2', defaultValue: '#5865F2' },
    ],
  },
  {
    type: 'SendDM',
    label: 'Envoyer un message privé',
    category: 'action',
    description: 'Envoie un message privé à un membre. Sans effet si ses MP sont fermés.',
    inputs: [
      EXEC_IN,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'text', label: 'Texte', type: 'String' },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'AddRole',
    label: 'Ajouter un rôle',
    category: 'action',
    description: 'Attribue un rôle à un membre.',
    inputs: [
      EXEC_IN,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'role', label: 'Rôle', type: 'Role' },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'RemoveRole',
    label: 'Retirer un rôle',
    category: 'action',
    description: 'Retire un rôle à un membre.',
    inputs: [
      EXEC_IN,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'role', label: 'Rôle', type: 'Role' },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'SetNickname',
    label: 'Changer le surnom',
    category: 'action',
    description: 'Modifie le surnom d\'un membre sur le serveur.',
    inputs: [
      EXEC_IN,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'nickname', label: 'Surnom', type: 'String' },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'TimeoutMember',
    label: 'Exclure temporairement',
    category: 'action',
    description: 'Applique une exclusion temporaire à un membre.',
    inputs: [
      EXEC_IN,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'minutes', label: 'Minutes', type: 'Number' },
      { id: 'reason', label: 'Motif', type: 'String', optional: true },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'KickMember',
    label: 'Expulser',
    category: 'action',
    description: 'Expulse un membre du serveur.',
    inputs: [
      EXEC_IN,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'reason', label: 'Motif', type: 'String', optional: true },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'DeleteMessage',
    label: 'Supprimer un message',
    category: 'action',
    description: 'Supprime un message existant.',
    inputs: [
      EXEC_IN,
      { id: 'message', label: 'Message', type: 'Message' },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'AddReaction',
    label: 'Réagir à un message',
    category: 'action',
    description: 'Ajoute une réaction à un message.',
    inputs: [
      EXEC_IN,
      { id: 'message', label: 'Message', type: 'Message' },
      { id: 'emoji', label: 'Émoji', type: 'String' },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'PinMessage',
    label: 'Épingler un message',
    category: 'action',
    description: 'Épingle un message dans son salon.',
    inputs: [
      EXEC_IN,
      { id: 'message', label: 'Message', type: 'Message' },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'CreateThread',
    label: 'Ouvrir un fil',
    category: 'action',
    description: 'Ouvre un fil de discussion dans un salon.',
    inputs: [
      EXEC_IN,
      { id: 'channel', label: 'Salon', type: 'Channel' },
      { id: 'name', label: 'Nom du fil', type: 'String' },
    ],
    outputs: [EXEC_OUT, { id: 'thread', label: 'Fil créé', type: 'Channel' }],
  },
  {
    type: 'BanMember',
    label: 'Bannir',
    category: 'action',
    description: 'Bannit un membre du serveur, définitivement ou pour une durée donnée.',
    inputs: [
      EXEC_IN,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'days', label: 'Jours', type: 'Number', optional: true },
      { id: 'reason', label: 'Motif', type: 'String', optional: true },
    ],
    outputs: [EXEC_OUT],
  },
  {
    type: 'CreateTicket',
    label: 'Ouvrir un ticket',
    category: 'action',
    description: 'Ouvre un ticket de support au nom d\'un membre.',
    inputs: [
      EXEC_IN,
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'subject', label: 'Sujet', type: 'String' },
    ],
    outputs: [EXEC_OUT, { id: 'channel', label: 'Salon créé', type: 'Channel' }],
  },
];

// ============================================================================
// DONNÉES - constantes, sélecteurs et accesseurs
// ============================================================================

const DATA: NodeDef[] = [
  {
    type: 'ConstText',
    label: 'Texte',
    category: 'data',
    description: 'Une valeur texte fixe.',
    inputs: [],
    outputs: [{ id: 'value', label: 'Valeur', type: 'String' }],
    config: [{ key: 'value', label: 'Texte', type: 'textarea', defaultValue: '' }],
  },
  {
    type: 'ConstNumber',
    label: 'Nombre',
    category: 'data',
    description: 'Une valeur numérique fixe.',
    inputs: [],
    outputs: [{ id: 'value', label: 'Valeur', type: 'Number' }],
    config: [{ key: 'value', label: 'Nombre', type: 'number', defaultValue: 0 }],
  },
  {
    type: 'ConstBoolean',
    label: 'Booléen',
    category: 'data',
    description: 'Vrai ou faux.',
    inputs: [],
    outputs: [{ id: 'value', label: 'Valeur', type: 'Boolean' }],
    config: [{ key: 'value', label: 'Vrai ?', type: 'boolean', defaultValue: false }],
  },
  {
    type: 'FormatText',
    label: 'Texte composé',
    category: 'data',
    description: 'Un texte dans lequel des valeurs du contexte viennent s\'insérer.',
    // Les entrées sont dérivées des emplacements déclarés en configuration :
    // un texte « Bienvenue {slot0} » n'a qu'une entrée, deux jetons en créent
    // deux. Passer par `resolveNodeInputs` est donc obligatoire pour ce nœud.
    inputs: [],
    outputs: [{ id: 'value', label: 'Valeur', type: 'String' }],
    config: [
      { key: 'template', label: 'Texte', type: 'textarea', defaultValue: '' },
      { key: 'slots', label: 'Emplacements', type: 'slots', defaultValue: [] },
    ],
  },
  {
    type: 'SelectRole',
    label: 'Un rôle',
    category: 'data',
    description: 'Un rôle choisi parmi ceux du serveur.',
    inputs: [],
    outputs: [{ id: 'role', label: 'Rôle', type: 'Role' }],
    config: [{ key: 'roleId', label: 'Rôle', type: 'role' }],
  },
  {
    type: 'SelectChannel',
    label: 'Un salon',
    category: 'data',
    description: 'Un salon choisi parmi ceux du serveur.',
    inputs: [],
    outputs: [{ id: 'channel', label: 'Salon', type: 'Channel' }],
    config: [{ key: 'channelId', label: 'Salon', type: 'channel' }],
  },
  {
    type: 'MemberInfo',
    label: 'Infos du membre',
    category: 'data',
    description: 'Expose les propriétés d\'un membre.',
    inputs: [{ id: 'member', label: 'Membre', type: 'Member' }],
    outputs: [
      { id: 'displayName', label: 'Pseudo', type: 'String' },
      { id: 'tag', label: 'Tag', type: 'String' },
      { id: 'id', label: 'Identifiant', type: 'String' },
      { id: 'accountAgeDays', label: 'Âge du compte (j)', type: 'Number' },
      { id: 'joinedDaysAgo', label: 'Arrivé il y a (j)', type: 'Number' },
      { id: 'isBot', label: 'Est un bot', type: 'Boolean' },
      { id: 'roles', label: 'Rôles', type: 'List', itemType: 'Role' },
    ],
  },
  {
    type: 'MessageInfo',
    label: 'Infos du message',
    category: 'data',
    description: 'Expose les propriétés d\'un message.',
    inputs: [{ id: 'message', label: 'Message', type: 'Message' }],
    outputs: [
      { id: 'content', label: 'Contenu', type: 'String' },
      { id: 'author', label: 'Auteur', type: 'Member' },
      { id: 'channel', label: 'Salon', type: 'Channel' },
      { id: 'length', label: 'Longueur', type: 'Number' },
    ],
  },
  {
    type: 'ChannelInfo',
    label: 'Infos du salon',
    category: 'data',
    description: 'Expose les propriétés d\'un salon.',
    inputs: [{ id: 'channel', label: 'Salon', type: 'Channel' }],
    outputs: [
      { id: 'name', label: 'Nom', type: 'String' },
      { id: 'id', label: 'Identifiant', type: 'String' },
      { id: 'categoryName', label: 'Catégorie', type: 'String' },
    ],
  },
  {
    type: 'GuildInfo',
    label: 'Infos du serveur',
    category: 'data',
    description: 'Expose les propriétés du serveur.',
    inputs: [],
    outputs: [
      { id: 'name', label: 'Nom', type: 'String' },
      { id: 'memberCount', label: 'Nombre de membres', type: 'Number' },
    ],
  },
];

// ============================================================================
// LOGIQUE - opérateurs et conditions
// ============================================================================

const LOGIC: NodeDef[] = [
  {
    type: 'HasRole',
    label: 'Possède le rôle',
    category: 'logic',
    description: 'Vrai si le membre possède le rôle indiqué.',
    inputs: [
      { id: 'member', label: 'Membre', type: 'Member' },
      { id: 'role', label: 'Rôle', type: 'Role' },
    ],
    outputs: [{ id: 'result', label: 'Résultat', type: 'Boolean' }],
  },
  {
    type: 'ChannelEquals',
    label: 'Salon est',
    category: 'logic',
    description: 'Vrai si les deux salons sont le même.',
    inputs: [
      { id: 'a', label: 'Salon', type: 'Channel' },
      { id: 'b', label: 'Comparé à', type: 'Channel' },
    ],
    outputs: [{ id: 'result', label: 'Résultat', type: 'Boolean' }],
  },
  {
    type: 'TextContains',
    label: 'Texte contient',
    category: 'logic',
    description: 'Vrai si le texte contient le fragment recherché.',
    inputs: [
      { id: 'text', label: 'Texte', type: 'String' },
      { id: 'search', label: 'Recherche', type: 'String' },
    ],
    outputs: [{ id: 'result', label: 'Résultat', type: 'Boolean' }],
    config: [{ key: 'caseSensitive', label: 'Sensible à la casse', type: 'boolean', defaultValue: false }],
  },
  {
    type: 'TextEquals',
    label: 'Texte est égal à',
    category: 'logic',
    description: 'Vrai si les deux textes sont identiques.',
    inputs: [
      { id: 'a', label: 'Texte', type: 'String' },
      { id: 'b', label: 'Comparé à', type: 'String' },
    ],
    outputs: [{ id: 'result', label: 'Résultat', type: 'Boolean' }],
    config: [{ key: 'caseSensitive', label: 'Sensible à la casse', type: 'boolean', defaultValue: false }],
  },
  {
    type: 'Compare',
    label: 'Comparer',
    category: 'logic',
    description: 'Compare deux nombres.',
    inputs: [
      { id: 'a', label: 'A', type: 'Number' },
      { id: 'b', label: 'B', type: 'Number' },
    ],
    outputs: [{ id: 'result', label: 'Résultat', type: 'Boolean' }],
    config: [{
      key: 'operator',
      label: 'Opérateur',
      type: 'select',
      defaultValue: 'gt',
      options: [
        { value: 'gt', label: 'A > B' },
        { value: 'gte', label: 'A ≥ B' },
        { value: 'lt', label: 'A < B' },
        { value: 'lte', label: 'A ≤ B' },
        { value: 'eq', label: 'A = B' },
        { value: 'neq', label: 'A ≠ B' },
      ],
    }],
  },
  {
    type: 'Logic',
    label: 'ET / OU',
    category: 'logic',
    description: 'Combine deux booléens.',
    inputs: [
      { id: 'a', label: 'A', type: 'Boolean' },
      { id: 'b', label: 'B', type: 'Boolean' },
    ],
    outputs: [{ id: 'result', label: 'Résultat', type: 'Boolean' }],
    config: [{
      key: 'operator',
      label: 'Opérateur',
      type: 'select',
      defaultValue: 'and',
      options: [{ value: 'and', label: 'ET' }, { value: 'or', label: 'OU' }],
    }],
  },
  {
    type: 'Not',
    label: 'NON',
    category: 'logic',
    description: 'Inverse un booléen.',
    inputs: [{ id: 'value', label: 'Valeur', type: 'Boolean' }],
    outputs: [{ id: 'result', label: 'Résultat', type: 'Boolean' }],
  },
  {
    type: 'Concat',
    label: 'Concaténer',
    category: 'logic',
    description: 'Assemble deux textes.',
    inputs: [
      { id: 'a', label: 'A', type: 'String' },
      { id: 'b', label: 'B', type: 'String' },
    ],
    outputs: [{ id: 'result', label: 'Résultat', type: 'String' }],
    config: [{ key: 'separator', label: 'Séparateur', type: 'text', defaultValue: '' }],
  },
  {
    type: 'TextLength',
    label: 'Longueur du texte',
    category: 'logic',
    description: 'Nombre de caractères d\'un texte.',
    inputs: [{ id: 'text', label: 'Texte', type: 'String' }],
    outputs: [{ id: 'result', label: 'Longueur', type: 'Number' }],
  },
  {
    type: 'Math',
    label: 'Calcul',
    category: 'logic',
    description: 'Opération arithmétique entre deux nombres.',
    inputs: [
      { id: 'a', label: 'A', type: 'Number' },
      { id: 'b', label: 'B', type: 'Number' },
    ],
    outputs: [{ id: 'result', label: 'Résultat', type: 'Number' }],
    config: [{
      key: 'operator',
      label: 'Opération',
      type: 'select',
      defaultValue: 'add',
      options: [
        { value: 'add', label: 'A + B' },
        { value: 'sub', label: 'A − B' },
        { value: 'mul', label: 'A × B' },
        { value: 'div', label: 'A ÷ B' },
      ],
    }],
  },
  {
    type: 'ListLength',
    label: 'Taille de la liste',
    category: 'logic',
    description: 'Nombre d\'éléments d\'une liste.',
    inputs: [{ id: 'list', label: 'Liste', type: 'List' }],
    outputs: [{ id: 'result', label: 'Taille', type: 'Number' }],
  },
];

// ============================================================================
// REGISTRE
// ============================================================================

export const NODE_CATALOG: NodeDef[] = [...TRIGGERS, ...FLOW, ...ACTIONS, ...DATA, ...LOGIC];

const BY_TYPE = new Map(NODE_CATALOG.map((def) => [def.type, def]));

export function getNodeDef(type: string): NodeDef | undefined {
  return BY_TYPE.get(type);
}

export function isTriggerNode(type: string): boolean {
  return getNodeDef(type)?.category === 'trigger';
}

/** Types d'événements du bus effectivement utilisés par au moins un déclencheur. */
export function triggerEventNames(): string[] {
  return [...new Set(TRIGGERS.map((def) => def.event).filter((e): e is string => Boolean(e)))];
}

/**
 * Sorties d'exécution d'un nœud, configuration comprise.
 *
 * Le nœud Switch fait exception : ses sorties dépendent des cas saisis par
 * l'utilisateur, elles ne peuvent donc pas être déclarées statiquement.
 */
export function resolveExecOutputs(type: string, config?: Record<string, unknown>): PortDef[] {
  const def = getNodeDef(type);
  if (!def) return [];

  if (type === 'Switch') {
    const cases = Array.isArray(config?.cases) ? (config.cases as unknown[]) : [];
    const caseOutputs: PortDef[] = cases
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .map((value, index) => ({ id: `case-${index}`, label: value, type: 'Exec' as const }));
    return [...caseOutputs, { id: 'default', label: 'Sinon', type: 'Exec' }];
  }

  return def.outputs.filter((port) => port.type === 'Exec');
}

/**
 * Ports d'entrée effectifs d'un nœud, une fois sa configuration prise en compte.
 *
 * Seul `FormatText` a des entrées variables : une par emplacement de son texte.
 * L'éditeur, la validation et le moteur doivent passer par ici plutôt que par
 * `def.inputs`, sinon un texte composé apparaîtrait sans aucune entrée.
 */
export function resolveNodeInputs(node: WorkflowNode): PortDef[] {
  const def = getNodeDef(node.type);
  if (!def) return [];

  if (node.type === 'FormatText') {
    const slots = Array.isArray(node.config?.slots) ? (node.config.slots as TextSlot[]) : [];
    return [
      ...def.inputs,
      ...slots
        .filter((slot) => slot && typeof slot.id === 'string')
        .map((slot) => ({ id: slot.id, label: slot.label || slot.id, type: 'String' as const })),
    ];
  }

  return def.inputs;
}

/**
 * Type effectif du port « Élément » d'un ForEach, déduit de la liste branchée
 * sur son entrée.
 *
 * Sans cette résolution, itérer sur les rôles d'un membre ne servirait à rien :
 * l'élément sortirait en texte et ne pourrait pas alimenter un « Retirer un
 * rôle ». On remonte donc le fil jusqu'au port source pour lire son `itemType`.
 */
function resolveForEachItemType(node: WorkflowNode, graph: WorkflowGraph): PortDataType {
  const listEdge = graph.edges.find((e) => e.target === node.id && e.targetHandle === 'list');
  if (!listEdge) return 'String';

  const sourceNode = graph.nodes.find((n) => n.id === listEdge.source);
  const sourceDef = sourceNode ? getNodeDef(sourceNode.type) : undefined;
  const sourcePort = sourceDef?.outputs.find((p) => p.id === listEdge.sourceHandle);

  return sourcePort?.itemType ?? 'String';
}

/**
 * Ports de sortie effectifs d'un nœud, une fois sa configuration et son
 * câblage pris en compte. C'est cette fonction que doivent utiliser l'éditeur
 * et la validation, jamais `def.outputs` directement.
 */
export function resolveNodeOutputs(node: WorkflowNode, graph?: WorkflowGraph): PortDef[] {
  const def = getNodeDef(node.type);
  if (!def) return [];

  if (node.type === 'Switch') {
    return [
      ...def.outputs.filter((port) => port.type !== 'Exec'),
      ...resolveExecOutputs(node.type, node.config),
    ];
  }

  if (node.type === 'ForEach' && graph) {
    const itemType = resolveForEachItemType(node, graph);
    return def.outputs.map((port) => (port.id === 'item' ? { ...port, type: itemType } : port));
  }

  return def.outputs;
}
