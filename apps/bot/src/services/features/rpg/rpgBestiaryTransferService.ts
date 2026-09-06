/**
 * Export et import du bestiaire d'un serveur.
 *
 * L'export décrit le bestiaire *effectif* : créatures du serveur et créatures du catalogue
 * livré de base, telles qu'elles sont jouées. Il ne contient aucun identifiant - un
 * identifiant n'a de sens que dans la base dont il vient, et l'import se fait par nom, la même
 * clé que celle du masquage d'un monstre global.
 *
 * Un butin désignant son objet par son nom, importer sur un serveur qui n'a pas ces objets
 * laisserait des récompenses fantômes, annoncées puis jamais versées. Ces butins sont retirés
 * à l'import et comptés dans le compte rendu, plutôt que de faire échouer le tout.
 */

import prisma from '../../../utils/db.js';
import {
  BestiaryError,
  listGuildMonsters,
  saveGuildMonster,
} from './rpgBestiaryService.js';
import {
  normalizeMonsterInput,
  parseMonsterDrops,
  type NormalizedMonster,
} from './rpgBestiaryPolicy.js';

export const BESTIARY_EXPORT_FORMAT = 'kotbo-bestiary';
export const BESTIARY_EXPORT_VERSION = 1;

/** Au delà, l'import n'est plus un transfert de bestiaire mais un envoi de fichier arbitraire. */
export const BESTIARY_IMPORT_MAX = 500;

export interface BestiaryExport {
  format: typeof BESTIARY_EXPORT_FORMAT;
  version: number;
  exportedAt: string;
  monsters: NormalizedMonster[];
}

export async function exportGuildBestiary(guildId: string): Promise<BestiaryExport> {
  const monsters = await listGuildMonsters(guildId, { includeDisabled: true });

  return {
    format: BESTIARY_EXPORT_FORMAT,
    version: BESTIARY_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    monsters: monsters.map((monster) => ({
      name: monster.name,
      description: monster.description,
      emoji: monster.emoji,
      level: monster.level,
      health: monster.health,
      attack: monster.attack,
      defense: monster.defense,
      speed: monster.speed,
      xpReward: monster.xpReward,
      coinReward: monster.coinReward,
      drops: parseMonsterDrops(monster.drops),
      isBoss: monster.isBoss,
      bossRespawnHours: monster.bossRespawnHours,
      clanPoints: monster.clanPoints,
      enabled: monster.enabled,
    })),
  };
}

export interface BestiaryImportReport {
  created: number;
  updated: number;
  /** Butins retirés faute d'objet correspondant sur ce serveur. */
  droppedLoot: number;
}

function readMonsterList(payload: unknown): unknown[] {
  const list = Array.isArray(payload)
    ? payload
    : (payload as { monsters?: unknown } | null)?.monsters;

  if (!Array.isArray(list)) {
    throw new BestiaryError("Ce fichier ne contient pas de bestiaire : la liste « monsters » est absente.", 400);
  }
  if (list.length === 0) throw new BestiaryError('Ce bestiaire est vide.', 400);
  if (list.length > BESTIARY_IMPORT_MAX) {
    throw new BestiaryError(`Un import ne peut pas dépasser ${BESTIARY_IMPORT_MAX} créatures.`, 400);
  }

  return list;
}

/**
 * Importe un bestiaire, créature par créature.
 *
 * Une créature dont le nom existe déjà est mise à jour, y compris s'il s'agit d'un monstre du
 * catalogue global : `saveGuildMonster` en dépose alors une copie locale, comme le ferait une
 * modification à la main. Rien n'est supprimé - un import ajoute et remplace, il ne fait pas
 * du serveur la copie conforme du fichier.
 *
 * Le palier de difficulté du serveur n'est pas modifié : les valeurs du fichier viennent d'un
 * équilibrage inconnu, et rien ne dit de quel palier elles sortent. Les fiches importées
 * apparaissent donc comme retouchées à la main, ce qu'elles sont du point de vue du palier.
 */
export async function importGuildBestiary(guildId: string, payload: unknown): Promise<BestiaryImportReport> {
  const list = readMonsterList(payload);

  // Toute la validation d'abord : un fichier à moitié importé laisserait un bestiaire
  // incohérent que personne ne saurait rattraper autrement qu'à la main.
  const seen = new Set<string>();
  const normalized = list.map((entry, index) => {
    const position = `Créature n°${index + 1}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new BestiaryError(`${position} : ce n'est pas une fiche de créature.`, 400);
    }

    const result = normalizeMonsterInput(entry as Record<string, unknown>);
    if (!result.ok) throw new BestiaryError(`${position} : ${result.error}`, 400);

    // Le nom est la clé de l'import : deux fiches homonymes créeraient la première puis
    // buteraient sur la seconde, après avoir déjà écrit la moitié du fichier.
    if (seen.has(result.value.name)) {
      throw new BestiaryError(`Le fichier contient deux fois « ${result.value.name} ».`, 400);
    }
    seen.add(result.value.name);

    return result.value;
  });

  const knownItems = await prisma.rpgItem.findMany({
    where: { OR: [{ guildId: null }, { guildId }] },
    select: { name: true },
  });
  const itemNames = new Set(knownItems.map((item) => item.name));

  const existing = await listGuildMonsters(guildId, { includeDisabled: true });
  const byName = new Map(existing.map((monster) => [monster.name, monster.id]));

  const report: BestiaryImportReport = { created: 0, updated: 0, droppedLoot: 0 };

  for (const monster of normalized) {
    const drops = monster.drops.filter((drop) => itemNames.has(drop.itemName));
    report.droppedLoot += monster.drops.length - drops.length;

    const previousId = byName.get(monster.name);
    await saveGuildMonster(guildId, { ...monster, drops }, previousId);
    if (previousId) report.updated += 1;
    else report.created += 1;
  }

  return report;
}
