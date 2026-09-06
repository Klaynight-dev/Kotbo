import { describe, expect, test } from 'bun:test';
import {
  SATISFACTION_COMMENT_MAX_LENGTH,
  buildSatisfactionReviewEmbed,
  clampCommentTimeout,
  sanitizeSatisfactionComment,
} from '../../services/features/ticketSatisfactionService.js';

describe('sanitizeSatisfactionComment', () => {
  test('conserve un commentaire normal', () => {
    expect(sanitizeSatisfactionComment('  Super réactif, merci !  ')).toBe('Super réactif, merci !');
  });

  test('retire les caractères invisibles et les inversions bidirectionnelles', () => {
    // Zero-width space, LTR override, BOM : servent a masquer ou retourner du texte.
    expect(sanitizeSatisfactionComment('ab\u200Bc\u202Dd\uFEFF')).toBe('abcd');
  });

  test('casse les mentions de masse sans amputer le texte', () => {
    const result = sanitizeSatisfactionComment('merci @everyone et @here');
    expect(result).not.toMatch(/@everyone/);
    expect(result).not.toMatch(/@here/);
    expect(result.replace(/\u200B/g, '')).toBe('merci @everyone et @here');
  });

  test('transforme une mention utilisateur en texte inerte', () => {
    const result = sanitizeSatisfactionComment('bravo <@123456789012345678>');
    expect(result).not.toMatch(/<@/);
    expect(result.replace(/\u200B/g, '')).toBe('bravo @123456789012345678');
  });

  test('préserve les sauts de ligne mais écrase les blocs vides', () => {
    expect(sanitizeSatisfactionComment('un\n\n\n\ndeux')).toBe('un\n\ndeux');
    expect(sanitizeSatisfactionComment('un\r\ndeux')).toBe('un\ndeux');
  });

  test('tronque au plafond de longueur', () => {
    const long = 'a'.repeat(SATISFACTION_COMMENT_MAX_LENGTH + 250);
    expect(sanitizeSatisfactionComment(long)).toHaveLength(SATISFACTION_COMMENT_MAX_LENGTH);
  });

  test('rend une chaîne vide pour un commentaire sans contenu visible', () => {
    expect(sanitizeSatisfactionComment('   \u200B\u200B  ')).toBe('');
  });
});

describe('clampCommentTimeout', () => {
  test('borne les valeurs hors plage', () => {
    expect(clampCommentTimeout(5)).toBe(30);
    expect(clampCommentTimeout(99999)).toBe(900);
  });

  test('accepte une valeur valide et arrondit', () => {
    expect(clampCommentTimeout(120)).toBe(120);
    expect(clampCommentTimeout('180')).toBe(180);
    expect(clampCommentTimeout(45.6)).toBe(46);
  });

  test('retombe sur le défaut quand la valeur est inexploitable', () => {
    expect(clampCommentTimeout(undefined)).toBe(120);
    expect(clampCommentTimeout('abc')).toBe(120);
  });
});

describe('buildSatisfactionReviewEmbed', () => {
  const base = {
    ticketId: 'clx0000000000abcdef',
    rating: 4,
    comment: 'Rapide et clair',
    userId: '111111111111111111',
    author: {
      userId: '111111111111111111',
      username: 'membre',
      displayName: 'Membre',
      avatarUrl: 'https://cdn.discordapp.com/avatar.png',
    },
    staffId: '222222222222222222',
    anonymous: false,
  };

  const field = (embed: ReturnType<typeof buildSatisfactionReviewEmbed>, name: string) =>
    embed.data.fields?.find((f) => f.name === name)?.value;

  test('affiche l\'auteur, le staff et le commentaire', () => {
    const embed = buildSatisfactionReviewEmbed(base);
    expect(field(embed, 'Auteur')).toBe('<@111111111111111111>');
    expect(field(embed, 'Staff')).toBe('<@222222222222222222>');
    expect(field(embed, 'Commentaire')).toBe('Rapide et clair');
    expect(embed.data.author?.name).toBe('Membre');
  });

  test('signale explicitement l\'absence de commentaire', () => {
    expect(field(buildSatisfactionReviewEmbed({ ...base, comment: null }), 'Commentaire')).toBe('*Aucun commentaire*');
    expect(field(buildSatisfactionReviewEmbed({ ...base, comment: '' }), 'Commentaire')).toBe('*Aucun commentaire*');
  });

  test('masque totalement le membre en mode anonyme', () => {
    const embed = buildSatisfactionReviewEmbed({ ...base, anonymous: true });
    expect(field(embed, 'Auteur')).toBe('*Membre anonyme*');
    expect(embed.data.author).toBeUndefined();
    expect(JSON.stringify(embed.data)).not.toContain(base.userId);
  });

  test('supporte un ticket sans staff attribue', () => {
    expect(field(buildSatisfactionReviewEmbed({ ...base, staffId: null }), 'Staff')).toBe('*Non attribué*');
  });

  test('rend la note en etoiles', () => {
    expect(buildSatisfactionReviewEmbed({ ...base, rating: 3 }).data.description).toContain('★★★☆☆ **3/5**');
    expect(buildSatisfactionReviewEmbed({ ...base, rating: 5 }).data.description).toContain('★★★★★ **5/5**');
  });

  test('ne casse pas sur une note hors bornes', () => {
    const embed = buildSatisfactionReviewEmbed({ ...base, rating: 9 });
    expect(embed.data.description).toContain('★★★★★');
    expect(embed.data.color).toBeDefined();
  });
});
