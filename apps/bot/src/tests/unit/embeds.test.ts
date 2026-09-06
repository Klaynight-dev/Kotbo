import { describe, expect, test } from 'bun:test';
import { ButtonStyle } from 'discord.js';
import {
  buildNewsEmbed,
  buildYouTubeComponents,
  buildYouTubeEmbed,
  categoryEmoji,
  feedStatusEmoji,
  getCategoryTheme,
  joinFieldEntries,
  truncate,
  EMBED_FIELD_VALUE_MAX,
} from '../../utils/embeds';
import { E } from '../../utils/emojis.js';

describe('valeur d’un champ d’embed', () => {
  const more = (count: number) => `et ${count} autres`;

  test('laisse la liste intacte quand elle tient', () => {
    expect(joinFieldEntries(['a', 'b', 'c'], { more })).toBe('a\nb\nc');
  });

  // Discord refuse le message entier, pas seulement le champ : dépasser d'un caractère
  // faisait disparaître l'écran de guilde ou figeait l'annonce du raid.
  test('ne dépasse jamais la limite, et annonce le reste', () => {
    const entries = Array.from({ length: 200 }, (_, i) => `<@10000000000000000${i}> (Niveau 42)`);
    const value = joinFieldEntries(entries, { separator: ', ', more });

    expect(value.length).toBeLessThanOrEqual(EMBED_FIELD_VALUE_MAX);
    expect(value).toContain('et ');
    // Les entrées gardées le sont en entier : une mention coupée s'afficherait en clair.
    expect(value.split(', ').slice(0, -1).every((entry) => entries.includes(entry))).toBe(true);
  });

  test('une entrée déjà trop longue est coupée plutôt que perdue', () => {
    const value = joinFieldEntries(['x'.repeat(2000), 'y'], { more });
    expect(value.length).toBeLessThanOrEqual(EMBED_FIELD_VALUE_MAX);
  });

  test('une liste vide ne produit rien', () => {
    expect(joinFieldEntries([], { more })).toBe('');
  });
});

describe('embeds utils', () => {
  test('retourne un theme par defaut si categorie inconnue', () => {
    const theme = getCategoryTheme('inconnu');
    expect(theme.label).toBe('Actualités');
  });

  test('construit un embed news coherent', () => {
    const embed = buildNewsEmbed({
      title: 'Titre article',
      url: 'https://example.com/a',
      description: 'Description article',
      feedName: 'Feed Test',
      category: 'Tech FR',
      publishedAt: new Date('2026-04-04T10:00:00.000Z'),
      isValidation: true,
      itemId: 'abc123',
    });

    const json = embed.toJSON();
    expect(json.title).toContain('Titre article');
    expect(json.footer?.text).toContain('ID: abc123');
    expect(json.fields?.length).toBeGreaterThanOrEqual(2);
  });

  test('construit un embed youtube coherent', () => {
    const embed = buildYouTubeEmbed({
      title: 'Video test',
      videoId: 'xyz',
      channelName: 'Kotbo TV',
      publishedAt: new Date('2026-04-04T10:00:00.000Z'),
    });

    const json = embed.toJSON();
    expect(json.url).toBe('https://www.youtube.com/watch?v=xyz');
    expect(json.footer?.text).toBe('YouTube');
    expect(json.description).toBe('Kotbo TV a publié une vidéo sur YouTube !');
  });

  test('embed youtube : avatar, miniature et extrait de description', () => {
    const embed = buildYouTubeEmbed({
      title: 'Video test',
      videoId: 'xyz',
      channelName: 'Kotbo TV',
      publishedAt: new Date('2026-04-04T10:00:00.000Z'),
      description: 'Un resume de la video.',
      channelUrl: 'https://www.youtube.com/channel/UC123',
      channelAvatarUrl: 'https://yt3.googleusercontent.com/avatar.jpg',
      thumbnailUrl: 'https://i.ytimg.com/vi/xyz/maxresdefault.jpg',
    });

    const json = embed.toJSON();
    expect(json.author?.url).toBe('https://www.youtube.com/channel/UC123');
    expect(json.author?.icon_url).toBe('https://yt3.googleusercontent.com/avatar.jpg');
    expect(json.thumbnail?.url).toBe('https://yt3.googleusercontent.com/avatar.jpg');
    expect(json.image?.url).toBe('https://i.ytimg.com/vi/xyz/maxresdefault.jpg');
    expect(json.description).toContain('**Description**');
    expect(json.description).toContain('Un resume de la video.');
  });

  test('embed youtube : accroche adaptee au type d annonce', () => {
    const base = {
      title: 'Video test',
      videoId: 'xyz',
      channelName: 'Kotbo TV',
      publishedAt: new Date('2026-04-04T10:00:00.000Z'),
    };

    expect(buildYouTubeEmbed({ ...base, kind: 'live' }).toJSON().description)
      .toBe('Kotbo TV est en direct sur YouTube !');
    expect(buildYouTubeEmbed({ ...base, kind: 'short' }).toJSON().description)
      .toBe('Kotbo TV a publié un Short sur YouTube !');
  });

  test('embed youtube : bouton de lien vers la video', () => {
    const [row] = buildYouTubeComponents({ videoId: 'xyz' });
    const button = row.toJSON().components[0] as { label?: string; url?: string; style: number };

    expect(button.label).toBe('Voir la vidéo');
    expect(button.url).toBe('https://www.youtube.com/watch?v=xyz');
    expect(button.style).toBe(ButtonStyle.Link);

    const [liveRow] = buildYouTubeComponents({ videoId: 'xyz', kind: 'live' });
    expect((liveRow.toJSON().components[0] as { label?: string }).label).toBe('Regarder le live');
    const [shortRow] = buildYouTubeComponents({ videoId: 'xyz', kind: 'short' });
    expect((shortRow.toJSON().components[0] as { label?: string }).label).toBe('Voir le Short');
  });

  test('un Short pointe vers /shorts et non vers le lecteur classique', () => {
    const base = {
      title: 'Short test',
      videoId: 'xyz',
      channelName: 'Kotbo TV',
      publishedAt: new Date('2026-04-04T10:00:00.000Z'),
    };

    expect(buildYouTubeEmbed({ ...base, kind: 'short' }).toJSON().url)
      .toBe('https://www.youtube.com/shorts/xyz');
    const [shortRow] = buildYouTubeComponents({ videoId: 'xyz', kind: 'short' });
    expect((shortRow.toJSON().components[0] as { url?: string }).url)
      .toBe('https://www.youtube.com/shorts/xyz');

    // Les lives et les videos gardent /watch.
    expect(buildYouTubeEmbed({ ...base, kind: 'live' }).toJSON().url)
      .toBe('https://www.youtube.com/watch?v=xyz');
  });

  // Un ID d'emoji d'application n'est servi qu'une fois confirmé sur
  // l'application courante : hors chargement, ces helpers rendent l'Unicode.
  test('helpers utilitaires', () => {
    expect(truncate('abcdef', 5)).toBe('ab...');
    expect(categoryEmoji('YouTube')).toBe('▶️');
    expect(feedStatusEmoji(true)).toBe('🟢');
    expect(feedStatusEmoji(false)).toBe('⚫');
    expect(categoryEmoji('YouTube')).toBe(E.youtube);
  });
});
