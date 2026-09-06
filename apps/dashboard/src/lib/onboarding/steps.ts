/**
 * L'ordre des ecrans, et ce qui decide qu'un ecran existe.
 *
 * Vingt ecrans decrits, jamais vingt ecrans traverses : chacun est rattache a
 * une piste, et une piste decochee retire ses ecrans du parcours - de la barre
 * de progression comprise. Le tronc commun (`track: null`) ne s'esquive pas :
 * on ne peut pas mettre un serveur en service sans savoir dans quelle langue
 * on lui parle ni a quoi il sert.
 *
 * L'ordre, lui, n'est pas negociable, et ce n'est pas une question de recit :
 *
 * - `identity` precede `structure` parce que la maquette nomme ses salons dans
 *   la langue du serveur ;
 * - `theme` la precede parce qu'il decide des sections a poser ;
 * - `tickets` la precede aussi parce que la pose publie le panneau de tickets :
 *   le regler apres laisserait dans le salon un panneau qui ignore les motifs
 *   et la couleur qu'on vient de choisir, et le republier en poserait un second
 *   a cote du premier ;
 * - `greeting`, `rules`, `levels`, `logs` et `staff` la suivent : ils ecrivent
 *   dans un salon ou sur des roles que la pose vient de creer.
 *
 * `layout` dit comment l'ecran occupe la page. La plupart sont en `split` -
 * question a gauche, apercu Discord vivant a droite - parce que c'est la
 * disposition qui repond a « a quoi ca va ressembler ? » pendant qu'on regle.
 * Trois passent en `stage`, plein ecran sans question : le montage du serveur,
 * la demonstration de moderation et le recapitulatif final. L'alternance fait
 * le rythme ; un parcours entierement en deux colonnes serait aussi plat qu'un
 * parcours entierement centre.
 */
import { m } from '../i18n';
import type { ServerKind } from './presets';
import type { TrackKey } from './tracks';
import { ONBOARDING_STEPS, type OnboardingStep } from '@kotbo/contracts';

/**
 * La liste vit desormais dans `@kotbo/contracts` : le bot en a besoin pour
 * distinguer une avancee d'un retour en arriere dans le tunnel d'acquisition,
 * et deux copies auraient diverge des le premier ecran ajoute ici.
 */
export const WIZARD_STEPS = ONBOARDING_STEPS;

export type WizardStep = OnboardingStep;

export type PhaseKey = 'discovery' | 'setup' | 'build' | 'polish' | 'launch';

/** Comment l'ecran occupe la page. */
export type StepLayout =
  /** Une colonne centree : rien a montrer, tout est dans la question. */
  | 'centered'
  /** Question a gauche, apercu Discord a droite. Le cas general. */
  | 'split'
  /** Plein ecran, sans question : on regarde. */
  | 'stage';

export type StepDefinition = {
  key: WizardStep;
  label: () => string;
  icon: string;
  phase: PhaseKey;
  /** La piste qui commande cet ecran. `null` : tronc commun, toujours traverse. */
  track: TrackKey | null;
  /**
   * Ce qui doit etre vrai du serveur pour que l'ecran ait un sens. `null` : il
   * l'a toujours.
   *
   * La reprise n'a rien a dire d'un serveur cree ce matin, et elle ne se coche
   * pas : elle s'impose des qu'on repond « serveur existant ». Un serveur qui
   * tourne depuis des mois porte deja des salons, des roles et souvent d'autres
   * bots - lui proposer de tout monter a neuf sans avoir regarde ce qu'il a
   * serait la meilleure facon de doubler ce qui existe.
   *
   * `structured` ne se lit pas sur cette reponse mais sur le serveur lui-meme.
   * C'est la difference qui a coute le plus cher : on repond « nouveau
   * serveur » parce que Kotbo est nouveau pour soi, et le parcours posait alors
   * la maquette entiere par-dessus vingt salons habites. Les ecrans de mappage
   * apparaissent donc quand le serveur porte quelque chose a rapprocher,
   * quoi qu'on ait repondu.
   */
  requires: 'new' | 'existing' | 'structured' | null;
  /** Porte un « Passer » visible. */
  optional: boolean;
  layout: StepLayout;
};

export const STEPS: StepDefinition[] = [
  { key: 'welcome', label: () => 'Bienvenue', icon: 'sparkles', phase: 'discovery', track: null, requires: null, optional: false, layout: 'centered' },
  { key: 'kind', label: () => 'Votre serveur', icon: 'search', phase: 'discovery', track: null, requires: null, optional: false, layout: 'centered' },
  { key: 'migration-bots', label: () => m.onb_step_migration_bots(), icon: 'radar', phase: 'discovery', track: null, requires: 'existing', optional: false, layout: 'centered' },
  { key: 'migration-findings', label: () => m.onb_step_migration_findings(), icon: 'download', phase: 'discovery', track: null, requires: 'existing', optional: true, layout: 'centered' },
  { key: 'tracks', label: () => m.onb_step_tracks(), icon: 'list-checks', phase: 'discovery', track: null, requires: null, optional: false, layout: 'centered' },

  { key: 'identity', label: () => 'Sa langue', icon: 'globe', phase: 'setup', track: null, requires: null, optional: false, layout: 'split' },
  { key: 'theme', label: () => 'Sa vocation', icon: 'compass', phase: 'setup', track: null, requires: null, optional: false, layout: 'split' },

  { key: 'tickets', label: () => 'Le support', icon: 'inbox', phase: 'build', track: 'tickets', requires: null, optional: true, layout: 'split' },

  // Le mappage d'un serveur habite, section par section. Il precede la pose
  // parce que c'est lui qui decide ce qu'elle a a poser : sans lui, elle
  // deduisait tout d'un rapprochement de noms et doublait ce qu'il ratait.
  // Chaque ecran se retire de lui-meme quand sa vocation n'en retient pas les
  // sections - on ne demande pas ou ranger les vocaux d'un serveur d'entraide.
  { key: 'map-access', label: () => "L'entrée", icon: 'door-open', phase: 'build', track: 'structure', requires: 'structured', optional: false, layout: 'split' },
  { key: 'map-staff', label: () => "L'équipe", icon: 'users', phase: 'build', track: 'structure', requires: 'structured', optional: false, layout: 'split' },
  { key: 'map-tickets', label: () => 'Le support', icon: 'inbox', phase: 'build', track: 'structure', requires: 'structured', optional: false, layout: 'split' },
  { key: 'map-welcome', label: () => "L'accueil", icon: 'book-open', phase: 'build', track: 'structure', requires: 'structured', optional: false, layout: 'split' },
  { key: 'map-stats', label: () => 'Les compteurs', icon: 'chart', phase: 'build', track: 'structure', requires: 'structured', optional: false, layout: 'split' },
  { key: 'map-text', label: () => 'Les discussions', icon: 'message-circle', phase: 'build', track: 'structure', requires: 'structured', optional: false, layout: 'split' },
  { key: 'map-fun', label: () => 'Le fun', icon: 'sparkles', phase: 'build', track: 'structure', requires: 'structured', optional: false, layout: 'split' },
  { key: 'map-voice', label: () => 'Les vocaux', icon: 'mic', phase: 'build', track: 'structure', requires: 'structured', optional: false, layout: 'split' },

  { key: 'structure', label: () => 'La structure', icon: 'layout-grid', phase: 'build', track: 'structure', requires: null, optional: false, layout: 'split' },
  { key: 'moderation', label: () => 'La modération', icon: 'shield', phase: 'build', track: 'moderation', requires: null, optional: false, layout: 'split' },
  { key: 'logs', label: () => m.onb_step_logs(), icon: 'scroll', phase: 'build', track: 'logs', requires: null, optional: true, layout: 'split' },
  { key: 'staff', label: () => m.onb_step_staff(), icon: 'users', phase: 'build', track: 'staff', requires: null, optional: true, layout: 'split' },

  { key: 'greeting', label: () => "L'accueil", icon: 'door-open', phase: 'polish', track: 'greeting', requires: null, optional: false, layout: 'split' },
  { key: 'rules', label: () => 'Le règlement', icon: 'book-open', phase: 'polish', track: 'rules', requires: null, optional: true, layout: 'split' },
  { key: 'levels', label: () => 'La progression', icon: 'crown', phase: 'polish', track: 'levels', requires: null, optional: true, layout: 'split' },
  { key: 'economy', label: () => m.onb_step_economy(), icon: 'coins', phase: 'polish', track: 'economy', requires: null, optional: true, layout: 'split' },
  { key: 'economy-shop', label: () => m.onb_step_economy_shop(), icon: 'shopping-bag', phase: 'polish', track: 'economy', requires: null, optional: true, layout: 'split' },
  { key: 'animation', label: () => m.onb_step_animation(), icon: 'target', phase: 'polish', track: 'animation', requires: null, optional: true, layout: 'split' },
  { key: 'animation-drops', label: () => m.onb_step_animation_drops(), icon: 'gift', phase: 'polish', track: 'animation', requires: null, optional: true, layout: 'split' },

  { key: 'mcp', label: () => m.onb_step_mcp(), icon: 'command', phase: 'launch', track: 'mcp', requires: null, optional: true, layout: 'split' },
  { key: 'recap', label: () => m.onb_step_recap(), icon: 'award', phase: 'launch', track: null, requires: null, optional: false, layout: 'stage' },
  { key: 'checkout', label: () => 'Mise en service', icon: 'gem', phase: 'launch', track: null, requires: null, optional: false, layout: 'centered' },
];

const BY_KEY = new Map(STEPS.map((step) => [step.key, step]));

export function stepDefinition(step: WizardStep): StepDefinition {
  // La carte couvre `WIZARD_STEPS` par construction ; le repli evite qu'une
  // clef inconnue - parcours renomme, etat relu d'une version anterieure -
  // fasse tomber la page plutot que de la ramener au debut.
  return BY_KEY.get(step) ?? STEPS[0];
}

/**
 * Les phases, nommees.
 *
 * « Etape 14 sur 20 » decourage a l'ecran 2. Cinq phases nommees disent la meme
 * longueur en la rendant lisible : on ne compte plus des ecrans, on voit ou l'on
 * en est d'un parcours qui a une forme. Une phase dont toutes les pistes sont
 * decochees disparait entierement de la barre - la progression montre le
 * parcours qu'on s'est choisi, pas celui qu'on aurait pu prendre.
 */
export const PHASES: { key: PhaseKey; label: () => string }[] = [
  { key: 'discovery', label: () => 'Découverte' },
  { key: 'setup', label: () => 'Votre serveur' },
  { key: 'build', label: () => 'Construction' },
  { key: 'polish', label: () => 'Personnalisation' },
  { key: 'launch', label: () => 'Lancement' },
];

/**
 * Les ecrans reellement traverses, d'apres les pistes retenues.
 *
 * C'est la seule liste qui compte : progression, « Suivant », « Retour » et
 * recapitulatif s'y adossent tous. Les etapes du tronc commun y sont toujours,
 * les autres seulement si leur piste est cochee.
 */
export function stepsFor(
  tracks: readonly TrackKey[],
  kind: ServerKind,
  /**
   * Ce que le serveur est, par opposition a ce qu'on a repondu qu'il etait.
   *
   * `structured` vient de la lecture du serveur et non de l'ecran « neuf ou
   * existant ». Faux tant que la maquette n'a pas ete lue : les ecrans de
   * mappage n'apparaissent alors pas, ce qui est le bon defaut - mieux vaut les
   * voir surgir une seconde apres le chargement que faire traverser six ecrans
   * vides a un serveur qui n'a rien a rapprocher.
   */
  context: { structured?: boolean } = {},
): WizardStep[] {
  const kept = new Set(tracks);
  const applies = (step: StepDefinition): boolean => {
    if (step.requires === null) return true;
    if (step.requires === 'structured') return context.structured === true;
    return step.requires === kind;
  };

  return STEPS
    .filter(applies)
    .filter((step) => step.track === null || kept.has(step.track))
    .map((step) => step.key);
}

/** Les ecrans d'une piste, pour dire sur l'ecran de selection ce qu'elle coute. */
export function stepsOfTrack(track: TrackKey): WizardStep[] {
  return STEPS.filter((step) => step.track === track).map((step) => step.key);
}

export function phaseOf(step: WizardStep): PhaseKey {
  return stepDefinition(step).phase;
}

export function phaseLabel(phase: PhaseKey): string {
  return PHASES.find((entry) => entry.key === phase)?.label() ?? '';
}
