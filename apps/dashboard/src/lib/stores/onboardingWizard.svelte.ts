/**
 * Ou l'on en est dans le parcours de configuration, et ce qu'on y a repondu.
 *
 * Chaque etape ecrit en la validant : ce qui est fait est donc lisible du
 * serveur lui-meme, et c'est lui qui fait foi a la reprise. Ce qui est garde
 * ici, ce sont les reponses que rien ne permet de relire - la vocation choisie,
 * le niveau de moderation retenu, les pistes cochees - et l'ecran courant, pour
 * qu'un rafraichissement ne renvoie pas au debut.
 *
 * Deux memoires, dans cet ordre. Le `localStorage` ecrit a chaque clic et rend
 * la main tout de suite : le parcours n'attend jamais le reseau pour avancer.
 * La colonne `onboardingState` de la guilde recoit la meme chose, sans qu'on
 * l'attende, et ne sert qu'a une chose : reprendre sur un autre appareil, ou
 * proposer depuis le tableau de bord de finir ce qui a ete laisse. Au
 * chargement, la version la plus avancee des deux gagne - « la plus avancee »
 * se mesurant au nombre d'etapes validees, pas a une date, parce que deux
 * horloges de navigateur ne s'accordent pas.
 *
 * La navigation ne suit pas `WIZARD_STEPS` mais la liste des ecrans reellement
 * retenus (`stepsFor`). Une piste decochee ne se traverse pas, meme en cliquant
 * « Retour » : le parcours qu'on parcourt est celui qu'on s'est choisi.
 */
import {
  WIZARD_STEPS,
  defaultTracks,
  stepsFor,
  type DropRhythm,
  type EconomyRhythm,
  type LevelRhythm,
  type McpScope,
  type MappingDecision,
  type MappingState,
  type ModerationLevel,
  type RetentionKey,
  type ServerKind,
  type ThemeKey,
  type TrackKey,
  type WizardStep,
} from '../onboarding';
import { fetchOnboardingState, saveOnboardingState } from '../api';

type WizardState = {
  step: WizardStep;
  kind: ServerKind | null;
  /** Pistes retenues. `null` tant que l'ecran de selection n'a pas ete valide. */
  tracks: TrackKey[] | null;
  theme: ThemeKey | null;
  /**
   * Le serveur porte deja quelque chose a rapprocher de la maquette.
   *
   * Lu sur le serveur au chargement, pas demande. C'est ce qui fait apparaitre
   * les ecrans de mappage, et c'est garde ici pour qu'un rafraichissement ne
   * fasse pas disparaitre six ecrans du parcours en cours de route.
   */
  structured: boolean | null;
  /**
   * Ce qui a ete decide ligne par ligne : quel salon existant tient quel role
   * du plan, quoi creer, quoi laisser de cote.
   *
   * Garde comme une reponse et non comme une lecture : c'est un jugement sur
   * son propre serveur, personne n'a envie de le refaire parce qu'un onglet a
   * ete ferme. La detection ne sert qu'a le pre-remplir la premiere fois.
   */
  mapping: MappingState | null;
  moderation: ModerationLevel | null;
  /** Teinte des panneaux publies par le bot, choisie a l'ecran « support ». */
  panelColor: string | null;
  rhythm: LevelRhythm | null;

  // ── Modules ajoutes ────────────────────────────────────────────────────────
  currencyName: string | null;
  currencyEmoji: string | null;
  economyRhythm: EconomyRhythm | null;
  shopKeys: string[] | null;
  retention: RetentionKey | null;
  logChannelId: string | null;
  staffRoleIds: string[] | null;
  staffAlertChannelId: string | null;
  questKeys: string[] | null;
  dropRhythm: DropRhythm | null;
  dropChannelId: string | null;
  mcpScope: McpScope | null;

  /**
   * Quand le parcours a commence, en millisecondes.
   *
   * Sert au recapitulatif : « quarante-sept reglages poses en six minutes » est
   * une phrase qui ne s'ecrit pas sans cette valeur, et c'est celle qui fait
   * mesurer ce qu'on vient de faire.
   */
  startedAt: number | null;
  /** Etapes validees, pour ne pas redemander ce qui a deja ete ecrit. */
  done: WizardStep[];
};

const DEFAULT_STATE: WizardState = {
  step: 'welcome',
  kind: null,
  tracks: null,
  theme: null,
  structured: null,
  mapping: null,
  moderation: null,
  panelColor: null,
  rhythm: null,
  currencyName: null,
  currencyEmoji: null,
  economyRhythm: null,
  shopKeys: null,
  retention: null,
  logChannelId: null,
  staffRoleIds: null,
  staffAlertChannelId: null,
  questKeys: null,
  dropRhythm: null,
  dropChannelId: null,
  mcpScope: null,
  startedAt: null,
  done: [],
};

const storageKey = (guildId: string) => `kotbo-wizard-${guildId}`;

/**
 * Remet en forme ce qu'on relit, d'ou que ca vienne.
 *
 * Le navigateur et la base portent le meme objet, ecrit par une version du
 * parcours qui n'est pas forcement celle qui le relit. Une etape disparue, une
 * piste renommee ou un tableau devenu autre chose ne doivent pas casser la
 * page : ils reviennent a leur valeur par defaut.
 */
function sanitize(parsed: unknown): WizardState {
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_STATE };
  const raw = parsed as Record<string, unknown>;

  const stringArray = (value: unknown): string[] | null =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : null;

  return {
    ...DEFAULT_STATE,
    ...raw,
    tracks: stringArray(raw.tracks) as TrackKey[] | null,
    shopKeys: stringArray(raw.shopKeys),
    staffRoleIds: stringArray(raw.staffRoleIds),
    questKeys: stringArray(raw.questKeys),
    structured: typeof raw.structured === 'boolean' ? raw.structured : null,
    mapping: sanitizeMapping(raw.mapping),
    done: (stringArray(raw.done) ?? []).filter(
      (entry): entry is WizardStep => (WIZARD_STEPS as readonly string[]).includes(entry),
    ),
    // Une etape inconnue - parcours renomme depuis - ramene au debut plutot
    // que de laisser la page sur un ecran qui n'existe plus.
    step: (WIZARD_STEPS as readonly string[]).includes(raw.step as string)
      ? (raw.step as WizardStep)
      : 'welcome',
  };
}

/**
 * Un mappage relu, ramene a ce qu'il pretend etre.
 *
 * Il vient du navigateur ou de la base, ecrit par une version du parcours qui
 * n'est pas forcement celle qui le relit. Une decision inconnue ou un
 * identifiant qui n'en est pas un est ecarte ligne a ligne : perdre une ligne
 * la remet sur la detection, alors que rejeter l'objet entier ferait
 * recommencer tout l'ecran.
 */
function sanitizeMapping(value: unknown): MappingState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const clean: MappingState = {};

  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const decision = raw as Record<string, unknown>;
    const mode = decision.mode;
    if (mode !== 'adopt' && mode !== 'create' && mode !== 'skip') continue;
    const id = typeof decision.id === 'string' && /^\d{5,25}$/.test(decision.id) ? decision.id : null;
    // Une adoption sans identifiant ne designe rien : elle repart en creation
    // plutot que d'envoyer au bot une ligne qu'il refusera.
    if (mode === 'adopt' && !id) { clean[key] = { mode: 'create', id: null }; continue; }
    clean[key] = { mode, id };
  }

  return Object.keys(clean).length > 0 ? clean : null;
}

function readState(guildId: string): WizardState {
  try {
    const raw = localStorage.getItem(storageKey(guildId));
    if (!raw) return { ...DEFAULT_STATE };
    return sanitize(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function writeState(guildId: string | null, next: WizardState): void {
  if (!guildId) return;
  try {
    localStorage.setItem(storageKey(guildId), JSON.stringify(next));
  } catch {
    // Mode prive, quota plein : le parcours vaut pour la session en cours.
  }
  scheduleRemoteSave(guildId, next);
}

// ── Doublure distante ────────────────────────────────────────────────────────

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * L'ecriture distante, groupee.
 *
 * Un ecran ou l'on tape le nom de sa monnaie declenche une ecriture par
 * caractere. Le navigateur les encaisse sans broncher ; le serveur n'a aucune
 * raison de les recevoir. Une seconde de silence suffit a n'envoyer que l'etat
 * final, et un echec ne remonte pas - la memoire qui compte pour avancer est
 * deja ecrite.
 */
function scheduleRemoteSave(guildId: string, next: WizardState): void {
  if (saveTimer) clearTimeout(saveTimer);
  const snapshot = JSON.parse(JSON.stringify(next)) as Record<string, unknown>;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveOnboardingState(snapshot, guildId);
  }, 1000);
}

const initialGuildId = typeof localStorage !== 'undefined' ? localStorage.getItem('kotbo_guild_id') : null;
let guildId = $state<string | null>(initialGuildId);
let state = $state<WizardState>(initialGuildId ? readState(initialGuildId) : { ...DEFAULT_STATE });

export const wizard = {
  get ready() { return guildId !== null; },
  get step() { return state.step; },
  get kind() { return state.kind; },
  get theme() { return state.theme; },
  get structured() { return state.structured === true; },
  get mapping(): MappingState { return state.mapping ?? {}; },
  get moderation() { return state.moderation; },
  get panelColor() { return state.panelColor; },
  get rhythm() { return state.rhythm; },
  get currencyName() { return state.currencyName; },
  get currencyEmoji() { return state.currencyEmoji; },
  get economyRhythm() { return state.economyRhythm; },
  get shopKeys() { return state.shopKeys; },
  get retention() { return state.retention; },
  get logChannelId() { return state.logChannelId; },
  get staffRoleIds() { return state.staffRoleIds; },
  get staffAlertChannelId() { return state.staffAlertChannelId; },
  get questKeys() { return state.questKeys; },
  get dropRhythm() { return state.dropRhythm; },
  get dropChannelId() { return state.dropChannelId; },
  get mcpScope() { return state.mcpScope; },
  get startedAt() { return state.startedAt; },

  /**
   * Les pistes retenues.
   *
   * Avant que l'ecran de selection ait ete valide, ce sont celles que l'etat du
   * serveur suggere : la barre de progression doit annoncer une longueur des le
   * premier ecran, et non attendre qu'on ait coche quoi que ce soit.
   */
  get tracks(): TrackKey[] {
    return state.tracks ?? defaultTracks(state.kind ?? 'new');
  },
  /** Vrai une fois l'ecran de selection valide : avant, ce ne sont que des suggestions. */
  get tracksChosen() { return state.tracks !== null; },

  /** Les ecrans reellement traverses, dans l'ordre. */
  get steps(): WizardStep[] {
    return stepsFor(this.tracks, state.kind ?? 'new', { structured: state.structured === true });
  },

  get index() { return this.steps.indexOf(state.step); },
  get total() { return this.steps.length; },
  get isFirst() { return this.index <= 0; },

  isDone(step: WizardStep): boolean {
    return state.done.includes(step);
  },

  /** Combien de temps le parcours a dure, en minutes pleines. Au moins une. */
  get elapsedMinutes(): number {
    if (!state.startedAt) return 1;
    return Math.max(1, Math.round((Date.now() - state.startedAt) / 60_000));
  },

  initialize(newGuildId: string): void {
    if (guildId === newGuildId) return;
    guildId = newGuildId;
    state = readState(newGuildId);
    if (!state.startedAt) {
      state.startedAt = Date.now();
      writeState(guildId, state);
    }
  },

  /**
   * Rattrape ce qu'un autre appareil aurait laisse plus loin.
   *
   * Appele une fois au chargement, apres `initialize`. On ne remplace que si le
   * serveur porte strictement plus d'etapes validees : a egalite, le navigateur
   * garde la main - c'est lui qui a les reponses en cours de saisie.
   */
  async hydrateFromServer(): Promise<void> {
    if (!guildId) return;
    const remote = await fetchOnboardingState(guildId);
    if (!remote) return;
    const candidate = sanitize(remote);
    if (candidate.done.length <= state.done.length) return;
    state = candidate;
  },

  goto(step: WizardStep): void {
    state.step = step;
    writeState(guildId, state);
  },

  next(): void {
    const steps = this.steps;
    const at = steps.indexOf(state.step);
    if (at < 0 || at >= steps.length - 1) return;
    state.step = steps[at + 1];
    writeState(guildId, state);
  },

  back(): void {
    const steps = this.steps;
    const at = steps.indexOf(state.step);
    if (at <= 0) return;
    state.step = steps[at - 1];
    writeState(guildId, state);
  },

  /** Marque l'etape ecrite, puis passe a la suivante. */
  complete(step: WizardStep): void {
    if (!state.done.includes(step)) state.done = [...state.done, step];
    writeState(guildId, state);
    this.next();
  },

  answer(patch: Partial<Omit<WizardState, 'step' | 'done'>>): void {
    Object.assign(state, patch);
    writeState(guildId, state);
  },

  /**
   * Installe le mappage de depart, tel que la detection le propose.
   *
   * Appele a chaque lecture de la maquette, et sans effet sur les lignes deja
   * decidees : c'est `defaultMapping` qui garde les reponses precedentes. Sans
   * cette precaution, revenir d'un ecran en arriere effacerait les corrections
   * qu'on venait justement d'y apporter.
   */
  seedMapping(mapping: MappingState): void {
    state.mapping = mapping;
    writeState(guildId, state);
  },

  /** Ce qu'on vient de decider d'une ligne : l'adopter, la creer, l'ecarter. */
  decide(key: string, decision: MappingDecision): void {
    state.mapping = { ...(state.mapping ?? {}), [key]: decision };
    writeState(guildId, state);
  },

  /**
   * Change la selection de pistes en cours de route.
   *
   * Ajouter une piste depuis le recapitulatif doit ramener a son premier ecran,
   * pas laisser sur place : sans ce saut, on cocherait « L'economie » et rien ne
   * se passerait. En retirer une alors qu'on est dessus ramene a l'ecran de
   * selection, seul endroit dont on est sur qu'il existe encore.
   */
  setTracks(tracks: TrackKey[], options: { gotoFirstOf?: TrackKey } = {}): void {
    state.tracks = [...tracks];

    if (options.gotoFirstOf) {
      const target = stepsFor(tracks, state.kind ?? 'new', { structured: state.structured === true })
        .find((step) => !state.done.includes(step) && step !== 'recap' && step !== 'checkout');
      if (target) state.step = target;
    } else if (!stepsFor(tracks, state.kind ?? 'new', { structured: state.structured === true }).includes(state.step)) {
      state.step = 'tracks';
    }

    writeState(guildId, state);
  },

  /**
   * Reprend au premier ecran qui n'a pas encore ete valide.
   *
   * Appele quand le serveur porte deja des traces d'un passage precedent - une
   * structure posee, par exemple. Sans cela, quelqu'un qui revient se verrait
   * proposer de reposer des salons qui existent.
   */
  resumeAfter(step: WizardStep): void {
    if (!state.done.includes(step)) state.done = [...state.done, step];
    const steps = this.steps;
    const at = steps.indexOf(step);
    const current = steps.indexOf(state.step);
    if (at >= 0 && at >= current && at < steps.length - 1) {
      state.step = steps[at + 1];
    }
    writeState(guildId, state);
  },
};
