/**
 * Modèle « recette » - la représentation lisible d'une automatisation.
 *
 * Le moteur du bot n'exécute qu'une chose : un `WorkflowGraph`, avec ses fils
 * d'exécution et ses fils de données typés. C'est un excellent format
 * d'exécution et un très mauvais format d'édition : y écrire « souhaite la
 * bienvenue au nouveau membre » demande quatre nœuds et cinq fils.
 *
 * La recette est la même automatisation vue comme une phrase : un déclencheur,
 * puis une suite d'étapes, chacune remplie de valeurs choisies dans des menus.
 * `compile.ts` la traduit en graphe, `decompile.ts` fait le chemin inverse.
 * Aucune donnée n'est stockée sous cette forme : la base ne connaît toujours
 * que le graphe, ce qui évite toute migration et garde les deux vues
 * interchangeables.
 */

// ============================================================================
// VALEURS
// ============================================================================

/**
 * Ce qui remplit un champ d'étape.
 *
 * Volontairement fermé : chaque variante correspond à un contrôle d'interface
 * précis (champ texte, sélecteur de rôle, sélecteur de salon…), il n'y a donc
 * jamais de champ « libre » dont l'utilisateur devrait deviner le format.
 */
export type ValueRef =
  /** Texte pouvant contenir des jetons `{membre.pseudo}` */
  | { from: 'text'; template: string }
  | { from: 'number'; value: number }
  | { from: 'boolean'; value: boolean }
  | { from: 'role'; roleId: string }
  | { from: 'channel'; channelId: string }
  /** Valeur issue du contexte du déclencheur, ex. `member` ou `member.displayName` */
  | { from: 'context'; path: string };

export const EMPTY_TEXT: ValueRef = { from: 'text', template: '' };

/** Jeton `{chemin}` inséré dans un texte. */
const TOKEN_PATTERN = /\{([a-zA-Z0-9_.]+)\}/g;

/** Chemins de contexte référencés par un texte, dans l'ordre d'apparition. */
export function templateTokens(template: string): string[] {
  const found: string[] = [];
  for (const match of template.matchAll(TOKEN_PATTERN)) {
    if (!found.includes(match[1])) found.push(match[1]);
  }
  return found;
}

export function isEmptyValue(ref: ValueRef | undefined): boolean {
  if (!ref) return true;
  switch (ref.from) {
    case 'text': return ref.template.trim() === '';
    case 'role': return !ref.roleId;
    case 'channel': return !ref.channelId;
    case 'context': return !ref.path;
    default: return false;
  }
}

// ============================================================================
// ÉTAPES
// ============================================================================

/** Une action à effet de bord : envoyer, attribuer, sanctionner… */
export interface ActionStep {
  id: string;
  kind: 'action';
  /** Type de nœud du catalogue moteur, ex. `SendMessage` */
  action: string;
  /** Valeurs des champs, indexées par la clé du champ */
  values: Record<string, ValueRef>;
  /** Réglages qui ne sont pas des valeurs branchables (couleur d'embed…) */
  options?: Record<string, unknown>;
}

/** Une pause, reprise même après un redémarrage du bot. */
export interface WaitStep {
  id: string;
  kind: 'wait';
  seconds: number;
}

/**
 * Un test, tel que l'utilisateur le formule : « le membre possède le rôle X ».
 * `negate` porte la nuance « ne … pas », qui se compile en nœud NON.
 */
export interface ConditionTest {
  id: string;
  /** Clé d'une entrée de `CONDITION_LIBRARY` */
  condition: string;
  /** Opérateur de comparaison, pour les conditions qui en proposent */
  operator?: string;
  value?: ValueRef;
  negate?: boolean;
}

/** Un embranchement : « si …, alors … sinon … ». */
export interface ConditionStep {
  id: string;
  kind: 'condition';
  /** `all` = toutes les conditions, `any` = au moins une */
  match: 'all' | 'any';
  tests: ConditionTest[];
  then: RecipeStep[];
  otherwise: RecipeStep[];
}

export type RecipeStep = ActionStep | WaitStep | ConditionStep;

export interface RecipeTrigger {
  /** Type de nœud déclencheur du catalogue, ex. `OnMemberJoin` */
  type: string;
  config?: Record<string, unknown>;
}

export interface Recipe {
  trigger: RecipeTrigger;
  steps: RecipeStep[];
}

export function emptyRecipe(triggerType = ''): Recipe {
  return { trigger: { type: triggerType }, steps: [] };
}

// ============================================================================
// IDENTIFIANTS
// ============================================================================

/**
 * Les identifiants d'étape deviennent des identifiants de nœuds : ils doivent
 * être stables d'une compilation à l'autre pour que le graphe ne soit pas
 * intégralement recréé à chaque frappe au clavier.
 */
export function newStepId(prefix = 's'): string {
  return `${prefix}${Math.random().toString(36).slice(2, 9)}`;
}

// ============================================================================
// PARCOURS
// ============================================================================

/** Toutes les étapes, branches comprises, en profondeur d'abord. */
export function walkSteps(steps: RecipeStep[]): RecipeStep[] {
  const out: RecipeStep[] = [];
  for (const step of steps) {
    out.push(step);
    if (step.kind === 'condition') {
      out.push(...walkSteps(step.then), ...walkSteps(step.otherwise));
    }
  }
  return out;
}

export function countSteps(recipe: Recipe): number {
  return walkSteps(recipe.steps).length;
}

/**
 * Une liste d'étapes accepte-t-elle une suite ?
 *
 * Une condition consomme le reste du parcours dans ses deux branches : une
 * sortie d'exécution n'accepte qu'un seul fil, et la compilation n'a donc rien
 * où raccrocher ce qui viendrait après. Une liste qui se termine par un « Si »
 * est close, et l'éditeur doit le refléter - sans cette garde, les étapes
 * ajoutées derrière seraient perdues à l'enregistrement, sans message.
 */
export function acceptsMoreSteps(steps: RecipeStep[]): boolean {
  return steps[steps.length - 1]?.kind !== 'condition';
}

/**
 * Déplacements autorisés pour l'étape à cette position, l'invariant « une
 * condition est toujours la dernière de sa liste » devant survivre au
 * déplacement.
 */
export function movableSteps(steps: RecipeStep[], index: number): { up: boolean; down: boolean } {
  return {
    up: index > 0 && steps[index]?.kind !== 'condition',
    down: index < steps.length - 1 && steps[index + 1]?.kind !== 'condition',
  };
}

/** Applique une transformation à l'étape ciblée, où qu'elle soit dans l'arbre. */
export function mapStep(
  steps: RecipeStep[],
  id: string,
  transform: (step: RecipeStep) => RecipeStep,
): RecipeStep[] {
  return steps.map((step) => {
    if (step.id === id) return transform(step);
    if (step.kind === 'condition') {
      return {
        ...step,
        then: mapStep(step.then, id, transform),
        otherwise: mapStep(step.otherwise, id, transform),
      };
    }
    return step;
  });
}

/** Retire l'étape ciblée, où qu'elle soit dans l'arbre. */
export function removeStep(steps: RecipeStep[], id: string): RecipeStep[] {
  return steps
    .filter((step) => step.id !== id)
    .map((step) => (step.kind === 'condition'
      ? { ...step, then: removeStep(step.then, id), otherwise: removeStep(step.otherwise, id) }
      : step));
}

/**
 * Insère `inserted` dans la liste `branch` (chemin d'accès depuis la racine),
 * à la position demandée.
 *
 * Le chemin est une suite d'`id:branche` - ex. `['s3:then']` désigne la branche
 * « alors » de l'étape `s3`. La racine est le chemin vide.
 */
export function insertStep(
  steps: RecipeStep[],
  path: string[],
  index: number,
  inserted: RecipeStep,
): RecipeStep[] {
  if (path.length === 0) {
    const next = [...steps];
    next.splice(index < 0 ? next.length : index, 0, inserted);
    return next;
  }

  const [head, ...rest] = path;
  const [stepId, branch] = head.split(':');

  return steps.map((step) => {
    if (step.id !== stepId || step.kind !== 'condition') return step;
    const key = branch === 'otherwise' ? 'otherwise' : 'then';
    return { ...step, [key]: insertStep(step[key], rest, index, inserted) };
  });
}

/** Déplace une étape d'un cran vers le haut ou vers le bas dans sa branche. */
export function moveStep(steps: RecipeStep[], id: string, delta: number): RecipeStep[] {
  const index = steps.findIndex((step) => step.id === id);

  if (index >= 0) {
    const target = index + delta;
    if (target < 0 || target >= steps.length) return steps;
    const next = [...steps];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    return next;
  }

  return steps.map((step) => (step.kind === 'condition'
    ? { ...step, then: moveStep(step.then, id, delta), otherwise: moveStep(step.otherwise, id, delta) }
    : step));
}
