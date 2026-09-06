/**
 * Profondeur de cascade d'un evenement du bus.
 *
 * Une automatisation qui reagit a un evenement peut en produire un autre :
 * exclure un membre publie `sanction:applied`, ouvrir un ticket publie
 * `ticket:created`. Rien n'empeche alors le meme workflow de se rappeler
 * indefiniment - « quand une sanction est appliquee, exclure le membre » se
 * redeclenche a chaque tour, sur un membre deja exclu.
 *
 * Le chainage reste utile - un workflow qui en declenche un autre est une
 * fonctionnalite - donc on le borne au lieu de l'interdire : chaque execution
 * incremente la profondeur, et le moteur refuse de repartir au-dela.
 *
 * La valeur voyage par `AsyncLocalStorage` dans le processus, et dans
 * l'enveloppe Redis entre processus : sans ce second chemin, deux instances se
 * renverraient la cascade a l'infini, chacune la voyant repartir de zero.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Partage par le symbole global, comme `kotbo.guildContext` : deux copies du
 * paquet chargees par des chemins differents doivent lire le meme magasin,
 * sinon la profondeur repart a zero d'un module a l'autre.
 */
const key = Symbol.for('kotbo.eventCascade');

const globalScope = globalThis as any;
if (!globalScope[key]) globalScope[key] = new AsyncLocalStorage<number>();

const cascadeStorage: AsyncLocalStorage<number> = globalScope[key];

/** Nombre d'automatisations deja enchainees pour en arriver a l'evenement courant. */
export function currentCascadeDepth(): number {
  const depth = cascadeStorage.getStore();
  return typeof depth === 'number' && Number.isFinite(depth) && depth > 0 ? depth : 0;
}

/** Execute `fn` en annoncant la profondeur atteinte a tout ce qu'il publiera. */
export function runWithCascadeDepth<T>(depth: number, fn: () => T): T {
  return cascadeStorage.run(Math.max(0, Math.trunc(depth)), fn);
}
