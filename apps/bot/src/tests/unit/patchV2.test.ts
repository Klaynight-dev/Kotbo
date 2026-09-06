import { describe, expect, test } from 'bun:test';
import { MessageFlags, TextDisplayBuilder } from 'discord.js';
import { embedToV2, transformUpdatePayload } from '../../utils/patchV2';

const v2Message = {
  flags: { has: (f: number) => f === MessageFlags.IsComponentsV2 },
};

const legacyMessage = {
  flags: { has: () => false },
};

describe('transformUpdatePayload', () => {
  test('convertit content en TextDisplay pour un update sur message V2', () => {
    const payload = transformUpdatePayload(
      { content: 'Alerte ignorée par <@123>.', embeds: [], components: [] },
      v2Message,
    ) as { content?: string; embeds?: unknown[]; components: unknown[]; flags: unknown; allowedMentions?: unknown };

    expect(payload.content).toBeUndefined();
    expect(payload.embeds).toBeUndefined();
    expect(payload.components).toHaveLength(1);
    expect(payload.components[0]).toBeInstanceOf(TextDisplayBuilder);
    expect((payload.components[0] as TextDisplayBuilder).toJSON().content).toBe('Alerte ignorée par <@123>.');
    expect(payload.flags).toContain(MessageFlags.IsComponentsV2);
    expect(payload.allowedMentions).toEqual({ parse: [] });
  });

  test('préserve les composants existants en les plaçant après le texte', () => {
    const row = { type: 1, components: [] };
    const payload = transformUpdatePayload(
      { content: 'Validé.', components: [row] },
      v2Message,
    ) as { components: unknown[] };

    expect(payload.components).toHaveLength(2);
    expect(payload.components[0]).toBeInstanceOf(TextDisplayBuilder);
    expect(payload.components[1]).toBe(row);
  });

  test('convertit un update string sur message V2', () => {
    const payload = transformUpdatePayload('Terminé.', v2Message) as { components: unknown[]; flags: unknown[] };

    expect(payload.components).toHaveLength(1);
    expect(payload.components[0]).toBeInstanceOf(TextDisplayBuilder);
    expect(payload.flags).toContain(MessageFlags.IsComponentsV2);
  });

  test('ne modifie pas un update content sur message legacy', () => {
    const options = { content: 'Alerte ignorée.', embeds: [], components: [] };
    const payload = transformUpdatePayload(options, legacyMessage);

    expect(payload).toBe(options);
    expect((payload as { content?: string }).content).toBe('Alerte ignorée.');
  });

  test('convertit toujours les embeds via transformPayload, cible V2 ou non', () => {
    const payload = transformUpdatePayload(
      { embeds: [{ title: 'Test', description: 'Desc' }], components: [] },
      v2Message,
    ) as { embeds?: unknown[]; components: unknown[]; flags: unknown };

    expect(payload.embeds).toBeUndefined();
    expect(payload.components.length).toBeGreaterThanOrEqual(1);
  });
});

/** Concatene les TextDisplay d'un container pour inspecter son rendu. */
function containerText(container: ReturnType<typeof embedToV2>): string {
  const json = container.toJSON() as { components: any[] };
  const collect = (nodes: any[]): string[] => nodes.flatMap((node) => {
    if (node.type === 10) return [node.content as string];
    if (Array.isArray(node.components)) return collect(node.components);
    return [];
  });
  return collect(json.components).join('\n');
}

describe('embedToV2', () => {
  test('rend le titre cliquable quand l embed porte une url', () => {
    const text = containerText(embedToV2({
      title: 'Ma super video',
      url: 'https://www.youtube.com/watch?v=abc123',
      description: 'Desc',
    }));

    expect(text).toContain('[Ma super video](https://www.youtube.com/watch?v=abc123)');
  });

  test('sort le titre cliquable du heading, que Discord rendrait en clair', () => {
    const text = containerText(embedToV2({
      title: '📜 Reglement publie',
      url: 'https://discord.com/channels/1/2/3',
    }));

    expect(text).toContain('**[📜 Reglement publie](https://discord.com/channels/1/2/3)**');
    expect(text).not.toContain('### [');
    expect(text).not.toContain('### **[');
  });

  test('garde l emoji hors du libelle et rend l auteur cliquable', () => {
    const text = containerText(embedToV2({
      title: 'Nouvelle actualite',
      url: 'https://exemple.test/article',
      author: { name: 'Ma chaine', url: 'https://exemple.test/chaine' },
    }));

    expect(text).toContain('**[Ma chaine](https://exemple.test/chaine)**');
    expect(text).toContain('[Nouvelle actualite](https://exemple.test/article)');
  });

  test('ignore une url non http et laisse le titre en clair', () => {
    const text = containerText(embedToV2({
      title: 'Titre',
      url: 'javascript:alert(1)',
    }));

    expect(text).toContain('### Titre');
    expect(text).not.toContain('](');
  });

  test('neutralise les crochets du libelle', () => {
    const text = containerText(embedToV2({
      title: 'Live [FR] test',
      url: 'https://exemple.test/live',
    }));

    // Backslash construit a la main pour rester lisible dans l'assertion.
    const bs = String.fromCharCode(92);
    expect(text).toContain(`[Live ${bs}[FR${bs}] test](https://exemple.test/live)`);
  });

  test('échappe les parenthèses de l URL pour préserver la syntaxe markdown', () => {
    const text = containerText(embedToV2({
      title: 'Documentation',
      url: 'https://exemple.test/wiki/Page_(disambiguation)',
    }));

    expect(text).toContain('[Documentation](https://exemple.test/wiki/Page_%28disambiguation%29)');
  });
});
