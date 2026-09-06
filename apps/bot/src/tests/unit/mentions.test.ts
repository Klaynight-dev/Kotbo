import { describe, expect, test } from 'bun:test';
import { allowedMentionsFor, normalizeRoleMention } from '../../utils/mentions';

describe('normalizeRoleMention', () => {
  test('conserve les pings globaux', () => {
    expect(normalizeRoleMention('@everyone')).toBe('@everyone');
    expect(normalizeRoleMention('@here')).toBe('@here');
  });

  test('conserve une balise de role', () => {
    expect(normalizeRoleMention('<@&123456789012345678>')).toBe('<@&123456789012345678>');
  });

  test('balise un ID de role brut', () => {
    expect(normalizeRoleMention('123456789012345678')).toBe('<@&123456789012345678>');
  });

  test('rejette le texte libre qui ne pingerait personne', () => {
    expect(normalizeRoleMention('@Notifs')).toBeNull();
    expect(normalizeRoleMention('role notif')).toBeNull();
    expect(normalizeRoleMention('  ')).toBeNull();
    expect(normalizeRoleMention(null)).toBeNull();
  });
});

describe('allowedMentionsFor', () => {
  test('n autorise aucun ping sans mention configuree', () => {
    expect(allowedMentionsFor(null)).toEqual({ parse: [] });
  });

  test('autorise le ping global demande', () => {
    expect(allowedMentionsFor('@everyone')).toEqual({ parse: ['everyone'] });
    expect(allowedMentionsFor('@here')).toEqual({ parse: ['everyone'] });
  });

  test('autorise uniquement le role configure', () => {
    expect(allowedMentionsFor('<@&123456789012345678>')).toEqual({
      parse: [],
      roles: ['123456789012345678'],
    });
  });

  test('ignore une mention invalide plutot que d ouvrir les pings', () => {
    expect(allowedMentionsFor('@Notifs')).toEqual({ parse: [] });
  });
});
