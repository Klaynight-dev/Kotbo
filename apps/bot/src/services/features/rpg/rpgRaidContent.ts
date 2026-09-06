/**
 * Sorts et boss de raid livrés de base.
 *
 * Tout est déclaratif, comme les classes de personnage : le moteur d'assaut lit ces
 * données et ne connaît aucun sort en particulier. Ajouter un sort ne demande donc aucune
 * modification du combat, et un serveur peut en composer d'autres depuis le dashboard.
 *
 * Ces fiches sont recopiées dans le serveur au premier allumage du raid, puis lui
 * appartiennent : les modifier ici ne touche pas les serveurs déjà servis, seuls les boss
 * dont le nom manque encore leur sont ajoutés.
 */

export interface RaidSpellEffect {
  /** Multiplicateur appliqué aux dégâts de base. 0 pour un sort qui ne frappe pas. */
  damageMultiplier: number;
  /** Part de la défense du joueur ignorée, de 0 à 1. */
  armorPiercing?: number;
  /** Part des dégâts infligés rendue au boss, prise sur la réserve de l'équipe. */
  lifesteal?: number;
  /** Multiplicateur de la défense du boss pendant `durationTurns` tours. */
  defenseMultiplier?: number;
  /** Part des dégâts subis annulée pendant `durationTurns` tours, de 0 à 1. */
  damageReduction?: number;
  /** Part des dégâts reçus renvoyée à l'attaquant pendant `durationTurns` tours. */
  thorns?: number;
  /** Le joueur perd son prochain tour. */
  stunNextTurn?: boolean;
  /** Durée des effets défensifs, en tours. Un tour par défaut. */
  durationTurns?: number;
}

export interface RaidSpell {
  id: string;
  name: string;
  /** Emoji d'affichage Discord, seule forme qu'un embed sait rendre. */
  emoji: string;
  /** Nom d'icône Papicons, pour le dashboard qui n'affiche pas d'emoji décoratif. */
  icon: string;
  description: string;
  /** Tours à attendre entre deux lancers dans un même assaut. */
  cooldownTurns: number;
  /**
   * Ne se déclenche qu'une fois la réserve de l'équipe descendue sous cette part, de 0 à 1.
   *
   * C'est ce qui donne des phases à un raid : la réserve étant commune, le seuil bascule
   * pour toute l'équipe à la fois et la fin du combat ne ressemble pas au début.
   */
  triggerBelowHealth?: number;
  effect: RaidSpellEffect;
}

/**
 * Sorts proposés au catalogue.
 *
 * Chacun répond à une façon de jouer : la carapace punit qui n'a pas de pénétration
 * d'armure, la gueule dévorante punit les dégâts étalés, les écailles punissent les longs
 * combats, et les sorts de phase récompensent ceux qui gardent leurs assauts pour la fin.
 */
export const RAID_SPELLS: RaidSpell[] = [
  {
    id: 'crushing_blow',
    name: 'Frappe écrasante',
    emoji: '💥',
    icon: 'AlertTriangle',
    description: 'Un coup massif à 190 % de dégâts.',
    cooldownTurns: 3,
    effect: { damageMultiplier: 1.9 },
  },
  {
    id: 'armor_breaker',
    name: 'Brise-armure',
    emoji: '🪓',
    icon: 'Unlock',
    description: 'Ignore 60 % de votre défense.',
    cooldownTurns: 4,
    effect: { damageMultiplier: 1.4, armorPiercing: 0.6 },
  },
  {
    id: 'devouring_maw',
    name: 'Gueule dévorante',
    emoji: '🩸',
    icon: 'Heart',
    description: 'Rend au boss la moitié des dégâts infligés.',
    cooldownTurns: 5,
    effect: { damageMultiplier: 1.2, lifesteal: 0.5 },
  },
  {
    id: 'stone_carapace',
    name: 'Carapace de pierre',
    emoji: '🪨',
    icon: 'Pillar',
    description: 'Le boss ne frappe pas et triple sa défense pendant deux tours.',
    cooldownTurns: 5,
    effect: { damageMultiplier: 0, defenseMultiplier: 3, durationTurns: 2 },
  },
  {
    id: 'terrifying_roar',
    name: 'Rugissement terrifiant',
    emoji: '📢',
    icon: 'Bell',
    description: 'Vous perdez votre tour suivant.',
    cooldownTurns: 6,
    effect: { damageMultiplier: 0, stunNextTurn: true },
  },
  {
    id: 'burning_scales',
    name: 'Écailles brûlantes',
    emoji: '🔥',
    icon: 'Sun',
    description: 'Renvoie un quart des dégâts reçus pendant trois tours.',
    cooldownTurns: 6,
    effect: { damageMultiplier: 0, thorns: 0.25, durationTurns: 3 },
  },
  {
    id: 'frenzy',
    name: 'Frénésie',
    emoji: '😤',
    icon: 'Sparkles',
    description: "À mi-réserve, le boss frappe plus fort et encaisse mieux pendant trois tours.",
    cooldownTurns: 5,
    triggerBelowHealth: 0.5,
    effect: { damageMultiplier: 1.5, damageReduction: 0.3, durationTurns: 3 },
  },
  {
    id: 'last_breath',
    name: "Souffle d'agonie",
    emoji: '☄️',
    icon: 'Ghost',
    description: 'Sous un quart de réserve, un souffle à 260 % de dégâts.',
    cooldownTurns: 4,
    triggerBelowHealth: 0.25,
    effect: { damageMultiplier: 2.6, armorPiercing: 0.3 },
  },
];

export function findRaidSpell(id: string): RaidSpell | null {
  return RAID_SPELLS.find((spell) => spell.id === id) ?? null;
}

export interface SeedRaidBoss {
  name: string;
  description: string;
  emoji: string;
  level: number;
  attack: number;
  defense: number;
  speed: number;
  /** Identifiants pris dans `RAID_SPELLS`. L'ordre compte : voir `pickRaidSpell`. */
  spellIds: string[];
}

/**
 * Quatre boss livrés de base, du plus lent au plus brutal.
 *
 * Ils ne diffèrent pas que par leurs chiffres : chacun demande une autre façon de jouer,
 * sans quoi il n'y aurait qu'un seul boss décliné en quatre niveaux de difficulté.
 */
export const RAID_BOSSES: SeedRaidBoss[] = [
  {
    name: 'Colosse de Rouille',
    description: "Une carcasse de siège que personne n'a fini de démonter. Elle encaisse plus qu'elle ne frappe.",
    emoji: '🗿',
    level: 15,
    attack: 52,
    defense: 48,
    speed: 8,
    spellIds: ['stone_carapace', 'crushing_blow'],
  },
  {
    name: 'Hydre Ancestrale',
    description: 'Chaque tête recousue rend la suivante plus affamée. La laisser respirer, c\'est tout recommencer.',
    emoji: '🐍',
    level: 20,
    attack: 68,
    defense: 30,
    speed: 18,
    spellIds: ['devouring_maw', 'armor_breaker', 'frenzy'],
  },
  {
    name: 'Seigneur des Cendres',
    description: "Il ne défend rien. Il attend simplement que vous frappiez assez longtemps pour brûler.",
    emoji: '🔥',
    level: 25,
    attack: 84,
    defense: 38,
    speed: 22,
    spellIds: ['burning_scales', 'terrifying_roar', 'last_breath'],
  },
  {
    name: "Dévoreur d'Étoiles",
    description: 'Ce qui reste quand une constellation a fini d\'être digérée. Le raid des serveurs qui ont tout vu.',
    emoji: '🌌',
    level: 30,
    attack: 104,
    defense: 56,
    speed: 26,
    spellIds: ['armor_breaker', 'stone_carapace', 'devouring_maw', 'last_breath'],
  },
];

/** Fiche prête à écrire, sorts résolus depuis leurs identifiants. */
export function buildSeedBoss(seed: SeedRaidBoss): Omit<SeedRaidBoss, 'spellIds'> & { spells: RaidSpell[] } {
  const { spellIds, ...rest } = seed;
  return {
    ...rest,
    spells: spellIds.flatMap((id) => {
      const spell = findRaidSpell(id);
      return spell ? [spell] : [];
    }),
  };
}
