import { describe, expect, test } from 'bun:test';
import { checkEmbedImageUrl } from '../../services/system/broadcastMediaService.js';

/**
 * Le bug d'origine : une image « uploadée » depuis le dashboard n'apparaissait
 * jamais dans l'embed, qui affichait « Échec du chargement de l'image ».
 *
 * Deux causes, toutes deux invisibles à l'envoi :
 *   - une data URL (produite par `FileReader.readAsDataURL`), que Discord ne
 *     télécharge jamais ;
 *   - un lien `cdn.discordapp.com` signé, valide quelques heures puis mort.
 *
 * Ces cas doivent être refusés *avant* diffusion vers des centaines de
 * serveurs, pas constatés après coup.
 */
describe('checkEmbedImageUrl', () => {
  test('accepte une valeur vide sans erreur', () => {
    for (const value of [undefined, null, '', '   ']) {
      const result = checkEmbedImageUrl(value);
      expect(result.ok).toBe(true);
      expect(result.value).toBeNull();
    }
  });

  test('refuse une data URL base64', () => {
    const result = checkEmbedImageUrl('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==');
    expect(result.ok).toBe(false);
    expect(result.value).toBeNull();
    expect(result.severity).toBe('error');
    expect(result.message).toContain('base64');
  });

  test('refuse un lien CDN Discord signé, même encore valide', () => {
    // `ex` est un timestamp hexadécimal ; ici loin dans le futur.
    const result = checkEmbedImageUrl(
      'https://cdn.discordapp.com/attachments/1/2/img.png?ex=7fffffff&is=6a1b2c3d&hm=deadbeef',
    );
    expect(result.ok).toBe(false);
    expect(result.severity).toBe('error');
    expect(result.message).toContain('expirent');
  });

  test('signale explicitement un lien CDN Discord déjà expiré', () => {
    const result = checkEmbedImageUrl(
      'https://media.discordapp.net/attachments/1/2/img.png?ex=1&is=2&hm=deadbeef',
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('expiré');
  });

  test('accepte un lien CDN Discord non signé', () => {
    // Les avatars et emojis servis sans signature restent stables.
    const result = checkEmbedImageUrl('https://cdn.discordapp.com/emojis/123456789.webp?size=64');
    expect(result.ok).toBe(true);
    expect(result.value).toBe('https://cdn.discordapp.com/emojis/123456789.webp?size=64');
  });

  test('refuse un protocole non HTTP', () => {
    const result = checkEmbedImageUrl('ftp://example.com/image.png');
    expect(result.ok).toBe(false);
    expect(result.severity).toBe('error');
  });

  test('refuse une URL non analysable', () => {
    const result = checkEmbedImageUrl('pas une url');
    expect(result.ok).toBe(false);
    expect(result.value).toBeNull();
  });

  test('accepte HTTP mais prévient que Discord peut le refuser', () => {
    const result = checkEmbedImageUrl('http://example.com/image.png');
    expect(result.ok).toBe(true);
    expect(result.value).toBe('http://example.com/image.png');
    expect(result.severity).toBe('warning');
  });

  test('accepte une image HTTPS externe sans avertissement', () => {
    const result = checkEmbedImageUrl('https://example.com/banner.png');
    expect(result.ok).toBe(true);
    expect(result.value).toBe('https://example.com/banner.png');
    expect(result.severity).toBeUndefined();
  });

  test('nettoie les espaces autour de la valeur', () => {
    const result = checkEmbedImageUrl('  https://example.com/a.png  ');
    expect(result.ok).toBe(true);
    expect(result.value).toBe('https://example.com/a.png');
  });
});
