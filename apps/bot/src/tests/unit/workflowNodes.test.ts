import { describe, expect, test } from 'bun:test';
import { evaluatePureNode, type WorkflowEffects } from '../../services/features/workflow/engine';
import {
  coerceToBoolean,
  coerceToList,
  coerceToNumber,
  daysSince,
  type ChannelValue,
  type MemberValue,
} from '../../services/features/workflow/values';

const effects: WorkflowEffects = {
  getRole: async (id) => (id ? { kind: 'Role', id, name: `role-${id}` } : null),
  getChannel: async (id) => (id ? { kind: 'Channel', id, name: `salon-${id}`, categoryName: 'Général' } : null),
  getMember: async (id) => (id
    ? {
      kind: 'Member',
      id,
      tag: `${id}#0000`,
      displayName: `membre-${id}`,
      isBot: false,
      roleIds: [],
      accountCreatedAt: null,
      joinedAt: null,
    }
    : null),
  getGuildInfo: async () => ({ name: 'Kotbo', memberCount: 1234 }),
  runAction: async () => ({}),
};

const NOW = Date.parse('2026-07-29T12:00:00.000Z');
const evaluate = (type: string, inputs: Record<string, unknown> = {}, config: Record<string, unknown> = {}) =>
  evaluatePureNode(type, inputs, config, effects, NOW);

const member: MemberValue = {
  kind: 'Member',
  id: 'u1',
  tag: 'Alice#0001',
  displayName: 'Alice',
  isBot: false,
  roleIds: ['r1'],
  accountCreatedAt: Date.parse('2025-07-29T12:00:00.000Z'),
  joinedAt: Date.parse('2026-07-19T12:00:00.000Z'),
};

describe('constantes', () => {
  test('restitue les valeurs saisies', async () => {
    expect(await evaluate('ConstText', {}, { value: 'salut' })).toEqual({ value: 'salut' });
    expect(await evaluate('ConstNumber', {}, { value: 12 })).toEqual({ value: 12 });
    expect(await evaluate('ConstBoolean', {}, { value: true })).toEqual({ value: true });
  });

  test('normalise une valeur absente', async () => {
    expect(await evaluate('ConstText')).toEqual({ value: '' });
    expect(await evaluate('ConstNumber')).toEqual({ value: 0 });
  });
});

describe('sélecteurs et infos serveur', () => {
  test('résout un rôle et un salon depuis leur identifiant', async () => {
    expect((await evaluate('SelectRole', {}, { roleId: 'r7' })).role).toMatchObject({ id: 'r7' });
    expect((await evaluate('SelectChannel', {}, { channelId: 'c3' })).channel).toMatchObject({ id: 'c3' });
  });

  test('retourne null quand aucun identifiant n\'est configuré', async () => {
    expect((await evaluate('SelectRole', {}, {})).role).toBeNull();
  });

  test('expose le nom et l\'effectif du serveur', async () => {
    expect(await evaluate('GuildInfo')).toEqual({ name: 'Kotbo', memberCount: 1234 });
  });
});

describe('MemberInfo', () => {
  test('calcule l\'âge du compte et l\'ancienneté sur le serveur', async () => {
    const result = await evaluate('MemberInfo', { member });
    expect(result.displayName).toBe('Alice');
    expect(result.accountAgeDays).toBe(365);
    expect(result.joinedDaysAgo).toBe(10);
    expect(result.isBot).toBe(false);
  });

  test('résout les rôles en entités exploitables en aval', async () => {
    const result = await evaluate('MemberInfo', { member });
    expect(result.roles).toEqual([{ kind: 'Role', id: 'r1', name: 'role-r1' }]);
  });

  test('reste neutre sans membre en entrée', async () => {
    const result = await evaluate('MemberInfo', { member: null });
    expect(result.displayName).toBe('');
    expect(result.roles).toEqual([]);
  });
});

describe('MessageInfo et ChannelInfo', () => {
  test('expose contenu, longueur, salon et auteur d\'un message', async () => {
    const result = await evaluate('MessageInfo', {
      message: { kind: 'Message', id: 'm1', content: 'bonjour', channelId: 'c1', authorId: 'u1' },
    });
    expect(result.content).toBe('bonjour');
    expect(result.length).toBe(7);
    expect(result.channel).toMatchObject({ id: 'c1' });
    expect(result.author).toMatchObject({ kind: 'Member', id: 'u1' });
  });

  test('reste neutre sans message', async () => {
    expect(await evaluate('MessageInfo', { message: null })).toEqual({
      content: '', author: null, channel: null, length: 0,
    });
  });

  test('expose les propriétés d\'un salon', async () => {
    const channel: ChannelValue = { kind: 'Channel', id: 'c9', name: 'general', categoryName: 'Public' };
    expect(await evaluate('ChannelInfo', { channel })).toEqual({
      name: 'general', id: 'c9', categoryName: 'Public',
    });
  });
});

describe('conditions', () => {
  test('HasRole détecte la possession d\'un rôle', async () => {
    expect((await evaluate('HasRole', { member, role: { kind: 'Role', id: 'r1', name: 'x' } })).result).toBe(true);
    expect((await evaluate('HasRole', { member, role: { kind: 'Role', id: 'r9', name: 'x' } })).result).toBe(false);
  });

  test('HasRole est faux sur des entrées invalides', async () => {
    expect((await evaluate('HasRole', { member: null, role: null })).result).toBe(false);
  });

  test('ChannelEquals compare par identifiant', async () => {
    const a: ChannelValue = { kind: 'Channel', id: 'c1', name: 'a', categoryName: null };
    const b: ChannelValue = { kind: 'Channel', id: 'c1', name: 'autre-nom', categoryName: null };
    expect((await evaluate('ChannelEquals', { a, b })).result).toBe(true);
  });

  test('TextContains ignore la casse par défaut', async () => {
    expect((await evaluate('TextContains', { text: 'Bonjour', search: 'BONJ' })).result).toBe(true);
    expect((await evaluate('TextContains', { text: 'Bonjour', search: 'BONJ' }, { caseSensitive: true })).result).toBe(false);
  });

  test('TextContains est faux sur une recherche vide', async () => {
    expect((await evaluate('TextContains', { text: 'Bonjour', search: '' })).result).toBe(false);
  });
});

describe('opérateurs', () => {
  test('Compare couvre tous les opérateurs', async () => {
    const cases: [string, number, number, boolean][] = [
      ['gt', 5, 3, true], ['gte', 3, 3, true], ['lt', 2, 3, true],
      ['lte', 4, 3, false], ['eq', 3, 3, true], ['neq', 3, 3, false],
    ];
    for (const [operator, a, b, expected] of cases) {
      expect((await evaluate('Compare', { a, b }, { operator })).result).toBe(expected);
    }
  });

  test('Logic gère ET et OU', async () => {
    expect((await evaluate('Logic', { a: true, b: false }, { operator: 'and' })).result).toBe(false);
    expect((await evaluate('Logic', { a: true, b: false }, { operator: 'or' })).result).toBe(true);
  });

  test('Not inverse la valeur', async () => {
    expect((await evaluate('Not', { value: true })).result).toBe(false);
  });

  test('Concat assemble avec un séparateur', async () => {
    expect((await evaluate('Concat', { a: 'Bonjour', b: 'Alice' }, { separator: ' ' })).result).toBe('Bonjour Alice');
    expect((await evaluate('Concat', { a: 'a', b: 'b' })).result).toBe('ab');
  });

  test('TextLength compte les caractères', async () => {
    expect((await evaluate('TextLength', { text: 'douze' })).result).toBe(5);
  });

  test('Math couvre les quatre opérations', async () => {
    expect((await evaluate('Math', { a: 6, b: 3 }, { operator: 'add' })).result).toBe(9);
    expect((await evaluate('Math', { a: 6, b: 3 }, { operator: 'sub' })).result).toBe(3);
    expect((await evaluate('Math', { a: 6, b: 3 }, { operator: 'mul' })).result).toBe(18);
    expect((await evaluate('Math', { a: 6, b: 3 }, { operator: 'div' })).result).toBe(2);
  });

  test('une division par zéro donne zéro plutôt qu\'un infini non sérialisable', async () => {
    expect((await evaluate('Math', { a: 6, b: 0 }, { operator: 'div' })).result).toBe(0);
  });

  test('ListLength compte les éléments', async () => {
    expect((await evaluate('ListLength', { list: ['a', 'b', 'c'] })).result).toBe(3);
    expect((await evaluate('ListLength', { list: null })).result).toBe(0);
  });

  test('un type de nœud inconnu ne produit aucune sortie', async () => {
    expect(await evaluate('NImporteQuoi')).toEqual({});
  });
});

describe('conversions', () => {
  test('coerceToNumber tolère textes et booléens', () => {
    expect(coerceToNumber('42')).toBe(42);
    expect(coerceToNumber('abc')).toBe(0);
    expect(coerceToNumber(true)).toBe(1);
    expect(coerceToNumber(Number.NaN)).toBe(0);
  });

  test('coerceToBoolean suit la véracité usuelle', () => {
    expect(coerceToBoolean('')).toBe(false);
    expect(coerceToBoolean('x')).toBe(true);
    expect(coerceToBoolean(0)).toBe(false);
    expect(coerceToBoolean([])).toBe(false);
    expect(coerceToBoolean(['a'])).toBe(true);
    expect(coerceToBoolean(null)).toBe(false);
  });

  test('coerceToList enveloppe une valeur seule', () => {
    expect(coerceToList(['a'])).toEqual(['a']);
    expect(coerceToList('a')).toEqual(['a']);
    expect(coerceToList(null)).toEqual([]);
  });

  test('daysSince retourne zéro sans horodatage', () => {
    expect(daysSince(null, NOW)).toBe(0);
  });
});
