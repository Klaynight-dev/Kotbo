/**
 * Les échelles de rôles que le parcours sait créer lui-même.
 *
 * Deux écrans butaient sur le même mur : « désignez vos rôles de staff » et
 * « choisissez les rôles à débloquer » supposent tous deux que le serveur en
 * possède déjà. Sur un serveur neuf il n'y en a aucun, et la seule issue était
 * d'aller les créer sur Discord puis de revenir - trois gestes hors du produit,
 * au moment précis où on essaie de le montrer.
 *
 * D'où ces gabarits. Ils ne prétendent pas couvrir toutes les organisations :
 * ils couvrent les deux ou trois que l'on retrouve partout, et l'on ajuste
 * ensuite. Une hiérarchie ajustée est une hiérarchie que l'on s'approprie ;
 * une page blanche est une page qu'on referme.
 *
 * Le format est le même pour les deux écrans - une liste ordonnée du plus haut
 * au plus bas - parce que c'est ce que la route de création attend : Discord
 * empile chaque nouveau rôle sous le précédent, et créer en partant du sommet
 * laisse la hiérarchie dans le bon sens sans avoir à la réordonner.
 */
import type { OnboardingRoleRequest, StaffRolePower } from '../api';

/** Un rôle proposé : ce qui part sur Discord, plus ce qui l'explique à l'écran. */
export type RoleBlueprint = {
  /** Clef de trace, pour qu'un second passage reprenne le rôle au lieu de le doubler. */
  key: string;
  name: string;
  color: string;
  power: StaffRolePower;
  /** Rôle affiché à part dans la liste des membres. */
  hoist: boolean;
  /** Ce qu'il fait, en une ligne. C'est ce qui permet de juger la structure. */
  duty: string;
};

// ── Hiérarchies de staff ─────────────────────────────────────────────────────

export type StaffStructureKey = 'founder' | 'admin' | 'flat';

export type StaffStructure = {
  key: StaffStructureKey;
  label: string;
  pitch: string;
  detail: string;
  icon: string;
  /** Direction : au-dessus des pôles. */
  top: RoleBlueprint[];
  /** Terrain : sous les pôles. */
  ground: RoleBlueprint[];
};

/**
 * Les deux conventions que l'on croise partout, plus une pour les petits
 * serveurs.
 *
 * La différence entre les deux premières tient à un seul point : le rôle que
 * porte le propriétaire du serveur. « Fondateur » au-dessus d'« Administrateur »
 * quand l'équipe compte plusieurs administrateurs ; « Administrateur » seul en
 * tête quand il n'y en a qu'un. Choisir l'une ou l'autre ne change rien aux
 * pouvoirs - les deux rôles de tête sont administrateurs - mais change la
 * lecture de la liste des membres, et c'est tout ce qu'on demande ici.
 */
export const STAFF_STRUCTURES: StaffStructure[] = [
  {
    key: 'founder',
    label: 'Fondateur en tête',
    pitch: 'Vous êtes Fondateur, vos administrateurs sont en dessous',
    detail:
      "Le plus courant dès qu'une équipe compte plus d'un administrateur : le rôle de tête distingue celui qui a créé le serveur de ceux qui l'administrent avec lui.",
    icon: 'crown',
    top: [
      {
        key: 'staff.founder',
        name: 'Fondateur',
        color: '#F59E0B',
        power: 'admin',
        hoist: true,
        duty: 'Le vôtre. Tous les droits, aucune limite.',
      },
      {
        key: 'staff.admin',
        name: 'Administrateur',
        color: '#EF4444',
        power: 'admin',
        hoist: true,
        duty: 'Gère le serveur avec vous : salons, rôles, réglages.',
      },
    ],
    ground: [
      {
        key: 'staff.moderator',
        name: 'Modérateur',
        color: '#3B82F6',
        power: 'moderate',
        hoist: true,
        duty: 'Sanctionne, supprime, exclut. Le travail quotidien.',
      },
      {
        key: 'staff.helper',
        name: 'Helper',
        color: '#10B981',
        power: 'assist',
        hoist: true,
        duty: "Répond, oriente, calme. Peut mettre en sourdine, pas exclure.",
      },
    ],
  },
  {
    key: 'admin',
    label: 'Administrateur en tête',
    pitch: 'Vous êtes Administrateur, sans échelon au-dessus',
    detail:
      "L'autre convention répandue : pas de rôle de fondateur, et un échelon intermédiaire entre l'administration et la modération de terrain.",
    icon: 'shield',
    top: [
      {
        key: 'staff.admin',
        name: 'Administrateur',
        color: '#EF4444',
        power: 'admin',
        hoist: true,
        duty: 'Le vôtre. Tous les droits, aucune limite.',
      },
      {
        key: 'staff.supermod',
        name: 'Responsable staff',
        color: '#F97316',
        power: 'manage',
        hoist: true,
        duty: "Encadre l'équipe et arbitre les décisions de modération.",
      },
    ],
    ground: [
      {
        key: 'staff.moderator',
        name: 'Modérateur',
        color: '#3B82F6',
        power: 'moderate',
        hoist: true,
        duty: 'Sanctionne, supprime, exclut. Le travail quotidien.',
      },
      {
        key: 'staff.helper',
        name: 'Helper',
        color: '#10B981',
        power: 'assist',
        hoist: true,
        duty: "Répond, oriente, calme. Peut mettre en sourdine, pas exclure.",
      },
    ],
  },
  {
    key: 'flat',
    label: 'Deux échelons',
    pitch: 'Un administrateur, des modérateurs',
    detail:
      "Pour un serveur qui démarre : au-delà de deux échelons, on passe plus de temps à décider qui est quoi qu'à modérer. Les pôles s'ajoutent plus tard.",
    icon: 'users',
    top: [
      {
        key: 'staff.admin',
        name: 'Administrateur',
        color: '#EF4444',
        power: 'admin',
        hoist: true,
        duty: 'Le vôtre. Tous les droits, aucune limite.',
      },
    ],
    ground: [
      {
        key: 'staff.moderator',
        name: 'Modérateur',
        color: '#3B82F6',
        power: 'moderate',
        hoist: true,
        duty: 'Sanctionne, supprime, exclut. Le travail quotidien.',
      },
    ],
  },
];

/**
 * Les responsables de pôle, à cocher par-dessus la hiérarchie.
 *
 * Ils ne sont pas dans les structures elles-mêmes parce qu'ils n'en font pas
 * partie : un serveur qui organise des événements a besoin d'un responsable
 * événements quelle que soit la façon dont il nomme son rôle de tête. Ils se
 * placent entre la direction et le terrain - au-dessus des modérateurs pour que
 * leurs décisions portent, en dessous de l'administration pour qu'elles
 * s'arbitrent.
 */
export type StaffPole = RoleBlueprint & { byDefault: boolean };

export const STAFF_POLES: StaffPole[] = [
  {
    key: 'staff.pole.moderation',
    name: 'Responsable modération',
    color: '#6366F1',
    power: 'moderate',
    hoist: false,
    duty: "Tranche les sanctions contestées et forme les nouveaux modérateurs.",
    byDefault: true,
  },
  {
    key: 'staff.pole.events',
    name: 'Responsable événements',
    color: '#EC4899',
    power: 'coordinate',
    hoist: false,
    duty: 'Organise et annonce les événements, gère les salons vocaux pendant.',
    byDefault: true,
  },
  {
    key: 'staff.pole.communication',
    name: 'Responsable communication',
    color: '#0EA5E9',
    power: 'coordinate',
    hoist: false,
    duty: 'Écrit les annonces et peut mentionner tout le serveur.',
    byDefault: false,
  },
  {
    key: 'staff.pole.recruitment',
    name: 'Responsable recrutement',
    color: '#8B5CF6',
    power: 'coordinate',
    hoist: false,
    duty: "Suit les candidatures au staff et les entretiens.",
    byDefault: false,
  },
  {
    key: 'staff.pole.partnerships',
    name: 'Responsable partenariats',
    color: '#14B8A6',
    power: 'coordinate',
    hoist: false,
    duty: 'Traite les demandes de partenariat entre serveurs.',
    byDefault: false,
  },
  {
    key: 'staff.pole.animation',
    name: 'Animateur',
    color: '#F59E0B',
    power: 'coordinate',
    hoist: false,
    duty: 'Anime la vie du serveur : jeux, quiz, soirées vocales.',
    byDefault: false,
  },
];

/**
 * La hiérarchie complète, du plus haut au plus bas.
 *
 * L'ordre est celui dans lequel les rôles seront créés, et c'est lui qui décide
 * de la hiérarchie finale : la route les pose dans cet ordre exact.
 */
export function buildStaffLadder(
  structure: StaffStructure,
  poleKeys: readonly string[],
): RoleBlueprint[] {
  const poles = STAFF_POLES.filter((pole) => poleKeys.includes(pole.key));
  return [...structure.top, ...poles, ...structure.ground];
}

export function defaultPoleKeys(): string[] {
  return STAFF_POLES.filter((pole) => pole.byDefault).map((pole) => pole.key);
}

// ── Échelles de rôles de niveau ──────────────────────────────────────────────

export type LevelLadderKey = 'metals' | 'seniority' | 'ranks' | 'plain';

export type LevelLadder = {
  key: LevelLadderKey;
  label: string;
  pitch: string;
  icon: string;
  /**
   * Huit noms, du premier palier au dernier. Le nombre choisi à l'écran y est
   * prélevé en gardant les extrêmes : à trois rôles, on veut Bronze, Or et
   * Légende - pas Bronze, Argent, Or, qui ne raconte que le début de l'échelle.
   */
  names: string[];
};

/** Liste vide pour l'échelle neutre, dont les noms se déduisent des paliers. */
export const LEVEL_LADDERS: LevelLadder[] = [
  {
    key: 'metals',
    label: 'Les métaux',
    pitch: 'Bronze, Argent, Or… tout le monde en comprend l’ordre',
    icon: 'award',
    names: ['Bronze', 'Argent', 'Or', 'Platine', 'Diamant', 'Maître', 'Champion', 'Légende'],
  },
  {
    key: 'seniority',
    label: "L'ancienneté",
    pitch: 'Ce que le rôle dit du membre, pas de son score',
    icon: 'clock',
    names: ['Nouveau', 'Habitué', 'Régulier', 'Fidèle', 'Pilier', 'Vétéran', 'Ancien', 'Légende'],
  },
  {
    key: 'ranks',
    label: 'Les grades',
    pitch: 'Une progression qui se mérite',
    icon: 'trophy',
    names: ['Recrue', 'Initié', 'Confirmé', 'Expert', 'Élite', 'Vétéran', 'Maître', 'Légende'],
  },
  {
    key: 'plain',
    label: 'Sans fioriture',
    pitch: 'Le palier pour nom : « Niveau 20 »',
    icon: 'hash',
    names: [],
  },
];

/**
 * Les couleurs de l'échelle, du plus froid au plus chaud.
 *
 * Une échelle de rôles se lit dans la liste des membres avant de se lire dans
 * un tableau : sans progression de couleur, huit rôles de niveau ne sont que
 * huit lignes.
 */
const LADDER_COLORS = [
  '#94A3B8',
  '#38BDF8',
  '#22D3EE',
  '#34D399',
  '#A3E635',
  '#FBBF24',
  '#FB923C',
  '#F43F5E',
];

/**
 * Les paliers, selon le nombre de rôles voulus.
 *
 * Tabulés plutôt que calculés : à trois rôles on veut une échelle qui couvre
 * toute la vie du serveur, à huit une échelle qui se resserre au début, là où
 * les premiers paliers doivent tomber vite pour donner envie du suivant. Une
 * formule unique rendrait l'un des deux cas absurde.
 */
const TIERS_BY_COUNT: Record<number, number[]> = {
  1: [10],
  2: [10, 40],
  3: [5, 25, 60],
  4: [5, 15, 35, 70],
  5: [5, 15, 30, 50, 80],
  6: [5, 15, 30, 50, 75, 110],
  7: [5, 12, 25, 40, 60, 85, 120],
  8: [5, 10, 20, 35, 55, 80, 110, 150],
};

export const LADDER_COUNTS = [3, 4, 5, 6, 8] as const;
export const MIN_LADDER_COUNT = 1;
export const MAX_LADDER_COUNT = 8;

export function ladderTiers(count: number): number[] {
  const clamped = Math.min(MAX_LADDER_COUNT, Math.max(MIN_LADDER_COUNT, Math.round(count)));
  return TIERS_BY_COUNT[clamped] ?? TIERS_BY_COUNT[5];
}

/** Prélève `count` entrées en gardant la première et la dernière. */
function spread<T>(list: readonly T[], count: number): T[] {
  if (count >= list.length) return [...list];
  if (count <= 1) return list.length > 0 ? [list[list.length - 1]] : [];
  return Array.from({ length: count }, (_, index) =>
    list[Math.round((index * (list.length - 1)) / (count - 1))],
  );
}

/** Un rôle de palier : ce qui part sur Discord, et le niveau qui le débloque. */
export type LevelRoleBlueprint = RoleBlueprint & { level: number };

/**
 * L'échelle complète, du dernier palier au premier.
 *
 * L'ordre est décroissant parce que c'est celui de la création : le rôle le
 * plus haut doit être créé en premier pour se retrouver au-dessus des autres
 * dans la hiérarchie Discord. L'écran, lui, la réaffiche dans l'ordre naturel.
 */
export function buildLevelLadder(ladder: LevelLadder, count: number): LevelRoleBlueprint[] {
  const tiers = ladderTiers(count);
  const names =
    ladder.names.length > 0
      ? spread(ladder.names, tiers.length)
      : tiers.map((level) => `Niveau ${level}`);
  const colors = spread(LADDER_COLORS, tiers.length);

  return tiers
    .map((level, index) => ({
      key: `level.${level}`,
      name: names[index] ?? `Niveau ${level}`,
      color: colors[index] ?? LADDER_COLORS[LADDER_COLORS.length - 1],
      // Aucun pouvoir : un rôle de palier récompense, il n'administre rien.
      power: 'none' as const,
      // Non détaché de la liste des membres : huit rôles de niveau épinglés en
      // feraient une liste de catégories plutôt qu'une liste de gens.
      hoist: false,
      duty: `Débloqué au niveau ${level}.`,
      level,
    }))
    .reverse();
}

/** Ce qu'on envoie à la route de création : le gabarit, sans ce qui l'explique. */
export function toRoleRequests(blueprints: readonly RoleBlueprint[]): OnboardingRoleRequest[] {
  return blueprints.map((entry) => ({
    key: entry.key,
    name: entry.name,
    color: entry.color,
    hoist: entry.hoist,
    power: entry.power,
  }));
}
