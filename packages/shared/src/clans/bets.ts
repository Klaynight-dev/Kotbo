/**
 * Règles des paris en points de clan, partagées entre le bot et le dashboard.
 *
 * Un pari est un ensemble de camps qui se disputent un pot. Le duel n'est qu'un
 * cas particulier - deux camps d'une place - ce qui laisse un seul moteur de
 * résolution couvrir le duel, le pool et les équipes.
 *
 * Les bornes vivent ici pour qu'un réglage refusé par l'API le soit aussi dans
 * le formulaire : sans source unique, la page laisse saisir une valeur que le
 * serveur rejette ensuite sans explication utile.
 */

export const BET_STAKE_FLOOR = 1;
/** Aligné sur le plafond d'un versement de points de clan. */
export const BET_STAKE_CEILING = 1_000_000;
export const BET_SUBJECT_MAX_LENGTH = 200;
export const BET_OPEN_PER_MEMBER_CEILING = 25;
export const BET_ACCEPT_WINDOW_HOURS_MIN = 1;
export const BET_ACCEPT_WINDOW_HOURS_MAX = 720;
/**
 * Plafond de la dette autorisée. Une dette non bornée permet de miser sans fin
 * des points qu'on n'a pas : le classement de la saison deviendrait une liste
 * de promesses plutôt qu'un relevé de contributions.
 */
export const BET_DEBT_CEILING = 1_000_000;

export const BET_SIDES_MIN = 2;
/** Un camp par bouton : au-delà, l'annonce ne tient plus dans une rangée. */
export const BET_SIDES_CEILING = 5;
export const BET_PARTICIPANTS_MIN = 2;
export const BET_PARTICIPANTS_CEILING = 50;
export const BET_SIDE_LABEL_MAX_LENGTH = 60;
/**
 * Plafond d'une prime de fin de saison. Une prime sans borne verserait au
 * podium plus de points que la saison entière n'en a distribués.
 */
export const BET_SEASON_REWARD_CEILING = 100_000;

/** DUEL : deux camps d'une place. POOL : un camp par personne. TEAMS : camps peuplés. */
export type BetShape = 'DUEL' | 'POOL' | 'TEAMS';
export type BetAccess = 'TARGETED' | 'OPEN';
/** Mise fixée par personne, ou par camp et divisée entre ses places. */
export type BetStakeMode = 'PER_MEMBER' | 'PER_SIDE';

export const BET_STAKE_MODES: readonly BetStakeMode[] = ['PER_MEMBER', 'PER_SIDE'];

export interface ClanBetSettings {
  betsEnabled: boolean;
  betChannelId: string | null;
  betAnnouncementChannelId: string | null;
  betMinStake: number;
  betMaxStake: number;
  betMaxOpenPerMember: number;
  betAcceptWindowHours: number;
  betAllowDebt: boolean;
  betMaxDebt: number;
  betDebtResetOnSeason: boolean;
  betResolverRoleIds: string[];
  betAllowPool: boolean;
  betAllowTeams: boolean;
  betAllowOpen: boolean;
  betStakeMode: BetStakeMode;
  betMaxParticipants: number;
  betMaxSides: number;
  betSeasonRewardEnabled: boolean;
  betSeasonRewardRoleId: string | null;
  betRewardTop1: number;
  betRewardTop2: number;
  betRewardTop3: number;
}

export const DEFAULT_CLAN_BET_SETTINGS: ClanBetSettings = {
  betsEnabled: false,
  betChannelId: null,
  betAnnouncementChannelId: null,
  betMinStake: 10,
  betMaxStake: 10_000,
  betMaxOpenPerMember: 5,
  betAcceptWindowHours: 48,
  betAllowDebt: false,
  betMaxDebt: 5_000,
  betDebtResetOnSeason: false,
  betResolverRoleIds: [],
  betAllowPool: false,
  betAllowTeams: false,
  betAllowOpen: false,
  betStakeMode: 'PER_MEMBER',
  betMaxParticipants: 10,
  betMaxSides: 4,
  betSeasonRewardEnabled: false,
  betSeasonRewardRoleId: null,
  betRewardTop1: 0,
  betRewardTop2: 0,
  betRewardTop3: 0,
};

/**
 * Colonnes à lire pour reconstituer ces réglages.
 *
 * Dérivée des valeurs par défaut, et non écrite à la main : une liste tenue à
 * part finit par oublier un réglage, et `normalizeClanBetSettings` remplace
 * alors silencieusement la colonne absente par son défaut. C'est exactement ce
 * qui est arrivé aux primes de fin de saison : réglées côté serveur, lues à
 * zéro par le bot, donc jamais versées.
 */
export const CLAN_BET_SETTINGS_SELECT = Object.fromEntries(
  Object.keys(DEFAULT_CLAN_BET_SETTINGS).map((key) => [key, true]),
) as { [K in keyof ClanBetSettings]: true };

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * Réglages tels qu'ils arrivent, avant normalisation.
 *
 * Les colonnes d'énumération sortent de la base en `string` : exiger ici le type étroit
 * obligerait chaque appelant à transtyper la ligne Prisma qu'il vient de lire, alors que
 * c'est précisément le travail de cette fonction de la ramener dans ses valeurs permises.
 */
export type ClanBetSettingsInput =
  Omit<Partial<ClanBetSettings>, 'betStakeMode'> & { betStakeMode?: string | null };

/**
 * Ramène des réglages venus de la base ou du formulaire dans leurs bornes.
 *
 * Une mise minimale au-dessus de la maximale rendrait tout pari impossible sans
 * que rien ne le signale : les deux sont donc réordonnées plutôt que refusées.
 */
export function normalizeClanBetSettings(raw: ClanBetSettingsInput | null | undefined): ClanBetSettings {
  const source = raw ?? {};
  const minStake = clampInt(source.betMinStake, BET_STAKE_FLOOR, BET_STAKE_CEILING, DEFAULT_CLAN_BET_SETTINGS.betMinStake);
  const maxStake = clampInt(source.betMaxStake, BET_STAKE_FLOOR, BET_STAKE_CEILING, DEFAULT_CLAN_BET_SETTINGS.betMaxStake);

  return {
    betsEnabled: source.betsEnabled ?? DEFAULT_CLAN_BET_SETTINGS.betsEnabled,
    betChannelId: source.betChannelId ?? null,
    betAnnouncementChannelId: source.betAnnouncementChannelId ?? null,
    betMinStake: Math.min(minStake, maxStake),
    betMaxStake: Math.max(minStake, maxStake),
    betMaxOpenPerMember: clampInt(source.betMaxOpenPerMember, 1, BET_OPEN_PER_MEMBER_CEILING, DEFAULT_CLAN_BET_SETTINGS.betMaxOpenPerMember),
    betAcceptWindowHours: clampInt(
      source.betAcceptWindowHours,
      BET_ACCEPT_WINDOW_HOURS_MIN,
      BET_ACCEPT_WINDOW_HOURS_MAX,
      DEFAULT_CLAN_BET_SETTINGS.betAcceptWindowHours,
    ),
    betAllowDebt: source.betAllowDebt ?? DEFAULT_CLAN_BET_SETTINGS.betAllowDebt,
    betMaxDebt: clampInt(source.betMaxDebt, 0, BET_DEBT_CEILING, DEFAULT_CLAN_BET_SETTINGS.betMaxDebt),
    betDebtResetOnSeason: source.betDebtResetOnSeason ?? DEFAULT_CLAN_BET_SETTINGS.betDebtResetOnSeason,
    betResolverRoleIds: Array.isArray(source.betResolverRoleIds) ? source.betResolverRoleIds : [],
    betAllowPool: source.betAllowPool ?? DEFAULT_CLAN_BET_SETTINGS.betAllowPool,
    betAllowTeams: source.betAllowTeams ?? DEFAULT_CLAN_BET_SETTINGS.betAllowTeams,
    betAllowOpen: source.betAllowOpen ?? DEFAULT_CLAN_BET_SETTINGS.betAllowOpen,
    betStakeMode: oneOf(source.betStakeMode, BET_STAKE_MODES, DEFAULT_CLAN_BET_SETTINGS.betStakeMode),
    betMaxParticipants: clampInt(
      source.betMaxParticipants,
      BET_PARTICIPANTS_MIN,
      BET_PARTICIPANTS_CEILING,
      DEFAULT_CLAN_BET_SETTINGS.betMaxParticipants,
    ),
    betMaxSides: clampInt(source.betMaxSides, BET_SIDES_MIN, BET_SIDES_CEILING, DEFAULT_CLAN_BET_SETTINGS.betMaxSides),
    betSeasonRewardEnabled: source.betSeasonRewardEnabled ?? DEFAULT_CLAN_BET_SETTINGS.betSeasonRewardEnabled,
    betSeasonRewardRoleId: source.betSeasonRewardRoleId ?? null,
    betRewardTop1: clampInt(source.betRewardTop1, 0, BET_SEASON_REWARD_CEILING, DEFAULT_CLAN_BET_SETTINGS.betRewardTop1),
    betRewardTop2: clampInt(source.betRewardTop2, 0, BET_SEASON_REWARD_CEILING, DEFAULT_CLAN_BET_SETTINGS.betRewardTop2),
    betRewardTop3: clampInt(source.betRewardTop3, 0, BET_SEASON_REWARD_CEILING, DEFAULT_CLAN_BET_SETTINGS.betRewardTop3),
  };
}

export interface BetSeasonLaureate {
  userId: string;
  /** 1, 2 ou 3. Les ex aequo partagent le meme rang. */
  rank: number;
  netGain: number;
  wins: number;
  /** Prime en points de clan, deja resolue depuis les reglages. */
  reward: number;
}

/**
 * Deux parieurs partagent une marche quand le départage de `buildBettorStandings`
 * les laisse à égalité. L'identifiant, dernier critère de ce tri, n'en fait pas
 * partie : il ne sert qu'à rendre l'ordre stable.
 */
function sameRank(a: BettorStanding | undefined, b: BettorStanding | undefined): boolean {
  if (!a || !b) return false;
  return a.netGain === b.netGain && a.wins === b.wins;
}

/**
 * Podium des parieurs d'une saison, prime comprise.
 *
 * Seul un gain net positif est récompensé : sans ce filtre, une saison où tout
 * le monde a perdu sacrerait le moins malchanceux, et le titre perdrait son
 * sens.
 *
 * Les ex aequo occupent ensemble les marches qui leur reviennent et s'en
 * partagent les primes - deux premiers se partagent celle du premier et celle
 * du second, exactement comme un camp de deux se partage le pot d'un pari. Leur
 * verser à chacun la prime pleine multiplierait la dépense par leur nombre,
 * pour une saison qui n'a pourtant rien distribué de plus.
 *
 * Sont ex aequo ceux que le classement lui-même ne départage pas, gain net
 * **et** victoires : le partager sur le seul gain net sacrait « premiers » deux
 * parieurs que la page et l'embed affichent pourtant l'un au-dessus de l'autre.
 *
 * Le total ne dépasse donc jamais la somme des trois primes, quel que soit le
 * nombre d'ex aequo.
 */
export function buildSeasonLaureates(
  standings: readonly BettorStanding[],
  rewards: Pick<ClanBetSettings, 'betRewardTop1' | 'betRewardTop2' | 'betRewardTop3'>,
): BetSeasonLaureate[] {
  const eligible = standings.filter((entry) => entry.netGain > 0);
  if (eligible.length === 0) return [];

  const steps = [rewards.betRewardTop1, rewards.betRewardTop2, rewards.betRewardTop3]
    .map((value) => Math.max(0, Math.floor(value)));

  const laureates: BetSeasonLaureate[] = [];
  let step = 0;

  for (let index = 0; index < eligible.length && step < steps.length; ) {
    // Tous ceux que le classement laisse à égalité forment un groupe : ils
    // montent sur la même marche et repartent avec la même part.
    const head = eligible[index];
    let size = 1;
    while (index + size < eligible.length && sameRank(eligible[index + size], head)) size += 1;

    // Marches réellement occupées : un groupe plus nombreux que ce qu'il reste
    // de podium ne crée pas de marche supplémentaire.
    const claimed = Math.min(size, steps.length - step);
    const pot = steps.slice(step, step + claimed).reduce((sum, value) => sum + value, 0);

    const share = Math.floor(pot / size);
    // Le reste va aux premiers du groupe, comme le reliquat d'un partage de
    // pot : la somme versée vaut alors exactement les primes des marches
    // occupées, jamais un point de plus.
    let remainder = pot - share * size;

    for (let offset = 0; offset < size; offset += 1) {
      const entry = eligible[index + offset];
      if (!entry) break;
      const bonus = remainder > 0 ? 1 : 0;
      remainder -= bonus;
      laureates.push({
        userId: entry.userId,
        rank: step + 1,
        netGain: entry.netGain,
        wins: entry.wins,
        reward: share + bonus,
      });
    }

    step += claimed;
    index += size;
  }

  return laureates;
}

export type StakeRejection =
  | { ok: false; reason: 'not-integer' }
  | { ok: false; reason: 'below-min'; min: number }
  | { ok: false; reason: 'above-max'; max: number };

export type StakeCheck = { ok: true; stake: number } | StakeRejection;

export function checkStake(raw: number, settings: Pick<ClanBetSettings, 'betMinStake' | 'betMaxStake'>): StakeCheck {
  if (!Number.isInteger(raw)) return { ok: false, reason: 'not-integer' };
  if (raw < settings.betMinStake) return { ok: false, reason: 'below-min', min: settings.betMinStake };
  if (raw > settings.betMaxStake) return { ok: false, reason: 'above-max', max: settings.betMaxStake };
  return { ok: true, stake: raw };
}

/**
 * Ce que doit engager la prochaine personne à prendre place dans un camp.
 *
 * En `PER_SIDE`, la mise annoncée vaut pour le camp entier. Elle est répartie
 * sur ce qui reste à pourvoir plutôt que sur un numéro de place : quelqu'un qui
 * quitte pendant les inscriptions libère la part qu'il avait engagée, et le
 * suivant la reprend. Calculée sur un index, elle laissait le camp un point
 * sous la mise annoncée dès qu'un départ décalait les places.
 *
 * Seules les places déjà payées comptent : une invitation occupe un siège sans
 * avoir rien engagé, et sa part sera calculée quand elle sera honorée.
 *
 * Ce mode exige une capacité connue - sans elle, il n'y a rien à répartir.
 */
export function nextSeatStake(params: {
  stake: number;
  stakeMode: BetStakeMode;
  capacity: number | null;
  /** Places déjà payées dans ce camp. */
  seatsTaken: number;
  /** Somme de ce que ces places ont engagé. */
  alreadyStaked: number;
}): number {
  const stake = Math.max(0, Math.floor(params.stake));
  if (params.stakeMode === 'PER_MEMBER') return stake;

  const capacity = Math.max(1, Math.floor(params.capacity ?? 1));
  const seatsLeft = capacity - Math.max(0, Math.floor(params.seatsTaken));
  if (seatsLeft <= 0) return 0;

  const remaining = stake - Math.max(0, Math.floor(params.alreadyStaked));
  if (remaining <= 0) return 0;

  // Arrondi vers le haut : la dernière place solde exactement le compte, là où
  // un arrondi vers le bas laisserait le camp sous la mise annoncée.
  return Math.ceil(remaining / seatsLeft);
}

export interface BetSideSpec {
  label: string;
  /** `null` pour un camp qui se remplit sans limite. */
  capacity: number | null;
}

export type SideSpecParse =
  | { ok: true; sides: BetSideSpec[] }
  | { ok: false; reason: 'too-few' | 'too-many' | 'duplicate-label' | 'bad-capacity' | 'capacity-required' | 'over-capacity' };

/**
 * Lit une liste de camps saisie en une ligne : « Rouge:1, Bleu:3 ».
 *
 * Le suffixe donne le nombre de places, et c'est ce qui permet de déclarer un
 * 1 contre 3 sans multiplier les options de commande. En mise par camp, il est
 * obligatoire : la part de chacun se calcule à partir du nombre de places, et
 * sans lui la mise individuelle changerait à chaque arrivée, donc après le
 * prélèvement des précédents.
 */
export function parseBetSides(
  raw: string,
  limits: { maxSides: number; maxParticipants: number; stakeMode: BetStakeMode },
): SideSpecParse {
  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length < BET_SIDES_MIN) return { ok: false, reason: 'too-few' };
  if (parts.length > limits.maxSides) return { ok: false, reason: 'too-many' };

  const sides: BetSideSpec[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    const match = /^(.*?)(?::(\d+))?$/.exec(part);
    const label = (match?.[1] ?? part).trim().slice(0, BET_SIDE_LABEL_MAX_LENGTH);
    if (!label) return { ok: false, reason: 'bad-capacity' };

    const key = label.toLowerCase();
    if (seen.has(key)) return { ok: false, reason: 'duplicate-label' };
    seen.add(key);

    const rawCapacity = match?.[2];
    if (rawCapacity === undefined) {
      if (limits.stakeMode === 'PER_SIDE') return { ok: false, reason: 'capacity-required' };
      sides.push({ label, capacity: null });
      continue;
    }

    const capacity = Number(rawCapacity);
    if (!Number.isInteger(capacity) || capacity < 1) return { ok: false, reason: 'bad-capacity' };
    sides.push({ label, capacity });
  }

  const declared = sides.reduce((sum, side) => sum + (side.capacity ?? 1), 0);
  if (declared > limits.maxParticipants) return { ok: false, reason: 'over-capacity' };

  return { ok: true, sides };
}

export type FundingPlan =
  | { ok: true; fromPoints: number; fromDebt: number }
  | { ok: false; reason: 'insufficient-points'; available: number }
  | { ok: false; reason: 'debt-ceiling'; available: number; maxDebt: number; currentDebt: number };

/**
 * Comment couvrir une mise : d'abord les points disponibles, le reste à crédit
 * quand le mode dette est ouvert.
 *
 * Les points sont toujours consommés en premier. L'inverse laisserait un membre
 * accumuler de la dette tout en gardant un score au classement, ce qui revient à
 * afficher des points déjà engagés ailleurs.
 */
export function planStakeFunding(params: {
  stake: number;
  availablePoints: number;
  allowDebt: boolean;
  maxDebt: number;
  currentDebt: number;
}): FundingPlan {
  const { stake, allowDebt, maxDebt } = params;
  const availablePoints = Math.max(0, params.availablePoints);
  const currentDebt = Math.max(0, params.currentDebt);

  if (stake <= availablePoints) return { ok: true, fromPoints: stake, fromDebt: 0 };
  if (!allowDebt) return { ok: false, reason: 'insufficient-points', available: availablePoints };

  const missing = stake - availablePoints;
  if (currentDebt + missing > maxDebt) {
    return { ok: false, reason: 'debt-ceiling', available: availablePoints, maxDebt, currentDebt };
  }

  return { ok: true, fromPoints: availablePoints, fromDebt: missing };
}

/**
 * Répartition d'un gain de points entre remboursement de dette et solde.
 *
 * La dette se rembourse avant tout crédit : un membre endetté qui verrait ses
 * gains arriver au classement pourrait miser à l'infini sans jamais rembourser.
 */
export function applyDebtRepayment(gain: number, debt: number): { repaid: number; credited: number; remainingDebt: number } {
  const amount = Math.max(0, Math.floor(gain));
  const owed = Math.max(0, Math.floor(debt));
  const repaid = Math.min(amount, owed);
  return { repaid, credited: amount - repaid, remainingDebt: owed - repaid };
}

/**
 * Part d'une dette qui reste due quoi qu'il arrive.
 *
 * Le reste est du crédit encore engagé dans des paris non tranchés : il
 * s'efface si le pari est annulé, expire ou tombe à la clôture d'une saison.
 * Confondre les deux fait lire un total qui va fondre tout seul comme une somme
 * réellement perdue.
 */
export function firmDebtOf(amount: number, engaged: number): number {
  return Math.max(0, Math.floor(amount) - Math.max(0, Math.floor(engaged)));
}

/**
 * Le sujet part dans un titre d'embed et dans un nom de fil : les retours à la
 * ligne y sont invisibles ou cassants, ils sont donc aplatis à la saisie plutôt
 * qu'à chaque affichage.
 */
export function normalizeBetSubject(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** Nom du fil ouvert sous l'annonce, borné aux 100 caractères de Discord. */
export function buildBetThreadName(subject: string): string {
  return `Pari - ${subject}`.slice(0, 100);
}

// ─── Enjeu et partage ────────────────────────────────────────────────────────

/** Ce qu'une personne a engagé dans un pari : points prélevés et part à crédit. */
export interface BetEngagement {
  userKey: string;
  escrow: number;
  debt: number;
}

/**
 * Ce qu'un parieur a réellement engagé.
 *
 * Le crédit compte, sinon le gagnant d'un pari contre un membre endetté
 * toucherait moins que la mise annoncée. Et c'est bien le montant inscrit qui
 * compte, jamais la mise théorique : le prélèvement peut avoir été rogné par le
 * plafond de saison, et redistribuer plus que ce qui a été pris créerait des
 * points.
 */
export function engagedAmount(entry: Pick<BetEngagement, 'escrow' | 'debt'>): number {
  return Math.max(0, entry.escrow) + Math.max(0, entry.debt);
}

/** Enjeu total : tout ce que les participants ont engagé, quel que soit leur camp. */
export function computeBetPot(entries: readonly Pick<BetEngagement, 'escrow' | 'debt'>[]): number {
  return entries.reduce((sum, entry) => sum + engagedAmount(entry), 0);
}

export interface PotShare {
  userKey: string;
  payout: number;
}

/**
 * Partage du pot entre les membres du camp gagnant, au prorata de ce que chacun
 * a engagé.
 *
 * Au prorata, et non par têtes : quand les mises sont égales - le cas normal -
 * les deux donnent le même résultat, mais un prélèvement rogné par le plafond de
 * saison rendrait le partage par têtes plus généreux que ce qui a été pris,
 * c'est-à-dire créateur de points.
 *
 * La division tombe rarement juste. Le reste est distribué point par point aux
 * premiers inscrits, dans l'ordre reçu : la somme versée vaut alors exactement
 * le pot, ce qui est la seule propriété qui compte ici.
 */
export function splitPot(pot: number, winners: readonly BetEngagement[]): PotShare[] {
  const total = Math.max(0, Math.floor(pot));
  if (winners.length === 0) return [];

  const engaged = winners.map(engagedAmount);
  const totalEngaged = engaged.reduce((sum, value) => sum + value, 0);

  // Un camp gagnant dont personne n'a rien pu engager - plafond de saison au
  // maximum des deux côtés - n'a pas de prorata calculable : à défaut, le pot se
  // partage à parts égales plutôt que d'échouer ou de rester au bot.
  const shares = totalEngaged > 0
    ? engaged.map((value) => Math.floor((total * value) / totalEngaged))
    : winners.map(() => Math.floor(total / winners.length));

  let remainder = total - shares.reduce((sum, value) => sum + value, 0);
  for (let i = 0; remainder > 0; i = (i + 1) % winners.length) {
    shares[i] = (shares[i] ?? 0) + 1;
    remainder -= 1;
  }

  return winners.map((winner, index) => ({ userKey: winner.userKey, payout: shares[index] ?? 0 }));
}

/**
 * Cote d'un camp : ce que rapporte un point engagé s'il l'emporte, sa propre
 * mise comprise.
 *
 * Sert à l'affichage. Un camp en sous-nombre gagne mécaniquement une meilleure
 * cote, et c'est ce qui pousse les arrivants vers le camp le moins peuplé : sans
 * l'annoncer, le déséquilibre passe pour une injustice au lieu d'un pari plus
 * payant.
 */
export function sideOdds(sideEngaged: number, pot: number): number {
  if (sideEngaged <= 0) return 0;
  return pot / sideEngaged;
}

// ─── Palmarès ────────────────────────────────────────────────────────────────

export interface SettledBetEntry {
  userId: string;
  /** Ce que la personne a engagé, crédit compris. */
  engaged: number;
  /** Ce qu'elle a touché au verdict. Nul pour un perdant. */
  payout: number;
  won: boolean;
}

/** Pari tranché, réduit à ce qu'il faut pour établir un palmarès. */
export interface SettledBet {
  entries: SettledBetEntry[];
  /** Sert uniquement à ordonner les séries. */
  resolvedAt: Date | string;
}

export interface BettorStanding {
  userId: string;
  wins: number;
  losses: number;
  /** Somme des gains nets moins somme des mises perdues. Peut être négative. */
  netGain: number;
  /** Plus longue série de victoires consécutives de la saison. */
  bestStreak: number;
  /** Série en cours à la fin de la période, pour distinguer une forme actuelle. */
  currentStreak: number;
}

/**
 * Palmarès des parieurs d'une saison.
 *
 * Le gain net d'une victoire est ce qui est touché **moins** ce qui avait été
 * engagé : compter le versement entier ferait apparaître un bénéfice là où le
 * gagnant n'a fait que récupérer sa propre mise. Une défaite retranche ce que le
 * perdant avait réellement engagé, crédit compris - c'est bien ce qu'il a perdu.
 *
 * Les paris sont reclassés par date de règlement : les séries n'ont de sens que
 * dans l'ordre où les verdicts sont tombés, or rien ne garantit celui de la
 * source.
 */
export function buildBettorStandings(bets: readonly SettledBet[]): BettorStanding[] {
  const standings = new Map<string, BettorStanding>();

  const entryFor = (userId: string): BettorStanding => {
    const existing = standings.get(userId);
    if (existing) return existing;
    const created: BettorStanding = { userId, wins: 0, losses: 0, netGain: 0, bestStreak: 0, currentStreak: 0 };
    standings.set(userId, created);
    return created;
  };

  const ordered = [...bets].sort(
    (a, b) => new Date(a.resolvedAt).getTime() - new Date(b.resolvedAt).getTime(),
  );

  for (const bet of ordered) {
    // Les entrées d'un même pari sont repliées par personne : un membre à
    // comptes liés replié en amont ne doit pas compter deux victoires pour un
    // seul pari, ni voir sa série gonfler d'un cran par compte.
    const folded = new Map<string, { engaged: number; payout: number; won: boolean }>();
    for (const entry of bet.entries) {
      const current = folded.get(entry.userId) ?? { engaged: 0, payout: 0, won: false };
      folded.set(entry.userId, {
        engaged: current.engaged + Math.max(0, entry.engaged),
        payout: current.payout + Math.max(0, entry.payout),
        won: current.won || entry.won,
      });
    }

    for (const [userId, entry] of folded) {
      const standing = entryFor(userId);
      standing.netGain += entry.payout - entry.engaged;
      if (entry.won) {
        standing.wins += 1;
        standing.currentStreak += 1;
        standing.bestStreak = Math.max(standing.bestStreak, standing.currentStreak);
      } else {
        standing.losses += 1;
        standing.currentStreak = 0;
      }
    }
  }

  // Départage : le gain net d'abord, puis le nombre de victoires - deux parieurs
  // à égalité de points ne doivent pas s'échanger de place au gré de l'ordre de
  // lecture de la base.
  return [...standings.values()].sort(
    (a, b) => b.netGain - a.netGain || b.wins - a.wins || a.userId.localeCompare(b.userId),
  );
}
