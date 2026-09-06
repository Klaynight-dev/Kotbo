/**
 * Ce que la maquette va poser sur Discord, et dans quel ordre.
 *
 * Trois questions, trois fonctions : ce qu'on retient de la maquette
 * (`selectionFor`), ce que cela represente une fois compte (`summarize`), et
 * l'ordre dans lequel Discord le creera (`buildSequence`) - c'est ce dernier
 * que la sequence de montage fait defiler a l'ecran.
 */
import type { ServerTemplatePlanItem } from '../api';
import type { ServerKind, ThemeKey } from './presets';
import { THEMES } from './presets';

/**
 * Les clefs de la maquette a poser, d'apres la vocation choisie.
 *
 * Sur un serveur habite, on ne posait rien : seuls les modules etaient retenus,
 * parce que la maquette complete y aurait double des salons dont des gens se
 * servent. C'etait prudent et c'etait un ecran vide - le seul moment du parcours
 * ou l'on voit le produit agir sur son propre serveur devenait une formalite
 * pour la moitie des serveurs qui l'installent.
 *
 * Le bot dit desormais ce que le serveur porte deja (`present`, rapproche par
 * identifiant puis par nom). On peut donc completer : la vocation choisit les
 * sections, l'existant en est retire, et il ne reste a creer que ce qui manque
 * reellement. Un serveur de trois ans qui n'a jamais eu de salon de tickets
 * voit ses tickets se poser, et son `#reglement` rester intact.
 *
 * Les modules suivent leurs salons : poser un salon de niveaux sans allumer le
 * leveling ne produirait rien. Ceux qui n'ont pas de salon a eux - AutoMod,
 * moderation des pseudos - sont retenus dans tous les cas. Un module dont le
 * salon existait deja est retenu lui aussi : le salon est la, il n'y a plus
 * qu'a brancher ce qui va avec.
 *
 * La selection est renvoyee brute : c'est le serveur qui la remet en etat
 * coherent (`normalizeSelection`), une categorie ne pouvant pas manquer quand
 * un de ses salons est retenu.
 */
export function selectionFor(
  plan: ServerTemplatePlanItem[],
  kind: ServerKind,
  theme: ThemeKey,
  present: readonly string[] = [],
): string[] {
  const modules = plan.filter((item) => item.kind === 'module');
  const wanted = new Set(THEMES.find((entry) => entry.key === theme)?.sections ?? []);
  const alreadyThere = new Set(present);

  const inScope = plan.filter((item) => item.kind !== 'module' && wanted.has(item.section));
  const scopeKeys = new Set(inScope.map((item) => item.key));

  // Ce qui reste a creer. Sur un serveur neuf, `present` est vide et l'on
  // retrouve exactement la selection d'avant.
  const toCreate = inScope
    .filter((item) => !alreadyThere.has(item.key))
    .map((item) => item.key);

  // Un module se branche des lors que son salon est dans le perimetre, qu'il
  // soit a creer ou deja la : c'est le branchement qui compte, pas la creation.
  const keptModules = modules.filter(
    (item) => !item.linkedTo || scopeKeys.has(item.linkedTo),
  );

  if (kind === 'existing') {
    return [...toCreate, ...keptModules.map((item) => item.key)];
  }

  return [...scopeKeys, ...keptModules.map((item) => item.key)];
}

/**
 * Ce que la maquette laisse en place, avec ses noms.
 *
 * L'ecran de structure les affiche en grise, « deja la ». Sans cette liste, une
 * reprise qui ne cree que trois salons sur quinze donne l'impression de n'avoir
 * rien fait ; avec elle, on lit que douze etaient deja bons.
 */
export function alreadyPresent(
  plan: ServerTemplatePlanItem[],
  theme: ThemeKey,
  present: readonly string[],
): { key: string; name: string; kind: ServerTemplatePlanItem['kind'] }[] {
  const wanted = new Set(THEMES.find((entry) => entry.key === theme)?.sections ?? []);
  const alreadyThere = new Set(present);
  return plan
    .filter((item) => item.kind !== 'module' && wanted.has(item.section) && alreadyThere.has(item.key))
    .map((item) => ({ key: item.key, name: item.name, kind: item.kind }));
}

/** Ce que la selection va poser, resume par nature plutot qu'enumere. */
export function summarize(plan: ServerTemplatePlanItem[], selection: string[]) {
  const selected = new Set(selection);
  const items = plan.filter((item) => selected.has(item.key));
  return {
    roles: items.filter((item) => item.kind === 'role').length,
    categories: items.filter((item) => item.kind === 'category').length,
    channels: items.filter((item) => item.kind === 'text' || item.kind === 'voice').length,
    modules: items.filter((item) => item.kind === 'module').length,
    names: items.filter((item) => item.kind !== 'module').map((item) => item.name),
  };
}

/**
 * Ce que la sequence de montage fait defiler, dans l'ordre ou Discord le cree.
 *
 * Les roles d'abord - les permissions des salons s'y adossent -, puis chaque
 * categorie suivie de ses salons. C'est l'ordre reel de la pose : l'animation
 * ne raconte pas une histoire, elle montre celle qui se deroule pendant qu'elle
 * joue.
 */
export type SequenceEntry = {
  key: string;
  name: string;
  kind: ServerTemplatePlanItem['kind'];
  /**
   * Ce que la pose fait de cet element. Un rattachement defile comme une
   * creation, marque autrement : sur un serveur habite, la moitie de ce qui
   * passe a l'ecran existait deja, et le faire defiler sous une coche verte
   * laisserait croire que Kotbo vient de le creer.
   */
  mode: 'create' | 'adopt';
};

export function buildSequence(
  plan: ServerTemplatePlanItem[],
  selection: string[],
  /** Ce que l'administrateur a designe, quand il a eu a le faire. */
  mapping: Record<string, { mode: string }> = {},
): SequenceEntry[] {
  const selected = new Set(selection);
  const items = plan.filter((item) => selected.has(item.key) && item.kind !== 'module');

  const roles = items.filter((item) => item.kind === 'role');
  const categories = items.filter((item) => item.kind === 'category');
  const children = items.filter((item) => item.kind === 'text' || item.kind === 'voice');

  const ordered = [...roles];
  for (const category of categories) {
    ordered.push(category);
    ordered.push(...children.filter((item) => item.parent === category.key));
  }
  // Un salon dont la categorie n'est pas retenue reste a poser : sans cette
  // reprise, il manquerait a l'animation alors qu'il est bien cree.
  ordered.push(...children.filter((item) => !ordered.includes(item)));

  return ordered.map((item) => ({
    key: item.key,
    name: item.name,
    kind: item.kind,
    mode: mapping[item.key]?.mode === 'adopt' ? ('adopt' as const) : ('create' as const),
  }));
}
