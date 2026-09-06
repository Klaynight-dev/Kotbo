import { describe, expect, test } from 'bun:test';
import type { Client } from 'discord.js';
import { E, loadApplicationEmojis, resolveEmojiShortcodes } from '../../utils/emojis.js';

/**
 * Les IDs d'emojis d'application codés en dur appartiennent à une seule
 * application Discord. Un autre bot (recette, white-label) qui les renvoie voit
 * Discord afficher `:ktb_xxx:` en clair dans le texte et rejeter tout message
 * qui les pose sur un bouton (`COMPONENT_INVALID_EMOJI`).
 */
function clientWithEmojis(entries: Array<{ name: string; id: string; animated?: boolean }>): Client {
  const emojis = new Map(entries.map((emoji) => [emoji.id, { ...emoji, animated: emoji.animated ?? false }]));
  return { application: { emojis: { fetch: async () => emojis } } } as unknown as Client;
}

describe('loadApplicationEmojis', () => {
  // Ce test doit rester le premier : il observe le magasin avant tout chargement.
  test("ne sert aucun ID d'emoji avant confirmation par l'application", () => {
    expect(E.error).toBe('❌');
    expect(E.moderation).toBe('🛡️');
  });

  test('adopte les IDs de l\'application courante', async () => {
    await loadApplicationEmojis(clientWithEmojis([{ name: 'ktb_cross', id: '42' }]));

    expect(E.error).toBe('<:ktb_cross:42>');
    expect(resolveEmojiShortcodes(':ktb_cross:')).toBe('<:ktb_cross:42>');
    // Un ID périmé stocké en base est réaligné sur l'application courante.
    expect(resolveEmojiShortcodes('<:ktb_cross:1519265262690373632>')).toBe('<:ktb_cross:42>');
  });

  test('retombe sur l\'Unicode pour un emoji absent de l\'application', async () => {
    await loadApplicationEmojis(clientWithEmojis([]));

    expect(E.error).toBe('❌');
    // Sans cette résolution, le raccourci ressortirait tel quel devant les membres.
    expect(resolveEmojiShortcodes(':ktb_cross:')).toBe('❌');
  });

  test('purge les IDs codés en dur quand la récupération échoue', async () => {
    const client = { application: { emojis: { fetch: async () => { throw new Error('401'); } } } } as unknown as Client;

    await loadApplicationEmojis(client);

    expect(E.error).toBe('❌');
    expect(E.moderation).toBe('🛡️');
  });

  test('purge les IDs codés en dur sans application accessible', async () => {
    await loadApplicationEmojis({ application: null } as unknown as Client);

    expect(E.error).toBe('❌');
    expect(E.moderation).toBe('🛡️');
  });
});
