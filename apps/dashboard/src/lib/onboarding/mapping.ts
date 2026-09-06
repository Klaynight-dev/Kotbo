/**
 * Quel salon, quel role tient deja chacun des roles du plan.
 *
 * Le parcours savait poser une maquette sur un serveur vide. Sur un serveur
 * habite, il devinait : un rapprochement par nom decidait seul, et tout ce
 * qu'il n'attrapait pas se recreait a cote. Un `#logs-mod` de trois ans
 * ressortait double d'un `#staff-logs` tout neuf, et l'administrateur le
 * decouvrait sur Discord une fois la pose faite.
 *
 * Ce fichier remplace la devinette par une question. Chaque element du plan
 * devient une ligne a trois issues - utiliser un salon existant, en creer un,
 * ne rien faire - pre-remplie avec ce que la detection propose, et corrigeable.
 * La detection ne disparait pas : elle passe du statut de decision a celui de
 * suggestion, ce qui est la seule place qu'elle merite tant qu'elle repose sur
 * la ressemblance des noms.
 *
 * Les lignes sont groupees par ecran plutot que servies d'un bloc. Vingt-cinq
 * menus deroulants sur une meme page, c'est un formulaire administratif ; cinq
 * ecrans de quatre lignes, c'est une conversation. Chacun ouvre sur sa
 * categorie - ou est-ce que ca vit ? - parce que ranger vingt salons apres coup
 * est le genre de corvee qu'on ne fait jamais.
 */
import type { ServerTemplatePlanItem, ServerTemplateSection, ServerTemplateState } from '../api';
import type { ThemeKey } from './presets';
import { THEMES } from './presets';
import type { WizardStep } from './steps';

/** Ce qu'on fait d'une ligne du plan. */
export type MappingMode =
  /** Un salon ou un role du serveur remplit deja ce role : on s'y branche. */
  | 'adopt'
  /** Rien ne le remplit : Kotbo le pose. */
  | 'create'
  /** Ni l'un ni l'autre. Le module qui en depend restera eteint, et c'est dit. */
  | 'skip';

export type MappingDecision = {
  mode: MappingMode;
  /** Renseigne pour `adopt` seulement. */
  id: string | null;
};

export type MappingState = Record<string, MappingDecision>;

/**
 * Les ecrans de mappage, dans l'ordre ou on les traverse.
 *
 * Le decoupage suit les sections de la maquette et non un equilibrage de
 * lignes : on repond mieux a « parlons du staff » qu'a « voici les lignes 8 a
 * 12 ». `access` et `security` tiennent sur le meme ecran parce que le role
 * Membre et le salon piege repondent tous deux a la question de l'entree ;
 * `text` et `bots` aussi, les salons de bots etant des salons de discussion
 * comme les autres du point de vue de qui range son serveur.
 */
export type MappingScreen = {
  step: WizardStep;
  sections: ServerTemplateSection[];
  title: string;
  lead: string;
  icon: string;
};

export const MAPPING_SCREENS: MappingScreen[] = [
  {
    step: 'map-access',
    sections: ['access', 'security'],
    title: 'Comment on entre chez vous.',
    lead: "Le rôle donné aux membres, et le salon-piège qui attrape les bots de spam. Si votre serveur a déjà un rôle qui joue ce rôle-là, désignez-le : Kotbo s'y branchera au lieu d'en créer un deuxième.",
    icon: 'door-open',
  },
  {
    step: 'map-staff',
    sections: ['staff'],
    title: 'Votre équipe.',
    lead: "Le rôle du staff et ses salons. C'est ici que les doublons font le plus de dégâts : un second salon de journalisation, et la moitié des traces partent dans celui que personne ne regarde.",
    icon: 'users',
  },
  {
    step: 'map-tickets',
    sections: ['tickets'],
    title: 'Le support.',
    lead: "Où les demandes arrivent, et où leurs transcriptions se rangent. Un serveur qui a déjà une catégorie de tickets la garde, avec les tickets ouverts qui s'y trouvent.",
    icon: 'inbox',
  },
  {
    step: 'map-welcome',
    sections: ['welcome'],
    title: "L'accueil et le règlement.",
    lead: "Le règlement écrit à la main est ce qu'on tient le plus à ne pas voir doublé. Désignez-le, Kotbo écrira dedans plutôt qu'à côté.",
    icon: 'book-open',
  },
  {
    step: 'map-stats',
    sections: ['stats'],
    title: 'Les compteurs du serveur.',
    lead: "Des salons vocaux que personne ne rejoint : leur nom porte le chiffre, et Kotbo le tient à jour. Si vous en avez déjà, désignez-les — ils seront renommés au même format, pas doublés.",
    icon: 'chart',
  },
  {
    step: 'map-text',
    sections: ['text', 'bots'],
    title: 'Les salons de discussion.',
    lead: "Ceux qui existent déjà n'ont aucune raison d'être refaits. Ne gardez en création que ce qui vous manque vraiment.",
    icon: 'message-circle',
  },
  {
    step: 'map-fun',
    sections: ['fun'],
    title: 'Les salons pour se détendre.',
    lead: "Mèmes, jeux, musique : ce qui fait qu'on reste sur un serveur une fois la question posée. Si les vôtres existent, désignez-les plutôt que d'en ouvrir des seconds.",
    icon: 'sparkles',
  },
  {
    step: 'map-voice',
    sections: ['voice'],
    title: 'Les vocaux.',
    lead: "Le salon d'appel courant, et celui qui crée un vocal à la demande de qui s'y connecte.",
    icon: 'mic',
  },
];

const SCREEN_BY_STEP = new Map(MAPPING_SCREENS.map((screen) => [screen.step, screen]));

export function mappingScreen(step: WizardStep): MappingScreen | null {
  return SCREEN_BY_STEP.get(step) ?? null;
}

export const MAPPING_STEPS: WizardStep[] = MAPPING_SCREENS.map((screen) => screen.step);

export function isMappingStep(step: WizardStep): boolean {
  return SCREEN_BY_STEP.has(step);
}

/**
 * Les sections que la vocation choisie retient.
 *
 * Un serveur d'entraide ne se voit pas demander ou ranger ses vocaux : il n'en
 * a pas au programme, et l'ecran n'existe pas pour lui.
 */
function sectionsOf(theme: ThemeKey): Set<ServerTemplateSection> {
  return new Set(THEMES.find((entry) => entry.key === theme)?.sections ?? []);
}

/**
 * Les lignes d'un ecran : ce que le plan prevoit pour ces sections-la, dans
 * l'ordre de la maquette - la categorie d'abord, ses salons ensuite.
 */
export function linesOf(
  plan: ServerTemplatePlanItem[],
  screen: MappingScreen,
  theme: ThemeKey,
): ServerTemplatePlanItem[] {
  const wanted = sectionsOf(theme);
  const sections = new Set(screen.sections.filter((section) => wanted.has(section)));
  return plan.filter((item) => item.kind !== 'module' && sections.has(item.section));
}

/** Un ecran sans ligne ne se traverse pas : il n'aurait rien a demander. */
export function screensFor(plan: ServerTemplatePlanItem[], theme: ThemeKey): MappingScreen[] {
  return MAPPING_SCREENS.filter((screen) => linesOf(plan, screen, theme).length > 0);
}

/**
 * Ce qu'un element du plan ne peut pas se voir refuser.
 *
 * `required` dit deja qu'un element est indispensable a sa section : sans role
 * Membre, tous les salons fermes du plan ne seraient visibles de personne. Ces
 * lignes gardent « utiliser » et « creer », et perdent « ne rien faire ».
 */
export function isSkippable(item: ServerTemplatePlanItem): boolean {
  return !item.required;
}

/**
 * L'etat de depart : la detection, proposee et non appliquee.
 *
 * Une ligne reconnue arrive sur « utiliser », pointant ce qui a ete reconnu ;
 * les autres sur « creer ». C'est le meme resultat qu'avant pour qui se
 * contente de valider - la difference tient a ce qu'il le voit avant, et peut
 * le corriger. Les decisions deja prises sont conservees telles quelles : on
 * revient souvent en arriere d'un ecran, et retrouver ses reponses effacees par
 * la detection serait le meilleur moyen de ne plus y toucher.
 */
export function defaultMapping(
  plan: ServerTemplatePlanItem[],
  theme: ThemeKey,
  matches: ServerTemplateState['matches'],
  previous: MappingState = {},
): MappingState {
  const wanted = sectionsOf(theme);
  const next: MappingState = {};

  for (const item of plan) {
    if (item.kind === 'module' || !wanted.has(item.section)) continue;

    const kept = previous[item.key];
    if (kept) {
      next[item.key] = kept;
      continue;
    }

    const match = matches[item.key];
    next[item.key] = match ? { mode: 'adopt', id: match.id } : { mode: 'create', id: null };
  }

  return next;
}

/**
 * La selection a envoyer : tout ce qui n'est pas ecarte.
 *
 * Une ligne adoptee y figure autant qu'une ligne a creer. C'est voulu : le bot
 * la reprend par identifiant sans rien y toucher, et c'est sa presence dans la
 * selection qui declenche le cablage - le salon de logs enregistre comme tel,
 * le role staff reconnu comme le role staff. L'ecarter reviendrait a adopter un
 * salon pour ne rien en faire.
 */
export function selectionFrom(plan: ServerTemplatePlanItem[], mapping: MappingState): string[] {
  const kept = new Set(
    Object.entries(mapping)
      .filter(([, decision]) => decision.mode !== 'skip')
      .map(([key]) => key),
  );

  // Les modules suivent le salon qui les porte : un module dont le salon est
  // ecarte resterait allume sans rien ou ecrire.
  for (const item of plan) {
    if (item.kind !== 'module') continue;
    if (!item.linkedTo || kept.has(item.linkedTo)) kept.add(item.key);
  }

  return plan.filter((item) => kept.has(item.key)).map((item) => item.key);
}

/** Les identifiants designes, tels que le bot les attend. */
export function adoptionsFrom(mapping: MappingState): Record<string, string> {
  const adopt: Record<string, string> = {};
  for (const [key, decision] of Object.entries(mapping)) {
    if (decision.mode === 'adopt' && decision.id) adopt[key] = decision.id;
  }
  return adopt;
}

/**
 * Les modules qui resteront eteints, et a cause de quelle ligne.
 *
 * Dit sur la ligne au moment ou on l'ecarte, puis repris dans le recapitulatif.
 * Ecarter le salon de niveaux est un choix legitime ; le faire sans savoir que
 * le module Niveaux ne s'allumera pas ne l'est pas.
 */
export function dormantModules(
  plan: ServerTemplatePlanItem[],
  mapping: MappingState,
): { key: string; name: string; because: string }[] {
  const skipped = new Set(
    Object.entries(mapping)
      .filter(([, decision]) => decision.mode === 'skip')
      .map(([key]) => key),
  );
  const nameOf = new Map(plan.map((item) => [item.key, item.name]));

  return plan
    .filter((item) => item.kind === 'module' && !!item.linkedTo && skipped.has(item.linkedTo))
    .map((item) => ({
      key: item.key,
      name: item.name,
      because: nameOf.get(item.linkedTo as string) ?? (item.linkedTo as string),
    }));
}

/** Ce que la pose va reellement faire, compte ligne par ligne. */
export function mappingTally(plan: ServerTemplatePlanItem[], mapping: MappingState) {
  const inScope = plan.filter((item) => item.kind !== 'module' && mapping[item.key]);
  const modeOf = (item: ServerTemplatePlanItem) => mapping[item.key]?.mode ?? 'create';

  return {
    adopted: inScope.filter((item) => modeOf(item) === 'adopt').length,
    created: inScope.filter((item) => modeOf(item) === 'create').length,
    skipped: inScope.filter((item) => modeOf(item) === 'skip').length,
  };
}
