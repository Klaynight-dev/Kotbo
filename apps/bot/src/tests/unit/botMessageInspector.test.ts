import { describe, expect, test } from 'bun:test';
import type { Guild } from 'discord.js';
import { splitArticles, toTemplate } from '../../services/core/botMessageInspector.js';

/** Seul le nom du serveur est lu par `toTemplate`. */
const guild = { name: 'Les Nerds' } as Guild;

describe('toTemplate', () => {
  test('rend les mentions et le nom du serveur a leurs variables', () => {
    const source = 'Bienvenue <@123456789012345678> sur Les Nerds ! 🎉';
    expect(toTemplate(source, guild)).toBe('Bienvenue {user} sur {server} ! 🎉');
  });

  test('reconnait la mention a surnom, que Discord ecrit differemment', () => {
    expect(toTemplate('Salut <@!987654321098765432>', guild)).toBe('Salut {user}');
  });

  test('remet le compteur de membres en variable plutot que de figer le nombre', () => {
    expect(toTemplate('Tu es le 1 240ème membre !', guild)).toBe('Tu es le {memberCount} membre !');
    expect(toTemplate('We are 512 members strong', guild)).toBe('We are {memberCount} members strong');
  });

  test('laisse les mentions de role intactes : elles ne designent pas l’arrivant', () => {
    const source = 'Va lire les règles, <@&111222333444555666> te répondra.';
    expect(toTemplate(source, guild)).toContain('<@&111222333444555666>');
  });
});

describe('splitArticles', () => {
  test('decoupe un reglement numerote et rattache chaque corps a son titre', () => {
    const raw = [
      '1. Respect',
      'Aucune insulte, aucun harcèlement.',
      '',
      '2. Pas de spam',
      'Ni flood, ni publicité sauvage.',
    ].join('\n');

    expect(splitArticles(raw)).toEqual([
      { emoji: null, title: 'Respect', description: 'Aucune insulte, aucun harcèlement.' },
      { emoji: null, title: 'Pas de spam', description: 'Ni flood, ni publicité sauvage.' },
    ]);
  });

  test('retient l’emoji de tete et le corps ecrit sur la ligne du titre', () => {
    const raw = ['🤝 **Respect** : on se parle correctement.', '🔇 **Silence** : pas de micro ouvert.'].join('\n');

    expect(splitArticles(raw)).toEqual([
      { emoji: '🤝', title: 'Respect', description: 'on se parle correctement.' },
      { emoji: '🔇', title: 'Silence', description: 'pas de micro ouvert.' },
    ]);
  });

  test('un titre sans corps se decrit lui-meme plutot que de rester vide', () => {
    expect(splitArticles('1. Respect\n2. Pas de spam')).toEqual([
      { emoji: null, title: 'Respect', description: 'Respect' },
      { emoji: null, title: 'Pas de spam', description: 'Pas de spam' },
    ]);
  });

  test('un paragraphe sans titre ne produit aucun article', () => {
    const raw = "Bienvenue sur le serveur, lis bien ce qui suit avant de participer.\nBonne lecture !";
    expect(splitArticles(raw)).toEqual([]);
  });
});
