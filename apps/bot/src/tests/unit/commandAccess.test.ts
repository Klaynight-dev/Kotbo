import { describe, expect, test } from 'bun:test';

import {
  evaluateCommandRestriction,
  normalizeCommandRestrictions,
  type CommandRestrictionRule,
} from '../../utils/commandAccess.js';

const roleId = '111111111111111111';
const otherRoleId = '222222222222222222';
const userId = '333333333333333333';
const channelId = '444444444444444444';

const rule = (overrides: Partial<CommandRestrictionRule> = {}): CommandRestrictionRule => ({
  commandName: 'ping',
  enabled: true,
  allowedChannelIds: [],
  blockedChannelIds: [],
  allowedRoleIds: [],
  blockedRoleIds: [],
  allowedUserIds: [],
  blockedUserIds: [],
  ...overrides,
});

describe('normalizeCommandRestrictions', () => {
  test('active la commande par defaut quand le flag est absent', () => {
    const [parsed] = normalizeCommandRestrictions([{ commandName: 'ping' }]);
    expect(parsed?.enabled).toBe(true);
  });

  test('ne coupe la commande que sur un false explicite', () => {
    const [off] = normalizeCommandRestrictions([{ commandName: 'ping', enabled: false }]);
    const [on] = normalizeCommandRestrictions([{ commandName: 'ping', enabled: 'nope' }]);
    expect(off?.enabled).toBe(false);
    expect(on?.enabled).toBe(true);
  });
});

describe('evaluateCommandRestriction', () => {
  test('laisse passer une commande sans regle', () => {
    expect(evaluateCommandRestriction([], 'ping', channelId, [roleId], userId).allowed).toBe(true);
  });

  test('une commande desactivee bloque aussi les privilegies', () => {
    const rules = [rule({ enabled: false })];

    expect(evaluateCommandRestriction(rules, 'ping', channelId, [roleId], userId, false).allowed).toBe(false);
    expect(evaluateCommandRestriction(rules, 'ping', channelId, [roleId], userId, true).allowed).toBe(false);
  });

  test('les privilegies contournent les restrictions de roles', () => {
    const rules = [rule({ allowedRoleIds: [otherRoleId] })];

    expect(evaluateCommandRestriction(rules, 'ping', channelId, [roleId], userId, false).allowed).toBe(false);
    expect(evaluateCommandRestriction(rules, 'ping', channelId, [roleId], userId, true).allowed).toBe(true);
  });

  test('une liste de roles autorises exclut les autres roles', () => {
    const rules = [rule({ allowedRoleIds: [roleId] })];

    expect(evaluateCommandRestriction(rules, 'ping', channelId, [roleId], userId).allowed).toBe(true);
    expect(evaluateCommandRestriction(rules, 'ping', channelId, [otherRoleId], userId).allowed).toBe(false);
  });

  test('un role bloque prime sur un role autorise', () => {
    const rules = [rule({ allowedRoleIds: [roleId], blockedRoleIds: [otherRoleId] })];

    expect(evaluateCommandRestriction(rules, 'ping', channelId, [roleId, otherRoleId], userId).allowed).toBe(false);
  });

  test('les salons autorises limitent la commande a ces salons', () => {
    const rules = [rule({ allowedChannelIds: [channelId] })];

    expect(evaluateCommandRestriction(rules, 'ping', channelId, [roleId], userId).allowed).toBe(true);
    expect(evaluateCommandRestriction(rules, 'ping', '555555555555555555', [roleId], userId).allowed).toBe(false);
  });
});
