import { describe, expect, test } from 'bun:test';
import {
  resolveLockUntilClaim,
  resolveRequireApproval,
  ticketBlacklistMessage,
} from '../../services/features/ticketService.js';

const baseType = { id: 'support', label: 'Support' };

describe('resolveLockUntilClaim', () => {
  test('suit la configuration du serveur quand le type n\'a rien tranché', () => {
    expect(resolveLockUntilClaim(baseType, { ticketLockUntilClaim: true })).toBe(true);
    expect(resolveLockUntilClaim(baseType, { ticketLockUntilClaim: false })).toBe(false);
    // Serveur jamais configuré : le verrouillage doit rester inactif.
    expect(resolveLockUntilClaim(baseType, {})).toBe(false);
  });

  test('le réglage du type prime sur celui du serveur, dans les deux sens', () => {
    expect(resolveLockUntilClaim({ ...baseType, lockUntilClaim: false }, { ticketLockUntilClaim: true })).toBe(false);
    expect(resolveLockUntilClaim({ ...baseType, lockUntilClaim: true }, { ticketLockUntilClaim: false })).toBe(true);
  });

  test('« hériter » est bien distingué de « désactivé »', () => {
    expect(resolveLockUntilClaim({ ...baseType, lockUntilClaim: null }, { ticketLockUntilClaim: true })).toBe(true);
  });
});

describe('resolveRequireApproval', () => {
  test('suit la configuration du serveur par défaut', () => {
    expect(resolveRequireApproval(baseType, { ticketApprovalEnabled: true })).toBe(true);
    expect(resolveRequireApproval(baseType, {})).toBe(false);
  });

  test('un type peut exiger la validation sur un serveur qui ne la demande pas', () => {
    expect(resolveRequireApproval({ ...baseType, requireApproval: true }, { ticketApprovalEnabled: false })).toBe(true);
  });

  test('un type peut s\'en dispenser sur un serveur qui l\'impose', () => {
    expect(resolveRequireApproval({ ...baseType, requireApproval: false }, { ticketApprovalEnabled: true })).toBe(false);
  });
});

describe('ticketBlacklistMessage', () => {
  test('mentionne la raison quand elle existe', () => {
    const message = ticketBlacklistMessage({ reason: 'Abus du système de tickets', expiresAt: null, allowReopen: false });
    expect(message).toContain('Abus du système de tickets');
    expect(message).not.toContain("Jusqu'au");
  });

  test('affiche une échéance en horodatage Discord', () => {
    const expiresAt = new Date('2026-09-01T12:00:00.000Z');
    const message = ticketBlacklistMessage({ reason: null, expiresAt, allowReopen: false });
    expect(message).toContain(`<t:${Math.floor(expiresAt.getTime() / 1000)}:F>`);
    expect(message).not.toContain('Raison');
  });
});
