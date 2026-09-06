/**
 * Instances d'objets : l'exemplaire possédé par un joueur, porteur de sa progression
 * (niveau de forge et enchantements).
 *
 * Une instance par couple (profil, objet). C'est ce qui fait que la progression suit
 * l'objet plutôt que l'emplacement : déséquiper une arme ne l'efface plus, et améliorer
 * une babiole n'avantage plus l'arme légendaire qu'on glisse ensuite dans le même slot.
 *
 * Ce module est volontairement minuscule et sans dépendance métier : la forge, l'autel
 * d'enchantement et le service d'économie s'en servent tous, un module partagé évite le
 * cycle d'imports qu'aurait créé un helper posé dans l'un d'eux.
 */

import prisma from '../../../utils/db.js';
import { parseEnchants, type EnchantStack } from './rpgEnchantments.js';

export type ItemProgression = {
  id: string;
  itemId: string;
  upgrade: number;
  enchants: EnchantStack[];
};

/** Progression d'un objet possédé, ou `null` s'il n'a jamais été forgé ni enchanté. */
export async function getItemInstance(rpgProfileId: string, itemId: string): Promise<ItemProgression | null> {
  const instance = await prisma.rpgItemInstance.findUnique({
    where: { rpgProfileId_itemId: { rpgProfileId, itemId } },
  });
  if (!instance) return null;

  return {
    id: instance.id,
    itemId: instance.itemId,
    upgrade: instance.upgrade,
    enchants: parseEnchants(instance.enchants),
  };
}

/**
 * Instance d'un objet possédé, créée à la volée si elle manque.
 *
 * La création est paresseuse : la très grande majorité des objets d'un inventaire ne sera
 * jamais ni forgée ni enchantée, et leur ouvrir une ligne à l'achat ferait grossir la table
 * pour rien. `upsert` rend l'appel idempotent, deux clics simultanés ne créant qu'une ligne.
 */
export async function ensureItemInstance(rpgProfileId: string, itemId: string): Promise<ItemProgression> {
  const instance = await prisma.rpgItemInstance.upsert({
    where: { rpgProfileId_itemId: { rpgProfileId, itemId } },
    update: {},
    create: { rpgProfileId, itemId, upgrade: 0, enchants: [] },
  });

  return {
    id: instance.id,
    itemId: instance.itemId,
    upgrade: instance.upgrade,
    enchants: parseEnchants(instance.enchants),
  };
}

/**
 * Progression de plusieurs objets d'un même profil, indexée par identifiant d'objet.
 * Un seul aller-retour, pour les vues qui affichent un inventaire entier.
 */
export async function getItemInstances(rpgProfileId: string, itemIds: string[]): Promise<Map<string, ItemProgression>> {
  if (itemIds.length === 0) return new Map();

  const instances = await prisma.rpgItemInstance.findMany({
    where: { rpgProfileId, itemId: { in: itemIds } },
  });

  return new Map(instances.map((instance) => [instance.itemId, {
    id: instance.id,
    itemId: instance.itemId,
    upgrade: instance.upgrade,
    enchants: parseEnchants(instance.enchants),
  }]));
}

/**
 * Écriture Prisma qui détruit la progression d'un objet qui quitte définitivement un
 * inventaire (vente, don, retrait admin). Renvoyée sans être exécutée pour que l'appelant
 * la place dans SA transaction : la pile et son instance doivent disparaître ensemble.
 *
 * `deleteMany` et non `delete` : l'objet n'a pas forcément d'instance, et une suppression
 * d'une ligne absente lèverait une erreur au milieu d'une transaction par ailleurs valide.
 */
export function deleteItemInstanceWrite(rpgProfileId: string, itemId: string) {
  return prisma.rpgItemInstance.deleteMany({ where: { rpgProfileId, itemId } });
}
